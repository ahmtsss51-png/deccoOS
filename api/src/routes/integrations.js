import { Router } from 'express'
import { pool, query } from '../db.js'
import { normalizePhone, PHONE_CANON_SQL } from './customers.js'
import { applyCustomerPayment } from './finance.js'

const router = Router()

/**
 * Exact decimal-string to integer cents parser.
 * Bypasses JavaScript floating-point arithmetic errors.
 * Rejects negative numbers, non-numeric strings, and numbers with > 2 decimal places.
 */
export function parseDecimalToCents(val) {
  if (val == null) return null
  const s = String(val).trim()
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null
  const [intPart, decPart = ''] = s.split('.')
  const cents = parseInt(intPart, 10) * 100 + parseInt(decPart.padEnd(2, '0'), 10)
  return Number.isSafeInteger(cents) && cents >= 0 ? cents : null
}

/**
 * Safe UTC date parser.
 */
export function parseUtcDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null
  const s = dateStr.trim()
  if (!s) return null
  const hasTz = s.endsWith('Z') || s.includes('+') || (s.includes('-') && s.length > 19)
  const iso = hasTz ? s : s + 'Z'
  const d = new Date(iso)
  return isNaN(d.getTime()) ? null : d.toISOString()
}

/**
 * Checks whether shipping object contains meaningful real data.
 */
function hasMeaningfulShipping(shipping) {
  if (!shipping || typeof shipping !== 'object') return false
  return Boolean(
    (typeof shipping.first_name === 'string' && shipping.first_name.trim()) ||
    (typeof shipping.last_name === 'string' && shipping.last_name.trim()) ||
    (typeof shipping.address_1 === 'string' && shipping.address_1.trim()) ||
    (typeof shipping.city === 'string' && shipping.city.trim()) ||
    (typeof shipping.company === 'string' && shipping.company.trim())
  )
}

/**
 * Shared WooCommerce order resolution helper:
 * - Accepts dbQuery (either global query or a transaction client.query.bind(client)).
 * - Used by both GET .../resolve and POST .../import.
 */
export async function resolveWooOrderEvent(dbQuery, event) {
  const errors = []
  const isOrderEvent = typeof event.event_type === 'string' && event.event_type.startsWith('order.')
  if (!isOrderEvent) {
    return {
      event_id: Number(event.id),
      woo_order_id: null,
      already_imported: false,
      decco_order_id: null,
      decco_order_no: null,
      importable: false,
      lines: [],
      errors: [{
        code: 'unsupported_event_type',
        message: `Desteklenmeyen etkinlik türü: ${event.event_type || 'boş'} (Yalnızca order.* topicleri çözümlenebilir)`
      }]
    }
  }

  const payload = event.payload || {}
  const rawOrderId = payload.id
  const wooOrderId = rawOrderId != null && String(rawOrderId).trim() !== '' ? String(rawOrderId).trim() : null

  if (!wooOrderId) {
    return {
      event_id: Number(event.id),
      woo_order_id: null,
      already_imported: false,
      decco_order_id: null,
      decco_order_no: null,
      importable: false,
      lines: [],
      errors: [{
        code: 'missing_order_id',
        message: 'Payload içinde id (WooCommerce sipariş kimliği) bulunamadı'
      }]
    }
  }

  const { rows: extRows } = await dbQuery(
    `SELECT r.order_id, o.order_no
     FROM order_external_refs r
     JOIN orders o ON o.id = r.order_id
     WHERE r.provider = 'woocommerce' AND r.external_id = $1`,
    [wooOrderId]
  )

  let alreadyImported = false
  let deccoOrderId = null
  let deccoOrderNo = null

  if (extRows.length > 0) {
    alreadyImported = true
    deccoOrderId = extRows[0].order_id
    deccoOrderNo = extRows[0].order_no
    errors.push({
      code: 'already_imported',
      message: `Bu WooCommerce siparişi zaten Decco OS siparişine (#${deccoOrderId} - ${deccoOrderNo || ''}) bağlı`,
      order_id: deccoOrderId,
      order_no: deccoOrderNo
    })
  }

  const lineItems = payload.line_items
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    return {
      event_id: Number(event.id),
      woo_order_id: wooOrderId,
      already_imported: alreadyImported,
      decco_order_id: deccoOrderId,
      decco_order_no: deccoOrderNo,
      importable: false,
      lines: [],
      errors: [
        ...errors,
        { code: 'missing_line_items', message: 'Payload içinde line_items dizisi boş veya eksik' }
      ]
    }
  }

  const lines = []
  for (const it of lineItems) {
    const lineId = it.id ?? null
    const rawSku = typeof it.sku === 'string' ? it.sku : (it.sku != null ? String(it.sku) : '')
    const rawQty = it.quantity
    const qty = Number(rawQty)
    const isQtyValid = Number.isInteger(qty) && qty > 0

    const rawPrice = it.price ?? null
    const rawSubtotal = it.subtotal ?? null
    const rawTotal = it.total ?? null

    if (!isQtyValid) {
      errors.push({
        code: 'invalid_quantity',
        line_id: lineId,
        message: `Sipariş kaleminde geçersiz adet: ${rawQty}`
      })
      lines.push({
        line_id: lineId,
        name: it.name || null,
        sku: rawSku,
        normalized_sku: null,
        product_id: null,
        product_name: null,
        quantity: rawQty,
        raw_price: rawPrice,
        raw_subtotal: rawSubtotal,
        raw_total: rawTotal,
        status: 'invalid_quantity'
      })
      continue
    }

    if (!rawSku || !rawSku.trim()) {
      errors.push({
        code: 'missing_sku',
        line_id: lineId,
        message: `Sipariş kaleminde SKU eksik (${it.name || 'isimsiz'})`
      })
      lines.push({
        line_id: lineId,
        name: it.name || null,
        sku: rawSku,
        normalized_sku: null,
        product_id: null,
        product_name: null,
        quantity: qty,
        raw_price: rawPrice,
        raw_subtotal: rawSubtotal,
        raw_total: rawTotal,
        status: 'missing_sku'
      })
      continue
    }

    const normalizedSku = rawSku.trim().toUpperCase()

    const { rows: prodRows } = await dbQuery(
      'SELECT id, name, is_active FROM products WHERE code = $1',
      [normalizedSku]
    )

    if (prodRows.length === 0) {
      errors.push({
        code: 'unknown_sku',
        line_id: lineId,
        sku: normalizedSku,
        message: `Decco OS'ta tanımlı olmayan SKU: ${normalizedSku}`
      })
      lines.push({
        line_id: lineId,
        name: it.name || null,
        sku: rawSku,
        normalized_sku: normalizedSku,
        product_id: null,
        product_name: null,
        quantity: qty,
        raw_price: rawPrice,
        raw_subtotal: rawSubtotal,
        raw_total: rawTotal,
        status: 'unknown_sku'
      })
      continue
    }

    const prod = prodRows[0]
    if (!prod.is_active) {
      errors.push({
        code: 'inactive_product',
        line_id: lineId,
        sku: normalizedSku,
        message: `Ürün pasif durumda: ${normalizedSku} (${prod.name})`
      })
      lines.push({
        line_id: lineId,
        name: it.name || null,
        sku: rawSku,
        normalized_sku: normalizedSku,
        product_id: prod.id,
        product_name: prod.name,
        quantity: qty,
        raw_price: rawPrice,
        raw_subtotal: rawSubtotal,
        raw_total: rawTotal,
        status: 'inactive_product'
      })
      continue
    }

    lines.push({
      line_id: lineId,
      name: it.name || null,
      sku: rawSku,
      normalized_sku: normalizedSku,
      product_id: prod.id,
      product_name: prod.name,
      quantity: qty,
      raw_price: rawPrice,
      raw_subtotal: rawSubtotal,
      raw_total: rawTotal,
      status: 'matched'
    })
  }

  const importable = !alreadyImported && errors.length === 0 && lines.every(l => l.status === 'matched')

  return {
    event_id: Number(event.id),
    woo_order_id: wooOrderId,
    already_imported: alreadyImported,
    decco_order_id: deccoOrderId,
    decco_order_no: deccoOrderNo,
    importable,
    lines,
    errors
  }
}

/**
 * GET /api/integrations/woocommerce/events/:eventId/resolve
 *
 * WooCommerce webhook event dry-run resolver (salt-okunur):
 */
router.get('/woocommerce/events/:eventId/resolve', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, provider, event_key, event_type, payload, status, received_at
       FROM integration_events
       WHERE id = $1 AND provider = 'woocommerce'`,
      [req.params.eventId]
    )

    if (!rows[0]) {
      return res.status(404).json({ error: 'WooCommerce event kaydı bulunamadı' })
    }

    const result = await resolveWooOrderEvent(query, rows[0])
    res.json(result)
  } catch (e) {
    next(e)
  }
})


/**
 * GET /api/integrations/woocommerce/events
 *
 * WooCommerce webhook olaylarını listeler (salt okunur):
 * - Yalnızca provider = 'woocommerce'
 * - En yeni event üstte, maksimum 50 kayıt
 * - Eksik veya beklenmeyen payload alanlarında null döner, asla hata fırlatmaz.
 */
router.get('/woocommerce/events', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, provider, event_key, event_type, payload, status, received_at
       FROM integration_events
       WHERE provider = 'woocommerce'
       ORDER BY received_at DESC, id DESC
       LIMIT 50`
    )

    const events = rows.map(r => {
      const p = (r.payload && typeof r.payload === 'object') ? r.payload : {}
      const billing = (p.billing && typeof p.billing === 'object') ? p.billing : {}
      const firstName = typeof billing.first_name === 'string' ? billing.first_name.trim() : ''
      const lastName = typeof billing.last_name === 'string' ? billing.last_name.trim() : ''
      const customerName = (firstName || lastName) ? `${firstName} ${lastName}`.trim() : null
      const lineItems = Array.isArray(p.line_items) ? p.line_items : null

      return {
        event_id: Number(r.id),
        event_type: r.event_type || null,
        integration_status: r.status || null,
        received_at: r.received_at || null,
        woo_order_id: p.id != null ? p.id : null,
        woo_order_number: p.number != null ? String(p.number) : (p.id != null ? String(p.id) : null),
        woo_status: typeof p.status === 'string' ? p.status : null,
        customer_name: customerName,
        billing_email: typeof billing.email === 'string' && billing.email.trim() ? billing.email.trim() : null,
        billing_phone: typeof billing.phone === 'string' && billing.phone.trim() ? billing.phone.trim() : null,
        total: p.total != null ? String(p.total) : null,
        currency: typeof p.currency === 'string' ? p.currency : null,
        payment_method_title: typeof p.payment_method_title === 'string' ? p.payment_method_title : null,
        line_count: lineItems ? lineItems.length : null
      }
    })

    res.json(events)
  } catch (e) {
    next(e)
  }
})

/**
 * POST /api/integrations/woocommerce/events/:eventId/import
 *
 * Doğrulanmış WooCommerce sipariş event'ini tek bir PostgreSQL transaction'ı
 * içinde Decco OS siparişine dönüştürür.
 */
router.post('/woocommerce/events/:eventId/import', async (req, res, next) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // 1. Lock event row FOR UPDATE
    const { rows: eventRows } = await client.query(
      `SELECT id, provider, event_key, event_type, payload, status, received_at
       FROM integration_events
       WHERE id = $1 AND provider = 'woocommerce'
       FOR UPDATE`,
      [req.params.eventId]
    )

    if (!eventRows[0]) {
      await client.query('ROLLBACK')
      return res.status(404).json({ ok: false, error: 'WooCommerce event kaydı bulunamadı' })
    }

    const event = eventRows[0]

    // 2. Validate event type and order ID
    const isOrderEvent = typeof event.event_type === 'string' && event.event_type.startsWith('order.')
    if (!isOrderEvent) {
      await client.query('ROLLBACK')
      return res.status(422).json({
        ok: false,
        code: 'unsupported_event_type',
        error: `Yalnızca order.* topicleri içe aktarılabilir: ${event.event_type || 'boş'}`
      })
    }

    const payload = event.payload || {}
    const rawOrderId = payload.id
    const wooOrderId = rawOrderId != null && String(rawOrderId).trim() !== '' ? String(rawOrderId).trim() : null

    if (!wooOrderId) {
      await client.query('ROLLBACK')
      return res.status(422).json({
        ok: false,
        code: 'missing_order_id',
        error: 'Payload içinde id (WooCommerce sipariş kimliği) bulunamadı'
      })
    }

    // 3. Idempotency check: order_external_refs
    const { rows: extRows } = await client.query(
      `SELECT r.order_id, o.order_no
       FROM order_external_refs r
       JOIN orders o ON o.id = r.order_id
       WHERE r.provider = 'woocommerce' AND r.external_id = $1`,
      [wooOrderId]
    )

    if (extRows.length > 0) {
      // Mark current event as processed so inbox does not remain indefinitely 'received'
      await client.query(
        `UPDATE integration_events
         SET status = 'processed', processed_at = NOW(), error_message = NULL
         WHERE id = $1`,
        [event.id]
      )
      await client.query('COMMIT')
      return res.json({
        ok: true,
        already_imported: true,
        order_id: extRows[0].order_id,
        order_no: extRows[0].order_no
      })
    }

    // 4. Status whitelist
    const rawStatus = typeof payload.status === 'string' ? payload.status.toLowerCase().trim() : ''
    const UNPAID_STATUSES = ['pending', 'on-hold']
    const PAID_STATUSES = ['processing', 'completed']

    if (!UNPAID_STATUSES.includes(rawStatus) && !PAID_STATUSES.includes(rawStatus)) {
      await client.query('ROLLBACK')
      return res.status(422).json({
        ok: false,
        code: 'unsupported_order_status',
        error: `Desteklenmeyen sipariş durumu: '${rawStatus}'. Yalnızca pending, on-hold, processing, completed içe aktarılabilir.`
      })
    }

    // 5. Payment requirements check
    let isPaid = false
    let paidAtIso = null
    if (PAID_STATUSES.includes(rawStatus)) {
      if (payload.date_paid_gmt && typeof payload.date_paid_gmt === 'string') {
        paidAtIso = parseUtcDate(payload.date_paid_gmt)
      } else if (payload.date_paid && typeof payload.date_paid === 'string') {
        const dp = payload.date_paid.trim()
        if (dp.endsWith('Z') || dp.includes('+') || (dp.includes('-') && dp.length > 19)) {
          paidAtIso = parseUtcDate(dp)
        }
      }

      if (!paidAtIso) {
        await client.query('ROLLBACK')
        return res.status(422).json({
          ok: false,
          code: 'inconsistent_paid_state',
          error: `Sipariş durumu '${rawStatus}' (ödendi) ancak geçerli bir ödeme tarihi (date_paid_gmt) bulunamadı.`
        })
      }

      const rawPaymentMethod = typeof payload.payment_method === 'string' ? payload.payment_method.toLowerCase().trim() : ''
      if (rawPaymentMethod !== 'paytr') {
        await client.query('ROLLBACK')
        return res.status(422).json({
          ok: false,
          code: 'unsupported_paid_payment_method',
          error: `Desteklenmeyen ödeme yöntemi: '${payload.payment_method || 'boş'}'. Ödenmiş siparişlerde şu anda yalnızca 'paytr' desteklenmektedir.`
        })
      }

      isPaid = true
    }

    // 6. Currency check (TRY only)
    const rawCurrency = typeof payload.currency === 'string' ? payload.currency.toUpperCase().trim() : ''
    if (rawCurrency !== 'TRY') {
      await client.query('ROLLBACK')
      return res.status(422).json({
        ok: false,
        code: 'unsupported_currency',
        error: `Desteklenmeyen para birimi: '${payload.currency || 'boş'}'. Yalnızca TRY kabul edilmektedir.`
      })
    }

    // 7. Resolver check (same transaction client)
    const resolveResult = await resolveWooOrderEvent(client.query.bind(client), event)
    if (!resolveResult.importable) {
      await client.query('ROLLBACK')
      return res.status(422).json({
        ok: false,
        code: 'unresolvable_order',
        error: 'Sipariş kalemleri çözümlenemedi',
        errors: resolveResult.errors,
        lines: resolveResult.lines
      })
    }

    // 8. Order total & line items integer cents precision check
    const orderTotalCents = parseDecimalToCents(payload.total)
    if (orderTotalCents == null || orderTotalCents < 0) {
      await client.query('ROLLBACK')
      return res.status(422).json({
        ok: false,
        code: 'invalid_order_total',
        error: `Geçersiz sipariş toplamı: '${payload.total}'`
      })
    }

    let calculatedLineSumCents = 0
    const processedLines = []

    for (let i = 0; i < resolveResult.lines.length; i++) {
      const line = resolveResult.lines[i]
      const rawItem = payload.line_items[i]
      const qty = parseInt(line.quantity, 10)

      if (!Number.isInteger(qty) || qty <= 0) {
        await client.query('ROLLBACK')
        return res.status(422).json({
          ok: false,
          code: 'invalid_quantity',
          error: `Kalem #${line.line_id || i + 1} için geçersiz adet: ${line.quantity}`
        })
      }

      const subtotalCents = parseDecimalToCents(rawItem.subtotal)
      const totalCents = parseDecimalToCents(rawItem.total)

      if (subtotalCents == null || subtotalCents < 0 || totalCents == null || totalCents < 0) {
        await client.query('ROLLBACK')
        return res.status(422).json({
          ok: false,
          code: 'invalid_line_amount',
          error: `Kalem #${line.line_id || i + 1} için geçersiz subtotal (${rawItem.subtotal}) veya total (${rawItem.total})`
        })
      }

      if (totalCents > subtotalCents) {
        await client.query('ROLLBACK')
        return res.status(422).json({
          ok: false,
          code: 'invalid_line_pricing',
          error: `Kalem #${line.line_id || i + 1} total (${rawItem.total}) subtotal'dan (${rawItem.subtotal}) büyük olamaz`
        })
      }

      // Check divisibility to exact cents without fractional cents (0.00 tolerance)
      if (subtotalCents % qty !== 0 || (subtotalCents - totalCents) % qty !== 0) {
        await client.query('ROLLBACK')
        return res.status(422).json({
          ok: false,
          code: 'unrepresentable_line_total',
          error: `Kalem #${line.line_id || i + 1} (${line.sku}) tutarı Decco 2-ondalık finans modelinde tam temsil edilemiyor (Adet: ${qty}, Subtotal: ${rawItem.subtotal}, Total: ${rawItem.total})`
        })
      }

      const unitPriceCents = subtotalCents / qty
      const discountCents = (subtotalCents - totalCents) / qty
      const storedLineTotalCents = (unitPriceCents - discountCents) * qty

      if (storedLineTotalCents !== totalCents) {
        await client.query('ROLLBACK')
        return res.status(422).json({
          ok: false,
          code: 'unrepresentable_line_total',
          error: `Kalem #${line.line_id || i + 1} yuvarlanmış toplam (${storedLineTotalCents / 100}) beklenen total ile (${totalCents / 100}) uyuşmuyor`
        })
      }

      calculatedLineSumCents += storedLineTotalCents

      processedLines.push({
        product_id: line.product_id,
        quantity: qty,
        unit_price: (unitPriceCents / 100).toFixed(2),
        discount: (discountCents / 100).toFixed(2)
      })
    }

    if (calculatedLineSumCents !== orderTotalCents) {
      await client.query('ROLLBACK')
      return res.status(422).json({
        ok: false,
        code: 'unsupported_order_total',
        error: `Sipariş kalemleri toplamı (${calculatedLineSumCents / 100} TL) sipariş toplamı (${orderTotalCents / 100} TL) ile tam uyuşmuyor`
      })
    }

    // 9. Customer resolution
    let customerId = null
    const rawCustId = payload.customer_id
    const isRegisteredWooCustomer = rawCustId != null && Number(rawCustId) > 0

    if (isRegisteredWooCustomer) {
      const { rows: extCustRows } = await client.query(
        `SELECT r.customer_id, c.is_active, c.deleted_at
         FROM customer_external_refs r
         JOIN customers c ON c.id = r.customer_id
         WHERE r.provider = 'woocommerce' AND r.external_id = $1`,
        [String(rawCustId)]
      )

      if (extCustRows.length > 0) {
        const linked = extCustRows[0]
        if (!linked.is_active || linked.deleted_at !== null) {
          await client.query('ROLLBACK')
          return res.status(422).json({
            ok: false,
            code: 'linked_customer_inactive',
            error: `Harici WooCommerce müşterisine bağlı Decco müşteri kartı (#${linked.customer_id}) pasif veya silinmiş durumda.`
          })
        }
        customerId = linked.customer_id
      }
    }

    const billing = (payload.billing && typeof payload.billing === 'object') ? payload.billing : {}
    const shipping = (payload.shipping && typeof payload.shipping === 'object') ? payload.shipping : {}

    if (!customerId) {
      // Step 1: Match by normalized phone
      const normPhone = normalizePhone(billing.phone)
      if (normPhone) {
        const { rows: phoneMatches } = await client.query(
          `SELECT id FROM customers
           WHERE deleted_at IS NULL AND is_active = true
             AND ${PHONE_CANON_SQL} = $1`,
          [normPhone]
        )
        if (phoneMatches.length === 1) {
          customerId = phoneMatches[0].id
        } else if (phoneMatches.length > 1) {
          await client.query('ROLLBACK')
          return res.status(422).json({
            ok: false,
            code: 'ambiguous_customer',
            error: `Bu telefon numarası (${billing.phone}) sistemde birden fazla aktif müşteride kayıtlı.`
          })
        }
      }
    }

    if (!customerId) {
      // Step 2: Match by email
      const rawEmail = typeof billing.email === 'string' ? billing.email.toLowerCase().trim() : ''
      if (rawEmail) {
        const { rows: emailMatches } = await client.query(
          `SELECT id FROM customers
           WHERE deleted_at IS NULL AND is_active = true
             AND lower(trim(email)) = $1`,
          [rawEmail]
        )
        if (emailMatches.length === 1) {
          customerId = emailMatches[0].id
        } else if (emailMatches.length > 1) {
          await client.query('ROLLBACK')
          return res.status(422).json({
            ok: false,
            code: 'ambiguous_customer',
            error: `Bu e-posta adresi (${billing.email}) sistemde birden fazla aktif müşteride kayıtlı.`
          })
        }
      }
    }

    if (!customerId) {
      // Step 3: Create new customer
      const bFirst = typeof billing.first_name === 'string' ? billing.first_name.trim() : ''
      const bLast = typeof billing.last_name === 'string' ? billing.last_name.trim() : ''
      const sFirst = typeof shipping.first_name === 'string' ? shipping.first_name.trim() : ''
      const sLast = typeof shipping.last_name === 'string' ? shipping.last_name.trim() : ''
      const bComp = typeof billing.company === 'string' ? billing.company.trim() : ''

      let custName = `${bFirst} ${bLast}`.trim()
      if (!custName) custName = `${sFirst} ${sLast}`.trim()
      if (!custName) custName = bComp

      if (!custName) {
        await client.query('ROLLBACK')
        return res.status(422).json({
          ok: false,
          code: 'missing_customer_name',
          error: 'Siparişte geçerli bir müşteri adı/soyadı veya şirket unvanı bulunamadı.'
        })
      }

      const fullAddress = [billing.address_1, billing.address_2].filter(Boolean).map(s => String(s).trim()).join(' ') || null

      const { rows: newCustRows } = await client.query(
        `INSERT INTO customers (name, phone, email, channel, city, district, address)
         VALUES ($1, $2, $3, 'web', $4, $5, $6)
         RETURNING id`,
        [
          custName,
          normalizePhone(billing.phone) || billing.phone || null,
          billing.email?.trim() || null,
          billing.city?.trim() || null,
          billing.state?.trim() || null,
          fullAddress
        ]
      )
      customerId = newCustRows[0].id
    }

    // Step 4: If registered Woo customer, insert customer_external_refs
    if (isRegisteredWooCustomer) {
      await client.query(
        `INSERT INTO customer_external_refs (customer_id, provider, external_id)
         VALUES ($1, 'woocommerce', $2)
         ON CONFLICT (customer_id, provider) DO NOTHING`,
        [customerId, String(rawCustId)]
      )
    }

    // 10. Order date parsing: date_created_gmt as UTC, otherwise fallback to event.received_at
    let orderDateIso = null
    if (payload.date_created_gmt && typeof payload.date_created_gmt === 'string') {
      orderDateIso = parseUtcDate(payload.date_created_gmt)
    }
    if (!orderDateIso) {
      orderDateIso = event.received_at ? new Date(event.received_at).toISOString() : new Date().toISOString()
    }

    // 11. Create Order
    const { rows: orderRows } = await client.query(
      `INSERT INTO orders (customer_id, source, total_amount, order_date, notes)
       VALUES ($1, 'web', $2, $3, $4)
       RETURNING id, order_no, total_amount, paid_amount, status`,
      [customerId, (orderTotalCents / 100).toFixed(2), orderDateIso, payload.customer_note || null]
    )
    const newOrder = orderRows[0]

    // 12. Create Order Items
    for (const pLine of processedLines) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, quantity, unit_price, discount, material_selections, personalization, notes)
         VALUES ($1, $2, $3, $4, $5, '{}', NULL, NULL)`,
        [newOrder.id, pLine.product_id, pLine.quantity, pLine.unit_price, pLine.discount]
      )
    }

    // 13. Address Snapshots (Billing always, Shipping ONLY IF real meaningful shipping data exists)
    await client.query(
      `INSERT INTO order_addresses (order_id, address_type, first_name, last_name, company, phone, email, address_1, address_2, city, district, state, postcode, country)
       VALUES ($1, 'billing', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        newOrder.id,
        billing.first_name?.trim() || null,
        billing.last_name?.trim() || null,
        billing.company?.trim() || null,
        billing.phone?.trim() || null,
        billing.email?.trim() || null,
        billing.address_1?.trim() || null,
        billing.address_2?.trim() || null,
        billing.city?.trim() || null,
        billing.state?.trim() || null,
        billing.state?.trim() || null,
        billing.postcode?.trim() || null,
        billing.country?.trim() || 'TR'
      ]
    )

    if (hasMeaningfulShipping(shipping)) {
      await client.query(
        `INSERT INTO order_addresses (order_id, address_type, first_name, last_name, company, phone, email, address_1, address_2, city, district, state, postcode, country)
         VALUES ($1, 'shipping', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          newOrder.id,
          shipping.first_name?.trim() || null,
          shipping.last_name?.trim() || null,
          shipping.company?.trim() || null,
          shipping.phone?.trim() || null,
          shipping.email?.trim() || null,
          shipping.address_1?.trim() || null,
          shipping.address_2?.trim() || null,
          shipping.city?.trim() || null,
          shipping.state?.trim() || null,
          shipping.state?.trim() || null,
          shipping.postcode?.trim() || null,
          shipping.country?.trim() || 'TR'
        ]
      )
    }

    // 14. Order External Ref
    await client.query(
      `INSERT INTO order_external_refs (order_id, provider, external_id)
       VALUES ($1, 'woocommerce', $2)`,
      [newOrder.id, wooOrderId]
    )

    // 15. Payment processing if paid
    if (isPaid) {
      const { rows: paytrAccRows } = await client.query(
        `SELECT id FROM accounts
         WHERE name = 'PayTR' AND account_type = 'card' AND is_active = true
         FOR UPDATE`
      )

      if (paytrAccRows.length !== 1) {
        await client.query('ROLLBACK')
        return res.status(422).json({
          ok: false,
          code: 'paytr_account_not_found',
          error: `PayTR aktif hesabı bulunamadı (Eşleşen: ${paytrAccRows.length})`
        })
      }

      const paytrAccount = paytrAccRows[0]
      const orderTotal = (orderTotalCents / 100).toFixed(2)
      const desc = `WooCommerce Sipariş #${wooOrderId} (PayTR${payload.transaction_id ? ' - İşlem No: ' + payload.transaction_id : ''})`

      await applyCustomerPayment(client, {
        customer_id: customerId,
        account_id: paytrAccount.id,
        amount: parseFloat(orderTotal),
        method: 'account',
        paid_at: paidAtIso,
        description: desc,
        allocations: [{ order_id: newOrder.id, amount: parseFloat(orderTotal) }]
      })
    }

    // 16. Update integration event status
    await client.query(
      `UPDATE integration_events
       SET status = 'processed', processed_at = NOW(), error_message = NULL
       WHERE id = $1`,
      [event.id]
    )

    await client.query('COMMIT')

    // Fetch updated order status
    const { rows: finalOrderRows } = await query(
      `SELECT id, order_no, total_amount, paid_amount, status FROM orders WHERE id = $1`,
      [newOrder.id]
    )

    res.status(201).json({
      ok: true,
      order_id: newOrder.id,
      order_no: finalOrderRows[0]?.order_no || newOrder.order_no,
      customer_id: customerId,
      status: finalOrderRows[0]?.status || newOrder.status,
      paid_amount: finalOrderRows[0]?.paid_amount || '0.00',
      payment_processed: isPaid
    })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    next(err)
  } finally {
    client.release()
  }
})

export default router

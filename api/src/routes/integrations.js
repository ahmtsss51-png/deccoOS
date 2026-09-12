import crypto from 'crypto'
import { Router } from 'express'
import { pool, query } from '../db.js'
import { normalizePhone, PHONE_CANON_SQL } from './customers.js'
import { applyCustomerPayment } from './finance.js'
import {
  queryPaytrStatus,
  createPaytrLink,
  validatePaytrCallbackUrl,
  centsToDecimalString,
  parsePaytrPaymentDate
} from '../services/paytr.js'
import { isSystemOpen } from '../opening-guard.js'

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

/**
 * GET /api/integrations/paytr/status/:merchantOid
 * JWT-korumalı, salt-okunur PayTR Durum Sorgu endpoint'i.
 * Decco OS veritabanında KESİNLİKLE hiçbir finansal veya kayıt mutasyonu YAPMAZ.
 */
router.get('/paytr/status/:merchantOid', async (req, res, next) => {
  try {
    const { merchantOid } = req.params

    if (!merchantOid || /\s/.test(merchantOid)) {
      return res.status(400).json({
        error: 'merchant_oid boşluk içeremez ve boş olamaz',
        code: 'INVALID_MERCHANT_OID'
      })
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(merchantOid)) {
      return res.status(400).json({
        error: 'merchant_oid biçimi geçersiz',
        code: 'INVALID_MERCHANT_OID'
      })
    }

    const result = await queryPaytrStatus(merchantOid)

    if (!result.ok) {
      if (result.error_code === 'PAYTR_STATUS_ERROR') {
        return res.status(422).json({
          error: result.err_msg,
          err_no: result.err_no,
          code: result.error_code
        })
      }
      if (result.error_code === 'PAYTR_CREDENTIALS_MISSING') {
        return res.status(500).json({
          error: result.message,
          code: result.error_code
        })
      }
      return res.status(502).json({
        error: result.message,
        code: result.error_code
      })
    }

    res.json(result.data)
  } catch (err) {
    next(err)
  }
})

/**
 * POST /api/integrations/paytr/orders/:orderId/create-link
 * Decco siparişine ait PayTR ödeme linki oluşturur.
 * DB transaction ile uzak ağ çağrısı birbirinden ayrılmıştır (State Machine: creating -> pending / create_unknown / failed).
 * Finansal mutasyon KESİNLİKLE YAPMAZ.
 */
router.post('/paytr/orders/:orderId/create-link', async (req, res, next) => {
  try {
    const orderId = parseInt(req.params.orderId, 10)
    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({ error: 'Geçersiz orderId', code: 'INVALID_ORDER_ID' })
    }

    // 1. max_installment doğrulaması (PayTR kuralı: 1..12 tam sayı, varsayılan: 1)
    let maxInstallment = 1
    if (req.body?.max_installment !== undefined && req.body?.max_installment !== null && req.body?.max_installment !== '') {
      const parsed = Number(req.body.max_installment)
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 12) {
        return res.status(400).json({
          error: 'max_installment 1 ile 12 arasında bir tam sayı olmalıdır',
          code: 'INVALID_MAX_INSTALLMENT'
        })
      }
      maxInstallment = parsed
    }

    // 2. Pre-flight Config Doğrulaması (DB rezervasyonu yapılmadan ÖNCE kontrol edilir)
    const merchantId = process.env.PAYTR_MERCHANT_ID
    const merchantKey = process.env.PAYTR_MERCHANT_KEY
    const merchantSalt = process.env.PAYTR_MERCHANT_SALT

    if (!merchantId || !merchantKey || !merchantSalt) {
      return res.status(500).json({
        error: 'PayTR API kimlik bilgileri yapılandırılmamış',
        code: 'PAYTR_CREDENTIALS_MISSING'
      })
    }

    const configuredCallbackUrl =
      process.env.PAYTR_LINK_CALLBACK_URL ||
      (process.env.NODE_ENV !== 'production' ? req.headers['x-paytr-test-callback-url'] : null)

    const callbackValidation = validatePaytrCallbackUrl(configuredCallbackUrl)
    if (!callbackValidation.valid) {
      return res.status(400).json({
        error: callbackValidation.message,
        code: callbackValidation.error_code
      })
    }
    const callbackLink = callbackValidation.url

    // 3. Kısa DB Rezervasyonu (Adım 1 - Order Lock & Creating State)
    const client = await pool.connect()
    let linkId
    let callbackId
    let requestedCents
    let requestedAmountStr
    let orderNo

    try {
      await client.query('BEGIN')

      const { rows: orderRows } = await client.query(
        `SELECT id, order_no, total_amount, paid_amount, status, deleted_at
         FROM orders
         WHERE id = $1
         FOR UPDATE`,
        [orderId]
      )

      if (orderRows.length === 0 || orderRows[0].deleted_at) {
        await client.query('ROLLBACK')
        return res.status(404).json({ error: 'Sipariş bulunamadı', code: 'ORDER_NOT_FOUND' })
      }

      const order = orderRows[0]
      if (order.status === 'cancelled') {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'İptal edilmiş siparişe ödeme linki açılamaz', code: 'ORDER_CANCELLED' })
      }

      orderNo = order.order_no

      // Exact cents hesabı: total_amount - paid_amount
      const totalCents = parseDecimalToCents(order.total_amount)
      const paidCents = parseDecimalToCents(order.paid_amount || '0.00')

      if (totalCents == null || paidCents == null) {
        await client.query('ROLLBACK')
        return res.status(422).json({ error: 'Sipariş tutarı hesaplanamadı', code: 'INVALID_ORDER_TOTAL' })
      }

      requestedCents = totalCents - paidCents
      if (requestedCents <= 0) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'Siparişin açık bakiyesi bulunmamaktadır (zaten ödendi)', code: 'ORDER_ALREADY_PAID' })
      }

      requestedAmountStr = centsToDecimalString(requestedCents)

      // Aktif link kontrolü (creating, pending, create_unknown)
      const { rows: activeLinks } = await client.query(
        `SELECT id, status
         FROM paytr_payment_links
         WHERE order_id = $1 AND status IN ('creating', 'pending', 'create_unknown')
         FOR UPDATE`,
        [orderId]
      )

      if (activeLinks.length > 0) {
        await client.query('ROLLBACK')
        return res.status(409).json({
          error: `Sipariş için zaten aktif bir ödeme linki mevcut (#${activeLinks[0].id} - ${activeLinks[0].status})`,
          code: 'ACTIVE_LINK_EXISTS',
          link_id: activeLinks[0].id,
          status: activeLinks[0].status
        })
      }

      callbackId = crypto.randomBytes(24).toString('hex')

      const { rows: insertedRows } = await client.query(
        `INSERT INTO paytr_payment_links (order_id, callback_id, requested_amount, currency, status)
         VALUES ($1, $2, $3, 'TL', 'creating')
         RETURNING id`,
        [orderId, callbackId, requestedAmountStr]
      )
      linkId = insertedRows[0].id

      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      if (err.code === '23505') {
        return res.status(409).json({
          error: 'Sipariş için aktif bir link zaten oluşturuluyor veya mevcut',
          code: 'ACTIVE_LINK_EXISTS'
        })
      }
      throw err
    } finally {
      client.release()
    }

    // 4. Uzak PayTR HTTP Çağrısı (Adım 2 - DB bağlantısı ve kilit tutulmaz)
    const linkName = `Decco Sipariş ${orderNo}`
    const createRes = await createPaytrLink({
      name: linkName,
      price: String(requestedCents),
      currency: 'TL',
      max_installment: String(maxInstallment),
      link_type: 'product',
      lang: 'tr',
      min_count: '1',
      max_count: '1',
      callback_link: callbackLink,
      callback_id: callbackId,
      debug_on: '1'
    })

    // 5. Sonuç Çözümleme & Callback Yarışı Koruması (Adım 3 - Kısa DB Güncellemesi)
    const finClient = await pool.connect()
    try {
      await finClient.query('BEGIN')

      const { rows: curRows } = await finClient.query(
        `SELECT id, status, paytr_link_id, link_url
         FROM paytr_payment_links
         WHERE id = $1
         FOR UPDATE`,
        [linkId]
      )

      if (curRows.length === 0) {
        await finClient.query('COMMIT')
        return res.status(500).json({ error: 'Oluşturulan link kaydı bulunamadı', code: 'LINK_RECORD_NOT_FOUND' })
      }

      const currentLink = curRows[0]

      if (createRes.ok) {
        const { paytr_link_id, link_url } = createRes.data

        if (currentLink.status === 'paid') {
          // Callback Create API yanıtından önce gelip linki paid yapmışsa status'ü pendinge DÜŞÜRME!
          await finClient.query(
            `UPDATE paytr_payment_links
             SET paytr_link_id = COALESCE(paytr_link_id, $1),
                 link_url = COALESCE(link_url, $2)
             WHERE id = $3`,
            [paytr_link_id, link_url, linkId]
          )
        } else {
          // Normal başarılı geçiş: creating -> pending
          await finClient.query(
            `UPDATE paytr_payment_links
             SET status = 'pending',
                 paytr_link_id = $1,
                 link_url = $2
             WHERE id = $3`,
            [paytr_link_id, link_url, linkId]
          )
        }

        await finClient.query('COMMIT')

        return res.status(201).json({
          ok: true,
          link_id: linkId,
          paytr_link_id,
          link_url,
          requested_amount: requestedAmountStr,
          currency: 'TL',
          status: currentLink.status === 'paid' ? 'paid' : 'pending',
          callback_id: callbackId
        })
      } else {
        // Hata durumu: Açık ret ('failed') vs Belirsizlik ('create_unknown')
        const newStatus = createRes.error_type === 'rejected' ? 'failed' : 'create_unknown'

        if (currentLink.status === 'paid') {
          // Callback ödendi dediyse paid korunsun
        } else {
          await finClient.query(
            `UPDATE paytr_payment_links
             SET status = $1
             WHERE id = $2`,
            [newStatus, linkId]
          )
        }

        await finClient.query('COMMIT')

        const httpStatus = createRes.error_type === 'rejected' ? 422 : 502
        return res.status(httpStatus).json({
          error: createRes.reason || createRes.message || 'PayTR link oluşturulamadı',
          code: createRes.error_code,
          status: currentLink.status === 'paid' ? 'paid' : newStatus,
          link_id: linkId
        })
      }
    } catch (err) {
      await finClient.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      finClient.release()
    }

  } catch (err) {
    next(err)
  }
})

/**
 * POST /api/integrations/paytr/events/:eventId/process
 * PayTR Link Payment Processing — Verified Finance Foundation
 *
 * Converts a verified PayTR link callback event into a real customer payment via Decco finance engine.
 * Flow:
 * A - Read Phase: event + link + order lookup (read-only, no locks)
 * B - Remote Verification: queryPaytrStatus(merchant_oid) (executed with ZERO DB locks held)
 * C - Finance Transaction: single PostgreSQL transaction locking event, link, order FOR UPDATE,
 *     strictly verifying idempotency via payment_external_refs, calling applyCustomerPayment(),
 *     inserting payment_external_refs, setting link.paid_at and event.status='processed'.
 */
router.post('/paytr/events/:eventId/process', async (req, res, next) => {
  try {
    if (!(await isSystemOpen())) {
      return res.status(423).json({
        error: 'Sistem PRE-OPENING modunda. Finansal işlem yapılamaz.',
        code: 'PRE_OPENING_MODE'
      })
    }

    const eventId = parseInt(req.params.eventId, 10)
    if (!Number.isInteger(eventId) || eventId <= 0) {
      return res.status(400).json({ error: 'Geçersiz event kimliği', code: 'INVALID_EVENT_ID' })
    }

    // A — Read phase (read-only, no locks)
    const { rows: eventRows } = await query(
      `SELECT id, provider, event_type, status, payload, error_message, processed_at
       FROM integration_events
       WHERE id = $1`,
      [eventId]
    )
    if (eventRows.length === 0) {
      return res.status(404).json({ error: 'Entegrasyon eventi bulunamadı', code: 'EVENT_NOT_FOUND' })
    }
    const event = eventRows[0]

    if (event.provider !== 'paytr' || event.event_type !== 'link.payment.success') {
      return res.status(422).json({
        error: 'Yalnızca PayTR link.payment.success eventleri işlenebilir',
        code: 'UNPROCESSABLE_EVENT_TYPE'
      })
    }

    const merchantOid = event.payload?.merchant_oid
    const callbackId = event.payload?.callback_id

    if (event.status === 'processed') {
      if (merchantOid) {
        const { rows: refRows } = await query(
          `SELECT payment_id FROM payment_external_refs
           WHERE provider = 'paytr' AND reference_type = 'merchant_oid' AND external_id = $1`,
          [merchantOid]
        )
        return res.status(200).json({
          ok: true,
          already_processed: true,
          event_id: event.id,
          payment_id: refRows[0]?.payment_id || null,
          message: 'Event zaten başarıyla işlenmiş (idempotent)'
        })
      }
      return res.status(200).json({
        ok: true,
        already_processed: true,
        event_id: event.id,
        message: 'Event zaten başarıyla işlenmiş (idempotent)'
      })
    }

    if (event.status !== 'received') {
      return res.status(422).json({
        error: `Event '${event.status}' durumunda, işlenemez`,
        code: 'EVENT_NOT_READY'
      })
    }

    if (!merchantOid || !callbackId) {
      return res.status(422).json({
        error: 'Event payload içinde merchant_oid veya callback_id eksik',
        code: 'INVALID_EVENT_PAYLOAD'
      })
    }

    const { rows: linkRows } = await query(
      `SELECT l.*, o.customer_id, o.order_no, o.total_amount AS order_total, o.paid_amount AS order_paid,
              o.status AS order_status, o.deleted_at AS order_deleted_at
       FROM paytr_payment_links l
       JOIN orders o ON o.id = l.order_id
       WHERE l.callback_id = $1`,
      [callbackId]
    )
    if (linkRows.length === 0) {
      return res.status(404).json({
        error: 'İlgili PayTR link kaydı veya sipariş bulunamadı',
        code: 'LINK_NOT_FOUND'
      })
    }
    const link = linkRows[0]

    if (link.merchant_oid !== merchantOid) {
      return res.status(422).json({
        error: 'Link merchant_oid ile event merchant_oid uyuşmuyor',
        code: 'MERCHANT_OID_MISMATCH'
      })
    }
    if (link.status !== 'paid') {
      return res.status(422).json({
        error: `Link henüz 'paid' durumunda değil (durum: ${link.status})`,
        code: 'LINK_NOT_PAID'
      })
    }
    if (link.order_deleted_at || link.order_status === 'cancelled') {
      return res.status(422).json({
        error: 'Sipariş silinmiş veya iptal edilmiş',
        code: 'ORDER_INACTIVE'
      })
    }

    // B — Remote verification (queryPaytrStatus with ZERO DB locks)
    let statusRes
    try {
      statusRes = await queryPaytrStatus(merchantOid)
    } catch (err) {
      return res.status(502).json({
        error: 'PayTR durum sorgu servisine erişilemedi: ' + err.message,
        code: 'PAYTR_UPSTREAM_ERROR'
      })
    }

    if (!statusRes.ok) {
      return res.status(502).json({
        error: statusRes.reason || statusRes.message || 'PayTR durum sorgusu başarısız',
        code: statusRes.error_code || 'PAYTR_QUERY_FAILED'
      })
    }

    const statusData = statusRes.data

    if (statusData.status !== 'success') {
      return res.status(422).json({
        error: `PayTR ödeme durumu '${statusData.status}', ödeme başarılı değil`,
        code: 'PAYTR_STATUS_NOT_SUCCESS'
      })
    }

    if (statusData.merchant_oid !== merchantOid) {
      return res.status(422).json({
        error: 'PayTR yanıtındaki merchant_oid ile sorgulanan merchant_oid uyuşmuyor',
        code: 'PAYTR_OID_MISMATCH'
      })
    }

    // Guard 1: Currency must be TL or TRY (Requirement 1)
    const rawCurrency = (statusData.currency || '').toUpperCase()
    if (rawCurrency !== 'TL' && rawCurrency !== 'TRY') {
      return res.status(422).json({
        error: `Desteklenmeyen para birimi: '${statusData.currency}'. Yalnızca TL ve TRY kabul edilir`,
        code: 'UNSUPPORTED_PAYTR_CURRENCY'
      })
    }

    // Guard 2: Returns must be empty (Requirement 2)
    if (Array.isArray(statusData.returns) && statusData.returns.length > 0) {
      return res.status(422).json({
        error: 'PayTR Durum Sorgusu iade/kısmi iade kaydı içeriyor. İadeli ödemeler bu fazda işlenemez',
        code: 'PAYTR_REFUND_PRESENT'
      })
    }

    // Guard 3: Test mode blocked in ALL environments (Requirement 3)
    if (statusData.test_mode === 1) {
      return res.status(422).json({
        error: 'PayTR test modu ödemeleri için finansal mutasyon yapılamaz',
        code: 'PAYTR_TEST_MODE_PAYMENT'
      })
    }

    // Guard 4: payment_amount exact cents match with link.requested_amount
    const requestedCents = parseDecimalToCents(link.requested_amount)
    if (statusData.payment_amount_cents == null || statusData.payment_amount_cents !== requestedCents) {
      return res.status(422).json({
        error: `PayTR ödeme tutarı (${statusData.payment_amount}) ile talep edilen tutar (${link.requested_amount}) uyuşmuyor`,
        code: 'PAYMENT_AMOUNT_MISMATCH'
      })
    }

    const verifiedPaidAt = parsePaytrPaymentDate(statusData.payment_date, statusData.auth_date)

    // C — Finance transaction (Single PostgreSQL transaction)
    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      // 1. Lock integration_events FOR UPDATE
      const { rows: lockEvRows } = await client.query(
        `SELECT id, status FROM integration_events WHERE id = $1 FOR UPDATE`,
        [eventId]
      )
      if (lockEvRows.length === 0) {
        await client.query('ROLLBACK')
        return res.status(404).json({ error: 'Event bulunamadı', code: 'EVENT_NOT_FOUND' })
      }
      const curEvent = lockEvRows[0]
      if (curEvent.status === 'processed') {
        const { rows: refRows } = await client.query(
          `SELECT payment_id FROM payment_external_refs
           WHERE provider = 'paytr' AND reference_type = 'merchant_oid' AND external_id = $1`,
          [merchantOid]
        )
        await client.query('COMMIT')
        return res.status(200).json({
          ok: true,
          already_processed: true,
          event_id: eventId,
          payment_id: refRows[0]?.payment_id || null,
          message: 'Event başka bir eşzamanlı işlem tarafından işlendi (idempotent)'
        })
      }
      if (curEvent.status !== 'received') {
        await client.query('ROLLBACK')
        return res.status(422).json({ error: `Event '${curEvent.status}' durumunda`, code: 'EVENT_NOT_READY' })
      }

      // 2. Lock paytr_payment_links FOR UPDATE
      const { rows: lockLinkRows } = await client.query(
        `SELECT id, order_id, callback_id, merchant_oid, requested_amount, status, paid_at
         FROM paytr_payment_links
         WHERE id = $1 FOR UPDATE`,
        [link.id]
      )
      if (lockLinkRows.length === 0) {
        await client.query('ROLLBACK')
        return res.status(404).json({ error: 'Link bulunamadı', code: 'LINK_NOT_FOUND' })
      }
      const curLink = lockLinkRows[0]
      if (curLink.status !== 'paid') {
        await client.query('ROLLBACK')
        return res.status(422).json({ error: `Link durumu '${curLink.status}', paid değil`, code: 'LINK_NOT_PAID' })
      }

      // 3. Lock orders FOR UPDATE
      const { rows: lockOrderRows } = await client.query(
        `SELECT id, customer_id, order_no, total_amount, paid_amount, status, deleted_at
         FROM orders
         WHERE id = $1 FOR UPDATE`,
        [curLink.order_id]
      )
      if (lockOrderRows.length === 0) {
        await client.query('ROLLBACK')
        return res.status(404).json({ error: 'Sipariş bulunamadı', code: 'ORDER_NOT_FOUND' })
      }
      const curOrder = lockOrderRows[0]
      if (curOrder.deleted_at || curOrder.status === 'cancelled') {
        await client.query('ROLLBACK')
        return res.status(422).json({ error: 'Sipariş iptal edilmiş veya silinmiş', code: 'ORDER_INACTIVE' })
      }

      // 4. Resolve Active PayTR Card Account
      const { rows: accRows } = await client.query(
        `SELECT id, name, account_type, balance, is_active
         FROM accounts
         WHERE name = 'PayTR' AND account_type = 'card' AND is_active = true`
      )
      if (accRows.length !== 1) {
        await client.query('ROLLBACK')
        return res.status(422).json({
          error: `Aktif PayTR kart hesabı bulunamadı veya birden fazla bulundu (${accRows.length})`,
          code: 'PAYTR_ACCOUNT_INVALID'
        })
      }
      const paytrAccount = accRows[0]

      // 5. Strict payment_external_refs idempotency & conflict verification (Requirement 4)
      const { rows: existingRefRows } = await client.query(
        `SELECT r.payment_id, cp.customer_id, cp.account_id, cp.amount AS payment_amount
         FROM payment_external_refs r
         JOIN customer_payments cp ON cp.id = r.payment_id
         WHERE r.provider = 'paytr' AND r.reference_type = 'merchant_oid' AND r.external_id = $1
         FOR UPDATE OF r`,
        [merchantOid]
      )

      if (existingRefRows.length > 0) {
        const existingRef = existingRefRows[0]
        const { rows: allocRows } = await client.query(
          `SELECT order_id, amount FROM customer_payment_allocations WHERE payment_id = $1`,
          [existingRef.payment_id]
        )

        const paymentAmountCents = parseDecimalToCents(existingRef.payment_amount)
        const isCustomerMatch = existingRef.customer_id === curOrder.customer_id
        const isAmountMatch = paymentAmountCents === statusData.payment_amount_cents
        const isAccountMatch = existingRef.account_id === paytrAccount.id
        const isSingleAlloc = allocRows.length === 1
        const allocOrderMatch = isSingleAlloc && allocRows[0].order_id === curOrder.id
        const allocAmountMatch = isSingleAlloc && parseDecimalToCents(allocRows[0].amount) === statusData.payment_amount_cents

        if (isCustomerMatch && isAmountMatch && isAccountMatch && allocOrderMatch && allocAmountMatch) {
          // All 5 strict conditions match -> Idempotent success
          await client.query(
            `UPDATE integration_events
             SET status = 'processed', processed_at = NOW(), error_message = NULL
             WHERE id = $1`,
            [eventId]
          )
          if (verifiedPaidAt && !curLink.paid_at) {
            await client.query(
              `UPDATE paytr_payment_links SET paid_at = $1 WHERE id = $2`,
              [verifiedPaidAt, curLink.id]
            )
          }
          await client.query('COMMIT')
          return res.status(200).json({
            ok: true,
            already_processed: true,
            event_id: eventId,
            payment_id: existingRef.payment_id,
            order_id: curOrder.id,
            amount: centsToDecimalString(statusData.payment_amount_cents),
            message: 'Ödeme referansı zaten mevcut ve doğrulandı (idempotent)'
          })
        } else {
          // Mismatch conflict! Do NOT mark event processed.
          await client.query('ROLLBACK')
          return res.status(409).json({
            error: 'PayTR ödeme referansı mevcut ancak müşteri, tutar, hesap veya sipariş eşleşmiyor',
            code: 'PAYMENT_REFERENCE_CONFLICT'
          })
        }
      }

      // 6. Open balance guard
      const orderTotalCents = parseDecimalToCents(curOrder.total_amount) || 0
      const orderPaidCents = parseDecimalToCents(curOrder.paid_amount) || 0
      const openBalanceCents = orderTotalCents - orderPaidCents
      if (openBalanceCents < statusData.payment_amount_cents) {
        await client.query('ROLLBACK')
        return res.status(422).json({
          error: `Sipariş açık bakiyesi (${centsToDecimalString(openBalanceCents)}) tahsilat tutarından (${centsToDecimalString(statusData.payment_amount_cents)}) küçük, aşırı ödeme yapılamaz`,
          code: 'ORDER_OVERPAYMENT'
        })
      }

      // 7. Apply Customer Payment via Decco Finance Engine
      const paymentAmountDecimal = parseFloat(centsToDecimalString(statusData.payment_amount_cents))
      const paymentDesc = `PayTR Link Ödemesi: #${curOrder.order_no || curOrder.id} (OID: ${merchantOid})`

      const paymentResult = await applyCustomerPayment(client, {
        customer_id: curOrder.customer_id,
        account_id: paytrAccount.id,
        amount: paymentAmountDecimal,
        method: 'credit_card',
        paid_at: verifiedPaidAt,
        description: paymentDesc,
        allocations: [{
          order_id: curOrder.id,
          amount: paymentAmountDecimal
        }]
      })

      const newPaymentId = paymentResult?.payment_id
      if (!newPaymentId) {
        await client.query('ROLLBACK')
        return res.status(500).json({
          error: 'applyCustomerPayment geçerli bir payment_id döndürmedi',
          code: 'PAYMENT_CREATION_FAILED'
        })
      }

      // 8. Insert payment_external_refs (handles 23505 race condition fallback)
      try {
        await client.query(
          `INSERT INTO payment_external_refs (payment_id, provider, reference_type, external_id)
           VALUES ($1, 'paytr', 'merchant_oid', $2)`,
          [newPaymentId, merchantOid]
        )
      } catch (refErr) {
        if (refErr.code === '23505') {
          await client.query('ROLLBACK')
          return res.status(409).json({
            error: 'Eşzamanlı istek sonucunda ödeme referansı zaten oluşturuldu',
            code: 'PAYMENT_REFERENCE_CONFLICT'
          })
        }
        throw refErr
      }

      // 9. Update paytr_payment_links.paid_at
      if (verifiedPaidAt) {
        await client.query(
          `UPDATE paytr_payment_links SET paid_at = $1 WHERE id = $2`,
          [verifiedPaidAt, curLink.id]
        )
      }

      // 10. Update integration_events to processed
      await client.query(
        `UPDATE integration_events
         SET status = 'processed', processed_at = NOW(), error_message = NULL
         WHERE id = $1`,
        [eventId]
      )

      await client.query('COMMIT')

      return res.status(200).json({
        ok: true,
        event_id: eventId,
        payment_id: newPaymentId,
        order_id: curOrder.id,
        amount: centsToDecimalString(statusData.payment_amount_cents),
        currency: statusData.currency,
        paid_at: verifiedPaidAt,
        merchant_oid: merchantOid,
        message: 'PayTR link ödemesi başarıyla finansal tahsilata dönüştürüldü'
      })

    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }

  } catch (err) {
    next(err)
  }
})

export default router

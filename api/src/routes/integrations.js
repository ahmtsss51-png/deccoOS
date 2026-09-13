import crypto from 'crypto'
import { Router } from 'express'
import { pool, query } from '../db.js'
import { normalizePhone, PHONE_CANON_SQL } from './customers.js'
import { applyCustomerPayment, recordAccountExpense, executeAccountTransfer } from './finance.js'
import {
  queryPaytrStatus,
  createPaytrLink,
  validatePaytrCallbackUrl,
  centsToDecimalString,
  parsePaytrPaymentDate,
  parseDecimalToCents,
  parsePaytrDateToCalendarDate,
  generatePaytrReportToken,
  splitDateRangeInto3DayChunks,
  computeHistoryTransactionSignature,
  queryPaytrTransactionReport
} from '../services/paytr.js'
import { isSystemOpen } from '../opening-guard.js'
import {
  getAdAccountDetails,
  getDailyInsights,
  getCampaignInsights,
  getMetaAdsConfig
} from '../services/meta-ads.js'

export { parseDecimalToCents }

const router = Router()

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
/**
 * GET /api/integrations/paytr/config
 * Read-only configuration & readiness status for PayTR integration.
 * NEVER returns sensitive credentials (merchant key/salt).
 */
router.get('/paytr/config', async (req, res, next) => {
  try {
    const merchantId = process.env.PAYTR_MERCHANT_ID
    const merchantKey = process.env.PAYTR_MERCHANT_KEY
    const merchantSalt = process.env.PAYTR_MERCHANT_SALT

    const credentialsConfigured = Boolean(merchantId && merchantKey && merchantSalt)

    const configuredCallbackUrl = process.env.PAYTR_LINK_CALLBACK_URL
    const callbackValidation = validatePaytrCallbackUrl(configuredCallbackUrl)
    const callbackReady = callbackValidation.valid

    const callbackMessage = callbackReady
      ? 'Canlı PayTR bağlantısı aktif'
      : (callbackValidation.error_code === 'PAYTR_CALLBACK_URL_MISSING'
          ? 'Canlı PayTR bağlantısı sunucu kurulumu sonrası aktif edilecek'
          : callbackValidation.message || 'Canlı PayTR bağlantısı sunucu kurulumu sonrası aktif edilecek')

    const { rows: accRows } = await query(
      `SELECT id, name, balance, is_active FROM accounts WHERE name = 'PayTR' AND account_type = 'card' LIMIT 1`
    )
    const accountReady = accRows.length > 0 && accRows[0].is_active

    const systemOpen = await isSystemOpen()

    const canCreateLink = credentialsConfigured && callbackReady && accountReady && systemOpen

    res.json({
      credentials_configured: credentialsConfigured,
      callback_ready: callbackReady,
      callback_message: callbackMessage,
      account_ready: accountReady,
      paytr_account_id: accRows[0]?.id || null,
      system_open: systemOpen,
      can_create_link: canCreateLink
    })
  } catch (err) {
    next(err)
  }
})

/**
 * GET /api/integrations/paytr/summary
 * Consolidated KPI summary metrics for PayTR Dashboard.
 * Accurately isolates PayTR Link pipeline from unrelated account payments.
 * Computes pipeline_tracked_balance and unmatched_balance using exact integer cents.
 */
router.get('/paytr/summary', async (req, res, next) => {
  try {
    // 1. PayTR account
    const { rows: accRows } = await query(
      `SELECT id, name, balance, is_active FROM accounts WHERE name = 'PayTR' AND account_type = 'card' LIMIT 1`
    )
    const account = accRows[0] || null

    // 2. Pending links (creating, pending, create_unknown)
    const { rows: pendingRows } = await query(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(requested_amount), 0)::numeric(14,2) AS amount
       FROM paytr_payment_links
       WHERE status IN ('pending', 'creating', 'create_unknown')`
    )

    // 3. Needs review links (create_unknown specifically)
    const { rows: needsReviewRows } = await query(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(requested_amount), 0)::numeric(14,2) AS amount
       FROM paytr_payment_links
       WHERE status = 'create_unknown'`
    )

    // 4. Awaiting customer payment creation (webhook received but no customer_payments yet)
    const { rows: awaitProcessRows } = await query(
      `SELECT COUNT(*)::int AS count,
              COALESCE(SUM((ie.payload->>'total_amount')::numeric / 100), 0)::numeric(14,2) AS amount
       FROM integration_events ie
       WHERE ie.provider = 'paytr'
         AND ie.event_type = 'link.payment.success'
         AND ie.status = 'received'
         AND NOT EXISTS (
           SELECT 1 FROM payment_external_refs per
           WHERE per.provider = 'paytr'
             AND per.reference_type = 'merchant_oid'
             AND per.external_id = ie.payload->>'merchant_oid'
         )`
    )

    // 5. Awaiting commission reconciliation (in finance via paytr link, but not reconciled)
    const { rows: awaitReconcileRows } = await query(
      `SELECT COUNT(DISTINCT per.payment_id)::int AS count,
              COALESCE(SUM(cp.amount), 0)::numeric(14,2) AS amount
       FROM payment_external_refs per
       JOIN customer_payments cp ON cp.id = per.payment_id
       LEFT JOIN paytr_reconciliations pr ON pr.payment_id = per.payment_id
       WHERE per.provider = 'paytr'
         AND per.reference_type = 'merchant_oid'
         AND pr.id IS NULL`
    )

    // 6. Awaiting bank settlement (reconciled, but no settlement junction)
    const { rows: awaitSettlementRows } = await query(
      `SELECT COUNT(pr.id)::int AS count,
              COALESCE(SUM(pr.net_amount), 0)::numeric(14,2) AS net_amount,
              COALESCE(SUM(pr.payment_amount), 0)::numeric(14,2) AS gross_amount,
              COALESCE(SUM(pr.commission_amount), 0)::numeric(14,2) AS commission_amount
       FROM paytr_reconciliations pr
       LEFT JOIN paytr_settlement_reconciliations psr ON psr.reconciliation_id = pr.id
       WHERE psr.id IS NULL`
    )

    // 7. Total settled to bank
    const { rows: settledRows } = await query(
      `SELECT COUNT(*)::int AS count,
              COALESCE(SUM(net_amount), 0)::numeric(14,2) AS net_amount,
              COALESCE(SUM(gross_amount), 0)::numeric(14,2) AS gross_amount
       FROM paytr_settlements`
    )

    // 8. Pipeline tracked balance calculation (exact integer cents):
    // link_payments - link_commissions - link_settled_net
    const { rows: linkPayments } = await query(
      `SELECT COALESCE(SUM(cp.amount), 0)::numeric(14,2) AS amount
       FROM payment_external_refs per
       JOIN customer_payments cp ON cp.id = per.payment_id
       WHERE per.provider = 'paytr' AND per.reference_type = 'merchant_oid'`
    )
    const { rows: linkComms } = await query(
      `SELECT COALESCE(SUM(commission_amount), 0)::numeric(14,2) AS amount
       FROM paytr_reconciliations
       WHERE commission_transaction_id IS NOT NULL`
    )
    const { rows: linkSettled } = await query(
      `SELECT COALESCE(SUM(net_amount), 0)::numeric(14,2) AS amount
       FROM paytr_settlements`
    )

    const paymentsCents = parseDecimalToCents(linkPayments[0]?.amount || '0') || 0
    const commsCents = parseDecimalToCents(linkComms[0]?.amount || '0') || 0
    const settledCents = parseDecimalToCents(linkSettled[0]?.amount || '0') || 0
    const pipelineTrackedCents = Math.max(0, paymentsCents - commsCents - settledCents)

    const accountBalanceCents = account ? (parseDecimalToCents(account.balance) || 0) : 0
    const unmatchedCents = Math.max(0, accountBalanceCents - pipelineTrackedCents)

    res.json({
      account: account ? {
        id: account.id,
        name: account.name,
        balance: account.balance,
        is_active: account.is_active,
        pipeline_tracked_balance: centsToDecimalString(pipelineTrackedCents),
        unmatched_balance: centsToDecimalString(unmatchedCents)
      } : null,
      pending_links: {
        count: pendingRows[0]?.count || 0,
        amount: pendingRows[0]?.amount || '0.00'
      },
      needs_review_links: {
        count: needsReviewRows[0]?.count || 0,
        amount: needsReviewRows[0]?.amount || '0.00'
      },
      awaiting_process: {
        count: awaitProcessRows[0]?.count || 0,
        amount: awaitProcessRows[0]?.amount || '0.00'
      },
      awaiting_reconcile: {
        count: awaitReconcileRows[0]?.count || 0,
        amount: awaitReconcileRows[0]?.amount || '0.00'
      },
      awaiting_settlement: {
        count: awaitSettlementRows[0]?.count || 0,
        net_amount: awaitSettlementRows[0]?.net_amount || '0.00',
        gross_amount: awaitSettlementRows[0]?.gross_amount || '0.00',
        commission_amount: awaitSettlementRows[0]?.commission_amount || '0.00'
      },
      total_settled: {
        count: settledRows[0]?.count || 0,
        net_amount: settledRows[0]?.net_amount || '0.00',
        gross_amount: settledRows[0]?.gross_amount || '0.00'
      }
    })
  } catch (err) {
    next(err)
  }
})

/**
 * GET /api/integrations/paytr/links
 * Lists PayTR payment links with their orders, customer info, and derived mutually-exclusive pipeline_status.
 * Supports filters: order_id, pipeline_status, search, limit, offset.
 * Response: { items, total, limit, offset }
 */
router.get('/paytr/links', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100)
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0)
    const orderId = req.query.order_id ? parseInt(req.query.order_id, 10) : null
    const search = req.query.search ? String(req.query.search).trim() : null
    const filterStatus = req.query.pipeline_status ? String(req.query.pipeline_status).trim() : null

    let whereSql = 'WHERE 1=1'
    const params = []

    if (orderId && Number.isInteger(orderId)) {
      params.push(orderId)
      whereSql += ` AND pl.order_id = $${params.length}`
    }

    if (search) {
      params.push(`%${search}%`)
      whereSql += ` AND (o.order_no ILIKE $${params.length} OR c.name ILIKE $${params.length} OR c.phone ILIKE $${params.length} OR pl.merchant_oid ILIKE $${params.length})`
    }

    const pipelineCaseSql = `
      CASE
        WHEN pl.status IN ('failed', 'cancelled', 'expired') THEN 'failed'
        WHEN pl.status = 'create_unknown' THEN 'needs_review'
        WHEN pl.status = 'creating' THEN 'creating'
        WHEN ps.id IS NOT NULL THEN 'settled'
        WHEN pr.id IS NOT NULL THEN 'awaiting_settlement'
        WHEN cp.id IS NOT NULL THEN 'awaiting_reconcile'
        WHEN pl.status = 'paid' OR ie.id IS NOT NULL THEN 'awaiting_process'
        ELSE 'pending'
      END
    `

    let fullWhereSql = whereSql
    if (filterStatus) {
      params.push(filterStatus)
      fullWhereSql += ` AND (${pipelineCaseSql}) = $${params.length}`
    }

    const countSql = `
      SELECT COUNT(*)::int AS total
      FROM paytr_payment_links pl
      JOIN orders o ON o.id = pl.order_id
      JOIN customers c ON c.id = o.customer_id
      LEFT JOIN integration_events ie ON ie.provider = 'paytr'
        AND ie.event_type = 'link.payment.success'
        AND ie.payload->>'merchant_oid' = pl.merchant_oid
      LEFT JOIN payment_external_refs per ON per.provider = 'paytr'
        AND per.reference_type = 'merchant_oid'
        AND per.external_id = pl.merchant_oid
      LEFT JOIN customer_payments cp ON cp.id = per.payment_id
      LEFT JOIN paytr_reconciliations pr ON pr.merchant_oid = pl.merchant_oid
      LEFT JOIN paytr_settlement_reconciliations psr ON psr.reconciliation_id = pr.id
      LEFT JOIN paytr_settlements ps ON ps.id = psr.settlement_id
      ${fullWhereSql}
    `
    const { rows: countRows } = await query(countSql, params)
    const total = countRows[0]?.total || 0

    params.push(limit)
    const limitIdx = params.length
    params.push(offset)
    const offsetIdx = params.length

    const dataSql = `
      SELECT
        pl.id AS link_id,
        pl.order_id,
        o.order_no,
        c.id AS customer_id,
        c.name AS customer_name,
        c.phone AS customer_phone,
        c.email AS customer_email,
        pl.callback_id,
        pl.merchant_oid,
        pl.requested_amount,
        pl.currency,
        pl.status AS raw_link_status,
        pl.link_url,
        pl.created_at,
        pl.paid_at,
        pl.expires_at,
        ie.id AS event_id,
        ie.status AS event_status,
        cp.id AS payment_id,
        cp.amount AS payment_amount,
        cp.paid_at AS payment_date,
        pr.id AS reconciliation_id,
        pr.commission_amount,
        pr.net_amount,
        pr.reconciled_at,
        ps.id AS settlement_id,
        ps.settlement_ref,
        ps.bank_value_date AS settlement_date,
        (${pipelineCaseSql}) AS pipeline_status
      FROM paytr_payment_links pl
      JOIN orders o ON o.id = pl.order_id
      JOIN customers c ON c.id = o.customer_id
      LEFT JOIN integration_events ie ON ie.provider = 'paytr'
        AND ie.event_type = 'link.payment.success'
        AND ie.payload->>'merchant_oid' = pl.merchant_oid
      LEFT JOIN payment_external_refs per ON per.provider = 'paytr'
        AND per.reference_type = 'merchant_oid'
        AND per.external_id = pl.merchant_oid
      LEFT JOIN customer_payments cp ON cp.id = per.payment_id
      LEFT JOIN paytr_reconciliations pr ON pr.merchant_oid = pl.merchant_oid
      LEFT JOIN paytr_settlement_reconciliations psr ON psr.reconciliation_id = pr.id
      LEFT JOIN paytr_settlements ps ON ps.id = psr.settlement_id
      ${fullWhereSql}
      ORDER BY pl.created_at DESC, pl.id DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `

    const { rows } = await query(dataSql, params)

    const items = rows.map(r => {
      const pStatus = r.pipeline_status
      let nextAction = 'none'

      if (pStatus === 'settled') {
        nextAction = 'completed'
      } else if (pStatus === 'awaiting_settlement') {
        nextAction = 'awaiting_settlement'
      } else if (pStatus === 'awaiting_reconcile') {
        nextAction = 'reconcile'
      } else if (pStatus === 'awaiting_process') {
        if (r.event_id) {
          nextAction = 'process_payment'
        } else if (r.merchant_oid) {
          nextAction = 'query_status'
        } else {
          nextAction = 'waiting_callback'
        }
      } else if (pStatus === 'needs_review') {
        if (r.merchant_oid) {
          nextAction = 'query_status'
        } else {
          nextAction = 'needs_review'
        }
      } else if (pStatus === 'pending') {
        if (r.merchant_oid) {
          nextAction = 'query_status'
        } else if (r.link_url) {
          nextAction = 'waiting_payment'
        } else {
          nextAction = 'waiting_payment'
        }
      }

      const hasMerchantOid = Boolean(r.merchant_oid && r.merchant_oid.trim() !== '')
      const canCopyLink = Boolean(r.link_url && r.link_url.trim() !== '' && !['failed', 'cancelled', 'expired'].includes(r.raw_link_status))

      return {
        link_id: r.link_id,
        order_id: r.order_id,
        order_no: r.order_no,
        customer_id: r.customer_id,
        customer_name: r.customer_name,
        customer_phone: r.customer_phone,
        customer_email: r.customer_email,
        callback_id: r.callback_id,
        merchant_oid: r.merchant_oid,
        requested_amount: r.requested_amount,
        currency: r.currency,
        raw_link_status: r.raw_link_status,
        pipeline_status: pStatus,
        link_url: r.link_url,
        can_copy_link: canCopyLink,
        can_query_status: hasMerchantOid,
        next_action: nextAction,
        created_at: r.created_at,
        paid_at: r.paid_at,
        expires_at: r.expires_at,
        event_id: r.event_id,
        event_status: r.event_status,
        payment_id: r.payment_id,
        payment_amount: r.payment_amount,
        payment_date: r.payment_date,
        reconciliation_id: r.reconciliation_id,
        commission_amount: r.commission_amount,
        net_amount: r.net_amount,
        reconciled_at: r.reconciled_at,
        settlement_id: r.settlement_id,
        settlement_ref: r.settlement_ref,
        settlement_date: r.settlement_date
      }
    })

    res.json({
      items,
      total,
      limit,
      offset
    })
  } catch (err) {
    next(err)
  }
})

/**
 * GET /api/integrations/paytr/status/:merchantOid
 * Canlı PayTR Durum Sorgu uç noktası (Salt Okunur).
 * Frontend için güvenli, sanitize edilmiş veri projeksiyonu sunar (auth_code ve tam returns dizisi sızdırılmaz).
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

    const d = result.data
    res.json({
      status: d.status,
      merchant_oid: d.merchant_oid,
      payment_amount: d.payment_amount,
      payment_total: d.payment_total,
      net_tutar: d.net_tutar,
      kesinti_tutari: d.kesinti_tutari,
      payment_date: d.payment_date,
      currency: d.currency,
      taksit: d.taksit,
      kart_marka: d.kart_marka,
      masked_pan: d.masked_pan || null,
      odeme_tipi: d.odeme_tipi,
      test_mode: d.test_mode,
      returns_count: Array.isArray(d.returns) ? d.returns.length : 0
    })
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
    if (!(await isSystemOpen())) {
      return res.status(423).json({
        error: 'Sistem PRE-OPENING modunda. Dış dünyaya ödeme talebi oluşturulamaz.',
        code: 'PRE_OPENING_MODE'
      })
    }

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

/**
 * POST /api/integrations/paytr/payments/:paymentId/reconcile
 * PayTR Payment Reconciliation — Commission Foundation
 *
 * Reconciles an already processed PayTR customer payment with PayTR Status Inquiry.
 * Verifies merchant_oid, net amount, and commission amount, then records
 * commission expense and paytr_reconciliations idempotently.
 * Flow:
 * A - Read Phase: payment + external ref + PayTR account lookup (read-only, no locks)
 * B - Remote Verification: queryPaytrStatus(merchant_oid) (executed with ZERO DB locks held)
 * C - Finance Transaction: single PostgreSQL transaction locking payment, account, reconciliation FOR UPDATE,
 *     inserting paytr_reconciliations, calling recordAccountExpense if commission > 0, and linking transaction.
 */
router.post('/paytr/payments/:paymentId/reconcile', async (req, res, next) => {
  try {
    if (!(await isSystemOpen())) {
      return res.status(423).json({
        error: 'Sistem PRE-OPENING modunda. Finansal işlem yapılamaz.',
        code: 'PRE_OPENING_MODE'
      })
    }

    const paymentId = parseInt(req.params.paymentId, 10)
    if (!Number.isInteger(paymentId) || paymentId <= 0) {
      return res.status(400).json({ error: 'Geçersiz payment kimliği', code: 'INVALID_PAYMENT_ID' })
    }

    // A — Read phase (read-only, no locks)
    // 1. Resolve active PayTR card account
    const { rows: accRows } = await query(
      `SELECT id, name, account_type, balance, is_active
       FROM accounts
       WHERE name = 'PayTR' AND account_type = 'card' AND is_active = true`
    )
    if (accRows.length !== 1) {
      return res.status(422).json({
        error: `Aktif PayTR kart hesabı bulunamadı veya birden fazla bulundu (${accRows.length})`,
        code: 'PAYTR_ACCOUNT_INVALID'
      })
    }
    const paytrAccount = accRows[0]

    // 2. Resolve customer_payments and payment_external_refs
    const { rows: cpRows } = await query(
      `SELECT cp.id, cp.customer_id, cp.account_id, cp.amount, cp.paid_at,
              r.external_id AS merchant_oid
       FROM customer_payments cp
       JOIN payment_external_refs r ON r.payment_id = cp.id
       WHERE cp.id = $1 AND r.provider = 'paytr' AND r.reference_type = 'merchant_oid'`,
      [paymentId]
    )
    if (cpRows.length === 0) {
      return res.status(404).json({
        error: 'PayTR referansına sahip müşteri tahsilatı bulunamadı',
        code: 'PAYTR_PAYMENT_NOT_FOUND'
      })
    }
    const payment = cpRows[0]
    const merchantOid = payment.merchant_oid

    // Requirement 3: customer_payments.account_id must match active PayTR account
    if (payment.account_id !== paytrAccount.id) {
      return res.status(409).json({
        error: 'Tahsilat hesabı aktif PayTR hesabı ile eşleşmiyor',
        code: 'PAYTR_PAYMENT_ACCOUNT_MISMATCH'
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

    // Currency must be TL or TRY
    const rawCurrency = (statusData.currency || '').toUpperCase()
    if (rawCurrency !== 'TL' && rawCurrency !== 'TRY') {
      return res.status(422).json({
        error: `Desteklenmeyen para birimi: '${statusData.currency}'. Yalnızca TL ve TRY kabul edilir`,
        code: 'UNSUPPORTED_PAYTR_CURRENCY'
      })
    }

    // Returns must be empty
    if (Array.isArray(statusData.returns) && statusData.returns.length > 0) {
      return res.status(422).json({
        error: 'PayTR Durum Sorgusu iade/kısmi iade kaydı içeriyor. İadeli ödemeler bu fazda mutabakata alınamaz',
        code: 'PAYTR_REFUND_PRESENT'
      })
    }

    // Test mode blocked in ALL environments
    if (statusData.test_mode === 1) {
      return res.status(422).json({
        error: 'PayTR test modu ödemeleri için finansal mutasyon yapılamaz',
        code: 'PAYTR_TEST_MODE_PAYMENT'
      })
    }

    // Exact cents validations (No JS float arithmetic)
    const paymentAmountCents = parseDecimalToCents(payment.amount)
    if (statusData.payment_amount_cents == null || statusData.payment_amount_cents !== paymentAmountCents) {
      return res.status(422).json({
        error: `PayTR ödeme tutarı (${statusData.payment_amount}) ile Decco tahsilat tutarı (${payment.amount}) uyuşmuyor`,
        code: 'PAYMENT_AMOUNT_MISMATCH'
      })
    }

    const netCents = statusData.net_tutar_cents
    const commissionCents = statusData.kesinti_tutari_cents

    if (netCents == null || netCents < 0 || commissionCents == null || commissionCents < 0) {
      return res.status(422).json({
        error: 'PayTR net tutar veya kesinti tutarı geçersiz veya eksik',
        code: 'INVALID_PAYTR_AMOUNTS'
      })
    }

    if (paymentAmountCents !== netCents + commissionCents) {
      return res.status(422).json({
        error: `Ödeme tutarı (${centsToDecimalString(paymentAmountCents)}) net (${centsToDecimalString(netCents)}) ve komisyon (${centsToDecimalString(commissionCents)}) toplamına eşit değil`,
        code: 'PAYTR_AMOUNT_SUM_MISMATCH'
      })
    }

    const verifiedPaymentDate = parsePaytrPaymentDate(statusData.payment_date, statusData.auth_date)
    const paymentAmountStr = centsToDecimalString(paymentAmountCents)
    const netAmountStr = centsToDecimalString(netCents)
    const commissionAmountStr = centsToDecimalString(commissionCents)
    const paymentTotalStr = statusData.payment_total_cents != null ? centsToDecimalString(statusData.payment_total_cents) : null

    // C — Finance transaction (Single PostgreSQL transaction)
    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      // 1. Lock customer_payments FOR UPDATE
      const { rows: lockCpRows } = await client.query(
        `SELECT id, customer_id, account_id, amount
         FROM customer_payments
         WHERE id = $1 FOR UPDATE`,
        [paymentId]
      )
      if (lockCpRows.length === 0) {
        await client.query('ROLLBACK')
        return res.status(404).json({ error: 'Tahsilat bulunamadı', code: 'PAYMENT_NOT_FOUND' })
      }
      const curPayment = lockCpRows[0]

      // 2. Lock PayTR account FOR UPDATE
      const { rows: lockAccRows } = await client.query(
        `SELECT id, name, account_type, balance, is_active
         FROM accounts
         WHERE id = $1 FOR UPDATE`,
        [paytrAccount.id]
      )
      if (lockAccRows.length === 0 || !lockAccRows[0].is_active) {
        await client.query('ROLLBACK')
        return res.status(422).json({ error: 'PayTR hesabı aktif değil', code: 'PAYTR_ACCOUNT_INVALID' })
      }

      // Re-verify account_id
      if (curPayment.account_id !== paytrAccount.id) {
        await client.query('ROLLBACK')
        return res.status(409).json({
          error: 'Tahsilat hesabı aktif PayTR hesabı ile eşleşmiyor',
          code: 'PAYTR_PAYMENT_ACCOUNT_MISMATCH'
        })
      }

      // 3. Lock & check paytr_reconciliations FOR UPDATE (Idempotency & Conflict)
      const { rows: existingRecRows } = await client.query(
        `SELECT id, payment_id, merchant_oid, payment_amount, net_amount, commission_amount,
                commission_transaction_id, payment_date, reconciled_at
         FROM paytr_reconciliations
         WHERE payment_id = $1 OR merchant_oid = $2
         FOR UPDATE`,
        [paymentId, merchantOid]
      )

      if (existingRecRows.length > 0) {
        const existingRec = existingRecRows[0]
        const isOidMatch = existingRec.merchant_oid === merchantOid
        const isPaymentIdMatch = existingRec.payment_id === paymentId
        const isPayAmtMatch = parseDecimalToCents(existingRec.payment_amount) === paymentAmountCents
        const isNetAmtMatch = parseDecimalToCents(existingRec.net_amount) === netCents
        const isCommAmtMatch = parseDecimalToCents(existingRec.commission_amount) === commissionCents

        if (isOidMatch && isPaymentIdMatch && isPayAmtMatch && isNetAmtMatch && isCommAmtMatch) {
          // Idempotent success
          await client.query('COMMIT')
          return res.status(200).json({
            ok: true,
            already_reconciled: true,
            reconciliation_id: existingRec.id,
            payment_id: paymentId,
            merchant_oid: merchantOid,
            payment_amount: paymentAmountStr,
            net_amount: netAmountStr,
            commission_amount: commissionAmountStr,
            commission_transaction_id: existingRec.commission_transaction_id,
            payment_date: existingRec.payment_date,
            message: 'Mutabakat zaten kayıtlı ve doğrulandı (idempotent)'
          })
        } else {
          // Conflict
          await client.query('ROLLBACK')
          return res.status(409).json({
            error: 'Mevcut mutabakat kaydı ile PayTR sorgu sonucu uyuşmuyor',
            code: 'PAYTR_RECONCILIATION_CONFLICT'
          })
        }
      }

      // 4. Requirement 4: Insert paytr_reconciliations FIRST with commission_transaction_id = NULL
      let recId
      try {
        const { rows: newRecRows } = await client.query(
          `INSERT INTO paytr_reconciliations (
             payment_id, merchant_oid, payment_amount, payment_total,
             net_amount, commission_amount, payment_date,
             commission_transaction_id, reconciled_at
           ) VALUES (
             $1, $2, $3, $4,
             $5, $6, $7,
             NULL, NOW()
           ) RETURNING id`,
          [
            paymentId,
            merchantOid,
            paymentAmountStr,
            paymentTotalStr,
            netAmountStr,
            commissionAmountStr,
            verifiedPaymentDate
          ]
        )
        recId = newRecRows[0].id
      } catch (insertErr) {
        if (insertErr.code === '23505') {
          // Unique violation race condition
          await client.query('ROLLBACK')
          return res.status(409).json({
            error: 'Eşzamanlı istek sonucunda mutabakat kaydı zaten oluşturuldu',
            code: 'PAYTR_RECONCILIATION_CONFLICT'
          })
        }
        throw insertErr
      }

      // 5. If commission_amount > 0, record account expense using reusable domain helper
      let commissionTxId = null
      if (commissionCents > 0) {
        const expDesc = `PayTR Komisyon Kesintisi (OID: ${merchantOid})`
        const expResult = await recordAccountExpense(client, {
          account_id: paytrAccount.id,
          amount: commissionAmountStr,
          description: expDesc,
          category: 'Banka/Komisyon',
          transaction_date: verifiedPaymentDate,
          reference_type: 'paytr_reconciliation',
          reference_id: recId
        })
        commissionTxId = expResult.transaction_id

        // Update paytr_reconciliations.commission_transaction_id
        await client.query(
          `UPDATE paytr_reconciliations SET commission_transaction_id = $1 WHERE id = $2`,
          [commissionTxId, recId]
        )
      }

      await client.query('COMMIT')

      return res.status(200).json({
        ok: true,
        reconciliation_id: recId,
        payment_id: paymentId,
        merchant_oid: merchantOid,
        payment_amount: paymentAmountStr,
        payment_total: paymentTotalStr,
        net_amount: netAmountStr,
        commission_amount: commissionAmountStr,
        payment_date: verifiedPaymentDate,
        commission_transaction_id: commissionTxId,
        message: 'PayTR komisyon ve net tutar mutabakatı başarıyla kaydedildi'
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

/**
 * Canonical bank_value_date parser and validator.
 * Strictly accepts:
 * 1. ISO datetime with explicit timezone, e.g. "2026-09-12T14:00:00+03:00", "2026-09-12T11:00:00Z"
 * 2. Calendar day only "YYYY-MM-DD" -> canonicalized to Europe/Istanbul day start (+03:00): "YYYY-MM-DDT00:00:00+03:00"
 * Strictly REJECTS timezone-less datetimes, e.g. "2026-09-12 14:00:00" or "2026-09-12T14:00:00"
 * Returns canonical ISO / timezone string or null.
 */
export function parseCanonicalBankValueDate(val) {
  if (!val || typeof val !== 'string') return null
  const s = val.trim()
  if (!s) return null

  // 1. Calendar day only YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const canonical = `${s}T00:00:00+03:00`
    const d = new Date(canonical)
    if (isNaN(d.getTime())) return null
    return canonical
  }

  // 2. Datetime with explicit timezone (Z or [+-]HH:MM or [+-]HHMM)
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const d = new Date(s)
    if (isNaN(d.getTime())) return null
    return s
  }

  return null
}

/**
 * Canonical bank_reference comparison helper.
 * Compares non-null values case-insensitively with trimming (UPPER(TRIM(...))).
 * Treats null and undefined as equal null values.
 */
export function isSameBankRef(ref1, ref2) {
  const c1 = ref1 != null && typeof ref1 === 'string' && ref1.trim() !== '' ? ref1.trim().toUpperCase() : null
  const c2 = ref2 != null && typeof ref2 === 'string' && ref2.trim() !== '' ? ref2.trim().toUpperCase() : null
  return c1 === c2
}

/**
 * POST /api/integrations/paytr/settlements
 * PayTR Settlement — Bank Transfer Foundation
 * Transfers net settled proceeds from active PayTR card account to target bank account.
 */
router.post('/paytr/settlements', async (req, res, next) => {
  try {
    if (!await isSystemOpen()) {
      return res.status(423).json({
        error: 'Sistem PRE-OPENING modunda. Finansal mutasyon yapılamaz.',
        code: 'SYSTEM_NOT_OPEN'
      })
    }

    const { target_account_id, reconciliation_ids, bank_value_date, bank_reference } = req.body

    // 1. Target account ID validation
    const targetAccId = parseInt(target_account_id, 10)
    if (!targetAccId || !Number.isSafeInteger(targetAccId) || targetAccId <= 0) {
      return res.status(400).json({
        error: 'target_account_id geçerli bir hesap kimliği olmalıdır',
        code: 'INVALID_TARGET_ACCOUNT_ID'
      })
    }

    // 2. Reconciliation IDs validation
    if (!Array.isArray(reconciliation_ids) || reconciliation_ids.length === 0) {
      return res.status(400).json({
        error: 'reconciliation_ids boş olmayan bir dizi olmalıdır',
        code: 'INVALID_RECONCILIATION_IDS'
      })
    }

    const recIdSet = new Set()
    const cleanRecIds = []
    for (const id of reconciliation_ids) {
      const num = parseInt(id, 10)
      if (!Number.isSafeInteger(num) || num <= 0 || recIdSet.has(num)) {
        return res.status(400).json({
          error: 'reconciliation_ids geçerli ve benzersiz pozitif tamsayılardan oluşmalıdır',
          code: 'INVALID_RECONCILIATION_IDS'
        })
      }
      recIdSet.add(num)
      cleanRecIds.push(num)
    }
    cleanRecIds.sort((a, b) => a - b)

    // 3. bank_value_date strict validation (no timezone ambiguity)
    const canonicalDate = parseCanonicalBankValueDate(bank_value_date)
    if (!canonicalDate) {
      return res.status(400).json({
        error: 'bank_value_date timezone içeren ISO formatında (örn. 2026-09-12T14:00:00+03:00) veya YYYY-MM-DD takvim günü olmalıdır',
        code: 'INVALID_BANK_VALUE_DATE'
      })
    }

    // 4. bank_reference validation (non-empty after trim)
    let trimmedBankRef = null
    if (bank_reference !== undefined && bank_reference !== null) {
      if (typeof bank_reference !== 'string') {
        return res.status(400).json({
          error: 'bank_reference metin olmalıdır',
          code: 'INVALID_BANK_REFERENCE'
        })
      }
      trimmedBankRef = bank_reference.trim()
      if (trimmedBankRef === '') {
        return res.status(400).json({
          error: 'bank_reference boş string olamaz',
          code: 'INVALID_BANK_REFERENCE'
        })
      }
    }

    // 5. Resolve active PayTR card account
    const { rows: paytrAccRows } = await query(
      `SELECT id, name, account_type, balance, is_active
       FROM accounts
       WHERE name = 'PayTR' AND account_type = 'card' AND is_active = true`
    )
    if (paytrAccRows.length === 0) {
      return res.status(422).json({
        error: 'Aktif PayTR hesabı bulunamadı',
        code: 'PAYTR_ACCOUNT_INVALID'
      })
    }
    const paytrAccount = paytrAccRows[0]

    if (targetAccId === paytrAccount.id) {
      return res.status(422).json({
        error: 'Hedef hesap PayTR hesabı olamaz',
        code: 'INVALID_TARGET_ACCOUNT'
      })
    }

    // 6. Resolve target bank account
    const { rows: targetAccRows } = await query(
      `SELECT id, name, account_type, balance, is_active
       FROM accounts
       WHERE id = $1`,
      [targetAccId]
    )
    if (targetAccRows.length === 0) {
      return res.status(404).json({
        error: 'Hedef hesap bulunamadı',
        code: 'TARGET_ACCOUNT_NOT_FOUND'
      })
    }
    const targetAccount = targetAccRows[0]
    if (!targetAccount.is_active) {
      return res.status(422).json({
        error: 'Hedef hesap aktif değil',
        code: 'TARGET_ACCOUNT_INACTIVE'
      })
    }
    if (targetAccount.account_type !== 'bank') {
      return res.status(422).json({
        error: 'Hedef hesap bir banka hesabı olmalıdır',
        code: 'TARGET_ACCOUNT_NOT_BANK'
      })
    }

    // 7. Transaction
    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      // Check existing settlement junction for these reconciliation IDs
      const { rows: existingJunctionRows } = await client.query(
        `SELECT psr.reconciliation_id, psr.settlement_id,
                s.id AS s_id, s.settlement_ref, s.target_account_id,
                s.gross_amount, s.commission_amount, s.net_amount,
                s.bank_value_date, s.bank_reference, s.transfer_ref,
                s.created_at AS settled_at
         FROM paytr_settlement_reconciliations psr
         JOIN paytr_settlements s ON s.id = psr.settlement_id
         WHERE psr.reconciliation_id = ANY($1::int[])`,
        [cleanRecIds]
      )

      if (existingJunctionRows.length > 0) {
        const first = existingJunctionRows[0]
        const allSameSettlement = existingJunctionRows.every(r => r.settlement_id === first.settlement_id)

        // Read all reconciliations belonging to this existing settlement
        const { rows: allForSettlement } = await client.query(
          `SELECT reconciliation_id
           FROM paytr_settlement_reconciliations
           WHERE settlement_id = $1
           ORDER BY reconciliation_id ASC`,
          [first.settlement_id]
        )
        const existingRecIds = allForSettlement.map(r => r.reconciliation_id)
        const isExactSameRecSet =
          allSameSettlement &&
          existingRecIds.length === cleanRecIds.length &&
          existingRecIds.every((v, i) => v === cleanRecIds[i])

        if (!isExactSameRecSet) {
          await client.query('ROLLBACK')
          return res.status(409).json({
            error: 'Seçilen mutabakatlardan biri veya daha fazlası zaten başka bir transferde kullanılmış',
            code: 'RECONCILIATION_ALREADY_SETTLED'
          })
        }

        // Calculate expected gross, commission, net from paytr_reconciliations
        const { rows: recDataRows } = await client.query(
          `SELECT id, payment_amount, commission_amount, net_amount
           FROM paytr_reconciliations
           WHERE id = ANY($1::int[])`,
          [cleanRecIds]
        )
        let calcGross = 0, calcComm = 0, calcNet = 0
        for (const r of recDataRows) {
          calcGross += parseDecimalToCents(r.payment_amount)
          calcComm += parseDecimalToCents(r.commission_amount)
          calcNet += parseDecimalToCents(r.net_amount)
        }

        const isTargetMatch = first.target_account_id === targetAccId
        const isDateMatch = new Date(first.bank_value_date).getTime() === new Date(canonicalDate).getTime()
        const isRefMatch = isSameBankRef(first.bank_reference, trimmedBankRef)
        const isGrossMatch = parseDecimalToCents(first.gross_amount) === calcGross
        const isCommMatch = parseDecimalToCents(first.commission_amount) === calcComm
        const isNetMatch = parseDecimalToCents(first.net_amount) === calcNet

        if (isTargetMatch && isDateMatch && isRefMatch && isGrossMatch && isCommMatch && isNetMatch) {
          await client.query('COMMIT')
          return res.status(200).json({
            ok: true,
            already_settled: true,
            settlement: {
              id: first.s_id,
              settlement_ref: first.settlement_ref,
              target_account_id: first.target_account_id,
              gross_amount: first.gross_amount,
              commission_amount: first.commission_amount,
              net_amount: first.net_amount,
              transfer_ref: first.transfer_ref,
              bank_value_date: first.bank_value_date,
              bank_reference: first.bank_reference,
              reconciliation_ids: existingRecIds,
              settled_at: first.settled_at
            },
            message: 'Mutabakat seti daha önce aynı parametrelerle başarıyla aktarılmış'
          })
        } else {
          await client.query('ROLLBACK')
          return res.status(409).json({
            error: 'Aynı mutabakat seti daha önce farklı transfer parametreleri ile aktarılmış',
            code: 'PAYTR_SETTLEMENT_CONFLICT'
          })
        }
      }

      // Reconciliations have not been settled yet. Lock them FOR UPDATE:
      const { rows: lockRecRows } = await client.query(
        `SELECT id, payment_amount, commission_amount, net_amount
         FROM paytr_reconciliations
         WHERE id = ANY($1::int[])
         ORDER BY id ASC
         FOR UPDATE`,
        [cleanRecIds]
      )

      if (lockRecRows.length !== cleanRecIds.length) {
        await client.query('ROLLBACK')
        return res.status(404).json({
          error: 'Bazı mutabakat kayıtları bulunamadı',
          code: 'RECONCILIATION_NOT_FOUND'
        })
      }

      let totalGrossCents = 0
      let totalCommCents = 0
      let totalNetCents = 0
      for (const r of lockRecRows) {
        const g = parseDecimalToCents(r.payment_amount)
        const c = parseDecimalToCents(r.commission_amount)
        const n = parseDecimalToCents(r.net_amount)
        if (g == null || c == null || n == null || g !== c + n) {
          await client.query('ROLLBACK')
          return res.status(422).json({
            error: 'Mutabakat tutarları tutarsız',
            code: 'INVALID_RECONCILIATION_AMOUNTS'
          })
        }
        totalGrossCents += g
        totalCommCents += c
        totalNetCents += n
      }

      if (totalGrossCents !== totalCommCents + totalNetCents) {
        await client.query('ROLLBACK')
        return res.status(422).json({
          error: 'Toplam brüt tutar, komisyon ve net tutar toplamına eşit değil',
          code: 'AMOUNT_SUM_MISMATCH'
        })
      }

      if (totalNetCents <= 0) {
        await client.query('ROLLBACK')
        return res.status(422).json({
          error: 'Aktarılacak net tutar 0 veya negatif olamaz',
          code: 'NET_AMOUNT_NON_POSITIVE'
        })
      }

      // Concurrency-safe backend-generated references
      const settlementRef = 'PST-' + crypto.randomUUID()
      const transferRef = crypto.randomUUID()
      const grossStr = centsToDecimalString(totalGrossCents)
      const commStr = centsToDecimalString(totalCommCents)
      const netStr = centsToDecimalString(totalNetCents)

      // Insert paytr_settlements
      const { rows: settlementInsertRows } = await client.query(
        `INSERT INTO paytr_settlements (
           settlement_ref, target_account_id, gross_amount, commission_amount,
           net_amount, transfer_ref, bank_value_date, bank_reference
         ) VALUES (
           $1, $2, $3::numeric, $4::numeric,
           $5::numeric, $6, $7::timestamptz, $8
         ) RETURNING id, created_at AS settled_at`,
        [
          settlementRef,
          targetAccId,
          grossStr,
          commStr,
          netStr,
          transferRef,
          canonicalDate,
          trimmedBankRef || null
        ]
      )
      const newSettlement = settlementInsertRows[0]

      // Insert paytr_settlement_reconciliations
      for (const recId of cleanRecIds) {
        await client.query(
          `INSERT INTO paytr_settlement_reconciliations (settlement_id, reconciliation_id)
           VALUES ($1, $2)`,
          [newSettlement.id, recId]
        )
      }

      // Execute transfer between PayTR account and target bank account
      await executeAccountTransfer(client, {
        from_account_id: paytrAccount.id,
        to_account_id: targetAccId,
        amount: netStr,
        description: `PayTR Net Hakediş Virmanı (${settlementRef})`,
        transaction_date: canonicalDate,
        reference_type: 'paytr_settlement',
        reference_id: newSettlement.id,
        transfer_ref: transferRef
      })

      await client.query('COMMIT')

      return res.status(201).json({
        ok: true,
        already_settled: false,
        settlement: {
          id: newSettlement.id,
          settlement_ref: settlementRef,
          target_account_id: targetAccId,
          gross_amount: grossStr,
          commission_amount: commStr,
          net_amount: netStr,
          transfer_ref: transferRef,
          bank_value_date: canonicalDate,
          bank_reference: trimmedBankRef || null,
          reconciliation_ids: cleanRecIds,
          settled_at: newSettlement.settled_at
        },
        message: 'PayTR hakediş aktarımı başarıyla kaydedildi'
      })

    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})

      // PayTR balance insufficient (thrown by executeAccountTransfer)
      if (err.code === 'INSUFFICIENT_BALANCE') {
        return res.status(422).json({
          error: 'PayTR hesabında aktarılacak yeterli bakiye bulunmuyor',
          code: 'PAYTR_INSUFFICIENT_BALANCE'
        })
      }

      // PostgreSQL unique constraint races (Correction #5)
      if (err.code === '23505') {
        if (err.constraint?.includes('bank_ref') || err.message?.includes('bank_ref')) {
          return res.status(409).json({
            error: 'Bu banka dekont / referans numarası ile daha önce transfer kaydedilmiş',
            code: 'BANK_REFERENCE_EXISTS'
          })
        }
        if (err.constraint?.includes('reconciliation') || err.message?.includes('reconciliation')) {
          try {
            const checkRes = await pool.query(
              `SELECT s.*, psr.reconciliation_id
               FROM paytr_settlement_reconciliations psr
               JOIN paytr_settlements s ON s.id = psr.settlement_id
               WHERE psr.reconciliation_id = ANY($1::int[])`,
              [cleanRecIds]
            )
            if (checkRes.rows.length > 0) {
              const first = checkRes.rows[0]
              const allSame = checkRes.rows.every(r => r.id === first.id)
              const { rows: allForS } = await pool.query(
                `SELECT reconciliation_id
                 FROM paytr_settlement_reconciliations
                 WHERE settlement_id = $1
                 ORDER BY reconciliation_id ASC`,
                [first.id]
              )
              const existingIds = allForS.map(r => r.reconciliation_id)
              const isExactSameSet =
                existingIds.length === cleanRecIds.length &&
                existingIds.every((v, i) => v === cleanRecIds[i])

              if (allSame && isExactSameSet) {
                const targetMatch = first.target_account_id === targetAccId
                const dateMatch = new Date(first.bank_value_date).getTime() === new Date(canonicalDate).getTime()
                const refMatch = isSameBankRef(first.bank_reference, trimmedBankRef)
                if (targetMatch && dateMatch && refMatch) {
                  return res.status(200).json({
                    ok: true,
                    already_settled: true,
                    settlement: {
                      id: first.id,
                      settlement_ref: first.settlement_ref,
                      target_account_id: first.target_account_id,
                      gross_amount: first.gross_amount,
                      commission_amount: first.commission_amount,
                      net_amount: first.net_amount,
                      transfer_ref: first.transfer_ref,
                      bank_value_date: first.bank_value_date,
                      bank_reference: first.bank_reference,
                      reconciliation_ids: existingIds,
                      settled_at: first.settled_at
                    },
                    message: 'Mutabakat seti daha önce aynı parametrelerle başarıyla aktarılmış'
                  })
                } else {
                  return res.status(409).json({
                    error: 'Aynı mutabakat seti daha önce farklı transfer parametreleri ile aktarılmış',
                    code: 'PAYTR_SETTLEMENT_CONFLICT'
                  })
                }
              }
            }
          } catch {
            // Fall through
          }
          return res.status(409).json({
            error: 'Seçilen mutabakatlardan biri veya daha fazlası zaten başka bir transferde kullanılmış',
            code: 'RECONCILIATION_ALREADY_SETTLED'
          })
        }
      }

      if (err.status && err.status < 500) {
        return res.status(err.status).json({ error: err.message, code: err.code })
      }
      next(err)
    } finally {
      client.release()
    }

  } catch (err) {
    next(err)
  }
})

/**
 * GET /api/integrations/paytr/settlements
 * List PayTR settlements with linked reconciliations.
 */
router.get('/paytr/settlements', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100)
    const { rows } = await query(
      `SELECT s.id, s.settlement_ref, s.target_account_id, a.name AS target_account_name,
              s.gross_amount, s.commission_amount, s.net_amount, s.transfer_ref,
              s.bank_value_date, s.bank_reference, s.created_at AS settled_at, s.created_at,
              COALESCE(
                JSON_AGG(psr.reconciliation_id ORDER BY psr.reconciliation_id ASC)
                FILTER (WHERE psr.reconciliation_id IS NOT NULL), '[]'
              ) AS reconciliation_ids
       FROM paytr_settlements s
       LEFT JOIN accounts a ON a.id = s.target_account_id
       LEFT JOIN paytr_settlement_reconciliations psr ON psr.settlement_id = s.id
       GROUP BY s.id, a.name
       ORDER BY s.created_at DESC, s.id DESC
       LIMIT $1`,
      [limit]
    )
    res.json(rows)
  } catch (err) {
    next(err)
  }
})

// ===========================================================================
// PAYTR GEÇMİŞ İŞLEM DÖKÜMÜ & EŞLEME (HISTORICAL TRANSACTIONS & MATCHING)
// ===========================================================================

/**
 * Automatically evaluates match candidates for a historical PayTR transaction.
 * Pure relational metadata logic — NEVER modifies financial balances, paid_amounts or payments.
 */
async function autoMatchHistoryTransaction(client, historyTxn) {
  const { id: historyId, merchant_order_no, transaction_amount, transaction_date } = historyTxn

  // If already manually confirmed, do not overwrite
  const { rows: existingRows } = await client.query(
    `SELECT id, confidence, confirmed_by_user FROM paytr_history_matches WHERE history_transaction_id = $1`,
    [historyId]
  )
  if (existingRows.length > 0 && (existingRows[0].confidence === 'manual' || existingRows[0].confirmed_by_user)) {
    return
  }

  // Priority 1: Exact PayTR match (payment_external_refs or paytr_payment_links)
  // 1a. payment_external_refs (merchant_oid)
  const { rows: extRefRows } = await client.query(
    `SELECT per.payment_id, cpa.order_id
     FROM payment_external_refs per
     LEFT JOIN customer_payment_allocations cpa ON cpa.payment_id = per.payment_id
     WHERE per.provider = 'paytr' AND per.reference_type = 'merchant_oid' AND per.external_id = $1
     LIMIT 1`,
    [merchant_order_no]
  )
  if (extRefRows.length > 0 && extRefRows[0].order_id) {
    const match = extRefRows[0]
    await client.query(
      `INSERT INTO paytr_history_matches (history_transaction_id, order_id, payment_id, match_method, confidence)
       VALUES ($1, $2, $3, 'exact_payment_ref', 'exact')
       ON CONFLICT (history_transaction_id)
       DO UPDATE SET order_id = EXCLUDED.order_id, payment_id = EXCLUDED.payment_id,
                     match_method = EXCLUDED.match_method, confidence = EXCLUDED.confidence`,
      [historyId, match.order_id, match.payment_id]
    )
    return
  }

  // 1b. paytr_payment_links (merchant_oid)
  const { rows: linkRows } = await client.query(
    `SELECT pl.order_id, per.payment_id
     FROM paytr_payment_links pl
     LEFT JOIN payment_external_refs per ON per.provider = 'paytr' AND per.reference_type = 'merchant_oid' AND per.external_id = pl.merchant_oid
     WHERE pl.merchant_oid = $1
     LIMIT 1`,
    [merchant_order_no]
  )
  if (linkRows.length > 0 && linkRows[0].order_id) {
    const match = linkRows[0]
    await client.query(
      `INSERT INTO paytr_history_matches (history_transaction_id, order_id, payment_id, match_method, confidence)
       VALUES ($1, $2, $3, 'exact_link_oid', 'exact')
       ON CONFLICT (history_transaction_id)
       DO UPDATE SET order_id = EXCLUDED.order_id, payment_id = EXCLUDED.payment_id,
                     match_method = EXCLUDED.match_method, confidence = EXCLUDED.confidence`,
      [historyId, match.order_id, match.payment_id || null]
    )
    return
  }

  // Priority 2: WooCommerce order external ref (SUGGESTED ONLY - Correction #8)
  const { rows: wooRows } = await client.query(
    `SELECT order_id FROM order_external_refs WHERE external_id = $1 LIMIT 1`,
    [merchant_order_no]
  )
  if (wooRows.length > 0) {
    await client.query(
      `INSERT INTO paytr_history_matches (history_transaction_id, order_id, payment_id, match_method, confidence)
       VALUES ($1, $2, NULL, 'woo_suggested', 'suggested')
       ON CONFLICT (history_transaction_id)
       DO UPDATE SET order_id = EXCLUDED.order_id, payment_id = EXCLUDED.payment_id,
                     match_method = EXCLUDED.match_method, confidence = EXCLUDED.confidence`,
      [historyId, wooRows[0].order_id]
    )
    return
  }

  // Check pattern e.g. ...PAYTRWOO(\d+)
  const wooPattern = /PAYTRWOO(\d+)/i.exec(merchant_order_no)
  if (wooPattern) {
    const wooId = wooPattern[1]
    const { rows: wooPatRows } = await client.query(
      `SELECT order_id FROM order_external_refs WHERE external_id = $1 LIMIT 1`,
      [wooId]
    )
    if (wooPatRows.length > 0) {
      await client.query(
        `INSERT INTO paytr_history_matches (history_transaction_id, order_id, payment_id, match_method, confidence)
         VALUES ($1, $2, NULL, 'woo_suggested', 'suggested')
         ON CONFLICT (history_transaction_id)
         DO UPDATE SET order_id = EXCLUDED.order_id, payment_id = EXCLUDED.payment_id,
                       match_method = EXCLUDED.match_method, confidence = EXCLUDED.confidence`,
        [historyId, wooPatRows[0].order_id]
      )
      return
    }
  }

  // Priority 3: Conservative Heuristic Match (Correction #8)
  // Requires combination of exact amount + reasonable calendar window (+/- 7 days) + PayTR historical payment evidence
  const { rows: candRows } = await client.query(
    `SELECT o.id, o.order_no, o.total_amount, o.created_at::date AS order_date, cp.id AS payment_id
     FROM orders o
     JOIN customer_payment_allocations cpa ON cpa.order_id = o.id
     JOIN customer_payments cp ON cp.id = cpa.payment_id
     JOIN accounts a ON a.id = cp.account_id AND a.name = 'PayTR'
     WHERE ABS(o.total_amount - $1::numeric) < 0.005
       AND o.created_at::date BETWEEN ($2::date - INTERVAL '7 days') AND ($2::date + INTERVAL '7 days')
     ORDER BY o.created_at DESC`,
    [transaction_amount, transaction_date]
  )

  if (candRows.length === 1) {
    await client.query(
      `INSERT INTO paytr_history_matches (history_transaction_id, order_id, payment_id, match_method, confidence)
       VALUES ($1, $2, $3, 'heuristic_suggested', 'suggested')
       ON CONFLICT (history_transaction_id)
       DO UPDATE SET order_id = EXCLUDED.order_id, payment_id = EXCLUDED.payment_id,
                     match_method = EXCLUDED.match_method, confidence = EXCLUDED.confidence`,
      [historyId, candRows[0].id, candRows[0].payment_id]
    )
    return
  }

  if (candRows.length > 1) {
    const candidateDetails = candRows.map(c => ({
      order_id: c.id,
      order_no: c.order_no,
      amount: c.total_amount,
      order_date: c.order_date
    }))
    await client.query(
      `INSERT INTO paytr_history_matches (history_transaction_id, order_id, payment_id, match_method, confidence, candidate_details)
       VALUES ($1, NULL, NULL, 'multiple_candidates', 'conflict', $2::jsonb)
       ON CONFLICT (history_transaction_id)
       DO UPDATE SET order_id = NULL, payment_id = NULL,
                     match_method = EXCLUDED.match_method, confidence = EXCLUDED.confidence,
                     candidate_details = EXCLUDED.candidate_details`,
      [historyId, JSON.stringify(candidateDetails)]
    )
    return
  }
}

export function isPaytrHistoryMockAllowed() {
  if (process.env.NODE_ENV === 'production') return false
  return process.env.NODE_ENV === 'test' || process.env.PAYTR_HISTORY_MOCK_ENABLED === 'true'
}

/**
 * POST /api/integrations/paytr/history/fetch
 * Fetches historical PayTR transactions via official report endpoint.
 * Chunks in up to 3 calendar day sequential windows (max 93 days total span).
 * Deduplicates with SHA-256 source signature + occurrence counter.
 * NEVER mutates existing financial balances or customer payments.
 */
router.post('/paytr/history/fetch', async (req, res, next) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({
        error: 'Geçersiz istek formatı. JSON nesnesi bekleniyor.',
        code: 'INVALID_REQUEST_BODY'
      })
    }

    const mockRequested = req.query?.mock === '1' || req.headers['x-mock-paytr'] === 'true' || Boolean(req.body?._mock_report)
    if (mockRequested) {
      if (process.env.NODE_ENV === 'production') {
        return res.status(400).json({
          error: 'Mock modu production ortamında kullanılamaz',
          code: 'MOCK_NOT_ALLOWED_IN_PRODUCTION'
        })
      }
      if (!isPaytrHistoryMockAllowed()) {
        return res.status(400).json({
          error: 'PayTR mock modu aktif değil (PAYTR_HISTORY_MOCK_ENABLED=true gereklidir)',
          code: 'PAYTR_MOCK_DISABLED'
        })
      }
    }

    const { start_date, end_date } = req.body
    if (!start_date || !end_date) {
      return res.status(400).json({
        error: 'start_date ve end_date (YYYY-MM-DD) zorunludur',
        code: 'MISSING_DATE_PARAMS'
      })
    }

    let chunks
    try {
      chunks = splitDateRangeInto3DayChunks(start_date, end_date)
    } catch (err) {
      if (err.message === 'MAX_DATE_RANGE_EXCEEDED') {
        return res.status(400).json({
          error: 'Tek seferde en fazla 93 günlük geçmiş sorgulanabilir',
          code: 'MAX_DATE_RANGE_EXCEEDED'
        })
      }
      return res.status(400).json({
        error: err.message,
        code: 'INVALID_DATE_RANGE'
      })
    }

    // 1. Insert fetch log
    const { rows: fetchRows } = await query(
      `INSERT INTO paytr_history_fetches (
         requested_start_date, requested_end_date, status, chunk_count
       ) VALUES ($1::date, $2::date, 'running', $3)
       RETURNING id`,
      [start_date, end_date, chunks.length]
    )
    const fetchId = fetchRows[0].id

    let successChunks = 0
    let failedChunks = 0
    let totalTransactions = 0
    let errorSummary = null

    // 2. Sequential chunk processing (Correction #2, #3, #5)
    for (const chunk of chunks) {
      const testOptions = isPaytrHistoryMockAllowed() ? (req.body?._test_options || {}) : {}
      if (isPaytrHistoryMockAllowed() && mockRequested) {
        const mockData = req.body?._mock_report
          ? (Array.isArray(req.body._mock_report)
              ? req.body._mock_report[chunk.chunk_no - 1] || req.body._mock_report[0]
              : req.body._mock_report)
          : { status: 'failed', err_msg: 'İşlem bulunamadı' }
        testOptions.fetchFn = async () => ({
          ok: true,
          status: 200,
          json: async () => mockData,
          text: async () => JSON.stringify(mockData)
        })
        testOptions.merchantId = testOptions.merchantId || 'test-mid'
        testOptions.merchantKey = testOptions.merchantKey || 'test-key'
        testOptions.merchantSalt = testOptions.merchantSalt || 'test-salt'
      }

      const reportRes = await queryPaytrTransactionReport(chunk.start_at, chunk.end_at, testOptions)

      if (!reportRes.ok) {
        failedChunks++
        const errMsg = reportRes.message || 'Chunk fetch failed'
        errorSummary = errorSummary ? `${errorSummary}; Chunk #${chunk.chunk_no}: ${errMsg}` : `Chunk #${chunk.chunk_no}: ${errMsg}`
        await query(
          `INSERT INTO paytr_history_fetch_chunks (
             fetch_id, chunk_no, start_at, end_at, status, row_count, error_code, error_message
           ) VALUES ($1, $2, $3, $4, 'failed', 0, $5, $6)`,
          [fetchId, chunk.chunk_no, chunk.start_at, chunk.end_at, reportRes.error_code || 'REPORT_ERROR', errMsg]
        )
        continue
      }

      successChunks++
      const txns = reportRes.transactions || []

      if (txns.length === 0) {
        await query(
          `INSERT INTO paytr_history_fetch_chunks (
             fetch_id, chunk_no, start_at, end_at, status, row_count
           ) VALUES ($1, $2, $3, $4, 'empty', 0)`,
          [fetchId, chunk.chunk_no, chunk.start_at, chunk.end_at]
        )
        continue
      }

      await query(
        `INSERT INTO paytr_history_fetch_chunks (
           fetch_id, chunk_no, start_at, end_at, status, row_count
         ) VALUES ($1, $2, $3, $4, 'success', $5)`,
        [fetchId, chunk.chunk_no, chunk.start_at, chunk.end_at, txns.length]
      )

      totalTransactions += txns.length

      // Count occurrences within this chunk's response (Correction #3, #5)
      const occurrenceMap = new Map()

      for (const t of txns) {
        const sig = computeHistoryTransactionSignature(t)
        const occ = (occurrenceMap.get(sig) || 0) + 1
        occurrenceMap.set(sig, occ)

        // Upsert into paytr_history_transactions
        const client = await pool.connect()
        try {
          await client.query('BEGIN')

          const { rows: insRows } = await client.query(
            `INSERT INTO paytr_history_transactions (
               transaction_type, merchant_order_no, transaction_amount, payment_amount,
               net_amount, commission_amount, commission_rate, transaction_date, currency,
               installment, card_brand, masked_card, payment_type, source_signature,
               occurrence_no, first_seen_at, last_seen_at
             ) VALUES (
               $1, $2, $3::numeric, $4::numeric,
               $5::numeric, $6::numeric, $7::numeric, $8::date, $9,
               $10, $11, $12, $13, $14,
               $15, NOW(), NOW()
             )
             ON CONFLICT (source_signature, occurrence_no)
             DO UPDATE SET last_seen_at = NOW()
             RETURNING id, transaction_type, merchant_order_no, transaction_amount, transaction_date, currency`,
            [
              t.transaction_type,
              t.merchant_order_no,
              t.transaction_amount,
              t.payment_amount,
              t.net_amount,
              t.commission_amount,
              t.commission_rate,
              t.transaction_date,
              t.currency,
              t.installment,
              t.card_brand,
              t.masked_card,
              t.payment_type,
              sig,
              occ
            ]
          )

          const historyTxn = insRows[0]

          // Link in junction table (Correction #3)
          await client.query(
            `INSERT INTO paytr_history_fetch_transactions (fetch_id, history_transaction_id)
             VALUES ($1, $2)
             ON CONFLICT DO NOTHING`,
            [fetchId, historyTxn.id]
          )

          // Run relational auto matching
          await autoMatchHistoryTransaction(client, historyTxn)

          await client.query('COMMIT')
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {})
          console.error('Error inserting history transaction:', err)
        } finally {
          client.release()
        }
      }
    }

    // Determine final fetch status (completed, partial, failed)
    let finalStatus = 'completed'
    if (failedChunks > 0 && successChunks === 0) {
      finalStatus = 'failed'
    } else if (failedChunks > 0 && successChunks > 0) {
      finalStatus = 'partial'
    }

    await query(
      `UPDATE paytr_history_fetches
       SET status = $1, success_chunk_count = $2, failed_chunk_count = $3, error_summary = $4, fetched_at = NOW()
       WHERE id = $5`,
      [finalStatus, successChunks, failedChunks, errorSummary, fetchId]
    )

    res.json({
      ok: true,
      fetch_id: fetchId,
      status: finalStatus,
      chunk_count: chunks.length,
      success_chunk_count: successChunks,
      failed_chunk_count: failedChunks,
      total_transactions: totalTransactions,
      error_summary: errorSummary
    })

  } catch (err) {
    next(err)
  }
})

/**
 * GET /api/integrations/paytr/history
 * List historical transactions with their match status, order details, and summary counts.
 * Supports filters: status ('exact', 'suggested', 'conflict', 'unmatched', 'refund'), search, limit, offset.
 */
router.get('/paytr/history', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100)
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0)
    const statusFilter = req.query.status ? String(req.query.status).trim() : null
    const search = req.query.search ? String(req.query.search).trim() : null

    let whereSql = 'WHERE 1=1'
    const params = []

    if (statusFilter === 'refund') {
      whereSql += ` AND pht.transaction_type = 'I'`
    } else if (statusFilter === 'exact') {
      whereSql += ` AND phm.confidence IN ('exact', 'manual') AND pht.transaction_type = 'S'`
    } else if (statusFilter === 'suggested') {
      whereSql += ` AND phm.confidence = 'suggested' AND pht.transaction_type = 'S'`
    } else if (statusFilter === 'conflict') {
      whereSql += ` AND phm.confidence = 'conflict' AND pht.transaction_type = 'S'`
    } else if (statusFilter === 'unmatched') {
      whereSql += ` AND phm.id IS NULL AND pht.transaction_type = 'S'`
    }

    if (search) {
      params.push(`%${search}%`)
      whereSql += ` AND (pht.merchant_order_no ILIKE $${params.length} OR o.order_no ILIKE $${params.length} OR c.name ILIKE $${params.length})`
    }

    // Summary counts query
    const { rows: summaryRows } = await query(
      `SELECT
         COUNT(*)::int AS total_count,
         COUNT(*) FILTER (WHERE phm.confidence IN ('exact', 'manual') AND pht.transaction_type = 'S')::int AS exact_count,
         COUNT(*) FILTER (WHERE phm.confidence = 'suggested' AND pht.transaction_type = 'S')::int AS suggested_count,
         COUNT(*) FILTER (WHERE phm.confidence = 'conflict' AND pht.transaction_type = 'S')::int AS conflict_count,
         COUNT(*) FILTER (WHERE phm.id IS NULL AND pht.transaction_type = 'S')::int AS unmatched_count,
         COUNT(*) FILTER (WHERE pht.transaction_type = 'I')::int AS refund_count
       FROM paytr_history_transactions pht
       LEFT JOIN paytr_history_matches phm ON phm.history_transaction_id = pht.id`
    )

    const countSql = `
      SELECT COUNT(*)::int AS total
      FROM paytr_history_transactions pht
      LEFT JOIN paytr_history_matches phm ON phm.history_transaction_id = pht.id
      LEFT JOIN orders o ON o.id = phm.order_id
      LEFT JOIN customers c ON c.id = o.customer_id
      ${whereSql}
    `
    const { rows: countRows } = await query(countSql, params)
    const total = countRows[0]?.total || 0

    params.push(limit)
    const limitIdx = params.length
    params.push(offset)
    const offsetIdx = params.length

    const dataSql = `
      SELECT
        pht.id,
        pht.transaction_type,
        pht.merchant_order_no,
        pht.transaction_amount,
        pht.payment_amount,
        pht.net_amount,
        pht.commission_amount,
        pht.commission_rate,
        TO_CHAR(pht.transaction_date, 'YYYY-MM-DD') AS transaction_date,
        pht.currency,
        pht.installment,
        pht.card_brand,
        pht.masked_card,
        pht.payment_type,
        pht.occurrence_no,
        pht.first_seen_at,
        pht.last_seen_at,
        phm.id AS match_id,
        phm.order_id,
        phm.payment_id,
        phm.match_method,
        phm.confidence,
        phm.candidate_details,
        phm.confirmed_by_user,
        o.order_no,
        o.total_amount AS order_amount,
        c.name AS customer_name
      FROM paytr_history_transactions pht
      LEFT JOIN paytr_history_matches phm ON phm.history_transaction_id = pht.id
      LEFT JOIN orders o ON o.id = phm.order_id
      LEFT JOIN customers c ON c.id = o.customer_id
      ${whereSql}
      ORDER BY pht.transaction_date DESC, pht.id DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `
    const { rows } = await query(dataSql, params)

    res.json({
      data: rows,
      items: rows,
      total,
      limit,
      offset,
      summary: summaryRows[0] || {
        total_count: 0,
        exact_count: 0,
        suggested_count: 0,
        conflict_count: 0,
        unmatched_count: 0,
        refund_count: 0
      }
    })
  } catch (err) {
    next(err)
  }
})

/**
 * POST /api/integrations/paytr/history/:id/match
 * Manually links a historical PayTR transaction to a Decco order.
 * Updates match record on the same row.
 * Precludes casual override of exact matches (Correction #7).
 * Strictly creates metadata relation; NEVER mutates order paid_amount or finance balances.
 */
router.post('/paytr/history/:id/match', async (req, res, next) => {
  try {
    const historyId = parseInt(req.params.id, 10)
    const { order_id } = req.body || {}

    if (!order_id || !Number.isInteger(Number(order_id))) {
      return res.status(400).json({
        error: 'Geçerli bir order_id belirtilmelidir',
        code: 'INVALID_ORDER_ID'
      })
    }

    const targetOrderId = parseInt(order_id, 10)

    // 1. Verify history transaction exists
    const { rows: histRows } = await query(
      `SELECT id, transaction_type, merchant_order_no, transaction_amount FROM paytr_history_transactions WHERE id = $1`,
      [historyId]
    )
    if (histRows.length === 0) {
      return res.status(404).json({ error: 'Geçmiş PayTR işlemi bulunamadı', code: 'TRANSACTION_NOT_FOUND' })
    }
    const hist = histRows[0]

    // 2. Verify target order exists and is not deleted
    const { rows: orderRows } = await query(
      `SELECT id, order_no, customer_id, total_amount, paid_amount, status, deleted_at FROM orders WHERE id = $1`,
      [targetOrderId]
    )
    if (orderRows.length === 0 || orderRows[0].deleted_at) {
      return res.status(404).json({ error: 'Sipariş bulunamadı veya silinmiş', code: 'ORDER_NOT_FOUND' })
    }
    const order = orderRows[0]

    // 3. Check existing match
    const { rows: matchRows } = await query(
      `SELECT id, order_id, confidence FROM paytr_history_matches WHERE history_transaction_id = $1`,
      [historyId]
    )

    if (matchRows.length > 0) {
      const existing = matchRows[0]
      // If it is an automatic EXACT match and user attempts to change to a DIFFERENT order,
      // prevent casual override (Correction #7)
      if (existing.confidence === 'exact' && existing.order_id !== targetOrderId) {
        return res.status(409).json({
          error: 'Bu işlem kesin bir PayTR kimliği ile başka bir siparişe eşleşmiştir. Manuel override için inceleme gereklidir.',
          code: 'EXACT_MATCH_OVERRIDE_REQUIRES_REVIEW'
        })
      }

      // Update existing row on same row (Correction #7)
      await query(
        `UPDATE paytr_history_matches
         SET order_id = $1,
             payment_id = NULL,
             match_method = 'manual',
             confidence = 'manual',
             candidate_details = NULL,
             confirmed_by_user = true,
             confirmed_at = NOW()
         WHERE id = $2`,
        [targetOrderId, existing.id]
      )
    } else {
      // Insert new match row
      await query(
        `INSERT INTO paytr_history_matches (
           history_transaction_id, order_id, payment_id, match_method, confidence, confirmed_by_user, confirmed_at
         ) VALUES ($1, $2, NULL, 'manual', 'manual', true, NOW())`,
        [historyId, targetOrderId]
      )
    }

    // ZERO finance mutation: orders.paid_amount, customer_payments, accounts.balance remain completely untouched!

    res.json({
      ok: true,
      message: `Geçmiş işlem başarıyla #${order.order_no} siparişiyle eşleştirildi (Finansal bakiye değiştirilmedi)`,
      order_id: targetOrderId,
      order_no: order.order_no
    })
  } catch (err) {
    next(err)
  }
})

/**
 * POST /api/integrations/paytr/history/:id/verify
 * Performs on-demand Status Inquiry verification for a historical transaction.
 * Compares calendar date, exact cents, and currency.
 * Sanitized response: returns_count only, NO auth_code or full returns (Correction #10).
 */
router.post('/paytr/history/:id/verify', async (req, res, next) => {
  try {
    const historyId = parseInt(req.params.id, 10)
    const { rows: histRows } = await query(
      `SELECT id, merchant_order_no, transaction_amount, currency, TO_CHAR(transaction_date, 'YYYY-MM-DD') AS transaction_date
       FROM paytr_history_transactions WHERE id = $1`,
      [historyId]
    )
    if (histRows.length === 0) {
      return res.status(404).json({ error: 'Geçmiş PayTR işlemi bulunamadı', code: 'TRANSACTION_NOT_FOUND' })
    }
    const hist = histRows[0]

    // Read-only queryPaytrStatus
    const testOptions = req.body?._test_options || {}
    if (process.env.NODE_ENV !== 'production' && req.body?._mock_status) {
      testOptions.fetchFn = async () => ({
        ok: true,
        status: 200,
        json: async () => req.body._mock_status,
        text: async () => JSON.stringify(req.body._mock_status)
      })
      testOptions.merchantId = testOptions.merchantId || 'test-mid'
      testOptions.merchantKey = testOptions.merchantKey || 'test-key'
      testOptions.merchantSalt = testOptions.merchantSalt || 'test-salt'
    }

    const result = await queryPaytrStatus(hist.merchant_order_no, testOptions)
    if (!result.ok) {
      return res.status(result.error_code === 'PAYTR_CREDENTIALS_MISSING' ? 500 : 422).json({
        ok: false,
        error: result.message || result.err_msg || 'Durum sorgulanamadı',
        code: result.error_code
      })
    }

    const d = result.data
    // Compare calendar date (ignoring time) (Correction #10)
    const dCalendarDate = parsePaytrDateToCalendarDate(d.payment_date)
    const dateMatch = dCalendarDate === hist.transaction_date

    // Compare cents
    const histCents = parseDecimalToCents(hist.transaction_amount)
    const amountMatch = d.payment_amount_cents === histCents

    // Compare currency (TL === TRY)
    const normalizeCurr = c => (c || '').toUpperCase().replace('TRY', 'TL')
    const currencyMatch = normalizeCurr(d.currency) === normalizeCurr(hist.currency)

    const verified = d.status === 'success' && dateMatch && amountMatch && currencyMatch

    res.json({
      ok: true,
      verified,
      status: d.status,
      merchant_oid: d.merchant_oid,
      payment_amount: d.payment_amount,
      currency: d.currency,
      payment_date: d.payment_date,
      date_matched: dateMatch,
      amount_matched: amountMatch,
      currency_matched: currencyMatch,
      returns_count: Array.isArray(d.returns) ? d.returns.length : 0
    })
  } catch (err) {
    next(err)
  }
})

// ===========================================================================
// WHATSAPP CLOUD API ENTEGRASYON YÖNETİM UÇLARI (FOUNDATION)
// ===========================================================================

/**
 * GET /api/integrations/whatsapp/config
 * Returns integration status without exposing any secret or token.
 */
router.get('/whatsapp/config', async (req, res, next) => {
  try {
    const verifyConfigured = Boolean(process.env.WHATSAPP_VERIFY_TOKEN)
    const secretConfigured = Boolean(process.env.WHATSAPP_APP_SECRET)
    const phoneConfigured = Boolean(process.env.WHATSAPP_PHONE_NUMBER_ID)
    const publicWebhookReady = Boolean(process.env.WHATSAPP_PUBLIC_WEBHOOK_URL)

    res.json({
      verify_token_configured: verifyConfigured,
      app_secret_configured: secretConfigured,
      phone_number_id_configured: phoneConfigured,
      public_webhook_ready: publicWebhookReady,
      webhook_path: '/api/webhooks/whatsapp',
      status_message: publicWebhookReady
        ? 'WhatsApp Cloud API bağlantısı hazır'
        : 'Sunucu bağlantısı bekleniyor (Yerel temel aktif)'
    })
  } catch (err) {
    next(err)
  }
})

/**
 * GET /api/integrations/whatsapp/messages
 * Lists normalized WhatsApp messages with customer match status and linked order.
 */
router.get('/whatsapp/messages', async (req, res, next) => {
  try {
    const filterStatus = req.query.status || 'all'
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100)

    const { rows: msgRows } = await query(
      `SELECT m.id, m.integration_event_id, m.message_id, m.wa_id, m.phone,
              m.sender_name, m.message_timestamp, m.message_type, m.text,
              m.direction, m.order_id, m.raw_message, m.created_at,
              o.order_no, o.status AS order_status, o.total_amount AS order_total_amount,
              o.paid_amount AS order_paid_amount,
              r.customer_id AS direct_customer_id,
              c_direct.name AS direct_customer_name,
              c_direct.phone AS direct_customer_phone
       FROM whatsapp_messages m
       LEFT JOIN orders o ON o.id = m.order_id
       LEFT JOIN customer_external_refs r ON r.provider = 'whatsapp' AND r.external_id = m.wa_id
       LEFT JOIN customers c_direct ON c_direct.id = r.customer_id
       ORDER BY m.message_timestamp DESC, m.id DESC
       LIMIT $1`,
      [limit]
    )

    const resolvedMessages = []
    let totalMatched = 0
    let totalSuggested = 0
    let totalUnmatched = 0

    for (const row of msgRows) {
      let matchStatus = 'unmatched'
      let matchedCustomer = null
      let suggestedCustomers = []

      if (row.direct_customer_id) {
        matchStatus = 'matched'
        matchedCustomer = {
          id: row.direct_customer_id,
          name: row.direct_customer_name,
          phone: row.direct_customer_phone
        }
        totalMatched++
      } else {
        const canonPhone = normalizePhone(row.wa_id)
        if (canonPhone) {
          const { rows: candidateRows } = await query(
            `SELECT id, name, phone, email
             FROM customers
             WHERE deleted_at IS NULL AND is_active = true
               AND ${PHONE_CANON_SQL} = $1
             ORDER BY id ASC
             LIMIT 5`,
            [canonPhone]
          )

          if (candidateRows.length === 1) {
            matchStatus = 'suggested'
            suggestedCustomers = candidateRows
            totalSuggested++
          } else if (candidateRows.length > 1) {
            matchStatus = 'ambiguous'
            suggestedCustomers = candidateRows
            totalSuggested++
          } else {
            matchStatus = 'unmatched'
            totalUnmatched++
          }
        } else {
          matchStatus = 'unmatched'
          totalUnmatched++
        }
      }

      let candidateOrders = []
      const effectiveCustomerId = matchedCustomer?.id || (suggestedCustomers.length === 1 ? suggestedCustomers[0].id : null)
      if (effectiveCustomerId && !row.order_id) {
        const { rows: ordRows } = await query(
          `SELECT id, order_no, status, total_amount, paid_amount, order_date
           FROM orders
           WHERE customer_id = $1 AND deleted_at IS NULL
           ORDER BY order_date DESC, id DESC
           LIMIT 5`,
          [effectiveCustomerId]
        )
        candidateOrders = ordRows.map(o => {
          const tot = parseFloat(o.total_amount || 0)
          const paid = parseFloat(o.paid_amount || 0)
          const rem = tot - paid
          let pStatus = 'unpaid'
          if (rem <= 0.005 && tot > 0) pStatus = 'paid'
          else if (paid > 0) pStatus = 'partial'
          return {
            ...o,
            payment_status: pStatus
          }
        })
      }

      // Canonical payment status calculation based on live orders data
      let orderPaymentStatus = null
      if (row.order_id) {
        const tot = parseFloat(row.order_total_amount || 0)
        const paid = parseFloat(row.order_paid_amount || 0)
        const rem = tot - paid
        if (rem <= 0.005 && tot > 0) {
          orderPaymentStatus = 'paid'
        } else if (paid > 0) {
          orderPaymentStatus = 'partial'
        } else {
          orderPaymentStatus = 'unpaid'
        }
      }

      const item = {
        id: Number(row.id),
        integration_event_id: row.integration_event_id ? Number(row.integration_event_id) : null,
        message_id: row.message_id,
        wa_id: row.wa_id,
        phone: row.phone,
        sender_name: row.sender_name,
        message_timestamp: row.message_timestamp,
        message_type: row.message_type,
        text: row.text,
        direction: row.direction,
        order_id: row.order_id ? Number(row.order_id) : null,
        order_no: row.order_no || null,
        order_status: row.order_status || null,
        order_total_amount: row.order_total_amount != null ? String(row.order_total_amount) : null,
        order_paid_amount: row.order_paid_amount != null ? String(row.order_paid_amount) : null,
        order_payment_status: orderPaymentStatus,
        raw_message: row.raw_message,
        match_status: matchStatus,
        matched_customer: matchedCustomer,
        suggested_customers: suggestedCustomers,
        candidate_orders: candidateOrders
      }

      if (filterStatus === 'all') {
        resolvedMessages.push(item)
      } else if (filterStatus === 'matched' && matchStatus === 'matched') {
        resolvedMessages.push(item)
      } else if (filterStatus === 'suggested' && (matchStatus === 'suggested' || matchStatus === 'ambiguous')) {
        resolvedMessages.push(item)
      } else if (filterStatus === 'unmatched' && matchStatus === 'unmatched') {
        resolvedMessages.push(item)
      }
    }

    res.json({
      summary: {
        total: msgRows.length,
        matched: totalMatched,
        suggested: totalSuggested,
        unmatched: totalUnmatched
      },
      messages: resolvedMessages
    })
  } catch (err) {
    next(err)
  }
})

/**
 * POST /api/integrations/whatsapp/messages/:id/match-customer
 * Manually links a customer to a WhatsApp wa_id in customer_external_refs.
 * Returns 409 if wa_id is already bound to another customer.
 * Idempotent success if already bound to the same customer.
 * Does NOT mutate integration_events.
 */
router.post('/whatsapp/messages/:id/match-customer', async (req, res, next) => {
  try {
    const messageId = parseInt(req.params.id, 10)
    const customerId = parseInt(req.body?.customer_id, 10)

    if (isNaN(messageId) || isNaN(customerId)) {
      return res.status(400).json({ ok: false, error: 'Geçersiz mesaj veya müşteri kimliği' })
    }

    const { rows: msgRows } = await query(
      `SELECT id, wa_id FROM whatsapp_messages WHERE id = $1`,
      [messageId]
    )
    if (msgRows.length === 0) {
      return res.status(404).json({ ok: false, code: 'message_not_found', error: 'WhatsApp mesajı bulunamadı' })
    }
    const waId = msgRows[0].wa_id

    const { rows: custRows } = await query(
      `SELECT id, name, is_active, deleted_at FROM customers WHERE id = $1`,
      [customerId]
    )
    if (custRows.length === 0 || custRows[0].deleted_at !== null) {
      return res.status(404).json({ ok: false, code: 'customer_not_found', error: 'Müşteri bulunamadı veya silinmiş' })
    }
    if (!custRows[0].is_active) {
      return res.status(422).json({ ok: false, code: 'customer_inactive', error: 'Seçilen müşteri hesabı pasif durumda' })
    }

    const { rows: existingRefs } = await query(
      `SELECT customer_id FROM customer_external_refs WHERE provider = 'whatsapp' AND external_id = $1`,
      [waId]
    )

    if (existingRefs.length > 0) {
      const boundCustomerId = existingRefs[0].customer_id
      if (boundCustomerId === customerId) {
        return res.status(200).json({
          ok: true,
          already_matched: true,
          customer_id: customerId,
          customer_name: custRows[0].name
        })
      } else {
        return res.status(409).json({
          ok: false,
          code: 'conflict_existing_customer_id',
          error: `Bu WhatsApp numarası (${waId}) zaten başka bir müşteriye (#${boundCustomerId}) bağlıdır.`
        })
      }
    }

    await query(
      `INSERT INTO customer_external_refs (customer_id, provider, external_id)
       VALUES ($1, 'whatsapp', $2)`,
      [customerId, waId]
    )

    return res.status(200).json({
      ok: true,
      matched: true,
      customer_id: customerId,
      customer_name: custRows[0].name
    })
  } catch (err) {
    next(err)
  }
})

/**
 * POST /api/integrations/whatsapp/messages/:id/link-order
 * Directly links or unlinks an order on whatsapp_messages.order_id.
 * Enforces:
 * 1. Message must be matched to a customer first (422 customer_not_matched).
 * 2. Order must belong to the matched customer (409 order_customer_mismatch).
 * Does NOT mutate integration_events.
 */
router.post('/whatsapp/messages/:id/link-order', async (req, res, next) => {
  try {
    const messageId = parseInt(req.params.id, 10)
    const orderId = req.body?.order_id != null ? parseInt(req.body.order_id, 10) : null

    if (isNaN(messageId)) {
      return res.status(400).json({ ok: false, error: 'Geçersiz mesaj kimliği' })
    }

    const { rows: msgRows } = await query(
      `SELECT id, wa_id, order_id FROM whatsapp_messages WHERE id = $1`,
      [messageId]
    )
    if (msgRows.length === 0) {
      return res.status(404).json({ ok: false, code: 'message_not_found', error: 'WhatsApp mesajı bulunamadı' })
    }
    const waId = msgRows[0].wa_id

    if (orderId === null || isNaN(orderId)) {
      await query(`UPDATE whatsapp_messages SET order_id = NULL WHERE id = $1`, [messageId])
      return res.status(200).json({ ok: true, unlinked: true, order_id: null })
    }

    const { rows: refRows } = await query(
      `SELECT customer_id FROM customer_external_refs WHERE provider = 'whatsapp' AND external_id = $1`,
      [waId]
    )
    if (refRows.length === 0) {
      return res.status(422).json({
        ok: false,
        code: 'customer_not_matched',
        error: 'Sipariş bağlamadan önce mesaj bir müşteriye eşleştirilmelidir'
      })
    }
    const matchedCustomerId = refRows[0].customer_id

    const { rows: ordRows } = await query(
      `SELECT id, order_no, customer_id, deleted_at FROM orders WHERE id = $1`,
      [orderId]
    )
    if (ordRows.length === 0 || ordRows[0].deleted_at !== null) {
      return res.status(404).json({ ok: false, code: 'order_not_found', error: 'Sipariş bulunamadı veya silinmiş' })
    }
    if (ordRows[0].customer_id !== matchedCustomerId) {
      return res.status(409).json({
        ok: false,
        code: 'order_customer_mismatch',
        error: 'Seçilen sipariş mesajın eşleştiği müşteriye ait değil'
      })
    }

    await query(
      `UPDATE whatsapp_messages SET order_id = $1 WHERE id = $2`,
      [orderId, messageId]
    )

    return res.status(200).json({
      ok: true,
      linked: true,
      order_id: orderId,
      order_no: ordRows[0].order_no
    })
  } catch (err) {
    next(err)
  }
})

// =========================================================================
// META ADS INTEGRATION (READ-ONLY FOUNDATION)
// =========================================================================

/**
 * GET /meta-ads/account
 * Read-only ad account details: id, name, currency, timezone, amount_spent, balance.
 * Strictly zero DB mutations.
 */
router.get('/meta-ads/account', async (req, res) => {
  try {
    const account = await getAdAccountDetails()
    return res.status(200).json({
      ok: true,
      account
    })
  } catch (err) {
    const status = err.status || 500
    return res.status(status).json({
      ok: false,
      code: err.code || 'META_API_ERROR',
      error: err.message || 'Meta API hatası'
    })
  }
})

/**
 * GET /meta-ads/insights/daily
 * Read-only daily account-level insights.
 * Query params: date_preset (default: 'last_7d')
 * Strictly zero DB mutations.
 */
router.get('/meta-ads/insights/daily', async (req, res) => {
  try {
    const datePreset = typeof req.query.date_preset === 'string' && req.query.date_preset.trim()
      ? req.query.date_preset.trim()
      : 'last_7d'
    const data = await getDailyInsights({ date_preset: datePreset })
    return res.status(200).json({
      ok: true,
      data
    })
  } catch (err) {
    const status = err.status || 500
    return res.status(status).json({
      ok: false,
      code: err.code || 'META_API_ERROR',
      error: err.message || 'Meta API hatası'
    })
  }
})

/**
 * GET /meta-ads/insights/campaigns
 * Read-only campaign-level insights.
 * Query params: date_preset (default: 'last_7d')
 * Strictly zero DB mutations.
 */
router.get('/meta-ads/insights/campaigns', async (req, res) => {
  try {
    const datePreset = typeof req.query.date_preset === 'string' && req.query.date_preset.trim()
      ? req.query.date_preset.trim()
      : 'last_7d'
    const data = await getCampaignInsights({ date_preset: datePreset })
    return res.status(200).json({
      ok: true,
      data
    })
  } catch (err) {
    const status = err.status || 500
    return res.status(status).json({
      ok: false,
      code: err.code || 'META_API_ERROR',
      error: err.message || 'Meta API hatası'
    })
  }
})

export default router


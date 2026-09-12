import { Router } from 'express'
import { query } from '../db.js'

const router = Router()

/**
 * GET /api/integrations/woocommerce/events/:eventId/resolve
 *
 * WooCommerce webhook event dry-run resolver:
 * - Doğrulanmış integration_events kaydı üzerinden salt okunur analiz yapar.
 * - Hiçbir order, customer, external_ref veya stok/üretim mutasyonu yapmaz.
 * - Woo sipariş kimliği olarak yalnızca payload.id okur.
 * - Kalemleri yalnızca payload.line_items üzerinden çözer.
 * - SKU'yu trim().toUpperCase() ile normalize eder ve products.code = normalizedSku ile katı eşleştirir.
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

    const event = rows[0]
    const errors = []

    // 1. Event type kontrolü: Yalnızca order topic'leri kabul edilir
    const isOrderEvent = typeof event.event_type === 'string' && event.event_type.startsWith('order.')
    if (!isOrderEvent) {
      return res.json({
        event_id: event.id,
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
      })
    }

    const payload = event.payload || {}

    // 2. Woo dış sipariş kimliği: Yalnızca payload.id kullanılır
    const rawOrderId = payload.id
    const wooOrderId = rawOrderId != null && String(rawOrderId).trim() !== '' ? String(rawOrderId).trim() : null

    if (!wooOrderId) {
      return res.json({
        event_id: event.id,
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
      })
    }

    // 3. Mükerrer sipariş kontrolü (order_external_refs)
    const { rows: extRows } = await query(
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

    // 4. Sipariş kalemleri: Yalnızca payload.line_items okunur
    const lineItems = payload.line_items
    if (!Array.isArray(lineItems) || lineItems.length === 0) {
      return res.json({
        event_id: event.id,
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
      })
    }

    // 5. Line items ve SKU çözümleme
    const lines = []
    for (const it of lineItems) {
      const lineId = it.id ?? null
      const rawSku = typeof it.sku === 'string' ? it.sku : (it.sku != null ? String(it.sku) : '')
      const rawQty = it.quantity
      const qty = Number(rawQty)
      const isQtyValid = Number.isFinite(qty) && qty > 0

      // Fiyat alanları yalnız ham dry-run analiz bilgisi olarak gösterilir
      const rawPrice = it.price ?? null
      const rawSubtotal = it.subtotal ?? null
      const rawTotal = it.total ?? null

      // Adet kontrolü: Pozitif sayı zorunlu
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

      // SKU boş mu?
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

      // Katı DB araması: products.code = normalizedSku
      const { rows: prodRows } = await query(
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

    res.json({
      event_id: event.id,
      woo_order_id: wooOrderId,
      already_imported: alreadyImported,
      decco_order_id: deccoOrderId,
      decco_order_no: deccoOrderNo,
      importable,
      lines,
      errors
    })
  } catch (e) {
    next(e)
  }
})

export default router

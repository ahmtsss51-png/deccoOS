import { Router } from 'express'
import crypto from 'crypto'
import { query } from '../db.js'

const router = Router()

/**
 * MIMARI NOT:
 * X-WC-Webhook-Delivery-ID yalnızca WooCommerce teslimat denemesinin kimliğidir;
 * gelecekte sipariş seviyesinde semantic idempotency için kullanılmayacaktır.
 * Woo siparişini Decco OS'a işlerken esas dış sipariş kimliği WooCommerce order.id,
 * ürün eşleştirme kimliği ise SKU olacaktır.
 */

// POST /api/webhooks/woocommerce
// WooCommerce webhook kabulü, HMAC-SHA256 imza doğrulama ve pasif event kaydı
router.post('/woocommerce', async (req, res, next) => {
  try {
    const secret = process.env.WOOCOMMERCE_WEBHOOK_SECRET
    if (!secret) {
      return res.status(500).json({ error: 'Webhook secret is not configured' })
    }

    const deliveryId = req.headers['x-wc-webhook-delivery-id']
    if (!deliveryId || typeof deliveryId !== 'string' || !deliveryId.trim()) {
      return res.status(400).json({ error: 'Missing X-WC-Webhook-Delivery-ID header' })
    }

    const signature = req.headers['x-wc-webhook-signature']
    if (!signature || typeof signature !== 'string') {
      return res.status(401).json({ error: 'Invalid or missing signature' })
    }

    if (!req.rawBody || !Buffer.isBuffer(req.rawBody)) {
      return res.status(400).json({ error: 'Raw request body is missing' })
    }

    // HMAC-SHA256 doğrulama
    const computedHmac = crypto.createHmac('sha256', secret).update(req.rawBody).digest('base64')
    const incomingBuf = Buffer.from(signature, 'base64')
    const computedBuf = Buffer.from(computedHmac, 'base64')

    // Uzunluklar eşit değilse timingSafeEqual çağrılmadan 401 dönülür (exception önleme)
    if (incomingBuf.length === 0 || incomingBuf.length !== computedBuf.length || !crypto.timingSafeEqual(incomingBuf, computedBuf)) {
      return res.status(401).json({ error: 'Invalid webhook signature' })
    }

    const bodySha256 = crypto.createHash('sha256').update(req.rawBody).digest('hex')
    const eventType = req.headers['x-wc-webhook-topic'] || null
    const payload = req.body || {}

    // Idempotent event ledger kaydı (domain mutasyonu yapılmaz)
    const { rows } = await query(`
      INSERT INTO integration_events (provider, event_key, event_type, payload, body_sha256, status)
      VALUES ('woocommerce', $1, $2, $3, $4, 'received')
      ON CONFLICT (provider, event_key) DO NOTHING
      RETURNING id
    `, [deliveryId.trim(), eventType, JSON.stringify(payload), bodySha256])

    if (rows.length === 0) {
      // Mükerrer teslimat denemesi: WooCommerce tekrar hata alıp yeniden denemesin diye 200 döner
      return res.json({ ok: true, duplicate: true })
    }

    res.status(201).json({ ok: true, id: rows[0].id })
  } catch (e) {
    next(e)
  }
})

export default router

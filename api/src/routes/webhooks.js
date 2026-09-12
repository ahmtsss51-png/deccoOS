import { Router, urlencoded } from 'express'
import crypto from 'crypto'
import { query, pool } from '../db.js'

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

/**
 * POST /api/webhooks/paytr/link
 *
 * PayTR Link Ödeme Callback (Pasif Temel Faz):
 * - application/x-www-form-urlencoded ile gelir.
 * - Form field stringleri üzerinden HMAC-SHA256 doğrulaması yapar (normalize edilmeden).
 * - merchant_id === PAYTR_MERCHANT_ID doğrulaması yapar.
 * - payment_amount integer cents consistency guard uygular.
 * - Tek PostgreSQL transaction'ı içinde satır kilidi (FOR UPDATE) ile link kaydını günceller.
 * - Doğrulanmış callback verisini integration_events defterine (status = 'received') kaydeder.
 * - Finansal mutasyon (tahsilat, bakiye artışı) KESİNLİKLE YAPMAZ.
 * - PayTR protokolüne uygun olarak başarılı/idempotent durumda düz metin "OK" döner.
 */
router.post('/paytr/link', urlencoded({ extended: false }), async (req, res, next) => {
  const merchantId = process.env.PAYTR_MERCHANT_ID
  const merchantKey = process.env.PAYTR_MERCHANT_KEY
  const merchantSalt = process.env.PAYTR_MERCHANT_SALT

  if (!merchantKey || !merchantSalt) {
    return res.status(500).type('text/plain').send('PAYTR_CREDENTIALS_MISSING')
  }

  // 1. Raw form stringleri (HMAC öncesi trim/lowercase/normalize YAPILMAZ)
  const rawCallbackId = req.body?.callback_id != null ? String(req.body.callback_id) : ''
  const rawMerchantOid = req.body?.merchant_oid != null ? String(req.body.merchant_oid) : ''
  const rawStatus = req.body?.status != null ? String(req.body.status) : ''
  const rawTotalAmount = req.body?.total_amount != null ? String(req.body.total_amount) : ''
  const incomingHash = req.body?.hash != null ? String(req.body.hash) : ''

  // 2. HMAC-SHA256 imza doğrulama
  const hashStr = rawCallbackId + rawMerchantOid + merchantSalt + rawStatus + rawTotalAmount
  const computedHash = crypto.createHmac('sha256', merchantKey).update(hashStr).digest('base64')

  let isHashValid = false
  try {
    const incomingBuf = Buffer.from(incomingHash, 'base64')
    const computedBuf = Buffer.from(computedHash, 'base64')
    if (incomingBuf.length > 0 && incomingBuf.length === computedBuf.length && crypto.timingSafeEqual(incomingBuf, computedBuf)) {
      isHashValid = true
    }
  } catch {
    isHashValid = false
  }

  if (!isHashValid) {
    return res.status(400).type('text/plain').send('BAD_HASH')
  }

  // 3. merchant_id guard (Hash kapsamı dışındadır, açık eşitlik aranır)
  const incomingMerchantId = req.body?.merchant_id != null ? String(req.body.merchant_id).trim() : ''
  if (!merchantId || incomingMerchantId !== String(merchantId).trim()) {
    return res.status(400).type('text/plain').send('INVALID_MERCHANT_ID')
  }

  // 4. Status kontrolü (Resmî Link API yalnız başarılı ödemede callback atar)
  if (rawStatus !== 'success') {
    return res.status(422).type('text/plain').send('UNEXPECTED_STATUS')
  }

  // 5. Tutarların tamsayı kuruş (integer cents) format doğrulaması
  const rawPaymentAmount = req.body?.payment_amount != null ? String(req.body.payment_amount) : ''
  if (!/^\d+$/.test(rawTotalAmount) || !/^\d+$/.test(rawPaymentAmount)) {
    return res.status(422).type('text/plain').send('INVALID_AMOUNT_FORMAT')
  }
  const totalAmountCents = parseInt(rawTotalAmount, 10)
  const paymentAmountCents = parseInt(rawPaymentAmount, 10)
  if (totalAmountCents <= 0 || paymentAmountCents <= 0) {
    return res.status(422).type('text/plain').send('NON_POSITIVE_AMOUNT')
  }

  const cleanMerchantOid = rawMerchantOid.trim()
  if (!cleanMerchantOid) {
    return res.status(422).type('text/plain').send('MISSING_MERCHANT_OID')
  }

  // 6. Tek transaction + satır kilidi ile pasif işleme
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // callback_id ile link satırını kilitle
    const { rows: linkRows } = await client.query(
      `SELECT id, order_id, callback_id, requested_amount, currency, status, merchant_oid
       FROM paytr_payment_links
       WHERE callback_id = $1
       FOR UPDATE`,
      [rawCallbackId.trim()]
    )

    if (linkRows.length === 0) {
      await client.query('ROLLBACK')
      return res.status(404).type('text/plain').send('UNKNOWN_CALLBACK_ID')
    }

    const link = linkRows[0]

    // İdempotent tekrar: Zaten paid ve aynı merchant_oid ise düz metin OK dön
    if (link.status === 'paid' && link.merchant_oid === cleanMerchantOid) {
      await client.query('COMMIT')
      return res.status(200).type('text/plain').send('OK')
    }

    // merchant_oid başka bir linke bağlı mı?
    const { rows: conflictRows } = await client.query(
      `SELECT id FROM paytr_payment_links
       WHERE merchant_oid = $1 AND id != $2`,
      [cleanMerchantOid, link.id]
    )

    if (conflictRows.length > 0) {
      await client.query('ROLLBACK')
      console.warn(`[PayTR Callback Conflict] merchant_oid '${cleanMerchantOid}' is already linked to link #${conflictRows[0].id}`)
      return res.status(409).type('text/plain').send('MERCHANT_OID_CONFLICT')
    }

    // Consistency guard: requested_amount cents === payment_amount cents
    const sReq = String(link.requested_amount).trim()
    const [intP, decP = ''] = sReq.split('.')
    const requestedCents = parseInt(intP, 10) * 100 + parseInt(decP.padEnd(2, '0'), 10)

    if (requestedCents !== paymentAmountCents) {
      await client.query('ROLLBACK')
      console.warn(`[PayTR Callback Mismatch] Requested cents: ${requestedCents}, Payment amount cents: ${paymentAmountCents}`)
      return res.status(422).type('text/plain').send('PAYMENT_AMOUNT_MISMATCH')
    }

    // Link durumunu güncelle: callback_received_at = NOW(), paid_at NULL kalır
    await client.query(
      `UPDATE paytr_payment_links
       SET status = 'paid', merchant_oid = $1, callback_received_at = NOW()
       WHERE id = $2`,
      [cleanMerchantOid, link.id]
    )

    // integration_events audit kaydı: bounded event_key 'link:' + sha256(merchant_oid)
    const eventKey = 'link:' + crypto.createHash('sha256').update(cleanMerchantOid).digest('hex')
    const auditPayload = {
      callback_id: rawCallbackId.trim(),
      merchant_oid: cleanMerchantOid,
      status: rawStatus,
      total_amount_cents: totalAmountCents,
      payment_amount_cents: paymentAmountCents,
      payment_type: req.body?.payment_type != null ? String(req.body.payment_type).trim() : null,
      currency: req.body?.currency != null ? String(req.body.currency).trim() : null,
      merchant_id: incomingMerchantId,
      test_mode: req.body?.test_mode != null ? parseInt(String(req.body.test_mode).trim(), 10) || 0 : 0
    }

    await client.query(
      `INSERT INTO integration_events (provider, event_key, event_type, payload, status)
       VALUES ('paytr', $1, 'link.payment.success', $2, 'received')
       ON CONFLICT (provider, event_key) DO NOTHING`,
      [eventKey, JSON.stringify(auditPayload)]
    )

    await client.query('COMMIT')
    return res.status(200).type('text/plain').send('OK')

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    if (err.code === '23505') {
      console.warn('[PayTR Callback 23505 Race Conflict]:', err.message)
      return res.status(409).type('text/plain').send('MERCHANT_OID_CONFLICT')
    }
    console.error('PayTR link callback error:', err)
    return res.status(500).type('text/plain').send('CALLBACK_PROCESSING_ERROR')
  } finally {
    client.release()
  }
})

export default router

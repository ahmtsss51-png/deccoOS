import crypto from 'crypto'

/**
 * Meta Webhook Challenge Verification (GET /api/webhooks/whatsapp)
 * Doğru verify_token ile gelen subscribe isteğini doğrular ve challenge değerini döner.
 */
export function verifyWebhookChallenge(query, verifyToken) {
  if (!verifyToken || typeof verifyToken !== 'string') {
    return { valid: false, challenge: null, error: 'VERIFY_TOKEN_NOT_CONFIGURED' }
  }

  const mode = query?.['hub.mode']
  const token = query?.['hub.verify_token']
  const challenge = query?.['hub.challenge']

  if (mode !== 'subscribe' || !token || !challenge) {
    return { valid: false, challenge: null, error: 'INVALID_VERIFICATION_PARAMS' }
  }

  const tokenBuf = Buffer.from(String(token))
  const expectedBuf = Buffer.from(String(verifyToken))

  if (tokenBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(tokenBuf, expectedBuf)) {
    return { valid: false, challenge: null, error: 'TOKEN_MISMATCH' }
  }

  return { valid: true, challenge: String(challenge) }
}

/**
 * Meta Webhook Signature Verification (POST /api/webhooks/whatsapp)
 * X-Hub-Signature-256 header'ını HMAC-SHA256 ile doğrular.
 * Default fail-closed: appSecret yoksa kesinlikle geçersiz sayar.
 */
export function verifyWebhookSignature(rawBody, signatureHeader, appSecret) {
  if (!appSecret || typeof appSecret !== 'string') {
    return { valid: false, error: 'WHATSAPP_APP_SECRET_MISSING' }
  }

  if (!signatureHeader || typeof signatureHeader !== 'string') {
    return { valid: false, error: 'MISSING_SIGNATURE_HEADER' }
  }

  if (!rawBody || !Buffer.isBuffer(rawBody)) {
    return { valid: false, error: 'RAW_BODY_MISSING' }
  }

  const incomingHash = signatureHeader.startsWith('sha256=')
    ? signatureHeader.slice(7).trim()
    : signatureHeader.trim()

  const computedHash = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')

  try {
    const inBuf = Buffer.from(incomingHash, 'hex')
    const expBuf = Buffer.from(computedHash, 'hex')

    if (inBuf.length === 0 || inBuf.length !== expBuf.length || !crypto.timingSafeEqual(inBuf, expBuf)) {
      return { valid: false, error: 'INVALID_SIGNATURE' }
    }
  } catch {
    return { valid: false, error: 'SIGNATURE_DECODE_ERROR' }
  }

  return { valid: true }
}

/**
 * Normalizes WhatsApp message content across various message types.
 * Supports: text, image, video, document, audio, location, interactive buttons/lists.
 */
export function normalizeMessageText(msg) {
  if (!msg || typeof msg !== 'object') return ''

  const type = msg.type || 'text'

  switch (type) {
    case 'text':
      return typeof msg.text?.body === 'string' ? msg.text.body : ''

    case 'image':
      return msg.image?.caption ? String(msg.image.caption) : '[Görsel]'

    case 'video':
      return msg.video?.caption ? String(msg.video.caption) : '[Video]'

    case 'document': {
      if (msg.document?.caption) return String(msg.document.caption)
      if (msg.document?.filename) return `[Belge: ${msg.document.filename}]`
      return '[Belge]'
    }

    case 'audio':
      return '[Ses Kaydı]'

    case 'location': {
      const loc = msg.location
      if (loc && typeof loc === 'object') {
        const parts = [
          loc.latitude != null && loc.longitude != null ? `${loc.latitude}, ${loc.longitude}` : null,
          loc.name ? String(loc.name) : null,
          loc.address ? String(loc.address) : null
        ].filter(Boolean)
        return `[Konum: ${parts.join(' - ')}]`
      }
      return '[Konum]'
    }

    case 'interactive': {
      const inter = msg.interactive || {}
      if (inter.type === 'button_reply' && inter.button_reply) {
        const title = inter.button_reply.title || inter.button_reply.id || ''
        return `[Buton Yanıtı: ${title}]`
      }
      if (inter.type === 'list_reply' && inter.list_reply) {
        const title = inter.list_reply.title || inter.list_reply.id || ''
        return `[Liste Seçimi: ${title}]`
      }
      return '[Etkileşim]'
    }

    case 'button':
      return msg.button?.text ? `[Buton: ${msg.button.text}]` : '[Buton]'

    case 'contacts':
      return '[Kişi Kartı]'

    default:
      return `[${type}]`
  }
}

/**
 * Extracts and normalizes messages from Meta WhatsApp Cloud API webhook payload.
 * Identifies event_type: 'messages', 'statuses', 'mixed', or 'unknown'.
 */
export function extractAndNormalizeWhatsAppPayload(payload) {
  const normalizedMessages = []
  let totalStatuses = 0

  if (!payload || typeof payload !== 'object') {
    return { event_type: 'unknown', messages: [], statusesCount: 0 }
  }

  const entries = Array.isArray(payload.entry) ? payload.entry : []

  for (const entry of entries) {
    const changes = Array.isArray(entry.changes) ? entry.changes : []
    for (const ch of changes) {
      const val = ch.value || {}

      // Contact map by wa_id
      const contactsMap = new Map()
      if (Array.isArray(val.contacts)) {
        for (const c of val.contacts) {
          if (c && c.wa_id) {
            contactsMap.set(String(c.wa_id), c)
          }
        }
      }

      // Count status/receipt events
      if (Array.isArray(val.statuses)) {
        totalStatuses += val.statuses.length
      }

      // Extract messages
      if (Array.isArray(val.messages)) {
        for (const msg of val.messages) {
          if (!msg || !msg.id) continue

          const messageId = String(msg.id).trim()
          const rawFrom = msg.from != null ? String(msg.from).trim() : ''
          const contact = contactsMap.get(rawFrom) || null
          const waId = contact?.wa_id ? String(contact.wa_id).trim() : rawFrom
          const senderName = contact?.profile?.name ? String(contact.profile.name).trim() : null

          let messageTimestamp = new Date().toISOString()
          if (msg.timestamp) {
            const parsedTs = parseInt(String(msg.timestamp), 10)
            if (!isNaN(parsedTs) && parsedTs > 0) {
              messageTimestamp = new Date(parsedTs * 1000).toISOString()
            }
          }

          const messageType = typeof msg.type === 'string' ? msg.type.trim() : 'text'
          const text = normalizeMessageText(msg)

          normalizedMessages.push({
            message_id: messageId,
            wa_id: waId,
            phone: rawFrom,
            sender_name: senderName,
            message_timestamp: messageTimestamp,
            message_type: messageType,
            text,
            direction: 'inbound',
            raw_message: msg
          })
        }
      }
    }
  }

  const hasMessages = normalizedMessages.length > 0
  const hasStatuses = totalStatuses > 0

  let eventType = 'unknown'
  if (hasMessages && hasStatuses) {
    eventType = 'mixed'
  } else if (hasMessages) {
    eventType = 'messages'
  } else if (hasStatuses) {
    eventType = 'statuses'
  }

  return {
    event_type: eventType,
    messages: normalizedMessages,
    statusesCount: totalStatuses
  }
}

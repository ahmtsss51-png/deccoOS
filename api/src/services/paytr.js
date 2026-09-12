import crypto from 'crypto'

/**
 * PayTR Durum Sorgu monetary parser.
 * Supports both dot and comma decimal separators ("899", "899.00", "899,00", "10,8", "9.76").
 * Rejects negative numbers, mixed separators, >2 decimal digits, and any whitespace.
 * Floating-point arithmetic (parseFloat, Number * 100) is strictly avoided.
 * Returns integer cents or null.
 */
export function parsePaytrMonetaryToCents(val) {
  if (val == null) return null
  const s = String(val)
  if (!s || /\s/.test(s)) return null

  // Integer without decimal (e.g. "899")
  if (/^\d+$/.test(s)) {
    const cents = parseInt(s, 10) * 100
    return Number.isSafeInteger(cents) && cents >= 0 ? cents : null
  }

  // Dot decimal (1 or 2 decimals, e.g. "899.00", "9.76", "10.8")
  if (/^\d+\.\d{1,2}$/.test(s)) {
    const [intPart, decPart = ''] = s.split('.')
    const cents = parseInt(intPart, 10) * 100 + parseInt(decPart.padEnd(2, '0'), 10)
    return Number.isSafeInteger(cents) && cents >= 0 ? cents : null
  }

  // Comma decimal (1 or 2 decimals, e.g. "899,00", "10,8")
  if (/^\d+,\d{1,2}$/.test(s)) {
    const [intPart, decPart = ''] = s.split(',')
    const cents = parseInt(intPart, 10) * 100 + parseInt(decPart.padEnd(2, '0'), 10)
    return Number.isSafeInteger(cents) && cents >= 0 ? cents : null
  }

  return null
}

/**
 * Generates PayTR Durum Sorgu HMAC-SHA256 token.
 * Token formula: merchant_id + merchant_oid + merchant_salt with merchant_key
 * Never logs secrets.
 */
export function generatePaytrStatusToken({ merchantId, merchantOid, merchantSalt, merchantKey }) {
  if (!merchantId || !merchantOid || !merchantSalt || !merchantKey) {
    throw new Error('PAYTR_CREDENTIALS_INCOMPLETE')
  }
  const hashStr = `${merchantId}${merchantOid}${merchantSalt}`
  return crypto.createHmac('sha256', merchantKey).update(hashStr).digest('base64')
}

/**
 * Normalizes PayTR Durum Sorgu success response into safe, immutable structure.
 * Floating-point arithmetic is strictly avoided.
 * Preserves raw provider strings and provider-native currency (TL or TRY).
 */
export function normalizePaytrStatusResponse(rawPayload, requestedMerchantOid) {
  if (!rawPayload || typeof rawPayload !== 'object') {
    throw new Error('INVALID_PAYLOAD')
  }

  const rawPaymentAmount = rawPayload.payment_amount != null ? String(rawPayload.payment_amount) : null
  const rawPaymentTotal = rawPayload.payment_total != null ? String(rawPayload.payment_total) : null
  const rawNetTutar = rawPayload.net_tutar != null ? String(rawPayload.net_tutar) : null
  const rawKesintiTutari = rawPayload.kesinti_tutari != null ? String(rawPayload.kesinti_tutari) : null

  return {
    status: String(rawPayload.status),
    merchant_oid: rawPayload.merchant_oid != null ? String(rawPayload.merchant_oid) : requestedMerchantOid,
    payment_amount: rawPaymentAmount,
    payment_total: rawPaymentTotal,
    net_tutar: rawNetTutar,
    kesinti_tutari: rawKesintiTutari,
    payment_amount_cents: parsePaytrMonetaryToCents(rawPaymentAmount),
    payment_total_cents: parsePaytrMonetaryToCents(rawPaymentTotal),
    net_tutar_cents: parsePaytrMonetaryToCents(rawNetTutar),
    kesinti_tutari_cents: parsePaytrMonetaryToCents(rawKesintiTutari),
    payment_date: rawPayload.payment_date != null ? String(rawPayload.payment_date) : null,
    currency: rawPayload.currency != null ? String(rawPayload.currency) : null,
    taksit: rawPayload.taksit != null ? String(rawPayload.taksit) : '1',
    kart_marka: rawPayload.kart_marka != null ? String(rawPayload.kart_marka) : null,
    masked_pan: rawPayload.masked_pan != null ? String(rawPayload.masked_pan) : null,
    auth_code: rawPayload.auth_code != null ? String(rawPayload.auth_code) : null,
    auth_date: rawPayload.auth_date != null ? String(rawPayload.auth_date) : null,
    odeme_tipi: rawPayload.odeme_tipi != null ? String(rawPayload.odeme_tipi) : null,
    test_mode: rawPayload.test_mode != null ? Number(rawPayload.test_mode) : 0,
    returns: Array.isArray(rawPayload.returns) ? rawPayload.returns : []
  }
}

/**
 * Executes a read-only PayTR Durum Sorgu request.
 * Does NOT mutate any Decco OS database state.
 */
export async function queryPaytrStatus(merchantOid, options = {}) {
  const merchantId = options.merchantId !== undefined ? options.merchantId : process.env.PAYTR_MERCHANT_ID
  const merchantKey = options.merchantKey !== undefined ? options.merchantKey : process.env.PAYTR_MERCHANT_KEY
  const merchantSalt = options.merchantSalt !== undefined ? options.merchantSalt : process.env.PAYTR_MERCHANT_SALT
  const endpoint = options.endpoint || process.env.PAYTR_STATUS_ENDPOINT || 'https://www.paytr.com/odeme/durum-sorgu'
  const timeoutMs = options.timeoutMs || 10000
  const fetchFn = options.fetchFn || fetch

  if (!merchantId || !merchantKey || !merchantSalt) {
    return {
      ok: false,
      error_code: 'PAYTR_CREDENTIALS_MISSING',
      message: 'PayTR API kimlik bilgileri yapılandırılmamış'
    }
  }

  let paytrToken
  try {
    paytrToken = generatePaytrStatusToken({ merchantId, merchantOid, merchantSalt, merchantKey })
  } catch {
    return {
      ok: false,
      error_code: 'TOKEN_GENERATION_FAILED',
      message: 'PayTR durum sorgu tokenı oluşturulamadı'
    }
  }

  const formParams = new URLSearchParams({
    merchant_id: String(merchantId),
    merchant_oid: String(merchantOid),
    paytr_token: paytrToken
  })

  let response
  try {
    response = await fetchFn(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formParams.toString(),
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return {
        ok: false,
        error_code: 'UPSTREAM_TIMEOUT',
        message: 'PayTR Durum Sorgu zaman aşımına uğradı'
      }
    }
    return {
      ok: false,
      error_code: 'UPSTREAM_NETWORK_ERROR',
      message: 'PayTR sunucusuna bağlanılamadı: ' + (err.message || 'Ağ hatası')
    }
  }

  if (!response.ok) {
    return {
      ok: false,
      error_code: 'UPSTREAM_HTTP_ERROR',
      status_code: response.status,
      message: `PayTR sunucusu HTTP ${response.status} hatası döndü`
    }
  }

  let rawJson
  try {
    rawJson = await response.json()
  } catch {
    return {
      ok: false,
      error_code: 'INVALID_UPSTREAM_RESPONSE',
      message: 'PayTR sunucusu geçersiz JSON formatı döndü'
    }
  }

  if (rawJson?.status === 'error') {
    return {
      ok: false,
      error_code: 'PAYTR_STATUS_ERROR',
      err_no: rawJson.err_no != null ? String(rawJson.err_no) : null,
      err_msg: rawJson.err_msg != null ? String(rawJson.err_msg) : 'PayTR durum sorgu hatası'
    }
  }

  if (rawJson?.status === 'success') {
    try {
      const normalized = normalizePaytrStatusResponse(rawJson, merchantOid)
      return { ok: true, data: normalized }
    } catch {
      return {
        ok: false,
        error_code: 'NORMALIZATION_FAILED',
        message: 'PayTR yanıtı normalize edilemedi'
      }
    }
  }

  return {
    ok: false,
    error_code: 'UNEXPECTED_PAYTR_STATUS',
    message: `PayTR beklenmeyen durum kodu döndü: ${rawJson?.status}`
  }
}

/**
 * Exact integer cents to 2-decimal string helper.
 * Avoids floating-point division (cents / 100).
 * e.g. 89900 -> "899.00", 50 -> "0.50", 7 -> "0.07".
 */
export function centsToDecimalString(cents) {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new Error('INVALID_CENTS_VALUE')
  }
  const s = String(cents)
  if (s.length <= 2) {
    return `0.${s.padStart(2, '0')}`
  }
  const intPart = s.slice(0, -2)
  const decPart = s.slice(-2)
  return `${intPart}.${decPart}`
}

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
 * Validates PayTR callback URL according to official PayTR Link API specifications:
 * - Must start with http:// or https://
 * - Must NOT be localhost, 127.0.0.1, ::1, or *.localhost
 * - Must NOT contain a port (e.g. :3000)
 */
export function validatePaytrCallbackUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') {
    return { valid: false, error_code: 'PAYTR_CALLBACK_URL_MISSING', message: 'PAYTR_LINK_CALLBACK_URL yapılandırılmamış' }
  }
  const s = urlStr.trim()
  if (!s) {
    return { valid: false, error_code: 'PAYTR_CALLBACK_URL_MISSING', message: 'PAYTR_LINK_CALLBACK_URL boş olamaz' }
  }

  let parsed
  try {
    parsed = new URL(s)
  } catch {
    return { valid: false, error_code: 'INVALID_CALLBACK_URL_FORMAT', message: 'Geçersiz callback URL formatı' }
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, error_code: 'INVALID_CALLBACK_URL_PROTOCOL', message: 'Callback URL http:// veya https:// ile başlamalıdır' }
  }

  const hostname = parsed.hostname.toLowerCase()
  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    hostname.endsWith('.localhost')
  ) {
    return { valid: false, error_code: 'CALLBACK_URL_LOCALHOST_NOT_ALLOWED', message: 'PayTR callback URL localhost veya yerel IP olamaz' }
  }

  if (parsed.port && parsed.port !== '') {
    return { valid: false, error_code: 'CALLBACK_URL_PORT_NOT_ALLOWED', message: 'PayTR callback URL port içeremez' }
  }

  return { valid: true, url: s }
}

/**
 * Validates that PayTR created link URL is an authentic PayTR link.
 * Must have protocol https:, hostname www.paytr.com, and pathname starting with /link/.
 */
export function validatePaytrLinkUrl(linkUrl) {
  if (!linkUrl || typeof linkUrl !== 'string') return false
  try {
    const parsed = new URL(linkUrl)
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname === 'www.paytr.com' &&
      parsed.pathname.startsWith('/link/')
    )
  } catch {
    return false
  }
}

/**
 * Generates PayTR Link Create HMAC-SHA256 token.
 * Token formula: name + price + currency + max_installment + link_type + lang + min_count + merchant_salt
 * Key: merchant_key, Base64 digest.
 */
export function generatePaytrLinkCreateToken({
  name,
  price,
  currency,
  maxInstallment,
  linkType,
  lang,
  minCount,
  merchantSalt,
  merchantKey
}) {
  if (
    !name ||
    !price ||
    !currency ||
    !maxInstallment ||
    !linkType ||
    !lang ||
    !minCount ||
    !merchantSalt ||
    !merchantKey
  ) {
    throw new Error('PAYTR_LINK_CREATE_TOKEN_PARAMS_INCOMPLETE')
  }

  const required = `${name}${price}${currency}${maxInstallment}${linkType}${lang}${minCount}`
  return crypto.createHmac('sha256', merchantKey).update(required + merchantSalt).digest('base64')
}

/**
 * Executes a PayTR Link Create API request (POST https://www.paytr.com/odeme/api/link/create).
 * Distinguishes between explicit PayTR rejections (error_type: 'rejected')
 * and ambiguous errors (error_type: 'uncertain', e.g. timeout, network failure, malformed response).
 */
export async function createPaytrLink(params, options = {}) {
  const merchantId = options.merchantId !== undefined ? options.merchantId : process.env.PAYTR_MERCHANT_ID
  const merchantKey = options.merchantKey !== undefined ? options.merchantKey : process.env.PAYTR_MERCHANT_KEY
  const merchantSalt = options.merchantSalt !== undefined ? options.merchantSalt : process.env.PAYTR_MERCHANT_SALT
  const endpoint = options.endpoint || 'https://www.paytr.com/odeme/api/link/create'
  const timeoutMs = options.timeoutMs || 15000
  const fetchFn = options.fetchFn || fetch

  if (!merchantId || !merchantKey || !merchantSalt) {
    return {
      ok: false,
      error_type: 'rejected',
      error_code: 'PAYTR_CREDENTIALS_MISSING',
      message: 'PayTR API kimlik bilgileri yapılandırılmamış'
    }
  }

  const {
    name,
    price,
    currency = 'TL',
    max_installment = '1',
    link_type = 'product',
    lang = 'tr',
    min_count = '1',
    max_count = '1',
    callback_link,
    callback_id,
    debug_on = '1'
  } = params

  let paytrToken
  try {
    paytrToken = generatePaytrLinkCreateToken({
      name,
      price: String(price),
      currency: String(currency),
      maxInstallment: String(max_installment),
      linkType: String(link_type),
      lang: String(lang),
      minCount: String(min_count),
      merchantSalt,
      merchantKey
    })
  } catch (err) {
    return {
      ok: false,
      error_type: 'rejected',
      error_code: 'TOKEN_GENERATION_FAILED',
      message: 'PayTR link tokenı oluşturulamadı: ' + err.message
    }
  }

  const formParams = new URLSearchParams({
    merchant_id: String(merchantId),
    name: String(name),
    price: String(price),
    currency: String(currency),
    max_installment: String(max_installment),
    link_type: String(link_type),
    lang: String(lang),
    min_count: String(min_count),
    max_count: String(max_count),
    callback_link: String(callback_link),
    callback_id: String(callback_id),
    debug_on: String(debug_on),
    paytr_token: paytrToken
  })

  let response
  try {
    response = await fetchFn(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formParams.toString(),
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return {
        ok: false,
        error_type: 'uncertain',
        error_code: 'UPSTREAM_TIMEOUT',
        message: 'PayTR Link Create çağrısı zaman aşımına uğradı'
      }
    }
    return {
      ok: false,
      error_type: 'uncertain',
      error_code: 'UPSTREAM_NETWORK_ERROR',
      message: 'PayTR sunucusuna bağlanılamadı: ' + (err.message || 'Ağ hatası')
    }
  }

  if (!response.ok) {
    return {
      ok: false,
      error_type: 'uncertain',
      error_code: 'UPSTREAM_HTTP_ERROR',
      status_code: response.status,
      message: `PayTR sunucusu HTTP ${response.status} hatası döndü`
    }
  }

  let rawJson
  try {
    rawJson = await response.json()
  } catch {
    return {
      ok: false,
      error_type: 'uncertain',
      error_code: 'INVALID_UPSTREAM_RESPONSE',
      message: 'PayTR sunucusu geçersiz yanıt formatı döndü'
    }
  }

  if (rawJson?.status === 'error' || rawJson?.status === 'failed') {
    return {
      ok: false,
      error_type: 'rejected',
      error_code: 'PAYTR_CREATE_ERROR',
      reason: rawJson.reason || 'PayTR link oluşturma isteğini reddetti'
    }
  }

  if (rawJson?.status === 'success') {
    const linkId = rawJson.id != null ? String(rawJson.id) : null
    const linkUrl = rawJson.link != null ? String(rawJson.link) : null

    if (!linkId || !linkUrl || !validatePaytrLinkUrl(linkUrl)) {
      return {
        ok: false,
        error_type: 'uncertain',
        error_code: 'INVALID_LINK_URL',
        message: 'PayTR geçersiz veya güvensiz bir link URL döndü'
      }
    }

    return {
      ok: true,
      data: {
        paytr_link_id: linkId,
        link_url: linkUrl
      }
    }
  }

  return {
    ok: false,
    error_type: 'uncertain',
    error_code: 'UNEXPECTED_PAYTR_STATUS',
    message: `PayTR beklenmeyen durum kodu döndü: ${rawJson?.status}`
  }
}

/**
 * PayTR payment date parser.
 * Primary field: payment_date (Turkish format DD.MM.YYYY or DD.MM.YYYY HH:mm:ss, or ISO format).
 * Fallback field: auth_date (only if payment_date is empty).
 * If only calendar day is present, preserves calendar day in Europe/Istanbul (+03:00) as T00:00:00+03:00 without fabricating fake hours.
 * Returns ISO string or null.
 */
export function parsePaytrPaymentDate(paymentDateStr, authDateStr) {
  const candidate = (paymentDateStr && String(paymentDateStr).trim()) ||
                    (authDateStr && String(authDateStr).trim()) || null
  if (!candidate) return null

  // 1. DD.MM.YYYY HH:mm:ss
  const trWithTime = /^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/.exec(candidate)
  if (trWithTime) {
    const [, day, month, year, hh, mm, ss] = trWithTime
    return `${year}-${month}-${day}T${hh}:${mm}:${ss}+03:00`
  }

  // 2. DD.MM.YYYY (calendar day only)
  const trDateOnly = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(candidate)
  if (trDateOnly) {
    const [, day, month, year] = trDateOnly
    return `${year}-${month}-${day}T00:00:00+03:00`
  }

  // 3. YYYY-MM-DD HH:mm:ss
  const isoWithTime = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/.exec(candidate)
  if (isoWithTime) {
    const [, year, month, day, hh, mm, ss] = isoWithTime
    return `${year}-${month}-${day}T${hh}:${mm}:${ss}+03:00`
  }

  // 4. YYYY-MM-DD (calendar day only)
  const isoDateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(candidate)
  if (isoDateOnly) {
    const [, year, month, day] = isoDateOnly
    return `${year}-${month}-${day}T00:00:00+03:00`
  }

  // 5. Standard ISO 8601 string
  const d = new Date(candidate)
  return isNaN(d.getTime()) ? null : d.toISOString()
}

/**
 * Parses any date format from PayTR (DD.MM.YYYY, YYYY-MM-DD, with or without time)
 * into a strict calendar date string: YYYY-MM-DD.
 * Does NOT invent 00:00:00 or artificial timestamps (Correction #1).
 */
export function parsePaytrDateToCalendarDate(candidate) {
  if (candidate == null) return null
  const s = String(candidate).trim()
  if (!s) return null

  // 1. DD.MM.YYYY (e.g. "13.01.2021" or "13.01.2021 14:20:00")
  const trMatch = /^(\d{2})\.(\d{2})\.(\d{4})/.exec(s)
  if (trMatch) {
    const [, day, month, year] = trMatch
    return `${year}-${month}-${day}`
  }

  // 2. YYYY-MM-DD (e.g. "2021-01-13" or "2021-01-13 14:20:00")
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (isoMatch) {
    const [, year, month, day] = isoMatch
    return `${year}-${month}-${day}`
  }

  // 3. Fallback date parse
  const d = new Date(s)
  if (!isNaN(d.getTime())) {
    return d.toISOString().slice(0, 10)
  }

  return null
}

/**
 * Generates PayTR İşlem Dökümü report token.
 * Token formula: merchant_id + start_date + end_date + merchant_salt with merchant_key
 * Never logs secrets.
 */
export function generatePaytrReportToken({ merchantId, startDate, endDate, merchantSalt, merchantKey }) {
  if (!merchantId || !startDate || !endDate || !merchantSalt || !merchantKey) {
    throw new Error('PAYTR_CREDENTIALS_INCOMPLETE')
  }
  const hashStr = `${merchantId}${startDate}${endDate}${merchantSalt}`
  return crypto.createHmac('sha256', merchantKey).update(hashStr).digest('base64')
}

/**
 * Splits a date range (YYYY-MM-DD to YYYY-MM-DD) into consecutive, non-overlapping
 * chunks of at most 3 calendar days (00:00:00 -> 23:59:59) in Europe/Istanbul time.
 * Enforces maximum span of 93 days (Correction #9).
 */
export function splitDateRangeInto3DayChunks(startDateStr, endDateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDateStr) || !/^\d{4}-\d{2}-\d{2}$/.test(endDateStr)) {
    throw new Error('INVALID_DATE_FORMAT')
  }

  const start = new Date(`${startDateStr}T00:00:00Z`)
  const end = new Date(`${endDateStr}T00:00:00Z`)

  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    throw new Error('INVALID_DATE_VALUES')
  }

  if (start.getTime() > end.getTime()) {
    throw new Error('START_DATE_AFTER_END_DATE')
  }

  const diffDays = Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1
  if (diffDays > 93) {
    throw new Error('MAX_DATE_RANGE_EXCEEDED')
  }

  const chunks = []
  let cur = new Date(start.getTime())
  let chunkNo = 1

  while (cur.getTime() <= end.getTime()) {
    const chunkStartStr = cur.toISOString().slice(0, 10)
    // Chunk end is cur + 2 days or final end date
    const chunkEnd = new Date(cur.getTime())
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + 2)
    const effectiveEnd = chunkEnd.getTime() > end.getTime() ? new Date(end.getTime()) : chunkEnd
    const chunkEndStr = effectiveEnd.toISOString().slice(0, 10)

    chunks.push({
      chunk_no: chunkNo++,
      start_cal: chunkStartStr,
      end_cal: chunkEndStr,
      start_at: `${chunkStartStr} 00:00:00`,
      end_at: `${chunkEndStr} 23:59:59`
    })

    // Advance cur to day after effectiveEnd
    cur = new Date(effectiveEnd.getTime())
    cur.setUTCDate(cur.getUTCDate() + 1)
  }

  return chunks
}

/**
 * Computes deterministic canonical SHA-256 signature for a transaction item.
 * Uses integer cents and canonical string formatting so "10" and "10.00" produce
 * identical signatures (Correction #5).
 */
export function computeHistoryTransactionSignature(fields) {
  const parts = [
    fields.transaction_type, // 'S' or 'I'
    (fields.merchant_order_no || '').trim(),
    String(fields.transaction_amount_cents),
    fields.payment_amount_cents != null ? String(fields.payment_amount_cents) : '',
    String(fields.net_amount_cents),
    String(fields.commission_amount_cents),
    fields.commission_rate != null ? String(fields.commission_rate) : '',
    fields.transaction_date, // 'YYYY-MM-DD'
    (fields.currency || '').toUpperCase().trim(),
    fields.installment != null ? String(fields.installment) : '',
    fields.card_brand ? fields.card_brand.toUpperCase().trim() : '',
    fields.masked_card ? fields.masked_card.trim() : '',
    fields.payment_type ? fields.payment_type.toUpperCase().trim() : ''
  ]
  return crypto.createHash('sha256').update(parts.join('|'), 'utf8').digest('hex')
}

/**
 * Executes PayTR İşlem Dökümü query for a given start_date and end_date window.
 * Returns parsed, cents-validated transaction array.
 * Treats status === 'failed' as empty window ({ ok: true, transactions: [] }) (Correction #2).
 * Does NOT negate refund amounts (Correction #6).
 */
export async function queryPaytrTransactionReport(startDate, endDate, options = {}) {
  const merchantId = options.merchantId !== undefined ? options.merchantId : process.env.PAYTR_MERCHANT_ID
  const merchantKey = options.merchantKey !== undefined ? options.merchantKey : process.env.PAYTR_MERCHANT_KEY
  const merchantSalt = options.merchantSalt !== undefined ? options.merchantSalt : process.env.PAYTR_MERCHANT_SALT
  const endpoint = options.endpoint || process.env.PAYTR_REPORT_ENDPOINT || 'https://www.paytr.com/rapor/islem-dokumu'
  const timeoutMs = options.timeoutMs || 10000
  const fetchFn = options.fetchFn || fetch

  if (!merchantId || !merchantKey || !merchantSalt) {
    return {
      ok: false,
      error_code: 'PAYTR_CREDENTIALS_MISSING',
      message: 'PayTR API kimlik bilgileri eksik'
    }
  }

  let paytrToken
  try {
    paytrToken = generatePaytrReportToken({
      merchantId,
      startDate,
      endDate,
      merchantSalt,
      merchantKey
    })
  } catch (err) {
    return {
      ok: false,
      error_code: 'TOKEN_GENERATION_FAILED',
      message: err.message
    }
  }

  const formData = new URLSearchParams()
  formData.append('merchant_id', String(merchantId))
  formData.append('start_date', String(startDate))
  formData.append('end_date', String(endDate))
  formData.append('paytr_token', paytrToken)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetchFn(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: formData.toString(),
      signal: controller.signal
    })

    const text = await res.text()
    let data
    try {
      data = JSON.parse(text)
    } catch {
      return {
        ok: false,
        error_code: 'INVALID_JSON_RESPONSE',
        message: 'PayTR API geçersiz JSON yanıtı döndürdü'
      }
    }

    if (!data || typeof data !== 'object') {
      return {
        ok: false,
        error_code: 'INVALID_PAYLOAD',
        message: 'PayTR API boş veya geçersiz nesne döndürdü'
      }
    }

    // Official PayTR status handling:
    // status === 'success' -> transactions present
    // status === 'failed' -> empty window (no transactions) (Correction #2)
    // status === 'error' -> actual API/query error

    if (data.status === 'failed') {
      return {
        ok: true,
        count: 0,
        transactions: []
      }
    }

    if (data.status === 'error') {
      return {
        ok: false,
        error_code: 'PAYTR_REPORT_ERROR',
        err_no: data.err_no != null ? String(data.err_no) : null,
        message: data.err_msg || 'PayTR raporlama hatası'
      }
    }

    if (data.status !== 'success') {
      return {
        ok: false,
        error_code: 'PAYTR_UNKNOWN_STATUS',
        message: `Bilinmeyen PayTR status yanıtı: ${data.status}`
      }
    }

    const rawList = Array.isArray(data.list) ? data.list : (Array.isArray(data.data) ? data.data : (Array.isArray(data.transactions) ? data.transactions : []))
    const parsedTransactions = []

    for (let i = 0; i < rawList.length; i++) {
      const it = rawList[i]
      const txType = (it.islem_tipi || it.transaction_type || '').toString().trim().toUpperCase()
      if (txType !== 'S' && txType !== 'I') {
        return {
          ok: false,
          error_code: 'INVALID_TRANSACTION_TYPE',
          message: `Satır ${i + 1}: Geçersiz işlem tipi (${txType})`
        }
      }

      const merchantOrderNo = (it.siparis_no || it.merchant_oid || it.merchant_order_no || '').toString().trim()
      if (!merchantOrderNo) {
        return {
          ok: false,
          error_code: 'MISSING_MERCHANT_ORDER_NO',
          message: `Satır ${i + 1}: siparis_no eksik`
        }
      }

      // Amounts: integer cents parsing
      const txAmtCents = parsePaytrMonetaryToCents(it.islem_tutari ?? it.tutar ?? it.transaction_amount)
      if (txAmtCents == null) {
        return {
          ok: false,
          error_code: 'INVALID_TRANSACTION_AMOUNT',
          message: `Satır ${i + 1}: Geçersiz işlem tutarı`
        }
      }

      const netAmtCents = parsePaytrMonetaryToCents(it.net_tutar ?? it.net_amount)
      if (netAmtCents == null) {
        return {
          ok: false,
          error_code: 'INVALID_NET_AMOUNT',
          message: `Satır ${i + 1}: Geçersiz net tutar`
        }
      }

      const commAmtCents = parsePaytrMonetaryToCents(it.komisyon_tutari ?? it.kesinti_tutari ?? it.commission_amount)
      if (commAmtCents == null) {
        return {
          ok: false,
          error_code: 'INVALID_COMMISSION_AMOUNT',
          message: `Satır ${i + 1}: Geçersiz komisyon tutarı`
        }
      }

      const payAmtRaw = it.payment_amount ?? it.odeme_tutari
      const payAmtCents = payAmtRaw != null ? parsePaytrMonetaryToCents(payAmtRaw) : null

      // Currency: MUST be present from provider (Correction #4)
      const rawCurrency = (it.para_birimi || it.currency || '').toString().trim()
      if (!rawCurrency) {
        return {
          ok: false,
          error_code: 'MISSING_CURRENCY',
          message: `Satır ${i + 1}: Para birimi eksik (varsayılan TL uydurulamaz)`
        }
      }

      // Date: calendar date YYYY-MM-DD (Correction #1)
      const calDate = parsePaytrDateToCalendarDate(it.tarih || it.islem_tarihi || it.transaction_date)
      if (!calDate) {
        return {
          ok: false,
          error_code: 'INVALID_TRANSACTION_DATE',
          message: `Satır ${i + 1}: Geçersiz işlem tarihi`
        }
      }

      // Installment: null or integer (0, 2..12) (Correction #4)
      let installment = null
      if (it.taksit != null && String(it.taksit).trim() !== '') {
        const parsedInst = parseInt(String(it.taksit).trim(), 10)
        if (!isNaN(parsedInst) && parsedInst >= 0 && parsedInst <= 12) {
          installment = parsedInst
        }
      }

      // Commission rate
      let commRate = null
      const rawCommissionRate = it.komisyon_orani ?? it.kesinti_orani
      if (rawCommissionRate != null && String(rawCommissionRate).trim() !== '') {
        const parsedRate = parseFloat(String(rawCommissionRate).replace(',', '.'))
        if (!isNaN(parsedRate) && parsedRate >= 0) {
          commRate = (parsedRate / 100).toFixed(4)
        }
      }

      const cardBrand = it.kart_marka != null ? String(it.kart_marka).trim() : null
      const maskedCard = it.maskeli_kart != null ? String(it.maskeli_kart).trim() : (it.masked_card != null ? String(it.masked_card).trim() : (it.kart_no != null ? String(it.kart_no).trim() : null))
      const paymentType = it.odeme_tipi != null ? String(it.odeme_tipi).trim() : (it.payment_type != null ? String(it.payment_type).trim() : null)

      parsedTransactions.push({
        transaction_type: txType,
        merchant_order_no: merchantOrderNo,
        transaction_amount_cents: txAmtCents,
        transaction_amount: centsToDecimalString(txAmtCents),
        payment_amount_cents: payAmtCents,
        payment_amount: payAmtCents != null ? centsToDecimalString(payAmtCents) : null,
        net_amount_cents: netAmtCents,
        net_amount: centsToDecimalString(netAmtCents),
        commission_amount_cents: commAmtCents,
        commission_amount: centsToDecimalString(commAmtCents),
        commission_rate: commRate,
        transaction_date: calDate,
        currency: rawCurrency.toUpperCase(),
        installment,
        card_brand: cardBrand,
        masked_card: maskedCard,
        payment_type: paymentType
      })
    }

    return {
      ok: true,
      count: parsedTransactions.length,
      transactions: parsedTransactions
    }

  } catch (err) {
    if (err.name === 'AbortError') {
      return {
        ok: false,
        error_code: 'TIMEOUT',
        message: `PayTR İşlem Dökümü isteği zaman aşımına uğradı (${timeoutMs}ms)`
      }
    }
    return {
      ok: false,
      error_code: 'NETWORK_ERROR',
      message: err.message || 'PayTR ağ hatası'
    }
  } finally {
    clearTimeout(timer)
  }
}

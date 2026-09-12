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
    merchant_oid: requestedMerchantOid,
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
  const endpoint = options.endpoint || 'https://www.paytr.com/odeme/durum-sorgu'
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

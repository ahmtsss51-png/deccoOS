/**
 * meta-ads.js
 * Read-only Meta Marketing / Graph API client foundation for Decco OS.
 *
 * Requirements:
 * - Read-only ad account details: id, name, currency, timezone, amount_spent, balance.
 * - Zero DB mutations.
 * - Secure error handling: access tokens are NEVER logged or leaked.
 * - Request timeout via AbortSignal.
 */

/**
 * Returns active Meta Ads configuration from environment.
 * Sanitizes and normalizes ad account ID with 'act_' prefix.
 */
export function getMetaAdsConfig() {
  const accessToken = (process.env.META_ACCESS_TOKEN || '').trim()
  const rawAccountId = (process.env.META_AD_ACCOUNT_ID || '').trim()

  let adAccountId = rawAccountId
  if (adAccountId && !adAccountId.startsWith('act_')) {
    adAccountId = `act_${adAccountId}`
  }

  return {
    accessToken,
    adAccountId,
    isConfigured: Boolean(accessToken && adAccountId)
  }
}

/**
 * Redacts secret tokens and sensitive query patterns from error messages.
 */
export function sanitizeErrorMessage(message, token) {
  if (!message) return 'Bilinmeyen Meta API hatası'
  let sanitized = String(message)
  if (token && token.length > 5) {
    sanitized = sanitized.replaceAll(token, '[REDACTED_TOKEN]')
  }
  // Mask any access_token=... in URLs or query strings
  sanitized = sanitized.replace(/access_token=[^&\s]+/gi, 'access_token=[REDACTED_TOKEN]')
  // Mask Bearer ... headers if logged
  sanitized = sanitized.replace(/Bearer\s+[a-zA-Z0-9_\-\.]+/gi, 'Bearer [REDACTED_TOKEN]')
  return sanitized
}

/**
 * Fetches ad account details from Meta Graph API.
 *
 * @param {Object} [options]
 * @param {string} [options.accessToken]
 * @param {string} [options.adAccountId]
 * @param {string} [options.apiVersion='v26.0']
 * @param {string} [options.baseUrl='https://graph.facebook.com']
 * @param {number} [options.timeoutMs=10000]
 * @param {Function} [options.fetchFn=globalThis.fetch]
 * @returns {Promise<{ id: string, name: string, currency: string, timezone: string, timezone_name: string, amount_spent: string, balance: string }>}
 */
export async function getAdAccountDetails(options = {}) {
  const config = getMetaAdsConfig()

  const accessToken = options.accessToken !== undefined ? options.accessToken : config.accessToken
  let adAccountId = options.adAccountId !== undefined ? options.adAccountId : config.adAccountId

  if (adAccountId && !adAccountId.startsWith('act_')) {
    adAccountId = `act_${adAccountId}`
  }

  if (!accessToken || !adAccountId) {
    const err = new Error('Meta Ads yapılandırması eksik (META_ACCESS_TOKEN veya META_AD_ACCOUNT_ID tanımlanmamış)')
    err.code = 'META_CONFIG_MISSING'
    err.status = 503
    throw err
  }

  const apiVersion = options.apiVersion || process.env.META_GRAPH_API_VERSION || 'v26.0'
  const baseUrl = (options.baseUrl || process.env.META_GRAPH_BASE_URL || 'https://graph.facebook.com').replace(/\/+$/, '')
  const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : (Number(process.env.META_API_TIMEOUT_MS) || 10000)
  const fetchFn = options.fetchFn || globalThis.fetch

  const fields = 'id,name,currency,timezone_name,amount_spent,balance'
  const url = `${baseUrl}/${apiVersion}/${encodeURIComponent(adAccountId)}?fields=${fields}`

  let signal
  if (typeof AbortSignal?.timeout === 'function') {
    signal = AbortSignal.timeout(timeoutMs)
  } else {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), timeoutMs).unref?.()
    signal = controller.signal
  }

  let response
  try {
    response = await fetchFn(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json',
        'User-Agent': 'DeccoOS-MetaAds/1.0'
      },
      signal
    })
  } catch (netErr) {
    if (netErr.name === 'TimeoutError' || netErr.name === 'AbortError') {
      const err = new Error(`Meta API istek zaman aşımına uğradı (${timeoutMs}ms)`)
      err.code = 'META_TIMEOUT'
      err.status = 504
      throw err
    }

    const safeMsg = sanitizeErrorMessage(netErr.message, accessToken)
    const err = new Error(`Meta API bağlantı hatası: ${safeMsg}`)
    err.code = 'META_NETWORK_ERROR'
    err.status = 502
    throw err
  }

  if (!response.ok) {
    let errBody = {}
    try {
      errBody = await response.json()
    } catch {
      // Non-JSON error body
    }

    const rawMsg = errBody?.error?.message || `Meta API yanıtı başarısız (HTTP ${response.status})`
    const safeMsg = sanitizeErrorMessage(rawMsg, accessToken)

    const err = new Error(safeMsg)
    err.code = errBody?.error?.type || 'META_API_ERROR'
    err.metaCode = errBody?.error?.code
    err.metaSubcode = errBody?.error?.error_subcode
    err.status = response.status >= 400 && response.status < 500 ? response.status : 502
    throw err
  }

  let data
  try {
    data = await response.json()
  } catch (jsonErr) {
    const err = new Error('Meta API geçersiz JSON yanıtı döndürdü')
    err.code = 'META_INVALID_RESPONSE'
    err.status = 502
    throw err
  }

  return {
    id: data.id || adAccountId,
    name: data.name || '',
    currency: data.currency || '',
    timezone: data.timezone_name || '',
    timezone_name: data.timezone_name || '',
    amount_spent: data.amount_spent != null ? String(data.amount_spent) : '0',
    balance: data.balance != null ? String(data.balance) : '0'
  }
}

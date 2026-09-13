/**
 * meta-ads.js
 * Read-only Meta Marketing / Graph API client foundation for Decco OS.
 *
 * Requirements:
 * - Read-only ad account details: id, name, currency, timezone, amount_spent, balance.
 * - Read-only insights: daily (account level) and campaigns (campaign level).
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
 * Normalizes numbers safely from API strings.
 */
export function toFloat(v) {
  if (v == null || v === '') return 0
  const n = parseFloat(v)
  return isNaN(n) ? 0 : n
}

export function toInt(v) {
  if (v == null || v === '') return 0
  const n = parseInt(v, 10)
  return isNaN(n) ? 0 : n
}

/**
 * Maps Meta API action array to exposed action metrics.
 * Missing actions default to 0.
 */
export function parseActions(actionsArray) {
  const map = {}
  if (Array.isArray(actionsArray)) {
    for (const a of actionsArray) {
      if (a && a.action_type) {
        const val = toInt(a.value)
        map[a.action_type] = val
      }
    }
  }

  return {
    link_clicks: map['link_click'] || 0,
    messaging_connections: map['onsite_conversion.total_messaging_connection'] || 0,
    conversations_started: map['onsite_conversion.messaging_conversation_started_7d'] || 0,
    first_replies: map['onsite_conversion.messaging_first_reply'] || 0,
    depth_2: map['onsite_conversion.messaging_user_depth_2_message_send'] || 0,
    depth_3: map['onsite_conversion.messaging_user_depth_3_message_send'] || 0,
    depth_5: map['onsite_conversion.messaging_user_depth_5_message_send'] || 0,
    messaging_orders: map['onsite_conversion.messaging_order_created_v2'] || 0
  }
}

/**
 * Normalizes a single Meta Graph API insight row.
 */
export function normalizeInsightRow(item, isCampaignLevel = false) {
  const row = {
    date_start: item.date_start || '',
    date_stop: item.date_stop || '',
    spend: toFloat(item.spend),
    impressions: toInt(item.impressions),
    reach: toInt(item.reach),
    clicks: toInt(item.clicks),
    cpc: toFloat(item.cpc),
    cpm: toFloat(item.cpm),
    ctr: toFloat(item.ctr),
    frequency: toFloat(item.frequency),
    actions: parseActions(item.actions)
  }

  if (isCampaignLevel) {
    row.campaign_id = item.campaign_id || ''
    row.campaign_name = item.campaign_name || ''
  }

  return row
}

/**
 * Generic internal Meta Graph API fetch handler with auth, timeout, and safe error masking.
 */
async function fetchMetaGraph(subPath, queryParams = {}, options = {}) {
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

  const qs = new URLSearchParams(queryParams).toString()
  const pathPart = subPath ? `/${subPath.replace(/^\/+/, '')}` : ''
  const url = `${baseUrl}/${apiVersion}/${encodeURIComponent(adAccountId)}${pathPart}${qs ? `?${qs}` : ''}`

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

  return data
}

/**
 * Fetches ad account details from Meta Graph API.
 */
export async function getAdAccountDetails(options = {}) {
  const fields = 'id,name,currency,timezone_name,amount_spent,balance'
  const data = await fetchMetaGraph('', { fields }, options)

  const config = getMetaAdsConfig()
  const adAccountId = options.adAccountId || config.adAccountId

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

/**
 * Fetches daily account-level insights from Meta Graph API.
 * Default date_preset = 'last_7d', time_increment = 1.
 */
export async function getDailyInsights(options = {}) {
  const datePreset = options.date_preset || 'last_7d'
  const fields = 'date_start,date_stop,spend,impressions,reach,clicks,cpc,cpm,ctr,frequency,actions'
  const queryParams = {
    level: 'account',
    time_increment: '1',
    date_preset: datePreset,
    fields
  }

  const data = await fetchMetaGraph('insights', queryParams, options)
  const rows = Array.isArray(data?.data) ? data.data : []
  return rows.map(r => normalizeInsightRow(r, false))
}

/**
 * Fetches campaign-level insights from Meta Graph API.
 * Default date_preset = 'last_7d'.
 */
export async function getCampaignInsights(options = {}) {
  const datePreset = options.date_preset || 'last_7d'
  const fields = 'campaign_id,campaign_name,date_start,date_stop,spend,impressions,reach,clicks,cpc,cpm,ctr,frequency,actions'
  const queryParams = {
    level: 'campaign',
    date_preset: datePreset,
    fields
  }

  const data = await fetchMetaGraph('insights', queryParams, options)
  const rows = Array.isArray(data?.data) ? data.data : []
  return rows.map(r => normalizeInsightRow(r, true))
}

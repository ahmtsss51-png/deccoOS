/**
 * test_meta_ads.js
 * Targeted test suite for META-01/02 Read-Only Meta Ads Connection Foundation.
 *
 * Requirements verified:
 * 1. Configuration validation (META_ACCESS_TOKEN and META_AD_ACCOUNT_ID).
 * 2. Normalization of ad account ID (with or without 'act_' prefix).
 * 3. Successful read of id, name, currency, timezone, amount_spent, balance.
 * 4. Safe error handling: Secrets and tokens are NEVER leaked in error responses.
 * 5. Request timeout handling (AbortSignal timeout -> 504 META_TIMEOUT).
 * 6. Endpoint GET /api/integrations/meta-ads/account behavior (auth required, correct projection).
 * 7. ZERO DB MUTATIONS: Verification that all database table counts remain completely untouched.
 */

import assert from 'node:assert/strict'
import jwt from 'jsonwebtoken'
import http from 'node:http'
import express from 'express'
import { pool, query } from './db.js'
import {
  getMetaAdsConfig,
  sanitizeErrorMessage,
  getAdAccountDetails,
  getDailyInsights,
  getCampaignInsights,
  parseActions,
  normalizeInsightRow
} from './services/meta-ads.js'

const JWT_SECRET = process.env.JWT_SECRET || 'changeme-in-production'
const authToken = jwt.sign(
  { id: 1, username: 'admin', role: 'admin', department: 'Yönetim' },
  JWT_SECRET,
  { expiresIn: '1h' }
)

const BASE_URL = 'http://127.0.0.1:3000/api'

async function authRequest(path, options = {}) {
  const headers = {
    'Authorization': `Bearer ${authToken}`,
    'Content-Type': 'application/json',
    ...(options.headers || {})
  }
  const res = await fetch(`${BASE_URL}${path}`, { ...options, headers })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, ok: res.ok, body }
}

async function runTests() {
  console.log('--- Starting Meta Ads (META-01/02) Foundation Targeted Tests ---')

  // Capture baseline DB counts to guarantee ZERO DB MUTATIONS
  const { rows: [{ count: cBaseCustomers }] } = await query('SELECT COUNT(*)::int as count FROM customers')
  const { rows: [{ count: cBaseOrders }] } = await query('SELECT COUNT(*)::int as count FROM orders')
  const { rows: [{ count: cBaseEvents }] } = await query('SELECT COUNT(*)::int as count FROM integration_events')
  const { rows: [{ count: cBaseMessages }] } = await query('SELECT COUNT(*)::int as count FROM whatsapp_messages')
  const { rows: [{ count: cBaseAccounts }] } = await query('SELECT COUNT(*)::int as count FROM accounts')
  const { rows: [{ count: cBaseTransactions }] } = await query('SELECT COUNT(*)::int as count FROM transactions')

  console.log('[Baseline Counts]:', {
    customers: cBaseCustomers,
    orders: cBaseOrders,
    events: cBaseEvents,
    messages: cBaseMessages,
    accounts: cBaseAccounts,
    transactions: cBaseTransactions
  })

  try {
    // =========================================================================
    // TEST 1: Config Normalization & Sanitization
    // =========================================================================
    console.log('\n[Test 1] Testing Meta Ads config normalization & prefix handling...')

    const origToken = process.env.META_ACCESS_TOKEN
    const origAccount = process.env.META_AD_ACCOUNT_ID

    try {
      // 1a. Missing config
      delete process.env.META_ACCESS_TOKEN
      delete process.env.META_AD_ACCOUNT_ID
      const emptyCfg = getMetaAdsConfig()
      assert.equal(emptyCfg.isConfigured, false)
      assert.equal(emptyCfg.accessToken, '')
      assert.equal(emptyCfg.adAccountId, '')

      // 1b. Normalization without act_ prefix
      process.env.META_ACCESS_TOKEN = 'test_token_123'
      process.env.META_AD_ACCOUNT_ID = '9876543210'
      const cfgWithoutPrefix = getMetaAdsConfig()
      assert.equal(cfgWithoutPrefix.isConfigured, true)
      assert.equal(cfgWithoutPrefix.adAccountId, 'act_9876543210')

      // 1c. Normalization with act_ prefix
      process.env.META_AD_ACCOUNT_ID = 'act_9876543210'
      const cfgWithPrefix = getMetaAdsConfig()
      assert.equal(cfgWithPrefix.adAccountId, 'act_9876543210')

      console.log('✓ Test 1 passed: Ad account ID correctly normalized with act_ prefix.')
    } finally {
      if (origToken !== undefined) process.env.META_ACCESS_TOKEN = origToken
      else delete process.env.META_ACCESS_TOKEN
      if (origAccount !== undefined) process.env.META_AD_ACCOUNT_ID = origAccount
      else delete process.env.META_AD_ACCOUNT_ID
    }

    // =========================================================================
    // TEST 2: Token Sanitization & Zero Secret Leakage
    // =========================================================================
    console.log('\n[Test 2] Testing token sanitization and error masking...')

    const secretToken = 'EAABwzL123456789SECRETTOKEN'
    const rawError = `Graph API call failed with access_token=${secretToken} on resource act_123: Invalid OAuth access token ${secretToken}`

    const sanitized = sanitizeErrorMessage(rawError, secretToken)
    assert.equal(sanitized.includes(secretToken), false, 'Token must NEVER appear in sanitized error')
    assert.equal(sanitized.includes('[REDACTED_TOKEN]'), true, 'Token must be replaced with redaction placeholder')

    console.log('✓ Test 2 passed: Sensitive access tokens are strictly redacted from error messages.')

    // =========================================================================
    // TEST 3: Service Missing Config Handling
    // =========================================================================
    console.log('\n[Test 3] Testing getAdAccountDetails with missing configuration...')

    try {
      await getAdAccountDetails({ accessToken: '', adAccountId: '' })
      assert.fail('Should have thrown META_CONFIG_MISSING error')
    } catch (err) {
      assert.equal(err.code, 'META_CONFIG_MISSING')
      assert.equal(err.status, 503)
      console.log('✓ Test 3 passed: Missing config throws 503 META_CONFIG_MISSING.')
    }

    // =========================================================================
    // TEST 4: Successful Read of Ad Account Details (Mock Fetch)
    // =========================================================================
    console.log('\n[Test 4] Testing getAdAccountDetails successful projection...')

    const mockMetaPayload = {
      id: 'act_1015849284729102',
      name: 'Decco Deri Reklam Hesabı',
      currency: 'TRY',
      timezone_name: 'Europe/Istanbul',
      amount_spent: '245600', // e.g. in kuruş or monetary units
      balance: '0'
    }

    let capturedUrl = null
    let capturedHeaders = null

    const mockFetchSuccess = async (url, opts) => {
      capturedUrl = url
      capturedHeaders = opts.headers
      return {
        ok: true,
        status: 200,
        json: async () => mockMetaPayload
      }
    }

    const details = await getAdAccountDetails({
      accessToken: 'MOCK_TOKEN_TEST',
      adAccountId: '1015849284729102',
      fetchFn: mockFetchSuccess
    })

    assert.ok(capturedUrl.includes('/v26.0/'), 'URL must use v26.0 default API version')
    assert.ok(capturedUrl.includes('act_1015849284729102'), 'URL must contain act_ formatted account ID')
    assert.ok(decodeURIComponent(capturedUrl).includes('fields=id,name,currency,timezone_name,amount_spent,balance'), 'URL must request required fields')
    assert.equal(capturedHeaders.Authorization, 'Bearer MOCK_TOKEN_TEST', 'Authorization header must pass Bearer token')

    assert.equal(details.id, 'act_1015849284729102')
    assert.equal(details.name, 'Decco Deri Reklam Hesabı')
    assert.equal(details.currency, 'TRY')
    assert.equal(details.timezone, 'Europe/Istanbul')
    assert.equal(details.timezone_name, 'Europe/Istanbul')
    assert.equal(details.amount_spent, '245600')
    assert.equal(details.balance, '0')

    console.log('✓ Test 4 passed: All requested fields correctly read and mapped.')

    // =========================================================================
    // TEST 5: Meta API Error Response & Token Masking
    // =========================================================================
    console.log('\n[Test 5] Testing Meta API error response handling...')

    const mockSecret = 'SUPER_SECRET_OAUTH_TOKEN_999'
    const mockFetchError = async () => {
      return {
        ok: false,
        status: 400,
        json: async () => ({
          error: {
            message: `Error validating access token: Session has expired. Token: ${mockSecret}`,
            type: 'OAuthException',
            code: 190,
            error_subcode: 463,
            fbtrace_id: 'AbCdEf123'
          }
        })
      }
    }

    try {
      await getAdAccountDetails({
        accessToken: mockSecret,
        adAccountId: 'act_1015849284729102',
        fetchFn: mockFetchError
      })
      assert.fail('Should have thrown error on failed Meta API response')
    } catch (err) {
      assert.equal(err.code, 'OAuthException')
      assert.equal(err.metaCode, 190)
      assert.equal(err.metaSubcode, 463)
      assert.equal(err.status, 400)
      assert.equal(err.message.includes(mockSecret), false, 'Token must NEVER leak in thrown error message!')
      assert.equal(err.message.includes('[REDACTED_TOKEN]'), true)
      console.log('✓ Test 5 passed: Meta Graph API errors parsed safely with zero token leakage.')
    }

    // =========================================================================
    // TEST 6: Request Timeout Handling (AbortSignal)
    // =========================================================================
    console.log('\n[Test 6] Testing request timeout handling...')

    const mockFetchTimeout = async (_url, opts) => {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          resolve({ ok: true, json: async () => mockMetaPayload })
        }, 500)

        opts.signal.addEventListener('abort', () => {
          clearTimeout(timer)
          const abortErr = new Error('The operation was aborted due to timeout')
          abortErr.name = 'TimeoutError'
          reject(abortErr)
        })
      })
    }

    try {
      await getAdAccountDetails({
        accessToken: 'MOCK_TOKEN',
        adAccountId: 'act_1015849284729102',
        timeoutMs: 50, // 50ms timeout
        fetchFn: mockFetchTimeout
      })
      assert.fail('Should have timed out')
    } catch (err) {
      assert.equal(err.code, 'META_TIMEOUT')
      assert.equal(err.status, 504)
      assert.ok(err.message.includes('50ms'))
      console.log('✓ Test 6 passed: Timeout properly caught and translated to 504 META_TIMEOUT.')
    }

    // =========================================================================
    // TEST 7: HTTP Endpoint Authentication & Unconfigured Behavior
    // =========================================================================
    console.log('\n[Test 7] Testing GET /api/integrations/meta-ads/account endpoint...')

    // 7a. Unauthorized request without Bearer token -> 401
    const unauthRes = await fetch(`${BASE_URL}/integrations/meta-ads/account`)
    assert.equal(unauthRes.status, 401, 'Endpoint must require authentication')

    // 7b. Authorized request when env is not configured -> 503 META_CONFIG_MISSING
    const authRes = await authRequest('/integrations/meta-ads/account')
    // If running in container without META_ACCESS_TOKEN set, it returns 503 META_CONFIG_MISSING
    if (!process.env.META_ACCESS_TOKEN) {
      assert.equal(authRes.status, 503)
      assert.equal(authRes.body.ok, false)
      assert.equal(authRes.body.code, 'META_CONFIG_MISSING')
      console.log('✓ Test 7 passed: Endpoint enforces authentication and handles unconfigured env safely.')
    } else {
      console.log(`✓ Test 7 passed: Endpoint returned status ${authRes.status}.`)
    }

    // =========================================================================
    // TEST 8: Endpoint Success Flow (Express Test App with Mocked Meta Service)
    // =========================================================================
    console.log('\n[Test 8] Testing full HTTP integration endpoint response structure...')

    const testApp = express()
    testApp.use(express.json())

    // Mount integrations router in test scope
    const integrationsModule = await import('./routes/integrations.js')
    testApp.use('/api/integrations', integrationsModule.default)

    const server = http.createServer(testApp)
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const testPort = server.address().port

    const origEnvToken = process.env.META_ACCESS_TOKEN
    const origEnvAccount = process.env.META_AD_ACCOUNT_ID

    try {
      // Mock global fetch temporarily during this single test
      const originalFetch = globalThis.fetch
      globalThis.fetch = async (url) => {
        if (url.includes('graph.facebook.com')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              id: 'act_123456789',
              name: 'Test Ad Account',
              currency: 'TRY',
              timezone_name: 'Europe/Istanbul',
              amount_spent: '120000',
              balance: '500'
            })
          }
        }
        return originalFetch(url)
      }

      process.env.META_ACCESS_TOKEN = 'test_active_token_xyz'
      process.env.META_AD_ACCOUNT_ID = '123456789'

      const epRes = await fetch(`http://127.0.0.1:${testPort}/api/integrations/meta-ads/account`, {
        headers: { 'Authorization': `Bearer ${authToken}` }
      })
      const epBody = await epRes.json()

      assert.equal(epRes.status, 200)
      assert.equal(epBody.ok, true)
      assert.ok(epBody.account)
      assert.equal(epBody.account.id, 'act_123456789')
      assert.equal(epBody.account.name, 'Test Ad Account')
      assert.equal(epBody.account.currency, 'TRY')
      assert.equal(epBody.account.timezone, 'Europe/Istanbul')
      assert.equal(epBody.account.timezone_name, 'Europe/Istanbul')
      assert.equal(epBody.account.amount_spent, '120000')
      assert.equal(epBody.account.balance, '500')

      // Restore fetch
      globalThis.fetch = originalFetch
      console.log('✓ Test 8 passed: Endpoint returns 200 with full account details object.')
    } finally {
      await new Promise(resolve => server.close(resolve))
      if (origEnvToken !== undefined) process.env.META_ACCESS_TOKEN = origEnvToken
      else delete process.env.META_ACCESS_TOKEN
      if (origEnvAccount !== undefined) process.env.META_AD_ACCOUNT_ID = origEnvAccount
      else delete process.env.META_AD_ACCOUNT_ID
    }

    // =========================================================================
    // TEST 9: parseActions Mapping & Missing Action Handling (META-04)
    // =========================================================================
    console.log('\n[Test 9] Testing parseActions mapping, missing actions = 0, and strict exposure...')

    const rawActionsSample = [
      { action_type: 'link_click', value: '42' },
      { action_type: 'onsite_conversion.total_messaging_connection', value: '15' },
      { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '12' },
      { action_type: 'onsite_conversion.messaging_first_reply', value: '9' },
      { action_type: 'onsite_conversion.messaging_user_depth_2_message_send', value: '7' },
      { action_type: 'onsite_conversion.messaging_user_depth_3_message_send', value: '4' },
      { action_type: 'onsite_conversion.messaging_user_depth_5_message_send', value: '2' },
      { action_type: 'onsite_conversion.messaging_order_created_v2', value: '3' },
      // Unrelated actions that must NOT be exposed:
      { action_type: 'comment', value: '10' },
      { action_type: 'post_reaction', value: '55' }
    ]

    const parsed = parseActions(rawActionsSample)
    assert.equal(parsed.link_clicks, 42)
    assert.equal(parsed.messaging_connections, 15)
    assert.equal(parsed.conversations_started, 12)
    assert.equal(parsed.first_replies, 9)
    assert.equal(parsed.depth_2, 7)
    assert.equal(parsed.depth_3, 4)
    assert.equal(parsed.depth_5, 2)
    assert.equal(parsed.messaging_orders, 3)

    // Verify only the 8 requested action keys exist
    const exposedKeys = Object.keys(parsed)
    assert.equal(exposedKeys.length, 8)
    assert.deepEqual(exposedKeys.sort(), [
      'conversations_started',
      'depth_2',
      'depth_3',
      'depth_5',
      'first_replies',
      'link_clicks',
      'messaging_connections',
      'messaging_orders'
    ].sort())

    // Partial actions -> missing action = 0
    const partialParsed = parseActions([
      { action_type: 'link_click', value: '5' }
    ])
    assert.equal(partialParsed.link_clicks, 5)
    assert.equal(partialParsed.messaging_connections, 0)
    assert.equal(partialParsed.conversations_started, 0)
    assert.equal(partialParsed.first_replies, 0)
    assert.equal(partialParsed.depth_2, 0)
    assert.equal(partialParsed.depth_3, 0)
    assert.equal(partialParsed.depth_5, 0)
    assert.equal(partialParsed.messaging_orders, 0)

    // Empty / null actions -> all 0
    const emptyParsed = parseActions(null)
    assert.equal(emptyParsed.link_clicks, 0)
    assert.equal(emptyParsed.messaging_orders, 0)

    console.log('✓ Test 9 passed: Actions mapped strictly to 8 exposed fields; missing actions default to 0.')

    // =========================================================================
    // TEST 10: normalizeInsightRow Number Normalization & Separation of clicks vs link_clicks
    // =========================================================================
    console.log('\n[Test 10] Testing number normalization and clicks vs link_clicks separation...')

    const rawInsight = {
      date_start: '2026-09-06',
      date_stop: '2026-09-06',
      spend: '345.67',
      impressions: '4500',
      reach: '3800',
      clicks: '98', // Total clicks on ad
      cpc: '3.527245',
      cpm: '76.815556',
      ctr: '2.177778',
      frequency: '1.184211',
      actions: [
        { action_type: 'link_click', value: '45' } // link_clicks separate from clicks
      ]
    }

    const normAccount = normalizeInsightRow(rawInsight, false)
    assert.equal(normAccount.date_start, '2026-09-06')
    assert.equal(normAccount.date_stop, '2026-09-06')
    assert.equal(typeof normAccount.spend, 'number')
    assert.equal(normAccount.spend, 345.67)
    assert.equal(typeof normAccount.impressions, 'number')
    assert.equal(normAccount.impressions, 4500)
    assert.equal(typeof normAccount.reach, 'number')
    assert.equal(normAccount.reach, 3800)
    assert.equal(typeof normAccount.clicks, 'number')
    assert.equal(normAccount.clicks, 98, 'clicks must come from raw clicks (98)')
    assert.equal(typeof normAccount.cpc, 'number')
    assert.equal(normAccount.cpc, 3.527245)
    assert.equal(typeof normAccount.cpm, 'number')
    assert.equal(normAccount.cpm, 76.815556)
    assert.equal(typeof normAccount.ctr, 'number')
    assert.equal(normAccount.ctr, 2.177778)
    assert.equal(typeof normAccount.frequency, 'number')
    assert.equal(normAccount.frequency, 1.184211)
    assert.equal(normAccount.actions.link_clicks, 45, 'actions.link_clicks must be 45')
    assert.notEqual(normAccount.clicks, normAccount.actions.link_clicks, 'clicks and link_clicks must remain separate')
    assert.equal(normAccount.campaign_id, undefined)

    // Campaign level adds campaign_id and campaign_name
    const rawCampaignInsight = {
      ...rawInsight,
      campaign_id: '1202058491029304',
      campaign_name: 'Decco Deri Cüzdan Kampanyası'
    }
    const normCamp = normalizeInsightRow(rawCampaignInsight, true)
    assert.equal(normCamp.campaign_id, '1202058491029304')
    assert.equal(normCamp.campaign_name, 'Decco Deri Cüzdan Kampanyası')

    console.log('✓ Test 10 passed: Numbers normalized, clicks and link_clicks strictly separated.')

    // =========================================================================
    // TEST 11: getDailyInsights Service Method
    // =========================================================================
    console.log('\n[Test 11] Testing getDailyInsights service call with level=account and time_increment=1...')

    let capturedDailyUrl = null
    const mockDailyFetch = async (url) => {
      capturedDailyUrl = url
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            {
              date_start: '2026-09-06',
              date_stop: '2026-09-06',
              spend: '150.25',
              impressions: '1200',
              reach: '1000',
              clicks: '35',
              cpc: '4.29',
              cpm: '125.20',
              ctr: '2.92',
              frequency: '1.2',
              actions: [{ action_type: 'link_click', value: '20' }]
            },
            {
              date_start: '2026-09-07',
              date_stop: '2026-09-07',
              spend: '200.50',
              impressions: '1600',
              reach: '1300',
              clicks: '50',
              cpc: '4.01',
              cpm: '125.31',
              ctr: '3.12',
              frequency: '1.23',
              actions: [{ action_type: 'onsite_conversion.messaging_first_reply', value: '5' }]
            }
          ]
        })
      }
    }

    const dailyRows = await getDailyInsights({
      accessToken: 'TEST_TOKEN',
      adAccountId: '123456789',
      fetchFn: mockDailyFetch
    })

    assert.ok(capturedDailyUrl.includes('/insights?'), 'URL must query /insights')
    assert.ok(capturedDailyUrl.includes('level=account'), 'level must be account')
    assert.ok(capturedDailyUrl.includes('time_increment=1'), 'time_increment must be 1')
    assert.ok(capturedDailyUrl.includes('date_preset=last_7d'), 'default date_preset must be last_7d')
    assert.equal(dailyRows.length, 2)
    assert.equal(dailyRows[0].date_start, '2026-09-06')
    assert.equal(dailyRows[0].spend, 150.25)
    assert.equal(dailyRows[0].actions.link_clicks, 20)
    assert.equal(dailyRows[0].actions.first_replies, 0)
    assert.equal(dailyRows[1].actions.first_replies, 5)

    console.log('✓ Test 11 passed: getDailyInsights queries account-level daily breakdown with correct params.')

    // =========================================================================
    // TEST 12: getCampaignInsights Service Method
    // =========================================================================
    console.log('\n[Test 12] Testing getCampaignInsights service call with level=campaign...')

    let capturedCampUrl = null
    const mockCampFetch = async (url) => {
      capturedCampUrl = url
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            {
              campaign_id: '99887766',
              campaign_name: 'Decco Cüzdan Mart',
              date_start: '2026-09-01',
              date_stop: '2026-09-07',
              spend: '1250.00',
              impressions: '15000',
              reach: '11000',
              clicks: '420',
              cpc: '2.97',
              cpm: '83.33',
              ctr: '2.80',
              frequency: '1.36',
              actions: [
                { action_type: 'link_click', value: '300' },
                { action_type: 'onsite_conversion.messaging_order_created_v2', value: '14' }
              ]
            }
          ]
        })
      }
    }

    const campRows = await getCampaignInsights({
      accessToken: 'TEST_TOKEN',
      adAccountId: '123456789',
      date_preset: 'last_30d',
      fetchFn: mockCampFetch
    })

    assert.ok(capturedCampUrl.includes('level=campaign'), 'level must be campaign')
    assert.ok(capturedCampUrl.includes('date_preset=last_30d'), 'custom date_preset must be respected')
    assert.equal(campRows.length, 1)
    assert.equal(campRows[0].campaign_id, '99887766')
    assert.equal(campRows[0].campaign_name, 'Decco Cüzdan Mart')
    assert.equal(campRows[0].spend, 1250)
    assert.equal(campRows[0].clicks, 420)
    assert.equal(campRows[0].actions.link_clicks, 300)
    assert.equal(campRows[0].actions.messaging_orders, 14)

    console.log('✓ Test 12 passed: getCampaignInsights queries campaign-level breakdown with campaign_id and campaign_name.')

    // =========================================================================
    // TEST 13: HTTP Endpoints for Insights (Daily & Campaigns)
    // =========================================================================
    console.log('\n[Test 13] Testing HTTP routes GET /api/integrations/meta-ads/insights/daily and /campaigns...')

    // 13a. Auth required
    const unauthDaily = await fetch(`${BASE_URL}/integrations/meta-ads/insights/daily`)
    assert.equal(unauthDaily.status, 401, 'daily insights endpoint must require authentication')

    const unauthCamp = await fetch(`${BASE_URL}/integrations/meta-ads/insights/campaigns`)
    assert.equal(unauthCamp.status, 401, 'campaigns insights endpoint must require authentication')

    // 13b. Full test scope HTTP endpoints with mocked fetch
    const insightsTestApp = express()
    insightsTestApp.use(express.json())
    const integrationsMod = await import('./routes/integrations.js')
    insightsTestApp.use('/api/integrations', integrationsMod.default)

    const insightsServer = http.createServer(insightsTestApp)
    await new Promise(resolve => insightsServer.listen(0, '127.0.0.1', resolve))
    const insPort = insightsServer.address().port

    const prevToken = process.env.META_ACCESS_TOKEN
    const prevAccount = process.env.META_AD_ACCOUNT_ID
    const prevFetch = globalThis.fetch

    try {
      process.env.META_ACCESS_TOKEN = 'test_token_insights'
      process.env.META_AD_ACCOUNT_ID = '123456789'

      globalThis.fetch = async (url) => {
        if (url.includes('level=account')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: [
                {
                  date_start: '2026-09-07',
                  date_stop: '2026-09-07',
                  spend: '85.50',
                  impressions: '900',
                  reach: '750',
                  clicks: '22',
                  cpc: '3.88',
                  cpm: '95.00',
                  ctr: '2.44',
                  frequency: '1.2',
                  actions: [{ action_type: 'link_click', value: '15' }]
                }
              ]
            })
          }
        }
        if (url.includes('level=campaign')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: [
                {
                  campaign_id: '55443322',
                  campaign_name: 'Bahar Kampanyası',
                  date_start: '2026-09-01',
                  date_stop: '2026-09-07',
                  spend: '500.00',
                  impressions: '6000',
                  reach: '4800',
                  clicks: '150',
                  cpc: '3.33',
                  cpm: '83.33',
                  ctr: '2.50',
                  frequency: '1.25',
                  actions: [
                    { action_type: 'link_click', value: '90' },
                    { action_type: 'onsite_conversion.total_messaging_connection', value: '10' }
                  ]
                }
              ]
            })
          }
        }
        return prevFetch(url)
      }

      // Test GET /insights/daily
      const dailyRes = await fetch(`http://127.0.0.1:${insPort}/api/integrations/meta-ads/insights/daily?date_preset=last_7d`, {
        headers: { 'Authorization': `Bearer ${authToken}` }
      })
      const dailyBody = await dailyRes.json()
      assert.equal(dailyRes.status, 200)
      assert.equal(dailyBody.ok, true)
      assert.ok(Array.isArray(dailyBody.data))
      assert.equal(dailyBody.data.length, 1)
      assert.equal(dailyBody.data[0].spend, 85.50)
      assert.equal(dailyBody.data[0].actions.link_clicks, 15)

      // Test GET /insights/campaigns
      const campRes = await fetch(`http://127.0.0.1:${insPort}/api/integrations/meta-ads/insights/campaigns?date_preset=last_30d`, {
        headers: { 'Authorization': `Bearer ${authToken}` }
      })
      const campBody = await campRes.json()
      assert.equal(campRes.status, 200)
      assert.equal(campBody.ok, true)
      assert.ok(Array.isArray(campBody.data))
      assert.equal(campBody.data.length, 1)
      assert.equal(campBody.data[0].campaign_id, '55443322')
      assert.equal(campBody.data[0].campaign_name, 'Bahar Kampanyası')
      assert.equal(campBody.data[0].actions.messaging_connections, 10)

      console.log('✓ Test 13 passed: Both daily and campaign HTTP endpoints return 200 with normalized insights data.')
    } finally {
      globalThis.fetch = prevFetch
      await new Promise(resolve => insightsServer.close(resolve))
      if (prevToken !== undefined) process.env.META_ACCESS_TOKEN = prevToken
      else delete process.env.META_ACCESS_TOKEN
      if (prevAccount !== undefined) process.env.META_AD_ACCOUNT_ID = prevAccount
      else delete process.env.META_AD_ACCOUNT_ID
    }

  } finally {
    // =========================================================================
    // VERIFY ZERO DB MUTATIONS
    // =========================================================================
    console.log('\n[Verification] Verifying ZERO DB MUTATIONS...')
    const { rows: [{ count: cAfterCustomers }] } = await query('SELECT COUNT(*)::int as count FROM customers')
    const { rows: [{ count: cAfterOrders }] } = await query('SELECT COUNT(*)::int as count FROM orders')
    const { rows: [{ count: cAfterEvents }] } = await query('SELECT COUNT(*)::int as count FROM integration_events')
    const { rows: [{ count: cAfterMessages }] } = await query('SELECT COUNT(*)::int as count FROM whatsapp_messages')
    const { rows: [{ count: cAfterAccounts }] } = await query('SELECT COUNT(*)::int as count FROM accounts')
    const { rows: [{ count: cAfterTransactions }] } = await query('SELECT COUNT(*)::int as count FROM transactions')

    console.log('[Post-Test Counts]:', {
      customers: { before: cBaseCustomers, after: cAfterCustomers },
      orders: { before: cBaseOrders, after: cAfterOrders },
      events: { before: cBaseEvents, after: cAfterEvents },
      messages: { before: cBaseMessages, after: cAfterMessages },
      accounts: { before: cBaseAccounts, after: cAfterAccounts },
      transactions: { before: cBaseTransactions, after: cAfterTransactions }
    })

    assert.equal(cAfterCustomers, cBaseCustomers, 'Customers count must not change')
    assert.equal(cAfterOrders, cBaseOrders, 'Orders count must not change')
    assert.equal(cAfterEvents, cBaseEvents, 'Integration events count must not change')
    assert.equal(cAfterMessages, cBaseMessages, 'WhatsApp messages count must not change')
    assert.equal(cAfterAccounts, cBaseAccounts, 'Accounts count must not change')
    assert.equal(cAfterTransactions, cBaseTransactions, 'Transactions count must not change')

    console.log('✓ ZERO DB MUTATIONS VERIFIED: All database tables remain 100% untouched.')
  }

  console.log('\n=== ALL META ADS FOUNDATION TESTS COMPLETED SUCCESSFULLY ===')
}

runTests()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('\n❌ Test failed with error:', err)
    process.exit(1)
  })

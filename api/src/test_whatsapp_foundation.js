/**
 * test_whatsapp_foundation.js
 * Comprehensive automated test suite for Meta WhatsApp Cloud API local foundation.
 *
 * Strict Isolation Guarantees:
 * - Unique testRunId for all fixtures.
 * - Explicit tracking of all created IDs (customers, orders, events, messages, external refs).
 * - Guaranteed finally cleanup removing ONLY the tracked IDs.
 * - Post-test counter assertions: afterCount === beforeCount across all tables.
 * - Zero external API calls (100% mock/stub).
 */

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import jwt from 'jsonwebtoken'
import { pool, query } from './db.js'

const JWT_SECRET = process.env.JWT_SECRET || 'changeme-in-production'
const token = jwt.sign(
  { id: 1, username: 'admin', role: 'admin', department: 'Yönetim' },
  JWT_SECRET,
  { expiresIn: '1h' }
)

const BASE_URL = 'http://127.0.0.1:3000/api'

// Test environment secrets for mock verification
const TEST_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'decco_wa_verify_token_2026'
const TEST_APP_SECRET = process.env.WHATSAPP_APP_SECRET || 'decco_wa_app_secret_2026'


async function authRequest(path, options = {}) {
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...(options.headers || {})
  }
  const body = options.body && typeof options.body === 'object' ? JSON.stringify(options.body) : options.body
  const res = await fetch(`${BASE_URL}${path}`, { ...options, headers, body })
  const text = await res.text()
  let data = null
  try { data = JSON.parse(text) } catch { data = text }
  return { status: res.status, headers: res.headers, body: data, rawText: text }
}

async function webhookRequest(method, path, options = {}) {
  const headers = { ...(options.headers || {}) }
  const body = options.body !== undefined ? options.body : undefined
  const res = await fetch(`${BASE_URL}${path}`, { method, headers, body })
  const text = await res.text()
  let data = null
  try { data = JSON.parse(text) } catch { data = text }
  return { status: res.status, headers: res.headers, body: data, rawText: text }
}

function signPayload(rawBodyStr, secret) {
  const hmac = crypto.createHmac('sha256', secret).update(Buffer.from(rawBodyStr, 'utf8')).digest('hex')
  return `sha256=${hmac}`
}

async function runTests() {
  console.log('--- Starting WhatsApp Foundation Automated Tests ---')

  const testRunId = 'test_wa_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex')
  console.log(`[Test Isolation] testRunId: ${testRunId}`)

  // Explicit tracking arrays
  const trackedCustomerIds = []
  const trackedOrderIds = []
  const trackedEventIds = []
  const trackedMessageIds = []
  const trackedRefs = [] // { customerId, externalId }

  // 1. Snapshot baseline counts
  const { rows: [{ count: cBaseCustomers }] } = await query('SELECT COUNT(*)::int as count FROM customers')
  const { rows: [{ count: cBaseOrders }] } = await query('SELECT COUNT(*)::int as count FROM orders')
  const { rows: [{ count: cBaseEvents }] } = await query('SELECT COUNT(*)::int as count FROM integration_events')
  const { rows: [{ count: cBaseMessages }] } = await query('SELECT COUNT(*)::int as count FROM whatsapp_messages')
  const { rows: [{ count: cBaseRefs }] } = await query("SELECT COUNT(*)::int as count FROM customer_external_refs WHERE provider = 'whatsapp'")

  console.log('[Baseline Counts]:', {
    customers: cBaseCustomers,
    orders: cBaseOrders,
    events: cBaseEvents,
    messages: cBaseMessages,
    whatsapp_refs: cBaseRefs
  })

  try {
    // =========================================================================
    // SCENARIO 1: Config Endpoint Status & Sanitization
    // =========================================================================
    console.log('\n[Scenario 1] Testing /whatsapp/config endpoint...')
    const cfgRes = await authRequest('/integrations/whatsapp/config')
    assert.equal(cfgRes.status, 200, 'Config endpoint should return 200')
    assert.equal(cfgRes.body.verify_token_configured, true)
    assert.equal(cfgRes.body.app_secret_configured, true)
    assert.equal(typeof cfgRes.body.status_message, 'string')
    assert.equal(cfgRes.body.webhook_path, '/api/webhooks/whatsapp')
    assert.equal(cfgRes.rawText.includes(TEST_VERIFY_TOKEN), false, 'Config MUST NOT leak verify token')
    assert.equal(cfgRes.rawText.includes(TEST_APP_SECRET), false, 'Config MUST NOT leak app secret')
    console.log('✓ Scenario 1 passed: Config returned sanitized booleans without leaking secrets.')

    // =========================================================================
    // SCENARIO 2: Meta Webhook GET Verification Challenge
    // =========================================================================
    console.log('\n[Scenario 2] Testing GET /api/webhooks/whatsapp challenge verification...')
    const testChallenge = 'challenge_random_' + crypto.randomBytes(6).toString('hex')

    // 2a. Valid token & mode
    const getValid = await webhookRequest('GET', `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${TEST_VERIFY_TOKEN}&hub.challenge=${testChallenge}`)
    assert.equal(getValid.status, 200, 'Valid verification should return 200')
    assert.equal(getValid.rawText, testChallenge, 'Valid verification should echo back challenge plain text')

    // 2b. Invalid token
    const getInvalidToken = await webhookRequest('GET', `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong_token&hub.challenge=${testChallenge}`)
    assert.equal(getInvalidToken.status, 403, 'Invalid token should return 403 Forbidden')

    // 2c. Invalid mode
    const getInvalidMode = await webhookRequest('GET', `/webhooks/whatsapp?hub.mode=publish&hub.verify_token=${TEST_VERIFY_TOKEN}&hub.challenge=${testChallenge}`)
    assert.equal(getInvalidMode.status, 403, 'Invalid mode should return 403 Forbidden')
    console.log('✓ Scenario 2 passed: GET challenge verification handles correct/incorrect tokens correctly.')

    // =========================================================================
    // SCENARIO 3: Meta Webhook POST Signature Validation (Fail-Closed)
    // =========================================================================
    console.log('\n[Scenario 3] Testing POST /api/webhooks/whatsapp signature verification...')
    const dummyPayload = JSON.stringify({ object: 'whatsapp_business_account', entry: [] })

    // 3a. Missing signature
    const postNoSig = await webhookRequest('POST', '/webhooks/whatsapp', {
      headers: { 'Content-Type': 'application/json' },
      body: dummyPayload
    })
    assert.equal(postNoSig.status, 401, 'Missing signature should return 401')

    // 3b. Invalid signature
    const postBadSig = await webhookRequest('POST', '/webhooks/whatsapp', {
      headers: {
        'Content-Type': 'application/json',
        'x-hub-signature-256': 'sha256=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
      },
      body: dummyPayload
    })
    assert.equal(postBadSig.status, 401, 'Invalid signature should return 401')

    // 3c. Valid signature
    const validSig = signPayload(dummyPayload, TEST_APP_SECRET)
    const postValidSig = await webhookRequest('POST', '/webhooks/whatsapp', {
      headers: {
        'Content-Type': 'application/json',
        'x-hub-signature-256': validSig
      },
      body: dummyPayload
    })
    assert.equal(postValidSig.status, 200, 'Valid signature should return 200')
    if (postValidSig.body?.event_id) trackedEventIds.push(postValidSig.body.event_id)
    console.log('✓ Scenario 3 passed: POST webhook enforces HMAC-SHA256 signature.')

    // =========================================================================
    // SCENARIO 4: Multi-Message Ingestion & Text Normalization in Single DB Transaction
    // =========================================================================
    console.log('\n[Scenario 4] Testing multi-message webhook with text & image caption normalizations...')
    const msgId1 = `${testRunId}_msg_1`
    const msgId2 = `${testRunId}_msg_2`
    const waPhone1 = '905331112233'
    const waPhone2 = '905334445566'

    const multiMsgPayloadObj = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA_TEST_ID',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                contacts: [
                  { profile: { name: 'Ahmet Test Müşteri' }, wa_id: waPhone1 },
                  { profile: { name: 'Mehmet Test' }, wa_id: waPhone2 }
                ],
                messages: [
                  {
                    from: waPhone1,
                    id: msgId1,
                    timestamp: '1773345600',
                    type: 'text',
                    text: { body: 'Siparişim ne zaman kargoya verilir?' }
                  },
                  {
                    from: waPhone2,
                    id: msgId2,
                    timestamp: '1773345610',
                    type: 'image',
                    image: { caption: 'Bu modelden var mı elinizde?' }
                  }
                ]
              },
              field: 'messages'
            }
          ]
        }
      ]
    }

    const multiMsgRaw = JSON.stringify(multiMsgPayloadObj)
    const multiMsgSig = signPayload(multiMsgRaw, TEST_APP_SECRET)

    const postMulti = await webhookRequest('POST', '/webhooks/whatsapp', {
      headers: {
        'Content-Type': 'application/json',
        'x-hub-signature-256': multiMsgSig
      },
      body: multiMsgRaw
    })

    assert.equal(postMulti.status, 200, 'Multi message webhook should succeed with 200')
    assert.equal(postMulti.body.event_type, 'messages')
    assert.equal(postMulti.body.messages_received, 2)
    assert.equal(postMulti.body.messages_inserted, 2)
    const multiEventId = postMulti.body.event_id
    assert.ok(multiEventId, 'event_id should be returned')
    trackedEventIds.push(multiEventId)

    // Check records in DB
    const { rows: dbMsgs } = await query(
      `SELECT id, message_id, wa_id, phone, sender_name, message_type, text, integration_event_id
       FROM whatsapp_messages WHERE message_id IN ($1, $2)`,
      [msgId1, msgId2]
    )
    assert.equal(dbMsgs.length, 2, 'Both messages should be inserted in whatsapp_messages table')
    for (const m of dbMsgs) trackedMessageIds.push(m.id)

    const dbMsg1 = dbMsgs.find(m => m.message_id === msgId1)
    assert.equal(dbMsg1.text, 'Siparişim ne zaman kargoya verilir?')
    assert.equal(dbMsg1.sender_name, 'Ahmet Test Müşteri')
    assert.equal(dbMsg1.wa_id, waPhone1)
    assert.equal(dbMsg1.integration_event_id, multiEventId)

    const dbMsg2 = dbMsgs.find(m => m.message_id === msgId2)
    assert.equal(dbMsg2.text, 'Bu modelden var mı elinizde?')
    assert.equal(dbMsg2.sender_name, 'Mehmet Test')
    assert.equal(dbMsg2.message_type, 'image')
    console.log('✓ Scenario 4 passed: Multi-message payload normalized & inserted in single transaction.')

    // =========================================================================
    // SCENARIO 5: Idempotency on Duplicate Webhook Delivery
    // =========================================================================
    console.log('\n[Scenario 5] Testing message_id idempotency on duplicate webhook delivery...')
    const postDup = await webhookRequest('POST', '/webhooks/whatsapp', {
      headers: {
        'Content-Type': 'application/json',
        'x-hub-signature-256': multiMsgSig
      },
      body: multiMsgRaw
    })
    assert.equal(postDup.status, 200, 'Duplicate delivery should return 200 OK')
    assert.equal(postDup.body.messages_inserted, 0, 'No duplicate messages should be inserted')

    const { rows: countAfterDup } = await query(
      `SELECT COUNT(*)::int as count FROM whatsapp_messages WHERE message_id IN ($1, $2)`,
      [msgId1, msgId2]
    )
    assert.equal(countAfterDup[0].count, 2, 'Message count must remain exactly 2')
    console.log('✓ Scenario 5 passed: Idempotency works cleanly without inserting duplicate messages.')

    // =========================================================================
    // SCENARIO 6: Statuses Delivery Receipt Webhook (Mutations-Free ACK)
    // =========================================================================
    console.log('\n[Scenario 6] Testing statuses/delivery receipt webhook...')
    const statusPayloadObj = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA_TEST_ID',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                statuses: [
                  { id: 'wamid.status_test_1', status: 'delivered', timestamp: '1773345620', recipient_id: waPhone1 }
                ]
              },
              field: 'messages'
            }
          ]
        }
      ]
    }
    const statusRaw = JSON.stringify(statusPayloadObj)
    const statusSig = signPayload(statusRaw, TEST_APP_SECRET)

    const postStatus = await webhookRequest('POST', '/webhooks/whatsapp', {
      headers: {
        'Content-Type': 'application/json',
        'x-hub-signature-256': statusSig
      },
      body: statusRaw
    })
    assert.equal(postStatus.status, 200, 'Status webhook should return 200')
    assert.equal(postStatus.body.event_type, 'statuses')
    assert.equal(postStatus.body.messages_inserted, 0)
    assert.equal(postStatus.body.statuses_count, 1)
    if (postStatus.body?.event_id) trackedEventIds.push(postStatus.body.event_id)
    console.log('✓ Scenario 6 passed: Delivery receipt status ACKed with zero message/domain mutation.')

    // =========================================================================
    // SCENARIO 7: Customer Matching Rules & Phone Suggestions
    // =========================================================================
    console.log('\n[Scenario 7] Testing customer matching & phone suggestion logic...')

    // Create 1 customer with phone matching waPhone1 (5331112233)
    const { rows: cust1Rows } = await query(
      `INSERT INTO customers (name, phone, channel)
       VALUES ($1, $2, 'whatsapp') RETURNING id`,
      [`${testRunId}_Customer_A`, '0533 111 22 33']
    )
    const customerAId = cust1Rows[0].id
    trackedCustomerIds.push(customerAId)

    // Query messages endpoint
    const listRes1 = await authRequest('/integrations/whatsapp/messages?status=all')
    assert.equal(listRes1.status, 200)

    const item1 = listRes1.body.messages.find(m => m.message_id === msgId1)
    assert.ok(item1, 'Message 1 should be listed')
    assert.equal(item1.match_status, 'suggested', 'waPhone1 should be suggested as it matches Customer A phone')
    assert.equal(item1.suggested_customers.length, 1)
    assert.equal(item1.suggested_customers[0].id, customerAId)

    const item2 = listRes1.body.messages.find(m => m.message_id === msgId2)
    assert.ok(item2, 'Message 2 should be listed')
    assert.equal(item2.match_status, 'unmatched', 'waPhone2 should be unmatched as no customer has this phone')
    console.log('✓ Scenario 7 passed: Customer phone suggestion identified candidate without auto-binding.')

    // =========================================================================
    // SCENARIO 8: Manual match-customer with Idempotency & Conflict Guard
    // =========================================================================
    console.log('\n[Scenario 8] Testing manual match-customer endpoint with 409 conflict guard...')

    // Create Customer B
    const { rows: cust2Rows } = await query(
      `INSERT INTO customers (name, phone, channel)
       VALUES ($1, $2, 'whatsapp') RETURNING id`,
      [`${testRunId}_Customer_B`, '0533 999 88 77']
    )
    const customerBId = cust2Rows[0].id
    trackedCustomerIds.push(customerBId)

    // 8a. Match Message 1 with Customer A -> Success
    const matchRes1 = await authRequest(`/integrations/whatsapp/messages/${dbMsg1.id}/match-customer`, {
      method: 'POST',
      body: { customer_id: customerAId }
    })
    assert.equal(matchRes1.status, 200)
    assert.equal(matchRes1.body.ok, true)
    assert.equal(matchRes1.body.matched, true)
    trackedRefs.push({ customerId: customerAId, externalId: waPhone1 })

    // 8b. Match again with Customer A -> Idempotent success (already_matched: true)
    const matchResRepeat = await authRequest(`/integrations/whatsapp/messages/${dbMsg1.id}/match-customer`, {
      method: 'POST',
      body: { customer_id: customerAId }
    })
    assert.equal(matchResRepeat.status, 200)
    assert.equal(matchResRepeat.body.already_matched, true)

    // 8c. Match with Customer B -> 409 Conflict! (wa_id already bound to Customer A)
    const matchResConflict = await authRequest(`/integrations/whatsapp/messages/${dbMsg1.id}/match-customer`, {
      method: 'POST',
      body: { customer_id: customerBId }
    })
    assert.equal(matchResConflict.status, 409, 'Attempting to match already-bound wa_id to Customer B should 409')
    assert.equal(matchResConflict.body.code, 'conflict_existing_customer_id')

    // Verify Message 1 is now 'matched' in list
    const listRes2 = await authRequest('/integrations/whatsapp/messages?status=matched')
    const item1Matched = listRes2.body.messages.find(m => m.message_id === msgId1)
    assert.ok(item1Matched)
    assert.equal(item1Matched.match_status, 'matched')
    assert.equal(item1Matched.matched_customer.id, customerAId)
    console.log('✓ Scenario 8 passed: match-customer handles first match, idempotent repeat, and 409 conflict.')

    // =========================================================================
    // SCENARIO 9: Order Linking Security & Immutability of integration_events
    // =========================================================================
    console.log('\n[Scenario 9] Testing order linking security guards and immutable ledger...')

    // Create Order for Customer A
    const { rows: ord1Rows } = await query(
      `INSERT INTO orders (customer_id, order_no, total_amount, paid_amount, status)
       VALUES ($1, $2, 2500, 0, 'confirmed') RETURNING id, order_no`,
      [customerAId, `${testRunId}_ORD_A`]
    )
    const orderAId = ord1Rows[0].id
    trackedOrderIds.push(orderAId)

    // Create Order for Customer B
    const { rows: ord2Rows } = await query(
      `INSERT INTO orders (customer_id, order_no, total_amount, paid_amount, status)
       VALUES ($1, $2, 4000, 0, 'confirmed') RETURNING id, order_no`,
      [customerBId, `${testRunId}_ORD_B`]
    )
    const orderBId = ord2Rows[0].id
    trackedOrderIds.push(orderBId)

    // 9a. Try to link Order to unmatched Message 2 -> 422 customer_not_matched
    const linkUnmatched = await authRequest(`/integrations/whatsapp/messages/${dbMsg2.id}/link-order`, {
      method: 'POST',
      body: { order_id: orderAId }
    })
    assert.equal(linkUnmatched.status, 422, 'Cannot link order to unmatched message')
    assert.equal(linkUnmatched.body.code, 'customer_not_matched')

    // 9b. Try to link Customer B's order to Message 1 (matched to Customer A) -> 409 order_customer_mismatch
    const linkMismatch = await authRequest(`/integrations/whatsapp/messages/${dbMsg1.id}/link-order`, {
      method: 'POST',
      body: { order_id: orderBId }
    })
    assert.equal(linkMismatch.status, 409, 'Cannot link other customer order to matched message')
    assert.equal(linkMismatch.body.code, 'order_customer_mismatch')

    // Capture integration_events payload BEFORE linking order
    const { rows: eventBeforeRows } = await query(
      `SELECT payload FROM integration_events WHERE id = $1`,
      [multiEventId]
    )
    const eventPayloadBefore = JSON.stringify(eventBeforeRows[0].payload)

    // 9c. Link Customer A's order to Message 1 -> Success
    const linkSuccess = await authRequest(`/integrations/whatsapp/messages/${dbMsg1.id}/link-order`, {
      method: 'POST',
      body: { order_id: orderAId }
    })
    assert.equal(linkSuccess.status, 200)
    assert.equal(linkSuccess.body.linked, true)
    assert.equal(linkSuccess.body.order_id, orderAId)

    // Verify in DB that whatsapp_messages.order_id was updated
    const { rows: msgCheck } = await query(
      `SELECT order_id FROM whatsapp_messages WHERE id = $1`,
      [dbMsg1.id]
    )
    assert.equal(msgCheck[0].order_id, orderAId)

    // Verify integration_events payload is COMPLETELY UNCHANGED
    const { rows: eventAfterRows } = await query(
      `SELECT payload FROM integration_events WHERE id = $1`,
      [multiEventId]
    )
    const eventPayloadAfter = JSON.stringify(eventAfterRows[0].payload)
    assert.equal(eventPayloadAfter, eventPayloadBefore, 'integration_events payload MUST remain completely immutable!')

    // 9d. Unlink order
    const unlinkRes = await authRequest(`/integrations/whatsapp/messages/${dbMsg1.id}/link-order`, {
      method: 'POST',
      body: { order_id: null }
    })
    assert.equal(unlinkRes.status, 200)
    assert.equal(unlinkRes.body.unlinked, true)
    console.log('✓ Scenario 9 passed: Order linking enforces customer ownership and keeps integration_events immutable.')

    // =========================================================================
    // SCENARIO 10: Canonical Live Payment Status (Unpaid -> Partial -> Paid)
    // =========================================================================
    console.log('\n[Scenario 10] Testing canonical live payment status derivation & re-query reflection...')

    // Link Order A back to Message 1 (total_amount = 2500, paid_amount = 0)
    await authRequest(`/integrations/whatsapp/messages/${dbMsg1.id}/link-order`, {
      method: 'POST',
      body: { order_id: orderAId }
    })

    // 10a. Unpaid status verification
    const listUnpaid = await authRequest('/integrations/whatsapp/messages?status=matched')
    const itemUnpaid = listUnpaid.body.messages.find(m => m.message_id === msgId1)
    assert.ok(itemUnpaid, 'itemUnpaid should be found in matched messages')
    assert.equal(itemUnpaid.order_id, orderAId)
    assert.equal(itemUnpaid.order_status, 'confirmed', 'Operational status must remain intact (orders.status)')
    assert.equal(itemUnpaid.order_payment_status, 'unpaid', 'Unpaid order must have order_payment_status = unpaid')
    assert.equal(parseFloat(itemUnpaid.order_paid_amount || 0), 0)

    // 10b. Partial payment reflection (kapora: e.g. ₺1000 recorded)
    await query('UPDATE orders SET paid_amount = 1000 WHERE id = $1', [orderAId])
    const listPartial = await authRequest('/integrations/whatsapp/messages?status=matched')
    const itemPartial = listPartial.body.messages.find(m => m.message_id === msgId1)
    assert.equal(itemPartial.order_status, 'confirmed', 'Operational status must NOT be modified by payment')
    assert.equal(itemPartial.order_payment_status, 'partial', 'Partial payment must dynamically reflect as partial')
    assert.equal(parseFloat(itemPartial.order_paid_amount), 1000)

    // 10c. Full payment reflection (₺2500 total paid)
    await query('UPDATE orders SET paid_amount = 2500 WHERE id = $1', [orderAId])
    const listPaid = await authRequest('/integrations/whatsapp/messages?status=matched')
    const itemPaid = listPaid.body.messages.find(m => m.message_id === msgId1)
    assert.equal(itemPaid.order_status, 'confirmed', 'Operational status remains confirmed')
    assert.equal(itemPaid.order_payment_status, 'paid', 'Full payment must dynamically reflect as paid')
    assert.equal(parseFloat(itemPaid.order_paid_amount), 2500)
    console.log('✓ Scenario 10 passed: Live canonical payment status reflects unpaid, partial, and paid without mutating whatsapp_messages.')

    // =========================================================================
    // SCENARIO 11: End-to-End Order Creation from WhatsApp & Payment Failure Resiliency
    // =========================================================================
    console.log('\n[Scenario 11] Testing WhatsApp order creation sequence and payment failure resilience...')

    // Find a valid active product
    const { rows: prodRows } = await query('SELECT id, code, base_price FROM products WHERE is_active = true LIMIT 1')
    assert.ok(prodRows.length > 0, 'At least 1 product must exist for testing')
    const testProduct = prodRows[0]

    // Step 1: Create Order with source = 'whatsapp'
    const createOrdRes = await authRequest('/orders', {
      method: 'POST',
      body: {
        customer_id: customerAId,
        source: 'whatsapp',
        notes: 'Sipariş WhatsApp mesajından oluşturuldu',
        delivery_date: '2026-10-20',
        items: [
          {
            product_id: testProduct.id,
            quantity: 2,
            unit_price: parseFloat(testProduct.base_price) || 500,
            personalization: 'DECCO-WA',
            material_selections: { note: 'Kaşmir Yeşil' }
          }
        ]
      }
    })
    assert.equal(createOrdRes.status, 201, 'Order creation should succeed with 201')
    assert.equal(createOrdRes.body.source, 'whatsapp', 'Order source must be whatsapp')
    const createdWaOrderId = createOrdRes.body.id
    trackedOrderIds.push(createdWaOrderId)

    // Step 2: Immediately link order to WhatsApp message
    const linkWaOrdRes = await authRequest(`/integrations/whatsapp/messages/${dbMsg1.id}/link-order`, {
      method: 'POST',
      body: { order_id: createdWaOrderId }
    })
    assert.equal(linkWaOrdRes.status, 200)
    assert.equal(linkWaOrdRes.body.linked, true)
    assert.equal(linkWaOrdRes.body.order_id, createdWaOrderId)

    // Step 3: Verify created order is initially unpaid (ödeme yok -> unpaid)
    const listInitialWa = await authRequest('/integrations/whatsapp/messages?status=matched')
    const itemInitialWa = listInitialWa.body.messages.find(m => m.message_id === msgId1)
    assert.equal(itemInitialWa.order_id, createdWaOrderId)
    assert.equal(itemInitialWa.order_payment_status, 'unpaid', 'Newly created order without payment must be unpaid')

    // Step 4: Simulate payment failure (e.g. invalid account ID 999999)
    const badPayRes = await authRequest(`/orders/${createdWaOrderId}/payments`, {
      method: 'POST',
      body: {
        amount: 100,
        account_id: 999999,
        description: 'Geçersiz hesap testi'
      }
    })
    assert.notEqual(badPayRes.status, 200, 'Invalid payment attempt must fail')

    // Step 5: Verify order remains linked and payment status remains 'unpaid' despite failure
    const listResilient = await authRequest('/integrations/whatsapp/messages?status=matched')
    const itemResilient = listResilient.body.messages.find(m => m.message_id === msgId1)
    assert.equal(itemResilient.order_id, createdWaOrderId, 'Order must remain linked to WhatsApp message even if payment failed')
    assert.equal(itemResilient.order_payment_status, 'unpaid', 'Payment status must remain unpaid after failed payment')

    // Step 6: Verify post-creation payment updates the WhatsApp query dynamically
    // Record a kapora/partial payment directly on this newly linked order
    const orderTotal = parseFloat(createOrdRes.body.total_amount)
    const kaporaAmount = Math.round((orderTotal / 2) * 100) / 100
    await query('UPDATE orders SET paid_amount = $1 WHERE id = $2', [kaporaAmount, createdWaOrderId])

    const listAfterKapora = await authRequest('/integrations/whatsapp/messages?status=matched')
    const itemAfterKapora = listAfterKapora.body.messages.find(m => m.message_id === msgId1)
    assert.equal(itemAfterKapora.order_id, createdWaOrderId)
    assert.equal(itemAfterKapora.order_payment_status, 'partial', 'WhatsApp screen must dynamically reflect kapora on re-query')
    assert.equal(parseFloat(itemAfterKapora.order_paid_amount), kaporaAmount)

    // Complete payment to full
    await query('UPDATE orders SET paid_amount = $1 WHERE id = $2', [orderTotal, createdWaOrderId])
    const listAfterFull = await authRequest('/integrations/whatsapp/messages?status=matched')
    const itemAfterFull = listAfterFull.body.messages.find(m => m.message_id === msgId1)
    assert.equal(itemAfterFull.order_payment_status, 'paid', 'WhatsApp screen must dynamically reflect paid on re-query')
    assert.equal(parseFloat(itemAfterFull.order_paid_amount), orderTotal)

    console.log('✓ Scenario 11 passed: Order creation sequence preserves WhatsApp link even if payment fails; subsequent payments dynamically update WhatsApp screen.')


  } finally {
    // =========================================================================
    // CLEANUP & ISOLATION VERIFICATION
    // =========================================================================
    console.log('\n[Cleanup] Cleaning up tracked test fixtures...')

    // Delete in reverse dependency order
    if (trackedMessageIds.length > 0) {
      await query('DELETE FROM whatsapp_messages WHERE id = ANY($1)', [trackedMessageIds])
    }

    if (trackedRefs.length > 0) {
      for (const r of trackedRefs) {
        await query("DELETE FROM customer_external_refs WHERE provider = 'whatsapp' AND customer_id = $1 AND external_id = $2", [r.customerId, r.externalId])
      }
    }

    if (trackedOrderIds.length > 0) {
      await query('DELETE FROM orders WHERE id = ANY($1)', [trackedOrderIds])
    }

    if (trackedCustomerIds.length > 0) {
      await query('DELETE FROM customers WHERE id = ANY($1)', [trackedCustomerIds])
    }

    if (trackedEventIds.length > 0) {
      await query('DELETE FROM integration_events WHERE id = ANY($1)', [trackedEventIds])
    }

    // Verify after counts equal before counts
    const { rows: [{ count: cAfterCustomers }] } = await query('SELECT COUNT(*)::int as count FROM customers')
    const { rows: [{ count: cAfterOrders }] } = await query('SELECT COUNT(*)::int as count FROM orders')
    const { rows: [{ count: cAfterEvents }] } = await query('SELECT COUNT(*)::int as count FROM integration_events')
    const { rows: [{ count: cAfterMessages }] } = await query('SELECT COUNT(*)::int as count FROM whatsapp_messages')
    const { rows: [{ count: cAfterRefs }] } = await query("SELECT COUNT(*)::int as count FROM customer_external_refs WHERE provider = 'whatsapp'")

    console.log('[Post-Test Counts Verification]:', {
      customers: { before: cBaseCustomers, after: cAfterCustomers },
      orders: { before: cBaseOrders, after: cAfterOrders },
      events: { before: cBaseEvents, after: cAfterEvents },
      messages: { before: cBaseMessages, after: cAfterMessages },
      whatsapp_refs: { before: cBaseRefs, after: cAfterRefs }
    })

    assert.equal(cAfterCustomers, cBaseCustomers, 'Customers count must match baseline!')
    assert.equal(cAfterOrders, cBaseOrders, 'Orders count must match baseline!')
    assert.equal(cAfterEvents, cBaseEvents, 'Integration events count must match baseline!')
    assert.equal(cAfterMessages, cBaseMessages, 'Whatsapp messages count must match baseline!')
    assert.equal(cAfterRefs, cBaseRefs, 'Whatsapp external refs count must match baseline!')

    console.log('✓ Cleanup complete: All tables returned to exact baseline counts.')
  }

  console.log('\n=== ALL WHATSAPP FOUNDATION TESTS COMPLETED SUCCESSFULLY ===')
}

runTests().catch(err => {
  console.error('\n❌ Test failed with error:', err)
  process.exit(1)
})

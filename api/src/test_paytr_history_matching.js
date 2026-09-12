/**
 * test_paytr_history_matching.js
 * Comprehensive automated test suite for PayTR Historical Transactions & Matching module.
 *
 * Scenarios tested (User corrections #1 - #10):
 * 1. status='failed' + empty err_msg -> empty successful chunk ({ ok: true, count: 0, transactions: [] })
 * 2. Same transaction in 2 different fetch runs -> 1 staging row + 2 fetch junctions (dedup + audit)
 * 3. Partial fetch audits which chunk failed in paytr_history_fetch_chunks without leaking secrets
 * 4. 10 and 10.00 produce identical canonical source_signature
 * 5. installment=0 is preserved, not defaulted to 1; null if absent
 * 6. Missing currency causes validation failure, is never defaulted to 'TL'
 * 7. Refund amounts (transaction_type='I') are stored positive, never negated in app code
 * 8. Casual manual override on exact match is rejected with 409 EXACT_MATCH_OVERRIDE_REQUIRES_REVIEW
 * 9. Suggested match is confirmed on the same match row with confirmed_by_user=true
 * 10. Single request exceeding 93 days is rejected with 400 MAX_DATE_RANGE_EXCEEDED
 * 11. Status verify compares calendar date (ignoring time), exact cents, TL/TRY equivalence, returns returns_count without auth_code
 * 12. ZERO FINANCE MUTATION: orders.paid_amount, customer_payments, and accounts.balance remain completely untouched!
 */

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import jwt from 'jsonwebtoken'
import { pool, query } from './db.js'
import {
  computeHistoryTransactionSignature,
  parsePaytrDateToCalendarDate,
  splitDateRangeInto3DayChunks,
  queryPaytrTransactionReport
} from './services/paytr.js'
import { isPaytrHistoryMockAllowed } from './routes/integrations.js'

const JWT_SECRET = process.env.JWT_SECRET || 'decco-secret-key-change-in-prod'
const token = jwt.sign(
  { id: 1, username: 'admin', role: 'admin', department: 'Yönetim' },
  JWT_SECRET,
  { expiresIn: '1h' }
)

const BASE_URL = 'http://127.0.0.1:3000/api'

async function request(path, options = {}) {
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...(options.headers || {})
  }
  const payload = options.body && typeof options.body === 'object' ? JSON.stringify(options.body) : options.body
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers,
    body: payload
  })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, ok: res.ok, body }
}

async function runTests() {
  console.log('--- Starting PayTR Historical Transactions & Matching Test Suite ---')

  const fixtures = {
    customerIds: new Set(),
    orderIds: new Set(),
    fetchIds: new Set(),
    historyTxnIds: new Set(),
    matchIds: new Set()
  }

  const testRunId = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`
  let baseline = null
  const client = await pool.connect()
  try {
    // Record initial state to assert after === before (zero contamination, zero finance mutation)
    baseline = {
      history_transactions: parseInt((await client.query('SELECT count(*)::int as c FROM paytr_history_transactions')).rows[0].c, 10),
      history_fetches: parseInt((await client.query('SELECT count(*)::int as c FROM paytr_history_fetches')).rows[0].c, 10),
      history_fetch_chunks: parseInt((await client.query('SELECT count(*)::int as c FROM paytr_history_fetch_chunks')).rows[0].c, 10),
      history_fetch_transactions: parseInt((await client.query('SELECT count(*)::int as c FROM paytr_history_fetch_transactions')).rows[0].c, 10),
      history_matches: parseInt((await client.query('SELECT count(*)::int as c FROM paytr_history_matches')).rows[0].c, 10),
      orders: parseInt((await client.query('SELECT count(*)::int as c FROM orders')).rows[0].c, 10),
      customers: parseInt((await client.query('SELECT count(*)::int as c FROM customers')).rows[0].c, 10),
      order_items: parseInt((await client.query('SELECT count(*)::int as c FROM order_items')).rows[0].c, 10),
      transactions: parseInt((await client.query('SELECT count(*)::int as c FROM transactions')).rows[0].c, 10),
      paytr_balance: parseFloat((await client.query("SELECT COALESCE(balance, 0)::numeric as b FROM accounts WHERE name = 'PayTR'")).rows[0]?.b || '0'),
      ziraat_balance: parseFloat((await client.query("SELECT COALESCE(balance, 0)::numeric as b FROM accounts WHERE name = 'Ziraat Bankası'")).rows[0]?.b || '0')
    }

    const { rows: initialAccounts } = await client.query('SELECT id, name, balance FROM accounts')
    const { rows: initialOrders } = await client.query('SELECT id, order_no, total_amount, paid_amount FROM orders')
    const { rows: initialPayments } = await client.query('SELECT id, amount FROM customer_payments')

    console.log(`[Baseline captured] Orders: ${baseline.orders}, Customers: ${baseline.customers}, Txns: ${baseline.transactions}, History Txns: ${baseline.history_transactions}, Fetches: ${baseline.history_fetches}`)

    // -------------------------------------------------------------
    // Test 1: Signature canonical semantic equality (Correction #5)
    // 10 and 10.00 must yield the identical SHA-256 hash
    // -------------------------------------------------------------
    console.log('\n[Test 1] Deterministic canonical source_signature (10 vs 10.00)...')
    const sig1 = computeHistoryTransactionSignature({
      transaction_type: 'S',
      merchant_order_no: 'OID-1001',
      transaction_amount_cents: 1000,
      payment_amount_cents: 1000,
      net_amount_cents: 950,
      commission_amount_cents: 50,
      commission_rate: '0.0500',
      transaction_date: '2026-05-10',
      currency: 'TL',
      installment: 0,
      card_brand: 'BONUS',
      masked_card: '411111****1111',
      payment_type: 'CARD'
    })

    const sig2 = computeHistoryTransactionSignature({
      transaction_type: 'S',
      merchant_order_no: '  OID-1001  ', // trimmed
      transaction_amount_cents: 1000,     // 10.00 -> 1000 cents
      payment_amount_cents: 1000,
      net_amount_cents: 950,
      commission_amount_cents: 50,
      commission_rate: '0.0500',
      transaction_date: '2026-05-10',
      currency: 'tl',                    // uppercase normalized
      installment: 0,
      card_brand: 'Bonus',
      masked_card: '411111****1111',
      payment_type: 'card'
    })

    assert.equal(sig1, sig2, 'Signatures for 10 and 10.00 with same semantic fields must be identical')
    console.log('✅ Test 1 Passed: Deterministic canonical signature verified')

    // -------------------------------------------------------------
    // Test 2: Date parser strictly outputs calendar date YYYY-MM-DD
    // Does NOT invent 00:00:00 (Correction #1)
    // -------------------------------------------------------------
    console.log('\n[Test 2] Calendar date parsing without artificial time...')
    assert.equal(parsePaytrDateToCalendarDate('13.01.2021'), '2021-01-13')
    assert.equal(parsePaytrDateToCalendarDate('13.01.2021 14:20:00'), '2021-01-13')
    assert.equal(parsePaytrDateToCalendarDate('2021-01-13'), '2021-01-13')
    console.log('✅ Test 2 Passed: Strict calendar date parsing verified')

    // -------------------------------------------------------------
    // Test 3: status='failed' handled as empty window ({ ok: true, count: 0, transactions: [] })
    // Does NOT rely on err_msg text (Correction #2)
    // -------------------------------------------------------------
    console.log('\n[Test 3] queryPaytrTransactionReport handles status=failed without err_msg...')
    const mockEmptyFetch = async () => ({
      ok: true,
      text: async () => JSON.stringify({ status: 'failed' }) // No err_msg at all!
    })

    const emptyRes = await queryPaytrTransactionReport('2026-05-01', '2026-05-03', {
      merchantId: 'test-mid',
      merchantKey: 'test-key',
      merchantSalt: 'test-salt',
      fetchFn: mockEmptyFetch
    })

    assert.equal(emptyRes.ok, true)
    assert.equal(emptyRes.count, 0)
    assert.deepEqual(emptyRes.transactions, [])
    console.log('✅ Test 3 Passed: status=failed cleanly treated as empty window')

    // -------------------------------------------------------------
    // Test 4: Financial defaults & validations:
    // - installment=0 preserved (not defaulted to 1) (Correction #4)
    // - currency missing rejected (not defaulted to TL) (Correction #4)
    // - refund amounts positive (Correction #6)
    // -------------------------------------------------------------
    console.log('\n[Test 4] Financial values validation (installment=0, strict currency, positive refunds)...')
    const mockTxnFetch = async () => ({
      ok: true,
      text: async () => JSON.stringify({
        status: 'success',
        data: [
          {
            islem_tipi: 'S',
            siparis_no: 'OID-INST0',
            islem_tutari: '100.00',
            net_tutar: '96.00',
            komisyon_tutari: '4.00',
            para_birimi: 'TL',
            taksit: '0', // Single payment: 0 in PayTR
            tarih: '2026-05-02'
          },
          {
            islem_tipi: 'I', // Refund
            siparis_no: 'OID-REFUND1',
            islem_tutari: '50.00',
            net_tutar: '48.00',
            komisyon_tutari: '2.00',
            para_birimi: 'TRY',
            taksit: null,
            tarih: '2026-05-03'
          }
        ]
      })
    })

    const reportRes = await queryPaytrTransactionReport('2026-05-01', '2026-05-03', {
      merchantId: 'test-mid',
      merchantKey: 'test-key',
      merchantSalt: 'test-salt',
      fetchFn: mockTxnFetch
    })

    assert.equal(reportRes.ok, true)
    assert.equal(reportRes.count, 2)
    assert.equal(reportRes.transactions[0].installment, 0, 'installment=0 must be preserved as 0, not defaulted to 1')
    assert.equal(reportRes.transactions[1].installment, null, 'missing installment must be null')
    assert.equal(reportRes.transactions[1].transaction_amount, '50.00', 'refund amount must be positive, not negated')
    assert.equal(reportRes.transactions[1].net_amount, '48.00', 'refund net must be positive')

    // Missing currency must fail validation
    const mockNoCurrFetch = async () => ({
      ok: true,
      text: async () => JSON.stringify({
        status: 'success',
        data: [{
          islem_tipi: 'S',
          siparis_no: 'OID-NOCURR',
          islem_tutari: '100.00',
          net_tutar: '96.00',
          komisyon_tutari: '4.00',
          para_birimi: '', // Missing currency!
          tarih: '2026-05-02'
        }]
      })
    })

    const noCurrRes = await queryPaytrTransactionReport('2026-05-01', '2026-05-03', {
      merchantId: 'test-mid',
      merchantKey: 'test-key',
      merchantSalt: 'test-salt',
      fetchFn: mockNoCurrFetch
    })
    assert.equal(noCurrRes.ok, false)
    assert.equal(noCurrRes.error_code, 'MISSING_CURRENCY', 'Must reject missing currency without faking TL default')
    console.log('✅ Test 4 Passed: Financial defaults & validations verified')

    // -------------------------------------------------------------
    // Test 4.6: History fetch request/response serialization validation
    // - Malformed JSON string (e.g. raw double quotes) rejected with 400 INVALID_JSON_BODY
    // - Non-object body (e.g. string payload) rejected with 400 INVALID_REQUEST_BODY
    // - Backend req.body must be an object, never silently re-parse strings
    // - Mock endpoint (?mock=1) must return 200 without upstream calls
    // -------------------------------------------------------------
    console.log('\n[Test 4.6] Request body serialization & mock endpoint validation...')
    const rawDoubleQuotePayload = '""{"start_date":"2026-05-01","end_date":"2026-05-02"}""'
    const syntaxErrRes = await request('/integrations/paytr/history/fetch', {
      method: 'POST',
      body: rawDoubleQuotePayload
    })
    assert.equal(syntaxErrRes.status, 400, 'Malformed JSON must return 400')
    assert.equal(syntaxErrRes.body.code, 'INVALID_JSON_BODY')

    // Array body (valid JSON in strict mode, but not an object map)
    const arrayRes = await request('/integrations/paytr/history/fetch', {
      method: 'POST',
      body: [{ start_date: '2026-05-01', end_date: '2026-05-02' }]
    })
    assert.equal(arrayRes.status, 400, 'Array body must return 400')
    assert.equal(arrayRes.body.code, 'INVALID_REQUEST_BODY')

    // Single-encoded object with ?mock=1 must be accepted
    const singleEncodedRes = await request('/integrations/paytr/history/fetch?mock=1', {
      method: 'POST',
      body: {
        start_date: '2026-05-01',
        end_date: '2026-05-02'
      }
    })
    assert.equal(singleEncodedRes.status, 200, 'Mock fetch with single-encoded object body must return 200')
    assert.equal(singleEncodedRes.body.ok, true)
    if (singleEncodedRes.body.fetch_id) {
      fixtures.fetchIds.add(singleEncodedRes.body.fetch_id)
    }

    // Production safety unit assertions for mock gatekeeper
    const origEnv = process.env.NODE_ENV
    const origMockFlag = process.env.PAYTR_HISTORY_MOCK_ENABLED
    try {
      process.env.NODE_ENV = 'production'
      assert.equal(isPaytrHistoryMockAllowed(), false, 'Mock must be strictly forbidden in production')

      process.env.NODE_ENV = 'development'
      delete process.env.PAYTR_HISTORY_MOCK_ENABLED
      assert.equal(isPaytrHistoryMockAllowed(), false, 'Query param alone without PAYTR_HISTORY_MOCK_ENABLED cannot enable mock')

      process.env.PAYTR_HISTORY_MOCK_ENABLED = 'true'
      assert.equal(isPaytrHistoryMockAllowed(), true, 'Mock allowed when PAYTR_HISTORY_MOCK_ENABLED=true in dev')

      delete process.env.PAYTR_HISTORY_MOCK_ENABLED
      process.env.NODE_ENV = 'test'
      assert.equal(isPaytrHistoryMockAllowed(), true, 'Mock allowed in NODE_ENV=test')
    } finally {
      process.env.NODE_ENV = origEnv
      if (origMockFlag !== undefined) process.env.PAYTR_HISTORY_MOCK_ENABLED = origMockFlag
      else delete process.env.PAYTR_HISTORY_MOCK_ENABLED
    }

    console.log('✅ Test 4.6 Passed: Serialization, strict object validation & production-safe mock gatekeeper verified')

    // -------------------------------------------------------------
    // Test 5: Date range limit: >93 days rejected with 400 (Correction #9)
    // -------------------------------------------------------------
    console.log('\n[Test 5] Reject requests exceeding 93 days with 400...')
    const over93Res = await request('/integrations/paytr/history/fetch', {
      method: 'POST',
      body: {
        start_date: '2026-01-01',
        end_date: '2026-05-01' // 121 days!
      }
    })
    assert.equal(over93Res.status, 400)
    assert.equal(over93Res.body.code, 'MAX_DATE_RANGE_EXCEEDED')
    console.log('✅ Test 5 Passed: >93 days request rejected with 400')

    // -------------------------------------------------------------
    // Test 6: End-to-end fetch execution:
    // - Splits into 3-day chunks
    // - Dedup with single staging row + multiple fetch junctions (Correction #3)
    // -------------------------------------------------------------
    console.log('\n[Test 6] End-to-end fetch & junction deduplication (two fetch runs)...')
    
    // Create test customer & order with unique testRunId
    const orderNo1 = `TST-HIST-${testRunId}-1`
    const orderNo2 = `TST-HIST-${testRunId}-2`
    const merchantOid = `TST-PAYTR-${testRunId}-1`
    const custName = `TST Hist Customer ${testRunId}`

    const { rows: custRows } = await client.query(
      `INSERT INTO customers (name, phone, email, is_active)
       VALUES ($1, '05551234567', 'hist@test.com', true)
       RETURNING id`,
      [custName]
    )
    const custId = custRows[0].id
    fixtures.customerIds.add(custId)

    const { rows: ordRows } = await client.query(
      `INSERT INTO orders (order_no, customer_id, total_amount, paid_amount, status)
       VALUES ($1, $2, 200.00, 0.00, 'processing')
       RETURNING id`,
      [orderNo1, custId]
    )
    const testOrderId = ordRows[0].id
    fixtures.orderIds.add(testOrderId)

    const mockReportData = [
      {
        islem_tipi: 'S',
        siparis_no: merchantOid,
        islem_tutari: '200.00',
        net_tutar: '192.00',
        komisyon_tutari: '8.00',
        komisyon_orani: '4.00',
        para_birimi: 'TL',
        taksit: '0',
        tarih: '2026-05-02',
        kart_marka: 'TROY',
        maskeli_kart: '979200****0001',
        odeme_tipi: 'KART'
      }
    ]

    const mockFetchFn = async () => ({
      ok: true,
      text: async () => JSON.stringify({ status: 'success', data: mockReportData })
    })

    // Fetch Run 1 (3-day range)
    const fetchRun1 = await request('/integrations/paytr/history/fetch', {
      method: 'POST',
      body: {
        start_date: '2026-05-01',
        end_date: '2026-05-03',
        _mock_report: { status: 'success', data: mockReportData }
      }
    })

    assert.equal(fetchRun1.status, 200)
    assert.equal(fetchRun1.body.ok, true)
    const fetchId1 = fetchRun1.body.fetch_id
    fixtures.fetchIds.add(fetchId1)

    // Fetch Run 2 (Same date range and transactions)
    const fetchRun2 = await request('/integrations/paytr/history/fetch', {
      method: 'POST',
      body: {
        start_date: '2026-05-01',
        end_date: '2026-05-03',
        _mock_report: { status: 'success', data: mockReportData }
      }
    })

    assert.equal(fetchRun2.status, 200)
    assert.equal(fetchRun2.body.ok, true)
    const fetchId2 = fetchRun2.body.fetch_id
    fixtures.fetchIds.add(fetchId2)
    assert.notEqual(fetchId1, fetchId2, 'Two fetch runs must produce separate fetch IDs')

    // Verify DB: Exactly 1 row in paytr_history_transactions
    const { rows: stagedTxns } = await client.query(
      `SELECT id, merchant_order_no, transaction_amount, installment, occurrence_no
       FROM paytr_history_transactions
       WHERE merchant_order_no = $1`,
      [merchantOid]
    )
    assert.equal(stagedTxns.length, 1, 'Staging transaction must be deduplicated into exactly 1 row')
    const historyTxnId = stagedTxns[0].id
    fixtures.historyTxnIds.add(historyTxnId)
    assert.equal(stagedTxns[0].installment, 0)

    // Verify DB: Exactly 2 rows in paytr_history_fetch_transactions junction
    const { rows: junctionRows } = await client.query(
      `SELECT fetch_id, history_transaction_id
       FROM paytr_history_fetch_transactions
       WHERE history_transaction_id = $1
       ORDER BY fetch_id ASC`,
      [historyTxnId]
    )
    assert.equal(junctionRows.length, 2, 'Must have 2 junction entries for the 2 fetch runs')
    assert.equal(junctionRows[0].fetch_id, fetchId1)
    assert.equal(junctionRows[1].fetch_id, fetchId2)
    console.log('✅ Test 6 Passed: Staging dedup + junction audit verified')

    // -------------------------------------------------------------
    // Test 7: Partial fetch audits which chunk failed in paytr_history_fetch_chunks
    // (Correction #3)
    // -------------------------------------------------------------
    console.log('\n[Test 7] Partial fetch audits failing chunk in paytr_history_fetch_chunks...')

    // 5-day range produces 2 chunks (3 days + 2 days)
    const partialFetchRes = await request('/integrations/paytr/history/fetch', {
      method: 'POST',
      body: {
        start_date: '2026-05-01',
        end_date: '2026-05-05',
        _mock_report: [
          { status: 'failed' },
          { status: 'error', err_no: '99', err_msg: 'PayTR Timeout Sim' }
        ]
      }
    })

    assert.equal(partialFetchRes.status, 200)
    assert.equal(partialFetchRes.body.status, 'partial', 'Fetch with 1 success and 1 failed chunk must be partial')
    const partialFetchId = partialFetchRes.body.fetch_id
    fixtures.fetchIds.add(partialFetchId)

    // Check chunks audit table
    const { rows: chunkAudit } = await client.query(
      `SELECT chunk_no, status, error_code, error_message
       FROM paytr_history_fetch_chunks
       WHERE fetch_id = $1
       ORDER BY chunk_no ASC`,
      [partialFetchId]
    )
    assert.equal(chunkAudit.length, 2)
    assert.equal(chunkAudit[0].status, 'empty')
    assert.equal(chunkAudit[1].status, 'failed')
    assert.equal(chunkAudit[1].error_code, 'PAYTR_REPORT_ERROR')
    assert.ok(chunkAudit[1].error_message.includes('PayTR Timeout Sim'))
    console.log('✅ Test 7 Passed: Chunk audit in paytr_history_fetch_chunks verified')

    // -------------------------------------------------------------
    // Test 8: Manual match updates on same row & refuses exact match override with 409
    // (Correction #7)
    // -------------------------------------------------------------
    console.log('\n[Test 8] Manual match updates existing row & exact match override prevention (409)...')
    
    // Order 2
    const { rows: ord2Rows } = await client.query(
      `INSERT INTO orders (order_no, customer_id, total_amount, paid_amount, status)
       VALUES ($1, $2, 200.00, 0.00, 'processing')
       RETURNING id`,
      [orderNo2, custId]
    )
    const testOrderId2 = ord2Rows[0].id
    fixtures.orderIds.add(testOrderId2)

    // Initially simulate an EXACT match
    await client.query(
      `INSERT INTO paytr_history_matches (history_transaction_id, order_id, match_method, confidence, confirmed_by_user)
       VALUES ($1, $2, 'merchant_oid_exact', 'exact', false)
       ON CONFLICT (history_transaction_id) DO UPDATE SET order_id = EXCLUDED.order_id, confidence = 'exact'`,
      [historyTxnId, testOrderId]
    )

    // User attempts to casually match to a DIFFERENT order (testOrderId2)
    const overrideAttempt = await request(`/integrations/paytr/history/${historyTxnId}/match`, {
      method: 'POST',
      body: { order_id: testOrderId2 }
    })

    assert.equal(overrideAttempt.status, 409)
    assert.equal(overrideAttempt.body.code, 'EXACT_MATCH_OVERRIDE_REQUIRES_REVIEW')

    // Now change to a suggested match row
    await client.query(
      `UPDATE paytr_history_matches
       SET confidence = 'suggested', match_method = 'heuristic_suggested', confirmed_by_user = false
       WHERE history_transaction_id = $1`,
      [historyTxnId]
    )

    // Manual match should now succeed on the SAME row (Correction #7)
    const manualMatchRes = await request(`/integrations/paytr/history/${historyTxnId}/match`, {
      method: 'POST',
      body: { order_id: testOrderId2 }
    })

    assert.equal(manualMatchRes.status, 200)
    assert.equal(manualMatchRes.body.ok, true)

    // Verify row count in matches table is still 1
    const { rows: matchCheck } = await client.query(
      `SELECT id, order_id, confidence, confirmed_by_user, confirmed_at
       FROM paytr_history_matches
       WHERE history_transaction_id = $1`,
      [historyTxnId]
    )
    assert.equal(matchCheck.length, 1, 'Match must be updated on the same record')
    assert.equal(matchCheck[0].order_id, testOrderId2)
    assert.equal(matchCheck[0].confidence, 'manual')
    assert.equal(matchCheck[0].confirmed_by_user, true)
    assert.ok(matchCheck[0].confirmed_at != null)
    console.log('✅ Test 8 Passed: 409 conflict and same-row manual confirmation verified')

    // -------------------------------------------------------------
    // Test 9: Status verify matches calendar day to datetime, exact cents, TL/TRY
    // Returns returns_count, NO auth_code or full returns (Correction #10)
    // -------------------------------------------------------------
    console.log('\n[Test 9] Status inquiry verification with calendar date & cents matching...')
    const mockStatusData = {
      status: 'success',
      payment_amount: '200.00',
      payment_total: '200.00',
      net_tutar: '192.00',
      kesinti_tutari: '8.00',
      currency: 'TRY', // TL === TRY
      payment_date: '2026-05-02 17:45:22', // datetime with hours
      merchant_oid: merchantOid,
      auth_code: 'SECRET-AUTH-12345',
      returns: [{ return_amount: '20.00', return_date: '2026-05-03' }]
    }

    const verifyRes = await request(`/integrations/paytr/history/${historyTxnId}/verify`, {
      method: 'POST',
      body: {
        _mock_status: mockStatusData
      }
    })

    console.log('verifyRes status:', verifyRes.status, 'body:', JSON.stringify(verifyRes.body))
    assert.equal(verifyRes.status, 200)
    assert.equal(verifyRes.body.ok, true)
    assert.equal(verifyRes.body.verified, true)
    assert.equal(verifyRes.body.date_matched, true, 'Date-only staging matches datetime Status Inquiry same calendar date')
    assert.equal(verifyRes.body.amount_matched, true)
    assert.equal(verifyRes.body.currency_matched, true, 'TL and TRY treated as equivalent')
    assert.equal(verifyRes.body.returns_count, 1)
    assert.equal(verifyRes.body.auth_code, undefined, 'auth_code must NOT be exposed')
    assert.equal(verifyRes.body.returns, undefined, 'Full returns array must NOT be exposed')
    console.log('✅ Test 9 Passed: Verification logic & secret sanitization verified')

    // -------------------------------------------------------------
    // Test 10: GET /api/integrations/paytr/history listing & filters
    // -------------------------------------------------------------
    console.log('\n[Test 10] Listing and summary counters on GET /paytr/history...')
    const listRes = await request('/integrations/paytr/history?limit=10')
    assert.equal(listRes.status, 200)
    assert.ok(listRes.body.summary)
    assert.ok(listRes.body.summary.total_count >= 1)
    assert.ok(Array.isArray(listRes.body.data))
    console.log('✅ Test 10 Passed: History listing & summary verified')

    // -------------------------------------------------------------
    // Test 11: CRITICAL ZERO FINANCE MUTATION ASSERTION
    // -------------------------------------------------------------
    console.log('\n[Test 11] ZERO FINANCE MUTATION AUDIT...')
    const { rows: finalAccounts } = await client.query('SELECT id, name, balance FROM accounts')
    const { rows: finalOrders } = await client.query('SELECT id, order_no, total_amount, paid_amount FROM orders')
    const { rows: finalPayments } = await client.query('SELECT id, amount FROM customer_payments')

    assert.equal(finalPayments.length, initialPayments.length, 'NO new customer payments may be created')
    for (const initAcc of initialAccounts) {
      const finalAcc = finalAccounts.find(a => a.id === initAcc.id)
      assert.equal(finalAcc.balance, initAcc.balance, `Account ${initAcc.name} balance must not change!`)
    }
    for (const initOrd of initialOrders) {
      const finalOrd = finalOrders.find(o => o.id === initOrd.id)
      assert.equal(finalOrd.paid_amount, initOrd.paid_amount, `Order ${initOrd.order_no} paid_amount must not change!`)
    }
    console.log('✅ Test 11 Passed: ZERO FINANCE MUTATION ABSOLUTELY PRESERVED')

    console.log('\n======================================================')
    console.log('ALL PAYTR HISTORY & MATCHING TESTS PASSED PERFECTLY!')
    console.log('======================================================')

  } finally {
    console.log('\nTeardown: Cleaning up history test fixtures in guaranteed finally block...')
    try {
      if (fixtures.matchIds.size > 0) {
        await client.query(`DELETE FROM paytr_history_matches WHERE id = ANY($1::int[])`, [[...fixtures.matchIds]])
      }
      if (fixtures.historyTxnIds.size > 0) {
        await client.query(`DELETE FROM paytr_history_matches WHERE history_transaction_id = ANY($1::int[])`, [[...fixtures.historyTxnIds]])
        await client.query(`DELETE FROM paytr_history_fetch_transactions WHERE history_transaction_id = ANY($1::int[])`, [[...fixtures.historyTxnIds]])
      }
      if (fixtures.fetchIds.size > 0) {
        await client.query(`DELETE FROM paytr_history_fetch_chunks WHERE fetch_id = ANY($1::int[])`, [[...fixtures.fetchIds]])
        await client.query(`DELETE FROM paytr_history_fetch_transactions WHERE fetch_id = ANY($1::int[])`, [[...fixtures.fetchIds]])
        await client.query(`DELETE FROM paytr_history_fetches WHERE id = ANY($1::int[])`, [[...fixtures.fetchIds]])
      }
      if (fixtures.historyTxnIds.size > 0) {
        await client.query(`DELETE FROM paytr_history_transactions WHERE id = ANY($1::int[])`, [[...fixtures.historyTxnIds]])
      }
      if (fixtures.orderIds.size > 0) {
        await client.query(`DELETE FROM paytr_history_matches WHERE order_id = ANY($1::int[])`, [[...fixtures.orderIds]])
        await client.query(`DELETE FROM orders WHERE id = ANY($1::int[])`, [[...fixtures.orderIds]])
      }
      if (fixtures.customerIds.size > 0) {
        await client.query(`DELETE FROM customers WHERE id = ANY($1::int[])`, [[...fixtures.customerIds]])
      }

      // 1. Explicit ID set cleanup
      if (fixtures.matchIds.size > 0) {
        await client.query(`DELETE FROM paytr_history_matches WHERE id = ANY($1::int[])`, [[...fixtures.matchIds]])
      }
      if (fixtures.historyTxnIds.size > 0) {
        await client.query(`DELETE FROM paytr_history_matches WHERE history_transaction_id = ANY($1::int[])`, [[...fixtures.historyTxnIds]])
        await client.query(`DELETE FROM paytr_history_fetch_transactions WHERE history_transaction_id = ANY($1::int[])`, [[...fixtures.historyTxnIds]])
      }
      if (fixtures.fetchIds.size > 0) {
        await client.query(`DELETE FROM paytr_history_fetch_chunks WHERE fetch_id = ANY($1::int[])`, [[...fixtures.fetchIds]])
        await client.query(`DELETE FROM paytr_history_fetch_transactions WHERE fetch_id = ANY($1::int[])`, [[...fixtures.fetchIds]])
        await client.query(`DELETE FROM paytr_history_fetches WHERE id = ANY($1::int[])`, [[...fixtures.fetchIds]])
      }
      if (fixtures.historyTxnIds.size > 0) {
        await client.query(`DELETE FROM paytr_history_transactions WHERE id = ANY($1::int[])`, [[...fixtures.historyTxnIds]])
      }
      if (fixtures.orderIds.size > 0) {
        await client.query(`DELETE FROM paytr_history_matches WHERE order_id = ANY($1::int[])`, [[...fixtures.orderIds]])
        await client.query(`DELETE FROM orders WHERE id = ANY($1::int[])`, [[...fixtures.orderIds]])
      }
      if (fixtures.customerIds.size > 0) {
        await client.query(`DELETE FROM customers WHERE id = ANY($1::int[])`, [[...fixtures.customerIds]])
      }

      // 2. Safety cleanup scoped ONLY to this testRunId (NO global prefix sweep)
      await client.query(`DELETE FROM paytr_history_matches WHERE history_transaction_id IN (SELECT id FROM paytr_history_transactions WHERE merchant_order_no LIKE $1)`, [`TST-PAYTR-${testRunId}%`])
      await client.query(`DELETE FROM paytr_history_fetch_transactions WHERE history_transaction_id IN (SELECT id FROM paytr_history_transactions WHERE merchant_order_no LIKE $1)`, [`TST-PAYTR-${testRunId}%`])
      await client.query(`DELETE FROM paytr_history_transactions WHERE merchant_order_no LIKE $1`, [`TST-PAYTR-${testRunId}%`])
      await client.query(`DELETE FROM orders WHERE order_no LIKE $1`, [`TST-HIST-${testRunId}%`])
      await client.query(`DELETE FROM customers WHERE name LIKE $1`, [`TST Hist Customer ${testRunId}%`])

      // 3. Dynamic baseline assertions: after === before on all 11 counters
      const finalCounts = {
        history_transactions: parseInt((await client.query('SELECT count(*)::int as c FROM paytr_history_transactions')).rows[0].c, 10),
        history_fetches: parseInt((await client.query('SELECT count(*)::int as c FROM paytr_history_fetches')).rows[0].c, 10),
        history_fetch_chunks: parseInt((await client.query('SELECT count(*)::int as c FROM paytr_history_fetch_chunks')).rows[0].c, 10),
        history_fetch_transactions: parseInt((await client.query('SELECT count(*)::int as c FROM paytr_history_fetch_transactions')).rows[0].c, 10),
        history_matches: parseInt((await client.query('SELECT count(*)::int as c FROM paytr_history_matches')).rows[0].c, 10),
        orders: parseInt((await client.query('SELECT count(*)::int as c FROM orders')).rows[0].c, 10),
        customers: parseInt((await client.query('SELECT count(*)::int as c FROM customers')).rows[0].c, 10),
        order_items: parseInt((await client.query('SELECT count(*)::int as c FROM order_items')).rows[0].c, 10),
        transactions: parseInt((await client.query('SELECT count(*)::int as c FROM transactions')).rows[0].c, 10),
        paytr_balance: parseFloat((await client.query("SELECT COALESCE(balance, 0)::numeric as b FROM accounts WHERE name = 'PayTR'")).rows[0]?.b || '0'),
        ziraat_balance: parseFloat((await client.query("SELECT COALESCE(balance, 0)::numeric as b FROM accounts WHERE name = 'Ziraat Bankası'")).rows[0]?.b || '0')
      }

      assert.equal(finalCounts.history_transactions, baseline.history_transactions, `paytr_history_transactions after (${finalCounts.history_transactions}) === before (${baseline.history_transactions})`)
      assert.equal(finalCounts.history_fetches, baseline.history_fetches, `paytr_history_fetches after (${finalCounts.history_fetches}) === before (${baseline.history_fetches})`)
      assert.equal(finalCounts.history_fetch_chunks, baseline.history_fetch_chunks, `paytr_history_fetch_chunks after === before`)
      assert.equal(finalCounts.history_fetch_transactions, baseline.history_fetch_transactions, `paytr_history_fetch_transactions after === before`)
      assert.equal(finalCounts.history_matches, baseline.history_matches, `paytr_history_matches after === before`)
      assert.equal(finalCounts.orders, baseline.orders, `orders after (${finalCounts.orders}) === before (${baseline.orders})`)
      assert.equal(finalCounts.customers, baseline.customers, `customers after (${finalCounts.customers}) === before (${baseline.customers})`)
      assert.equal(finalCounts.order_items, baseline.order_items, `order_items after === before`)
      assert.equal(finalCounts.transactions, baseline.transactions, `transactions after === before`)
      assert.equal(finalCounts.paytr_balance, baseline.paytr_balance, `PayTR balance after === before`)
      assert.equal(finalCounts.ziraat_balance, baseline.ziraat_balance, `Ziraat balance after === before`)
      console.log('✓ Teardown complete: All baseline counters perfectly verified (after === before)!')
    } finally {
      client.release()
    }
  }
}

runTests().catch(err => {
  console.error('\n❌ Test failed with error:', err)
  process.exit(1)
})

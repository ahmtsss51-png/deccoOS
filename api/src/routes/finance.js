import { Router } from 'express'
import { query, pool } from '../db.js'

const router = Router()

// Ortak çekirdek: müşteri tahsilatı — finance/collections ve orders/:id/payments tarafından kullanılır
export async function applyCustomerPayment(client, { customer_id, account_id, amount, method, paid_at, description, allocations }) {
  const { rows: openOrders } = await client.query(`
    SELECT id, order_no, total_amount, paid_amount, status,
           (total_amount - paid_amount) AS open_amount
    FROM orders
    WHERE customer_id=$1 AND deleted_at IS NULL AND status <> 'cancelled'
      AND paid_amount < total_amount
    ORDER BY order_date ASC, id ASC FOR UPDATE`, [customer_id])

  let allocs = allocations
  if (!allocs || !allocs.length) {
    let remaining = amount
    allocs = []
    for (const o of openOrders) {
      if (remaining <= 0.005) break
      const open = parseFloat(o.open_amount)
      const applying = Math.min(remaining, open)
      allocs.push({ order_id: o.id, amount: applying })
      remaining -= applying
    }
    if (remaining > 0.005) {
      const totalOpen = openOrders.reduce((s, o) => s + parseFloat(o.open_amount), 0)
      throw Object.assign(new Error(`Aşırı ödeme: toplam açık alacak ₺${totalOpen.toFixed(2)}, girilen ₺${amount.toFixed(2)}`), { status: 400 })
    }
  } else {
    const total = allocs.reduce((s, a) => s + parseFloat(a.amount), 0)
    if (total > amount + 0.005) throw Object.assign(new Error('Dağıtım tutarı toplam tutarı aşıyor'), { status: 400 })
  }

  const { rows: cpRows } = await client.query(`
    INSERT INTO customer_payments (customer_id, account_id, amount, method, description, paid_at)
    VALUES ($1,$2,$3,$4,$5,COALESCE($6::timestamptz,NOW())) RETURNING id`,
    [customer_id, account_id, amount, method || null, description || null, paid_at || null])
  const paymentId = cpRows[0].id

  for (const alloc of allocs) {
    const order = openOrders.find(o => o.id === alloc.order_id)
    if (!order) throw Object.assign(new Error('Geçersiz sipariş: ' + alloc.order_id), { status: 400 })
    const applying = parseFloat(alloc.amount)
    if (applying > parseFloat(order.open_amount) + 0.005)
      throw Object.assign(new Error(`Sipariş ${order.order_no || '#' + order.id} için aşırı ödeme`), { status: 400 })

    await client.query('INSERT INTO customer_payment_allocations (payment_id,order_id,amount) VALUES ($1,$2,$3)',
      [paymentId, alloc.order_id, applying])
    await client.query('UPDATE orders SET paid_amount=paid_amount+$1 WHERE id=$2', [applying, alloc.order_id])
    const newPaid = parseFloat(order.paid_amount) + applying
    if (newPaid >= parseFloat(order.total_amount) - 0.005 && ['draft', 'payment_pending'].includes(order.status))
      await client.query("UPDATE orders SET status='confirmed' WHERE id=$1", [alloc.order_id])
    await client.query(`
      INSERT INTO transactions (account_id,amount,transaction_type,reference_type,reference_id,description,transaction_date)
      VALUES ($1,$2,'customer_payment','order',$3,$4,COALESCE($5::timestamptz,NOW()))`,
      [account_id, applying, alloc.order_id, description || null, paid_at || null])
  }

  await client.query('UPDATE accounts SET balance=balance+$1 WHERE id=$2', [amount, account_id])
  return { payment_id: paymentId, allocations: allocs }
}

// Açık alacaklı müşteriler + siparişleri
router.get('/receivables', async (_req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT c.id AS customer_id, c.name AS customer_name, c.phone,
             COUNT(o.id)::int AS order_count,
             COALESCE(SUM(o.total_amount - o.paid_amount),0) AS open_balance,
             JSON_AGG(JSON_BUILD_OBJECT(
               'id', o.id, 'order_no', o.order_no, 'order_date', o.order_date,
               'total_amount', o.total_amount, 'paid_amount', o.paid_amount,
               'open_amount', o.total_amount - o.paid_amount, 'status', o.status
             ) ORDER BY o.order_date ASC, o.id ASC) AS orders
      FROM orders o
      JOIN customers c ON c.id = o.customer_id
      WHERE o.deleted_at IS NULL AND o.status <> 'cancelled'
        AND o.paid_amount < o.total_amount
      GROUP BY c.id ORDER BY open_balance DESC`)
    res.json(rows)
  } catch (e) { next(e) }
})

// Müşteriden tahsilat al (FIFO veya manuel dağıtım)
router.post('/collections', async (req, res, next) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { customer_id, account_id, amount, method, paid_at, description, allocations } = req.body
    if (!customer_id) throw Object.assign(new Error('Müşteri seçilmedi'), { status: 400 })
    if (!account_id) throw Object.assign(new Error('Hesap seçilmedi'), { status: 400 })
    const amt = parseFloat(amount)
    if (!amt || amt <= 0) throw Object.assign(new Error('Geçerli tutar girin'), { status: 400 })
    const result = await applyCustomerPayment(client, { customer_id, account_id, amount: amt, method, paid_at, description, allocations })
    await client.query('COMMIT')
    res.status(201).json(result)
  } catch (e) { await client.query('ROLLBACK'); next(e) }
  finally { client.release() }
})

router.get('/summary', async (_req, res, next) => {
  try {
    const accounts = await query("SELECT SUM(balance) AS total FROM accounts WHERE is_active=TRUE AND account_type != 'founder'")
    const receivable = await query("SELECT SUM(total_amount - paid_amount) AS total FROM orders WHERE deleted_at IS NULL AND status <> 'cancelled' AND paid_amount < total_amount")
    const payable = await query('SELECT SUM(total_debt) AS total FROM suppliers')
    const thisMonth = await query(`
      SELECT
        SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS income,
        SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) AS expense
      FROM transactions
      WHERE DATE_TRUNC('month', transaction_date) = DATE_TRUNC('month', NOW())
    `)
    res.json({
      available_cash: accounts.rows[0].total || 0,
      customer_receivable: receivable.rows[0].total || 0,
      supplier_payable: payable.rows[0].total || 0,
      this_month_income: thisMonth.rows[0].income || 0,
      this_month_expense: thisMonth.rows[0].expense || 0,
    })
  } catch (e) { next(e) }
})

router.get('/accounts', async (_req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM accounts WHERE is_active=TRUE ORDER BY account_type')
    res.json(rows)
  } catch (e) { next(e) }
})

router.post('/accounts', async (req, res, next) => {
  try {
    const { name, account_type, balance } = req.body
    const { rows } = await query(
      'INSERT INTO accounts (name,account_type,balance) VALUES ($1,$2,$3) RETURNING *',
      [name, account_type, balance || 0]
    )
    res.status(201).json(rows[0])
  } catch (e) { next(e) }
})

router.get('/transactions', async (req, res, next) => {
  try {
    const { account_id, limit = 50 } = req.query
    let sql = `
      SELECT t.*, a.name AS account_name
      FROM transactions t JOIN accounts a ON a.id=t.account_id
      WHERE 1=1
    `
    const params = []
    if (account_id) { params.push(account_id); sql += ` AND t.account_id=$${params.length}` }
    params.push(limit)
    sql += ` ORDER BY t.transaction_date DESC LIMIT $${params.length}`
    const { rows } = await query(sql, params)
    res.json(rows)
  } catch (e) { next(e) }
})

// Manuel gider / gelir kaydı
router.post('/transactions', async (req, res, next) => {
  const client = await (await import('../db.js')).pool.connect()
  try {
    await client.query('BEGIN')
    const { account_id, amount, transaction_type, description } = req.body
    await client.query(
      `INSERT INTO transactions (account_id,amount,transaction_type,description)
       VALUES ($1,$2,$3,$4)`,
      [account_id, amount, transaction_type, description]
    )
    await client.query('UPDATE accounts SET balance=balance+$1 WHERE id=$2', [amount, account_id])
    await client.query('COMMIT')
    res.status(201).json({ ok: true })
  } catch (e) { await client.query('ROLLBACK'); next(e) }
  finally { client.release() }
})

// Hesaplar arası transfer
router.post('/transfer', async (req, res, next) => {
  const client = await (await import('../db.js')).pool.connect()
  try {
    await client.query('BEGIN')
    const { from_account_id, to_account_id, amount, description } = req.body
    await client.query(
      `INSERT INTO transactions (account_id,amount,transaction_type,description) VALUES ($1,$2,'transfer_out',$3)`,
      [from_account_id, -amount, description]
    )
    await client.query(
      `INSERT INTO transactions (account_id,amount,transaction_type,description) VALUES ($1,$2,'transfer_in',$3)`,
      [to_account_id, amount, description]
    )
    await client.query('UPDATE accounts SET balance=balance-$1 WHERE id=$2', [amount, from_account_id])
    await client.query('UPDATE accounts SET balance=balance+$1 WHERE id=$2', [amount, to_account_id])
    await client.query('COMMIT')
    res.status(201).json({ ok: true })
  } catch (e) { await client.query('ROLLBACK'); next(e) }
  finally { client.release() }
})

router.put('/accounts/:id', async (req, res, next) => {
  try {
    const { name, account_type, is_active } = req.body
    const { rows } = await query(
      `UPDATE accounts SET name=$1, account_type=$2, is_active=$3 WHERE id=$4 RETURNING *`,
      [name, account_type, is_active !== undefined ? is_active : true, req.params.id]
    )
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (e) { next(e) }
})

export default router

import { Router } from 'express'
import { query } from '../db.js'

const router = Router()

router.get('/summary', async (_req, res, next) => {
  try {
    const accounts = await query("SELECT SUM(balance) AS total FROM accounts WHERE is_active=TRUE AND account_type != 'founder'")
    const receivable = await query("SELECT SUM(total_amount - paid_amount) AS total FROM orders WHERE status NOT IN ('cancelled','completed')")
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

import { Router } from 'express'
import { query, pool } from '../db.js'

const router = Router()

router.get('/', async (req, res, next) => {
  try {
    const { status, customer_id } = req.query
    let sql = `
      SELECT o.*, c.name AS customer_name,
        COUNT(oi.id) AS item_count
      FROM orders o
      JOIN customers c ON c.id = o.customer_id
      LEFT JOIN order_items oi ON oi.order_id = o.id
      WHERE 1=1
    `
    const params = []
    if (status) { params.push(status); sql += ` AND o.status=$${params.length}` }
    if (customer_id) { params.push(customer_id); sql += ` AND o.customer_id=$${params.length}` }
    sql += ' GROUP BY o.id, c.name ORDER BY o.created_at DESC'
    const { rows } = await query(sql, params)
    res.json(rows)
  } catch (e) { next(e) }
})

router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT o.*, c.name AS customer_name
      FROM orders o JOIN customers c ON c.id=o.customer_id
      WHERE o.id=$1
    `, [req.params.id])
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    const items = await query(`
      SELECT oi.*, p.code AS product_code, p.name AS product_name, p.image_url,
        pv.name AS variant_name
      FROM order_items oi
      JOIN products p ON p.id=oi.product_id
      LEFT JOIN product_variants pv ON pv.id=oi.variant_id
      WHERE oi.order_id=$1
    `, [req.params.id])
    res.json({ ...rows[0], items: items.rows })
  } catch (e) { next(e) }
})

router.post('/', async (req, res, next) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { customer_id, source, notes, delivery_date, items } = req.body

    let total = 0
    for (const item of items) {
      total += (item.unit_price - (item.discount || 0)) * item.quantity
    }

    const { rows } = await client.query(
      `INSERT INTO orders (customer_id,source,notes,delivery_date,total_amount)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [customer_id, source, notes, delivery_date, total]
    )
    const order = rows[0]

    for (const item of items) {
      await client.query(
        `INSERT INTO order_items (order_id,product_id,variant_id,quantity,unit_price,discount,material_selections,personalization,notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [order.id, item.product_id, item.variant_id, item.quantity, item.unit_price,
         item.discount || 0, JSON.stringify(item.material_selections || {}),
         item.personalization, item.notes]
      )
    }

    await client.query('COMMIT')
    res.status(201).json(order)
  } catch (e) { await client.query('ROLLBACK'); next(e) }
  finally { client.release() }
})

router.patch('/:id/status', async (req, res, next) => {
  try {
    const { status } = req.body
    const { rows } = await query(
      'UPDATE orders SET status=$1 WHERE id=$2 RETURNING *',
      [status, req.params.id]
    )
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (e) { next(e) }
})

// Ödeme ekle
router.post('/:id/payments', async (req, res, next) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { amount, account_id, description } = req.body

    const { rows: orderRows } = await client.query('SELECT * FROM orders WHERE id=$1', [req.params.id])
    if (!orderRows[0]) return res.status(404).json({ error: 'Not found' })

    await client.query(
      'UPDATE orders SET paid_amount=paid_amount+$1 WHERE id=$2',
      [amount, req.params.id]
    )
    await client.query(
      `INSERT INTO transactions (account_id,amount,transaction_type,reference_type,reference_id,description)
       VALUES ($1,$2,'customer_payment','order',$3,$4)`,
      [account_id, amount, req.params.id, description]
    )
    await client.query('UPDATE accounts SET balance=balance+$1 WHERE id=$2', [amount, account_id])

    await client.query('COMMIT')
    const { rows } = await client.query('SELECT * FROM orders WHERE id=$1', [req.params.id])
    res.json(rows[0])
  } catch (e) { await client.query('ROLLBACK'); next(e) }
  finally { client.release() }
})

export default router

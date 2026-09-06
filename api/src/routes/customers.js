import { Router } from 'express'
import { query } from '../db.js'

const router = Router()

router.get('/', async (_req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT c.*,
        COUNT(o.id) AS order_count,
        COALESCE(SUM(o.total_amount),0) AS total_ordered,
        COALESCE(SUM(o.paid_amount),0) AS total_paid
      FROM customers c
      LEFT JOIN orders o ON o.customer_id = c.id
      GROUP BY c.id
      ORDER BY c.created_at DESC
    `)
    res.json(rows)
  } catch (e) { next(e) }
})

router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM customers WHERE id=$1', [req.params.id])
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    const orders = await query('SELECT * FROM orders WHERE customer_id=$1 ORDER BY created_at DESC', [req.params.id])
    res.json({ ...rows[0], orders: orders.rows })
  } catch (e) { next(e) }
})

router.post('/', async (req, res, next) => {
  try {
    const { name, phone, channel, notes } = req.body
    const { rows } = await query(
      'INSERT INTO customers (name,phone,channel,notes) VALUES ($1,$2,$3,$4) RETURNING *',
      [name, phone, channel, notes]
    )
    res.status(201).json(rows[0])
  } catch (e) { next(e) }
})

router.put('/:id', async (req, res, next) => {
  try {
    const { name, phone, channel, notes } = req.body
    const { rows } = await query(
      'UPDATE customers SET name=$1,phone=$2,channel=$3,notes=$4 WHERE id=$5 RETURNING *',
      [name, phone, channel, notes, req.params.id]
    )
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (e) { next(e) }
})

export default router

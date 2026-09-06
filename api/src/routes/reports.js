import { Router } from 'express'
import { query } from '../db.js'

const router = Router()

router.get('/product-sales', async (req, res, next) => {
  try {
    const days = parseInt(req.query.days) || 30
    const { rows } = await query(`
      SELECT
        p.code AS product_code, p.name AS product_name,
        COUNT(DISTINCT oi.order_id) AS order_count,
        SUM(oi.quantity) AS total_qty,
        SUM(oi.quantity * oi.unit_price) AS total_revenue,
        AVG(oi.unit_price) AS avg_price
      FROM order_items oi
      JOIN products p ON p.id = oi.product_id
      JOIN orders o ON o.id = oi.order_id
      WHERE o.created_at >= NOW() - INTERVAL '1 day' * $1
        AND o.status NOT IN ('cancelled')
      GROUP BY p.id, p.code, p.name
      ORDER BY total_revenue DESC
    `, [days])
    res.json(rows)
  } catch (e) { next(e) }
})

router.get('/top-customers', async (req, res, next) => {
  try {
    const days = parseInt(req.query.days) || 30
    const { rows } = await query(`
      SELECT
        c.id, c.name, c.channel,
        COUNT(o.id) AS order_count,
        SUM(o.total_amount) AS total_spent,
        MAX(o.created_at) AS last_order
      FROM customers c
      JOIN orders o ON o.customer_id = c.id
      WHERE o.created_at >= NOW() - INTERVAL '1 day' * $1
        AND o.status NOT IN ('cancelled')
      GROUP BY c.id, c.name, c.channel
      ORDER BY total_spent DESC
      LIMIT 20
    `, [days])
    res.json(rows)
  } catch (e) { next(e) }
})

router.get('/summary', async (req, res, next) => {
  try {
    const days = parseInt(req.query.days) || 30
    const [orders, production, customers, stock] = await Promise.all([
      query(`SELECT COUNT(*) AS cnt, SUM(total_amount) AS total FROM orders WHERE created_at >= NOW() - INTERVAL '1 day' * $1 AND status != 'cancelled'`, [days]),
      query(`SELECT COUNT(*) AS cnt FROM production_jobs WHERE status='completed' AND created_at >= NOW() - INTERVAL '1 day' * $1`, [days]),
      query(`SELECT COUNT(*) AS cnt FROM customers WHERE created_at >= NOW() - INTERVAL '1 day' * $1`, [days]),
      query(`SELECT COUNT(*) AS critical FROM materials WHERE is_active=TRUE AND current_stock <= COALESCE(reorder_level, 0)`),
    ])
    res.json({
      order_count: orders.rows[0].cnt,
      total_sales: orders.rows[0].total || 0,
      produced_count: production.rows[0].cnt,
      new_customers: customers.rows[0].cnt,
      critical_stock: stock.rows[0].critical,
    })
  } catch (e) { next(e) }
})

export default router

import { Router } from 'express'
import { query } from '../db.js'

const router = Router()

// CHK-R01/R02: Tüm sorgular order_date / purchase_date / payment date kullanır; created_at yalnız audit
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
      WHERE o.deleted_at IS NULL
        AND o.status NOT IN ('cancelled')
        AND o.order_date >= NOW() - INTERVAL '1 day' * $1
      GROUP BY p.id, p.code, p.name
      ORDER BY total_revenue DESC
    `, [days])
    res.json(rows)
  } catch (e) { next(e) }
})

// CHK-R02/R07: MAX(order_date) for last_order; period filter on order_date
router.get('/top-customers', async (req, res, next) => {
  try {
    const days = parseInt(req.query.days) || 30
    const { rows } = await query(`
      SELECT
        c.id, c.name, c.channel,
        COUNT(o.id) AS order_count,
        SUM(o.total_amount) AS total_spent,
        MAX(o.order_date) AS last_order
      FROM customers c
      JOIN orders o ON o.customer_id = c.id
      WHERE o.deleted_at IS NULL
        AND o.status NOT IN ('cancelled')
        AND o.order_date >= NOW() - INTERVAL '1 day' * $1
      GROUP BY c.id, c.name, c.channel
      ORDER BY total_spent DESC
      LIMIT 20
    `, [days])
    res.json(rows)
  } catch (e) { next(e) }
})

// CHK-R04/R06: Separate sales vs collections; new_customers via first order_date
router.get('/summary', async (req, res, next) => {
  try {
    const days = parseInt(req.query.days) || 30
    const [sales, collections, newCustomers, production] = await Promise.all([
      // Satış = gerçekleşen sipariş tutarı (order_date bazlı)
      query(`SELECT COUNT(*)::int AS cnt, COALESCE(SUM(total_amount),0) AS total
             FROM orders
             WHERE deleted_at IS NULL AND status != 'cancelled'
               AND order_date >= NOW() - INTERVAL '1 day' * $1`, [days]),

      // Tahsilat = kasaya giren customer_payment hareketleri + doğrudan tedarikçiye ödemeler
      query(`SELECT (
               COALESCE((SELECT SUM(amount) FROM transactions
                         WHERE transaction_type = 'customer_payment' AND amount > 0
                           AND transaction_date >= NOW() - INTERVAL '1 day' * $1), 0)
               +
               COALESCE((SELECT SUM(amount) FROM customer_payments
                         WHERE method = 'direct_to_supplier'
                           AND paid_at >= NOW() - INTERVAL '1 day' * $1), 0)
             ) AS total`, [days]),

      // CHK-R06: Yeni müşteri = o dönemde ilk siparişini veren müşteri sayısı
      query(`SELECT COUNT(*)::int AS cnt FROM (
               SELECT customer_id FROM orders WHERE deleted_at IS NULL
               GROUP BY customer_id
               HAVING MIN(order_date) >= NOW() - INTERVAL '1 day' * $1
             ) sub`, [days]),

      // Üretim: completed_at üzerinden (üretim kendi domain tarihi)
      query(`SELECT COUNT(*)::int AS cnt FROM production_jobs
             WHERE status='completed' AND completed_at >= NOW() - INTERVAL '1 day' * $1`, [days]),
    ])
    // FIX-F2: profit=null + profit_status='cogs_missing' (COGS verisi olmadan hesaplanamaz)
    res.json({
      order_count: sales.rows[0].cnt,
      total_sales: sales.rows[0].total,
      total_collections: collections.rows[0].total,
      produced_count: production.rows[0].cnt,
      new_customers: newCustomers.rows[0].cnt,
      profit: null,
      profit_status: 'cogs_missing',
    })
  } catch (e) { next(e) }
})

export default router

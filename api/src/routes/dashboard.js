import { Router } from 'express'
import { query } from '../db.js'

const router = Router()

router.get('/', async (_req, res, next) => {
  try {
    const [
      orderStats,
      financeStats,
      stockStats,
      todayJobs,
      recentOrders,
    ] = await Promise.all([
      // Sipariş durumu sayıları
      query(`
        SELECT
          COUNT(*) FILTER (WHERE status IN ('confirmed','production_pending')) AS waiting_production,
          COUNT(*) FILTER (WHERE status = 'in_production') AS in_production,
          COUNT(*) FILTER (WHERE status = 'ready') AS ready,
          COUNT(*) FILTER (WHERE status NOT IN ('completed','cancelled') AND delivery_date < NOW()) AS overdue,
          COUNT(*) FILTER (WHERE status NOT IN ('completed','cancelled')) AS open_total
        FROM orders
      `),

      // Finans özeti
      query(`
        SELECT
          (SELECT COALESCE(SUM(balance),0) FROM accounts WHERE is_active=TRUE AND account_type != 'founder') AS available_cash,
          -- Teslim edilmiş sipariş de ödenmemiş olabilir; sadece iptaller hariç
          (SELECT COALESCE(SUM(total_amount - paid_amount),0) FROM orders WHERE status <> 'cancelled' AND paid_amount < total_amount) AS customer_receivable,
          (SELECT COALESCE(SUM(total_debt),0) FROM suppliers) AS supplier_payable,
          (SELECT COALESCE(SUM(amount),0) FROM transactions WHERE amount > 0 AND DATE_TRUNC('month', transaction_date) = DATE_TRUNC('month', NOW())) AS this_month_income,
          (SELECT COALESCE(SUM(ABS(amount)),0) FROM transactions WHERE amount < 0 AND DATE_TRUNC('month', transaction_date) = DATE_TRUNC('month', NOW())) AS this_month_expense
      `),

      // Stok özeti
      query(`
        SELECT
          (SELECT COALESCE(SUM(current_stock * avg_cost),0) FROM materials WHERE is_active=TRUE) AS raw_stock_value,
          (SELECT COALESCE(SUM(available_qty),0) FROM production_outputs WHERE available_qty > 0) AS finished_product_count,
          (SELECT COALESCE(SUM(reserved_stock),0) FROM materials WHERE is_active=TRUE) AS reserved_stock_total,
          (SELECT COUNT(*) FROM materials WHERE is_active=TRUE AND reorder_level IS NOT NULL AND (current_stock - reserved_stock) <= reorder_level) AS low_stock_count
      `),

      // Bugünün üretim işleri
      query(`
        SELECT pj.id, pj.status, pj.quantity,
          p.code AS product_code, p.name AS product_name,
          pj.material_selections,
          oi.personalization,
          o.delivery_date
        FROM production_jobs pj
        JOIN products p ON p.id = pj.product_id
        LEFT JOIN order_items oi ON oi.id = pj.order_item_id
        LEFT JOIN orders o ON o.id = oi.order_id
        WHERE pj.status IN ('pending','in_progress')
        ORDER BY o.delivery_date ASC NULLS LAST, pj.created_at ASC
        LIMIT 20
      `),

      // Son siparişler — gerçek sipariş tarihine göre (created_at kayıt anıdır,
      // toplu aktarımda hepsi aynı olduğu için sıralamaya uygun değil)
      query(`
        SELECT o.id, o.order_no, o.status, o.total_amount, o.paid_amount,
          o.order_date, o.delivery_date,
          c.name AS customer_name,
          COUNT(oi.id) AS item_count,
          COALESCE(SUM(oi.quantity),0) AS unit_count
        FROM orders o
        JOIN customers c ON c.id = o.customer_id
        LEFT JOIN order_items oi ON oi.order_id = o.id
        GROUP BY o.id, c.name
        ORDER BY o.order_date DESC NULLS LAST, o.id DESC
        LIMIT 8
      `),
    ])

    res.json({
      orders: orderStats.rows[0],
      finance: financeStats.rows[0],
      stock: stockStats.rows[0],
      today_jobs: todayJobs.rows,
      recent_orders: recentOrders.rows,
    })
  } catch (e) { next(e) }
})

export default router

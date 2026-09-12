import { Router } from 'express'
import { query, pool } from '../db.js'

const router = Router()

router.get('/', async (req, res, next) => {
  try {
    const { q, include_deleted } = req.query
    const params = []
    let sql = `
      SELECT c.*,
        COUNT(o.id) FILTER (WHERE o.deleted_at IS NULL) AS order_count,
        COALESCE(SUM(o.total_amount) FILTER (WHERE o.deleted_at IS NULL),0) AS total_ordered,
        COALESCE(SUM(o.paid_amount)  FILTER (WHERE o.deleted_at IS NULL),0) AS total_paid,
        MAX(o.order_date) FILTER (WHERE o.deleted_at IS NULL) AS last_order_date
      FROM customers c
      LEFT JOIN orders o ON o.customer_id = c.id
      WHERE 1=1
    `
    if (!include_deleted) sql += ' AND c.deleted_at IS NULL'
    if (q) {
      params.push(`%${q}%`)
      sql += ` AND (c.name ILIKE $${params.length} OR c.phone ILIKE $${params.length})`
    }
    sql += ' GROUP BY c.id ORDER BY c.name'
    const { rows } = await query(sql, params)
    res.json(rows)
  } catch (e) { next(e) }
})

router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM customers WHERE id=$1', [req.params.id])
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })

    const orders = await query(`
      SELECT o.*, COUNT(oi.id) AS item_count,
             COALESCE(SUM(oi.quantity),0) AS unit_count
      FROM orders o
      LEFT JOIN order_items oi ON oi.order_id = o.id
      WHERE o.customer_id=$1 AND o.deleted_at IS NULL
      GROUP BY o.id
      ORDER BY o.order_date DESC NULLS LAST, o.id DESC`, [req.params.id])

    // Tahsilat geçmişi: sipariş referanslı hareketler + doğrudan tedarikçiye yapılan ödemeler
    const payments = await query(`
      SELECT * FROM (
        SELECT t.id, t.amount, t.description, t.transaction_date, t.reference_id,
               t.reference_type, a.name AS account_name, o.order_no
        FROM transactions t
        JOIN orders o ON o.id = t.reference_id
        LEFT JOIN accounts a ON a.id = t.account_id
        WHERE t.reference_type IN ('order','order_reversal')
          AND t.transaction_type='customer_payment'
          AND o.customer_id=$1
        UNION ALL
        SELECT cp.id, cpa.amount, cp.description, cp.paid_at AS transaction_date, cpa.order_id AS reference_id,
               'order' AS reference_type, ('Tedarikçiye Doğrudan: ' || COALESCE(s.name, '')) AS account_name, o.order_no
        FROM customer_payments cp
        JOIN customer_payment_allocations cpa ON cpa.payment_id = cp.id
        JOIN orders o ON o.id = cpa.order_id
        LEFT JOIN suppliers s ON s.id = cp.supplier_id
        WHERE cp.method = 'direct_to_supplier'
          AND cp.customer_id = $1
      ) p
      ORDER BY p.transaction_date DESC, p.id DESC`, [req.params.id])

    const stats = await query(`
      SELECT COUNT(*) AS order_count,
             COALESCE(SUM(total_amount),0) AS total_ordered,
             COALESCE(SUM(paid_amount),0)  AS total_paid,
             COALESCE(SUM(total_amount - paid_amount),0) AS open_balance
      FROM orders WHERE customer_id=$1 AND deleted_at IS NULL
        AND status <> 'cancelled'`, [req.params.id])

    res.json({ ...rows[0], orders: orders.rows, payments: payments.rows, stats: stats.rows[0] })
  } catch (e) { next(e) }
})

// FIX-F3: Canonical TR telefon — 0532.../+90532.../0090532... → 5321234567
// Önce tüm non-digit'ler temizlenir; ardından ülke kodu (90) ve baştaki 0 şeritlenir.
// Bu mantık DB sorgusunda da yansıtılır: regexp_replace + LTRIM dönüşümü ile.
export function normalizePhone(raw) {
  if (!raw) return null
  let digits = String(raw).replace(/\D/g, '')
  if (digits.startsWith('0090')) digits = digits.slice(4)
  else if (digits.startsWith('90') && digits.length === 12) digits = digits.slice(2)
  else if (digits.startsWith('0') && digits.length === 11) digits = digits.slice(1)
  if (digits.length < 7) return null
  return digits
}

// DB-side normalization: non-digit sil, ardından öne gelen 90 veya 0 şerit
// Sonuç JS normalizePhone() ile canonical eşdeğer olur.
export const PHONE_CANON_SQL = `
  regexp_replace(
    regexp_replace(
      regexp_replace(phone, '[^0-9]', '', 'g'),
      '^0090', ''
    ),
    '^(90(?=\\d{10}$)|0(?=\\d{10}$))', ''
  )`

router.post('/', async (req, res, next) => {
  try {
    const { name, phone, channel, notes, city, district, address, email } = req.body
    if (!name?.trim()) return res.status(400).json({ error: 'Ad soyad zorunlu' })

    // FIX-F3: Aynı canonical telefonu olan müşteri kontrolü
    const normalized = normalizePhone(phone)
    if (normalized) {
      const { rows: existing } = await query(`
        SELECT id, name FROM customers
        WHERE deleted_at IS NULL
          AND ${PHONE_CANON_SQL} = $1
        LIMIT 1`, [normalized])
      if (existing[0]) {
        return res.status(409).json({
          error: `Bu telefon numarası zaten kayıtlı: ${existing[0].name}`,
          existing_id: existing[0].id,
          existing_name: existing[0].name,
          duplicate: true,
        })
      }
    }

    const { rows } = await query(
      `INSERT INTO customers (name,phone,channel,notes,city,district,address,email)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [name.trim(), phone || null, channel || null, notes || null,
       city || null, district || null, address || null, email || null]
    )
    res.status(201).json(rows[0])
  } catch (e) { next(e) }
})

// Kısmi güncelleme: yalnızca gönderilen alanlar yazılır.
// Alanı temizlemek için açıkça null gönderilir; hiç göndermemek eski değeri korur.
const EDITABLE = ['name', 'phone', 'channel', 'notes', 'city', 'district', 'address', 'email']

router.put('/:id', async (req, res, next) => {
  try {
    const sets = []
    const params = []
    for (const f of EDITABLE) {
      if (f in req.body) {
        params.push(req.body[f] === '' ? null : req.body[f])
        sets.push(`${f}=$${params.length}`)
      }
    }
    if ('is_active' in req.body) {
      params.push(!!req.body.is_active)
      sets.push(`is_active=$${params.length}`)
      // Yeniden aktifleştirme arşiv kaydını da geri alır
      sets.push(`deleted_at = CASE WHEN $${params.length} THEN NULL ELSE deleted_at END`)
    }
    if (!sets.length) return res.status(400).json({ error: 'Güncellenecek alan yok' })

    params.push(req.params.id)
    const { rows } = await query(
      `UPDATE customers SET ${sets.join(', ')} WHERE id=$${params.length} RETURNING *`, params)
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (e) { next(e) }
})

// Geçmişi yoksa tamamen sil, varsa arşivle. Açık alacağı varsa reddet.
router.delete('/:id', async (req, res, next) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      'SELECT * FROM customers WHERE id=$1 FOR UPDATE', [req.params.id])
    if (!rows[0]) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Not found' })
    }
    if (rows[0].deleted_at) {
      await client.query('ROLLBACK')
      return res.json({ ok: true, already_deleted: true })
    }

    const { rows: agg } = await client.query(`
      SELECT COUNT(*)::int AS all_orders,
             COALESCE(SUM(total_amount - paid_amount)
               FILTER (WHERE deleted_at IS NULL AND status <> 'cancelled'),0) AS open_balance
      FROM orders WHERE customer_id=$1`, [req.params.id])
    const { all_orders, open_balance } = agg[0]

    if (parseFloat(open_balance) > 0.005) {
      await client.query('ROLLBACK')
      return res.status(409).json({
        error: `Açık alacağı olan müşteri silinemez (₺${parseFloat(open_balance).toFixed(2)}). ` +
               'Önce tahsilat alın veya siparişleri iptal edin.' })
    }

    if (all_orders === 0) {
      await client.query('DELETE FROM customers WHERE id=$1', [req.params.id])
      await client.query('COMMIT')
      return res.json({ ok: true, hard_deleted: true })
    }

    await client.query(
      'UPDATE customers SET is_active=FALSE, deleted_at=NOW() WHERE id=$1', [req.params.id])
    await client.query('COMMIT')
    res.json({ ok: true, soft_deleted: true, order_count: all_orders })
  } catch (e) { await client.query('ROLLBACK'); next(e) }
  finally { client.release() }
})

export default router

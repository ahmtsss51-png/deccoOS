import { Router } from 'express'
import { query, pool } from '../db.js'
import { isSystemOpen, assertAccountReady, assertSupplierReady, assertOrderPayable } from '../opening-guard.js'

const router = Router()

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

// Ay şeridi — /:id'den ÖNCE tanımlı olmalı, yoksa 'months' id olarak parse edilir
router.get('/months', async (_req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT TO_CHAR(DATE_TRUNC('month', order_date), 'YYYY-MM') AS month,
             DATE_TRUNC('month', order_date)                     AS month_start,
             COUNT(*)                                            AS order_count,
             COALESCE(SUM(total_amount), 0)                      AS revenue,
             COALESCE(SUM(paid_amount), 0)                       AS collected,
             COALESCE(SUM(total_amount - paid_amount), 0)        AS open_amount
      FROM orders
      WHERE deleted_at IS NULL AND order_date IS NOT NULL
      GROUP BY 1, 2
      ORDER BY 2 DESC
    `)
    res.json(rows)
  } catch (e) { next(e) }
})

router.get('/', async (req, res, next) => {
  try {
    // CHK-O05: payment_status ayrı filtre — unpaid | partial | paid
    const { status, customer_id, month, q, payment_status } = req.query
    if (month && !MONTH_RE.test(month)) {
      return res.status(400).json({ error: 'Geçersiz ay formatı (YYYY-AA bekleniyor)' })
    }
    let sql = `
      SELECT o.*, c.name AS customer_name,
        COUNT(oi.id) AS item_count,
        COALESCE(SUM(oi.quantity), 0) AS unit_count,
        (SELECT p2.code
           || COALESCE(' · ' || (oi2.material_selections->>'note'), '')
           || COALESCE(' · ' || oi2.personalization, '')
         FROM order_items oi2
         JOIN products p2 ON p2.id = oi2.product_id
         WHERE oi2.order_id = o.id
         ORDER BY oi2.id LIMIT 1) AS first_item_summary
      FROM orders o
      JOIN customers c ON c.id = o.customer_id
      LEFT JOIN order_items oi ON oi.order_id = o.id
      WHERE o.deleted_at IS NULL
    `
    const params = []
    if (status) { params.push(status); sql += ` AND o.status=$${params.length}` }
    if (customer_id) { params.push(customer_id); sql += ` AND o.customer_id=$${params.length}` }
    if (month) {
      // Yarı açık aralık — orders_active_idx kullanılabilir kalsın
      params.push(month + '-01')
      sql += ` AND o.order_date >= $${params.length}::date
               AND o.order_date <  ($${params.length}::date + INTERVAL '1 month')`
    }
    if (q) {
      params.push(`%${q}%`)
      sql += ` AND (c.name ILIKE $${params.length} OR o.order_no ILIKE $${params.length})`
    }
    // CHK-O05: Ödeme durumu filtresi
    if (payment_status === 'unpaid')  sql += ' AND o.paid_amount = 0'
    if (payment_status === 'partial') sql += ' AND o.paid_amount > 0 AND o.paid_amount < o.total_amount - 0.005'
    if (payment_status === 'paid')    sql += ' AND o.paid_amount >= o.total_amount - 0.005'
    sql += ' GROUP BY o.id, c.name ORDER BY o.order_date DESC NULLS LAST, o.id DESC'
    const { rows } = await query(sql, params)
    res.json(rows)
  } catch (e) { next(e) }
})

router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT o.*, c.name AS customer_name, c.phone AS customer_phone
      FROM orders o JOIN customers c ON c.id=o.customer_id
      WHERE o.id=$1 AND o.deleted_at IS NULL
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
    // Ödeme geçmişi — ters kayıtlar dahil
    const payments = await query(`
      SELECT t.id, t.amount, t.description, t.transaction_date, t.reference_type,
             a.name AS account_name
      FROM transactions t
      LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.reference_id=$1 AND t.reference_type IN ('order','order_reversal')
      ORDER BY t.transaction_date, t.id
    `, [req.params.id])
    res.json({ ...rows[0], items: items.rows, payments: payments.rows })
  } catch (e) { next(e) }
})

router.post('/', async (req, res, next) => {
  const client = await pool.connect()
  try {
    const { customer_id, source, notes, delivery_date, items } = req.body
    if (!customer_id) return res.status(400).json({ error: 'Müşteri seçilmedi' })
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'Siparişte en az bir ürün olmalı' })
    }

    await client.query('BEGIN')

    let total = 0
    for (const item of items) {
      total += (item.unit_price - (item.discount || 0)) * item.quantity
    }

    const { rows } = await client.query(
      `INSERT INTO orders (customer_id,source,notes,delivery_date,total_amount,order_date)
       VALUES ($1,$2,$3,$4,$5,NOW()) RETURNING *`,
      [customer_id, source, notes, delivery_date || null, total]
    )
    const order = rows[0]

    for (const item of items) {
      await client.query(
        `INSERT INTO order_items (order_id,product_id,variant_id,quantity,unit_price,discount,material_selections,personalization,notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [order.id, item.product_id, item.variant_id || null, item.quantity, item.unit_price,
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
      'UPDATE orders SET status=$1 WHERE id=$2 AND deleted_at IS NULL RETURNING *',
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
    const { amount, account_id, description, payment_method, supplier_id } = req.body
    const isDirectToSupplier = payment_method === 'direct_to_supplier'

    const { rows: orderRows } = await client.query(
      'SELECT * FROM orders WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [req.params.id])
    if (!orderRows[0]) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Not found' })
    }

    const order = orderRows[0]
    const open = parseFloat(order.total_amount) - parseFloat(order.paid_amount)
    const amt = parseFloat(amount)
    if (!(amt > 0)) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'Tutar sıfırdan büyük olmalı' })
    }
    if (amt > open + 0.005) {
      await client.query('ROLLBACK')
      return res.status(400).json({
        error: `Bu siparişin açık tutarı ₺${open.toFixed(2)}; daha fazlası tahsil edilemez` })
    }

    // Historical customer receivable opening guard
    await assertOrderPayable(req.params.id)

    if (isDirectToSupplier) {
      if (!supplier_id) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'Tedarikçi seçilmelidir' })
      }

      // Tedarikçi satırı FOR UPDATE ile kilitlenir (yarış durumu engellenir)
      const { rows: supRows } = await client.query(
        'SELECT * FROM suppliers WHERE id=$1 FOR UPDATE', [supplier_id])
      if (!supRows[0]) {
        await client.query('ROLLBACK')
        return res.status(404).json({ error: 'Tedarikçi bulunamadı' })
      }
      const supplier = supRows[0]
      if (supplier.deleted_at || supplier.is_active === false) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'Seçilen tedarikçi aktif değil' })
      }
      if (supplier.supplier_type !== 'material_supplier') {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'Yalnızca malzeme tedarikçilerine doğrudan ödeme yapılabilir' })
      }

      // Supplier opening payable debt guard
      await assertSupplierReady(supplier_id)

      const supDebt = parseFloat(supplier.total_debt) || 0
      if (amt > supDebt + 0.005) {
        await client.query('ROLLBACK')
        return res.status(400).json({
          error: `Tutar tedarikçinin mevcut borcunu (₺${supDebt.toFixed(2)}) aşamaz` })
      }

      // Müşteri bilgisi
      const { rows: custRows } = await client.query('SELECT name FROM customers WHERE id=$1', [order.customer_id])
      const custName = custRows[0]?.name || 'Müşteri'
      const orderLabel = order.order_no || `#${order.id}`

      // 1. Müşteri alacağı azaltılır (orders.paid_amount)
      await client.query(
        'UPDATE orders SET paid_amount=paid_amount+$1 WHERE id=$2',
        [amt, req.params.id]
      )

      // 2. Müşteri tahsilat kaydı (customer_payments) — account_id NULL
      const cpDesc = description || `Tedarikçiye Doğrudan Ödeme: ${supplier.name}`
      const { rows: cpRows } = await client.query(`
        INSERT INTO customer_payments (customer_id, account_id, supplier_id, amount, method, description)
        VALUES ($1, NULL, $2, $3, 'direct_to_supplier', $4) RETURNING id`,
        [order.customer_id, supplier_id, amt, cpDesc])

      await client.query(`
        INSERT INTO customer_payment_allocations (payment_id, order_id, amount)
        VALUES ($1, $2, $3)`,
        [cpRows[0].id, req.params.id, amt])

      // 3. Tedarikçi ödeme kaydı (supplier_payments) — account_id NULL, payment_type direct_from_customer
      const spDesc = `Müşteri doğrudan ödeme: ${custName} (Sipariş ${orderLabel})${description ? ' - ' + description : ''}`
      await client.query(`
        INSERT INTO supplier_payments (supplier_id, account_id, customer_id, order_id, amount, description, payment_type)
        VALUES ($1, NULL, $2, $3, $4, $5, 'direct_from_customer')`,
        [supplier_id, order.customer_id, req.params.id, amt, spDesc])

      // 4. Tedarikçinin cari borcu azaltılır (suppliers.total_debt)
      await client.query('UPDATE suppliers SET total_debt=total_debt-$1 WHERE id=$2', [amt, supplier_id])

      // Money account ve transactions hareketi OLUŞTURULMAZ!
    } else {
      // Normal nakit / banka akışı
      if (!account_id) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'Hesap seçilmelidir' })
      }
      await assertAccountReady(account_id)

      await client.query(
        'UPDATE orders SET paid_amount=paid_amount+$1 WHERE id=$2',
        [amt, req.params.id]
      )
      await client.query(
        `INSERT INTO transactions (account_id,amount,transaction_type,reference_type,reference_id,description)
         VALUES ($1,$2,'customer_payment','order',$3,$4)`,
        [account_id, amt, req.params.id, description]
      )
      await client.query('UPDATE accounts SET balance=balance+$1 WHERE id=$2', [amt, account_id])

      // customer_payments kaydı
      const { rows: cpRows } = await client.query(`
        INSERT INTO customer_payments (customer_id, account_id, amount, method, description)
        VALUES ($1, $2, $3, 'account', $4) RETURNING id`,
        [order.customer_id, account_id, amt, description || null])
      await client.query(`
        INSERT INTO customer_payment_allocations (payment_id, order_id, amount)
        VALUES ($1, $2, $3)`,
        [cpRows[0].id, req.params.id, amt])
    }

    // Tam ödendiyse sadece ileri yön: draft/payment_pending -> confirmed
    await client.query(`
      UPDATE orders SET status='confirmed'
      WHERE id=$1 AND paid_amount >= total_amount - 0.005
        AND status IN ('draft','payment_pending')`, [req.params.id])

    await client.query('COMMIT')
    const { rows } = await client.query('SELECT * FROM orders WHERE id=$1', [req.params.id])
    res.json(rows[0])
  } catch (e) { await client.query('ROLLBACK'); next(e) }
  finally { client.release() }
})

// Sipariş sil — kayıt silinmez, iptal edilir. Tahsilatı varsa kasadan
// ters kayıtla geri alınır; tarihsel mutabakat bozulmaz.
router.delete('/:id', async (req, res, next) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { reason } = req.body || {}

    const { rows: orderRows } = await client.query(
      'SELECT * FROM orders WHERE id=$1 FOR UPDATE', [req.params.id])
    if (!orderRows[0]) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Not found' })
    }
    const order = orderRows[0]
    if (order.deleted_at) {
      await client.query('ROLLBACK')
      return res.json({ ok: true, already_deleted: true })
    }

    const paid = parseFloat(order.paid_amount) || 0

    // Tahsilatlı sipariş, açılış kilitlenmeden silinemez (kasa henüz gerçek değil)
    if (paid > 0 && !(await isSystemOpen())) {
      await client.query('ROLLBACK')
      return res.status(423).json({
        error: 'Tahsilatı olan sipariş PRE-OPENING modunda silinemez. Önce açılışı kilitleyin.' })
    }

    // Kilitli açılış alacak defterinde geçiyorsa silinemez
    const { rows: inOpening } = await client.query(`
      SELECT 1 FROM opening_lines ol
      JOIN opening_sessions s ON s.id = ol.session_id
      WHERE ol.order_id=$1 AND ol.section='receivable' AND s.locked_at IS NOT NULL`,
      [req.params.id])
    if (inOpening.length) {
      await client.query('ROLLBACK')
      return res.status(409).json({
        error: 'Bu sipariş açılış alacak defterinde; silmek açılış mutabakatını bozar' })
    }

    // Tamamlanmış üretim işi varsa silinemez
    const { rows: jobs } = await client.query(`
      SELECT pj.status, COUNT(*)::int AS n FROM production_jobs pj
      JOIN order_items oi ON oi.id = pj.order_item_id
      WHERE oi.order_id=$1 GROUP BY pj.status`, [req.params.id])
    if (jobs.some(j => ['completed', 'quality_check'].includes(j.status))) {
      await client.query('ROLLBACK')
      return res.status(409).json({
        error: 'Tamamlanmış üretim işi var; önce üretim çıktısını iptal edin' })
    }

    // Tahsilatları hesap bazında ters kaydet
    const { rows: paidByAccount } = await client.query(`
      SELECT account_id, SUM(amount) AS amt FROM transactions
      WHERE reference_type='order' AND reference_id=$1
        AND transaction_type='customer_payment'
      GROUP BY account_id`, [req.params.id])

    let reversed = 0
    for (const p of paidByAccount) {
      const amt = parseFloat(p.amt)
      if (!amt) continue
      await client.query(
        `INSERT INTO transactions (account_id,amount,transaction_type,reference_type,reference_id,description)
         VALUES ($1,$2,'customer_payment','order_reversal',$3,$4)`,
        [p.account_id, -amt, req.params.id,
         `Sipariş silindi — tahsilat iadesi ${order.order_no || '#' + order.id}`])
      await client.query('UPDATE accounts SET balance=balance-$1 WHERE id=$2',
        [amt, p.account_id])
      reversed += amt
    }

    // Bekleyen üretim işlerini iptal et
    await client.query(`
      UPDATE production_jobs SET status='cancelled'
      WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id=$1)
        AND status IN ('pending','in_progress')`, [req.params.id])

    // Kilitlenmemiş açılış oturumunun alacak satırını da temizle,
    // yoksa açılış kontrol listesi silinmiş siparişi saymaya devam eder
    await client.query(`
      DELETE FROM opening_lines ol USING opening_sessions s
      WHERE ol.session_id=s.id AND ol.order_id=$1
        AND ol.section='receivable' AND s.locked_at IS NULL`, [req.params.id])

    await client.query(`
      UPDATE orders SET deleted_at=NOW(), deleted_by=$2, delete_reason=$3,
        status='cancelled', paid_amount=0
      WHERE id=$1`, [req.params.id, req.user?.id ?? null, reason ?? null])

    await client.query('COMMIT')
    res.json({ ok: true, order_id: order.id, reversed_amount: reversed })
  } catch (e) { await client.query('ROLLBACK'); next(e) }
  finally { client.release() }
})

export default router

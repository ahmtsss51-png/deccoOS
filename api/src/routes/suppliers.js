import { Router } from 'express'
import { query, pool } from '../db.js'
import { isSystemOpen, assertSupplierReady, assertAccountReady } from '../opening-guard.js'

const router = Router()

router.get('/', async (_req, res, next) => {
  try {
    const [{ rows }, opening_locked] = await Promise.all([
      query(`SELECT s.*, MAX(p.purchase_date) AS last_purchase_at
             FROM suppliers s
             LEFT JOIN purchases p ON p.supplier_id = s.id
             WHERE s.deleted_at IS NULL AND s.supplier_type = 'material_supplier'
             GROUP BY s.id ORDER BY s.name`),
      isSystemOpen(),
    ])
    res.json({ items: rows, opening_locked })
  } catch (e) { next(e) }
})

router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM suppliers WHERE id=$1 AND supplier_type=$2', [req.params.id, 'material_supplier'])
    if (!rows[0]) return res.status(404).json({ error: 'Tedarikçi bulunamadı' })
    const stats = await query(`
      SELECT COALESCE(SUM(total_amount),0) AS lifetime_purchases,
             MAX(purchase_date) AS last_purchase_at
      FROM purchases WHERE supplier_id=$1`, [req.params.id])
    const payments = await query(
      'SELECT COALESCE(SUM(amount),0) AS lifetime_payments FROM supplier_payments WHERE supplier_id=$1',
      [req.params.id])
    const returns_ = await query(
      'SELECT COALESCE(SUM(total_amount),0) AS lifetime_returns FROM purchase_returns WHERE supplier_id=$1',
      [req.params.id])
    res.json({
      ...rows[0],
      ...stats.rows[0],
      lifetime_payments: payments.rows[0].lifetime_payments,
      lifetime_returns: returns_.rows[0].lifetime_returns,
    })
  } catch (e) { next(e) }
})

router.post('/', async (req, res, next) => {
  try {
    const { name, phone, notes, email, address, tax_no, supplier_type } = req.body
    if (!name?.trim()) return res.status(400).json({ error: 'Ad zorunludur' })
    const type = supplier_type || 'material_supplier'
    if (!['material_supplier', 'service_provider'].includes(type)) {
      return res.status(400).json({ error: 'Geçersiz tedarikçi türü' })
    }
    const { rows } = await query(
      'INSERT INTO suppliers (name,phone,notes,email,address,tax_no,supplier_type) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [name.trim(), phone || null, notes || null, email || null, address || null, tax_no || null, type])
    res.status(201).json(rows[0])
  } catch (e) { next(e) }
})

router.put('/:id', async (req, res, next) => {
  try {
    const { name, phone, notes, email, address, tax_no, supplier_type } = req.body
    const { rows: existing } = await query('SELECT * FROM suppliers WHERE id=$1', [req.params.id])
    if (!existing[0]) return res.status(404).json({ error: 'Tedarikçi bulunamadı' })
    const type = supplier_type || existing[0].supplier_type || 'material_supplier'
    if (!['material_supplier', 'service_provider'].includes(type)) {
      return res.status(400).json({ error: 'Geçersiz tedarikçi türü' })
    }
    const { rows } = await query(
      `UPDATE suppliers SET name=$1,phone=$2,notes=$3,email=$4,address=$5,tax_no=$6,supplier_type=$7 WHERE id=$8 RETURNING *`,
      [name, phone || null, notes || null, email || null, address || null, tax_no || null, type, req.params.id])
    res.json(rows[0])
  } catch (e) { next(e) }
})

router.delete('/:id', async (req, res, next) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query('SELECT * FROM suppliers WHERE id=$1 FOR UPDATE', [req.params.id])
    if (!rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }) }
    if (rows[0].deleted_at) { await client.query('ROLLBACK'); return res.json({ ok: true, already_deleted: true }) }
    if (parseFloat(rows[0].total_debt) > 0.005) {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: `Borcu olan tedarikçi silinemez (₺${parseFloat(rows[0].total_debt).toFixed(2)}). Önce borcu kapatın.` })
    }
    const { rows: pCount } = await client.query('SELECT COUNT(*)::int AS cnt FROM purchases WHERE supplier_id=$1', [req.params.id])
    if (pCount[0].cnt === 0) {
      await client.query('DELETE FROM suppliers WHERE id=$1', [req.params.id])
      await client.query('COMMIT')
      return res.json({ ok: true, hard_deleted: true })
    }
    await client.query('UPDATE suppliers SET is_active=FALSE, deleted_at=NOW() WHERE id=$1', [req.params.id])
    await client.query('COMMIT')
    res.json({ ok: true, soft_deleted: true })
  } catch (e) { await client.query('ROLLBACK'); next(e) }
  finally { client.release() }
})

router.get('/:id/purchases', async (req, res, next) => {
  try {
    const { rows: sup } = await query('SELECT id, supplier_type FROM suppliers WHERE id=$1', [req.params.id])
    if (!sup[0] || sup[0].supplier_type !== 'material_supplier') {
      return res.status(404).json({ error: 'Tedarikçi bulunamadı' })
    }
    const { rows } = await query(
      `SELECT p.*, JSON_AGG(JSON_BUILD_OBJECT('material_id',pl.material_id,'quantity',pl.quantity,'unit_cost',pl.unit_cost,'material_name',m.name,'material_sku',m.sku) ORDER BY pl.id) AS lines
       FROM purchases p
       LEFT JOIN purchase_lines pl ON pl.purchase_id = p.id
       LEFT JOIN materials m ON m.id = pl.material_id
       WHERE p.supplier_id=$1
       GROUP BY p.id ORDER BY p.purchase_date DESC, p.id DESC LIMIT 50`,
      [req.params.id])
    res.json(rows)
  } catch (e) { next(e) }
})

router.get('/:id/historical-purchases', async (req, res, next) => {
  try {
    const { rows: sup } = await query('SELECT id, supplier_type FROM suppliers WHERE id=$1', [req.params.id])
    if (!sup[0] || sup[0].supplier_type !== 'material_supplier') {
      return res.status(404).json({ error: 'Tedarikçi bulunamadı' })
    }
    const { rows } = await query(
      `SELECT * FROM (
        SELECT shp.id, shp.purchase_date::timestamptz AS date, shp.amount,
               '—' AS payment_method,
               shp.external_reference,
               shp.description,
               shp.note,
               'Tarihsel / Ödenmiş' AS status,
               'archive' AS source
        FROM supplier_historical_purchases shp
        WHERE shp.supplier_id = $1
        UNION ALL
        SELECT t.id, t.transaction_date AS date, ABS(t.amount) AS amount,
               a.name AS payment_method,
               NULL::varchar AS external_reference,
               t.description,
               NULL::text AS note,
               'Tarihsel / Ödenmiş' AS status,
               'transaction' AS source
        FROM transactions t
        JOIN accounts a ON t.account_id = a.id
        WHERE t.transaction_type = 'expense'
          AND t.reference_type = 'supplier'
          AND t.reference_id = $1
          AND t.description ILIKE '%Deri & Sarf Malzemesi%'
      ) combined
      ORDER BY date DESC, id DESC`,
      [req.params.id])

    const byYear = {}
    let total = 0
    rows.forEach(r => {
      const yr = new Date(r.date).getFullYear()
      const amt = parseFloat(r.amount || 0)
      total += amt
      byYear[yr] = (byYear[yr] || 0) + amt
    })

    res.json({ items: rows, total, by_year: byYear })
  } catch (e) { next(e) }
})



router.get('/:id/ledger', async (req, res, next) => {
  try {
    const { rows: sup } = await query('SELECT id, supplier_type FROM suppliers WHERE id=$1', [req.params.id])
    if (!sup[0] || sup[0].supplier_type !== 'material_supplier') {
      return res.status(404).json({ error: 'Tedarikçi bulunamadı' })
    }
    const { rows } = await query(`
      SELECT * FROM (
        SELECT p.purchase_date::timestamptz AS date, 'purchase' AS entry_type,
               p.total_amount AS debit, 0 AS credit,
               'Alım' AS description, p.id AS ref_id, p.id AS purchase_id,
               NULL::int AS payment_id, NULL::int AS return_id
        FROM purchases p WHERE p.supplier_id=$1
        UNION ALL
        SELECT sp.paid_at AS date, 'payment' AS entry_type,
               0 AS debit, sp.amount AS credit,
               COALESCE(sp.description,'Ödeme') AS description, sp.id AS ref_id,
               sp.purchase_id, sp.id AS payment_id, NULL::int AS return_id
        FROM supplier_payments sp WHERE sp.supplier_id=$1
        UNION ALL
        SELECT pr.return_date AS date, 'return' AS entry_type,
               0 AS debit, pr.total_amount AS credit,
               COALESCE(pr.notes,'İade') AS description, pr.id AS ref_id,
               pr.purchase_id, NULL::int AS payment_id, pr.id AS return_id
        FROM purchase_returns pr WHERE pr.supplier_id=$1
      ) t ORDER BY date ASC, ref_id ASC`, [req.params.id])
    // Running balance (borç birikimi)
    let balance = 0
    const result = rows.map(r => {
      balance += parseFloat(r.debit) - parseFloat(r.credit)
      return { ...r, running_balance: parseFloat(balance.toFixed(2)) }
    })
    res.json(result)
  } catch (e) { next(e) }
})

// Tedarikçiye ödeme
router.post('/:id/payments', async (req, res, next) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { account_id, amount, description, purchase_id, paid_at } = req.body
    if (!account_id || !amount || parseFloat(amount) <= 0) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'Hesap ve geçerli tutar zorunludur' })
    }
    await assertSupplierReady(req.params.id)
    await assertAccountReady(account_id)
    const { rows: sup } = await client.query('SELECT * FROM suppliers WHERE id=$1 FOR UPDATE', [req.params.id])
    if (!sup[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }) }
    if (sup[0].supplier_type !== 'material_supplier') {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'Yalnızca malzeme tedarikçilerine ödeme yapılabilir' })
    }
    const amt = parseFloat(amount)

    const { rows: sp } = await client.query(`
      INSERT INTO supplier_payments (supplier_id,account_id,purchase_id,amount,description,paid_at)
      VALUES ($1,$2,$3,$4,$5,COALESCE($6::timestamptz,NOW())) RETURNING *`,
      [req.params.id, account_id, purchase_id || null, amt, description || null, paid_at || null])

    await client.query(`
      INSERT INTO transactions (account_id,amount,transaction_type,reference_type,reference_id,description,transaction_date)
      VALUES ($1,$2,'supplier_payment','supplier_payment',$3,$4,COALESCE($5::timestamptz,NOW()))`,
      [account_id, -amt, sp[0].id, description || null, paid_at || null])

    await client.query('UPDATE accounts SET balance=balance-$1 WHERE id=$2', [amt, account_id])
    await client.query('UPDATE suppliers SET total_debt=total_debt-$1 WHERE id=$2', [amt, req.params.id])
    if (purchase_id)
      await client.query('UPDATE purchases SET paid_amount=paid_amount+$1 WHERE id=$2', [amt, purchase_id])

    await client.query('COMMIT')
    res.status(201).json(sp[0])
  } catch (e) { await client.query('ROLLBACK'); next(e) }
  finally { client.release() }
})

// Tedarikçi iade
router.post('/:id/returns', async (req, res, next) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { lines, settlement, account_id, notes, purchase_id, return_date } = req.body
    if (!lines || !lines.length) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'En az 1 malzeme satırı gerekli' })
    }
    if (settlement === 'refund' && !account_id) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'Nakit iadede hesap seçilmeli' })
    }
    await assertSupplierReady(req.params.id)
    if (settlement === 'refund' && account_id) {
      await assertAccountReady(account_id)
    }

    const { rows: sup } = await client.query('SELECT * FROM suppliers WHERE id=$1 FOR UPDATE', [req.params.id])
    if (!sup[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }) }
    if (sup[0].supplier_type !== 'material_supplier') {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'Yalnızca malzeme tedarikçilerine iade yapılabilir' })
    }

    // CHK-T04: purchase_id verilmişse iade satırlarını purchase_lines ile doğrula
    if (purchase_id) {
      const { rows: pLines } = await client.query(
        `SELECT pl.material_id, pl.quantity AS orig_qty, pl.unit_cost,
                COALESCE(SUM(prl.quantity),0) AS already_returned
         FROM purchase_lines pl
         LEFT JOIN purchase_return_lines prl ON prl.return_id IN (
           SELECT id FROM purchase_returns WHERE purchase_id=$1
         ) AND prl.material_id = pl.material_id
         WHERE pl.purchase_id=$1
         GROUP BY pl.material_id, pl.quantity, pl.unit_cost`, [purchase_id])
      for (const l of lines) {
        const pl = pLines.find(p => String(p.material_id) === String(l.material_id))
        if (!pl) {
          await client.query('ROLLBACK')
          return res.status(400).json({ error: `Malzeme ${l.material_id} bu alımda bulunmuyor` })
        }
        const maxReturnable = parseFloat(pl.orig_qty) - parseFloat(pl.already_returned)
        if (parseFloat(l.quantity) > maxReturnable + 0.001) {
          await client.query('ROLLBACK')
          return res.status(400).json({ error: `Malzeme ${l.material_id}: iade edilebilir maks ${maxReturnable.toFixed(4)} birim` })
        }
        // CHK-T04: Orijinal alım maliyetini kullan
        l.unit_cost = parseFloat(pl.unit_cost)
      }
    }

    let total = 0
    for (const l of lines) total += parseFloat(l.quantity) * parseFloat(l.unit_cost)

    const { rows: pr } = await client.query(`
      INSERT INTO purchase_returns (supplier_id,purchase_id,total_amount,settlement,account_id,notes,return_date)
      VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz,NOW())) RETURNING *`,
      [req.params.id, purchase_id || null, total, settlement || 'debt', account_id || null, notes || null, return_date || null])

    for (const l of lines) {
      const qty = parseFloat(l.quantity)
      // Stok yeterlilik kontrolü
      const { rows: mat } = await client.query('SELECT current_stock FROM materials WHERE id=$1', [l.material_id])
      if (!mat[0] || parseFloat(mat[0].current_stock) < qty - 0.001) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: `Yeterli stok yok (malzeme ${l.material_id})` })
      }
      await client.query(
        'INSERT INTO purchase_return_lines (return_id,material_id,quantity,unit_cost) VALUES ($1,$2,$3,$4)',
        [pr[0].id, l.material_id, qty, l.unit_cost])
      // avg_cost değişmez, sadece stok düşer
      await client.query('UPDATE materials SET current_stock=current_stock-$1 WHERE id=$2', [qty, l.material_id])
      await client.query(`
        INSERT INTO stock_movements (material_id,movement_type,quantity,unit_cost,reference_type,reference_id)
        VALUES ($1,'return_out',$2,$3,'purchase_return',$4)`,
        [l.material_id, qty, l.unit_cost, pr[0].id])
    }

    if (settlement === 'debt') {
      await client.query('UPDATE suppliers SET total_debt=total_debt-$1 WHERE id=$2', [total, req.params.id])
    } else {
      // Nakit geri
      await client.query(`
        INSERT INTO transactions (account_id,amount,transaction_type,reference_type,reference_id,description)
        VALUES ($1,$2,'supplier_payment','purchase_return',$3,$4)`,
        [account_id, total, pr[0].id, notes || 'İade nakit iadesi'])
      await client.query('UPDATE accounts SET balance=balance+$1 WHERE id=$2', [total, account_id])
    }

    await client.query('COMMIT')
    res.status(201).json(pr[0])
  } catch (e) { await client.query('ROLLBACK'); next(e) }
  finally { client.release() }
})

// Satın alma girişi — CHK-T01 (purchase_date, reference_no), CHK-T02 (atomic)
router.post('/purchases', async (req, res, next) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { supplier_id, lines, paid_amount, account_id, notes, purchase_date, reference_no } = req.body

    if (!lines || !lines.length) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'En az 1 malzeme satırı gerekli' })
    }
    const { rows: sup } = await client.query('SELECT * FROM suppliers WHERE id=$1', [supplier_id])
    if (!sup[0] || sup[0].supplier_type !== 'material_supplier') {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'Satın alma yalnızca malzeme tedarikçileri için oluşturulabilir' })
    }
    await assertSupplierReady(supplier_id)
    if (paid_amount && account_id) {
      await assertAccountReady(account_id)
    }

    const total = lines.reduce((s, l) => s + l.quantity * l.unit_cost, 0)

    const { rows: purchaseRows } = await client.query(
      `INSERT INTO purchases (supplier_id,total_amount,paid_amount,notes,purchase_date,reference_no)
       VALUES ($1,$2,$3,$4,COALESCE($5::timestamptz,NOW()),$6) RETURNING *`,
      [supplier_id, total, paid_amount || 0, notes, purchase_date || null, reference_no || null])
    const purchase = purchaseRows[0]

    for (const line of lines) {
      await client.query(
        'INSERT INTO purchase_lines (purchase_id,material_id,quantity,unit_cost) VALUES ($1,$2,$3,$4)',
        [purchase.id, line.material_id, line.quantity, line.unit_cost])
      await client.query(`
        UPDATE materials SET
          avg_cost = COALESCE((current_stock * avg_cost + $1::numeric * $2::numeric) / NULLIF(current_stock + $1::numeric, 0), avg_cost),
          current_stock = current_stock + $1::numeric
        WHERE id=$3`, [line.quantity, line.unit_cost, line.material_id])
      await client.query(
        `INSERT INTO stock_movements (material_id,movement_type,quantity,unit_cost,reference_type,reference_id)
         VALUES ($1,'purchase_in',$2,$3,'purchase',$4)`,
        [line.material_id, line.quantity, line.unit_cost, purchase.id])
    }

    const debt = total - (paid_amount || 0)
    await client.query('UPDATE suppliers SET total_debt=total_debt+$1 WHERE id=$2', [debt, supplier_id])

    if (paid_amount && account_id) {
      await client.query(
        `INSERT INTO transactions (account_id,amount,transaction_type,reference_type,reference_id)
         VALUES ($1,$2,'supplier_payment','purchase',$3)`,
        [account_id, -paid_amount, purchase.id])
      await client.query('UPDATE accounts SET balance=balance-$1 WHERE id=$2', [paid_amount, account_id])
    }

    await client.query('COMMIT')
    res.status(201).json(purchase)
  } catch (e) { await client.query('ROLLBACK'); next(e) }
  finally { client.release() }
})

// CHK-T06: Tedarikçi iskonto/fiyat düzeltmesi (stoka dokunmaz, yalnız borç azalır)
router.post('/:id/discounts', async (req, res, next) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { amount, purchase_id, notes, discount_date } = req.body
    const amt = parseFloat(amount)
    if (!amt || amt <= 0) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'Geçerli iskonto tutarı zorunludur' })
    }
    await assertSupplierReady(req.params.id)
    const { rows: sup } = await client.query('SELECT * FROM suppliers WHERE id=$1 FOR UPDATE', [req.params.id])
    if (!sup[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }) }
    if (sup[0].supplier_type !== 'material_supplier') {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'Yalnızca malzeme tedarikçilerine iskonto uygulanabilir' })
    }

    const { rows: disc } = await client.query(
      `INSERT INTO supplier_discounts (supplier_id,purchase_id,amount,notes,discount_date)
       VALUES ($1,$2,$3,$4,COALESCE($5::timestamptz,NOW())) RETURNING *`,
      [req.params.id, purchase_id || null, amt, notes || null, discount_date || null])

    // CHK-T06: Stok hareketi yok, hesap hareketi yok — yalnız borç azalır
    await client.query('UPDATE suppliers SET total_debt=total_debt-$1 WHERE id=$2', [amt, req.params.id])
    await client.query('COMMIT')
    res.status(201).json(disc[0])
  } catch (e) { await client.query('ROLLBACK'); next(e) }
  finally { client.release() }
})

// CHK-T06: Ledger'da iskontolar da görünsün
router.get('/:id/discounts', async (req, res, next) => {
  try {
    const { rows } = await query(
      'SELECT * FROM supplier_discounts WHERE supplier_id=$1 ORDER BY discount_date DESC', [req.params.id])
    res.json(rows)
  } catch (e) { next(e) }
})

export default router

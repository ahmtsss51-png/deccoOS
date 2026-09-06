import { Router } from 'express'
import { query, pool } from '../db.js'

const router = Router()

router.get('/', async (_req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM suppliers ORDER BY name')
    res.json(rows)
  } catch (e) { next(e) }
})

router.post('/', async (req, res, next) => {
  try {
    const { name, phone, notes } = req.body
    const { rows } = await query(
      'INSERT INTO suppliers (name,phone,notes) VALUES ($1,$2,$3) RETURNING *',
      [name, phone, notes]
    )
    res.status(201).json(rows[0])
  } catch (e) { next(e) }
})

router.put('/:id', async (req, res, next) => {
  try {
    const { name, phone, notes } = req.body
    const { rows } = await query(
      'UPDATE suppliers SET name=$1, phone=$2, notes=$3 WHERE id=$4 RETURNING *',
      [name, phone, notes, req.params.id]
    )
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (e) { next(e) }
})

router.get('/:id/purchases', async (req, res, next) => {
  try {
    const { rows } = await query(
      'SELECT * FROM purchases WHERE supplier_id=$1 ORDER BY purchase_date DESC, id DESC LIMIT 50',
      [req.params.id]
    )
    res.json(rows)
  } catch (e) { next(e) }
})

// Satın alma girişi
router.post('/purchases', async (req, res, next) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { supplier_id, lines, paid_amount, account_id, notes } = req.body

    const total = lines.reduce((s, l) => s + l.quantity * l.unit_cost, 0)

    const { rows: purchaseRows } = await client.query(
      `INSERT INTO purchases (supplier_id,total_amount,paid_amount,notes)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [supplier_id, total, paid_amount || 0, notes]
    )
    const purchase = purchaseRows[0]

    for (const line of lines) {
      await client.query(
        'INSERT INTO purchase_lines (purchase_id,material_id,quantity,unit_cost) VALUES ($1,$2,$3,$4)',
        [purchase.id, line.material_id, line.quantity, line.unit_cost]
      )
      // Stok + ağırlıklı ortalama maliyet güncelle
      await client.query(`
        UPDATE materials SET
          avg_cost = COALESCE((current_stock * avg_cost + $1 * $2) / NULLIF(current_stock + $1, 0), avg_cost),
          current_stock = current_stock + $1
        WHERE id=$3
      `, [line.quantity, line.unit_cost, line.material_id])
      await client.query(
        `INSERT INTO stock_movements (material_id,movement_type,quantity,unit_cost,reference_type,reference_id)
         VALUES ($1,'purchase_in',$2,$3,'purchase',$4)`,
        [line.material_id, line.quantity, line.unit_cost, purchase.id]
      )
    }

    // Tedarikçi borç güncelle
    const debt = total - (paid_amount || 0)
    await client.query('UPDATE suppliers SET total_debt=total_debt+$1 WHERE id=$2', [debt, supplier_id])

    // Ödeme yapıldıysa kasa düş
    if (paid_amount && account_id) {
      await client.query(
        `INSERT INTO transactions (account_id,amount,transaction_type,reference_type,reference_id)
         VALUES ($1,$2,'supplier_payment','purchase',$3)`,
        [account_id, -paid_amount, purchase.id]
      )
      await client.query('UPDATE accounts SET balance=balance-$1 WHERE id=$2', [paid_amount, account_id])
    }

    await client.query('COMMIT')
    res.status(201).json(purchase)
  } catch (e) { await client.query('ROLLBACK'); next(e) }
  finally { client.release() }
})

export default router

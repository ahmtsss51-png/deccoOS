import { Router } from 'express'
import { query, pool } from '../db.js'

const router = Router()

router.get('/', async (req, res, next) => {
  try {
    const { material_type, low_stock } = req.query
    let sql = 'SELECT * FROM materials WHERE is_active=TRUE'
    const params = []
    if (material_type) { params.push(material_type); sql += ` AND material_type=$${params.length}` }
    if (low_stock === 'true') sql += ' AND current_stock - reserved_stock <= COALESCE(reorder_level, 0)'
    sql += ' ORDER BY material_type, name'
    const { rows } = await query(sql, params)
    res.json(rows)
  } catch (e) { next(e) }
})

router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM materials WHERE id=$1', [req.params.id])
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    const movements = await query(
      'SELECT * FROM stock_movements WHERE material_id=$1 ORDER BY created_at DESC LIMIT 50',
      [req.params.id]
    )
    res.json({ ...rows[0], movements: movements.rows })
  } catch (e) { next(e) }
})

router.post('/', async (req, res, next) => {
  try {
    const { sku, name, family, color, material_type, unit, reorder_level } = req.body
    const { rows } = await query(
      `INSERT INTO materials (sku,name,family,color,material_type,unit,reorder_level)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [sku, name, family, color, material_type, unit, reorder_level]
    )
    res.status(201).json(rows[0])
  } catch (e) { next(e) }
})

// Açılış / düzeltme girişi
router.post('/:id/movements', async (req, res, next) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { movement_type, quantity, unit_cost, notes } = req.body
    const isIn = quantity > 0

    await client.query(
      `INSERT INTO stock_movements (material_id,movement_type,quantity,unit_cost,notes)
       VALUES ($1,$2,$3,$4,$5)`,
      [req.params.id, movement_type, quantity, unit_cost, notes]
    )

    // Ağırlıklı ortalama maliyet güncelle (sadece giriş hareketleri için)
    if (isIn && unit_cost) {
      await client.query(`
        UPDATE materials SET
          avg_cost = (current_stock * avg_cost + $1 * $2) / (current_stock + $1),
          current_stock = current_stock + $1
        WHERE id=$3
      `, [quantity, unit_cost, req.params.id])
    } else {
      await client.query(
        'UPDATE materials SET current_stock=current_stock+$1 WHERE id=$2',
        [quantity, req.params.id]
      )
    }

    await client.query('COMMIT')
    const { rows } = await client.query('SELECT * FROM materials WHERE id=$1', [req.params.id])
    res.json(rows[0])
  } catch (e) { await client.query('ROLLBACK'); next(e) }
  finally { client.release() }
})

// Malzeme sil (pasif yap)
router.delete('/:id', async (req, res, next) => {
  try {
    await query('UPDATE materials SET is_active=FALSE WHERE id=$1', [req.params.id])
    res.json({ ok: true })
  } catch (e) { next(e) }
})

// Malzeme güncelle
router.put('/:id', async (req, res, next) => {
  try {
    const { name, sku, material_type, family, color, unit, reorder_level } = req.body
    const { rows } = await query(
      `UPDATE materials SET name=$1, sku=$2, material_type=$3, family=$4, color=$5, unit=$6, reorder_level=$7 WHERE id=$8 RETURNING *`,
      [name, sku, material_type, family||null, color||null, unit, reorder_level||null, req.params.id]
    )
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (e) { next(e) }
})

export default router

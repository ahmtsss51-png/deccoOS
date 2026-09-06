import { Router } from 'express'
import { query, pool } from '../db.js'

const router = Router()

// Tüm reçeteler (özet)
router.get('/', async (_req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT r.id, r.product_id, r.description, r.updated_at,
        p.code AS product_code, p.name AS product_name,
        COUNT(rl.id) AS line_count,
        SUM(rl.quantity * (1 + rl.waste_rate) * m.avg_cost) AS estimated_cost
      FROM recipes r
      JOIN products p ON p.id = r.product_id
      LEFT JOIN recipe_lines rl ON rl.recipe_id = r.id
      LEFT JOIN materials m ON m.id = rl.material_id
      GROUP BY r.id, p.code, p.name
      ORDER BY p.code
    `)
    res.json(rows)
  } catch (e) { next(e) }
})

// Reçete detayı (satırlarıyla)
router.get('/:id', async (req, res, next) => {
  try {
    const { rows: rRows } = await query(`
      SELECT r.*, p.code AS product_code, p.name AS product_name
      FROM recipes r JOIN products p ON p.id = r.product_id
      WHERE r.id = $1`, [req.params.id])
    if (!rRows[0]) return res.status(404).json({ error: 'Not found' })

    const { rows: lines } = await query(`
      SELECT rl.*, m.name AS material_name, m.sku, m.unit AS material_unit, m.avg_cost
      FROM recipe_lines rl JOIN materials m ON m.id = rl.material_id
      WHERE rl.recipe_id = $1 ORDER BY rl.id`, [req.params.id])

    res.json({ ...rRows[0], lines })
  } catch (e) { next(e) }
})

// Yeni reçete oluştur
router.post('/', async (req, res, next) => {
  try {
    const { product_id, description } = req.body
    const { rows } = await query(
      `INSERT INTO recipes (product_id, description) VALUES ($1, $2) RETURNING *`,
      [product_id, description || null]
    )
    res.status(201).json(rows[0])
  } catch (e) { next(e) }
})

// Reçete satırlarını toplu güncelle (PUT — idempotent)
router.put('/:id/lines', async (req, res, next) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { lines } = req.body
    const recipeId = req.params.id

    // Mevcut satırları sil
    await client.query('DELETE FROM recipe_lines WHERE recipe_id = $1', [recipeId])

    // Yenileri ekle
    let estimated_cost = 0
    for (const line of lines) {
      const qty = parseFloat(line.quantity) || 1
      const waste = parseFloat(line.waste_rate) || 0
      await client.query(
        `INSERT INTO recipe_lines (recipe_id, material_id, quantity, unit, waste_rate, slot_code)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [recipeId, line.material_id, qty, line.unit || null, waste, line.slot_code || null]
      )
      // Maliyet tahmini: qty * (1+waste) * avg_cost
      const { rows: mRows } = await client.query('SELECT avg_cost FROM materials WHERE id=$1', [line.material_id])
      if (mRows[0]) estimated_cost += qty * (1 + waste) * parseFloat(mRows[0].avg_cost || 0)
    }

    await client.query(
      `UPDATE recipes SET updated_at = NOW(), estimated_cost = $1 WHERE id = $2`,
      [estimated_cost.toFixed(2), recipeId]
    )
    await client.query('COMMIT')
    res.json({ ok: true, estimated_cost })
  } catch (e) { await client.query('ROLLBACK'); next(e) }
  finally { client.release() }
})

export default router

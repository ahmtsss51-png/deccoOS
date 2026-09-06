import { Router } from 'express'
import { query } from '../db.js'

const router = Router()

// Hazır ürün stoku — ürün + malzeme konfigürasyonuna göre gruplu
router.get('/finished', async (_req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT
        po.product_id,
        p.code AS product_code,
        p.name AS product_name,
        po.material_config,
        SUM(po.available_qty) AS total_qty,
        AVG(po.unit_cost) AS avg_cost,
        MAX(po.produced_at) AS last_produced
      FROM production_outputs po
      JOIN products p ON p.id = po.product_id
      WHERE po.available_qty > 0
      GROUP BY po.product_id, p.code, p.name, po.material_config
      ORDER BY p.code, last_produced DESC
    `)
    res.json(rows)
  } catch (e) { next(e) }
})

export default router

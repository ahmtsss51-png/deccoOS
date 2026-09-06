import { Router } from 'express'
import { query, pool } from '../db.js'

const router = Router()

router.get('/', async (req, res, next) => {
  try {
    const { status } = req.query
    let sql = `
      SELECT pj.*, p.code AS product_code, p.name AS product_name
      FROM production_jobs pj
      JOIN products p ON p.id=pj.product_id
      WHERE 1=1
    `
    const params = []
    if (status) { params.push(status); sql += ` AND pj.status=$${params.length}` }
    sql += ' ORDER BY pj.created_at DESC'
    const { rows } = await query(sql, params)
    res.json(rows)
  } catch (e) { next(e) }
})

router.post('/', async (req, res, next) => {
  try {
    const { order_item_id, product_id, variant_id, recipe_id, quantity, material_selections, notes } = req.body
    const { rows } = await query(
      `INSERT INTO production_jobs (order_item_id,product_id,variant_id,recipe_id,quantity,material_selections,notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [order_item_id, product_id, variant_id, recipe_id, quantity,
       JSON.stringify(material_selections || {}), notes]
    )
    res.status(201).json(rows[0])
  } catch (e) { next(e) }
})

router.patch('/:id/status', async (req, res, next) => {
  try {
    const { status } = req.body
    const extra = status === 'in_progress' ? ', started_at=NOW()' : status === 'completed' ? ', completed_at=NOW()' : ''
    const { rows } = await query(
      `UPDATE production_jobs SET status=$1${extra} WHERE id=$2 RETURNING *`,
      [status, req.params.id]
    )
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (e) { next(e) }
})

// Üretim tamamla: output oluştur + stok düş
router.post('/:id/complete', async (req, res, next) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { material_config, unit_cost } = req.body

    const { rows: jobRows } = await client.query('SELECT * FROM production_jobs WHERE id=$1', [req.params.id])
    const job = jobRows[0]
    if (!job) return res.status(404).json({ error: 'Not found' })

    // Output oluştur
    const { rows: outputRows } = await client.query(
      `INSERT INTO production_outputs (job_id,product_id,quantity,material_config,unit_cost,available_qty)
       VALUES ($1,$2,$3,$4,$5,$3) RETURNING *`,
      [job.id, job.product_id, job.quantity, JSON.stringify(material_config || {}), unit_cost]
    )

    // Reçete malzemelerini stoktan düş
    if (job.recipe_id) {
      const { rows: lines } = await client.query(
        'SELECT * FROM recipe_lines WHERE recipe_id=$1', [job.recipe_id]
      )
      const selections = job.material_selections || {}
      for (const line of lines) {
        const matId = selections[line.slot_code] || line.material_id
        if (!matId) continue
        const used = line.quantity * job.quantity * (1 + parseFloat(line.waste_rate))
        await client.query(
          'UPDATE materials SET current_stock=current_stock-$1 WHERE id=$2',
          [used, matId]
        )
        await client.query(
          `INSERT INTO stock_movements (material_id,movement_type,quantity,reference_type,reference_id)
           VALUES ($1,'production_out',$2,'production_job',$3)`,
          [matId, -used, job.id]
        )
      }
    }

    // İş durumunu güncelle
    await client.query(
      "UPDATE production_jobs SET status='completed', completed_at=NOW() WHERE id=$1",
      [job.id]
    )

    await client.query('COMMIT')
    res.json(outputRows[0])
  } catch (e) { await client.query('ROLLBACK'); next(e) }
  finally { client.release() }
})

export default router

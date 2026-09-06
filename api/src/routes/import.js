import { Router } from 'express'
import { pool } from '../db.js'

const router = Router()

// Müşteri bulk import
router.post('/customers', async (req, res, next) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows: data } = req.body.data ? { rows: req.body.data } : { rows: [] }
    let imported = 0
    for (const row of data) {
      if (!row.name) continue
      await client.query(
        `INSERT INTO customers (name, phone, channel, notes)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT DO NOTHING`,
        [row.name, row.phone || null, row.channel || null, row.notes || null]
      )
      imported++
    }
    await client.query('COMMIT')
    res.json({ imported })
  } catch (e) { await client.query('ROLLBACK'); next(e) }
  finally { client.release() }
})

// Malzeme bulk import
router.post('/materials', async (req, res, next) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const data = req.body.data || []
    let imported = 0
    for (const row of data) {
      if (!row.sku || !row.name) continue
      await client.query(
        `INSERT INTO materials (sku,name,family,color,material_type,unit,current_stock,avg_cost)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (sku) DO UPDATE SET
           name=EXCLUDED.name, family=EXCLUDED.family, color=EXCLUDED.color,
           current_stock=EXCLUDED.current_stock, avg_cost=EXCLUDED.avg_cost`,
        [row.sku, row.name, row.family || null, row.color || null,
         row.material_type || 'leather', row.unit || 'desi',
         parseFloat(row.current_stock) || 0, parseFloat(row.avg_cost) || 0]
      )
      imported++
    }
    await client.query('COMMIT')
    res.json({ imported })
  } catch (e) { await client.query('ROLLBACK'); next(e) }
  finally { client.release() }
})

// Ürün bulk import
router.post('/products', async (req, res, next) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const data = req.body.data || []
    let imported = 0
    for (const row of data) {
      if (!row.code || !row.name) continue
      await client.query(
        `INSERT INTO products (code,name,base_price,allows_personalization,standard_production_minutes)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (code) DO UPDATE SET
           name=EXCLUDED.name, base_price=EXCLUDED.base_price`,
        [row.code, row.name, parseFloat(row.base_price) || 0,
         row.allows_personalization === 'true' || row.allows_personalization === true,
         parseInt(row.standard_production_minutes) || 0]
      )
      imported++
    }
    await client.query('COMMIT')
    res.json({ imported })
  } catch (e) { await client.query('ROLLBACK'); next(e) }
  finally { client.release() }
})

export default router

import { Router } from 'express'
import { query, pool } from '../db.js'

const router = Router()

const SORT_WHITELIST = { code: 'code', name: 'name', base_price: 'base_price', standard_production_minutes: 'standard_production_minutes' }

router.get('/', async (req, res, next) => {
  try {
    const { include_inactive, sort, dir } = req.query
    const col = SORT_WHITELIST[sort] || 'code'
    const direction = dir === 'desc' ? 'DESC' : 'ASC'
    let sql = `SELECT * FROM products`
    sql += include_inactive === '1' ? '' : ` WHERE is_active=TRUE`
    sql += ` ORDER BY ${col} ${direction}`
    const { rows } = await query(sql)
    res.json(rows)
  } catch (e) { next(e) }
})

router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM products WHERE id=$1', [req.params.id])
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    const variants = await query('SELECT * FROM product_variants WHERE product_id=$1 AND is_active=TRUE', [req.params.id])
    const recipes = await query(`
      SELECT r.*, json_agg(rl ORDER BY rl.id) AS lines
      FROM recipes r LEFT JOIN recipe_lines rl ON rl.recipe_id=r.id
      WHERE r.product_id=$1 AND r.is_active=TRUE GROUP BY r.id`, [req.params.id])
    res.json({ ...rows[0], variants: variants.rows, recipes: recipes.rows })
  } catch (e) { next(e) }
})

router.post('/', async (req, res, next) => {
  try {
    const { code, name, description, base_price, allows_personalization, standard_production_minutes } = req.body
    const { rows } = await query(
      `INSERT INTO products (code,name,description,base_price,allows_personalization,standard_production_minutes)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [code, name, description, base_price, allows_personalization, standard_production_minutes])
    res.status(201).json(rows[0])
  } catch (e) { next(e) }
})

router.put('/:id', async (req, res, next) => {
  try {
    const { code, name, description, base_price, allows_personalization, standard_production_minutes, is_active } = req.body
    const { rows: existing } = await query('SELECT code FROM products WHERE id=$1', [req.params.id])
    if (!existing[0]) return res.status(404).json({ error: 'Not found' })

    // CHK-U02: Geçmişte kullanılmış ürünlerde code değiştirilemez
    if (code && code !== existing[0].code) {
      const { rows: usage } = await query(
        `SELECT COUNT(*)::int AS cnt FROM order_items WHERE product_id=$1
         UNION ALL SELECT COUNT(*)::int FROM production_jobs WHERE product_id=$1`,
        [req.params.id])
      const totalUsage = usage.reduce((s, r) => s + r.cnt, 0)
      if (totalUsage > 0) {
        return res.status(409).json({ error: 'Sipariş/üretim geçmişi bulunan ürünün kodu değiştirilemez' })
      }
    }

    const { rows } = await query(
      `UPDATE products SET code=COALESCE($1,code),name=$2,description=$3,base_price=$4,allows_personalization=$5,
       standard_production_minutes=$6,is_active=COALESCE($7,is_active) WHERE id=$8 RETURNING *`,
      [code || null, name, description, base_price, allows_personalization, standard_production_minutes, is_active, req.params.id])
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (e) { next(e) }
})

router.delete('/:id', async (req, res, next) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query('SELECT * FROM products WHERE id=$1 FOR UPDATE', [req.params.id])
    if (!rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }) }

    const { rows: usage } = await client.query(
      'SELECT COUNT(*)::int AS cnt FROM order_items WHERE product_id=$1', [req.params.id])

    if (usage[0].cnt === 0) {
      await client.query('DELETE FROM products WHERE id=$1', [req.params.id])
      await client.query('COMMIT')
      return res.json({ ok: true, hard_deleted: true })
    }
    await client.query('UPDATE products SET is_active=FALSE WHERE id=$1', [req.params.id])
    await client.query('COMMIT')
    res.json({ ok: true, soft_deleted: true, order_count: usage[0].cnt })
  } catch (e) { await client.query('ROLLBACK'); next(e) }
  finally { client.release() }
})

export default router

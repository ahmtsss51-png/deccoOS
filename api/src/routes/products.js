import { Router } from 'express'
import { query } from '../db.js'

const router = Router()

router.get('/', async (_req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM products WHERE is_active=TRUE ORDER BY code')
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
      FROM recipes r
      LEFT JOIN recipe_lines rl ON rl.recipe_id=r.id
      WHERE r.product_id=$1 AND r.is_active=TRUE
      GROUP BY r.id
    `, [req.params.id])
    res.json({ ...rows[0], variants: variants.rows, recipes: recipes.rows })
  } catch (e) { next(e) }
})

router.post('/', async (req, res, next) => {
  try {
    const { code, name, description, base_price, allows_personalization, standard_production_minutes } = req.body
    const { rows } = await query(
      `INSERT INTO products (code,name,description,base_price,allows_personalization,standard_production_minutes)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [code, name, description, base_price, allows_personalization, standard_production_minutes]
    )
    res.status(201).json(rows[0])
  } catch (e) { next(e) }
})

router.put('/:id', async (req, res, next) => {
  try {
    const { code, name, description, base_price, allows_personalization, standard_production_minutes, is_active } = req.body
    const { rows } = await query(
      `UPDATE products SET code=$1, name=$2, description=$3, base_price=$4, allows_personalization=$5, standard_production_minutes=$6, is_active=COALESCE($7, is_active)
       WHERE id=$8 RETURNING *`,
      [code, name, description, base_price, allows_personalization, standard_production_minutes, is_active, req.params.id]
    )
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (e) { next(e) }
})

export default router

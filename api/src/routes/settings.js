import { Router } from 'express'
import { query } from '../db.js'
import bcrypt from 'bcryptjs'

const router = Router()

// Rol izinleri tanımı
const ROLE_PERMISSIONS = {
  admin:      { label: 'Yönetici',    permissions: ['*'] },
  production: { label: 'Üretim',      permissions: ['production', 'stock', 'materials', 'recipes'] },
  sales:      { label: 'Satış',       permissions: ['orders', 'customers', 'products', 'finance:view'] },
  finance:    { label: 'Finans',      permissions: ['finance', 'suppliers', 'orders:view', 'customers:view'] },
  readonly:   { label: 'Salt Okunur', permissions: ['dashboard', 'orders:view', 'stock:view'] },
}

router.get('/roles', (_req, res) => {
  res.json(Object.entries(ROLE_PERMISSIONS).map(([key, v]) => ({ key, ...v })))
})

// Departmanlar
router.get('/departments', async (_req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM departments ORDER BY name')
    res.json(rows)
  } catch (e) { next(e) }
})

router.post('/departments', async (req, res, next) => {
  try {
    const { name, color } = req.body
    const { rows } = await query(
      'INSERT INTO departments (name, color) VALUES ($1,$2) RETURNING *',
      [name, color || 'blue']
    )
    res.status(201).json(rows[0])
  } catch (e) { next(e) }
})

router.put('/departments/:id', async (req, res, next) => {
  try {
    const { name, color } = req.body
    const { rows } = await query(
      'UPDATE departments SET name=$1, color=$2 WHERE id=$3 RETURNING *',
      [name, color, req.params.id]
    )
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (e) { next(e) }
})

router.delete('/departments/:id', async (req, res, next) => {
  try {
    await query('DELETE FROM departments WHERE id=$1', [req.params.id])
    res.json({ ok: true })
  } catch (e) { next(e) }
})

// Kullanıcılar
router.get('/users', async (_req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT id, full_name, username, role, department, is_active, created_at
      FROM users ORDER BY id
    `)
    res.json(rows)
  } catch (e) { next(e) }
})

router.post('/users', async (req, res, next) => {
  try {
    const { full_name, username, role, department, password } = req.body
    const hash = await bcrypt.hash(password || 'decco123', 10)
    const { rows } = await query(
      `INSERT INTO users (full_name, username, role, department, password_hash)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, full_name, username, role, department, is_active`,
      [full_name, username, role || 'readonly', department, hash]
    )
    res.status(201).json(rows[0])
  } catch (e) { next(e) }
})

router.put('/users/:id', async (req, res, next) => {
  try {
    const { full_name, username, role, department, is_active, password } = req.body
    let sql = 'UPDATE users SET full_name=$1, username=$2, role=$3, department=$4, is_active=$5'
    const params = [full_name, username, role, department, is_active !== undefined ? is_active : true]
    if (password) { params.push(await bcrypt.hash(password, 10)); sql += `, password_hash=$${params.length}` }
    params.push(req.params.id)
    sql += ` WHERE id=$${params.length} RETURNING id, full_name, username, role, department, is_active`
    const { rows } = await query(sql, params)
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (e) { next(e) }
})

export default router

import { Router } from 'express'
import { query } from '../db.js'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'

const router = Router()
const SECRET = process.env.JWT_SECRET || 'decco-secret-2026'
const EXPIRES = '8h'

router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body
    if (!username || !password) return res.status(400).json({ error: 'Kullanıcı adı ve şifre gerekli' })

    const { rows } = await query(
      'SELECT * FROM users WHERE username=$1 AND is_active=TRUE',
      [username]
    )
    const user = rows[0]
    if (!user) return res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı' })

    const valid = await bcrypt.compare(password, user.password_hash)
    if (!valid) return res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı' })

    const payload = {
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      role: user.role,
      department: user.department,
    }
    const token = jwt.sign(payload, SECRET, { expiresIn: EXPIRES })
    res.json({ token, user: payload })
  } catch (e) { next(e) }
})

router.get('/me', (req, res) => {
  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token gerekli' })
  try {
    const payload = jwt.verify(auth.slice(7), SECRET)
    res.json(payload)
  } catch {
    res.status(401).json({ error: 'Geçersiz veya süresi dolmuş token' })
  }
})

router.post('/logout', (_req, res) => {
  // Client tarafında token siliniyor
  res.json({ ok: true })
})

export { SECRET }
export default router

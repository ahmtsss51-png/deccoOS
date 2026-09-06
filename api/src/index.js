import express from 'express'
import cors from 'cors'
import { pool, runMigrations } from './db.js'

// Routes
import dashboardRouter from './routes/dashboard.js'
import customersRouter from './routes/customers.js'
import ordersRouter from './routes/orders.js'
import productsRouter from './routes/products.js'
import materialsRouter from './routes/materials.js'
import productionRouter from './routes/production.js'
import financeRouter from './routes/finance.js'
import suppliersRouter from './routes/suppliers.js'
import stockRouter from './routes/stock.js'
import importRouter from './routes/import.js'
import recipesRouter from './routes/recipes.js'
import settingsRouter from './routes/settings.js'
import reportsRouter from './routes/reports.js'
import authRouter from './routes/auth.js'
import openingRouter from './routes/opening.js'
import { requireOpened } from './opening-guard.js'
import jwt from 'jsonwebtoken'

const JWT_SECRET = process.env.JWT_SECRET || 'decco-secret-2026'

// Auth middleware — /api/auth/* hariç tüm /api/* korumalı
function requireAuth(req, res, next) {
  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Oturum açmanız gerekiyor' })
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET)
    next()
  } catch {
    res.status(401).json({ error: 'Geçersiz veya süresi dolmuş oturum' })
  }
}

const app = express()
const PORT = process.env.PORT || 3000

app.use(cors())
app.use(express.json())

// Health check
app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1')
    res.json({ status: 'ok', service: 'decco-api' })
  } catch {
    res.status(503).json({ status: 'db_error' })
  }
})

// Auth routes — korumasız
app.use('/api/auth', authRouter)

// Tüm diğer /api/* rotaları token gerektirir
app.use('/api', requireAuth)

// PRE-OPENING: açılış kilitlenene kadar canlı stok/para hareketi yapılamaz.
// Tanım/kayıt uçları (ürün, malzeme, müşteri, sipariş oluşturma) serbest kalır.
app.use('/api/materials/:id/movements', requireOpened)
app.use('/api/orders/:id/payments', requireOpened)
app.use('/api/production/:id/complete', requireOpened)
app.use('/api/suppliers/purchases', requireOpened)
app.use('/api/finance/transactions', requireOpened)
app.use('/api/finance/transfer', requireOpened)

// API routes
app.use('/api/opening', openingRouter)
app.use('/api/dashboard', dashboardRouter)
app.use('/api/customers', customersRouter)
app.use('/api/orders', ordersRouter)
app.use('/api/products', productsRouter)
app.use('/api/materials', materialsRouter)
app.use('/api/production', productionRouter)
app.use('/api/finance', financeRouter)
app.use('/api/suppliers', suppliersRouter)
app.use('/api/stock', stockRouter)
app.use('/api/import', importRouter)
app.use('/api/recipes', recipesRouter)
app.use('/api/settings', settingsRouter)
app.use('/api/reports', reportsRouter)

// 404
app.use((_req, res) => res.status(404).json({ error: 'Not found' }))

// Global error handler
app.use((err, _req, res, _next) => {
  // Doğrulama hataları kendi durum kodunu ve mesajını taşır
  if (err.status && err.status < 500) {
    return res.status(err.status).json({ error: err.message })
  }
  console.error(err)
  res.status(500).json({ error: 'Internal server error' })
})

await runMigrations()

app.listen(PORT, () => {
  console.log(`Decco API running on :${PORT}`)
})

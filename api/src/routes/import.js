import { Router } from 'express'
import { pool, query } from '../db.js'
import crypto from 'crypto'

const router = Router()

// CHK-I01: Müşteri bulk import — dry_run, validation, duplicate phone detection
router.post('/customers', async (req, res, next) => {
  const client = await pool.connect()
  try {
    const { data = [], dry_run = false } = req.body
    const results = []
    const errors = []

    await client.query('BEGIN')
    for (let i = 0; i < data.length; i++) {
      const row = data[i]
      if (!row.name) { errors.push({ row: i + 1, error: 'Ad soyad zorunlu' }); continue }

      // Duplicate phone check
      if (row.phone) {
        const digits = String(row.phone).replace(/\D/g, '')
        const norm = digits.startsWith('0') ? digits.slice(1) : digits
        if (norm.length >= 7) {
          const { rows: dup } = await client.query(
            `SELECT id, name FROM customers WHERE deleted_at IS NULL AND regexp_replace(phone,'[^0-9]','','g') = $1 LIMIT 1`,
            [norm])
          if (dup[0]) {
            errors.push({ row: i + 1, error: `Telefon zaten kayıtlı: ${dup[0].name} (id=${dup[0].id})`, severity: 'warning' })
            // warning = continue, not stop
          }
        }
      }
      results.push({ row: i + 1, name: row.name, status: dry_run ? 'preview' : 'ok' })
      if (!dry_run) {
        await client.query(
          `INSERT INTO customers (name,phone,channel,notes,city,district,address,email)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
          [row.name, row.phone || null, row.channel || null, row.notes || null,
           row.city || null, row.district || null, row.address || null, row.email || null]
        )
      }
    }
    if (dry_run) { await client.query('ROLLBACK') } else { await client.query('COMMIT') }
    res.json({ dry_run, imported: dry_run ? 0 : results.length, preview: results, errors })
  } catch (e) { await client.query('ROLLBACK'); next(e) }
  finally { client.release() }
})

// CHK-I01: Malzeme bulk import
router.post('/materials', async (req, res, next) => {
  const client = await pool.connect()
  try {
    const { data = [], dry_run = false } = req.body
    const results = []
    const errors = []

    await client.query('BEGIN')
    for (let i = 0; i < data.length; i++) {
      const row = data[i]
      if (!row.sku || !row.name) { errors.push({ row: i + 1, error: 'SKU ve ad zorunlu' }); continue }
      results.push({ row: i + 1, sku: row.sku, name: row.name, status: dry_run ? 'preview' : 'ok' })
      if (!dry_run) {
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
      }
    }
    if (dry_run) { await client.query('ROLLBACK') } else { await client.query('COMMIT') }
    res.json({ dry_run, imported: dry_run ? 0 : results.length, preview: results, errors })
  } catch (e) { await client.query('ROLLBACK'); next(e) }
  finally { client.release() }
})

// CHK-I01: Ürün bulk import
router.post('/products', async (req, res, next) => {
  const client = await pool.connect()
  try {
    const { data = [], dry_run = false } = req.body
    const results = []
    const errors = []

    await client.query('BEGIN')
    for (let i = 0; i < data.length; i++) {
      const row = data[i]
      if (!row.code || !row.name) { errors.push({ row: i + 1, error: 'Kod ve ad zorunlu' }); continue }
      results.push({ row: i + 1, code: row.code, name: row.name, status: dry_run ? 'preview' : 'ok' })
      if (!dry_run) {
        await client.query(
          `INSERT INTO products (code,name,base_price,allows_personalization,standard_production_minutes)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (code) DO UPDATE SET
             name=EXCLUDED.name, base_price=EXCLUDED.base_price`,
          [row.code, row.name, parseFloat(row.base_price) || 0,
           row.allows_personalization === 'true' || row.allows_personalization === true,
           parseInt(row.standard_production_minutes) || 0]
        )
      }
    }
    if (dry_run) { await client.query('ROLLBACK') } else { await client.query('COMMIT') }
    res.json({ dry_run, imported: dry_run ? 0 : results.length, preview: results, errors })
  } catch (e) { await client.query('ROLLBACK'); next(e) }
  finally { client.release() }
})

// FIX-F4: Sipariş bulk import — confirmed INSERT + persistent batch_id deduplication
// dry_run=true → yalnız önizleme (hiç kayıt açılmaz, tam ROLLBACK)
// dry_run=false → tek transaction içinde gerçek INSERT; aynı batch ikinci kez 409 döner
// Her satırda business date = order_date; created_at business date OLMAZ.
// Satır alanları: order_no*, customer_id*, order_date, total_amount*, paid_amount,
//                 status, source, notes, items:[{product_id|product_code, quantity, unit_price}]
router.post('/orders', async (req, res, next) => {
  const client = await pool.connect()
  try {
    const { data = [], dry_run = false } = req.body
    const batchId = crypto.createHash('md5').update(JSON.stringify(data)).digest('hex')

    // Aynı batch daha önce confirmed import edildi mi?
    const { rows: prevBatch } = await client.query(
      'SELECT COUNT(*)::int AS cnt FROM orders WHERE import_batch_id=$1', [batchId])
    if (!dry_run && prevBatch[0].cnt > 0) {
      return res.status(409).json({
        error: `Bu import dosyası daha önce yüklendi (${prevBatch[0].cnt} sipariş mevcut)`,
        batch_id: batchId, duplicate_batch: true })
    }

    const results = []
    const errors = []
    await client.query('BEGIN')

    for (let i = 0; i < data.length; i++) {
      const row = data[i]
      const rowNum = i + 1

      // Zorunlu alan kontrolleri
      if (!row.order_no) { errors.push({ row: rowNum, error: 'order_no zorunlu' }); continue }
      if (!row.customer_id) { errors.push({ row: rowNum, order_no: row.order_no, error: 'customer_id zorunlu' }); continue }
      const totalAmt = parseFloat(row.total_amount)
      if (!totalAmt || totalAmt <= 0) { errors.push({ row: rowNum, order_no: row.order_no, error: 'total_amount geçerli bir tutar olmalı' }); continue }

      // Duplicate order_no
      const { rows: dup } = await client.query('SELECT id FROM orders WHERE order_no=$1', [row.order_no])
      if (dup[0]) {
        errors.push({ row: rowNum, order_no: row.order_no, error: 'Sipariş numarası zaten mevcut', severity: 'warning' })
        continue
      }

      // Müşteri var mı?
      const { rows: cust } = await client.query(
        'SELECT id FROM customers WHERE id=$1 AND deleted_at IS NULL', [row.customer_id])
      if (!cust[0]) { errors.push({ row: rowNum, order_no: row.order_no, error: `Müşteri bulunamadı: customer_id=${row.customer_id}` }); continue }

      const paidAmt = parseFloat(row.paid_amount) || 0
      const orderDate = row.order_date ? new Date(row.order_date) : new Date()
      if (isNaN(orderDate.getTime())) {
        errors.push({ row: rowNum, order_no: row.order_no, error: 'Geçersiz order_date formatı' }); continue
      }

      results.push({ row: rowNum, order_no: row.order_no, customer_id: row.customer_id, status: dry_run ? 'preview' : 'ok' })

      if (!dry_run) {
        const { rows: ord } = await client.query(
          `INSERT INTO orders
             (order_no, customer_id, order_date, total_amount, paid_amount, status, source, notes, import_batch_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [row.order_no, row.customer_id, orderDate, totalAmt, paidAmt,
           row.status || 'completed', row.source || null, row.notes || null, batchId])
        const orderId = ord[0].id

        // items varsa ekle
        if (Array.isArray(row.items) && row.items.length > 0) {
          for (const item of row.items) {
            let productId = item.product_id
            if (!productId && item.product_code) {
              const { rows: pr } = await client.query('SELECT id FROM products WHERE code=$1', [item.product_code])
              productId = pr[0]?.id
            }
            if (!productId) continue
            await client.query(
              `INSERT INTO order_items (order_id, product_id, quantity, unit_price, discount, material_selections, personalization)
               VALUES ($1,$2,$3,$4,0,'{}',NULL)`,
              [orderId, productId, parseFloat(item.quantity) || 1, parseFloat(item.unit_price) || 0])
          }
        }
      }
    }

    if (dry_run) {
      await client.query('ROLLBACK')
    } else {
      await client.query('COMMIT')
    }

    const hardErrors = errors.filter(e => e.severity !== 'warning')
    res.json({
      dry_run,
      batch_id: batchId,
      imported: dry_run ? 0 : results.length,
      preview: results,
      errors,
      can_import: hardErrors.length === 0,
    })
  } catch (e) { await client.query('ROLLBACK'); next(e) }
  finally { client.release() }
})

export default router

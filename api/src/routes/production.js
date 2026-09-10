import { Router } from 'express'
import { query, pool } from '../db.js'
import { assertMaterialCounted } from '../opening-guard.js'

const router = Router()

// CHK-P06: Geçerli durum geçişleri (ileri yön)
const VALID_TRANSITIONS = {
  pending:       ['in_progress', 'cancelled'],
  in_progress:   ['quality_check', 'cancelled'],
  quality_check: ['cancelled'],   // 'completed' yalnız /complete endpoint'inden
}

// CHK-P04: BOM'dan malzeme rezervasyonu — job_id ile izlenebilir
async function reserveMaterials(client, job, snapshot) {
  for (const line of snapshot) {
    if (line.material_id) await assertMaterialCounted(line.material_id)
    const qty = parseFloat(line.quantity_per_unit ?? line.quantity) * job.quantity * (1 + parseFloat(line.waste_rate || 0))
    await client.query(
      'UPDATE materials SET reserved_stock = reserved_stock + $1 WHERE id = $2',
      [qty, line.material_id]
    )
  }
}

async function releaseReservations(client, job, snapshot) {
  for (const line of snapshot) {
    const qty = parseFloat(line.quantity_per_unit ?? line.quantity) * job.quantity * (1 + parseFloat(line.waste_rate || 0))
    await client.query(
      'UPDATE materials SET reserved_stock = GREATEST(0, reserved_stock - $1) WHERE id = $2',
      [qty, line.material_id]
    )
  }
}

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

// CHK-P01/P02/P03/P04: Yeni üretim işi
router.post('/', async (req, res, next) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const {
      order_item_id, product_id, variant_id, recipe_id, quantity,
      material_selections, notes,
      source = 'stock',           // CHK-P01: 'order' | 'stock'
      payment_override = false,   // CHK-P02: %33 altı explicit onay
    } = req.body

    // CHK-P01: Sipariş için üretimde order_item_id zorunlu; aynı order_item için aktif iş olamaz
    if (source === 'order') {
      if (!order_item_id) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'Sipariş için üretimde order_item_id zorunlu' })
      }
      const { rows: dup } = await client.query(
        `SELECT id FROM production_jobs WHERE order_item_id=$1 AND status NOT IN ('cancelled','completed')`,
        [order_item_id]
      )
      if (dup.length) {
        await client.query('ROLLBACK')
        return res.status(409).json({ error: 'Bu sipariş kalemi için zaten aktif üretim işi var (#' + dup[0].id + ')' })
      }

      // CHK-P02: Ödeme uygunluğu — sipariş ödeme kontrolü
      const { rows: oi } = await client.query(`
        SELECT oi.order_id, o.total_amount, o.paid_amount, o.status AS order_status
        FROM order_items oi JOIN orders o ON o.id=oi.order_id
        WHERE oi.id=$1`, [order_item_id])
      if (!oi[0]) {
        await client.query('ROLLBACK')
        return res.status(404).json({ error: 'Sipariş kalemi bulunamadı' })
      }
      const { total_amount, paid_amount } = oi[0]
      const pct = parseFloat(total_amount) > 0
        ? parseFloat(paid_amount) / parseFloat(total_amount)
        : 1
      if (pct < 0.005 && !payment_override) {
        await client.query('ROLLBACK')
        return res.status(422).json({
          error: 'Ödeme alınmamış sipariş için üretim başlatılamaz',
          payment_pct: Math.round(pct * 100),
          require_override: true,
        })
      }
      if (pct < 0.33 && !payment_override) {
        await client.query('ROLLBACK')
        return res.status(422).json({
          error: `Ödeme oranı %${Math.round(pct*100)} — üretim için en az %33 gerekli (veya explicit onay)`,
          payment_pct: Math.round(pct * 100),
          require_override: true,
        })
      }
    }

    // CHK-P03: BOM snapshot — reçete değişse de bu iş doğru malzemeyi tüketir
    let bomSnapshot = null
    if (recipe_id) {
      const { rows: recipeLines } = await client.query(
        `SELECT rl.material_id, rl.quantity AS quantity_per_unit, rl.waste_rate, rl.slot_code,
                m.sku, m.name AS material_name, m.unit
         FROM recipe_lines rl JOIN materials m ON m.id=rl.material_id
         WHERE rl.recipe_id=$1`, [recipe_id])
      if (recipeLines.length) bomSnapshot = recipeLines
    }

    const { rows } = await client.query(
      `INSERT INTO production_jobs
         (order_item_id,product_id,variant_id,recipe_id,quantity,material_selections,notes,bom_snapshot,source,payment_override)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [order_item_id || null, product_id, variant_id || null, recipe_id || null, quantity,
       JSON.stringify(material_selections || {}), notes,
       bomSnapshot ? JSON.stringify(bomSnapshot) : null,
       source, !!payment_override]
    )
    const job = rows[0]

    // CHK-P04: Malzemeleri rezerve et
    if (bomSnapshot) {
      await reserveMaterials(client, job, bomSnapshot)
    }

    await client.query('COMMIT')
    res.status(201).json(job)
  } catch (e) { await client.query('ROLLBACK'); next(e) }
  finally { client.release() }
})

// CHK-P06: Durum geçişi — geçersiz transition reddedilir; iptal = rezervasyon serbest
router.patch('/:id/status', async (req, res, next) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { status: newStatus } = req.body
    const { rows: jobRows } = await client.query(
      'SELECT * FROM production_jobs WHERE id=$1 FOR UPDATE', [req.params.id])
    if (!jobRows[0]) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Not found' })
    }
    const job = jobRows[0]

    // CHK-P06: Geçiş kontrolü
    const allowed = VALID_TRANSITIONS[job.status]
    if (!allowed || !allowed.includes(newStatus)) {
      await client.query('ROLLBACK')
      return res.status(400).json({
        error: `Geçersiz durum geçişi: ${job.status} → ${newStatus}`,
        allowed_from_here: allowed || []
      })
    }

    const extra = newStatus === 'in_progress' ? ', started_at=NOW()' : ''
    await client.query(
      `UPDATE production_jobs SET status=$1${extra} WHERE id=$2`,
      [newStatus, req.params.id]
    )

    // CHK-P04: İptal → rezervasyon serbest bırak
    if (newStatus === 'cancelled') {
      const snapshot = Array.isArray(job.bom_snapshot) && job.bom_snapshot.length
        ? job.bom_snapshot
        : null
      if (snapshot) await releaseReservations(client, job, snapshot)
    }

    await client.query('COMMIT')
    const { rows } = await client.query('SELECT * FROM production_jobs WHERE id=$1', [req.params.id])
    res.json(rows[0])
  } catch (e) { await client.query('ROLLBACK'); next(e) }
  finally { client.release() }
})

// CHK-P03/P04/P05: Üretim tamamla
router.post('/:id/complete', async (req, res, next) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { material_config, unit_cost } = req.body

    const { rows: jobRows } = await client.query('SELECT * FROM production_jobs WHERE id=$1', [req.params.id])
    const job = jobRows[0]
    if (!job) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Not found' })
    }
    if (!['in_progress','quality_check'].includes(job.status)) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: `Üretim tamamlamak için iş in_progress veya quality_check durumunda olmalı (şu an: ${job.status})` })
    }

    // CHK-P03: Snapshot varsa onu kullan, yoksa canlı reçete
    const useSnapshot = Array.isArray(job.bom_snapshot) && job.bom_snapshot.length > 0
    const lines = useSnapshot
      ? job.bom_snapshot.map(s => ({
          material_id: s.material_id,
          quantity: parseFloat(s.quantity_per_unit ?? s.quantity),
          waste_rate: parseFloat(s.waste_rate || 0),
          slot_code: s.slot_code || null,
        }))
      : job.recipe_id
        ? (await client.query('SELECT material_id, quantity_per_unit AS quantity, waste_rate, slot_code FROM recipe_lines WHERE recipe_id=$1', [job.recipe_id])).rows
        : []

    // CHK-P04: Önce rezervasyonu serbest bırak
    if (useSnapshot) {
      await releaseReservations(client, job, job.bom_snapshot)
    }

    // CHK-P03/P04: Stoktan gerçek tüketim (free-text note, sadece SKU'lu malzemeler)
    const selections = job.material_selections || {}
    const actualMaterialConfig = {}
    for (const line of lines) {
      const matId = selections[line.slot_code] || line.material_id
      if (!matId) continue
      await assertMaterialCounted(matId)
      const used = line.quantity * job.quantity * (1 + line.waste_rate)
      await client.query(
        'UPDATE materials SET current_stock = current_stock - $1 WHERE id=$2',
        [used, matId]
      )
      await client.query(
        `INSERT INTO stock_movements (material_id,movement_type,quantity,reference_type,reference_id)
         VALUES ($1,'production_out',$2,'production_job',$3)`,
        [matId, -used, job.id]
      )
      // Gerçek malzeme konfigürasyonunu kayıt altına al
      actualMaterialConfig[line.slot_code || matId] = matId
    }

    // CHK-P05: available_qty — stok için = üretilen; sipariş için = 0 (sipariş bekleniyor)
    const availQty = job.source === 'order' ? 0 : job.quantity

    const { rows: outputRows } = await client.query(
      `INSERT INTO production_outputs (job_id,product_id,quantity,material_config,unit_cost,available_qty)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [job.id, job.product_id, job.quantity,
       JSON.stringify(material_config || actualMaterialConfig),
       unit_cost || null, availQty]
    )

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

import { Router } from 'express'
import { pool, query } from '../db.js'
import { invalidateOpeningCache } from '../opening-guard.js'

const router = Router()

// Sıfır cevabı geçerli olan bölümler açık onay ister
const CONFIRMABLE = ['finished_goods', 'assets']

// --- Oturum yardımcıları ----------------------------------------------------

export function isValidGoLiveDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return false
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim())
  if (!match) return false

  const year = parseInt(match[1], 10)
  const month = parseInt(match[2], 10)
  const day = parseInt(match[3], 10)

  if (year < 2000 || year > 2100) return false
  if (month < 1 || month > 12) return false
  if (day < 1 || day > 31) return false

  const d = new Date(Date.UTC(year, month - 1, day))
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  )
}

export function formatTrCalendarDate(dateStr) {
  if (!dateStr) return ''
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr).trim())
  if (m) {
    return `${m[3]}.${m[2]}.${m[1]}`
  }
  return String(dateStr)
}

async function getLatestSession() {
  const { rows } = await query(
    `SELECT id,
            TO_CHAR(go_live_date, 'YYYY-MM-DD') AS go_live_date,
            status, confirmations, locked_at, locked_by, notes, created_at
     FROM opening_sessions ORDER BY id DESC LIMIT 1`)
  return rows[0] || null
}

async function ensureSession() {
  const existing = await getLatestSession()
  if (existing) return existing
  await query("INSERT INTO opening_sessions (status) VALUES ('draft')")
  return await getLatestSession()
}

// Bölüm satırlarını oturum için hazırla (eksik olanları pending yarat)
async function seedLines(sessionId) {
  await query(`
    INSERT INTO opening_lines (session_id, section, ref_key, material_id, location)
    SELECT $1, 'material', m.id::text, m.id, 'ATOLYE'
    FROM materials m WHERE m.is_active = TRUE
    ON CONFLICT (session_id, section, ref_key) DO NOTHING`, [sessionId])

  await query(`
    INSERT INTO opening_lines (session_id, section, ref_key, account_id)
    SELECT $1, 'account', a.id::text, a.id
    FROM accounts a WHERE a.is_active = TRUE
    ON CONFLICT (session_id, section, ref_key) DO NOTHING`, [sessionId])

  // Tarihsel olarak açık görünen siparişler — kullanıcı teyit edecek
  await query(`
    INSERT INTO opening_lines (session_id, section, ref_key, order_id, amount, previous_value)
    SELECT $1, 'receivable', o.id::text, o.id,
           o.total_amount - o.paid_amount, o.total_amount - o.paid_amount
    FROM orders o WHERE o.deleted_at IS NULL AND o.total_amount - o.paid_amount > 0
    ON CONFLICT (session_id, section, ref_key) DO NOTHING`, [sessionId])

  await query(`
    INSERT INTO opening_lines (session_id, section, ref_key, supplier_id, previous_value)
    SELECT $1, 'supplier_debt', s.id::text, s.id, s.total_debt
    FROM suppliers s
    ON CONFLICT (session_id, section, ref_key) DO NOTHING`, [sessionId])

  await query(`
    INSERT INTO opening_lines (session_id, section, ref_key)
    VALUES ($1, 'founder', 'FOUNDER')
    ON CONFLICT (session_id, section, ref_key) DO NOTHING`, [sessionId])
}

// --- İlerleme hesabı --------------------------------------------------------

async function buildChecklist(session) {
  const { rows } = await query('SELECT * FROM opening_lines WHERE session_id=$1', [session.id])
  const of = s => rows.filter(r => r.section === s)
  const conf = session.confirmations || {}

  const materials = of('material')
  const accounts = of('account')
  const receivables = of('receivable')
  const debts = of('supplier_debt')
  const founder = of('founder')[0]
  const finished = of('finished_good')
  const { rows: assets } = await query(
    'SELECT count(*)::int n FROM fixed_assets WHERE session_id=$1', [session.id])

  const countedMat = materials.filter(m => m.counted_at !== null).length
  const uncountedMat = materials.filter(m => m.counted_at === null).length
  const verifiedAcc = accounts.filter(a => a.amount !== null).length
  const unverifiedAcc = accounts.filter(a => a.amount === null).length
  const confirmedRec = receivables.filter(r => ['confirmed', 'closed'].includes(r.status)).length
  const unconfirmedRec = receivables.filter(r => !['confirmed', 'closed'].includes(r.status)).length
  const verifiedDebt = debts.filter(d => d.amount !== null).length
  const unverifiedDebt = debts.filter(d => d.amount === null).length

  const matDone = materials.length > 0 && uncountedMat === 0
  const finDone = !!conf.finished_goods || finished.length > 0
  const accDone = accounts.length > 0 && unverifiedAcc === 0
  const recDone = receivables.length > 0 ? unconfirmedRec === 0 : true
  const debtDone = debts.length > 0 ? unverifiedDebt === 0 : true
  const fndDone = !!founder && founder.amount !== null
  const astDone = !!conf.assets || assets[0].n > 0
  const goliveDone = !!session.go_live_date && isValidGoLiveDate(session.go_live_date)

  return [
    { key: 'materials', label: 'Ham madde sayımı',
      done: matDone,
      status: matDone ? 'completed' : 'uncounted',
      detail: `${countedMat} / ${materials.length} kalem sayıldı${uncountedMat > 0 ? ` (${uncountedMat} sayılmadı)` : ''}` },
    { key: 'finished_goods', label: 'Hazır ürün sayımı',
      done: finDone,
      status: finDone ? 'completed' : 'uncounted',
      detail: finished.length ? `${finished.length} lot girildi` : (conf.finished_goods ? 'Kayıt yok — onaylandı' : 'Sayılmadı — onay veya lot gerekli') },
    { key: 'accounts', label: 'Kasa / Banka',
      done: accDone,
      status: accDone ? 'completed' : 'missing',
      detail: `${verifiedAcc} / ${accounts.length} hesap doğrulandı${unverifiedAcc > 0 ? ` (${unverifiedAcc} doğrulanmadı)` : ''}` },
    { key: 'receivables', label: 'Müşteri alacakları',
      done: recDone,
      status: recDone ? 'completed' : 'missing',
      detail: `${confirmedRec} / ${receivables.length} sipariş teyit edildi${unconfirmedRec > 0 ? ` (${unconfirmedRec} doğrulanmadı)` : ''}` },
    { key: 'supplier_debts', label: 'Tedarikçi borçları',
      done: debtDone,
      status: debtDone ? 'completed' : 'missing',
      detail: `${verifiedDebt} / ${debts.length} tedarikçi doğrulandı${unverifiedDebt > 0 ? ` (${unverifiedDebt} doğrulanmadı)` : ''}` },
    { key: 'founder', label: 'Kurucu finansmanı',
      done: fndDone,
      status: fndDone ? 'completed' : 'missing',
      detail: fndDone ? 'Tutar onaylandı' : 'Doğrulanmadı' },
    { key: 'assets', label: 'Demirbaşlar',
      done: astDone,
      status: astDone ? 'completed' : 'missing',
      detail: assets[0].n ? `${assets[0].n} demirbaş girildi` : (conf.assets ? 'Kayıt yok — onaylandı' : 'Kayıt yok — onay gerekli') },
    { key: 'go_live', label: 'Go-live tarihi',
      done: goliveDone,
      status: goliveDone ? 'completed' : 'missing',
      detail: goliveDone
        ? formatTrCalendarDate(session.go_live_date)
        : (session.go_live_date ? 'Geçersiz tarih' : 'Seçilmedi') },
  ]
}

// --- Ana durum --------------------------------------------------------------

router.get('/', async (_req, res, next) => {
  try {
    let session = await getLatestSession()
    if (!session) {
      session = await ensureSession()
    }
    await seedLines(session.id)
    const fresh = await getLatestSession()
    const checklist = await buildChecklist(fresh)
    const done = checklist.filter(c => c.done).length

    // Canonical state: 'draft' | 'open' | 'completed'
    let state = 'draft'
    if (fresh.locked_at !== null || fresh.status === 'completed') {
      state = 'completed'
    } else if (fresh.status === 'open') {
      state = 'open'
    } else {
      state = 'draft'
    }

    res.json({
      state,
      is_locked: state === 'completed',
      session: fresh,
      checklist,
      progress: Math.round((done / checklist.length) * 100),
      done,
      total: checklist.length,
      counts: {
        completed: checklist.filter(c => c.status === 'completed').length,
        missing: checklist.filter(c => c.status === 'missing').length,
        uncounted: checklist.filter(c => c.status === 'uncounted').length,
      }
    })
  } catch (e) { next(e) }
})

// Sistemi operasyonel kullanıma açma (Go-Live)
router.post('/start-operations', async (req, res, next) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows: sessRows } = await client.query(
      `SELECT id, TO_CHAR(go_live_date, 'YYYY-MM-DD') AS go_live_date, status, locked_at
       FROM opening_sessions ORDER BY id DESC LIMIT 1 FOR UPDATE`
    )
    const session = sessRows[0] || null
    if (!session) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Açılış oturumu bulunamadı' })
    }
    if (session.locked_at !== null || session.status === 'completed') {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: 'Açılış oturumu zaten kilitlenmiş' })
    }
    if (session.status === 'open') {
      await client.query('ROLLBACK')
      return res.json({ ok: true, state: 'open' })
    }
    if (!session.go_live_date || !isValidGoLiveDate(session.go_live_date)) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'Sistemi kullanıma açmak için geçerli bir Go-live tarihi zorunludur' })
    }

    const goLive = session.go_live_date
    const { rows: lines } = await client.query(
      'SELECT * FROM opening_lines WHERE session_id=$1', [session.id]
    )
    const of = s => lines.filter(l => l.section === s)

    // 1) Ham madde — draft aşamasında zaten sayılmış olanlar
    for (const l of of('material')) {
      if (l.counted_at !== null && parseFloat(l.counted_qty) > 0) {
        const qty = parseFloat(l.counted_qty)
        const cost = l.unit_cost ?? 0
        const { rows: existingMovements } = await client.query(
          `SELECT id FROM stock_movements WHERE reference_type = 'OPENING' AND reference_id = $1 AND material_id = $2`,
          [session.id, l.material_id]
        )
        if (!existingMovements.length) {
          await client.query(`
            INSERT INTO stock_movements (material_id, movement_type, quantity, unit_cost,
              reference_type, reference_id, location, notes, created_at)
            VALUES ($1,'opening_in',$2,$3,'OPENING',$4,$5,$6,$7)`,
            [l.material_id, qty, cost, session.id, l.location || 'ATOLYE', 'Açılış sayımı', goLive])
          await client.query(
            'UPDATE materials SET current_stock = current_stock + $2, avg_cost = COALESCE($3, avg_cost) WHERE id = $1',
            [l.material_id, qty, cost])
        }
      }
    }

    // 2) Hazır ürün — draft aşamasında girilmiş lotlar
    for (const l of of('finished_good')) {
      const qty = parseInt(l.counted_qty, 10)
      if (!(qty > 0)) continue
      const { rows: existingOutputs } = await client.query(
        `SELECT id FROM production_outputs WHERE opening_line_id = $1`, [l.id]
      )
      if (!existingOutputs.length) {
        await client.query(`
          INSERT INTO production_outputs (job_id, product_id, quantity, material_config,
            unit_cost, available_qty, produced_at, source, opening_line_id)
          VALUES (NULL,$1,$2,$3,$4,$2,$5,'OPENING',$6)`,
          [l.product_id, qty, l.material_config, l.unit_cost ?? 0, goLive, l.id])
      }
    }

    // 3) Kasa/Banka — doğrulanmış hesaplar
    for (const l of of('account')) {
      if (l.amount !== null) {
        const amt = parseFloat(l.amount) || 0
        const { rows: existingTx } = await client.query(
          `SELECT id FROM transactions WHERE reference_type = 'OPENING' AND reference_id = $1 AND account_id = $2`,
          [session.id, l.account_id]
        )
        if (!existingTx.length) {
          await client.query(`
            INSERT INTO transactions (account_id, amount, transaction_type, reference_type,
              reference_id, description, transaction_date)
            VALUES ($1,$2,'opening_balance','OPENING',$3,$4,$5)`,
            [l.account_id, amt, session.id, 'Açılış bakiyesi', goLive])
          await client.query('UPDATE accounts SET balance = balance + $2 WHERE id=$1',
            [l.account_id, amt])
        }
      }
    }

    // 4) Tedarikçi borçları — doğrulanmış borçlar
    for (const l of of('supplier_debt')) {
      if (l.amount !== null) {
        await client.query('UPDATE suppliers SET total_debt = $2 WHERE id = $1',
          [l.supplier_id, parseFloat(l.amount) || 0])
      }
    }

    await client.query(`UPDATE opening_sessions SET status = 'open' WHERE id = $1`, [session.id])
    await client.query('COMMIT')
    invalidateOpeningCache()
    res.json({ ok: true, state: 'open' })
  } catch (e) {
    await client.query('ROLLBACK')
    next(e)
  } finally {
    client.release()
  }
})

router.put('/session', async (req, res, next) => {
  try {
    const session = await getLatestSession()
    if (!session) return res.status(404).json({ error: 'Açılış oturumu bulunamadı' })
    if (session.locked_at !== null || session.status === 'completed') {
      return res.status(409).json({ error: 'Açılış kilitlenmiş' })
    }
    const { go_live_date, notes, confirm } = req.body
    if (session.status === 'open' && go_live_date !== undefined && go_live_date !== session.go_live_date) {
      return res.status(403).json({ error: 'Sistem operasyonel kullanıma açıldığından Go-live tarihi değiştirilemez' })
    }
    if (confirm && CONFIRMABLE.includes(confirm.key)) {
      await query(
        `UPDATE opening_sessions SET confirmations = confirmations || $2::jsonb WHERE id=$1`,
        [session.id, JSON.stringify({ [confirm.key]: !!confirm.value })])
    }
    if (go_live_date !== undefined && session.status !== 'open') {
      if (!isValidGoLiveDate(go_live_date)) {
        return res.status(400).json({ error: 'Geçerli bir tarih girin (örn. 10.09.2026)' })
      }
      await query(
        `UPDATE opening_sessions SET go_live_date=$2 WHERE id=$1`,
        [session.id, go_live_date.trim()])
    }
    if (notes !== undefined) {
      await query(
        `UPDATE opening_sessions SET notes=$2 WHERE id=$1`,
        [session.id, notes ?? null])
    }
    invalidateOpeningCache()
    res.json(await getLatestSession())
  } catch (e) { next(e) }
})

// --- Bölüm listeleri --------------------------------------------------------

router.get('/materials', async (_req, res, next) => {
  try {
    const s = await getLatestSession()
    if (!s) return res.json([])
    const { rows } = await query(`
      SELECT l.id, l.material_id, m.sku, m.name, m.unit, m.family, m.color,
             l.counted_qty, l.unit_cost, l.location, l.notes, l.counted_at,
             l.counted_qty * l.unit_cost AS total_value
      FROM opening_lines l JOIN materials m ON m.id = l.material_id
      WHERE l.session_id=$1 AND l.section='material' ORDER BY m.sku`, [s.id])
    res.json(rows)
  } catch (e) { next(e) }
})

// Dedicated açılış tamamlama endpoint'i (OPENING_COMPLETION audit referansıyla)
router.post('/materials/:lineId/complete', async (req, res, next) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const s = await getLatestSession()
    if (!s) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Açılış oturumu bulunamadı' })
    }
    if (s.locked_at !== null || s.status === 'completed') {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: 'Açılış kilitlenmiş' })
    }

    const { rows: lines } = await client.query(
      `SELECT l.*, m.sku FROM opening_lines l JOIN materials m ON m.id = l.material_id
       WHERE l.id = $1 AND l.session_id = $2 AND l.section = 'material' FOR UPDATE`,
      [req.params.lineId, s.id]
    )
    if (!lines.length) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Malzeme açılış satırı bulunamadı' })
    }
    const line = lines[0]
    if (line.counted_at !== null) {
      await client.query('ROLLBACK')
      return res.status(409).json({
        error: 'Bu malzeme açılışta zaten sayılmıştır. Stok düzeltme için normal stok akışını kullanın.'
      })
    }

    const { counted_qty, unit_cost, location, notes } = req.body
    if (counted_qty === '' || counted_qty === null || counted_qty === undefined) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'Sayım miktarı girilmelidir' })
    }
    const qty = parseFloat(counted_qty)
    if (isNaN(qty) || qty < 0) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'Geçersiz sayım miktarı' })
    }
    if (qty > 0 && (unit_cost === null || unit_cost === undefined || unit_cost === '')) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'Miktar > 0 olduğunda birim maliyet zorunludur' })
    }
    const cost = qty > 0 ? parseFloat(unit_cost) : (unit_cost ? parseFloat(unit_cost) : null)

    await client.query(
      `UPDATE opening_lines
       SET counted_qty = $1, unit_cost = $2, location = COALESCE($3, location),
           notes = $4, counted_at = NOW(), status = 'counted', updated_at = NOW()
       WHERE id = $5`,
      [qty, cost, location || null, notes || null, line.id]
    )

    if (qty > 0 && s.status === 'open') {
      await client.query(`
        INSERT INTO stock_movements (material_id, movement_type, quantity, unit_cost,
          reference_type, reference_id, location, notes, created_at)
        VALUES ($1, 'opening_in', $2, $3, 'OPENING_COMPLETION', $4, $5, $6, NOW())`,
        [line.material_id, qty, cost ?? 0, s.id, location || line.location || 'ATOLYE',
         notes ? `Açılış tamamlama: ${notes}` : 'Açılış tamamlama sayımı']
      )
      await client.query(`
        UPDATE materials
        SET current_stock = current_stock + $1,
            avg_cost = COALESCE((current_stock * avg_cost + $1 * $2) / NULLIF(current_stock + $1, 0), avg_cost)
        WHERE id = $3`,
        [qty, cost ?? 0, line.material_id]
      )
    }

    await client.query('COMMIT')
    invalidateOpeningCache()
    res.json({ ok: true, line_id: line.id })
  } catch (e) {
    await client.query('ROLLBACK')
    next(e)
  } finally {
    client.release()
  }
})

// counted_qty: null gönderilirse "sayılmadı"ya döner, 0 gerçek sıfırdır
router.put('/materials/:lineId', async (req, res, next) => {
  try {
    const s = await getLatestSession()
    if (!s) return res.status(404).json({ error: 'Açılış oturumu bulunamadı' })
    if (s.locked_at !== null || s.status === 'completed') {
      return res.status(409).json({ error: 'Açılış kilitlenmiş' })
    }
    const { rows: lines } = await query(
      `SELECT * FROM opening_lines WHERE id = $1 AND session_id = $2 AND section = 'material'`,
      [req.params.lineId, s.id]
    )
    if (!lines.length) return res.status(404).json({ error: 'Satır bulunamadı' })
    const line = lines[0]

    // Açılış operasyonel moddaysa ve bu kalem zaten sayıldıysa üzerine yazılamaz
    if (s.status === 'open' && line.counted_at !== null) {
      return res.status(409).json({
        error: 'Bu malzeme açılışta zaten sayılmıştır. Stok düzeltme için normal stok akışını kullanın.'
      })
    }

    const { counted_qty, unit_cost, location, notes } = req.body
    const qty = counted_qty === '' || counted_qty === undefined ? null : counted_qty
    if (qty !== null && parseFloat(qty) > 0 && (unit_cost === null || unit_cost === undefined || unit_cost === '')) {
      return res.status(400).json({ error: 'Miktar > 0 olduğunda birim maliyet zorunludur' })
    }

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query(`
        UPDATE opening_lines SET
          counted_qty=$3, unit_cost=$4, location=COALESCE($5,location), notes=$6,
          counted_at = CASE WHEN $3::numeric IS NULL THEN NULL ELSE NOW() END,
          status     = CASE WHEN $3::numeric IS NULL THEN 'pending' ELSE 'counted' END,
          updated_at = NOW()
        WHERE id=$1 AND session_id=$2 AND section='material' RETURNING *`,
        [req.params.lineId, s.id, qty, unit_cost ?? null, location ?? null, notes ?? null])

      if (s.status === 'open' && qty !== null && parseFloat(qty) > 0) {
        await client.query(`
          INSERT INTO stock_movements (material_id, movement_type, quantity, unit_cost,
            reference_type, reference_id, location, notes, created_at)
          VALUES ($1, 'opening_in', $2, $3, 'OPENING_COMPLETION', $4, $5, $6, NOW())`,
          [line.material_id, parseFloat(qty), parseFloat(unit_cost) || 0, s.id, location || line.location || 'ATOLYE',
           notes ? `Açılış tamamlama: ${notes}` : 'Açılış tamamlama sayımı']
        )
        await client.query(`
          UPDATE materials
          SET current_stock = current_stock + $1,
              avg_cost = COALESCE((current_stock * avg_cost + $1 * $2) / NULLIF(current_stock + $1, 0), avg_cost)
          WHERE id = $3`,
          [parseFloat(qty), parseFloat(unit_cost) || 0, line.material_id]
        )
      }

      await client.query('COMMIT')
      invalidateOpeningCache()
      res.json(rows[0])
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  } catch (e) { next(e) }
})

router.get('/finished', async (_req, res, next) => {
  try {
    const s = await getLatestSession()
    if (!s) return res.json([])
    const { rows } = await query(`
      SELECT l.*, p.code AS product_code, p.name AS product_name
      FROM opening_lines l JOIN products p ON p.id = l.product_id
      WHERE l.session_id=$1 AND l.section='finished_good' ORDER BY p.code, l.id`, [s.id])
    res.json(rows)
  } catch (e) { next(e) }
})

// material_config gerçek malzeme kayıtlarına karşı doğrulanır
async function buildMaterialConfig({ main_leather_id, secondary_leather_id }) {
  const ids = [main_leather_id, secondary_leather_id].filter(Boolean)
  if (!main_leather_id) throw Object.assign(new Error('Ana deri (MAIN_LEATHER) zorunlu'), { status: 400 })
  const { rows } = await query('SELECT id, sku FROM materials WHERE id = ANY($1::int[])', [ids])
  const bySku = Object.fromEntries(rows.map(r => [r.id, r.sku]))
  for (const id of ids) {
    if (!bySku[id]) throw Object.assign(new Error(`Malzeme bulunamadı: ${id}`), { status: 400 })
  }
  return {
    slots: {
      MAIN_LEATHER: { material_id: main_leather_id, sku: bySku[main_leather_id] },
      SECONDARY_LEATHER: secondary_leather_id
        ? { material_id: secondary_leather_id, sku: bySku[secondary_leather_id] } : null,
    },
    source: 'OPENING',
  }
}

router.post('/finished', async (req, res, next) => {
  try {
    const s = await getLatestSession()
    if (!s) return res.status(404).json({ error: 'Açılış oturumu bulunamadı' })
    if (s.locked_at !== null || s.status === 'completed') {
      return res.status(409).json({ error: 'Açılış kilitlenmiş' })
    }
    const { product_id, quantity, unit_cost, location, notes } = req.body
    if (!product_id || !(quantity > 0)) {
      return res.status(400).json({ error: 'Ürün ve adet zorunlu' })
    }
    const config = await buildMaterialConfig(req.body)
    const ref = `${product_id}-${config.slots.MAIN_LEATHER.sku}-${config.slots.SECONDARY_LEATHER?.sku || 'NONE'}-${location || 'ATOLYE'}`
    const { rows } = await query(`
      INSERT INTO opening_lines (session_id, section, ref_key, product_id, counted_qty,
        unit_cost, material_config, location, notes, status, counted_at)
      VALUES ($1,'finished_good',$2,$3,$4,$5,$6,$7,$8,'counted',NOW())
      ON CONFLICT (session_id, section, ref_key) DO UPDATE SET
        counted_qty = opening_lines.counted_qty + EXCLUDED.counted_qty,
        unit_cost = EXCLUDED.unit_cost, notes = EXCLUDED.notes, updated_at = NOW()
      RETURNING *`,
      [s.id, ref, product_id, quantity, unit_cost ?? 0,
       JSON.stringify(config), location || 'ATOLYE', notes ?? null])
    if (s.status === 'open' && quantity > 0) {
      await query(`
        INSERT INTO production_outputs (job_id, product_id, quantity, material_config,
          unit_cost, available_qty, produced_at, source, opening_line_id)
        VALUES (NULL,$1,$2,$3,$4,$2,NOW(),'OPENING',$5)`,
        [product_id, quantity, JSON.stringify(config), unit_cost ?? 0, rows[0].id]
      )
    }
    invalidateOpeningCache()
    res.status(201).json(rows[0])
  } catch (e) { next(e) }
})

router.delete('/finished/:lineId', async (req, res, next) => {
  try {
    const s = await getLatestSession()
    if (!s) return res.status(404).json({ error: 'Açılış oturumu bulunamadı' })
    if (s.locked_at !== null || s.status === 'completed') {
      return res.status(409).json({ error: 'Açılış kilitlenmiş' })
    }
    await query(`DELETE FROM production_outputs WHERE opening_line_id=$1 AND source='OPENING'`, [req.params.lineId])
    await query(`DELETE FROM opening_lines WHERE id=$1 AND session_id=$2 AND section='finished_good'`,
      [req.params.lineId, s.id])
    invalidateOpeningCache()
    res.json({ ok: true })
  } catch (e) { next(e) }
})

router.get('/accounts', async (_req, res, next) => {
  try {
    const s = await getLatestSession()
    if (!s) return res.json([])
    const { rows } = await query(`
      SELECT l.id, l.account_id, a.name, a.account_type, a.balance AS current_balance,
             l.amount, l.notes
      FROM opening_lines l JOIN accounts a ON a.id = l.account_id
      WHERE l.session_id=$1 AND l.section='account' ORDER BY a.id`, [s.id])
    res.json(rows)
  } catch (e) { next(e) }
})

router.get('/receivables', async (_req, res, next) => {
  try {
    const s = await getLatestSession()
    if (!s) return res.json([])
    const { rows } = await query(`
      SELECT l.id, l.order_id, l.amount, l.previous_value, l.status, l.notes,
             o.order_no, o.order_ref, c.name AS customer_name,
             o.total_amount, o.paid_amount, o.order_date
      FROM opening_lines l
      JOIN orders o ON o.id = l.order_id
      JOIN customers c ON c.id = o.customer_id
      WHERE l.session_id=$1 AND l.section='receivable' ORDER BY o.order_date`, [s.id])
    res.json(rows)
  } catch (e) { next(e) }
})

router.get('/suppliers', async (_req, res, next) => {
  try {
    const s = await getLatestSession()
    if (!s) return res.json([])
    const { rows } = await query(`
      SELECT l.id, l.supplier_id, sup.name, l.amount, l.previous_value, l.notes,
             (SELECT COALESCE(SUM(p.paid_amount), 0) FROM purchases p WHERE p.supplier_id = sup.id) AS historical_spend
      FROM opening_lines l JOIN suppliers sup ON sup.id = l.supplier_id
      WHERE l.session_id=$1 AND l.section='supplier_debt' ORDER BY sup.name`, [s.id])
    res.json(rows)
  } catch (e) { next(e) }
})

router.get('/founder', async (_req, res, next) => {
  try {
    const s = await getLatestSession()
    if (!s) return res.json(null)
    const { rows } = await query(
      `SELECT * FROM opening_lines WHERE session_id=$1 AND section='founder'`, [s.id])
    res.json(rows[0] || null)
  } catch (e) { next(e) }
})

// Tutar/durum güncellemesi — account, receivable, supplier_debt, founder ortak
router.put('/lines/:lineId', async (req, res, next) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const s = await getLatestSession()
    if (!s) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Açılış oturumu bulunamadı' })
    }
    if (s.locked_at !== null || s.status === 'completed') {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: 'Açılış kilitlenmiş' })
    }
    const { rows: lines } = await client.query(
      `SELECT * FROM opening_lines WHERE id=$1 AND session_id=$2 FOR UPDATE`,
      [req.params.lineId, s.id]
    )
    if (!lines.length) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Satır bulunamadı' })
    }
    const line = lines[0]

    // open modunda doğrulanmış satırlar dondurulur; henüz doğrulanmamışlar tamamlanabilir
    if (s.status === 'open') {
      if (['account', 'supplier_debt'].includes(line.section) && line.amount !== null) {
        await client.query('ROLLBACK')
        return res.status(403).json({
          error: 'Bu satır açılışta zaten doğrulanmıştır; operasyonel modda değiştirilemez.'
        })
      }
      if (line.section === 'receivable' && ['confirmed', 'closed'].includes(line.status)) {
        await client.query('ROLLBACK')
        return res.status(403).json({
          error: 'Bu alacak kaydı açılışta zaten teyit edilmiştir; operasyonel modda değiştirilemez.'
        })
      }
    }

    const { amount, status, notes } = req.body
    const amt = amount === '' || amount === undefined ? null : amount
    const { rows } = await client.query(`
      UPDATE opening_lines SET
        amount=$3, status=$4, notes=$5, updated_at=NOW()
      WHERE id=$1 AND session_id=$2
        AND section IN ('account','receivable','supplier_debt','founder')
      RETURNING *`, [req.params.lineId, s.id, amt, status ?? null, notes ?? null])
    if (!rows.length) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Satır bulunamadı' })
    }

    // open modunda sonradan tamamlanan finans/tedarikçi açılışı canlıya işlenir
    if (s.status === 'open' && amt !== null) {
      if (line.section === 'account' && line.amount === null) {
        const num = parseFloat(amt) || 0
        await client.query(`
          INSERT INTO transactions (account_id, amount, transaction_type, reference_type,
            reference_id, description, transaction_date)
          VALUES ($1, $2, 'opening_balance', 'OPENING', $3, 'Açılış bakiyesi', $4)`,
          [line.account_id, num, s.id, s.go_live_date])
        await client.query('UPDATE accounts SET balance = balance + $2 WHERE id=$1',
          [line.account_id, num])
      } else if (line.section === 'supplier_debt' && line.amount === null) {
        const num = parseFloat(amt) || 0
        await client.query('UPDATE suppliers SET total_debt = total_debt + $2 WHERE id=$1',
          [line.supplier_id, num])
      }
    }

    await client.query('COMMIT')
    invalidateOpeningCache()
    res.json(rows[0])
  } catch (e) {
    await client.query('ROLLBACK')
    next(e)
  } finally {
    client.release()
  }
})

// --- 7. Demirbaşlar ---------------------------------------------------------

function depreciation({ purchase_cost, in_service_date, useful_life_months }, goLiveDate) {
  const cost = parseFloat(purchase_cost) || 0
  const life = parseInt(useful_life_months, 10) || 60
  if (!cost || !in_service_date || !goLiveDate) {
    return { accumulated: 0, carrying: cost }
  }
  const s = new Date(in_service_date)
  const g = new Date(goLiveDate)
  let months = (g.getFullYear() - s.getFullYear()) * 12 + (g.getMonth() - s.getMonth())
  if (months < 0) months = 0
  if (months > life) months = life
  const accumulated = Math.round((cost / life) * months * 100) / 100
  const carrying = Math.max(0, Math.round((cost - accumulated) * 100) / 100)
  return { accumulated, carrying, months_used: months }
}

router.get('/assets', async (_req, res, next) => {
  try {
    const s = await getLatestSession()
    if (!s) return res.json([])
    const { rows } = await query(
      'SELECT * FROM fixed_assets WHERE session_id=$1 ORDER BY name', [s.id])
    res.json(rows)
  } catch (e) { next(e) }
})

router.post('/assets', async (req, res, next) => {
  try {
    const s = await getLatestSession()
    if (!s) return res.status(404).json({ error: 'Açılış oturumu bulunamadı' })
    if (s.locked_at !== null || s.status === 'completed') {
      return res.status(409).json({ error: 'Açılış kilitlenmiş' })
    }
    const b = req.body
    if (!b.name) return res.status(400).json({ error: 'Demirbaş adı zorunlu' })
    // Kullanıcı elle girdiyse ona saygı duy, girmediyse hesapla
    let acc = b.opening_accumulated_depreciation
    let carry = b.opening_carrying_value
    if (acc === null || acc === undefined || carry === null || carry === undefined) {
      const calc = depreciation(b, s.go_live_date)
      acc = acc ?? calc.accumulated
      carry = carry ?? calc.carrying
    }
    const { rows } = await query(`
      INSERT INTO fixed_assets (session_id, name, category, purchase_date, purchase_cost,
        in_service_date, useful_life_months, opening_accumulated_depreciation,
        opening_carrying_value, payment_source, status, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [s.id, b.name, b.category ?? null, b.purchase_date || null, b.purchase_cost ?? 0,
       b.in_service_date || null, b.useful_life_months ?? null, acc, carry,
       b.payment_source ?? null, b.status || 'active', b.notes ?? null])
    invalidateOpeningCache()
    res.status(201).json(rows[0])
  } catch (e) { next(e) }
})

router.delete('/assets/:id', async (req, res, next) => {
  try {
    const s = await getLatestSession()
    if (!s) return res.status(404).json({ error: 'Açılış oturumu bulunamadı' })
    if (s.locked_at !== null || s.status === 'completed') {
      return res.status(409).json({ error: 'Açılış kilitlenmiş' })
    }
    await query('DELETE FROM fixed_assets WHERE id=$1 AND session_id=$2', [req.params.id, s.id])
    invalidateOpeningCache()
    res.json({ ok: true })
  } catch (e) { next(e) }
})

// Amortisman önizlemesi (kaydetmeden)
router.post('/assets/preview', async (req, res, next) => {
  try {
    const s = await getLatestSession()
    res.json(depreciation(req.body, s?.go_live_date))
  } catch (e) { next(e) }
})

// --- KİLİT ------------------------------------------------------------------
// Tek transaction. Tarihsel kayıtlara dokunulmaz.
// Yazılan her satır: reference_type='OPENING', reference_id=session, tarih=go_live.

router.post('/lock', async (req, res, next) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // FOR UPDATE: eş zamanlı çift kilitleme engellenir
    const { rows: sessRows } = await client.query(
      `SELECT id,
              TO_CHAR(go_live_date, 'YYYY-MM-DD') AS go_live_date,
              status, confirmations, locked_at, locked_by, notes, created_at
       FROM opening_sessions WHERE locked_at IS NULL ORDER BY id DESC LIMIT 1 FOR UPDATE NOWAIT`)
    const session = sessRows[0] || null
    if (!session) {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: 'Açılış zaten kilitlenmiş veya bulunamadı' })
    }
    const checklist = await buildChecklist(session)
    const missing = checklist.filter(c => !c.done)
    if (missing.length) {
      await client.query('ROLLBACK')
      return res.status(400).json({
        error: 'Eksik bölümler var: ' + missing.map(m => m.label).join(', ') })
    }
    if (!session.go_live_date || !isValidGoLiveDate(session.go_live_date)) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'Geçerli bir Go-live tarihi gerekli' })
    }

    const goLive = session.go_live_date
    const { rows: lines } = await client.query(
      'SELECT * FROM opening_lines WHERE session_id=$1', [session.id])
    const of = s => lines.filter(l => l.section === s)

    // 1) Ham madde — henüz stock_movement oluşturulmamış sayılan kalemler
    for (const l of of('material')) {
      const qty = parseFloat(l.counted_qty)
      if (qty > 0) {
        const { rows: existingMovements } = await client.query(
          `SELECT id FROM stock_movements WHERE reference_type IN ('OPENING', 'OPENING_COMPLETION') AND reference_id = $1 AND material_id = $2`,
          [session.id, l.material_id]
        )
        if (!existingMovements.length) {
          await client.query(`
            INSERT INTO stock_movements (material_id, movement_type, quantity, unit_cost,
              reference_type, reference_id, location, notes, created_at)
            VALUES ($1,'opening_in',$2,$3,'OPENING',$4,$5,$6,$7)`,
            [l.material_id, qty, l.unit_cost ?? 0, session.id, l.location || 'ATOLYE',
             'Açılış sayımı', goLive])
          await client.query(
            'UPDATE materials SET current_stock = current_stock + $2, avg_cost = COALESCE($3, avg_cost) WHERE id = $1',
            [l.material_id, qty, l.unit_cost])
        }
      }
    }

    // 2) Hazır ürün — henüz production_outputs oluşturulmamış açılış lotu
    for (const l of of('finished_good')) {
      const qty = parseInt(l.counted_qty, 10)
      if (!(qty > 0)) continue
      const { rows: existingOutputs } = await client.query(
        `SELECT id FROM production_outputs WHERE opening_line_id = $1`, [l.id]
      )
      if (!existingOutputs.length) {
        await client.query(`
          INSERT INTO production_outputs (job_id, product_id, quantity, material_config,
            unit_cost, available_qty, produced_at, source, opening_line_id)
          VALUES (NULL,$1,$2,$3,$4,$2,$5,'OPENING',$6)`,
          [l.product_id, qty, l.material_config, l.unit_cost ?? 0, goLive, l.id])
      }
    }

    // 3) Kasa/Banka — işlem görmemiş açılış hesap bakiyeleri
    for (const l of of('account')) {
      const amt = parseFloat(l.amount) || 0
      const { rows: existingTx } = await client.query(
        `SELECT id FROM transactions WHERE reference_type = 'OPENING' AND reference_id = $1 AND account_id = $2`,
        [session.id, l.account_id]
      )
      if (!existingTx.length) {
        await client.query(`
          INSERT INTO transactions (account_id, amount, transaction_type, reference_type,
            reference_id, description, transaction_date)
          VALUES ($1,$2,'opening_balance','OPENING',$3,$4,$5)`,
          [l.account_id, amt, session.id, 'Açılış bakiyesi', goLive])
        await client.query('UPDATE accounts SET balance = balance + $2 WHERE id=$1',
          [l.account_id, amt])
      }
    }

    // 4) Müşteri alacakları — orders TABLOSUNA DOKUNULMAZ.
    await client.query(`
      UPDATE opening_lines SET status='confirmed', updated_at=NOW()
      WHERE session_id=$1 AND section='receivable' AND status='confirmed'`, [session.id])

    // 5) Tedarikçi borçları — sistem open moduna girmeden doğrudan lock edildiyse borçları işle
    if (session.status !== 'open') {
      for (const l of of('supplier_debt')) {
        await client.query('UPDATE suppliers SET total_debt=$2 WHERE id=$1',
          [l.supplier_id, parseFloat(l.amount) || 0])
      }
    }

    // 6) Kurucu finansmanı ve Demirbaşlar — kayıt defteri

    await client.query(
      `UPDATE opening_sessions SET status='completed', locked_at=NOW(), locked_by=$2 WHERE id=$1`,
      [session.id, req.user?.id ?? null])

    await client.query('COMMIT')
    invalidateOpeningCache()
    res.json({ ok: true, session_id: session.id, go_live_date: goLive, state: 'completed' })
  } catch (e) {
    await client.query('ROLLBACK')
    next(e)
  } finally { client.release() }
})

export default router

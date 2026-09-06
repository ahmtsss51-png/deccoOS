import { Router } from 'express'
import { pool, query } from '../db.js'
import { invalidateOpeningCache } from '../opening-guard.js'

const router = Router()

// Sıfır cevabı geçerli olan bölümler açık onay ister
const CONFIRMABLE = ['finished_goods', 'assets']

// --- Oturum yardımcıları ----------------------------------------------------

async function getOpenSession(client = { query }) {
  const { rows } = await client.query(
    'SELECT * FROM opening_sessions WHERE locked_at IS NULL ORDER BY id DESC LIMIT 1')
  return rows[0] || null
}

async function ensureSession() {
  const existing = await getOpenSession()
  if (existing) return existing
  const { rows: locked } = await query('SELECT id FROM opening_sessions WHERE locked_at IS NOT NULL LIMIT 1')
  if (locked.length) return null   // sistem açılmış, yeni oturum açılmaz
  const { rows } = await query('INSERT INTO opening_sessions DEFAULT VALUES RETURNING *')
  return rows[0]
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

  return [
    { key: 'materials', label: 'Ham madde sayımı',
      done: materials.length > 0 && countedMat === materials.length,
      detail: `${countedMat} / ${materials.length} kalem sayıldı` },
    { key: 'finished_goods', label: 'Hazır ürün sayımı',
      done: !!conf.finished_goods,
      detail: finished.length ? `${finished.length} lot girildi` : 'Kayıt yok — onay gerekli' },
    { key: 'accounts', label: 'Kasa / Banka',
      done: accounts.length > 0 && accounts.every(a => a.amount !== null),
      detail: `${accounts.filter(a => a.amount !== null).length} / ${accounts.length} hesap girildi` },
    { key: 'receivables', label: 'Müşteri alacakları',
      done: receivables.every(r => ['confirmed', 'closed'].includes(r.status)),
      detail: `${receivables.filter(r => ['confirmed', 'closed'].includes(r.status)).length} / ${receivables.length} sipariş teyit edildi` },
    { key: 'supplier_debts', label: 'Tedarikçi borçları',
      done: debts.every(d => d.amount !== null),
      detail: `${debts.filter(d => d.amount !== null).length} / ${debts.length} tedarikçi girildi` },
    { key: 'founder', label: 'Kurucu finansmanı',
      done: !!founder && founder.amount !== null,
      detail: founder?.amount !== null && founder?.amount !== undefined
        ? 'Tutar onaylandı' : 'Gerçek tutar elle onaylanmalı' },
    { key: 'assets', label: 'Demirbaşlar',
      done: !!conf.assets,
      detail: assets[0].n ? `${assets[0].n} demirbaş girildi` : 'Kayıt yok — onay gerekli' },
    { key: 'go_live', label: 'Go-live tarihi',
      done: !!session.go_live_date,
      detail: session.go_live_date
        ? new Date(session.go_live_date).toLocaleDateString('tr-TR') : 'Seçilmedi' },
  ]
}

// --- Ana durum --------------------------------------------------------------

router.get('/', async (_req, res, next) => {
  try {
    const { rows: lockedRows } = await query(
      'SELECT * FROM opening_sessions WHERE locked_at IS NOT NULL ORDER BY id DESC LIMIT 1')
    if (lockedRows.length) {
      return res.json({ state: 'locked', session: lockedRows[0], checklist: [], progress: 100 })
    }
    const session = await ensureSession()
    await seedLines(session.id)
    const fresh = await getOpenSession()
    const checklist = await buildChecklist(fresh)
    const done = checklist.filter(c => c.done).length
    res.json({
      state: done === checklist.length ? 'ready' : 'draft',
      session: fresh, checklist,
      progress: Math.round((done / checklist.length) * 100),
      done, total: checklist.length,
    })
  } catch (e) { next(e) }
})

router.put('/session', async (req, res, next) => {
  try {
    const session = await getOpenSession()
    if (!session) return res.status(409).json({ error: 'Açılış kilitlenmiş' })
    const { go_live_date, notes, confirm } = req.body
    if (confirm && CONFIRMABLE.includes(confirm.key)) {
      await query(
        `UPDATE opening_sessions SET confirmations = confirmations || $2::jsonb WHERE id=$1`,
        [session.id, JSON.stringify({ [confirm.key]: !!confirm.value })])
    }
    if (go_live_date !== undefined || notes !== undefined) {
      await query(
        `UPDATE opening_sessions SET go_live_date=COALESCE($2,go_live_date), notes=COALESCE($3,notes)
         WHERE id=$1`, [session.id, go_live_date || null, notes ?? null])
    }
    res.json(await getOpenSession())
  } catch (e) { next(e) }
})

// --- Bölüm listeleri --------------------------------------------------------

router.get('/materials', async (_req, res, next) => {
  try {
    const s = await getOpenSession()
    if (!s) return res.json([])
    const { rows } = await query(`
      SELECT l.id, l.material_id, m.sku, m.name, m.unit, m.family, m.color,
             l.counted_qty, l.unit_cost, l.location, l.notes, l.counted_at,
             COALESCE(l.counted_qty,0) * COALESCE(l.unit_cost,0) AS total_value
      FROM opening_lines l JOIN materials m ON m.id = l.material_id
      WHERE l.session_id=$1 AND l.section='material' ORDER BY m.sku`, [s.id])
    res.json(rows)
  } catch (e) { next(e) }
})

// counted_qty: null gönderilirse "sayılmadı"ya döner, 0 gerçek sıfırdır
router.put('/materials/:lineId', async (req, res, next) => {
  try {
    const s = await getOpenSession()
    if (!s) return res.status(409).json({ error: 'Açılış kilitlenmiş' })
    const { counted_qty, unit_cost, location, notes } = req.body
    const qty = counted_qty === '' || counted_qty === undefined ? null : counted_qty
    const { rows } = await query(`
      UPDATE opening_lines SET
        counted_qty=$3, unit_cost=$4, location=COALESCE($5,location), notes=$6,
        counted_at = CASE WHEN $3::numeric IS NULL THEN NULL ELSE NOW() END,
        status     = CASE WHEN $3::numeric IS NULL THEN 'pending' ELSE 'counted' END,
        updated_at = NOW()
      WHERE id=$1 AND session_id=$2 AND section='material' RETURNING *`,
      [req.params.lineId, s.id, qty, unit_cost ?? null, location ?? null, notes ?? null])
    res.json(rows[0])
  } catch (e) { next(e) }
})

router.get('/finished', async (_req, res, next) => {
  try {
    const s = await getOpenSession()
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
    const s = await getOpenSession()
    if (!s) return res.status(409).json({ error: 'Açılış kilitlenmiş' })
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
    res.status(201).json(rows[0])
  } catch (e) { next(e) }
})

router.delete('/finished/:lineId', async (req, res, next) => {
  try {
    const s = await getOpenSession()
    if (!s) return res.status(409).json({ error: 'Açılış kilitlenmiş' })
    await query(`DELETE FROM opening_lines WHERE id=$1 AND session_id=$2 AND section='finished_good'`,
      [req.params.lineId, s.id])
    res.json({ ok: true })
  } catch (e) { next(e) }
})

router.get('/accounts', async (_req, res, next) => {
  try {
    const s = await getOpenSession()
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
    const s = await getOpenSession()
    if (!s) return res.json([])
    const { rows } = await query(`
      SELECT l.id, l.order_id, l.amount, l.previous_value, l.status, l.notes,
             c.name AS customer_name, c.phone, o.notes AS order_ref,
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
    const s = await getOpenSession()
    if (!s) return res.json([])
    const { rows } = await query(`
      SELECT l.id, l.supplier_id, sup.name, l.amount, l.previous_value, l.notes,
             (SELECT COALESCE(-SUM(t.amount),0) FROM transactions t
              WHERE t.reference_type='supplier' AND t.reference_id=sup.id
                AND t.transaction_type='expense') AS historical_spend
      FROM opening_lines l JOIN suppliers sup ON sup.id = l.supplier_id
      WHERE l.session_id=$1 AND l.section='supplier_debt' ORDER BY sup.name`, [s.id])
    res.json(rows)
  } catch (e) { next(e) }
})

router.get('/founder', async (_req, res, next) => {
  try {
    const s = await getOpenSession()
    if (!s) return res.json(null)
    const { rows } = await query(
      `SELECT * FROM opening_lines WHERE session_id=$1 AND section='founder'`, [s.id])
    res.json(rows[0] || null)
  } catch (e) { next(e) }
})

// Tutar/durum güncellemesi — account, receivable, supplier_debt, founder ortak
router.put('/lines/:lineId', async (req, res, next) => {
  try {
    const s = await getOpenSession()
    if (!s) return res.status(409).json({ error: 'Açılış kilitlenmiş' })
    const { amount, status, notes } = req.body
    const amt = amount === '' || amount === undefined ? null : amount
    const { rows } = await query(`
      UPDATE opening_lines
      SET amount=$3, status=COALESCE($4,status), notes=$5, updated_at=NOW()
      WHERE id=$1 AND session_id=$2
        AND section IN ('account','receivable','supplier_debt','founder')
      RETURNING *`, [req.params.lineId, s.id, amt, status ?? null, notes ?? null])
    if (!rows.length) return res.status(404).json({ error: 'Satır bulunamadı' })
    res.json(rows[0])
  } catch (e) { next(e) }
})

// --- Demirbaşlar ------------------------------------------------------------

// Doğrusal amortisman: go-live tarihine kadar geçen ay kadar birikmiş amortisman.
// Böylece geçmiş demirbaşlarda amortisman go-live'da sıfırdan başlamaz.
function depreciation({ purchase_cost, in_service_date, useful_life_months }, goLive) {
  const cost = parseFloat(purchase_cost) || 0
  const life = parseInt(useful_life_months, 10) || 0
  if (!cost || !life || !in_service_date || !goLive) {
    return { accumulated: 0, carrying: cost }
  }
  const a = new Date(in_service_date), b = new Date(goLive)
  const months = Math.max(0, (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth()))
  const accumulated = Math.min(cost, +(cost / life * months).toFixed(2))
  return { accumulated, carrying: +(cost - accumulated).toFixed(2) }
}

router.get('/assets', async (_req, res, next) => {
  try {
    const s = await getOpenSession()
    if (!s) return res.json([])
    const { rows } = await query(
      'SELECT * FROM fixed_assets WHERE session_id=$1 ORDER BY name', [s.id])
    res.json(rows)
  } catch (e) { next(e) }
})

router.post('/assets', async (req, res, next) => {
  try {
    const s = await getOpenSession()
    if (!s) return res.status(409).json({ error: 'Açılış kilitlenmiş' })
    const b = req.body
    if (!b.name) return res.status(400).json({ error: 'Demirbaş adı zorunlu' })
    // Kullanıcı elle girdiyse ona saygı duy, girmediyse hesapla
    const auto = depreciation(b, s.go_live_date)
    const acc = b.opening_accumulated_depreciation ?? auto.accumulated
    const carry = b.opening_carrying_value ?? +((parseFloat(b.purchase_cost) || 0) - acc).toFixed(2)
    const { rows } = await query(`
      INSERT INTO fixed_assets (session_id, name, category, purchase_date, purchase_cost,
        in_service_date, useful_life_months, opening_accumulated_depreciation,
        opening_carrying_value, payment_source, status, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [s.id, b.name, b.category ?? null, b.purchase_date || null, b.purchase_cost ?? 0,
       b.in_service_date || null, b.useful_life_months ?? null, acc, carry,
       b.payment_source ?? null, b.status || 'active', b.notes ?? null])
    res.status(201).json(rows[0])
  } catch (e) { next(e) }
})

router.delete('/assets/:id', async (req, res, next) => {
  try {
    const s = await getOpenSession()
    if (!s) return res.status(409).json({ error: 'Açılış kilitlenmiş' })
    await query('DELETE FROM fixed_assets WHERE id=$1 AND session_id=$2', [req.params.id, s.id])
    res.json({ ok: true })
  } catch (e) { next(e) }
})

// Amortisman önizlemesi (kaydetmeden)
router.post('/assets/preview', async (req, res, next) => {
  try {
    const s = await getOpenSession()
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
    const session = await getOpenSession(client)
    if (!session) {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: 'Açılış zaten kilitlenmiş' })
    }
    const checklist = await buildChecklist(session)
    const missing = checklist.filter(c => !c.done)
    if (missing.length) {
      await client.query('ROLLBACK')
      return res.status(400).json({
        error: 'Eksik bölümler var: ' + missing.map(m => m.label).join(', ') })
    }

    const goLive = session.go_live_date
    const { rows: lines } = await client.query(
      'SELECT * FROM opening_lines WHERE session_id=$1', [session.id])
    const of = s => lines.filter(l => l.section === s)

    // 1) Ham madde — sayılan her kalem. 0 sayım hareket yaratmaz ama sayılmış sayılır.
    for (const l of of('material')) {
      const qty = parseFloat(l.counted_qty)
      if (qty > 0) {
        await client.query(`
          INSERT INTO stock_movements (material_id, movement_type, quantity, unit_cost,
            reference_type, reference_id, location, notes, created_at)
          VALUES ($1,'opening_in',$2,$3,'OPENING',$4,$5,$6,$7)`,
          [l.material_id, qty, l.unit_cost ?? 0, session.id, l.location,
           'Açılış sayımı', goLive])
      }
      await client.query(
        'UPDATE materials SET current_stock=$2, avg_cost=COALESCE($3,avg_cost) WHERE id=$1',
        [l.material_id, qty, l.unit_cost])
    }

    // 2) Hazır ürün — üretim işi olmayan açılış lotu
    for (const l of of('finished_good')) {
      const qty = parseInt(l.counted_qty, 10)
      if (!(qty > 0)) continue
      await client.query(`
        INSERT INTO production_outputs (job_id, product_id, quantity, material_config,
          unit_cost, available_qty, produced_at, source, opening_line_id)
        VALUES (NULL,$1,$2,$3,$4,$2,$5,'OPENING',$6)`,
        [l.product_id, qty, l.material_config, l.unit_cost ?? 0, goLive, l.id])
    }

    // 3) Kasa/Banka — doğrudan balance set edilmez, transaction üzerinden işlenir
    for (const l of of('account')) {
      const amt = parseFloat(l.amount) || 0
      await client.query(`
        INSERT INTO transactions (account_id, amount, transaction_type, reference_type,
          reference_id, description, transaction_date)
        VALUES ($1,$2,'opening_balance','OPENING',$3,$4,$5)`,
        [l.account_id, amt, session.id, 'Açılış bakiyesi', goLive])
      await client.query('UPDATE accounts SET balance = balance + $2 WHERE id=$1',
        [l.account_id, amt])
    }

    // 4) Müşteri alacakları — orders TABLOSUNA DOKUNULMAZ.
    //    Tarihsel paid_amount korunur; açılış kalanı opening_lines'ta iz olarak durur.
    await client.query(`
      UPDATE opening_lines SET status='confirmed', updated_at=NOW()
      WHERE session_id=$1 AND section='receivable' AND status='confirmed'`, [session.id])

    // 5) Tedarikçi borçları — önceki değer previous_value'da saklı kalır
    for (const l of of('supplier_debt')) {
      await client.query('UPDATE suppliers SET total_debt=$2 WHERE id=$1',
        [l.supplier_id, parseFloat(l.amount) || 0])
    }

    // 6) Kurucu finansmanı — founder_funding transaction'ı YARATILMAZ.
    //    Go-live günü yeni para girmediği için bu bir OPENING yükümlülüğüdür.

    // 7) Demirbaşlar — para/gider hareketi yaratmaz, yalnız kayıt defteri

    await client.query(
      `UPDATE opening_sessions SET status='locked', locked_at=NOW(), locked_by=$2 WHERE id=$1`,
      [session.id, req.user?.id ?? null])

    await client.query('COMMIT')
    invalidateOpeningCache()
    res.json({ ok: true, session_id: session.id, go_live_date: goLive })
  } catch (e) {
    await client.query('ROLLBACK')
    next(e)
  } finally { client.release() }
})

export default router

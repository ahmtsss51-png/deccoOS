import { query } from './db.js'

let cachedSession = null

export function invalidateOpeningCache() {
  cachedSession = null
}

export async function getOpeningSession() {
  if (cachedSession !== null) return cachedSession
  const { rows } = await query(
    `SELECT id, TO_CHAR(go_live_date, 'YYYY-MM-DD') AS go_live_date,
            status, locked_at, confirmations
     FROM opening_sessions ORDER BY id DESC LIMIT 1`
  )
  cachedSession = rows[0] || null
  return cachedSession
}

export async function getOpeningState() {
  const s = await getOpeningSession()
  if (!s) return 'draft'
  if (s.locked_at !== null || s.status === 'completed') return 'completed'
  if (s.status === 'open') return 'open'
  return 'draft'
}

export async function isSystemOpen() {
  const state = await getOpeningState()
  return state === 'open' || state === 'completed'
}

export async function requireOpened(req, res, next) {
  if (req.method === 'GET') return next()
  try {
    if (await isSystemOpen()) return next()
    res.status(423).json({
      error: 'Sistem PRE-OPENING modunda. Bu işlem için önce Açılış ekranından ' +
             'gerçek başlangıç durumunu kaydedip açılışı başlatmalısınız.',
      state: 'pre_opening',
    })
  } catch (e) { next(e) }
}

function capabilityError(msg) {
  const err = new Error(msg)
  err.status = 400
  return err
}

// 1. Kasa/Banka opening doğrulanmamış hesaplarda customer payment, expense ve transfer engellensin.
// Go-live sonrasında oluşturulan yeni finance account için opening doğrulaması aranmasın.
export async function assertAccountReady(accountId) {
  if (!accountId) return
  const s = await getOpeningSession()
  if (!s || s.status !== 'open') return
  const { rows } = await query(
    `SELECT amount FROM opening_lines
     WHERE session_id = $1 AND section = 'account' AND account_id = $2`,
    [s.id, accountId]
  )
  if (rows.length > 0 && rows[0].amount === null) {
    throw capabilityError('Bu kasa/banka hesabının açılış bakiyesi henüz doğrulanmamıştır (Açılış Verilerini Tamamla).')
  }
}

// 2. Supplier opening payable doğrulanmamış tedarikçide payment/return/discount ve mutasyon engellensin.
// Go-live sonrası oluşturulan supplier opening payable doğrulaması gerektirmeden çalışabilmeli.
export async function assertSupplierReady(supplierId) {
  if (!supplierId) return
  const s = await getOpeningSession()
  if (!s || s.status !== 'open') return
  const { rows } = await query(
    `SELECT amount FROM opening_lines
     WHERE session_id = $1 AND section = 'supplier_debt' AND supplier_id = $2`,
    [s.id, supplierId]
  )
  if (rows.length > 0 && rows[0].amount === null) {
    throw capabilityError('Bu tedarikçinin açılış borç bakiyesi henüz doğrulanmamıştır (Açılış Verilerini Tamamla).')
  }
}

// 3. Historical customer receivable guard:
// order_date < go_live_date olan opening kapsamındaki siparişlere uygulanmalı. Go-live sonrası order'lara uygulanmamalı.
export async function assertOrderPayable(orderId) {
  if (!orderId) return
  const s = await getOpeningSession()
  if (!s || s.status !== 'open') return
  const { rows: orderRows } = await query(
    `SELECT TO_CHAR(order_date, 'YYYY-MM-DD') AS order_date FROM orders WHERE id = $1`,
    [orderId]
  )
  if (!orderRows.length) return
  const order = orderRows[0]
  if (s.go_live_date && order.order_date) {
    if (order.order_date < s.go_live_date) {
      const { rows: lineRows } = await query(
        `SELECT status FROM opening_lines
         WHERE session_id = $1 AND section = 'receivable' AND order_id = $2`,
        [s.id, orderId]
      )
      if (lineRows.length > 0 && !['confirmed', 'closed'].includes(lineRows[0].status)) {
        throw capabilityError('Bu tarihsel siparişin açılış alacak kaydı henüz teyit edilmemiştir (Açılış Verilerini Tamamla).')
      }
    }
  }
}

// 4. Material guard:
// Opening checklist'te bulunan material: counted_at IS NULL -> Sayılmadı -> kullanılamaz.
// Go-live sonrası oluşturulan yeni material için opening_line bulunmaz -> opening sayımı istenmez, normal stok olarak kullanılabilir.
export async function assertMaterialCounted(materialId) {
  if (!materialId) return
  const s = await getOpeningSession()
  if (!s || s.status !== 'open') return
  const { rows } = await query(
    `SELECT counted_at FROM opening_lines
     WHERE session_id = $1 AND section = 'material' AND material_id = $2`,
    [s.id, materialId]
  )
  if (rows.length > 0 && rows[0].counted_at === null) {
    throw capabilityError('Bu malzemenin açılış sayımı henüz yapılmamıştır (Açılış Verilerini Tamamla).')
  }
}

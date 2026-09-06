// PRE-OPENING modu
// Açılış kilitlenene kadar canlı stok/finans hareketlerine izin verilmez.
// Böylece açılış sayımı, arada oluşan günlük hareketlerle karışmaz.
import { query } from './db.js'

let cache = null

export function invalidateOpeningCache() { cache = null }

export async function isSystemOpen() {
  if (cache !== null) return cache
  const { rows } = await query(
    'SELECT 1 FROM opening_sessions WHERE locked_at IS NOT NULL LIMIT 1')
  cache = rows.length > 0
  return cache
}

// Sadece yazma isteklerini engeller; okuma her zaman serbest
export async function requireOpened(req, res, next) {
  if (req.method === 'GET') return next()
  try {
    if (await isSystemOpen()) return next()
    res.status(423).json({
      error: 'Sistem PRE-OPENING modunda. Bu işlem için önce Açılış ekranından ' +
             'gerçek başlangıç durumunu kaydedip açılışı kilitlemelisiniz.',
      state: 'pre_opening',
    })
  } catch (e) { next(e) }
}

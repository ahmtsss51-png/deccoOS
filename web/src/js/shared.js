// Decco OS — Ortak yardımcı fonksiyonlar

// Oturum yönetimi
export function getToken() { return localStorage.getItem('decco_token') }
export function getUser()  { try { return JSON.parse(localStorage.getItem('decco_user') || 'null') } catch { return null } }

export function requireAuth() {
  if (!getToken()) { window.location.href = '/login.html'; return false }
  return true
}

export function logout() {
  localStorage.removeItem('decco_token')
  localStorage.removeItem('decco_user')
  window.location.href = '/login.html'
}

// API fetch wrapper
export async function api(path, opts = {}) {
  const token = getToken()
  const res = await fetch('/api' + path, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...opts.headers,
    },
    ...opts,
    body: opts.body !== undefined
      ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body))
      : undefined,
  })
  if (res.status === 401) { logout(); return }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || 'Sunucu hatası')
  return data
}

// Para formatı
export function money(val) {
  const n = parseFloat(val) || 0
  return '₺' + n.toLocaleString('tr-TR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}

// Tarih formatı
export function fmtDate(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', year: 'numeric' })
}

// Durum chip HTML
export function chip(status) {
  const map = {
    draft:             ['chip-gray',   'Taslak'],
    payment_pending:   ['chip-yellow', 'Ödeme Bekliyor'],
    confirmed:         ['chip-blue',   'Onaylandı'],
    production_pending:['chip-yellow', 'Üretim Bekliyor'],
    in_production:     ['chip-blue',   'Üretimde'],
    quality_check:     ['chip-purple', 'Kalite Kontrol'],
    ready:             ['chip-green',  'Hazır'],
    shipped:           ['chip-green',  'Kargolandı'],
    completed:         ['chip-gray',   'Tamamlandı'],
    cancelled:         ['chip-red',    'İptal'],
    // üretim
    pending:           ['chip-yellow', 'Bekliyor'],
    in_progress:       ['chip-blue',   'Üretimde'],
  }
  const [cls, label] = map[status] || ['chip-gray', status]
  return `<span class="chip ${cls}">${label}</span>`
}

// Toast bildirimi
export function toast(msg, type = 'success') {
  let container = document.getElementById('toast-container')
  if (!container) {
    container = document.createElement('div')
    container.id = 'toast-container'
    document.body.appendChild(container)
  }
  const el = document.createElement('div')
  el.className = `toast toast-${type}`
  el.textContent = msg
  container.appendChild(el)
  setTimeout(() => el.remove(), 3500)
}

// Modal
export function openModal(html, size = '') {
  let overlay = document.getElementById('modal-overlay')
  if (!overlay) {
    overlay = document.createElement('div')
    overlay.id = 'modal-overlay'
    overlay.className = 'modal-overlay'
    overlay.addEventListener('click', e => { if (e.target === overlay) closeModal() })
    document.body.appendChild(overlay)
  }
  overlay.style.pointerEvents = ''
  overlay.innerHTML = `<div class="modal ${size}">${html}</div>`
  requestAnimationFrame(() => overlay.classList.add('open'))
  const onKey = e => { if (e.key === 'Escape') { closeModal(); document.removeEventListener('keydown', onKey) } }
  document.addEventListener('keydown', onKey)
}

export function closeModal() {
  const overlay = document.getElementById('modal-overlay')
  if (!overlay) return
  overlay.classList.remove('open')
  setTimeout(() => { overlay.innerHTML = ''; overlay.style.pointerEvents = 'none' }, 200)
}

// Tema yönetimi
export function initTheme() {
  const saved = localStorage.getItem('decco_theme') || 'dark'
  document.documentElement.setAttribute('data-theme', saved === 'light' ? 'light' : '')
}

export function toggleTheme() {
  const cur = localStorage.getItem('decco_theme') || 'dark'
  const next = cur === 'dark' ? 'light' : 'dark'
  localStorage.setItem('decco_theme', next)
  document.documentElement.setAttribute('data-theme', next === 'light' ? 'light' : '')
  const btn = document.getElementById('theme-toggle')
  if (btn) btn.textContent = next === 'dark' ? '☀️' : '🌙'
}

// Sidebar inject
export function renderSidebar(active) {
  if (!requireAuth()) return
  initTheme()
  const links = [
    ['dashboard',  '📊', 'Dashboard',    '/dashboard.html'],
    ['orders',     '📋', 'Siparişler',   '/orders.html'],
    ['production', '🔨', 'Üretim',       '/production.html'],
    ['stock',      '📦', 'Stok',         '/stock.html'],
    ['customers',  '👤', 'Müşteriler',   '/customers.html'],
    ['finance',    '💰', 'Finans',       '/finance.html'],
    ['products',   '🎒', 'Ürünler',      '/products.html'],
    ['suppliers',  '🏭', 'Tedarikçiler', '/suppliers.html'],
    ['opening',    '🚀', 'Açılış',       '/opening.html'],
    ['import',     '📂', 'Veri Aktarım', '/import.html'],
    ['reports',    '📈', 'Raporlar',     '/reports.html'],
    ['section',    null, 'Entegrasyonlar', null],
    ['woocommerce','🔌', 'WooCommerce',  '/integrations-woocommerce.html'],
    ['paytr',      '💳', 'PayTR',        '/integrations-paytr.html'],
    ['whatsapp',   '💬', 'WhatsApp',     '/integrations-whatsapp.html'],
    ['section',    null, 'Sistem',         null],
    ['settings',   '⚙️', 'Ayarlar',      '/settings.html'],
  ]
  const theme = localStorage.getItem('decco_theme') || 'dark'
  document.querySelector('.sidebar .nav').innerHTML = links.map(([key, icon, label, href]) => {
    if (key === 'section') {
      return `<div style="font-size:.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text-secondary);padding:10px 18px 4px;opacity:.7">${label}</div>`
    }
    return `<a href="${href}" class="${active === key ? 'active' : ''}"><span class="nav-icon">${icon}</span> ${label}</a>`
  }).join('')
  // Sidebar footer: kullanıcı bilgisi + tema toggle + çıkış
  const footer = document.querySelector('.sidebar-footer')
  if (footer) {
    const user = getUser()
    footer.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <div style="display:flex;align-items:center;gap:7px;min-width:0">
          <div style="width:26px;height:26px;border-radius:50%;background:rgba(34,197,94,.2);display:flex;align-items:center;justify-content:center;font-size:.75rem;font-weight:700;color:var(--primary);flex-shrink:0">
            ${user ? user.full_name.charAt(0).toUpperCase() : '?'}
          </div>
          <div style="min-width:0">
            <div style="font-size:.75rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${user?.full_name || 'Kullanıcı'}</div>
            <div style="font-size:.65rem;color:var(--text-secondary)">${user?.department || user?.role || ''}</div>
          </div>
        </div>
        <div style="display:flex;gap:4px">
          <button id="theme-toggle" title="Tema" style="background:none;border:none;cursor:pointer;font-size:.9rem;padding:4px;opacity:.7;border-radius:5px" onclick="(function(){
            const cur=localStorage.getItem('decco_theme')||'dark';const next=cur==='dark'?'light':'dark';
            localStorage.setItem('decco_theme',next);document.documentElement.setAttribute('data-theme',next==='light'?'light':'');
            document.getElementById('theme-toggle').textContent=next==='dark'?'☀️':'🌙';
          })()">${theme === 'dark' ? '☀️' : '🌙'}</button>
          <button title="Çıkış" onclick="(function(){localStorage.removeItem('decco_token');localStorage.removeItem('decco_user');window.location.href='/login.html';})()" style="background:none;border:none;cursor:pointer;font-size:.85rem;padding:4px;opacity:.7;border-radius:5px;color:var(--text-secondary)">⏻</button>
        </div>
      </div>
      <div style="font-size:.65rem;color:var(--text-secondary)">Decco Deri © 2026</div>
    `
  }
}

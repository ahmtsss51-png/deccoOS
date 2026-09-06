import pg from 'pg'
const { Pool } = pg
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const q = (sql, p) => pool.query(sql, p)

async function seed() {
  console.log('🌱 Seed başlıyor...')

  // ── ÜRÜNLER ─────────────────────────────────────────────────────────────────
  const products = [
    { code: 'DPF001', name: 'Double Portföy Cüzdan',             category: 'cuzdan',  price: 1650 },
    { code: 'DPS001', name: 'Double Portföy Set – Kahve',         category: 'set',     price: 2000 },
    { code: 'CKC001', name: 'Çapraz Katlanır Cüzdan',             category: 'cuzdan',  price: 950  },
    { code: 'KCS001', name: 'Klasik Cüzdan Set – Sarı',           category: 'set',     price: 1450 },
    { code: 'KCS002', name: 'Klasik Cüzdan Set – Siyah',          category: 'set',     price: 1450 },
    { code: 'DZK001', name: 'Deri Zippo Kılıfı – Açık Kahve',    category: 'aksesuar',price: 449  },
    { code: 'DZK002', name: 'Deri Zippo Kılıfı – Siyah',         category: 'aksesuar',price: 449  },
    { code: 'DZK003', name: 'Deri Zippo Kılıfı – Koyu Kahve',    category: 'aksesuar',price: 449  },
    { code: 'DZK004', name: 'Deri Zippo Kılıfı – Desenli Kırmızı', category: 'aksesuar', price: 449 },
    { code: 'PFS001', name: 'Portföy Set – Yeşil',                category: 'set',     price: 1600 },
    { code: 'PFS002', name: 'Portföy Set – Siyah',                category: 'set',     price: 1600 },
    { code: 'MKK001', name: 'Minimal Kompakt Kartlık',            category: 'kartlik', price: 449  },
    { code: 'MDK001', name: 'Minimalist Deri Kartlık',            category: 'kartlik', price: 599  },
    { code: 'EYC001', name: 'El Yapımı Deri Cüzdan – Para Kıskaçlı Kobalt', category: 'cuzdan', price: 749 },
  ]

  for (const p of products) {
    await q(`INSERT INTO products (code,name,base_price) VALUES ($1,$2,$3) ON CONFLICT (code) DO UPDATE SET name=$2,base_price=$3`,
      [p.code, p.name, p.price])
  }
  console.log(`✅ ${products.length} ürün eklendi`)

  // ── MALZEMELER ───────────────────────────────────────────────────────────────
  const materials = [
    // Deriler
    { sku:'CR-SYH', name:'Crazy Horse Siyah',    type:'leather', family:'Crazy Horse', color:'Siyah',      unit:'desi', reorder:20, cost:45 },
    { sku:'CR-KHV', name:'Crazy Horse Kahve',    type:'leather', family:'Crazy Horse', color:'Kahve',      unit:'desi', reorder:20, cost:45 },
    { sku:'CR-YSL', name:'Crazy Horse Yeşil',    type:'leather', family:'Crazy Horse', color:'Yeşil',      unit:'desi', reorder:15, cost:47 },
    { sku:'CR-KBL', name:'Crazy Horse Kobalt',   type:'leather', family:'Crazy Horse', color:'Kobalt',     unit:'desi', reorder:10, cost:47 },
    { sku:'CR-KRM', name:'Crazy Horse Kırmızı',  type:'leather', family:'Crazy Horse', color:'Kırmızı',    unit:'desi', reorder:10, cost:47 },
    { sku:'CR-ACK', name:'Crazy Horse Açık Kahve', type:'leather', family:'Crazy Horse', color:'Açık Kahve', unit:'desi', reorder:15, cost:45 },
    { sku:'PB-SYH', name:'Pueblo Siyah',         type:'leather', family:'Pueblo',      color:'Siyah',      unit:'desi', reorder:15, cost:55 },
    { sku:'PB-KHV', name:'Pueblo Kahve',         type:'leather', family:'Pueblo',      color:'Kahve',      unit:'desi', reorder:15, cost:55 },
    { sku:'KM-YSL', name:'Kaşmir Yeşil',         type:'leather', family:'Kaşmir',      color:'Yeşil',      unit:'desi', reorder:10, cost:60 },
    { sku:'KM-SRL', name:'Kaşmir Sarı',          type:'leather', family:'Kaşmir',      color:'Sarı',       unit:'desi', reorder:10, cost:60 },
    { sku:'DSN-KRM',name:'Desenli Kırmızı Deri', type:'leather', family:'Desenli',     color:'Kırmızı',    unit:'desi', reorder:8,  cost:50 },
    // İplikler
    { sku:'IPL-KHV', name:'Kahve Deri İplik',    type:'thread',  family:null,          color:'Kahve',      unit:'m',    reorder:50, cost:0.8 },
    { sku:'IPL-SYH', name:'Siyah Deri İplik',    type:'thread',  family:null,          color:'Siyah',      unit:'m',    reorder:50, cost:0.8 },
    { sku:'IPL-BEJ', name:'Bej Deri İplik',      type:'thread',  family:null,          color:'Bej',        unit:'m',    reorder:30, cost:0.8 },
    // Yapıştırıcı
    { sku:'YAP-STD', name:'Deri Yapıştırıcı',    type:'adhesive',family:null,          color:null,         unit:'ml',   reorder:200, cost:0.15 },
    // Aksesuarlar
    { sku:'AKS-PRK', name:'Para Kıskaç Metal',   type:'accessory',family:null,         color:'Altın',      unit:'adet', reorder:20, cost:25 },
    { sku:'AKS-CRT', name:'Kart Bölmesi Aparatı',type:'accessory',family:null,         color:null,         unit:'adet', reorder:50, cost:5  },
    // Ambalaj
    { sku:'AMB-KTN', name:'Kraft Kutu',          type:'packaging',family:null,         color:null,         unit:'adet', reorder:30, cost:8  },
    { sku:'AMB-TOR', name:'Bez Torba',           type:'packaging',family:null,         color:null,         unit:'adet', reorder:30, cost:6  },
  ]

  for (const m of materials) {
    await q(`INSERT INTO materials (sku,name,material_type,family,color,unit,reorder_level,avg_cost)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (sku) DO UPDATE SET avg_cost=$8`,
      [m.sku, m.name, m.type, m.family, m.color, m.unit, m.reorder, m.cost])
  }

  // Açılış stok hareketleri
  const opening = [
    { sku:'CR-SYH', qty:80 }, { sku:'CR-KHV', qty:60 }, { sku:'CR-YSL', qty:40 },
    { sku:'CR-KBL', qty:30 }, { sku:'CR-KRM', qty:25 }, { sku:'CR-ACK', qty:45 },
    { sku:'PB-SYH', qty:35 }, { sku:'PB-KHV', qty:35 }, { sku:'KM-YSL', qty:20 },
    { sku:'KM-SRL', qty:18 }, { sku:'DSN-KRM', qty:15 },
    { sku:'IPL-KHV', qty:300 }, { sku:'IPL-SYH', qty:300 }, { sku:'IPL-BEJ', qty:150 },
    { sku:'YAP-STD', qty:2000 },
    { sku:'AKS-PRK', qty:40 }, { sku:'AKS-CRT', qty:120 },
    { sku:'AMB-KTN', qty:80 }, { sku:'AMB-TOR', qty:80 },
  ]

  for (const o of opening) {
    const { rows } = await q('SELECT id, avg_cost FROM materials WHERE sku=$1', [o.sku])
    if (!rows[0]) continue
    await q('UPDATE materials SET current_stock=$1 WHERE id=$2', [o.qty, rows[0].id])
    await q(`INSERT INTO stock_movements (material_id,movement_type,quantity,unit_cost) VALUES ($1,'opening_in',$2,$3)`,
      [rows[0].id, o.qty, rows[0].avg_cost])
  }
  console.log(`✅ ${materials.length} malzeme + açılış stokları eklendi`)

  // ── MÜŞTERİLER ──────────────────────────────────────────────────────────────
  const customers = [
    { name:'Ayşe Kaya',       phone:'0532 111 2233', channel:'instagram', notes:'Genellikle hediye amacıyla alıyor' },
    { name:'Mehmet Yılmaz',   phone:'0544 222 3344', channel:'whatsapp',  notes:'Kurumsal sipariş verebilir' },
    { name:'Zeynep Arslan',   phone:'0555 333 4455', channel:'instagram', notes:null },
    { name:'Burak Şahin',     phone:'0506 444 5566', channel:'web',       notes:'İsim baskısı istiyor' },
    { name:'Selin Çelik',     phone:'0533 555 6677', channel:'whatsapp',  notes:null },
    { name:'Ali Demir',       phone:'0542 666 7788', channel:'direct',    notes:'Atölyeden bizzat teslim alıyor' },
    { name:'Fatma Öztürk',    phone:'0551 777 8899', channel:'instagram', notes:'Çift sipariş verdi daha önce' },
    { name:'Can Erdoğan',     phone:'0530 888 9900', channel:'web',       notes:null },
    { name:'Merve Koç',       phone:'0543 999 0011', channel:'whatsapp',  notes:'Beyaz kargo tercih ediyor' },
    { name:'Hasan Aksoy',     phone:'0507 000 1122', channel:'direct',    notes:null },
  ]

  const custIds = []
  for (const c of customers) {
    const { rows } = await q(`INSERT INTO customers (name,phone,channel,notes)
      VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id`, [c.name, c.phone, c.channel, c.notes])
    if (rows[0]) custIds.push(rows[0].id)
    else {
      const r = await q('SELECT id FROM customers WHERE name=$1', [c.name])
      if (r.rows[0]) custIds.push(r.rows[0].id)
    }
  }
  console.log(`✅ ${customers.length} müşteri eklendi`)

  // ── FİNANS HESAPLARI ────────────────────────────────────────────────────────
  const accounts = [
    { name:'Nakit Kasa',    type:'cash',    balance:12500 },
    { name:'İş Bankası',    type:'bank',    balance:45800 },
    { name:'Kurucu Fonu',   type:'founder', balance:30000 },
  ]
  const accIds = []
  for (const a of accounts) {
    const { rows } = await q(`INSERT INTO accounts (name,account_type,balance) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id`,
      [a.name, a.type, a.balance])
    if (rows[0]) accIds.push({ ...a, id: rows[0].id })
    else {
      const r = await q('SELECT id FROM accounts WHERE name=$1', [a.name])
      if (r.rows[0]) accIds.push({ ...a, id: r.rows[0].id })
    }
  }

  // Birkaç geçmiş işlem
  if (accIds.length >= 2) {
    const kasaId = accIds[0].id
    const bankaId = accIds[1].id
    const txns = [
      { acc: kasaId,  amount:  1650, type:'customer_payment', desc:'Ayşe Kaya – Double Portföy Cüzdan' },
      { acc: kasaId,  amount:   950, type:'customer_payment', desc:'Zeynep Arslan – Çapraz Katlanır Cüzdan' },
      { acc: bankaId, amount:  2000, type:'customer_payment', desc:'Mehmet Yılmaz – Double Portföy Set' },
      { acc: kasaId,  amount: -450,  type:'expense',          desc:'Kargo gideri' },
      { acc: kasaId,  amount: -1200, type:'expense',          desc:'Malzeme alımı – Crazy Horse' },
      { acc: bankaId, amount: -600,  type:'expense',          desc:'Meta reklam' },
    ]
    for (const t of txns) {
      await q(`INSERT INTO transactions (account_id,amount,transaction_type,description) VALUES ($1,$2,$3,$4)`,
        [t.acc, t.amount, t.type, t.desc])
    }
  }
  console.log(`✅ ${accounts.length} hesap + 6 işlem eklendi`)

  // ── SİPARİŞLER ──────────────────────────────────────────────────────────────
  const prodRows = await q('SELECT id,code,base_price FROM products')
  const pMap = {}
  prodRows.rows.forEach(r => { pMap[r.code] = r })

  const orders = [
    { cust:0, status:'completed', paid_pct:1,   items:[ { code:'DPF001', qty:1, note:'Siyah – İsim baskısı: M.Y.' } ] },
    { cust:1, status:'ready',     paid_pct:0.5, items:[ { code:'DPS001', qty:1, note:'Kahve' }, { code:'MKK001', qty:1, note:'' } ] },
    { cust:2, status:'in_production', paid_pct:0, items:[ { code:'CKC001', qty:2, note:'Yeşil' } ] },
    { cust:3, status:'production_pending', paid_pct:1, items:[ { code:'KCS001', qty:1, note:'Sarı – isim baskısı: B.Ş.' } ] },
    { cust:4, status:'payment_pending',  paid_pct:0, items:[ { code:'PFS001', qty:1, note:'Yeşil' } ] },
    { cust:5, status:'shipped',   paid_pct:1,   items:[ { code:'DZK002', qty:2, note:'Siyah' } ] },
    { cust:6, status:'completed', paid_pct:1,   items:[ { code:'EYC001', qty:1, note:'Kobalt' }, { code:'MDK001', qty:1, note:'' } ] },
    { cust:7, status:'confirmed', paid_pct:0.3, items:[ { code:'DPF001', qty:1, note:'' }, { code:'MKK001', qty:2, note:'' } ] },
    { cust:8, status:'production_pending', paid_pct:1, items:[ { code:'KCS002', qty:1, note:'Siyah' } ] },
    { cust:9, status:'ready',     paid_pct:1,   items:[ { code:'DZK001', qty:1, note:'Açık Kahve' }, { code:'DZK004', qty:1, note:'Desenli Kırmızı' } ] },
  ]

  const client = await pool.connect()
  for (let i = 0; i < orders.length; i++) {
    const o = orders[i]
    const custId = custIds[o.cust]
    if (!custId) continue
    try {
      await client.query('BEGIN')
      const total = o.items.reduce((s,it) => s + (pMap[it.code]?.base_price || 0) * it.qty, 0)
      const paid = Math.round(total * o.paid_pct)
      const daysAgo = (orders.length - i) * 3
      const createdAt = new Date(Date.now() - daysAgo * 86400000)
      const { rows: oRows } = await client.query(
        `INSERT INTO orders (customer_id,status,total_amount,paid_amount,created_at,delivery_date)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [custId, o.status, total, paid, createdAt, new Date(Date.now() + (14 - i * 2) * 86400000)]
      )
      const orderId = oRows[0].id
      for (const it of o.items) {
        const prod = pMap[it.code]
        if (!prod) continue
        await client.query(
          `INSERT INTO order_items (order_id,product_id,quantity,unit_price,notes)
           VALUES ($1,$2,$3,$4,$5)`,
          [orderId, prod.id, it.qty, prod.base_price, it.note]
        )
      }
      await client.query('COMMIT')
    } catch(e) { await client.query('ROLLBACK'); console.error('Sipariş hatası:', e.message) }
  }
  client.release()
  console.log(`✅ ${orders.length} sipariş eklendi`)

  // ── ÜRETİM İŞLERİ ───────────────────────────────────────────────────────────
  const jobs = [
    { code:'CKC001', qty:2, status:'in_progress',  mat:'Crazy Horse Yeşil' },
    { code:'KCS001', qty:1, status:'pending',       mat:'Kaşmir Sarı' },
    { code:'KCS002', qty:1, status:'pending',       mat:'Crazy Horse Siyah' },
    { code:'DPF001', qty:1, status:'quality_check', mat:'Pueblo Siyah' },
  ]
  for (const j of jobs) {
    const prod = pMap[j.code]
    if (!prod) continue
    await q(`INSERT INTO production_jobs (product_id,quantity,status,material_selections,notes)
      VALUES ($1,$2,$3,$4,$5)`,
      [prod.id, j.qty, j.status, JSON.stringify({ note: j.mat }), ''])
  }
  console.log(`✅ ${jobs.length} üretim işi eklendi`)

  await pool.end()
  console.log('\n🎉 Seed tamamlandı!')
}

seed().catch(e => { console.error(e); process.exit(1) })

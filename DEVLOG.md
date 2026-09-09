# Decco OS — Geliştirici El Kitabı (AI Handoff)

> Bu dosya başka bir yapay zekanın projeye bağlanıp kaldığı yerden devam edebilmesi için yazılmıştır.
> Son güncelleme: 2026-09-10 · Commit: `94cad0c`

---

## Projeye Giriş

Decco OS, **Decco Deri** adlı küçük el yapımı deri ürünleri atölyesi için geliştirilmiş bir operasyon yönetim sistemidir.
Sipariş → Üretim → Stok → Tedarikçi → Finans zincirini tek bir web uygulamasında toplar.

**Teknoloji yığını:**

| Katman | Teknoloji |
|--------|-----------|
| Frontend | Vanilla HTML/CSS/JS (framework yok) |
| Backend | Node.js 20 / Express / ES Modules (`"type":"module"`) |
| Veritabanı | PostgreSQL 16 |
| Container | Docker Compose (3 servis: `decco_web`, `decco_api`, `decco_db`) |

---

## Çalıştırma

```bash
docker compose up -d        # başlat
docker compose down         # durdur (veri korunur)
docker compose down -v      # durdur + DB sil
docker compose up -d --build api   # API'yi yeniden derle (kod değişikliği sonrası)
```

- Web: `http://localhost`
- API: `http://localhost:3000`
- DB: `localhost:5432` — bağlantı bilgileri `docker-compose.yml` içinde
- Admin girişi: `.env` dosyasına bakın (repoda yok)

---

## Proje Yapısı

```
deccoderi/
├── api/
│   ├── src/
│   │   ├── index.js          ← Express app, route mount'ları, auth/guard middleware
│   │   ├── db.js             ← pool + query helper
│   │   └── routes/
│   │       ├── auth.js
│   │       ├── customers.js
│   │       ├── dashboard.js
│   │       ├── finance.js
│   │       ├── import.js
│   │       ├── materials.js
│   │       ├── opening.js
│   │       ├── orders.js
│   │       ├── production.js
│   │       ├── products.js
│   │       ├── recipes.js
│   │       ├── reports.js
│   │       ├── suppliers.js
│   │       └── users.js
│   └── db/
│       └── schema.sql        ← Tüm tablo tanımları; her boot'ta çalışır (idempotent)
├── web/src/                  ← Statik HTML sayfaları
│   ├── js/shared.js          ← api(), money(), fmtDate(), chip(), openModal(), renderSidebar()
│   ├── css/theme.css         ← Tüm tasarım sistemi (CSS variables, component sınıfları)
│   ├── dashboard.html
│   ├── orders.html
│   ├── customers.html
│   ├── customer-detail.html  ← Müşteri detay sayfası (?id=)
│   ├── suppliers.html
│   ├── supplier-detail.html  ← Tedarikçi detay + cari (?id=)
│   ├── production.html
│   ├── stock.html
│   ├── finance.html
│   ├── products.html
│   ├── materials.html
│   ├── reports.html
│   ├── opening.html          ← Açılış sihirbazı (tek seferlik)
│   ├── settings.html
│   └── login.html
└── docker-compose.yml
```

---

## Kritik Mimari Kararlar

### 1. PRE-OPENING Guard

Sistem iki modda çalışır:
- **PRE-OPENING**: `opening_sessions` tablosunda `locked_at IS NULL` olan satır var → açılış tamamlanmamış
- **OPEN**: `locked_at IS NOT NULL` → sistem canlı

```js
// api/src/index.js
function isSystemOpen() { ... }          // DB'yi sorgular
function requireOpened(req, res, next)   // 423 döner PRE-OPENING'de

// Guard mount'ları — bu route'lar PRE-OPENING'de 423 döner:
app.use('/api/suppliers/:id/payments',  requireOpened)
app.use('/api/suppliers/:id/returns',   requireOpened)
app.use('/api/suppliers/:id/discounts', requireOpened)
app.use('/api/finance/collections',     requireOpened)
// ... (tam liste index.js'te)
```

**Mevcut durum:** Açılış oturumu id=1, `locked_at` dolu → sistem **OPEN** modunda.

### 2. Açılış Sihirbazı (`opening.html`)

Tek seferlik süreç; tamamlandıktan sonra açılış sayfası pasif olur.
Açılış oturumunu kilitleyen endpoint: `POST /api/opening/lock` — geri alınamaz.

### 3. Telefon Normalizasyonu

`0532 xxx`, `+90 532 xxx`, `5321234567`, `0090532...` → canonical: `5321234567`

```js
// api/src/routes/customers.js
function normalizePhone(raw) { ... }   // JS tarafı

const PHONE_CANON_SQL = `regexp_replace(regexp_replace(regexp_replace(
  phone,'[^0-9]','','g'),'^0090',''),'^(90(?=\\d{10}$)|0(?=\\d{10}$))','')` 
// DB tarafı — aynı mantık, duplicate check sorgularında kullanılır
```

### 4. BOM Snapshot

Üretim işi oluşturulurken reçete o anki haliyle `production_jobs.bom_snapshot` (JSONB) sütununa kopyalanır.
İş tamamlanırken snapshot kullanılır; reçete sonradan değişse bile iş doğru malzemeyi tüketir.

```js
// production.js — sütun adına dikkat:
// recipe_lines tablosunda sütun: `quantity` (quantity_per_unit DEĞİL)
// BOM snapshot sorgusunda alias: `rl.quantity AS quantity_per_unit`
```

### 5. Sipariş Silme (Soft Delete)

`DELETE /api/orders/:id` → soft delete + tahsilat ters kaydı:
- `orders.deleted_at` = NOW(), `status` = 'cancelled', `paid_amount` = 0
- Her hesap için ters `transactions` kaydı (`reference_type='order_reversal'`)
- `accounts.balance` düşürülür
- Bekleyen `production_jobs` iptal edilir

### 6. Import Deduplication

`POST /api/import/orders` — body'deki `data` dizisinin MD5 hash'i `orders.import_batch_id` olarak saklanır.
Aynı hash ikinci kez gönderilirse **409** döner.

### 7. avg_cost Güncelleme Formülü

```sql
avg_cost = COALESCE(
  (current_stock * avg_cost + $1::numeric * $2::numeric) / NULLIF(current_stock + $1::numeric, 0),
  avg_cost
)
```

`::numeric` cast zorunlu — ikisi de `unknown` tipte gelince PostgreSQL operator seçemiyor.

---

## Veritabanı Şeması (Ana Tablolar)

| Tablo | Açıklama |
|-------|----------|
| `orders` | Siparişler; `deleted_at` soft-delete, `import_batch_id` import takibi |
| `order_items` | Sipariş kalemleri |
| `customers` | `deleted_at`, `is_active`, `city`, `district`, `address`, `email` var |
| `suppliers` | `total_debt` denormalize; `deleted_at`, `is_active` var |
| `purchases` + `purchase_lines` | Tedarikçi alımları |
| `purchase_returns` + `purchase_return_lines` | İadeler |
| `supplier_payments` | Borç ödemeleri |
| `supplier_discounts` | İskonto/fiyat düzeltmesi (stoğa dokunmaz) |
| `materials` | `current_stock`, `reserved_stock`, `avg_cost` |
| `stock_movements` | Her stok hareketi buraya kayıt düşer |
| `products` + `product_variants` | |
| `recipes` + `recipe_lines` | `recipe_lines`: `slot_code` NOT NULL, `slot_label` NOT NULL, `quantity` NOT NULL |
| `production_jobs` | `bom_snapshot` JSONB, `source` ('order'\|'stock'), `reserved_stock` bağlantısı |
| `production_outputs` | `available_qty`, `material_config` JSONB, `source` ('OPENING'\|'PRODUCTION') |
| `accounts` | `account_type`: 'cash'\|'bank'\|'card'\|'other'; `balance` denormalize |
| `transactions` | Tüm para hareketleri; `reference_type` + `reference_id` ile bağlantı |
| `opening_sessions` | Açılış; `locked_at` doluysa sistem OPEN |
| `opening_lines` | Açılış stok/alacak/borç satırları |
| `customer_payments` | Tahsilat başlıkları |
| `customer_payment_allocations` | Tahsilatın sipariş bazında dağıtımı |

---

## Mevcut Sistem Durumu (2026-09-10)

### Tarihsel Veri (değişmemeli)
```
Sipariş sayısı : 43
Toplam satış   : 58.798 TL
Tahsilat       : 53.298 TL
Açık alacak    :  5.500 TL
```

### Hesaplar
| id | Ad | Bakiye |
|----|-----|--------|
| 1 | Nakit | 10.000 TL |
| 2 | Banka | 0 TL |
| 3 | Kredi Kartı | 0 TL |
| 4 | Test Kasa | 0 TL |

### Tedarikçiler
ALİ KARAYAZI, meta, vaketa deri, hepsiburada, KARGONOMİ — hepsinin `total_debt = 0`

### Açılış Oturumu
`opening_sessions` id=1, `locked_at IS NOT NULL` → sistem **OPEN** modunda.

---

## Bilinen Açık Sorunlar (Backlog)

### YÜKSEK ÖNCELİK

1. **Ready Stock Sale — available_qty azalmıyor**
   - `POST /api/orders` ile `source='ready_stock'` sipariş oluşturulduğunda `production_outputs.available_qty` düşmüyor.
   - `api/src/routes/orders.js` içine şu mantık eklenmeli: sipariş kalemindeki ürün için `production_outputs`'tan FIFO sırasıyla `available_qty` tüket.
   - Oversell riski var.

2. **PUT /api/recipes/:id/lines — 500 hatası**
   - `recipe_lines.slot_code` ve `slot_label` NOT NULL; API bu alanları göndermediği için INSERT fail oluyor.
   - Düzeltme: route'a `slot_code` ve `slot_label` alanlarını ekle (zorunlu veya `material_id`'den türet).

### ORTA ÖNCELİK

3. **Hesap bakiyesi ↔ transaction ledger uyuşmazlığı**
   - 43 tarihi sipariş import ile yüklendi (`paid_amount` yazıldı); karşılık `transactions` satırı ve `accounts.balance` güncellenmedi.
   - Bu bir veri tutarlılık sorunudur; production'da para sayımını zorlaştırır.
   - Çözüm: tek seferlik migration ile tarihi ödemeleri `transactions`'a yaz ve bakiyeleri güncelle.

4. **Tedarikçi detay sayfası (`supplier-detail.html`) — cari hareket tablosu eksik**
   - KPI kısmı var; `GET /api/suppliers/:id/ledger` endpoint'i var ama UI'da hareket tablosu tam render edilmiyor.

### DÜŞÜK ÖNCELİK

5. **Ürünler sayfası sıralama + pasif ürün gösterimi**
   - `GET /api/products?include_inactive=1` var ama UI'da "Pasifleri göster" toggle yok.

---

## Plan Dosyası

`C:\Users\HP\.claude\plans\t-m-sayfalar-geli-tirmeni-istiyorum-parallel-seal.md` dosyasında onaylı implementasyon planı mevcut. Ana başlıklar:

- **Aşama 1** (kısmen tamamlandı): Siparişler aylık sayfalama, yeni sipariş modalı müşteri seçimi, sipariş silme, müşteri detay sayfası
- **Aşama 2** (henüz başlanmadı): Müşteri tahsilat ekranı, tedarikçi cari tablo, ürün sıralama/pasif

---

## Doğrulama Sorguları

Her değişiklik sonrası bu sorgular çalıştırılmalı:

```sql
-- Tarihsel veri bozulmadı mı? (43 / 58798 / 53298 / 5500 olmalı)
SELECT COUNT(*), SUM(total_amount), SUM(paid_amount), SUM(total_amount-paid_amount)
FROM orders WHERE deleted_at IS NULL AND status != 'cancelled';

-- Hesap bakiyesi = hareket toplamı mı? (0 satır dönmeli — şu an pre-existing gap var, izle)
SELECT a.id, a.name, a.balance, COALESCE(SUM(t.amount),0) AS ledger,
       ABS(a.balance - COALESCE(SUM(t.amount),0)) AS diff
FROM accounts a LEFT JOIN transactions t ON t.account_id=a.id
GROUP BY a.id, a.name, a.balance HAVING ABS(a.balance - COALESCE(SUM(t.amount),0)) > 0.005;

-- Tedarikçi borç = 0 mu? (canlı tedarikçilerde sıfır olmalı şu an)
SELECT id, name, total_debt FROM suppliers WHERE total_debt != 0;
```

---

## Disposable Fixture Kuralı

Gerçek Decco verilerine test amacıyla **dokunma**. Her test:
- Kendi müşteri/tedarikçi/malzeme/ürün kayıtlarını oluşturur (`TEST-` prefix ile)
- Test sonunda temizler (DELETE veya transaction ROLLBACK)
- Tarihsel 43/58798/53298/5500 rakamları hiç değişmemeli

---

## Yardımcı Komutlar

```bash
# API logları
docker logs decco_api -f

# DB'ye bağlan
docker exec -it decco_db psql -U decco -d decco

# API yeniden başlat (kod değişikliği sonrası)
docker compose up -d --build api

# Yedek al
docker exec decco_db pg_dump -U decco decco > backup_$(date +%Y%m%d).sql

# Yedekten geri yükle
docker exec -i decco_db psql -U decco decco < backup_YYYYMMDD.sql
```

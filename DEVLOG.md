# Decco OS — Geliştirici El Kitabı (AI Handoff)

> Bu dosya başka bir yapay zekanın projeye bağlanıp kaldığı yerden devam edebilmesi için yazılmıştır.
> Son güncelleme: 2026-09-11 · Açılış Lifecycle, Capability Guards & Audit Correction

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
│   │   ├── opening-guard.js  ← Domain/capability bazlı açılış guard'ları
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

### 1. Açılış Yaşam Döngüsü ve Capability Guard (Opening Lifecycle & Guards)

Açılış süreci ve günlük operasyonel kullanım 3 kanonik duruma ayrılmıştır:
- **`draft`**: Açılış hazırlığı (`status = 'draft'`). Go-live tarihi doğrulanır (4 haneli yıl 2000–2100 aralığında, timezone bağımsız YYYY-MM-DD takvim tarihi).
- **`open`**: Sistem operasyonel kullanıma açılmış (`status = 'open'`). Günlük operasyonlar serbesttir; ancak henüz teyit edilmemiş başlangıç verileri için **domain bazlı capability guard** devrededir (`api/src/opening-guard.js`). Eksik başlangıç verileri *"Açılış Verilerini Tamamla"* modunda tamamlanabilir.
- **`completed`**: Tüm 8 checklist bölümü tamamlanıp kilitlenmiştir (`locked_at IS NOT NULL` veya `status = 'completed'`).

**Capability Guard Kuralları (`api/src/opening-guard.js`):**
- **Kapsam (Pre-go-live vs. Post-go-live):** Guard yalnızca go-live anında mevcut kayıtlar için geçerlidir. Go-live sonrasında oluşturulan yeni hesap, tedarikçi, müşteri, malzeme veya hazır ürün kayıtları açılış doğrulaması istemez; doğrudan canlı hareketlerle çalışır.
- **Ham Madde:** Pre-go-live malzemelerde `counted_at IS NULL` (sayılmadı) ise sarfiyat/üretim veya stok düzeltme engellenir (HTTP 409: *"Bu malzemenin açılış sayımı tamamlanmamış. Açılış Verilerini Tamamla ekranından sayım yapın."*). Go-live sonrası yeni malzemeler açılış satırı olmasa da ilk stok girişinden sonra serbestçe kullanılır.
- **Kasa / Banka:** Açılış bakiyesi teyit edilmemiş hesaplarda harcama, transfer ve tahsilat engellenir. Doğrulanan hesaplar çalışır.
- **Tedarikçi:** Açılış borcu teyit edilmemiş tedarikçilerde mevcut borç mutlak değerini etkileyen işlemler (ödeme, iade, indirim) engellenir.
- **Müşteri Alacakları:** Sipariş tarihi `< go_live_date` olan tarihsel alacaklar teyit edilene kadar tahsilatı engellenir; post-go-live siparişler normal tahsilat akışıyla çalışır.

### 2. Açılış Verilerini Tamamla ve Güvenli Düzeltme Akışı (`opening.html` & `opening.js`)

- **Açık Kaydet Butonu (`onchange` kaldırıldı):** Ham madde, kasa/banka ve tedarikçi satırlarında `onchange` / `blur` ile otomatik kaydetme tamamen kaldırılmıştır. Miktar + birim maliyet + konum ancak satırdaki açık **Kaydet** butonu tıklandığında doğrulanıp kaydedilir.
- **Açılış Tamamlama (`POST /api/opening/materials/:lineId/complete`):** `open` modda sayılmamış malzeme girildiğinde canlı stok hareketi `reference_type='OPENING_COMPLETION'` ile işlenir.
- **Audit Korumalı Düzeltme (`POST /api/opening/materials/:lineId/correct`):**
  - **409 Guard:** Malzemede açılıştan sonra başka stok hareketi (satın alma, üretim tüketimi veya stok düzeltme) oluşmuşsa HTTP 409 döner; geriye dönük `avg_cost` hesaplama karmaşasına girilmez.
  - **Ters Kayıt + Yeni Kayıt:** Eski açılış hareketi silinmez. Denetim izini korumak için `-old_qty` ile ters kayıt, ardından `+new_qty` ile yeni kayıt oluşturulur (`reference_type='OPENING_CORRECTION'`).
  - **PostgreSQL 42725 Çözümü:** SQL metninde unar eksi (`-$2`) kullanılmaz, JS parametresinde `-oldQty` geçilir. Stok/maliyet güncellemesinde `$1::numeric + $2::numeric` ve `$2::numeric > 0` açık tip cast kullanılır.
- **Nihai Kilit (`POST /api/opening/lock`):** Yalnızca tüm 8 bölüm tamamlandığında çalıştırılır; `OPENING`, `OPENING_COMPLETION` ve `OPENING_CORRECTION` hareketlerini mükerrer oluşturmayacak şekilde korur.

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
- Malzeme Tedarikçileri (`material_supplier`): ALİ KARAYAZI (id=1), vaketa deri (id=3)
- Hizmet Sağlayıcılar (`service_provider`): meta (id=2), hepsiburada (id=4), KARGONOMİ (id=5) — Tedarikçiler modülü ve açılış borç checklist'inden filtrelenmiştir; cari işlemler yalnız `material_supplier` için geçerlidir.
- Borç durumu: hepsinin `total_debt = 0`

### Açılış Oturumu (2026-09-11 İtibarıyla)
`opening_sessions` id=1:
- `status = 'open'`, `locked_at = NULL` → Sistem operasyonel açık modda (canlı işlemler açık, eksik bölümler tamamlanabilir).
- Go-live tarihi: `2026-09-10` (takvim tarihi).
- PB-KKH açılış sayımı düzeltme akışı ve audit ters kayıt mekanizmasıyla doğru değerlerine (227 desi / 22 TL) alınabilir durumda.

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

## 2026-09-11 Değişiklik Notları

1. **Açılış Yaşam Döngüsü Ayrımı (draft → open → completed):**
   - Açılış kilitlenme şartı (`locked_at`) ile operasyonel kullanım (`status = 'open'`) birbirinden ayrıldı. Sistem tüm checklist bitmeden canlı kullanıma açılabilir hale getirildi.
   - Go-live tarihi doğrulama kuralı eklendi: 4 haneli yıl (2000–2100), ISO calendar date (YYYY-MM-DD), frontend'de kısmi tarih girişlerinde otomatik submit engellendi.

2. **Domain Bazlı Capability Guards (`api/src/opening-guard.js`):**
   - Açılışı tamamlanmamış hesap, tedarikçi, müşteri alacağı ve malzemeler için domain bazlı koruma eklendi.
   - **Post-go-live istisnası:** Go-live sonrası oluşturulan yeni hesap, tedarikçi, müşteri, malzeme veya ürünler açılış guard'ından muaf tutuldu.
   - Sayılmamış pre-go-live malzeme normal stok düzeltmeye sokulmak istendiğinde 500 yerine açıklayıcı HTTP 409 dönmesi sağlandı (*"Bu malzemenin açılış sayımı tamamlanmamış. Açılış Verilerini Tamamla ekranından sayım yapın."*).

3. **`onchange` Otomatik Kaydının Kaldırılması (`web/src/opening.html`):**
   - Kullanıcı miktar veya maliyet yazarken blur/spinner adımlarında verinin yarım kaydedilmesini önlemek amacıyla `onchange` otomatik kaydı tamamen kaldırıldı.
   - Ham madde, kasa ve tedarikçi satırlarına açık **Kaydet** butonu eklendi; miktar + birim maliyet + konum yalnız butona tıklandığında kaydedilir.

4. **Audit Korumalı Düzeltme Endpoint'i (`POST /api/opening/materials/:lineId/correct`):**
   - Açılış sonrasında başka stok hareketi olan malzemelerde geriye dönük `avg_cost` bozulmaması için 409 guard'ı uygulandı.
   - Eski açılış hareketi silinmeden ters kayıt (`-old_qty`) ve yeni kayıt (`+new_qty`) ile denetim izi korunarak `reference_type='OPENING_CORRECTION'` ile kaydedilmesi sağlandı.
   - PostgreSQL `42725 (operator is not unique: - unknown)` hatası parametrik negatif değer (`-oldQty`) ve `::numeric` cast ile çözüldü.
   - Operasyonel modda sayılmış kilitli satırlara **Düzelt** butonu ve modalı eklendi (PB-KKH 0.0001 miktar / 227 maliyet hatasının 227 desi / 22 TL olarak güvenle düzeltilebilmesi sağlandı).

5. **Tedarikçi Türü Ayrımı (`material_supplier` vs `service_provider`):**
   - `suppliers` tablosuna `CHECK (supplier_type IN ('material_supplier', 'service_provider'))` constraint'i ve `DEFAULT 'material_supplier'` ile `supplier_type` kolonu eklendi.
   - Mevcut veride `meta`, `hepsiburada` ve `KARGONOMİ` hizmet sağlayıcı (`service_provider`), `ALİ KARAYAZI` ve `vaketa deri` malzeme tedarikçisi (`material_supplier`) olarak sınıflandırıldı; hiçbir geçmiş kayıt silinmedi.
   - Tedarikçiler listesi (`GET /api/suppliers`), detay sayfası ve cari işlemler (alım, ödeme, iade, iskonto, ekstre) yalnız `material_supplier` için çalışacak şekilde kısıtlandı.
   - Açılış checklist'i, `start-operations`, `lock` ve açılış tedarikçi listesinde hizmet sağlayıcılar filtrelendi; eski service-provider açılış satırlarının açılış tamamlanmasını bloke etmesi engellendi (checklist yalnız 2 malzeme tedarikçisi üzerinden değerlendirilir).

6. **Müşteri Tahsilatında “Tedarikçiye Doğrudan Ödeme” Yöntemi & UI Regresyon Çözümü:**
   - Sipariş ve Finans tahsilat modallarına `direct_to_supplier` ödeme yöntemi eklendi.
   - Bu yöntem seçildiğinde kasa/banka hesabı seçimi kaldırılır; money account ve `transactions` hareketi oluşturulmaz; kasa bakiyesi etkilenmez.
   - `customer_payments` ve `supplier_payments` tablolarında `account_id` yalnız `direct_to_supplier` / `direct_from_customer` tipleri için `NULL` kabul edilecek şekilde DB CHECK constraint ile korundu (`customer_payments_account_check`, `supplier_payments_account_check`).
   - Müşteri alacağı (`orders.paid_amount`), müşteri tahsilat kaydı (`customer_payments`), tedarikçi ödeme kaydı (`supplier_payments`) ve tedarikçi borcu (`suppliers.total_debt`) tek bir DB transaction'ı içinde atomik olarak kilitlenip güncellendi (`FOR UPDATE`).
   - Tutar sınırı hem siparişin açık alacağı hem de seçilen tedarikçinin mevcut `total_debt` borcu ile çift taraflı sınırlandırıldı.
   - Açılış capability guard'ları entegre edildi: doğrulanmamış tarihsel müşteri alacağı (`assertOrderPayable`) veya doğrulanmamış tedarikçi açılış borcu (`assertSupplierReady`) üzerinden tahsilat yapılması engellendi.
   - Rapor ve dashboard sorgularına (`reports.js`, `dashboard.js`) kasa hareketi yaratmayan doğrudan ödemeler dahil edildi.
   - **UI Regresyon Kök Nedeni ve Çözümü:** `GET /api/suppliers` endpoint'inin bir array yerine `{ items: [...], opening_locked: true }` objesi dönmesi nedeniyle `orders.html` ve `finance.html` içindeki `suppliers.map()` çağrısı `TypeError` verip modal açılışını engelliyordu. `Array.isArray(supData) ? supData : (supData?.items || [])` kontrolü ile tedarikçi listesi güvenle unpack edildi; her iki ekranda da modal açılışı ve dinamik alan geçişleri doğrulandı.

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

---

## PayTR Entegrasyonu — Tarihsel İşlem Dökümü ve Eşleme (Historical Transactions & Matching) (2026-09-12)

Resmi PayTR İşlem Dökümü API'si (`POST https://www.paytr.com/rapor/islem-dokumu`) entegrasyonu tamamlandı.

### Temel Güvenlik Kuralı: SIFIR FİNANSAL MUTASYON (Zero Finance Mutation)
Geçmiş PayTR hareketleri Decco OS içinde `customer_payments` veya `orders.paid_amount`'u ASLA otomatik değiştirmez; kasa/banka bakiyelerine dokunmaz. Yalnızca staging tablolarda saklanır ve Decco siparişleriyle meta veri olarak eşleştirilir/ilişkilendirilir.

### Mimari İlkeler ve Düzeltmeler:
1. **transaction_date**: Kesinlikle `DATE NOT NULL` (saat bilgisi uydurulmaz, 00:00:00 eklenmez).
2. **status === 'failed'**: Boş pencere kabul edilir (`{ ok: true, count: 0, transactions: [] }`), `err_msg` metin kontrolüne bağlanmaz.
3. **Audit Modeli**: `paytr_history_transactions` tablosunda tek `fetch_id` yerine `paytr_history_fetch_transactions` junction tablosu ve chunk bazlı hata takibi için `paytr_history_fetch_chunks` tablosu eklendi.
4. **Finansal Doğruluk**: `installment` provider-native (`0` tek çekim, `2..12` taksitli, yoksa `null`, asla 1 varsayılmaz). `currency` sağlayıcıdan gelmek zorundadır (`TL` uydurulmaz). `CHECK (transaction_type IN ('S','I'))`.
5. **Deterministic source_signature**: Kuruş bazlı tam sayı integer cents üzerinden canonical SHA-256 (`10` ve `10.00` aynı hash'i üretir). Response içi tekrarlar `occurrence_no` ile takip edilir.
6. **İade (I) Tutarları**: Uygulama tarafında negatifleştirilmez, pozitif tutulur; yönü `transaction_type='I'` belirler.
7. **Manuel Eşleme**: Mevcut suggested/conflict kaydı aynı satır üzerinde `confirmed_by_user=true` ile güncellenir. Otomatik kesin eşleşmeyi (`exact`) başka siparişe bağlama denemelerinde backend `409 EXACT_MATCH_OVERRIDE_REQUIRES_REVIEW` döner.
8. **Konservatif Heuristic Eşleme**: Yalnızca tutar eşleşmesiyle öneri üretilmez. Tutar + takvim penceresi (+/- 7 gün) + PayTR tarihsel ödeme kanıtı aranır. Çoklu aday -> `conflict`.
9. **Tarih Güvenlik Sınırı**: Tek fetch isteğinde maksimum 93 gün sorgulanabilir. 3'er günlük parçalar halinde sequential taranır.
10. **Durum Doğrulama**: Calendar date eşitliği (saat farkı gözetilmeden), kuruş eşitliği ve TL/TRY denkliği kontrol edilir. `returns_count` döndürülür; `auth_code` ve tam returns frontend'e sızdırılmaz.
11. **Serialization ve Güvenli Hata Yönetimi**:
    - Request gövdesi tam olarak tek sefer JSON encode edilir (`{ start_date: 'YYYY-MM-DD', end_date: 'YYYY-MM-DD' }`).
    - `web/src/js/shared.js` içindeki `api()` wrapper'ı `opts.body`'nin zaten string olup olmadığını kontrol ederek çift `JSON.stringify` uygulamasını engeller; `web/src/integrations-paytr.html` doğrudan plain object gönderir.
    - Backend `POST /api/integrations/paytr/history/fetch` endpoint'i `req.body`'yi strict JS object olarak doğrular; string ise sessizce tekrar parse ederek problemi gizlemez, `400 INVALID_REQUEST_BODY` ile reddeder.
    - Express `SyntaxError` (bozuk/çift tırnaklı JSON body) `api/src/index.js` global error handler'ında `400 INVALID_JSON_BODY` koduna sanitize edilir.
    - UI toast katmanında `safeUserError` ile `Unexpected token`, `is not valid JSON`, `SyntaxError` gibi teknik detaylar filtrelenir; kullanıcıya güvenli Türkçe bildirim gösterilir, teknik detay console'da saklanır.
    - Canlı PayTR upstream çağrısı yapılmadan önce non-production ortamında `?mock=1` query parametresi ve mock test desteği eklenmiş, browser subagent ile Network payload, status 200 ve toast temizliği doğrulanmıştır.

-- Decco OS — PostgreSQL Schema
-- IF NOT EXISTS ile her başlangıçta güvenle çalışır

CREATE TABLE IF NOT EXISTS customers (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(200) NOT NULL,
  phone       VARCHAR(20),
  channel     VARCHAR(50),   -- whatsapp, instagram, web, direct
  notes       TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS products (
  id                          SERIAL PRIMARY KEY,
  code                        VARCHAR(50) UNIQUE NOT NULL,  -- PF001, CW001
  name                        VARCHAR(200) NOT NULL,
  description                 TEXT,
  base_price                  NUMERIC(12,2) DEFAULT 0,
  is_active                   BOOLEAN DEFAULT TRUE,
  allows_personalization      BOOLEAN DEFAULT FALSE,
  standard_production_minutes INT DEFAULT 0,
  image_url                   VARCHAR(500),
  created_at                  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS product_variants (
  id          SERIAL PRIMARY KEY,
  product_id  INT NOT NULL REFERENCES products(id),
  name        VARCHAR(100) NOT NULL,  -- Standart, Büyük Boy
  price_delta NUMERIC(12,2) DEFAULT 0,
  is_active   BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS materials (
  id            SERIAL PRIMARY KEY,
  sku           VARCHAR(50) UNIQUE NOT NULL,  -- CR-SYH, KM-YSL
  name          VARCHAR(200) NOT NULL,
  family        VARCHAR(100),                 -- Crazy, Kaşmir, Pueblo, Tiana
  color         VARCHAR(100),
  material_type VARCHAR(50) NOT NULL,         -- leather, thread, adhesive, accessory, packaging
  unit          VARCHAR(20) NOT NULL,         -- desi, adet, ml, m
  current_stock NUMERIC(12,4) DEFAULT 0,
  reserved_stock NUMERIC(12,4) DEFAULT 0,
  avg_cost      NUMERIC(12,4) DEFAULT 0,
  reorder_level NUMERIC(12,4),
  is_active     BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS recipes (
  id          SERIAL PRIMARY KEY,
  product_id  INT NOT NULL REFERENCES products(id),
  variant_id  INT REFERENCES product_variants(id),
  name        VARCHAR(100) DEFAULT 'Standart',
  is_active   BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS recipe_lines (
  id                  SERIAL PRIMARY KEY,
  recipe_id           INT NOT NULL REFERENCES recipes(id),
  slot_code           VARCHAR(50) NOT NULL,   -- MAIN_LEATHER, SECONDARY_LEATHER, THREAD
  slot_label          VARCHAR(100) NOT NULL,  -- Ana Deri, İkincil Deri, İplik
  material_id         INT REFERENCES materials(id),
  quantity            NUMERIC(10,4) NOT NULL,
  unit                VARCHAR(20) NOT NULL,
  waste_rate          NUMERIC(5,4) DEFAULT 0,
  customer_selectable BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS orders (
  id            SERIAL PRIMARY KEY,
  customer_id   INT NOT NULL REFERENCES customers(id),
  source        VARCHAR(50),   -- web, meta, whatsapp, direct
  status        VARCHAR(50) DEFAULT 'draft',
  total_amount  NUMERIC(12,2) DEFAULT 0,
  paid_amount   NUMERIC(12,2) DEFAULT 0,
  notes         TEXT,
  order_date    TIMESTAMPTZ DEFAULT NOW(),
  delivery_date TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Gerçek sipariş numarası (2608-011). Tarihsel aktarımda notes içine
-- yazılmıştı; buradan tek kolona taşınır.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_no VARCHAR(50);
UPDATE orders SET order_no = split_part(notes, ' · ', 1)
WHERE order_no IS NULL AND notes ~ '^[0-9]{4}-[0-9]+';

CREATE TABLE IF NOT EXISTS order_items (
  id                   SERIAL PRIMARY KEY,
  order_id             INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id           INT NOT NULL REFERENCES products(id),
  variant_id           INT REFERENCES product_variants(id),
  quantity             INT DEFAULT 1,
  unit_price           NUMERIC(12,2) NOT NULL,
  discount             NUMERIC(12,2) DEFAULT 0,
  material_selections  JSONB,   -- {main_leather_id: 3, secondary_leather_id: 5}
  personalization      VARCHAR(200),
  status               VARCHAR(50) DEFAULT 'pending',
  notes                TEXT
);

CREATE TABLE IF NOT EXISTS production_jobs (
  id                   SERIAL PRIMARY KEY,
  order_item_id        INT REFERENCES order_items(id),
  product_id           INT NOT NULL REFERENCES products(id),
  variant_id           INT REFERENCES product_variants(id),
  recipe_id            INT REFERENCES recipes(id),
  quantity             INT DEFAULT 1,
  status               VARCHAR(50) DEFAULT 'pending',
  -- pending, in_progress, quality_check, completed, cancelled
  material_selections  JSONB,
  notes                TEXT,
  started_at           TIMESTAMPTZ,
  completed_at         TIMESTAMPTZ,
  created_at           TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS production_outputs (
  id              SERIAL PRIMARY KEY,
  job_id          INT NOT NULL REFERENCES production_jobs(id),
  product_id      INT NOT NULL REFERENCES products(id),
  quantity        INT NOT NULL,
  material_config JSONB,   -- üretim tamamlandığında dondurulur
  unit_cost       NUMERIC(12,4),
  available_qty   INT NOT NULL,  -- rezerve edilmemiş adet
  produced_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id             SERIAL PRIMARY KEY,
  material_id    INT NOT NULL REFERENCES materials(id),
  movement_type  VARCHAR(50) NOT NULL,
  -- purchase_in, opening_in, production_out, production_in,
  -- sale_out, return_in, scrap_out, count_adjust, transfer_in, transfer_out
  quantity       NUMERIC(12,4) NOT NULL,  -- + giriş, - çıkış
  unit_cost      NUMERIC(12,4),
  reference_type VARCHAR(50),
  reference_id   INT,
  location       VARCHAR(100) DEFAULT 'ATOLYE',
  notes          TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS accounts (
  id           SERIAL PRIMARY KEY,
  name         VARCHAR(100) NOT NULL,
  account_type VARCHAR(50) NOT NULL,  -- cash, bank, card, founder
  balance      NUMERIC(14,2) DEFAULT 0,
  is_active    BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS transactions (
  id               SERIAL PRIMARY KEY,
  account_id       INT NOT NULL REFERENCES accounts(id),
  amount           NUMERIC(14,2) NOT NULL,   -- + giriş, - çıkış
  transaction_type VARCHAR(50) NOT NULL,
  -- customer_payment, supplier_payment, expense, asset_purchase,
  -- founder_funding, founder_repayment, transfer_in, transfer_out
  reference_type   VARCHAR(50),
  reference_id     INT,
  description      TEXT,
  transaction_date TIMESTAMPTZ DEFAULT NOW(),
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS suppliers (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(200) NOT NULL,
  phone      VARCHAR(20),
  notes      TEXT,
  total_debt NUMERIC(14,2) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  supplier_type VARCHAR(50) NOT NULL DEFAULT 'material_supplier' CHECK (supplier_type IN ('material_supplier', 'service_provider'))
);

CREATE TABLE IF NOT EXISTS purchases (
  id            SERIAL PRIMARY KEY,
  supplier_id   INT NOT NULL REFERENCES suppliers(id),
  total_amount  NUMERIC(14,2) NOT NULL,
  paid_amount   NUMERIC(14,2) DEFAULT 0,
  purchase_date TIMESTAMPTZ DEFAULT NOW(),
  notes         TEXT
);

CREATE TABLE IF NOT EXISTS purchase_lines (
  id          SERIAL PRIMARY KEY,
  purchase_id INT NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  material_id INT NOT NULL REFERENCES materials(id),
  quantity    NUMERIC(12,4) NOT NULL,
  unit_cost   NUMERIC(12,4) NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  full_name     VARCHAR(200) NOT NULL,
  username      VARCHAR(100) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          VARCHAR(50) DEFAULT 'readonly',
  -- admin, production, sales, finance, readonly
  department    VARCHAR(100),
  is_active     BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS departments (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(100) UNIQUE NOT NULL,
  color      VARCHAR(20) DEFAULT 'blue',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ===========================================================================
-- AÇILIŞ / CUTOVER
-- Sistemin canlıya alındığı gün Decco'nun GERÇEK fiziksel ve finansal durumu.
-- Tarihsel kayıtlar burada değişmez; açılış etkisi ayrı iz bırakır.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS opening_sessions (
  id            SERIAL PRIMARY KEY,
  go_live_date  DATE,
  status        VARCHAR(20) DEFAULT 'draft',   -- draft, locked
  confirmations JSONB DEFAULT '{}'::jsonb,     -- sıfır cevabı geçerli olan bölümlerin onayı
  locked_at     TIMESTAMPTZ,
  locked_by     INT REFERENCES users(id),
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Aynı anda yalnızca bir kilitlenmemiş açılış oturumu olabilir
CREATE UNIQUE INDEX IF NOT EXISTS opening_sessions_single_open
  ON opening_sessions ((locked_at IS NULL)) WHERE locked_at IS NULL;

-- Tüm açılış bölümlerinin tek defteri.
-- counted_qty: NULL = sayılmadı, 0 = sayıldı ve gerçekten sıfır.
CREATE TABLE IF NOT EXISTS opening_lines (
  id              SERIAL PRIMARY KEY,
  session_id      INT NOT NULL REFERENCES opening_sessions(id) ON DELETE CASCADE,
  section         VARCHAR(30) NOT NULL,
  -- material, finished_good, account, receivable, supplier_debt, founder
  ref_key         VARCHAR(100) NOT NULL,
  material_id     INT REFERENCES materials(id),
  product_id      INT REFERENCES products(id),
  order_id        INT REFERENCES orders(id),
  account_id      INT REFERENCES accounts(id),
  supplier_id     INT REFERENCES suppliers(id),
  counted_qty     NUMERIC(12,4),
  unit_cost       NUMERIC(12,4),
  amount          NUMERIC(14,2),
  previous_value  NUMERIC(14,2),   -- üzerine yazılan önceki değer (geri izlenebilirlik)
  material_config JSONB,           -- {slots:{MAIN_LEATHER:{material_id,sku}, ...}}
  location        VARCHAR(100) DEFAULT 'ATOLYE',
  status          VARCHAR(20) DEFAULT 'pending',
  -- pending, counted, confirmed, closed
  notes           TEXT,
  counted_at      TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS opening_lines_uniq
  ON opening_lines (session_id, section, ref_key);

-- Demirbaş kayıt defteri. Açılışta para/gider hareketi YARATMAZ;
-- geçmiş demirbaşlarda amortisman go-live'da sıfırdan başlamasın diye
-- birikmiş amortisman ve net defter değeri ayrıca tutulur.
CREATE TABLE IF NOT EXISTS fixed_assets (
  id                 SERIAL PRIMARY KEY,
  session_id         INT REFERENCES opening_sessions(id),
  name               VARCHAR(200) NOT NULL,
  category           VARCHAR(100),
  purchase_date      DATE,
  purchase_cost      NUMERIC(14,2) DEFAULT 0,
  in_service_date    DATE,
  useful_life_months INT,
  opening_accumulated_depreciation NUMERIC(14,2) DEFAULT 0,
  opening_carrying_value           NUMERIC(14,2) DEFAULT 0,
  payment_source     VARCHAR(100),
  status             VARCHAR(20) DEFAULT 'active',   -- active, disposed
  source             VARCHAR(20) DEFAULT 'OPENING',
  notes              TEXT,
  created_at         TIMESTAMPTZ DEFAULT NOW()
);

-- production_outputs genel hazır ürün lot tablosu olarak kullanılıyor
-- (stock.js ve dashboard.js job_id'ye bakmadan okuyor), bu yüzden
-- üretim işi olmayan açılış lotları da burada tutulur.
ALTER TABLE production_outputs ALTER COLUMN job_id DROP NOT NULL;
ALTER TABLE production_outputs ADD COLUMN IF NOT EXISTS source VARCHAR(20) DEFAULT 'PRODUCTION';
ALTER TABLE production_outputs ADD COLUMN IF NOT EXISTS opening_line_id INT REFERENCES opening_lines(id);

-- Açılış tekrar çalıştırılsa bile çift kayıt DB seviyesinde engellenir
CREATE UNIQUE INDEX IF NOT EXISTS production_outputs_opening_uniq
  ON production_outputs (opening_line_id) WHERE opening_line_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS stock_movements_opening_uniq
  ON stock_movements (material_id, reference_id) WHERE reference_type = 'OPENING';
CREATE UNIQUE INDEX IF NOT EXISTS transactions_opening_uniq
  ON transactions (account_id, reference_id) WHERE transaction_type = 'opening_balance';

-- ===========================================================================
-- CARİ HESAP / SOFT DELETE GENİŞLETMELERİ
-- ===========================================================================

-- Müşteri: adres bilgileri + soft delete
ALTER TABLE customers ADD COLUMN IF NOT EXISTS city       VARCHAR(100);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS district   VARCHAR(100);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS address    TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS email      VARCHAR(200);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS is_active  BOOLEAN DEFAULT TRUE;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Tarihsel aktarımda şehir notes içine yazılmıştı ("Şehir: NİĞDE · ..."),
-- kendi kolonuna taşınır
UPDATE customers
SET city = INITCAP(TRIM(SPLIT_PART(SUBSTRING(notes FROM 'Şehir: ([^·]+)'), '·', 1)))
WHERE city IS NULL AND notes ~ 'Şehir: ';

-- Taşındıktan sonra nottaki "Şehir: X" öneki temizlenir, kalan not korunur
UPDATE customers
SET notes = NULLIF(TRIM(BOTH ' ·' FROM REGEXP_REPLACE(notes, 'Şehir: [^·]*(· ?)?', '')), '')
WHERE city IS NOT NULL AND notes ~ 'Şehir: ';

-- Sipariş: silme = iptal + kayıt kalır (tarihsel mutabakat korunur)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS deleted_at    TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS deleted_by    INT REFERENCES users(id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delete_reason TEXT;
CREATE INDEX IF NOT EXISTS orders_active_idx
  ON orders (order_date DESC) WHERE deleted_at IS NULL;

-- Tedarikçi: iletişim + soft delete
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS is_active  BOOLEAN DEFAULT TRUE;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS email      VARCHAR(200);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS address    TEXT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS tax_no     VARCHAR(50);

-- Tahsilat başlığı: bir tahsilat birden fazla siparişe dağıtılabilir
CREATE TABLE IF NOT EXISTS customer_payments (
  id          SERIAL PRIMARY KEY,
  customer_id INT NOT NULL REFERENCES customers(id),
  account_id  INT NOT NULL REFERENCES accounts(id),
  amount      NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  method      VARCHAR(30),
  description TEXT,
  paid_at     TIMESTAMPTZ DEFAULT NOW(),
  created_by  INT REFERENCES users(id),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customer_payment_allocations (
  id         SERIAL PRIMARY KEY,
  payment_id INT NOT NULL REFERENCES customer_payments(id) ON DELETE CASCADE,
  order_id   INT NOT NULL REFERENCES orders(id),
  amount     NUMERIC(14,2) NOT NULL CHECK (amount > 0)
);

-- Tedarikçiye borç ödemesi
CREATE TABLE IF NOT EXISTS supplier_payments (
  id          SERIAL PRIMARY KEY,
  supplier_id INT NOT NULL REFERENCES suppliers(id),
  account_id  INT NOT NULL REFERENCES accounts(id),
  purchase_id INT REFERENCES purchases(id),   -- NULL = genel cari ödeme
  amount      NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  description TEXT,
  paid_at     TIMESTAMPTZ DEFAULT NOW(),
  created_by  INT REFERENCES users(id),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Tedarikçi iadesi. purchases'a negatif satır KOYULMAZ: ağırlıklı ortalama
-- maliyet formülü negatif miktarda bozulur. İadede avg_cost sabit kalır.
CREATE TABLE IF NOT EXISTS purchase_returns (
  id           SERIAL PRIMARY KEY,
  supplier_id  INT NOT NULL REFERENCES suppliers(id),
  purchase_id  INT REFERENCES purchases(id),
  total_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  settlement   VARCHAR(20) NOT NULL DEFAULT 'debt',  -- debt | refund
  account_id   INT REFERENCES accounts(id),
  notes        TEXT,
  return_date  TIMESTAMPTZ DEFAULT NOW(),
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS purchase_return_lines (
  id          SERIAL PRIMARY KEY,
  return_id   INT NOT NULL REFERENCES purchase_returns(id) ON DELETE CASCADE,
  material_id INT NOT NULL REFERENCES materials(id),
  quantity    NUMERIC(12,4) NOT NULL CHECK (quantity > 0),
  unit_cost   NUMERIC(12,4) NOT NULL
);

-- Sipariş silinince tahsilat ters kaydı hesap başına yalnız bir kez yazılabilir
CREATE UNIQUE INDEX IF NOT EXISTS transactions_order_reversal_uniq
  ON transactions (reference_id, account_id) WHERE reference_type = 'order_reversal';
CREATE INDEX IF NOT EXISTS supplier_payments_sup_idx
  ON supplier_payments (supplier_id, paid_at DESC);
CREATE INDEX IF NOT EXISTS purchase_returns_sup_idx
  ON purchase_returns (supplier_id, return_date DESC);
CREATE INDEX IF NOT EXISTS cpa_order_idx
  ON customer_payment_allocations (order_id);

-- CHK-F04: Gider kategori alanı
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS category VARCHAR(100);

-- CHK-F06: Transfer'de ortak referans
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS transfer_ref UUID;

-- CHK-T01: Alım belge numarası
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS reference_no VARCHAR(100);

-- CHK-T06: Tedarikçi iskonto/fiyat düzeltmesi (stoka dokunmaz)
CREATE TABLE IF NOT EXISTS supplier_discounts (
  id          SERIAL PRIMARY KEY,
  supplier_id INT NOT NULL REFERENCES suppliers(id),
  purchase_id INT REFERENCES purchases(id),
  amount      NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  notes       TEXT,
  discount_date TIMESTAMPTZ DEFAULT NOW(),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- CHK-U04: BOM snapshot
ALTER TABLE production_jobs ADD COLUMN IF NOT EXISTS bom_snapshot JSONB;

-- CHK-P01: Üretim kaynağı — 'order' (sipariş için) | 'stock' (stok için)
ALTER TABLE production_jobs ADD COLUMN IF NOT EXISTS source VARCHAR(20) DEFAULT 'stock';

-- CHK-P02: Geçersiz üretim başlatmayı loglamak için override flag
ALTER TABLE production_jobs ADD COLUMN IF NOT EXISTS payment_override BOOLEAN DEFAULT FALSE;

-- CHK-I01: Import batch takibi — aynı dosyanın tekrar yüklenmesini önler
ALTER TABLE orders ADD COLUMN IF NOT EXISTS import_batch_id VARCHAR(100);
CREATE INDEX IF NOT EXISTS orders_batch_idx ON orders (import_batch_id) WHERE import_batch_id IS NOT NULL;

-- Varsayılan departmanlar
INSERT INTO departments (name, color) VALUES
  ('Yönetim', 'purple'),
  ('Üretim', 'yellow'),
  ('Satış', 'green'),
  ('Finans', 'blue'),
  ('Depo', 'gray')
ON CONFLICT (name) DO NOTHING;

-- Varsayılan admin kullanıcı (şifre: admin123)
INSERT INTO users (full_name, username, password_hash, role, department)
VALUES ('Yönetici', 'admin', '$2a$10$YVDFRTR/IzUIblBReAGZL.ZuBPGVdSBL1RNJVx.nohTQx6d6e7tQa', 'admin', 'Yönetim')
ON CONFLICT (username) DO NOTHING;

-- Tedarikçi türü: material_supplier | service_provider
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'suppliers' AND column_name = 'supplier_type'
  ) THEN
    ALTER TABLE suppliers ADD COLUMN supplier_type VARCHAR(50) NOT NULL DEFAULT 'material_supplier';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'suppliers_supplier_type_check'
  ) THEN
    ALTER TABLE suppliers ADD CONSTRAINT suppliers_supplier_type_check
      CHECK (supplier_type IN ('material_supplier', 'service_provider'));
  END IF;

  -- Tedarikçiye Doğrudan Ödeme (direct_to_supplier) desteği
  ALTER TABLE customer_payments ALTER COLUMN account_id DROP NOT NULL;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='customer_payments' AND column_name='supplier_id') THEN
    ALTER TABLE customer_payments ADD COLUMN supplier_id INT REFERENCES suppliers(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='customer_payments_account_check') THEN
    ALTER TABLE customer_payments ADD CONSTRAINT customer_payments_account_check
      CHECK ((method = 'direct_to_supplier' AND account_id IS NULL) OR (method <> 'direct_to_supplier' AND account_id IS NOT NULL));
  END IF;

  ALTER TABLE supplier_payments ALTER COLUMN account_id DROP NOT NULL;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='supplier_payments' AND column_name='payment_type') THEN
    ALTER TABLE supplier_payments ADD COLUMN payment_type VARCHAR(50) DEFAULT 'account';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='supplier_payments' AND column_name='customer_id') THEN
    ALTER TABLE supplier_payments ADD COLUMN customer_id INT REFERENCES customers(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='supplier_payments' AND column_name='order_id') THEN
    ALTER TABLE supplier_payments ADD COLUMN order_id INT REFERENCES orders(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='supplier_payments_account_check') THEN
    ALTER TABLE supplier_payments ADD CONSTRAINT supplier_payments_account_check
      CHECK ((payment_type = 'direct_from_customer' AND account_id IS NULL) OR (payment_type <> 'direct_from_customer' AND account_id IS NOT NULL));
  END IF;
END $$;

-- Salt okunur tarihsel tedarikçi alım arşivi (canlı stok, cari ve kasa/banka etkilemez)
CREATE TABLE IF NOT EXISTS supplier_historical_purchases (
  id SERIAL PRIMARY KEY,
  supplier_id INT NOT NULL REFERENCES suppliers(id),
  purchase_date DATE NOT NULL,
  amount NUMERIC(14,2) NOT NULL,
  external_reference VARCHAR(100),
  description TEXT,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS shp_supplier_idx ON supplier_historical_purchases (supplier_id, purchase_date DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'shp_supplier_extref_uniq'
  ) THEN
    ALTER TABLE supplier_historical_purchases
      ADD CONSTRAINT shp_supplier_extref_uniq UNIQUE (supplier_id, external_reference);
  END IF;
END $$;

-- 2025 ALİ KARAYAZI tarihsel alımlar seed (idempotent)
DO $$
DECLARE
  v_supplier_id INT;
BEGIN
  SELECT id INTO v_supplier_id FROM suppliers WHERE name ILIKE '%ALİ KARAYAZI%' LIMIT 1;
  IF v_supplier_id IS NOT NULL THEN
    INSERT INTO supplier_historical_purchases (supplier_id, purchase_date, amount, external_reference, description, note)
    VALUES
      (v_supplier_id, '2025-01-25', 4420.00, '#15014', 'Deri & Sarf Malzemesi', '2025 Tarihsel Alım'),
      (v_supplier_id, '2025-02-05', 3240.00, '#15081', 'Deri & Sarf Malzemesi', '2025 Tarihsel Alım'),
      (v_supplier_id, '2025-03-06', 600.00, '#15321', 'Deri & Sarf Malzemesi', '2025 Tarihsel Alım')
    ON CONFLICT (supplier_id, external_reference) DO NOTHING;
  END IF;
END $$;

-- CHK-H01: 22.07.2026 Paketleme hepsiburada gider tutarı düzeltmesi (1.503,50 TL -> 1.187,20 TL)
UPDATE transactions
SET amount = -1187.20,
    description = CASE
      WHEN description LIKE '%[Düzeltme%' THEN description
      ELSE description || ' [Düzeltme: 1.503,50 TL -> 1.187,20 TL (gerçek sipariş toplamı)]'
    END
WHERE id = 49 AND amount = -1503.50;

-- Ambalaj tedarikçileri (material_supplier)
INSERT INTO suppliers (name, supplier_type)
SELECT 'Kutufix', 'material_supplier'
WHERE NOT EXISTS (SELECT 1 FROM suppliers WHERE name = 'Kutufix');

INSERT INTO suppliers (name, supplier_type)
SELECT 'Packanya', 'material_supplier'
WHERE NOT EXISTS (SELECT 1 FROM suppliers WHERE name = 'Packanya');

INSERT INTO suppliers (name, supplier_type)
SELECT 'Doğal Ambalaj', 'material_supplier'
WHERE NOT EXISTS (SELECT 1 FROM suppliers WHERE name = 'Doğal Ambalaj');

-- Ambalaj tedarikçileri salt okunur tarihsel alımlar (idempotent)
DO $$
DECLARE
  v_kutufix_id INT;
  v_packanya_id INT;
  v_dogal_id INT;
BEGIN
  SELECT id INTO v_kutufix_id FROM suppliers WHERE name = 'Kutufix' LIMIT 1;
  IF v_kutufix_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM supplier_historical_purchases
      WHERE supplier_id = v_kutufix_id AND purchase_date = '2025-04-14' AND amount = 629.00
    ) THEN
      INSERT INTO supplier_historical_purchases (supplier_id, purchase_date, amount, external_reference, description, note)
      VALUES (v_kutufix_id, '2025-04-14', 629.00, '#1665', 'Karton Kutu 15×11×5 cm', 'Tarihsel Alım');
    END IF;
  END IF;

  SELECT id INTO v_packanya_id FROM suppliers WHERE name = 'Packanya' LIMIT 1;
  IF v_packanya_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM supplier_historical_purchases
      WHERE supplier_id = v_packanya_id AND purchase_date = '2026-07-24' AND amount = 525.12
    ) THEN
      INSERT INTO supplier_historical_purchases (supplier_id, purchase_date, amount, external_reference, description, note)
      VALUES (v_packanya_id, '2026-07-24', 525.12, NULL, 'Kilitli Kutu 26×19×5 cm', 'Tarihsel Alım');
    END IF;
  END IF;

  SELECT id INTO v_dogal_id FROM suppliers WHERE name = 'Doğal Ambalaj' LIMIT 1;
  IF v_dogal_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM supplier_historical_purchases
      WHERE supplier_id = v_dogal_id AND purchase_date = '2026-07-31' AND amount = 662.08
    ) THEN
      INSERT INTO supplier_historical_purchases (supplier_id, purchase_date, amount, external_reference, description, note)
      VALUES (v_dogal_id, '2026-07-31', 662.08, NULL, 'Honeycomb Kraft Ambalaj 40 cm × 100 m', 'Tarihsel Alım');
    END IF;
  END IF;
END $$;

-- Ambalaj malzemeleri (stok miktarı 0, reorder_level NULL)
INSERT INTO materials (sku, name, family, material_type, unit, current_stock, reserved_stock, avg_cost, reorder_level)
SELECT 'PKG-KTU-26195', 'Kilitli Kutu 26×19×5 cm', 'Kutu', 'packaging', 'adet', 0, 0, 0, NULL
WHERE NOT EXISTS (SELECT 1 FROM materials WHERE name = 'Kilitli Kutu 26×19×5 cm' OR sku = 'PKG-KTU-26195');

INSERT INTO materials (sku, name, family, material_type, unit, current_stock, reserved_stock, avg_cost, reorder_level)
SELECT 'PKG-HNY-40CM', 'Honeycomb Kraft Ambalaj 40 cm', 'Kraft', 'packaging', 'metre', 0, 0, 0, NULL
WHERE NOT EXISTS (SELECT 1 FROM materials WHERE name = 'Honeycomb Kraft Ambalaj 40 cm' OR sku = 'PKG-HNY-40CM');

-- Kumaşçı tarihsel alım (idempotent, external_reference = NULL)
DO $$
DECLARE
  v_sup_id INT;
BEGIN
  SELECT id INTO v_sup_id FROM suppliers WHERE name ILIKE '%Kumaşçı%' LIMIT 1;
  IF v_sup_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM supplier_historical_purchases
      WHERE supplier_id = v_sup_id
        AND purchase_date = '2026-08-20'
        AND amount = 860.22
        AND description = 'Parafinli Kanvas Kumaş - 1 metre uzunluk x 150 cm en (1,50 m²)'
    ) THEN
      INSERT INTO supplier_historical_purchases (supplier_id, purchase_date, amount, external_reference, description, note)
      VALUES (v_sup_id, '2026-08-20', 860.22, NULL, 'Parafinli Kanvas Kumaş - 1 metre uzunluk x 150 cm en (1,50 m²)', '25.08.2026 tarihinde teslim alındı');
    END IF;
  END IF;
END $$;

-- Parafinli Kanvas Kumaş malzeme kartı ve fiziksel açılış stoku (idempotent)
DO $$
DECLARE
  v_mat_id INT;
  v_session_id INT;
  v_line_id INT;
BEGIN
  -- Malzeme kartı
  SELECT id INTO v_mat_id FROM materials WHERE sku = 'KNV-PRF-KKH' OR name = 'Parafinli Kanvas Kumaş — Koyu Kahve' LIMIT 1;
  IF v_mat_id IS NULL THEN
    INSERT INTO materials (sku, name, family, color, material_type, unit, current_stock, reserved_stock, avg_cost, reorder_level)
    VALUES ('KNV-PRF-KKH', 'Parafinli Kanvas Kumaş — Koyu Kahve', 'Kanvas', 'Koyu Kahve', 'textile', 'm²', 1.0000, 0, 573.4800, NULL)
    RETURNING id INTO v_mat_id;
  ELSE
    UPDATE materials
    SET current_stock = 1.0000, avg_cost = 573.4800, color = 'Koyu Kahve'
    WHERE id = v_mat_id;
  END IF;

  -- Açılış sayımı ve başlangıç stoku
  SELECT id INTO v_session_id FROM opening_sessions WHERE status = 'open' ORDER BY id DESC LIMIT 1;
  IF v_session_id IS NOT NULL THEN
    SELECT id INTO v_line_id FROM opening_lines
    WHERE session_id = v_session_id AND section = 'material' AND ref_key = v_mat_id::text LIMIT 1;

    IF v_line_id IS NULL THEN
      INSERT INTO opening_lines (session_id, section, ref_key, material_id, counted_qty, unit_cost, amount, location, status, notes, counted_at, updated_at)
      VALUES (v_session_id, 'material', v_mat_id::text, v_mat_id, 1.0000, 573.4800, 573.48, 'ATOLYE', 'counted',
              'Fiziksel açılış sayımı: 1,00 m² (Alış: 1,50 m² @ 860,22 TL)', NOW(), NOW())
      RETURNING id INTO v_line_id;
    ELSE
      UPDATE opening_lines
      SET counted_qty = 1.0000, unit_cost = 573.4800, amount = 573.48, status = 'counted',
          notes = 'Fiziksel açılış sayımı: 1,00 m² (Alış: 1,50 m² @ 860,22 TL)', counted_at = COALESCE(counted_at, NOW()), updated_at = NOW()
      WHERE id = v_line_id;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM stock_movements
      WHERE material_id = v_mat_id AND movement_type = 'opening_in' AND reference_type = 'OPENING_COMPLETION' AND reference_id = v_session_id
    ) THEN
      INSERT INTO stock_movements (material_id, movement_type, quantity, unit_cost, reference_type, reference_id, location, notes, created_at)
      VALUES (v_mat_id, 'opening_in', 1.0000, 573.4800, 'OPENING_COMPLETION', v_session_id, 'ATOLYE',
              'Açılış tamamlama: Fiziksel açılış sayımı: 1,00 m² (Alış: 1,50 m² @ 860,22 TL)', NOW());
    END IF;
  END IF;
END $$;

-- Karton Kutu 15×11×5 cm malzeme kartı (Kutufix) ve sayılmamış açılış satırı (idempotent)
DO $$
DECLARE
  v_mat_id INT;
  v_session_id INT;
BEGIN
  SELECT id INTO v_mat_id FROM materials WHERE sku = 'PKG-KTU-15115' OR name = 'Karton Kutu 15×11×5 cm' LIMIT 1;
  IF v_mat_id IS NULL THEN
    INSERT INTO materials (sku, name, family, material_type, unit, current_stock, reserved_stock, avg_cost, reorder_level)
    VALUES ('PKG-KTU-15115', 'Karton Kutu 15×11×5 cm', 'Kutu', 'packaging', 'adet', 0, 0, 0, NULL)
    RETURNING id INTO v_mat_id;
  END IF;

  SELECT id INTO v_session_id FROM opening_sessions WHERE status = 'open' ORDER BY id DESC LIMIT 1;
  IF v_session_id IS NOT NULL THEN
    INSERT INTO opening_lines (session_id, section, ref_key, material_id, status, location)
    VALUES (v_session_id, 'material', v_mat_id::text, v_mat_id, 'pending', 'ATOLYE')
    ON CONFLICT (session_id, section, ref_key) DO NOTHING;
  END IF;
END $$;

-- ===========================================================================
-- SİPARİŞ NUMARATÖRÜ (ORDER NUMBER GENERATOR)
-- Dönem bazlı (YYMM-NNN) atomik ve eşzamanlılığa dayanıklı sipariş sayacı
-- ===========================================================================

CREATE TABLE IF NOT EXISTS order_sequences (
  period   VARCHAR(4) PRIMARY KEY, -- '2609' (YYMM)
  last_val INT NOT NULL DEFAULT 0
);

-- Mevcut siparişlerden dönem bazında en yüksek sıra numarasını aktar (idempotent)
INSERT INTO order_sequences (period, last_val)
SELECT
  split_part(order_no, '-', 1) AS period,
  MAX(split_part(order_no, '-', 2)::int) AS last_val
FROM orders
WHERE order_no ~ '^[0-9]{4}-[0-9]+$'
GROUP BY split_part(order_no, '-', 1)
ON CONFLICT (period) DO UPDATE
  SET last_val = GREATEST(order_sequences.last_val, EXCLUDED.last_val);

-- Atomik numara üretici fonksiyon (Europe/Istanbul saat dilimi esaslı)
CREATE OR REPLACE FUNCTION next_order_no(p_order_date TIMESTAMPTZ DEFAULT NOW())
RETURNS VARCHAR(50) AS $$
DECLARE
  v_period VARCHAR(4);
  v_seq    INT;
BEGIN
  v_period := TO_CHAR(COALESCE(p_order_date, NOW()) AT TIME ZONE 'Europe/Istanbul', 'YYMM');

  INSERT INTO order_sequences (period, last_val)
  VALUES (v_period, 1)
  ON CONFLICT (period) DO UPDATE
    SET last_val = order_sequences.last_val + 1
  RETURNING last_val INTO v_seq;

  RETURN v_period || '-' || LPAD(v_seq::text, 3, '0');
END;
$$ LANGUAGE plpgsql;

-- Otomatik atama ve sayaç senkronizasyon trigger'ı
CREATE OR REPLACE FUNCTION set_order_no_trigger()
RETURNS TRIGGER AS $$
BEGIN
  -- 1. Açıkça formatlı numara verilmişse (ör. import): numarayı koru, sayacı ileri taşı
  IF NEW.order_no IS NOT NULL AND NEW.order_no ~ '^[0-9]{4}-[0-9]+$' THEN
    INSERT INTO order_sequences (period, last_val)
    VALUES (
      split_part(NEW.order_no, '-', 1),
      split_part(NEW.order_no, '-', 2)::int
    )
    ON CONFLICT (period) DO UPDATE
      SET last_val = GREATEST(order_sequences.last_val, EXCLUDED.last_val);

  -- 2. Numara boşsa: Europe/Istanbul bazlı atomik yeni numara ata
  ELSIF NEW.order_no IS NULL OR TRIM(NEW.order_no) = '' THEN
    NEW.order_no := next_order_no(COALESCE(NEW.order_date, NOW()));
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_orders_order_no ON orders;
CREATE TRIGGER trg_orders_order_no
  BEFORE INSERT ON orders
  FOR EACH ROW
  EXECUTE FUNCTION set_order_no_trigger();

-- Global tekillik koruması (iptal edilmiş siparişlerin numaraları da dahil korunur)
CREATE UNIQUE INDEX IF NOT EXISTS orders_order_no_uniq
  ON orders (order_no) WHERE order_no IS NOT NULL;

-- ===========================================================================
-- DIŞ ENTEGRASYON OLAY DEFTERİ (INTEGRATION EVENTS)
-- Provider-agnostic, pasif webhook event ledger
-- ===========================================================================

CREATE TABLE IF NOT EXISTS integration_events (
  id            BIGSERIAL PRIMARY KEY,
  provider      VARCHAR(50) NOT NULL,
  event_key     VARCHAR(255) NOT NULL,
  event_type    VARCHAR(100),
  payload       JSONB NOT NULL,
  body_sha256   VARCHAR(64),
  status        VARCHAR(30) NOT NULL DEFAULT 'received',
  received_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at  TIMESTAMPTZ,
  error_message TEXT,
  CONSTRAINT integration_events_provider_event_key_uniq UNIQUE (provider, event_key)
);

CREATE INDEX IF NOT EXISTS integration_events_provider_status_idx
  ON integration_events (provider, status, received_at DESC);

-- ===========================================================================
-- SİPARİŞ DIŞ SİSTEM REFERANSLARI (ORDER EXTERNAL REFS)
-- Decco OS iç kimliği ile dış pazar yeri/e-ticaret kimliklerini bağlar
-- ===========================================================================

CREATE TABLE IF NOT EXISTS order_external_refs (
  id          BIGSERIAL PRIMARY KEY,
  order_id    INT NOT NULL REFERENCES orders(id),
  provider    VARCHAR(50) NOT NULL,
  external_id VARCHAR(255) NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT order_external_refs_provider_not_empty CHECK (length(trim(provider)) > 0),
  CONSTRAINT order_external_refs_ext_id_not_empty CHECK (length(trim(external_id)) > 0),
  CONSTRAINT order_external_refs_provider_canonical CHECK (provider = lower(trim(provider))),
  CONSTRAINT order_external_refs_ext_id_canonical CHECK (external_id = trim(external_id)),
  CONSTRAINT order_external_refs_provider_ext_uniq UNIQUE (provider, external_id),
  CONSTRAINT order_external_refs_order_provider_uniq UNIQUE (order_id, provider)
);

-- ===========================================================================
-- MÜŞTERİ DIŞ SİSTEM REFERANSLARI (CUSTOMER EXTERNAL REFS)
-- Kayıtlı dış müşteri kimlikleri ile Decco OS müşteri kartlarını bağlar
-- ===========================================================================

CREATE TABLE IF NOT EXISTS customer_external_refs (
  id          BIGSERIAL PRIMARY KEY,
  customer_id INT NOT NULL REFERENCES customers(id),
  provider    VARCHAR(50) NOT NULL,
  external_id VARCHAR(255) NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT customer_external_refs_provider_not_empty CHECK (length(trim(provider)) > 0),
  CONSTRAINT customer_external_refs_ext_id_not_empty CHECK (length(trim(external_id)) > 0),
  CONSTRAINT customer_external_refs_provider_canonical CHECK (provider = lower(trim(provider))),
  CONSTRAINT customer_external_refs_ext_id_canonical CHECK (external_id = trim(external_id)),
  CONSTRAINT customer_external_refs_provider_ext_uniq UNIQUE (provider, external_id),
  CONSTRAINT customer_external_refs_customer_provider_uniq UNIQUE (customer_id, provider)
);

-- ===========================================================================
-- SİPARİŞ ADRES SNAPSHOTLARI (ORDER ADDRESSES)
-- Sipariş anındaki teslimat (shipping) ve fatura (billing) adreslerini dondurur
-- ===========================================================================

CREATE TABLE IF NOT EXISTS order_addresses (
  id           BIGSERIAL PRIMARY KEY,
  order_id     INT NOT NULL REFERENCES orders(id),
  address_type VARCHAR(20) NOT NULL,
  first_name   VARCHAR(100),
  last_name    VARCHAR(100),
  company      VARCHAR(200),
  phone        VARCHAR(30),
  email        VARCHAR(150),
  address_1    TEXT,
  address_2    TEXT,
  city         VARCHAR(100),
  district     VARCHAR(100),
  state        VARCHAR(100),
  postcode     VARCHAR(20),
  country      VARCHAR(10),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT order_addresses_type_check CHECK (address_type IN ('shipping', 'billing')),
  CONSTRAINT order_addresses_order_type_uniq UNIQUE (order_id, address_type)
);

-- ===========================================================================
-- PAYTR ÖDEME LİNKLERİ (PAYTR PAYMENT LINKS)
-- Decco OS siparişlerine ait PayTR ödeme linklerini ve durumlarını takip eder
-- ===========================================================================

CREATE TABLE IF NOT EXISTS paytr_payment_links (
  id                   BIGSERIAL PRIMARY KEY,
  order_id             INT NOT NULL REFERENCES orders(id),
  callback_id          VARCHAR(64) NOT NULL UNIQUE,
  paytr_link_id        VARCHAR(100) NULL UNIQUE,
  link_url             TEXT NULL,
  requested_amount     NUMERIC(12,2) NOT NULL,
  currency             VARCHAR(10) NOT NULL DEFAULT 'TL',
  status               VARCHAR(30) NOT NULL DEFAULT 'pending',
  merchant_oid         VARCHAR(255) NULL UNIQUE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at           TIMESTAMPTZ NULL,
  callback_received_at TIMESTAMPTZ NULL,
  paid_at              TIMESTAMPTZ NULL,
  CONSTRAINT paytr_payment_links_amount_pos CHECK (requested_amount > 0),
  CONSTRAINT paytr_payment_links_callback_not_empty CHECK (length(trim(callback_id)) > 0),
  CONSTRAINT paytr_payment_links_callback_alphanumeric CHECK (callback_id ~ '^[a-zA-Z0-9]+$'),
  CONSTRAINT paytr_payment_links_merchant_oid_format CHECK (merchant_oid IS NULL OR (length(trim(merchant_oid)) > 0 AND merchant_oid = trim(merchant_oid))),
  CONSTRAINT paytr_payment_links_status_check CHECK (status IN ('creating', 'pending', 'create_unknown', 'paid', 'cancelled', 'expired', 'failed')),
  CONSTRAINT paytr_payment_links_currency_check CHECK (currency IN ('TL', 'USD', 'EUR', 'GBP', 'RUB'))
);

CREATE INDEX IF NOT EXISTS idx_paytr_payment_links_order_id ON paytr_payment_links(order_id);
CREATE INDEX IF NOT EXISTS idx_paytr_payment_links_status ON paytr_payment_links(status);

-- Idempotent constraint migration for existing table
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'paytr_payment_links_status_check'
  ) THEN
    ALTER TABLE paytr_payment_links DROP CONSTRAINT paytr_payment_links_status_check;
  END IF;
  ALTER TABLE paytr_payment_links ADD CONSTRAINT paytr_payment_links_status_check
    CHECK (status IN ('creating', 'pending', 'create_unknown', 'paid', 'cancelled', 'expired', 'failed'));
END $$;

-- Sipariş başına aynı anda yalnızca TEK BİR aktif link (creating, pending, create_unknown) olabilir
CREATE UNIQUE INDEX IF NOT EXISTS idx_paytr_payment_links_active_order
  ON paytr_payment_links (order_id) WHERE status IN ('creating', 'pending', 'create_unknown');

-- ===========================================================================
-- ÖDEME DIŞ SİSTEM REFERANSLARI (PAYMENT EXTERNAL REFS)
-- Tahsilat düzeyinde harici işlem kimliklerini (merchant_oid, transaction_id vb.) bağlar
-- ===========================================================================

CREATE TABLE IF NOT EXISTS payment_external_refs (
  id             BIGSERIAL PRIMARY KEY,
  payment_id     INT NOT NULL REFERENCES customer_payments(id),
  provider       VARCHAR(50) NOT NULL,
  reference_type VARCHAR(50) NOT NULL,
  external_id    VARCHAR(255) NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payment_external_refs_provider_not_empty CHECK (length(trim(provider)) > 0),
  CONSTRAINT payment_external_refs_ref_type_not_empty CHECK (length(trim(reference_type)) > 0),
  CONSTRAINT payment_external_refs_ext_id_not_empty CHECK (length(trim(external_id)) > 0),
  CONSTRAINT payment_external_refs_provider_canonical CHECK (provider = lower(trim(provider))),
  CONSTRAINT payment_external_refs_ref_type_canonical CHECK (reference_type = lower(trim(reference_type))),
  CONSTRAINT payment_external_refs_ext_id_canonical CHECK (external_id = trim(external_id)),
  CONSTRAINT payment_external_refs_provider_ref_ext_uniq UNIQUE (provider, reference_type, external_id),
  CONSTRAINT payment_external_refs_payment_provider_ref_uniq UNIQUE (payment_id, provider, reference_type)
);

-- ===========================================================================
-- PAYTR MUTABAKAT VE KOMİSYON KAYITLARI (PAYTR RECONCILIATIONS)
-- Tahsilat düzeyinde PayTR durum sorgusu ile teyit edilen net ve komisyon mutabakatını saklar
-- ===========================================================================

CREATE TABLE IF NOT EXISTS paytr_reconciliations (
  id                        SERIAL PRIMARY KEY,
  payment_id                INT NOT NULL REFERENCES customer_payments(id),
  merchant_oid              VARCHAR(255) NOT NULL,
  payment_amount            NUMERIC(14,2) NOT NULL,
  payment_total             NUMERIC(14,2) NULL,
  net_amount                NUMERIC(14,2) NOT NULL,
  commission_amount         NUMERIC(14,2) NOT NULL,
  payment_date              TIMESTAMPTZ NULL,
  commission_transaction_id INT NULL REFERENCES transactions(id),
  reconciled_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT paytr_reconciliations_payment_amount_pos CHECK (payment_amount > 0),
  CONSTRAINT paytr_reconciliations_net_amount_nonneg CHECK (net_amount >= 0),
  CONSTRAINT paytr_reconciliations_commission_amount_nonneg CHECK (commission_amount >= 0),
  CONSTRAINT paytr_reconciliations_sum_check CHECK (payment_amount = net_amount + commission_amount),
  CONSTRAINT paytr_reconciliations_oid_not_empty CHECK (length(trim(merchant_oid)) > 0),
  CONSTRAINT paytr_reconciliations_oid_canonical CHECK (merchant_oid = trim(merchant_oid)),
  CONSTRAINT paytr_reconciliations_payment_id_uniq UNIQUE (payment_id),
  CONSTRAINT paytr_reconciliations_merchant_oid_uniq UNIQUE (merchant_oid)
);

-- ===========================================================================
-- PAYTR BANKA YATIŞI / VİRMAN MUTABAKATLARI (PAYTR SETTLEMENTS)
-- PayTR net alacaklarının banka hesabına toplu virman kayıtlarını saklar
-- ===========================================================================

CREATE TABLE IF NOT EXISTS paytr_settlements (
  id                  SERIAL PRIMARY KEY,
  settlement_ref      VARCHAR(100) NOT NULL UNIQUE,
  target_account_id   INT NOT NULL REFERENCES accounts(id),
  gross_amount        NUMERIC(14,2) NOT NULL,
  commission_amount   NUMERIC(14,2) NOT NULL,
  net_amount          NUMERIC(14,2) NOT NULL,
  transfer_ref        UUID NOT NULL UNIQUE,
  bank_value_date     TIMESTAMPTZ NOT NULL,
  bank_reference      VARCHAR(255) NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT paytr_settlements_gross_pos CHECK (gross_amount > 0),
  CONSTRAINT paytr_settlements_commission_nonneg CHECK (commission_amount >= 0),
  CONSTRAINT paytr_settlements_net_pos CHECK (net_amount > 0),
  CONSTRAINT paytr_settlements_sum_check CHECK (gross_amount = net_amount + commission_amount),
  CONSTRAINT paytr_settlements_ref_not_empty CHECK (length(trim(settlement_ref)) > 0),
  CONSTRAINT paytr_settlements_bank_ref_not_empty CHECK (bank_reference IS NULL OR length(trim(bank_reference)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS paytr_settlements_bank_ref_uniq
  ON paytr_settlements (UPPER(TRIM(bank_reference))) WHERE bank_reference IS NOT NULL;

CREATE TABLE IF NOT EXISTS paytr_settlement_reconciliations (
  id                 BIGSERIAL PRIMARY KEY,
  settlement_id      INT NOT NULL REFERENCES paytr_settlements(id),
  reconciliation_id  INT NOT NULL REFERENCES paytr_reconciliations(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT paytr_settlement_reconciliations_uniq UNIQUE (reconciliation_id)
);

CREATE INDEX IF NOT EXISTS idx_paytr_settlement_reconciliations_settlement_id
  ON paytr_settlement_reconciliations(settlement_id);

-- ===========================================================================
-- PAYTR GEÇMİŞ İŞLEM DÖKÜMÜ & STAGING (HISTORICAL TRANSACTIONS & MATCHING)
-- PayTR İşlem Dökümü API'sinden çekilen tarihsel hareketleri ve eşleme durumlarını saklar.
-- Finansal mutasyon KESİNLİKLE YAPMAZ.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS paytr_history_fetches (
  id                   SERIAL PRIMARY KEY,
  requested_start_date DATE NOT NULL,
  requested_end_date   DATE NOT NULL,
  status               VARCHAR(30) NOT NULL, -- 'running', 'completed', 'partial', 'failed'
  chunk_count          INT NOT NULL DEFAULT 0,
  success_chunk_count  INT NOT NULL DEFAULT 0,
  failed_chunk_count   INT NOT NULL DEFAULT 0,
  error_summary        TEXT NULL,
  fetched_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT paytr_history_fetches_status_check CHECK (status IN ('running', 'completed', 'partial', 'failed'))
);

CREATE TABLE IF NOT EXISTS paytr_history_fetch_chunks (
  id            SERIAL PRIMARY KEY,
  fetch_id      INT NOT NULL REFERENCES paytr_history_fetches(id),
  chunk_no      INT NOT NULL,
  start_at      VARCHAR(30) NOT NULL,
  end_at        VARCHAR(30) NOT NULL,
  status        VARCHAR(20) NOT NULL, -- 'success', 'empty', 'failed'
  row_count     INT NOT NULL DEFAULT 0,
  error_code    VARCHAR(50) NULL,
  error_message TEXT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT paytr_history_fetch_chunks_status_check CHECK (status IN ('success', 'empty', 'failed'))
);

CREATE TABLE IF NOT EXISTS paytr_history_transactions (
  id                 SERIAL PRIMARY KEY,
  transaction_type   VARCHAR(5) NOT NULL,
  merchant_order_no  VARCHAR(255) NOT NULL,
  transaction_amount NUMERIC(14,2) NOT NULL,
  payment_amount     NUMERIC(14,2) NULL,
  net_amount         NUMERIC(14,2) NOT NULL,
  commission_amount  NUMERIC(14,2) NOT NULL,
  commission_rate    NUMERIC(6,4) NULL,
  transaction_date   DATE NOT NULL,
  currency           VARCHAR(10) NOT NULL,
  installment        SMALLINT NULL,
  card_brand         VARCHAR(50) NULL,
  masked_card        VARCHAR(30) NULL,
  payment_type       VARCHAR(50) NULL,
  source_signature   VARCHAR(64) NOT NULL,
  occurrence_no      INT NOT NULL DEFAULT 1,
  first_seen_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT paytr_history_txns_type_check CHECK (transaction_type IN ('S', 'I')),
  CONSTRAINT paytr_history_txns_sig_occ_uniq UNIQUE (source_signature, occurrence_no),
  CONSTRAINT paytr_history_txns_amounts_nonneg CHECK (transaction_amount >= 0 AND net_amount >= 0 AND commission_amount >= 0)
);

CREATE TABLE IF NOT EXISTS paytr_history_fetch_transactions (
  fetch_id               INT NOT NULL REFERENCES paytr_history_fetches(id),
  history_transaction_id INT NOT NULL REFERENCES paytr_history_transactions(id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (fetch_id, history_transaction_id)
);

CREATE TABLE IF NOT EXISTS paytr_history_matches (
  id                     SERIAL PRIMARY KEY,
  history_transaction_id INT NOT NULL UNIQUE REFERENCES paytr_history_transactions(id),
  order_id               INT NULL REFERENCES orders(id),
  payment_id             INT NULL REFERENCES customer_payments(id),
  match_method           VARCHAR(50) NOT NULL,
  confidence             VARCHAR(20) NOT NULL, -- 'exact', 'suggested', 'conflict', 'manual'
  candidate_details      JSONB NULL,
  confirmed_by_user      BOOLEAN NOT NULL DEFAULT false,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at           TIMESTAMPTZ NULL,
  CONSTRAINT paytr_history_matches_confidence_check CHECK (confidence IN ('exact', 'suggested', 'conflict', 'manual'))
);

CREATE INDEX IF NOT EXISTS idx_paytr_history_txns_merchant_order_no
  ON paytr_history_transactions(merchant_order_no);

CREATE INDEX IF NOT EXISTS idx_paytr_history_txns_date
  ON paytr_history_transactions(transaction_date);

CREATE INDEX IF NOT EXISTS idx_paytr_history_matches_order_id
  ON paytr_history_matches(order_id);

-- ===========================================================================
-- WHATSAPP NORMALİZE MESAJLAR (WHATSAPP MESSAGES)
-- Meta WhatsApp Cloud API gelen mesajlarının yapısal defteri
-- ===========================================================================

CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id                   BIGSERIAL PRIMARY KEY,
  integration_event_id BIGINT REFERENCES integration_events(id) ON DELETE SET NULL,
  message_id           VARCHAR(255) NOT NULL UNIQUE,
  wa_id                VARCHAR(100) NOT NULL,
  phone                VARCHAR(100) NOT NULL,
  sender_name          VARCHAR(255),
  message_timestamp    TIMESTAMPTZ NOT NULL,
  message_type         VARCHAR(50) NOT NULL,
  text                 TEXT,
  direction            VARCHAR(20) NOT NULL DEFAULT 'inbound',
  order_id             INT NULL REFERENCES orders(id) ON DELETE SET NULL,
  raw_message          JSONB NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_wa_id
  ON whatsapp_messages(wa_id);

CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_timestamp
  ON whatsapp_messages(message_timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_order_id
  ON whatsapp_messages(order_id);


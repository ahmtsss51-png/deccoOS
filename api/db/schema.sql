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
  created_at TIMESTAMPTZ DEFAULT NOW()
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

-- Varsayılan departmanlar
INSERT INTO departments (name, color) VALUES
  ('Yönetim', 'purple'),
  ('Üretim', 'yellow'),
  ('Satış', 'green'),
  ('Finans', 'blue'),
  ('Depo', 'gray')
ON CONFLICT (name) DO NOTHING;

-- Varsayılan admin kullanıcı (şifre: decco123)
INSERT INTO users (full_name, username, password_hash, role, department)
VALUES ('Yönetici', 'admin', '$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'admin', 'Yönetim')
ON CONFLICT (username) DO NOTHING;

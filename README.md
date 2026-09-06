# Decco OS

Decco Deri için üretim yönetim sistemi. Docker ile çalışır.

## Gereksinimler

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Mac veya Windows)

## Kurulum

```bash
# 1. Repoyu klonla
git clone <repo-url>
cd deccoderi

# 2. Ortam değişkenlerini ayarla (opsiyonel)
cp .env.example .env

# 3. Başlat
docker compose up -d
```

Sistem hazır: http://localhost

Varsayılan giriş: `admin` / `decco123`

## Durdurma

```bash
docker compose down
```

Veritabanını da silmek için:

```bash
docker compose down -v
```

## Sayfalar

| Sayfa | URL |
|-------|-----|
| Giriş | `/login.html` |
| Dashboard | `/dashboard.html` |
| Siparişler | `/orders.html` |
| Üretim | `/production.html` |
| Stok | `/stock.html` |
| Müşteriler | `/customers.html` |
| Finans | `/finance.html` |
| Ürünler | `/products.html` |
| Tedarikçiler | `/suppliers.html` |
| Raporlar | `/reports.html` |
| Ayarlar | `/settings.html` |

## Mimari

```
web/    → Nginx (port 80) — statik HTML/JS/CSS
api/    → Node.js/Express (port 3000) — REST API
db/     → PostgreSQL 16 (port 5432)
```

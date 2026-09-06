#!/bin/bash
# Decco OS — Mac Kurulum Scripti (Docker Desktop gerekli)

set -e

echo "🍎 Decco OS Mac Kurulumu"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Docker kontrol
if ! command -v docker &> /dev/null; then
  echo "❌ Docker Desktop kurulu değil. Lütfen kuruyun: https://www.docker.com/products/docker-desktop"
  exit 1
fi

if ! docker ps &> /dev/null; then
  echo "❌ Docker daemon çalışmıyor. Docker Desktop'ı başlatın."
  exit 1
fi

echo "✅ Docker OK"

# Repo klasörü sor
read -p "📁 Decco OS klasörü (default: ~/decco-os): " PROJECT_DIR
PROJECT_DIR=${PROJECT_DIR:-"$HOME/decco-os"}

# Klonla
if [ ! -d "$PROJECT_DIR" ]; then
  echo "📥 Repo klonlanıyor..."
  read -p "GitHub Repo URL: " GITHUB_URL
  git clone "$GITHUB_URL" "$PROJECT_DIR"
fi

cd "$PROJECT_DIR"
echo "📍 Çalışma dizini: $PWD"

# Docker Compose başlat
echo "🐳 Docker Compose başlatılıyor..."
docker compose up -d

echo "⏳ Veritabanı hazırlanıyor (30 saniye)..."
sleep 30

# Database kontrol
echo "🔌 Veritabanı bağlantısı kontrol ediliyor..."
until docker exec decco_db pg_isready -U decco -d decco &> /dev/null; do
  echo "  ⏳ Bekleniyor..."
  sleep 5
done

echo "✅ Veritabanı hazır"

# Admin şifresi ayarla (admin123)
echo "🔑 Admin şifresi ayarlanıyor..."
docker exec decco_api node --input-type=module -e @'
import bcrypt from "bcryptjs"
import pg from "pg"
const pool = new pg.Pool({connectionString: process.env.DATABASE_URL})
const hash = await bcrypt.hash("admin123", 10)
await pool.query("UPDATE users SET password_hash=$1 WHERE username=$2", [hash, "admin"])
console.log("✅ Şifre: admin123")
await pool.end()
'@

# Veri kontrol
echo "📊 Tarihsel veri kontrol ediliyor..."
RESULT=$(docker exec decco_db psql -U decco -d decco -t -c "SELECT COUNT(*), ROUND(SUM(total_amount)::numeric,2), ROUND(SUM(paid_amount)::numeric,2), ROUND(SUM(total_amount-paid_amount)::numeric,2) FROM orders WHERE deleted_at IS NULL;" 2>/dev/null)

echo "📋 Mutabakat: $RESULT"
if [[ "$RESULT" == *"43"* ]]; then
  echo "✅ Tarihsel veri bütün"
else
  echo "⚠️ Veri tabanı boş olabilir. Veri taşıması gerekiyorsa:"
  echo "   - Windows'tan: docker exec decco_db pg_dump -U decco decco | bzip2 > decco.sql.bz2"
  echo "   - Mac'te: bzcat decco.sql.bz2 | docker exec -i decco_db psql -U decco -d decco"
fi

# Hizmetler kontrol
echo "🚀 Hizmetler çalıştırılıyor..."
docker compose ps

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ KURULUM TAMAMLANDI!"
echo ""
echo "🌐 Erişim:"
echo "   • Web: http://localhost"
echo "   • API: http://localhost:3000"
echo "   • DB:  localhost:5432 (decco/decco)"
echo ""
echo "🔑 Giriş Bilgileri:"
echo "   • Kullanıcı: admin"
echo "   • Şifre: admin123"
echo ""
echo "📜 Loglar: docker compose logs -f"
echo "🛑 Durdur: docker compose down"

# Decco OS — Kurulum Talimatları

## 📦 Ön Koşullar

### Windows / Linux
- Docker & Docker Compose
- Git

### Mac
- Docker Desktop (https://www.docker.com/products/docker-desktop)
- Git

---

## 🚀 1. GitHub'a Gönder (Windows/Linux)

```bash
cd /path/to/decco-os
bash scripts/push-to-github.sh
```

İçinde isteyecekleri:
- **GitHub Repo URL**: `https://github.com/KULLANICI/decco-os`
- **GitHub Personal Access Token** (Fine-grained token, repo yazma yetkisi)

Token oluştur: https://github.com/settings/personal-access-tokens/new

---

## 🍎 2. Mac'te Kurulum

### A. Repoyu İndir

```bash
git clone https://github.com/KULLANICI/decco-os.git
cd decco-os
```

### B. Otomatik Setup (önerilir)

```bash
bash scripts/setup-mac.sh
```

Bu script:
1. ✅ Docker kontrol eder
2. 🐳 Docker Compose başlatır
3. 🔌 Veritabanı hazır olana kadar bekler
4. 🔑 Admin şifresi ayarlar (admin123)
5. 📊 Tarihsel veri kontrol eder

### C. Manual Setup (Docker açıksa)

```bash
docker compose up -d
sleep 30
# Logları kontrol et: docker compose logs api
```

---

## 📊 3. Veriyi Windows'tan Mac'e Taşı

### Adım 1: Windows'ta Backup Yap

```bash
cd C:\Users\HP\Desktop\deccoderi
bash scripts/export-db.sh
# Dosya: decco_backup_YYYYMMDD_HHMMSS.sql.bz2
```

### Adım 2: Mac'e Kopyala

```bash
# Terminal'de (Mac'te):
scp windows_user@windows_host:~/decco_backup_*.sql.bz2 ~/
```

Ya da USB'den kopyala.

### Adım 3: Mac'te Import Et

```bash
# Mac'te:
cd ~/decco-os
bzcat ~/decco_backup_*.sql.bz2 | docker exec -i decco_db psql -U decco -d decco
echo "✅ Veri yüklendi"
```

### Adım 4: Kontrol Et

```bash
docker exec decco_db psql -U decco -d decco -c \
  "SELECT COUNT(*), SUM(total_amount) FROM orders WHERE deleted_at IS NULL;"
# Sonuç: 43 | 58798.00
```

---

## 🌐 Erişim

| Servis | URL |
|--------|-----|
| Web | http://localhost |
| API | http://localhost:3000 |
| DB | localhost:5432 |

### Giriş

```
Kullanıcı: admin
Şifre: admin123
```

---

## 📋 Kontrol Listesi

- [ ] Docker Desktop çalışıyor
- [ ] `docker compose up -d` başarılı
- [ ] Web sayfası açılıyor: http://localhost
- [ ] Login çalışıyor (admin/admin123)
- [ ] Mutabakat: 43 sipariş, 58.798 TL
- [ ] Finans sayfası "Tahsilat Al" gösteriyor
- [ ] Tedarikçi detay sayfası çalışıyor
- [ ] Ürünler sıralama çalışıyor

---

## 🛠️ Troubleshooting

### Docker Desktop açılmıyor (Mac)

```bash
# Hata: Cannot connect to Docker daemon
# Çözüm: Docker Desktop uygulamasını açın
open /Applications/Docker.app
```

### Veritabanı timeout

```bash
# Hata: connection refused
# Çözüm: Bekle ve retry
docker compose logs db
sleep 60 && docker compose ps
```

### Port 80/3000 kullanımda

```bash
# Hata: Address already in use
# Çözüm: Çalışan container'ı kapat
docker compose down
# Ya da farklı port kullan (docker-compose.yml'i edit et)
```

### Veri boş gösteriliyor

```bash
# Kontrol: Veritabanı şeması hazır mı?
docker exec decco_db psql -U decco -d decco -c "\dt"
# 43+ tablo görmeli

# Veri yoksa import et (SETUP adım 3)
bzcat decco_backup_*.sql.bz2 | docker exec -i decco_db psql -U decco -d decco
```

---

## 📞 Destek

Sorun mu? Kontrol et:

```bash
# Tüm logları göster
docker compose logs

# Belirli servisi
docker compose logs api
docker compose logs db

# Terminal'den API test
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}'
```

---

**Yapı:** Aşama 1 (siparişler + müşteriler) + Aşama 2 (finans + tedarikçi + ürünler) tamamlandı.

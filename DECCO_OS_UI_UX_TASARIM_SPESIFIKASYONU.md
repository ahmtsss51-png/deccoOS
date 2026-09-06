# Decco OS — UI/UX ve Arayüz Tasarım Spesifikasyonu

> Bu doküman, Decco OS'un sıfırdan yeniden geliştirilecek arayüzü için teknoloji bağımsız UI/UX rehberidir. Amaç masaüstünde güçlü, telefonda hızlı, üretim ortamında anlaşılır bir yönetim paneli oluşturmaktır.

---

# 1. Tasarım amacı

Decco OS arayüzü:

- Muhasebe programı gibi korkutucu görünmemeli
- ERP gibi yüzlerce menü içermemeli
- Günlük üretim yapan kişinin hızlı anlayacağı kadar sade olmalı
- İşletmenin tamamını tek bakışta yönetecek kadar güçlü olmalı
- Mobil kullanımda hızlı olmalı
- Bilgi yoğunluğu ile sadelik arasında denge kurmalı

Ana UX ilkesi:

> Kullanıcı önce “ne yapmam gerekiyor?” sorusunun cevabını görmeli, sonra detaya inmelidir.

---

# 2. Genel görsel karakter

- Modern
- Temiz
- Premium ama aşırı gösterişli değil
- Büyük ve okunaklı başlıklar
- Yuvarlatılmış kartlar
- Net boşluk kullanımı
- Sade ikonlar
- Tutarlı durum renkleri
- Mobil uyumlu responsive düzen
- Gereksiz animasyon yok
- Kritik işlemlerde güçlü geri bildirim

Markanın deri/el işçiliği karakteri hafif hissedilebilir; yönetim paneli ürün katalog sitesi gibi görünmemelidir.

---

# 3. Navigasyon

## 3.1 Masaüstü

Sol sidebar:

- Dashboard
- Siparişler
- Üretim
- Stok
- Ürünler
- Müşteriler
- Satın Alma
- Tedarikçiler
- Finans
- İadeler / Değişimler
- Raporlar
- Demirbaşlar
- Ayarlar

Alt bölüm:

- Kullanıcı
- Rol
- Çıkış

Menü isimleri teknik değil işletme diliyle yazılmalıdır.

Yanlış:

- Inventory Movements
- Production Allocations
- Material Selections

Doğru:

- Stok
- Üretim
- Malzemeler
- Hazır Ürünler

---

## 3.2 Mobil

Alt navigasyon:

- Ana Sayfa
- Siparişler
- Üretim
- Stok
- Daha Fazla

Sık kullanılan aksiyonlar için belirgin “+” butonu düşünülebilir.

---

# 4. Dashboard

İlk ekran Dashboard olmalıdır.

## 4.1 Üst alan

Başlık:

**Decco OS**

Altında:

- Tarih
- Günün kısa operasyon özeti

Örnek:

> Bugün 5 sipariş hazırlanmalı, 2 sipariş üretimde.

## 4.2 Operasyon kartları

- Hazırlanacak
- Üretimde
- Hazır
- Geciken

Kartlara basınca ilgili filtreli liste açılır.

## 4.3 Finans kartları

- Kasa / Banka
- Müşteri Alacağı
- Tedarikçi Borcu
- Bu Ay Tahsilat

## 4.4 Stok kartları

- Kritik Stok
- Ham Madde Değeri
- Hazır Ürün Adedi
- Rezerve Stok

## 4.5 Bugünün işleri

Örnek:

- PF001 / Yeşil / AHMET — Kesim
- CW001 / Siyah / Baskısız — Dikiş
- DP001 / Camel / MERVE — Paketleme

Her satırda:

- ürün
- deri/renk
- kişiselleştirme
- aşama
- teslim tarihi

olmalıdır.

---

# 5. Sipariş listesi

Sipariş kartı/satırı:

- Sipariş no
- Müşteri
- Toplam
- Ödenen
- Kalan
- Durum
- Sipariş tarihi
- Teslim tarihi
- Ürün sayısı
- Kaynak

Örnek:

**#1042 — Mehmet Yılmaz**

2 ürün  
1.850 TL  
Ödendi: 600 TL  
Kalan: 1.250 TL  
Durum: Üretim Bekliyor

---

## 5.1 Ürün özetleri listede görünmeli

Yalnız “2 ürün” yazması yeterli değildir.

Örnek:

- PF001 · Kaşmir Yeşil · AHMET
- CW001 · Crazy Siyah · Baskısız

Çok ürün varsa:

**+2 ürün daha**

şeklinde kapanabilir.

---

## 5.2 Filtreler

- Tümü
- Ödeme Bekliyor
- Üretim Bekliyor
- Üretimde
- Hazır
- Kargolandı
- Tamamlandı
- Geciken
- İptal

Ek filtreler:

- Tarih
- Müşteri
- Kaynak
- Ürün
- Ödeme durumu

Mobilde filtreler bottom sheet olabilir.

---

# 6. Yeni sipariş oluşturma

Mümkün olduğunca tek akışta tamamlanmalıdır.

## Adım 1 — Müşteri

- Müşteri ara
- Yeni müşteri ekle

## Adım 2 — Ürün

Ürün kartlarından seç.

## Adım 3 — Konfigürasyon

- Varyant
- Ana deri
- İkincil deri
- Renk
- İsim baskısı
- Ek not

Alanlar yalnız ürün gerektiriyorsa gösterilir.

## Adım 4 — Fiyat

- Birim fiyat
- Adet
- İndirim
- Satır toplamı

## Adım 5 — Ödeme

- Ödeme alınmadı
- Kapora alındı
- Tam ödeme
- Tutar
- Yöntem
- Hesap

## Adım 6 — Onay

Sipariş özeti gösterilir.

---

# 7. Sipariş detay ekranı

Üst başlık:

**Sipariş #1042**

- Müşteri
- Durum
- Tarih

Ana aksiyonlar:

- Düzenle
- Ödeme Ekle
- Üretime Gönder
- İptal

---

## 7.1 Finans özeti

Toplam: 2.400 TL  
Ödenen: 800 TL  
Kalan: 1.600 TL

Kapora ilerleme barı:

**%33 üretim eşiği**

Eşik karşılandıysa:

✓ Üretim başlatılabilir

Karşılanmadıysa:

! Üretim için onay gerekiyor

---

## 7.2 Ürün kartları

Her ürün ayrı kart olmalıdır.

Örnek:

### PF001 — Portföy

Adet: 1  
Ana deri: Kaşmir / Yeşil  
İsim baskısı: AHMET  
Fiyat: 1.200 TL  
Durum: Üretimde

---

## 7.3 Timeline

- Sipariş oluşturuldu
- 500 TL ödeme alındı
- Üretim onaylandı
- Üretime başladı
- Üretim tamamlandı
- Paketlendi
- Kargolandı

Timeline hata çözümü ve denetim için önemlidir.

---

# 8. Üretim ekranı

Sekmeler:

- Bekleyen
- Üretimde
- Kontrol
- Tamamlanan

Üretim kartı örneği:

### PF001 — Portföy

Müşteri: Mehmet  
Ana deri: Kaşmir Yeşil  
İsim: AHMET  
Adet: 1  
Durum: Kesim

Aksiyonlar:

- Başlat
- Sonraki Aşama
- Sorun Bildir
- Tamamla

---

# 9. Üretim detayında malzemeler

**Gerekli**

- Ana deri — Kaşmir Yeşil — 2,2 desi
- İplik — 1
- Yapıştırıcı — 4 ml

**Gerçek Tüketim**

- Kaşmir Yeşil — 2,3 desi

Fark:

+0,1 desi

---

# 10. Üretim kuyruğu

Kolonlar:

- Sıra
- Sipariş
- Ürün
- Müşteri
- Malzeme
- Kişiselleştirme
- Termin
- Durum

Öncelik sırası görünür olmalıdır.

---

# 11. Stok ekranı

Sekmeler:

- Malzemeler
- Hazır Ürünler
- Hareketler
- Sayım

---

# 12. Malzeme stoğu

Liste alanları:

- Kod
- Malzeme
- Aile
- Renk
- Mevcut
- Rezerve
- Kullanılabilir
- Ortalama maliyet

Örnek:

**KM-YSL — Kaşmir / Yeşil**

Mevcut: 24,5 desi  
Rezerve: 6,2  
Kullanılabilir: 18,3

---

# 13. Kritik stok

Kritik malzemeler ayrı gösterilebilir.

Örnek:

**Crazy Siyah — 2,1 desi kaldı**

Aksiyon:

**Satın Alma Oluştur**

---

# 14. Hazır ürün stoğu

Yalnız ürün toplamını değil malzeme konfigürasyonunu da göstermelidir.

Örnek:

### PF001

Toplam: 4

- Kaşmir / Yeşil — 2
- Crazy / Siyah — 1
- Pueblo / Camel — 1

Detayda lotlar:

**Output #101**

- 2 adet
- Kaşmir Yeşil
- Üretim tarihi
- Maliyet

---

# 15. Stok hareketleri

Kolonlar:

- Tarih
- Ürün / Malzeme
- İşlem
- Giriş
- Çıkış
- Konum
- Kaynak
- Açıklama

Teknik işlem kodları kullanıcıya doğrudan gösterilmemelidir.

Örnek:

“PRODUCTION_CONSUMPTION_OUT” yerine:

**Üretimde Kullanıldı**

---

# 16. Ürünler ekranı

Ürün kartı:

- Fotoğraf
- Kod
- Ürün adı
- Aktif / pasif
- Satış fiyatı
- Kişiselleştirme durumu

Detay:

- Yapısal varyantlar
- Reçete
- Malzeme slotları
- Fiyat
- Üretim süresi
- Notlar

Renkler ayrı ürün kartları olarak çoğaltılmamalıdır.

---

# 17. Reçete düzenleme UX

Teknik BOM görünümü yerine işletme dili kullanılmalıdır.

Örnek:

### Ana Deri
Miktar: 2,2 desi  
Müşteri seçebilir: Evet

### İkincil Deri
Miktar: 0,7 desi  
Müşteri seçebilir: Evet

### İplik
Miktar: 1,4 m

### Yapıştırıcı
Miktar: 4 ml

---

# 18. Müşteriler ekranı

Liste:

- Müşteri
- Telefon
- Son sipariş
- Toplam sipariş
- Açık bakiye

Müşteri detayı:

- İletişim
- Siparişler
- Ödemeler
- İadeler
- Notlar

---

# 19. Tedarikçiler

Kart:

- Ad
- Borç
- Son alım
- Son ödeme

Detay:

- Alımlar
- Ödemeler
- İadeler
- İndirimler
- Açık bakiye

---

# 20. Satın alma ekranı

Yeni alış:

- Tedarikçi
- Tarih
- Malzemeler
- Miktar
- Birim
- Birim fiyat
- Toplam
- Ödenen
- Kalan
- Ödeme hesabı

Bir alışta birden fazla malzeme desteklenmelidir.

---

# 21. Finans ekranı

Ana sekmeler:

- Özet
- Kasa / Banka
- Tahsilatlar
- Giderler
- Borç / Alacak

Finans ekranı aşırı muhasebesel görünmemelidir.

---

## 21.1 Finans özeti

- Toplam kullanılabilir para
- Müşteri alacağı
- Tedarikçi borcu
- Kurucu finansmanı
- Bu ay gelir
- Bu ay gider

---

## 21.2 Hareket listesi

Örnek:

+ 1.200 TL  
Mehmet Yılmaz  
Sipariş #1042  
Müşteri Tahsilatı

- 350 TL  
Deri Alımı  
ABC Deri

- 200 TL  
Meta Reklam

---

# 22. Ödeme ekleme UX

Sipariş içinde:

**Ödeme Ekle**

Form:

- Tutar
- Tarih
- Yöntem
- Hesap
- Açıklama

Sonuç anında görünmelidir.

Önce:

Ödenen 500 / 1.500

Sonra:

Ödenen 1.000 / 1.500

---

# 23. İade / değişim UX

İade işlemi adımlı olabilir.

## 1. Sipariş / sevkiyat seç

## 2. Ürün seç

## 3. Çözüm

- Para iadesi
- Değişim
- Tamir

## 4. Ürün durumu

- Tekrar satılabilir
- Yeniden işlenecek
- Satılamaz

## 5. Lot kimliği

Sistem mümkünse otomatik bulur.

Birden fazla olasılık varsa kullanıcıya teknik ID yerine anlaşılır seçenek gösterilir:

- Kaşmir Yeşil — 03.09 üretim
- Crazy Siyah — 01.09 üretim

---

# 24. Demirbaş ekranı

Kart:

- Makine / ekipman adı
- Alış tarihi
- Alış maliyeti
- Kayıtlı değer
- Durum

Detay:

- Amortisman
- Bakımlar
- İyileştirmeler
- Notlar

---

# 25. Raporlar

Grafik mezarlığı olmamalıdır.

Önce KPI, sonra anlamlı grafik.

Raporlar:

- Satış
- Tahsilat
- Ürün
- Müşteri
- Üretim
- Stok
- Maliyet
- Gider
- Kanal

---

# 26. Müşteri yolculuğu raporu

Aşama hunisi:

İlk mesaj  
↓  
Fiyat konuşuldu  
↓  
Ürün sorusu  
↓  
Sipariş  
↓  
Ödeme  
↓  
Tamamlandı

Bu rapor yalnız toplam mesaj sayısı vermemelidir.

---

# 27. Mobil kullanım senaryoları

Telefonda en sık:

- Yeni sipariş bak
- Sipariş detayını aç
- Üretim durumunu değiştir
- Ödeme gir
- Stok bak
- Müşteri ara
- Kargo bilgisi gir
- Üretimi tamamla

Bu işlemler 2–3 dokunuşta ulaşılabilir olmalıdır.

---

# 28. Mobil kart tasarımı

Masaüstündeki geniş tablo telefonda sıkıştırılmamalıdır.

Örnek:

### #1042
Mehmet Yılmaz

PF001 · Kaşmir Yeşil  
AHMET

**Üretimde**

1.200 TL  
500 TL ödendi

---

# 29. Masaüstü tablolar

- 15–20 kolon aynı anda gösterilmemeli
- Kritik bilgiler solda
- İkincil bilgiler detayda
- Gerekirse kolon görünürlüğü ileride ayarlanabilir

---

# 30. Global arama

Aranabilir:

- Sipariş no
- Müşteri adı
- Telefon
- Ürün kodu
- Ürün adı
- Kargo takip no

Header'da:

**Ara...**

---

# 31. Hızlı aksiyon menüsü

“+” menüsü:

- Yeni Sipariş
- Yeni Müşteri
- Ödeme Ekle
- Satın Alma
- Stok Düzeltme

---

# 32. Durum renkleri

Tutarlı renk sistemi kullanılmalıdır.

Örnek:

- Gri → Taslak
- Sarı → Bekliyor
- Mavi → İşlemde / Üretimde
- Mor → Kalite Kontrol
- Yeşil → Hazır / Tamamlandı
- Kırmızı → Sorun / Gecikmiş / İptal

Aynı renk farklı ekranlarda farklı anlama gelmemelidir.

---

# 33. Kritik uyarılar

Teknik hata yerine kullanıcı dili:

Kötü:

> Error: insufficient material reservation balance

İyi:

> Kaşmir Yeşil stok yetersiz.  
> Gereken: 3,2 desi  
> Kullanılabilir: 2,1 desi

Aksiyon:

**Stoku Gör**

---

# 34. Onay gerektiren işlemler

- Sipariş iptal
- Üretim tamamla
- Stok düzelt
- Para iadesi
- Ay kapatma
- Kritik ters kayıtlar

Confirmation metni işlemin etkisini açıklamalıdır.

---

# 35. Boş ekranlar

Yalnız “Kayıt yok” denmemelidir.

Örnek:

### Henüz üretim işi yok

Onaylanan siparişleri üretime gönderdiğinizde burada göreceksiniz.

**Siparişlere Git**

---

# 36. Form prensipleri

- Etiketler alanın üstünde
- Placeholder bilgi yerine geçmez
- Zorunlu alanlar belli
- Para birimi görünür
- Ölçü birimi görünür
- Hatalar alanın yanında
- Kaydet aksiyonu kolay erişilir

---

# 37. Para gösterimi

Kartlarda:

**₺1.250**

Detaylarda:

**1.250,00 TL**

---

# 38. Stok gösterimi

- 18,3 desi
- 4 adet
- 250 ml

Birim asla gizli varsayılmamalıdır.

---

# 39. Tarih gösterimi

Liste:

**5 Eyl 2026**

Detay:

**05.09.2026 14:32**

---

# 40. Teknik isimleri kullanıcıya göstermeme

Kullanıcıya mümkün olduğunca gösterilmemeli:

- reservation_key
- source_type
- production_output_id
- material_slot_code
- movement_type

Yerine:

- Stok Rezervasyonu
- Kaynak
- Üretim Lotu
- Ana Deri
- İşlem Türü

kullanılmalıdır.

---

# 41. Ürün görselleri

Küçük ürün görselleri özellikle:

- Sipariş oluşturma
- Ürün seçme
- İade
- Hazır stok

alanlarında faydalıdır.

---

# 42. İsim baskısı UX

Kişiselleştirme görünür olmalıdır.

Örnek:

**İsim Baskısı: AHMET**

veya

**Baskısız**

İsim yalnız not alanına gömülmemelidir.

---

# 43. Malzeme / renk seçimi UX

Örnek:

**Kaşmir**

- Yeşil
- Siyah
- Camel
- Mor

Seçim sonunda gerçek stok SKU'su belirlenmelidir.

Stok olmayan kombinasyon:

- Stok yok
- Siparişle temin
- Pasif

şeklinde gösterilebilir.

---

# 44. Ürün konfigürasyon özeti

Sistem boyunca aynı format kullanılmalıdır:

**PF001 · Kaşmir Yeşil · AHMET · 1 adet**

---

# 45. Rol bazlı Dashboard

İleride:

### Owner

- Finans
- Borç
- Satış
- Üretim

### Production

- Bekleyen işler
- Bugünkü işler
- Malzeme eksikleri

### Staff

- Sipariş
- Ödeme
- Kargo
- Müşteri

---

# 46. İlk kullanım / onboarding

İlk kullanımda kısa açıklamalar:

### Sipariş verdiğinizde ne olur?

Sipariş → ödeme → üretim → stok → teslimat

### Para nereye yansıdı?

Tahsilat hesabı ve müşteri bakiyesi gösterilir.

### Stok neden azaldı?

Üretim tüketimi açıklanır.

---

# 47. Performans hissi

- Sayfa gereksiz yenilenmemeli
- Skeleton/loading kullanılmalı
- Aynı butona iki kez basılması engellenmeli
- İşlem sonrası açık geri bildirim gösterilmeli

---

# 48. Yazdırılabilir çıktılar

İleride:

- Üretim fişi
- Paketleme fişi
- Sipariş özeti
- Stok sayım listesi
- Tedarikçi borç özeti

Üretim fişinde büyük ve net:

- Ürün
- Deri
- Renk
- İsim baskısı
- Adet
- Not

olmalıdır.

---

# 49. Sayım ekranı

Mobil uyumlu olmalıdır.

Örnek:

**KM-YSL — Kaşmir Yeşil**

Sistem: 18,3 desi  
Sayım: [____]

Fark otomatik hesaplanır.

---

# 50. Kasa ekranı

Hesap kartları:

### Nakit
12.500 TL

### Banka
34.100 TL

### Ödeme Sağlayıcı
3.200 TL

Kart seçilince hareketler açılır.

---

# 51. Ana görsel hiyerarşi

Her ekran:

1. Sayfa başlığı
2. Ana aksiyon
3. Kritik KPI
4. Filtreler
5. Ana içerik
6. İkincil detay

şeklinde ilerlemelidir.

---

# 52. Kaçınılması gerekenler

- Çok fazla modal
- Her yerde tablo
- Aşırı küçük yazı
- Teknik isimler
- Gereksiz grafik
- Aynı iş için farklı ekranlarda farklı davranış
- Renklerin rastgele kullanımı
- Veritabanı yapısını kullanıcıya hissettirmek
- Bir sipariş için çok fazla sayfa dolaşmak
- Ürün renklerini ayrı ürün gibi çoğaltmak
- Finans hareketlerini muhasebe fişi diliyle göstermek

---

# 53. MVP ekran listesi

1. Giriş
2. Dashboard
3. Sipariş Listesi
4. Sipariş Detayı
5. Yeni Sipariş
6. Müşteri Listesi
7. Müşteri Detayı
8. Üretim Kuyruğu
9. Üretim Detayı
10. Malzeme Stok
11. Hazır Ürün Stok
12. Ürün Listesi
13. Ürün / Reçete Detayı
14. Satın Alma Listesi
15. Yeni Satın Alma
16. Tedarikçi Listesi
17. Finans Özeti
18. Para Hareketleri
19. İade / Değişim
20. Raporlar
21. Ayarlar

---

# 54. Ana kullanıcı yolculukları

## Sipariş

Dashboard  
→ Yeni Sipariş  
→ Müşteri  
→ Ürün  
→ Deri / renk  
→ İsim baskısı  
→ Fiyat  
→ Kapora  
→ Kaydet

## Üretim

Üretim  
→ Bekleyen  
→ İş aç  
→ Malzemeyi kontrol et  
→ Başlat  
→ Tüketim  
→ Tamamla

## Teslimat

Sipariş  
→ Hazır  
→ Kargola  
→ Firma / takip no  
→ Kaydet

## Ödeme

Sipariş  
→ Ödeme Ekle  
→ Tutar  
→ Hesap  
→ Kaydet

## İade

Sipariş  
→ Teslimat  
→ İade Başlat  
→ Ürün  
→ Çözüm  
→ Durum  
→ Stok etkisi  
→ Tamamla

---

# 55. UI/UX başarı kriteri

Kullanıcı eğitim almadan şunları yapabiliyorsa arayüz başarılıdır:

- Yeni sipariş açmak
- Müşterinin ne istediğini görmek
- Hangi deri kullanılacağını anlamak
- Üretim sırasını görmek
- Ödeme girip kalan bakiyeyi görmek
- Stok miktarına bakmak
- Kargolamak
- İade almak
- Günün işlerini görmek

---

# 56. Son tasarım ilkesi

> Kullanıcıya veritabanını değil, işletmesini göster.

> Ekranın görevi mümkün olan en fazla bilgiyi göstermek değil, doğru anda doğru bilgiyi göstermektir.

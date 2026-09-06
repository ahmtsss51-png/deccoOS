# Decco OS — Proje Tanımı, Kapsamı ve İş Kuralları

> Bu doküman, Decco OS projesinin bugüne kadar konuşulan ve tasarlanan iş mantığını teknoloji bağımsız biçimde tanımlar. Amaç, sistemi sıfırdan yeniden kodlarken iş kurallarının kaybolmamasıdır.

---

## 1. Projenin temel amacı

**Decco OS**, Decco Deri'nin siparişten üretime, stoktan finansa kadar günlük operasyonunu tek sistemde yönetmek için tasarlanmış işletme yönetim sistemidir.

Ana hedefler:

- Siparişleri eksiksiz takip etmek
- Müşterinin hangi ürünü, hangi deri/renk ve hangi kişiselleştirmeyle istediğini net tutmak
- Üretim sırasını yönetmek
- Ham madde ve bitmiş ürün stoklarını takip etmek
- Satış ile tahsilatı birbirinden ayırmak
- Tedarikçi borçlarını ve müşteri alacaklarını görmek
- Gerçek ürün maliyetini hesaplamak
- Kasa/banka ve işletme durumunu tek ekranda görmek
- İşletmeyi kişiye bağımlı olmaktan çıkarıp sistemle yönetilebilir hale getirmek

Uzun vadeli hedef:

> Ahmet üretimin içinde çalışan kişi olmaktan çıkıp, üretimi ve işletmeyi yöneten kişi haline gelsin.

---

## 2. Proje nedir?

Decco OS;

- Sipariş yönetim sistemi
- Üretim takip sistemi
- Stok yönetim sistemi
- Müşteri yönetim sistemi
- Tedarikçi yönetim sistemi
- Kasa / ödeme / borç-alacak takip sistemi
- Ürün maliyeti ve kârlılık sistemi
- Operasyon dashboard'u
- İade/değişim yönetim sistemi
- İleride rol bazlı çalışan iş akışı sistemi

olarak çalışır.

Ana zincir:

**Müşteri → Sipariş → Ödeme → Üretim → Malzeme Tüketimi → Bitmiş Ürün → Teslimat → İade/Değişim → Finans → Raporlama**

---

## 3. Proje ne değildir?

Decco OS;

- Tam teşekküllü resmi muhasebe yazılımı değildir
- E-fatura / e-defter yazılımının yerine geçmez
- Her sektör için genel amaçlı ERP değildir
- Gereksiz seviyede karmaşık süreç motoru olmamalıdır
- Decco'nun gerçek operasyonunda karşılığı olmayan süreçleri yönetmemelidir
- Teknoloji gösterisi için tasarlanmamalıdır

Ana prensip:

> Sistem Decco'nun işini kolaylaştırmalı; Decco sistemi yönetmek için çalışmamalıdır.

---

# 4. İşletme bağlamı

## 4.1 Marka

**Decco Deri**

Ana faaliyetler:

- Gerçek deri ürün üretimi
- El işçiliği ve makine dikişi
- İsim baskısı / kişiselleştirme
- Bireysel satış
- Sosyal medya satışları
- Web satışları
- Çevre / doğrudan satış
- İleride toptan / bayi satışları

## 4.2 Operasyon hedefi

- Kısa vadede süreçlerin standardize edilmesi
- Orta vadede üretimin ayrı alana taşınması
- Uzun vadede üretimi başkaları yaparken Ahmet'in yönetimde kalması

---

# 5. Temel iş kuralları

## 5.1 Satış ≠ Tahsilat

Bir sipariş verilmiş olması, paranın Decco'ya girdiği anlamına gelmez.

Ayrı takip edilmelidir:

- Sipariş toplamı
- Tahsil edilen
- Kalan bakiye
- Tahsilat tarihi
- Tahsilat yöntemi
- Tahsilat hesabı

Örnek:

- Sipariş: 1.500 TL
- Tahsil edilen: 500 TL
- Kalan: 1.000 TL

Sistem bunu 1.500 TL para girişi olarak göstermemelidir.

---

## 5.2 İşletme parası ≠ kişisel para

Ahmet'in kişisel parası veya kartı Decco için kullanılırsa bu hareket ayrıca izlenmelidir.

- İşletme gideri veya varlık oluşabilir
- Ancak ödeme kaynağı Decco kasası değildir
- İşletmenin Ahmet'e borcu / kurucu finansmanı ayrıca tutulabilir

Geçmişte kişisel karttan yapılan her harcama otomatik olarak bugünkü kurucu borcu kabul edilmez.

---

## 5.3 Tarihsel veri ≠ açılış bakiyesi

Açılışta yalnız geçiş günündeki gerçek durum esas alınır.

Örnek:

- Geçmişte alınmış ama bugün elde olmayan deri açılış stoğuna girmez
- Geçmişte kişisel kartla yapılmış harcama bugünkü kurucu borcu olmak zorunda değildir

Açılış bakiyesi fiziksel sayım ve gerçek finans bakiyelerinden oluşturulmalıdır.

---

# 6. Ana modüller

1. Dashboard
2. Müşteriler
3. Siparişler
4. Ürünler
5. Malzemeler
6. Reçeteler
7. Üretim
8. Stok
9. Hazır ürün / lot takibi
10. Satın alma
11. Tedarikçiler
12. Finans / Kasa
13. İade / Değişim
14. Demirbaşlar
15. Reklam giderleri
16. Raporlar
17. Ay kapanışı
18. Yetkilendirme
19. Ayarlar

---

# 7. Dashboard

Dashboard işletmenin durumunu tek bakışta göstermelidir.

Temel göstergeler:

- Hazırlanacak siparişler
- Üretimdeki siparişler
- Hazır siparişler
- Geciken işler
- Kasa / banka toplamı
- Müşteri alacağı
- Tedarikçi borcu
- Stok değeri
- Demirbaş değeri
- Bu ay satış
- Bu ay tahsilat
- Bu ay gider
- Yaklaşık kâr

Dashboard süs ekranı değil, operasyon ekranıdır.

---

# 8. Müşteri yönetimi

Müşteri kartı:

- Ad / soyad
- Telefon
- İletişim kanalı
- Notlar
- Sipariş geçmişi
- Toplam sipariş
- Toplam tahsilat
- Açık bakiye
- İade / değişim geçmişi

Müşteri yolculuğu raporlarında aşamalar mümkün olduğunca:

1. İlk mesaj
2. Fiyat konuşması
3. Ürün soruları
4. Sipariş
5. Ödeme / kargo
6. Satış tamamlandı

şeklinde izlenmelidir.

---

# 9. Sipariş yönetimi

Bir sipariş birden fazla ürün içerebilir.

Örnek:

**Sipariş #145**

- PF001 — Yeşil — AHMET baskısı
- CW001 — Siyah — Baskısız
- Anahtarlık — Kahve — MERAL baskısı

Her sipariş satırı kendi:

- ürününü
- yapısal varyantını
- malzeme seçimini
- rengini
- kişiselleştirmesini
- adedini
- fiyatını
- durumunu

taşımalıdır.

---

## 9.1 Sipariş kaynakları

- Web
- Meta / Instagram
- WhatsApp
- Çevre / doğrudan
- İleride diğer kanallar

Kaynak raporlanabilir olmalıdır.

---

## 9.2 Ödeme / kapora kuralı

- Ödeme yoksa üretim başlamaz
- %33 ve üzeri kapora → üretim başlayabilir
- %33 altı → özel onay gerekir

Bu oran ileride ayarlardan değiştirilebilir.

---

## 9.3 Sipariş durumları

Önerilen sade akış:

1. Taslak
2. Ödeme Bekliyor
3. Onaylandı
4. Üretim Bekliyor
5. Üretimde
6. Kalite Kontrol
7. Hazır
8. Kargolandı / Teslim Edildi
9. Tamamlandı

Yan durumlar:

- İptal
- İade
- Değişim
- Düzeltme / yeniden işleme

---

# 10. Ürün modeli

## 10.1 Ürün

Ürün fiziksel modeli temsil eder.

Bilinen ürün kodları:

- CW001
- CW002
- CW003
- CW004
- DP001
- FW001
- FW002
- FW003
- MB001
- MC001
- PF001
- PW001

Yeni ürünler ayrıca eklenebilir.

---

## 10.2 Varyant

**Renk veya deri türü otomatik olarak varyant değildir.**

Varyant yalnız gerçek yapısal/ticari farkı temsil etmelidir.

Örnek:

- Standart
- Büyük boy
- Farklı iç tasarım
- Farklı cep sayısı

Yanlış yaklaşım:

- PF001 Yeşil
- PF001 Siyah
- PF001 Camel

bunları ayrı varyant yapmak.

Doğru yaklaşım:

**PF001 / Standart** + **Ana deri: Kaşmir Yeşil**

---

# 11. Malzeme modeli

Her fiziksel stok malzemesi ayrı SKU olarak takip edilir.

Örnek deri SKU'ları:

- CR-SYH — Crazy Siyah
- CR-CML — Crazy Camel
- KM-YSL — Kaşmir Yeşil
- PB-KNY — Pueblo Konyak
- TI-GRI — Tiana Gri

Deri dışında:

- Yapıştırıcı
- İğne
- Kart mekanizması
- Para klipsi
- Çıtçıt
- İplik
- Aksesuar

stok malzemesi olabilir.

Bilinen deri aileleri:

- Crazy
- Kaşmir
- Pueblo
- Tiana

---

# 12. Malzeme slotları

Reçete gerçek rengi sabitlemek yerine malzeme rolünü tanımlar.

Örnek slotlar:

- MAIN_LEATHER — Ana Deri
- SECONDARY_LEATHER — İkincil Deri

Örnek:

CW003:

- MAIN_LEATHER → Crazy Siyah
- SECONDARY_LEATHER → Crazy Camel

Böylece çok derili / çok renkli ürünler doğru takip edilir.

---

# 13. Reçete / BOM

Reçete şunları içerebilir:

- Ana deri miktarı
- İkincil deri miktarı
- İplik
- Yapıştırıcı
- Çıtçıt
- Aksesuar
- Ambalaj
- Standart işçilik süresi
- Fire oranı

Ana prensip:

> Reçete rol ve miktarı tanımlar; gerçek kullanılacak SKU sipariş/üretim sırasında seçilir.

---

# 14. Üretim yönetimi

Üretim işi şu kaynaklardan doğabilir:

- Siparişe özel üretim
- Hazır stok üretimi
- Değişim üretimi
- Hurda / küçük deri değerlendirme üretimi

Üretim işinde:

- Ürün
- Varyant
- Adet
- Reçete
- Gerçek seçilen malzemeler
- Durum
- Başlama / bitiş
- Malzeme rezervasyonları
- Gerçek tüketim
- İşçilik
- Üretim maliyeti

izlenmelidir.

---

## 14.1 Malzeme rezervasyonu

Üretim başlamadan gereken malzemeler rezerve edilebilir.

Sistem şu sorulara cevap vermelidir:

- Stokta yeterli mi?
- Başka işlere rezerve edilmiş mi?
- Kullanılabilir miktar nedir?

---

## 14.2 Gerçek tüketim

Reçete teorik ihtiyacı, üretim tüketimi gerçek kullanım miktarını gösterir.

Örnek:

- Reçete: 2,0 desi
- Gerçek tüketim: 2,15 desi

Bu fark fire ve gerçek maliyet analizi için kullanılabilir.

---

# 15. Bitmiş ürün stoğu

Yalnız:

**PF001 = 5 adet**

bilgisi yeterli değildir.

Operasyonel olarak örneğin:

- PF001 / Kaşmir Yeşil = 2
- PF001 / Crazy Siyah = 1
- PF001 / Pueblo Camel = 2

bilinmelidir.

Ancak bunlar ayrı ürün varyantları olmak zorunda değildir.

---

# 16. Üretim lotu / output mantığı

Her tamamlanan üretim bir bitmiş ürün lotu oluşturur.

Örnek:

**Output A**

- Ürün: PF001
- Adet: 2
- Ana deri: KM-YSL
- Üretim tarihi
- Birim maliyet
- Üretim işi

Lotun malzeme konfigürasyonu üretim tamamlandığında dondurulur.

Sonradan ürün veya reçete değişse bile geçmiş lot değişmez.

---

# 17. Hazır stok rezervasyonu

Müşteri:

**PF001 + Kaşmir Yeşil**

istediyse sistem genel PF001 toplamına bakıp rastgele ürün ayırmamalıdır.

Yalnız uyumlu lotlar kullanılmalıdır.

Örnek:

- Output A / KM-YSL → 2
- Output B / CR-SYH → 1

Sipariş KM-YSL ise yalnız Output A kullanılabilir.

---

# 18. Sevkiyat ve lot izi

Bir sevkiyat satırı birden fazla üretim lotundan karşılanabilir.

Örnek:

Shipment Line #12:

- Output A → 1 adet
- Output B → 1 adet

Bu nedenle sevkiyat ile üretim lotu arasında **miktarlı provenance / allocation** bağlantısı tutulmalıdır.

Amaç:

> Müşteriye gönderilen ürün hangi üretim lotundan çıktı?

sorusuna kesin cevap vermek.

---

# 19. İade / değişim

## 19.1 Genel yaklaşım

- Üretim başlamadan önce → iade mümkün
- Üretim başladıysa standart ürün → duruma göre
- Gerçek kişiselleştirilmiş ürün → farklı politika
- Kusurlu / yanlış ürün → ayrıca değerlendirilir

## 19.2 İade sonucu

Ürün:

- Sellable — tekrar satılabilir
- Reworkable — yeniden işlenecek
- Unsellable — satılamaz

olarak sınıflandırılabilir.

## 19.3 İadede lot takibi

İade edilen ürünün hangi üretim lotundan geldiği korunmalıdır.

Amaç:

Kaşmir Yeşil geri geldiyse stokta Crazy Siyah artmamalıdır.

Bu nedenle:

- Sevkiyat → Output allocation
- İade → Output allocation

zinciri korunmalıdır.

---

# 20. Stok yönetimi

## 20.1 Stok türleri

- Ham madde
- Yardımcı malzeme
- Bitmiş ürün
- Hurda / değerlendirilebilir parça

## 20.2 Stok konumları

Başlangıç:

- ATOLYE

İleride:

- Ana depo
- Üretim
- Paketleme
- Mağaza
- Stand / bayi

## 20.3 Stok işlemleri

- Satın alma girişi
- Açılış girişi
- Üretim tüketimi
- Üretim çıktısı
- Satış çıkışı
- İade girişi
- Hurda çıkışı
- Sayım farkı
- Transfer
- Düzeltme

---

# 21. Stok maliyeti

Ham maddelerde ağırlıklı ortalama yaklaşımı kullanılabilir.

Örnek:

- 50 desi × 10 TL
- 50 desi × 8 TL

Yeni ortalama:

**9 TL / desi**

Sonraki üretim tüketimleri güncel stok maliyeti üzerinden değerlenebilir.

---

# 22. Satın alma ve tedarikçi

Tedarikçi kartında:

- İsim
- İletişim
- Borç
- Alımlar
- Ödemeler
- İadeler
- Sonradan indirimler

bulunmalıdır.

Parçalı ödeme desteklenmelidir.

Örnek:

Mal alımı: 10.000 TL

- 3.000 TL ödendi
- 7.000 TL borç

---

# 23. Satın alma iadesi

Malzeme iade edilirse:

- Stok düşer
- Stok değeri uygun maliyetle düşer
- Tedarikçi borcu/alacağı etkilenir
- Para iadesi varsa ayrıca işlenir

---

# 24. Finans / para yönetimi

Finansal hesap örnekleri:

- Nakit
- Banka
- Kart / ödeme sağlayıcı
- Diğer hesaplar
- Kurucu finansmanı bağlantıları

Temel hareketler:

- Müşteri tahsilatı
- Tedarikçi ödemesi
- Reklam gideri
- Kargo gideri
- İşletme gideri
- Demirbaş alımı
- Kurucu finansmanı
- Kurucuya geri ödeme
- Hesaplar arası transfer

---

# 25. Reklam giderleri

Reklam işletme gideridir.

Takip alanları:

- Tarih
- Kanal
- Kampanya / açıklama
- Tutar
- Ödeme hesabı

Aynı reklam giderinin iki kez raporlanmaması önemlidir.

---

# 26. Kargo ve ambalaj

Sevkiyatta:

- Kargo firması
- Takip numarası
- Gerçek kargo maliyeti
- Ambalaj maliyeti
- Teslimat tipi

izlenebilir.

Ücretsiz kargo müşteriye ücretsizdir; Decco için maliyettir.

---

# 27. Ürün maliyeti

Ürün maliyeti yalnız deri değildir.

Maliyet bileşenleri:

- Deri
- Yardımcı malzeme
- Aksesuar
- Yapıştırıcı
- İplik
- Ambalaj
- İşçilik
- Kargo
- Reklam payı
- Fire
- Diğer direkt üretim giderleri

Operasyonel stok maliyeti ile yönetim amaçlı tam maliyet gerektiğinde ayrıştırılabilir.

---

# 28. İşçilik

Başlangıçta dakika/saat bazlı modellenebilir.

Örnek:

- Standart üretim süresi: 25 dakika
- Saatlik yönetim işçilik oranı

İleride:

- Çalışan bazlı
- Fason
- Parça başı

modeller eklenebilir.

---

# 29. Demirbaşlar

Örnekler:

- Dikiş makinesi
- Pres
- Zımpara / kenar makinesi
- Kalıplar
- Diğer ekipman

Takip alanları:

- Ad
- Alış tarihi
- Maliyet
- Kullanıma başlama tarihi
- Faydalı ömür
- Amortisman
- Bakım
- İyileştirme

Demirbaş satın almak doğrudan o ayın ürün gideri gibi değerlendirilmemelidir.

---

# 30. Ay kapanışı

Ay sonunda geçmiş dönemi kilitleme yaklaşımı olabilir.

Amaç:

- Geçmiş dönemin yanlışlıkla değiştirilmesini önlemek
- Raporları stabil tutmak
- Düzeltmeleri özel işlem olarak yapmak

Öneri:

Ayın 1–2'sinde önceki ay kontrol edilip kapatılır.

---

# 31. Yetkilendirme

Başlangıç rollerinden bilinenler:

- Owner
- Staff
- Production

Yeni sistemde rol sayısı sade tutulabilir.

### Owner
Her şey

### Staff
- Müşteri
- Sipariş
- Ödeme
- Stok görüntüleme
- Sevkiyat

### Production
- Üretim kuyruğu
- Malzeme kullanımı
- Üretim başlat / tamamla
- Kalite durumu

---

# 32. Raporlama

## 32.1 Satış

- Günlük / haftalık / aylık ciro
- Sipariş adedi
- Ürün bazlı satış
- Kanal bazlı satış
- Ortalama sepet
- Açık siparişler

## 32.2 Tahsilat

- Tahsil edilen para
- Bekleyen alacak
- Ödeme yöntemi
- Hesap bazlı hareket

## 32.3 Üretim

- Bekleyen üretim
- Üretimde
- Tamamlanan
- Ortalama üretim süresi
- Malzeme tüketimi
- Fire
- Ürün maliyeti

## 32.4 Stok

- Ham madde
- Kullanılabilir stok
- Rezerve stok
- Bitmiş ürün
- Deri/renk bazlı hazır stok
- Stok değeri
- Kritik stok

## 32.5 Finans

- Gelir
- Gider
- Kasa / banka
- Tedarikçi borcu
- Müşteri alacağı
- Kurucu finansmanı
- Demirbaş değeri
- Aylık sonuç

---

# 33. Geçiş / açılış yaklaşımı

Yeni sisteme geçerken gerçek açılış verileri ayrı belirlenmelidir:

- Fiziksel deri miktarı
- Yardımcı malzeme
- Hazır ürün stoğu
- Kasa
- Banka
- Gerçek müşteri alacakları
- Gerçek tedarikçi borçları
- Gerçek kurucu finansmanı
- Demirbaşlar
- Açık siparişler

Tarihsel kayıtlar rapor için taşınabilir; açılış bakiyesini otomatik belirlememelidir.

---

# 34. Bilinen tarihsel veri özeti

Daha önce hazırlanan tarihsel veri setinde:

- 43 sipariş
- 50 sipariş satırı
- 57 tekil ürün detayı
- 58.798 TL satış
- 53.298 TL tahsilat
- 5.500 TL açık bakiye
- 4 açık sipariş
- 39 müşteri

bulunmuştur.

Bu veriler tarihsel geçiş için kullanılabilir; fiziksel stok ve finans açılışı ayrıca sayılmalıdır.

---

# 35. Tarihsel renk / malzeme notları

Müşteri veya eski kayıt etiketi her zaman gerçek stok SKU'su değildir.

Örnek:

- MUSTANG → tarihsel olarak Pueblo Kızıl Kahve kullanılmış olabilir
- HAKİ → çoğu durumda Yeşil olabilir
- SARI → Camel olabilir
- KAHVE → ürüne göre farklı deri ailesi / ton olabilir

Bu nedenle müşteri etiketi ile gerçek stok SKU'su ayrı tutulmalıdır.

---

# 36. Marka içgörüsü

PF001 ürününde yeşil renk bazı müşteriler için yalnız estetik değil, **bereket / sembolik anlam** taşıyabilir.

Pazarlama ve müşteri analizlerinde renk tercihlerine yalnız görsel tercih olarak bakılmamalıdır.

---

# 37. Yeniden yazımda mutlaka korunacak kararlar

1. Satış ≠ tahsilat
2. Ürün ≠ malzeme
3. Renk ≠ otomatik varyant
4. Reçete rol tanımlar, gerçek SKU ayrıca seçilir
5. Çok malzemeli ürün desteklenir
6. Ham madde gerçek SKU bazında stoklanır
7. Bitmiş ürünün malzeme konfigürasyonu kaybolmaz
8. Sevkiyat hangi üretim lotundan çıktı bilgisini korur
9. İade doğru lota geri döner
10. Açılış bakiyesi gerçek fiziksel durumdan gelir
11. Kişisel para ile işletme parası ayrılır
12. Tedarikçi parçalı ödeme desteklenir
13. Bir siparişte birden fazla ürün olabilir
14. Her ürün satırı farklı deri/renk/isim baskısı taşıyabilir
15. Üretim ödeme kuralına bağlıdır
16. Kişiselleştirilmiş ürün iadeleri farklı politika taşıyabilir
17. Stok maliyeti ağırlıklı ortalama mantığıyla yönetilebilir
18. Demirbaşlar ayrı değerlendirilir
19. Ay kapanışı geçmiş veriyi korur
20. Sistem günlük işi kolaylaştırmalıdır

---

# 38. Yeni kodlama için MVP sınırı

İlk sürümde eksiksiz çalışması gereken ana akış:

**Müşteri oluştur**
↓
**Sipariş oluştur**
↓
**Ürün + malzeme + kişiselleştirme seç**
↓
**Kapora / ödeme gir**
↓
**Üretim işi oluştur**
↓
**Malzeme stoktan düş**
↓
**Ürünü hazır hale getir**
↓
**Bitmiş stok / sipariş rezervasyonu**
↓
**Kargola / teslim et**
↓
**Tahsilatı tamamla**
↓
**Kasa + stok + maliyet raporuna yansıt**

Bunun dışındaki gelişmiş özellikler ikinci aşamaya bırakılabilir.

---

# 39. Sade mimari prensibi

Yeni sistemde veri modeli gereksiz yere parçalanmamalıdır.

Prensip:

> Veriyi gerektiği kadar ayrıştır; günlük işi anlamayı zorlaştıracak kadar bölme.

Ancak şu izler kaybolmamalıdır:

- Sipariş satırı
- Ödeme
- Malzeme
- Üretim
- Bitmiş ürün lotu
- Sevkiyat
- İade
- Tedarikçi borcu
- Kasa hareketi

---

# 40. Başarı kriteri

Kullanıcı birkaç saniyede şu sorulara cevap verebilmelidir:

- Bugün ne üretmem gerekiyor?
- Hangi sipariş gecikiyor?
- Hangi müşteri ne istedi?
- Hangi isim baskısı yapılacak?
- Hangi ürün hangi deriyle yapılacak?
- Kaç desi yeşil deri kaldı?
- Hazırda kaç tane PF001 Kaşmir Yeşil var?
- Bu siparişin parası geldi mi?
- Müşteriden ne kadar alacağım var?
- Tedarikçiye ne kadar borcum var?
- Kasada ne kadar para var?
- Bu ay ne kadar satış yaptım?
- Bu ay ne kadar tahsil ettim?
- Hangi ürün daha çok satılıyor?
- Hangi ürün para kazandırıyor?
- Hangi sipariş hangi üretim lotundan çıktı?
- İade edilen ürün yeniden satılabilir mi?

---

# 41. Son prensip

> Bir özellik Decco'nun gerçek problemini çözmüyorsa ilk sürüme eklenmez.

> Para, stok, müşteri veya üretim doğruluğunu etkileyen iş kuralı ise sistem sadeleştirilse bile kaybedilmez.

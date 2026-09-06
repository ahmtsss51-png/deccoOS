# Token Tasarrufu Kurallari

Hedef: ~%70 token tasarrufu. Her gorevde asagidaki kurallari uygula.

## 1. Kisa Yanit
- Max 1-3 cumle, sorulmadikca aciklama yapma
- Kod bloklari sadece degisen kismi goster, tum dosyayi tekrarlama
- Liste/tablo yerine tek satirlik ozet

## 2. Dar Gorev Tanimi
- Gorevi endpoint/dosya/fonksiyon seviyesinde tanimla
- "Tum projeyi tara" yerine spesifik dosya/klasor hedefle
- Once Grep/Glob, sonra Read (sadece ilgili satirlar)

## 3. Context Izolasyonu
- Sadece gorevle ilgili dosyalari oku
- Tum dosyayi okuma, offset/limit kullan
- Ayni dosyayi tekrar okuma

## 4. Tool Kullanimi
- Paralel tool call mumkunse tek turda yap
- Bash yerine Read/Edit/Grep/Glob kullan
- Gereksiz git status/log tekrarlama

## 5. Yanit Formati
- Emoji yok, basa/sona ozet yok
- "Yaptigim degisiklikler" listesi yok (diff zaten gorunur)
- Onay beklemeden devam et (tehlikeli islemler haric)

## 6. Agent Kullanimi
- Subagent sadece gerektiginde, mumkunse kendi tool'larinla coz
- Agent prompt'lari max 2-3 cumle
- Ayni isi hem kendin hem agent yapma

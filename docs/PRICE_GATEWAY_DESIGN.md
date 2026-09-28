# Fiyat Ağ Geçidi (Price Gateway) — Tasarım

**Durum:** Taslak — TEFAS bölümü, `tefas-test.yml` fizibilite testinin sonucuna bağlı.
**Kapsam:** Investor'ın tüm fiyat sorgularını tek bir Cloudflare Worker uç noktasında toplamak; Worker'ın farklı kaynaklardan fiyatları toplayıp konsolide bir yanıt döndürmesi.

## 1. Amaç ve ilkeler

1. **Tek kapı.** Uygulama yalnızca Worker ile konuşur. Kaynak seçimi ve sembol eşleme (`.IS`, `.V`, `.DE` …) Worker'a taşınır; istemci ince kalır.
2. **Anahtar bazlı yanıt.** Sonuçlar dizi sırasına değil, istemcinin verdiği `id`'ye (ticker) göre döner. (Önceki "virgüllü sembol → satır kayması" hatası sıra bağımlılığından doğmuştu.)
3. **Her sonuç kendini tanımlar:** kaynak, tazelik (`live` / `eod`), `asOf`, hata sınıfı.
4. **Kısmi başarı normaldir.** Bir kaynak çökerse diğerlerinin sonuçları yine döner.
5. **TEFAS = son kapanış (günlük birim pay fiyatı).** Anlık fiyat yoktur; bu bilinçli bir tasarım kararıdır.

## 2. Mimari

```
Investor (tarayıcı)
   │  POST /pricesPost   {items:[{id, assetType, currency}]}
   ▼
Cloudflare Worker  (gateway)
   ├─ Router: assetType ──► sağlayıcı
   ├─ YahooProvider ──► query1.finance.yahoo.com   (canlı: hisse / ETF / opsiyon / BIST / varant)
   ├─ TefasProvider ──► tefas_prices.json          (snapshot, Cache API ~30 dk)
   └─ Birleştirici  ──► { results: { [id]: {...} }, fetchedAt }

GitHub Actions  (hafta içi akşam, cron)
   └─ tefasmak (Chrome TLS taklidi) ──► tüm YAT fonları son fiyat ──► data dalı: tefas_prices.json
```

**Neden TEFAS için snapshot?** TEFAS, Akamai bot koruması arkasında; Worker'ın `fetch()`'i Chrome TLS parmak izini taklit edemez. Tarayıcı taklidi yapabilen bir ortamda (Actions) günde bir kez çekip Worker'a *statik veri* olarak sunmak hem güvenilir hem de günlük NAV'a zaten yeterli.

## 3. Sözleşme

**İstek**
```json
POST /pricesPost
{ "items": [
  { "id": "TUPRS", "assetType": "Türk Hisse Senetleri",   "currency": "TRY" },
  { "id": "AMZN",  "assetType": "Amerikan Hisse Senetleri", "currency": "USD" },
  { "id": "AFT",   "assetType": "Türk TEFAS Fonları",     "currency": "TRY" }
]}
```

**Yanıt**
```json
{ "fetchedAt": "2026-09-28T17:05:11Z",
  "results": {
    "TUPRS": { "ok": true, "price": 250.3, "previousClose": 248.1, "currency": "TRY",
               "source": "yahoo", "freshness": "live", "asOf": "2026-09-28T14:55:00Z",
               "marketState": "REGULAR", "name": "TÜPRAŞ" },
    "AFT":   { "ok": true, "price": 12.34, "previousClose": 12.30, "currency": "TRY",
               "source": "tefas-snapshot", "freshness": "eod", "asOf": "2026-09-26", "stale": false },
    "XYZ":   { "ok": false, "error": "Fon bulunamadı", "permanent": true, "source": "tefas-snapshot" }
}}
```

- `permanent: true` yalnızca *kesin* "böyle bir sembol/fon yok" durumunda; ağ/kaynak hataları `false`. (İstemcinin hata mesajından tahmin yürütmesi kalkar.)
- `stale: true`: TEFAS `asOf` tarihi 4 takvim gününden eskiyse (snapshot işi bozulmuş demektir). Veri yine döner, istemci uyarı gösterir.
- Mevcut `/quotePost`, `/quoteGet`, `/historicalPost` uç noktaları geriye dönük uyumluluk için korunur.

## 4. Yönlendirme tablosu (Worker içinde)

| assetType | Sağlayıcı | Sembol kuralı | Tazelik |
|---|---|---|---|
| Türk TEFAS Fonları | TEFAS snapshot | fon kodu olduğu gibi | `eod` |
| Türk Hisse Senetleri, Türk Yatırım Fonları | Yahoo | `+.IS` | `live` |
| Türk Varantlar | Yahoo | `+.V` | `live` |
| Amerikan Hisse Senetleri / Opsiyonları | Yahoo | olduğu gibi | `live` |
| Avrupa Hisse Senetleri / Opsiyonları | Yahoo | `+.DE` (varsayılan) | `live` |

`buildYahooSymbol` istemciden kalkar. Yahoo'da doğrulanmamış olan `[FONADI].TEFAS` yolu, TEFAS sağlayıcısı çalışınca emekliye ayrılır. Süresi dolmuş opsiyonların atlanması (v0.12.7) istemcide kalır.

*Genişletme noktası:* her `assetType` için `[birincil, yedek…]` sağlayıcı zinciri tanımlanabilir. Şimdilik yedek sağlayıcı yok (YAGNI).

## 5. TEFAS snapshot hattı

**Kaynak:** `tefasmak.fonlar_son_fiyat_bulk("YAT")` — tek çağrıda (≈2 sayfa) tüm yatırım fonlarının son fiyatı. İzleme listesi tutmaya gerek kalmaz; Worker yalnızca istenen kodları seçer.

**Şema (`tefas_prices.json`)**
```json
{ "generatedAt": "2026-09-28T17:05:11Z", "source": "tefasmak 1.0.1",
  "funds": { "IPB": { "price": 0.846063, "date": "2026-09-26",
                       "prevPrice": 0.845100, "prevDate": "2026-09-25", "name": "…" } } }
```
- `prevPrice/prevDate`: önceki snapshot'tan devralınır (tarih değiştiğinde `price → prevPrice`). Böylece "Bugün" (günlük %) kolonu, kaynak API günlük getiriyi vermese de TEFAS fonları için çalışır.
- `date` (NAV tarihi) API yanıtından okunur; yoksa son iş günü olarak yazılır — **fizibilite testinin çıktısına göre netleşecek.**

**Zamanlama:** hafta içi TRT 20:00 ve 23:00 (UTC 17:00 / 20:00). Eski TEFAS dokümanı verinin genelde 19:00 sonrası güncellendiğini söylüyor; *yeni sitede bu saat doğrulanmadı.* GitHub cron'u best-effort'tur (gecikebilir); iş iki kez çalıştığı için tolere edilir.

**Yayın:** `data` adlı ayrı dal, tek commit'e force-push (repo geçmişini kirletmez). Worker `raw.githubusercontent.com/SelimY/Investor/data/tefas_prices.json` adresinden okur. Alternatif: Actions'tan Cloudflare KV'ye yazmak (ek olarak bir Cloudflare API token'ı gerektirir).

**Hata modu:** iş başarısız olursa eski snapshot yerinde kalır → Worker `stale` işaretler → istemci Manuel Fiyat / proxy'ye düşebilir. Snapshot bulunamazsa TEFAS kalemleri `ok:false, permanent:false, error:"snapshot-unavailable"` döner.

## 6. İstemci değişiklikleri (Investor v0.14)

- `runPriceRefresh`: tek `/pricesPost` çağrısı; `id = ticker`. Cevap `id` ile eşlenir.
- Fiyat önbelleği ticker anahtarlı; `source / freshness / asOf` saklanır.
- Yeni fiyat noktası: `eod` — tooltip *"TEFAS kapanış — 26.09.2026"*; `stale` ise uyarı rengi.
- "Bugün" kolonu `previousClose` olan her kaynakta çalışır (TEFAS dahil).
- Tarihsel fiyat (transfer maliyeti): `/historicalPost` aynı yönlendirmeyle. TEFAS için snapshot'a son N günlük seri eklenmesi **Faz 4**.

## 7. Faz planı

| Faz | İçerik | Kapı |
|---|---|---|
| 0 | `tefas-test.yml` fizibilite testi | Akamai Actions'tan geçiyor mu? |
| 1 | Snapshot workflow'u + `data` dalı | Faz 0 PASS |
| 2 | Worker gateway (`/pricesPost`), eski uç noktalar korunur | — |
| 3 | Investor v0.14 istemci geçişi | Faz 2 canlıda |
| 4 | Tarihsel TEFAS serisi, yedek sağlayıcılar | — |

Faz 2 ve 3, TEFAS'tan bağımsız olarak (Yahoo tarafıyla) başlayabilir; TEFAS sağlayıcısı sonradan takılır.

## 8. Riskler

- **Akamai** Actions IP'lerine de geçit vermeyebilir → Faz 0 bunu belirler. Plan B: Cloudflare Browser Run testi; olmazsa TEFAS fonları için Manuel Fiyat.
- **`tefasmak` tek kişilik bir proje**; TEFAS API'si değişirse kırılabilir. Etki snapshot şemasında izole: kaynak değişse Worker/istemci etkilenmez, en kötü ihtimalle veri `stale` görünür.
- TEFAS'ın dakikada ~6 istek sınırı toplu çağrıyla sorun olmaz.

## 9. Açık kararlar

1. **Yayın yeri:** `data` dalı (sıfır ek kurulum) mı, Cloudflare KV (API token gerekir) mı? *Öneri: `data` dalı.*
2. **Fon evreni:** tüm YAT (izleme listesi yok) mı, izleme listesi mi? EMK/BYF gerekli mi? *Öneri: tüm YAT.*
3. Mevcut **"Türk Yatırım Fonları"** tipi Yahoo `.IS`'te mi kalsın, TEFAS'a mı geçsin?

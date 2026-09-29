# Fiyat Ağ Geçidi (Price Gateway) — Tasarım

**Durum:** Faz 0–3 **tamamlandı** (fizibilite, TEFAS snapshot hattı, Worker v2 ağ geçidi, Investor v0.14.0). Faz 4 (tarihsel TEFAS serisi, yedek sağlayıcı) bekliyor.
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
    "XYZ":   { "ok": false, "error": "Fon TEFAS YAT snapshot listesinde yok (…)", "permanent": false, "source": "tefas-snapshot" }
}}
```

- `permanent: true` yalnızca Yahoo'nun *kesin* "sembol yok" yanıtında (ya da geçerli JSON'da fiyat alanı hiç yoksa); ağ/HTTP hataları `false`. TEFAS'ta "snapshot'ta yok" da `false`: fon BYF/EMK olabilir ya da fiyatı boş olabilir, yani kesin "yok" denemez.
- `stale: true`: snapshot **üretim zamanı** (`generatedAt`) 4 günden eskiyse (iş bozulmuş demektir) **ya da** fonun kendi fiyat tarihi 12 günden eskiyse (bayram tatili payı; tek fonun durması). İş hafta içi tatillerde de çalıştığı için `generatedAt` bayramda bayatlamaz. Veri yine döner, istemci uyarı gösterir.
- Mevcut `/quotePost`, `/quoteGet` ve `/historicalPost {requests:[…]}` uç noktaları **birebir** korundu (yahoo_test_v2.html ve eski istemciler çalışmaya devam eder). Yeni: `POST /historicalPost {items:[…]}` (anahtar bazlı yanıt; TEFAS için snapshot'taki son iki iş günü) ve `GET /health` (sürüm + snapshot durumu).

## 4. Yönlendirme tablosu (Worker içinde)

| assetType | Sağlayıcı | Sembol kuralı | Tazelik |
|---|---|---|---|
| Türk TEFAS Fonları, **Türk Yatırım Fonları** | TEFAS snapshot | fon kodu olduğu gibi | `eod` |
| Türk Hisse Senetleri | Yahoo | `+.IS` | `live` |
| Türk Varantlar | Yahoo | `+.V` | `live` |
| Amerikan Hisse Senetleri / Opsiyonları | Yahoo | olduğu gibi | `live` |
| Avrupa Hisse Senetleri / Opsiyonları | Yahoo | `+.DE` (varsayılan) | `live` |

`buildYahooSymbol` istemciden kalkar. Yahoo'da doğrulanmamış olan `[FONADI].TEFAS` yolu emekliye ayrılır. **Karar:** "Türk Yatırım Fonları" tipi de artık Yahoo `.IS`'e gitmez; bu tipte yalnızca TEFAS okunur. Not: snapshot yalnızca YAT fonlarını kapsar; borsada işlem gören fonlar (BYF) veya emeklilik fonları (EMK) bu tiplerde varsa listede bulunmaz — gerekirse `fonTipi` genişletilir. Süresi dolmuş opsiyonların atlanması (v0.12.7) istemcide kalır.

*Genişletme noktası:* her `assetType` için `[birincil, yedek…]` sağlayıcı zinciri tanımlanabilir. Şimdilik yedek sağlayıcı yok (YAGNI).

## 5. TEFAS snapshot hattı (uygulandı)

**Dosyalar:** `.github/workflows/tefas-snapshot.yml`, `.github/scripts/tefas_snapshot.py`.
**Kaynak:** `tefasmak.fonlar_son_fiyat_bulk("YAT", tarih=YYYYMMDD)` — sayfalı toplu çekim; ~2000 fon, gün başına ~3 istek. İzleme listesi yok; Worker yalnızca istenen kodları seçer.

**Tarih mantığı (durumsuz).**
- İstanbul saatiyle bugünden geriye yürünür; hafta sonları atlanır. Boş sonuç = tatil ya da henüz yayınlanmamış gün → atlanır.
- En yeni **iki** dolu gün çekilir. En yeni gün bir öncekinin %95'inden azsa (kısmi yayın) üçüncü gün de çekilir.
- Her fon için fiyat = fonu içeren **en yeni** günün fiyatı; önceki fiyat = bir sonraki eski günün fiyatı. Tarih fon bazlıdır (`tarih` alanı API'den gelir), yani kısmi yayında eksik fonlar bir önceki günle görünür ve `date` bunu açıkça söyler.
- Önceki fiyat aynı çalışmada ikinci bir toplu çekimle alındığı için "Bugün" kolonu ilk günden çalışır; günler arası devretme durumu yoktur.
- **Ağ/Akamai hatası boş sonuç sayılmaz:** `tefasmak` istisna fırlatır, iş hata verir, eski snapshot yerinde kalır (tatil ile engellenme karışmaz).
- **Sağlık kontrolü:** fon sayısı 1500'ün altındaysa yayınlanmaz.

**Şema (`tefas_prices.json`, ≈310 KB)**
```json
{ "generatedAt": "2026-09-28T14:45:49Z", "source": "tefasmak 1.0.1", "fundType": "YAT",
  "asOfDates": ["2026-09-28", "2026-09-25"], "count": 2019,
  "funds": { "IPB": { "price": 0.765776, "date": "2026-09-28", "name": "İSTANBUL PORTFÖY BİRİNCİ DEĞİŞKEN FON",
                       "prevPrice": 0.755303, "prevDate": "2026-09-25" } } }
```

**Zamanlama:** hafta içi TRT 20:00 ve 23:00 (UTC 17:00 / 20:00) + `workflow_dispatch` + iki dosyadan biri `main`'de değişince. İlk çalışma 28.09.2026 17:45 TRT'de yapıldı ve aynı günün (2026-09-28) fiyatlarını döndürdü; yani TEFAS bu saatte günün fiyatını zaten yayınlıyor (eski dokümandaki "19:00 sonrası" varsayımı yeni sitede geçerli değil, ya da fona göre değişiyor).

**Yayın:** `data` dalı, tek commit, her çalışmada force-push. Worker `https://raw.githubusercontent.com/SelimY/Investor/data/tefas_prices.json` adresinden okur (doğrulandı: HTTP 200, `access-control-allow-origin: *`, `cache-control: max-age=300` — yani en fazla ~5 dk GitHub önbelleği; Worker kendi önbelleği ~30 dk).

**Hata modu:** iş başarısız olursa eski snapshot kalır → Worker `stale` işaretler → istemci Manuel Fiyat / proxy'ye düşebilir. Snapshot okunamazsa TEFAS kalemleri `ok:false, permanent:false, error:"snapshot-unavailable"` döner.

## 6. İstemci değişiklikleri (Investor v0.14)

- `runPriceRefresh`: tek `/pricesPost` çağrısı; `id = ticker`. Cevap `id` ile eşlenir.
- Fiyat önbelleği ticker anahtarlı; `source / freshness / asOf` saklanır.
- Yeni fiyat noktası: `eod` — tooltip *"TEFAS kapanış — 26.09.2026"*; `stale` ise uyarı rengi.
- "Bugün" kolonu `previousClose` olan her kaynakta çalışır (TEFAS dahil).
- Tarihsel fiyat (transfer maliyeti): `/historicalPost` aynı yönlendirmeyle. TEFAS için snapshot'a son N günlük seri eklenmesi **Faz 4**.

## 7. Faz planı

| Faz | İçerik | Kapı |
|---|---|---|
| 0 | `tefas-test.yml` fizibilite testi | ✅ **Geçti** — Actions çıkış IP'si (Azure) + curl_cffi ile 2040 fonluk toplu çekim 20 sn'de tamamlandı |
| 1 | Snapshot workflow'u + `data` dalı | ✅ **Canlı** — ilk çalışma 2019 fon, 2016'sı aynı günün fiyatıyla |
| 2 | Worker gateway (`/pricesPost`), eski uç noktalar korunur | ✅ **Yazıldı ve test edildi** (`worker/investor-yahoo-proxy.js`, v2.0.0) — dağıtım kullanıcı tarafından |
| 3 | Investor v0.14 istemci geçişi | ✅ **v0.14.0** — Worker v2 dağıtılınca çalışır |
| 4 | Tarihsel TEFAS serisi, yedek sağlayıcılar | — |

Faz 2 ve 3, TEFAS'tan bağımsız olarak (Yahoo tarafıyla) başlayabilir; TEFAS sağlayıcısı sonradan takılır.

## 8. Riskler

- ~~Akamai Actions'a geçit vermeyebilir~~ → ölçüldü, geçit veriyor. Yine de Akamai kuralları değişebilir; bu durumda iş hata verir ve snapshot `stale` görünür (Plan B: Cloudflare Browser Run testi; olmazsa Manuel Fiyat).
- **`tefasmak` tek kişilik bir proje**; TEFAS API'si değişirse kırılabilir. Etki snapshot şemasında izole: kaynak değişse Worker/istemci etkilenmez, en kötü ihtimalle veri `stale` görünür.
- **GitHub zamanlanmış workflow'ları**, public repoda 60 gün hareketsizlikte devre dışı bırakılabilir; repo aktif kullanıldığı sürece sorun olmaz, ama `stale` uyarısı bunu da yakalar.
- Snapshot ~21 fonu (2040 satırdan 2019 geçerli fiyat) dışarıda bırakıyor: fiyatı boş/0 olanlar. Bunlar için Worker `ok:false` döner.
- Yeni TEFAS sitesinin fiyat yayın saati fona göre değişebilir; tarih fon bazlı taşındığı için bu bir doğruluk değil, tazelik meselesidir.

## 8b. Uygulama notları (Faz 2–3)

- **Worker dosyası** artık repoda: `worker/investor-yahoo-proxy.js` (Cloudflare panelinden yapıştırılarak deploy edilir). Sürüm `GET /health` ile doğrulanır.
- **Testler:** Worker (11 grup, sahte Yahoo + gerçek snapshot), istemci fiyat çekirdeği (dosyadan çıkarılan gerçek kod, 9 grup) ve ikisini birbirine bağlayan entegrasyon testi (güncel fiyat + transfer maliyeti) çalıştırıldı. Canlı Yahoo'ya karşı test yapılamadı (geliştirme ortamı erişemiyor); Yahoo yanıt biçimi mevcut üretim kodundan aynen korundu.
- **Cloudflare ücretsiz plan sınırı:** istek başına 50 alt-istek → kalem sınırı 50 (TEFAS kalemleri tek snapshot isteği harcar). CPU limiti 10 ms; snapshot (~310 KB) isolate içinde 5 dk bellekte tutulur, edge önbelleği 30 dk. CPU aşımı görülürse ilk bakılacak yer snapshot ayrıştırma maliyetidir.
- **İstemci önbelleği** ticker anahtarlı (`investor_price_v2_<ticker>`); `freshness`/`asOf`/`stale` saklanır. Eski Yahoo-sembol anahtarlı kayıtlar ilk açılışta silinir.
- **Yeni fiyat noktası** `eod` (mavi); `stale` ise içi boş altın halka. "Bugün" kolonu `previousClose` olan her kaynakta çalışır.

## 9. Kararlar

1. **Yayın yeri:** `data` dalı ✅
2. **Fon evreni:** tüm YAT ✅ (EMK/BYF gerekirse sonradan)
3. **"Türk Yatırım Fonları":** Yahoo `.IS`'te kalmaz; yalnızca TEFAS okunur ✅
4. **Faz 2–3 onaylandı** ve uygulandı. Worker'ın Cloudflare'e deploy edilmesi kullanıcı tarafından yapılır.

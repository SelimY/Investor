# Investor — Yatırım Takip Sistemi

Tek dosyalık, veritabanı gerektirmeyen (SQLite/WASM gömülü) tarayıcı tabanlı yatırım portföyü takip uygulaması. FIFO/AVG maliyet hesaplama, etiket sistemi, Yahoo Finance fiyat entegrasyonu ve Dosya Sistemi Erişim API'si ile otomatik kayıt içerir.

## Bağlantılar

| # | Sayfa | Bağlantı |
|---|-------|----------|
| 1 | Main | https://selimy.github.io/Investor/investor.html |
| 2 | Yahoo Test v1 | https://selimy.github.io/Investor/Tools/yahoo_test.html |
| 3 | Yahoo Test v2 | https://selimy.github.io/Investor/Tools/yahoo_test_v2.html |

## İçerik

- **`investor.html`** — Uygulamanın güncel sürümü (v0.14.0). Doğrudan tarayıcıda açılabilir; FSA desteği için `https://` veya `localhost` üzerinden servis edilmesi önerilir.
- **`Archive/`** — Önceki/arşivlenmiş sürümler.
- **`Tools/`** — Geliştirme sırasında kullanılan yardımcı test araçları (ör. Yahoo Finance bağlantı testi).

## Kullanım

`investor.html` dosyasını bir tarayıcıda açmanız yeterlidir. İlk kullanımda hamburger menüden bir `.sqlite` dosyasına bağlanabilir veya yeni bir veritabanı oluşturabilirsiniz.

## Fiyat altyapısı

Investor tüm fiyat sorgularını tek bir Cloudflare Worker'a (`worker/investor-yahoo-proxy.js`, v2) gönderir; Worker Yahoo (canlı) ve TEFAS (son kapanış) fiyatlarını konsolide eder. TEFAS verisi, GitHub Actions'ın (`.github/workflows/tefas-snapshot.yml`) hafta içi akşam ürettiği `data` dalındaki snapshot'tan gelir. Tasarım: [`docs/PRICE_GATEWAY_DESIGN.md`](docs/PRICE_GATEWAY_DESIGN.md).

**Worker'ı güncelleme:** Cloudflare paneli → Workers & Pages → `investor-yahoo-proxy` → Edit code → `worker/investor-yahoo-proxy.js` içeriğini yapıştır → Deploy. Doğrulama: `https://investor-yahoo-proxy.yanniers.workers.dev/health` adresi `"version":"2.0.0"` ve TEFAS snapshot durumunu göstermeli.

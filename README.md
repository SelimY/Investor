# Investor — Yatırım Takip Sistemi

Tek dosyalık, veritabanı gerektirmeyen (SQLite/WASM gömülü) tarayıcı tabanlı yatırım portföyü takip uygulaması. FIFO/AVG maliyet hesaplama, etiket sistemi, Yahoo Finance fiyat entegrasyonu ve Dosya Sistemi Erişim API'si ile otomatik kayıt içerir.

## İçerik

- **`index.html`** — Uygulamanın güncel sürümü (v0.12.1). Doğrudan tarayıcıda açılabilir; FSA desteği için `https://` veya `localhost` üzerinden servis edilmesi önerilir.
- **`Archive/`** — Önceki/arşivlenmiş sürümler.
- **`Tools/`** — Geliştirme sırasında kullanılan yardımcı test araçları (ör. Yahoo Finance bağlantı testi).

## Kullanım

`index.html` dosyasını bir tarayıcıda açmanız yeterlidir. İlk kullanımda hamburger menüden bir `.sqlite` dosyasına bağlanabilir veya yeni bir veritabanı oluşturabilirsiniz.

// ================= Investor — Fiyat Ağ Geçidi (Cloudflare Worker) v2 =================
//
// TEK KAPI: Investor tüm fiyat sorgularını buraya gönderir. Kaynak seçimi ve sembol eşleme (.IS/.V/.DE ...)
// Worker'dadır. Yahoo canlı fiyat verir; TEFAS fonları için GitHub Actions'ın her hafta içi akşam ürettiği
// günlük snapshot (`data` dalı) okunur — TEFAS anlık değil, SON KAPANIŞ (günlük birim pay fiyatı) verir.
//
// ---------- YENİ (v2) ----------
//
//   POST /pricesPost                       güncel fiyat, tüm kaynaklar konsolide
//     Body:  {"items":[{"id":"TUPRS","assetType":"Türk Hisse Senetleri","currency":"TRY"}, ...]}   (en fazla 50 kalem)
//     Yanıt: {"fetchedAt":"…","results":{"TUPRS":{…}, …},"meta":{"tefas":{…}}}
//       results ANAHTAR bazlıdır (id'ye göre) — dizi sırasına bağımlılık yoktur.
//       Başarılı kalem:  {ok:true, price, previousClose, currency, source, freshness:"live"|"eod", asOf, name, …}
//         source "yahoo"  + freshness "live"  : canlı; asOf ISO zaman damgası, marketState/dayHigh/dayLow var
//         source "tefas-snapshot" + freshness "eod": son kapanış; asOf "YYYY-MM-DD" (NAV tarihi), prevDate, stale
//       Hatalı kalem:    {ok:false, error, permanent, source}   permanent=true YALNIZCA Yahoo'nun kesin "sembol yok" yanıtında
//       stale=true: snapshot 4 günden eski üretilmiş YA DA fonun fiyat tarihi 12 günden eski (bayram payı)
//
//   POST /historicalPost  {"items":[{"id":"0","ticker":"AAPL","assetType":"…","date":"2025-03-14","time":"14:30:00"?}]}
//                          geçmiş tarih fiyatı; yanıt results ANAHTAR bazlı: {ok, price, source, method, asOf}
//                          TEFAS için yalnızca snapshot'taki son iki iş günü desteklenir (tam seri: Faz 4).
//
//   GET  /health                           sürüm + TEFAS snapshot durumu (dağıtımı doğrulamak için tarayıcıdan açın)
//
// Yönlendirme (assetType -> kaynak):
//   Türk TEFAS Fonları, Türk Yatırım Fonları  -> TEFAS snapshot (kod olduğu gibi)
//   Türk Hisse Senetleri  -> Yahoo  + ".IS"       Türk Varantlar -> Yahoo + ".V"
//   Avrupa Hisse (+Opsiyon) -> Yahoo + ".DE" (uzantı yoksa)      diğerleri / opsiyon formatı -> Yahoo olduğu gibi
//
// ---------- ESKİ (geriye dönük uyumlu, DEĞİŞMEDİ) ----------
//
//   GET  /quoteGet?symbols=AAPL|TUPRS.IS|MSFT       (ayraç "|")
//   POST /quotePost        {"symbols":["AAPL","TUPRS.IS"]}                     -> {results:[…]} (dizi, sıralı)
//   POST /historicalPost   {"requests":[{"symbol":"AAPL","date":"2025-03-14","time":"14:30:00"?}]}  -> {results:[…]}
//
// Yahoo/TEFAS'a istek TARAYICIDAN değil bu Worker'dan (sunucu-sunucu) gittiği için CORS sorunu yoktur.
// Cloudflare ücretsiz plan notu: istek başına en fazla 50 alt-istek → kalem sınırı 50.
// ==========================================================================================

const ALLOWED_ORIGIN = '*'; // İstersen 'https://selimy.github.io' ile kısıtlayabilirsin
const YAHOO_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() }
  });
}

async function fetchYahooSymbol(symbol) {
  const targetUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
  try {
    const res = await fetch(targetUrl, {
      headers: {
        // Yahoo bazı botları/başlıksız istekleri reddedebiliyor — gerçekçi bir User-Agent ekliyoruz
        'User-Agent': YAHOO_UA
      }
    });
    if (!res.ok) {
      return { symbol, error: `HTTP ${res.status}` };
    }
    const data = await res.json();

    if (data && data.chart && data.chart.error) {
      return { symbol, error: data.chart.error.description || data.chart.error.code || 'Yahoo API hatası' };
    }
    const meta = data && data.chart && data.chart.result && data.chart.result[0] && data.chart.result[0].meta;
    if (!meta || typeof meta.regularMarketPrice !== 'number') {
      return { symbol, error: 'Fiyat verisi bulunamadı (sembol geçersiz olabilir)' };
    }

    const previousClose = (typeof meta.previousClose === 'number')
      ? meta.previousClose
      : (typeof meta.chartPreviousClose === 'number' ? meta.chartPreviousClose : null);

    return {
      symbol: meta.symbol || symbol,
      price: meta.regularMarketPrice,
      previousClose,
      dayHigh: (typeof meta.regularMarketDayHigh === 'number') ? meta.regularMarketDayHigh : null,
      dayLow: (typeof meta.regularMarketDayLow === 'number') ? meta.regularMarketDayLow : null,
      marketState: meta.marketState || null,
      currency: meta.currency || null,
      longName: meta.longName || meta.shortName || null
    };
  } catch (e) {
    return { symbol, error: e.message || 'Ağ hatası' };
  }
}

// v0.13: belirli bir geçmiş tarih için fiyat — önce gün-içi (5dk) dener, sonra günlük açılış/kapanış ortalamasına düşer
async function fetchHistoricalPrice(symbol, dateStr, timeStr) {
  if (!symbol || !dateStr) return { error: 'symbol ve date gerekli' };
  let dayStart;
  try {
    dayStart = Math.floor(new Date(dateStr + 'T00:00:00Z').getTime() / 1000);
    if (!Number.isFinite(dayStart)) throw new Error('geçersiz tarih');
  } catch (e) {
    return { error: 'Geçersiz tarih formatı (YYYY-MM-DD bekleniyor)' };
  }
  const dayEnd = dayStart + 86400;

  // Kademe 1: gün-içi (5 dakikalık) veri
  try {
    const intraUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${dayStart}&period2=${dayEnd}&interval=5m`;
    const res = await fetch(intraUrl, { headers: { 'User-Agent': YAHOO_UA } });
    if (res.ok) {
      const data = await res.json();
      const result = data && data.chart && data.chart.result && data.chart.result[0];
      const closes = result && result.indicators && result.indicators.quote && result.indicators.quote[0] && result.indicators.quote[0].close;
      if (result && result.timestamp && result.timestamp.length && closes) {
        let targetTs = dayStart + 12 * 3600; // saat verilmemişse öğlen hedeflenir
        if (timeStr) {
          const parts = String(timeStr).split(':').map(Number);
          targetTs = dayStart + (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
        }
        let bestIdx = -1, bestDiff = Infinity;
        result.timestamp.forEach((ts, i) => {
          if (closes[i] == null) return;
          const diff = Math.abs(ts - targetTs);
          if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
        });
        if (bestIdx !== -1) {
          return { price: closes[bestIdx], source: 'intraday' };
        }
      }
    }
  } catch (e) { /* kademe 2'ye düş */ }

  // Kademe 2: günlük bar, açılış+kapanış ortalaması
  try {
    const dailyUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${dayStart}&period2=${dayEnd}&interval=1d`;
    const res2 = await fetch(dailyUrl, { headers: { 'User-Agent': YAHOO_UA } });
    if (!res2.ok) return { error: `HTTP ${res2.status}` };
    const data2 = await res2.json();
    if (data2 && data2.chart && data2.chart.error) {
      return { error: data2.chart.error.description || data2.chart.error.code || 'Yahoo API hatası' };
    }
    const result2 = data2 && data2.chart && data2.chart.result && data2.chart.result[0];
    const q = result2 && result2.indicators && result2.indicators.quote && result2.indicators.quote[0];
    if (q && q.open && q.close && q.open[0] != null && q.close[0] != null) {
      return { price: (q.open[0] + q.close[0]) / 2, source: 'daily-avg', open: q.open[0], close: q.close[0] };
    }
    return { error: 'O tarihe ait veri bulunamadı (tatil/hafta sonu olabilir)' };
  } catch (e) {
    return { error: e.message || 'Ağ hatası' };
  }
}


// ============================================================================================
// v2 — FİYAT AĞ GEÇİDİ
// ============================================================================================
const WORKER_VERSION = '2.0.0';
const TEFAS_SNAPSHOT_URL = 'https://raw.githubusercontent.com/SelimY/Investor/data/tefas_prices.json';
const TEFAS_SNAPSHOT_MEMO_MS = 5 * 60 * 1000;   // isolate içi bellek ömrü
const TEFAS_SNAPSHOT_EDGE_TTL_S = 1800;         // Cloudflare edge önbelleği (sn)
const TEFAS_SNAPSHOT_STALE_DAYS = 4;            // snapshot bu kadar günden eski üretilmişse "bayat"
const TEFAS_FUND_STALE_DAYS = 12;               // fonun fiyat tarihi bu kadar günden eskiyse "bayat" (bayram tatili payı)
const MAX_ITEMS = 50;

const TEFAS_ASSET_TYPES = new Set(['Türk TEFAS Fonları', 'Türk Yatırım Fonları']);
const OPTION_RE = /^[A-Z]+\d{6}[CP]\d+$/;

function providerFor(assetType) {
  return TEFAS_ASSET_TYPES.has(assetType) ? 'tefas' : 'yahoo';
}

// İstemcideki eski buildYahooSymbol'ün Worker'a taşınmış hali (TEFAS tipleri artık Yahoo'ya gitmez)
function yahooSymbolFor(ticker, assetType) {
  if (OPTION_RE.test(ticker)) return ticker; // opsiyon formatı zaten Yahoo ile uyumlu
  if (assetType === 'Türk Varantlar') return /\.V$/i.test(ticker) ? ticker : ticker + '.V';
  if (assetType === 'Türk Hisse Senetleri') return /\.IS$/i.test(ticker) ? ticker : ticker + '.IS';
  if (assetType === 'Avrupa Hisse Senetleri' || assetType === 'Avrupa Hisse Opsiyonları') {
    // Borsa bilgisi tutulmadığı için varsayılan olarak .DE (Frankfurt)
    return /\.[A-Za-z]{1,3}$/.test(ticker) ? ticker : ticker + '.DE';
  }
  return ticker; // Amerikan hisse/opsiyon: olduğu gibi
}

function normalizeItems(items) {
  const out = [];
  for (const it of items) {
    const rawId = it && (it.id != null ? it.id : it.ticker);
    const id = rawId != null ? String(rawId).trim() : '';
    if (!id) return null;
    out.push({
      id,
      ticker: String(it.ticker != null ? it.ticker : id).trim(),
      assetType: typeof it.assetType === 'string' ? it.assetType : '',
      date: typeof it.date === 'string' ? it.date : '',
      time: typeof it.time === 'string' ? it.time : ''
    });
  }
  return out;
}

// ---------- Yahoo sağlayıcısı (ağ geçidi biçimi) ----------
async function yahooGatewayQuote(symbol) {
  try {
    const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`, {
      headers: { 'User-Agent': YAHOO_UA }
    });
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }

    const chartErr = data && data.chart && data.chart.error;
    if (chartErr) {
      const text = `${chartErr.code || ''} ${chartErr.description || ''}`;
      return {
        ok: false, source: 'yahoo',
        error: chartErr.description || chartErr.code || 'Yahoo API hatası',
        permanent: /not found|no data/i.test(text)   // yalnızca Yahoo'nun KESİN "sembol yok" yanıtı
      };
    }
    if (!res.ok) return { ok: false, source: 'yahoo', error: `HTTP ${res.status}`, permanent: false };

    const meta = data && data.chart && data.chart.result && data.chart.result[0] && data.chart.result[0].meta;
    if (!meta || typeof meta.regularMarketPrice !== 'number') {
      return { ok: false, source: 'yahoo', error: 'Fiyat verisi bulunamadı (sembol geçersiz olabilir)', permanent: true };
    }
    const previousClose = (typeof meta.previousClose === 'number')
      ? meta.previousClose
      : (typeof meta.chartPreviousClose === 'number' ? meta.chartPreviousClose : null);
    return {
      ok: true, source: 'yahoo', freshness: 'live',
      price: meta.regularMarketPrice,
      previousClose,
      currency: meta.currency || null,
      asOf: (typeof meta.regularMarketTime === 'number') ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
      marketState: meta.marketState || null,
      dayHigh: (typeof meta.regularMarketDayHigh === 'number') ? meta.regularMarketDayHigh : null,
      dayLow: (typeof meta.regularMarketDayLow === 'number') ? meta.regularMarketDayLow : null,
      name: meta.longName || meta.shortName || null,
      symbol: meta.symbol || symbol
    };
  } catch (e) {
    return { ok: false, source: 'yahoo', error: e.message || 'Ağ hatası', permanent: false };
  }
}

// ---------- TEFAS sağlayıcısı (günlük snapshot) ----------
let tefasMemo = { at: 0, data: null };

async function loadTefasSnapshot() {
  const now = Date.now();
  if (tefasMemo.data && now - tefasMemo.at < TEFAS_SNAPSHOT_MEMO_MS) return tefasMemo.data;
  try {
    const res = await fetch(TEFAS_SNAPSHOT_URL, { cf: { cacheTtl: TEFAS_SNAPSHOT_EDGE_TTL_S, cacheEverything: true } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!data || typeof data.funds !== 'object' || data.funds === null) throw new Error('Geçersiz snapshot biçimi');
    tefasMemo = { at: now, data };
    return data;
  } catch (e) {
    if (tefasMemo.data) return tefasMemo.data;   // eski bellek kopyası hiç yoktan iyidir (bayatlık ayrıca işaretlenir)
    throw e;
  }
}

function daysSinceIso(iso, nowMs) {
  const t = Date.parse(String(iso || '').slice(0, 10) + 'T00:00:00Z');
  return Number.isFinite(t) ? Math.floor((nowMs - t) / 86400000) : Infinity;
}
function tefasCode(ticker) {
  return String(ticker || '').trim().toUpperCase().replace(/\.(TEFAS|IS)$/i, '');
}
function tefasMeta(snap, nowMs) {
  const gen = Date.parse(snap.generatedAt || '');
  return {
    ok: true,
    generatedAt: snap.generatedAt || null,
    asOfDates: snap.asOfDates || [],
    count: snap.count != null ? snap.count : Object.keys(snap.funds).length,
    ageHours: Number.isFinite(gen) ? Math.round((nowMs - gen) / 360000) / 10 : null,
    stale: !Number.isFinite(gen) || (nowMs - gen) / 86400000 > TEFAS_SNAPSHOT_STALE_DAYS
  };
}
function tefasGatewayQuote(ticker, snap, nowMs) {
  const f = snap.funds[tefasCode(ticker)];
  if (!f) {
    return { ok: false, source: 'tefas-snapshot', permanent: false,
             error: 'Fon TEFAS YAT snapshot listesinde yok (borsada işlem gören/emeklilik fonu ya da fiyatı boş olabilir)' };
  }
  const stale = tefasMeta(snap, nowMs).stale || daysSinceIso(f.date, nowMs) > TEFAS_FUND_STALE_DAYS;
  return {
    ok: true, source: 'tefas-snapshot', freshness: 'eod',
    price: f.price,
    previousClose: (typeof f.prevPrice === 'number') ? f.prevPrice : null,
    currency: 'TRY',
    asOf: f.date,
    prevDate: f.prevDate || null,
    stale,
    name: f.name || null
  };
}
function tefasHistoricalQuote(ticker, date, snap) {
  const f = snap.funds[tefasCode(ticker)];
  if (!f) return { ok: false, source: 'tefas-snapshot', permanent: false, error: 'Fon TEFAS YAT snapshot listesinde yok' };
  const d = String(date || '').slice(0, 10);
  if (d === f.date) return { ok: true, source: 'tefas-snapshot', method: 'snapshot', price: f.price, asOf: f.date };
  if (f.prevDate && d === f.prevDate && typeof f.prevPrice === 'number') {
    return { ok: true, source: 'tefas-snapshot', method: 'snapshot', price: f.prevPrice, asOf: f.prevDate };
  }
  return { ok: false, source: 'tefas-snapshot', permanent: false,
           error: 'TEFAS için geçmiş fiyat şimdilik yalnızca son iki iş günü için destekleniyor (tam seri planlandı)' };
}

// ---------- uç nokta işleyicileri ----------
async function handlePricesPost(request) {
  let body;
  try { body = await request.json(); }
  catch (e) { return jsonResponse({ error: 'Geçersiz JSON gövdesi — { "items": [{"id":"AAPL","assetType":"Amerikan Hisse Senetleri"}] } bekleniyor' }, 400); }
  const raw = Array.isArray(body && body.items) ? body.items : [];
  if (!raw.length) return jsonResponse({ error: 'items listesi boş veya eksik' }, 400);
  if (raw.length > MAX_ITEMS) return jsonResponse({ error: `Tek istekte en fazla ${MAX_ITEMS} kalem desteklenir` }, 400);
  const items = normalizeItems(raw);
  if (!items) return jsonResponse({ error: 'Her kalemde boş olmayan bir "id" gerekli' }, 400);

  const results = {};
  const meta = {};
  const nowMs = Date.now();
  const tefasItems = items.filter(it => providerFor(it.assetType) === 'tefas');
  const yahooItems = items.filter(it => providerFor(it.assetType) === 'yahoo');

  const tasks = yahooItems.map(async it => {
    results[it.id] = await yahooGatewayQuote(yahooSymbolFor(it.ticker, it.assetType));
  });
  if (tefasItems.length) {
    tasks.push((async () => {
      let snap = null, err = null;
      try { snap = await loadTefasSnapshot(); } catch (e) { err = e.message || String(e); }
      tefasItems.forEach(it => {
        results[it.id] = snap
          ? tefasGatewayQuote(it.ticker, snap, nowMs)
          : { ok: false, source: 'tefas-snapshot', permanent: false, error: 'snapshot-unavailable', detail: err };
      });
      meta.tefas = snap ? tefasMeta(snap, nowMs) : { ok: false, error: err };
    })());
  }
  await Promise.all(tasks);
  return jsonResponse({ fetchedAt: new Date().toISOString(), results, meta });
}

async function handleHistoricalItems(rawItems) {
  if (!rawItems.length) return jsonResponse({ error: 'items listesi boş veya eksik' }, 400);
  if (rawItems.length > MAX_ITEMS) return jsonResponse({ error: `Tek istekte en fazla ${MAX_ITEMS} kalem desteklenir` }, 400);
  const items = normalizeItems(rawItems);
  if (!items) return jsonResponse({ error: 'Her kalemde boş olmayan bir "id" gerekli' }, 400);
  if (items.some(it => !it.date)) return jsonResponse({ error: 'Her kalemde "date" (YYYY-MM-DD) gerekli' }, 400);

  let snap = null, snapErr = null;
  if (items.some(it => providerFor(it.assetType) === 'tefas')) {
    try { snap = await loadTefasSnapshot(); } catch (e) { snapErr = e.message || String(e); }
  }
  const results = {};
  await Promise.all(items.map(async it => {
    if (providerFor(it.assetType) === 'tefas') {
      results[it.id] = snap
        ? tefasHistoricalQuote(it.ticker, it.date, snap)
        : { ok: false, source: 'tefas-snapshot', permanent: false, error: 'snapshot-unavailable', detail: snapErr };
      return;
    }
    const r = await fetchHistoricalPrice(yahooSymbolFor(it.ticker, it.assetType), it.date, it.time || undefined);
    results[it.id] = r.error
      ? { ok: false, source: 'yahoo', permanent: false, error: r.error }
      : { ok: true, source: 'yahoo', method: r.source, price: r.price, open: r.open != null ? r.open : null, close: r.close != null ? r.close : null, asOf: it.date };
  }));
  return jsonResponse({ fetchedAt: new Date().toISOString(), results });
}

async function handleHealth() {
  const nowMs = Date.now();
  let tefas;
  try { tefas = tefasMeta(await loadTefasSnapshot(), nowMs); }
  catch (e) { tefas = { ok: false, error: e.message || String(e) }; }
  return jsonResponse({
    ok: true, worker: 'investor-price-gateway', version: WORKER_VERSION,
    endpoints: ['POST /pricesPost', 'POST /historicalPost', 'GET /health', 'POST /quotePost (eski)', 'GET /quoteGet (eski)'],
    tefas
  });
}

async function route(request) {
  const url = new URL(request.url);

  // ---------- v2: POST /pricesPost ----------
  if (url.pathname === '/pricesPost') {
    if (request.method !== 'POST') return jsonResponse({ error: '/pricesPost yalnızca POST metodunu kabul eder' }, 405);
    return handlePricesPost(request);
  }

  // ---------- v2: GET /health ----------
  if (url.pathname === '/health') {
    if (request.method !== 'GET') return jsonResponse({ error: '/health yalnızca GET metodunu kabul eder' }, 405);
    return handleHealth();
  }

  // ---------- GET /quoteGet?symbols=AAPL|TUPRS.IS|MSFT (eski) ----------
  if (url.pathname === '/quoteGet') {
    if (request.method !== 'GET') {
      return jsonResponse({ error: '/quoteGet yalnızca GET metodunu kabul eder' }, 405);
    }
    const symbolsParam = url.searchParams.get('symbols') || '';
    const symbols = symbolsParam.split('|').map(s => s.trim()).filter(Boolean);
    return handleSymbols(symbols);
  }

  // ---------- POST /quotePost  Body: {"symbols":[...]} (eski) ----------
  if (url.pathname === '/quotePost') {
    if (request.method !== 'POST') {
      return jsonResponse({ error: '/quotePost yalnızca POST metodunu kabul eder' }, 405);
    }
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return jsonResponse({ error: 'Geçersiz JSON gövdesi — { "symbols": ["AAPL","TUPRS.IS"] } bekleniyor' }, 400);
    }
    const symbols = Array.isArray(body.symbols) ? body.symbols.map(s => String(s).trim()).filter(Boolean) : [];
    return handleSymbols(symbols);
  }

  // ---------- POST /historicalPost ----------
  //   yeni:  {"items":[{id,ticker,assetType,date,time?}]}  -> results ANAHTAR bazlı
  //   eski:  {"requests":[{symbol,date,time?}]}            -> results dizi (sıralı)
  if (url.pathname === '/historicalPost') {
    if (request.method !== 'POST') {
      return jsonResponse({ error: '/historicalPost yalnızca POST metodunu kabul eder' }, 405);
    }
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return jsonResponse({ error: 'Geçersiz JSON gövdesi — { "items": [{"id":"0","ticker":"AAPL","assetType":"…","date":"2025-03-14"}] } bekleniyor' }, 400);
    }
    if (Array.isArray(body && body.items)) return handleHistoricalItems(body.items);
    const requests = Array.isArray(body.requests) ? body.requests : [];
    if (!requests.length) {
      return jsonResponse({ error: 'requests listesi boş veya eksik' }, 400);
    }
    if (requests.length > 50) {
      return jsonResponse({ error: 'Tek istekte en fazla 50 sorgu desteklenir' }, 400);
    }
    const results = await Promise.all(requests.map(r => fetchHistoricalPrice(r.symbol, r.date, r.time)));
    return jsonResponse({ results, fetchedAt: new Date().toISOString() });
  }

  return jsonResponse({
    error: 'Bilinmeyen uç nokta',
    usage: 'POST /pricesPost  Body: {"items":[{"id":"AAPL","assetType":"Amerikan Hisse Senetleri"}]}  (güncel fiyat, tüm kaynaklar)\nPOST /historicalPost  Body: {"items":[{"id":"0","ticker":"AAPL","assetType":"…","date":"2025-03-14"}]}\nGET /health  (sürüm + TEFAS snapshot durumu)\nEski: GET /quoteGet, POST /quotePost, POST /historicalPost {"requests":[…]}'
  }, 404);
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }
    try {
      return await route(request);
    } catch (e) {
      // Yakalanmayan hata Cloudflare'in CORS başlıksız HTML 500 sayfasına dönüşmesin
      return jsonResponse({ error: 'Sunucu hatası', detail: (e && e.message) || String(e) }, 500);
    }
  }
};

async function handleSymbols(symbols) {
  if (!symbols.length) {
    return jsonResponse({ error: 'symbols listesi boş veya eksik' }, 400);
  }
  if (symbols.length > 50) {
    return jsonResponse({ error: 'Tek istekte en fazla 50 sembol desteklenir' }, 400);
  }
  const results = await Promise.all(symbols.map(fetchYahooSymbol));
  return jsonResponse({ results, fetchedAt: new Date().toISOString() });
}

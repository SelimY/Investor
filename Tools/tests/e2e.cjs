// Investor — uçtan uca (E2E) testler: gerçek investor.html'i jsdom'da, gömülü gerçek sql.js (SQLite/WASM) ile çalıştırır;
// ağ yerine sahte bir fiyat ağ geçidi (Worker) kullanır. Kapsam: Gösterge Değerler paneli (A kartlar / B tablo, geçiş,
// düzenleme paneli, doğrulama, TTL/zorla yenileme, hata modları, eski veritabanı dosyalarının migrasyonu) ve v0.14
// portföy fiyat akışı (TEFAS kapanış fiyatı, "Bugün" kolonu) için regresyon.
//
// Çalıştırma:   cd Tools/tests && npm install jsdom@24 sql.js@1.8.0 && node e2e.cjs
const { JSDOM, VirtualConsole } = require('jsdom');
const initSqlJs = require('sql.js');
const assert = require('assert/strict');
const fs = require('fs');

const HTML = fs.readFileSync(require('path').join(__dirname, '..', '..', 'investor.html'), 'utf8');
const ok = n => console.log('OK  ', n);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- sahte fiyat ağ geçidi ----
const TARGETS = { '^GSPC': [6512.30, 0.62], '^NDX': [23184.55, 0.85], '^DJI': [45920.10, -0.18], '^RUT': [2415.80, 1.12], '^SOX': [6874.20, -1.34],
  '^VIX': [16.42, 3.10], '^TNX': [4.18, -0.95], 'DX-Y.NYB': [98.74, 0.21], 'CL=F': [68.45, -0.74], 'GC=F': [2050.5, 0] };
function gatewayResult(id) {
  if (id === 'AFT') return { ok: true, source: 'tefas-snapshot', freshness: 'eod', price: 1.056083, previousClose: 1.037657, currency: 'TRY', asOf: '2026-11-02', stale: false, name: 'AK PORTFÖY YENİ TEKNOLOJİLER' };
  if (id === 'AMZN') return { ok: true, source: 'yahoo', freshness: 'live', price: 264.12, previousClose: 262.0, currency: 'USD', asOf: '2026-11-02T14:30:00.000Z', name: 'Amazon.com, Inc.' };
  const t = TARGETS[id];
  if (!t) return { ok: false, source: 'yahoo', error: 'No data found, symbol may be delisted', permanent: true };
  return { ok: true, source: 'yahoo', freshness: 'live', price: t[0], previousClose: t[0] / (1 + t[1] / 100), currency: 'USD', asOf: '2026-11-02T14:30:00.000Z', name: 'Ad ' + id };
}

async function boot(opts = {}) {
  const requests = [];
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push('JSDOM-ERR: ' + ((e.detail && e.detail.message) || e.message)));
  vc.on('error', m => errors.push('console.error: ' + m));
  const state = { gateway: opts.gateway || 'ok' };
  const dom = new JSDOM(HTML, {
    url: 'https://selimy.github.io/Investor/investor.html', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(window) {
      window.TextDecoder = TextDecoder; window.TextEncoder = TextEncoder;
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
      Object.entries(opts.localStorage || {}).forEach(([k, v]) => window.localStorage.setItem(k, v));
      window.fetch = async (url, o) => {
        const body = o && o.body ? JSON.parse(o.body) : null;
        requests.push({ url: String(url), body });
        if (state.gateway === '404') return { ok: false, status: 404, json: async () => ({}) };
        if (state.gateway === 'down') throw new Error('Failed to fetch');
        if (String(url).endsWith('/pricesPost')) {
          const results = {};
          body.items.forEach(it => { results[it.id] = gatewayResult(it.id); });
          return { ok: true, status: 200, json: async () => ({ results }) };
        }
        return { ok: false, status: 400, json: async () => ({}) };
      };
    }
  });
  const w = dom.window, d = w.document;
  const waitFor = async (fn, msg, timeout = 9000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { try { const v = fn(); if (v) return v; } catch (e) {} await sleep(40); }
    throw new Error('Zaman aşımı: ' + msg + (errors.length ? ' | hatalar: ' + errors.join(' ; ') : ''));
  };
  const api = {
    w, d, requests, errors, state, waitFor,
    tiles: () => [...d.querySelectorAll('#indPanelBody .ind-tile')],
    tileText: t => ({ label: t.querySelector('.ind-tile-label').textContent, head: t.querySelector('.ind-head-val').textContent.trim(), sub: t.querySelector('.ind-sub').textContent.trim() }),
    logLines: () => [...d.querySelectorAll('.line')].map(l => l.textContent),
    click: el => el.click(),
    type: (el, v) => { el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); el.dispatchEvent(new w.Event('change', { bubbles: true })); },
    close: async () => { await sleep(350); w.close(); },
  };
  await waitFor(() => d.getElementById('indPanelBody') && /ind-tile|ind-table|ind-empty/.test(d.getElementById('indPanelBody').innerHTML), 'panelin ilk çizimi');
  return api;
}
const pricesReqs = a => a.requests.filter(r => r.url.endsWith('/pricesPost'));

(async () => {
  // =============== 1) varsayılan kurulum, değerler, kurallar ===============
  let a = await boot();
  await a.waitFor(() => a.tiles().every(t => a.tileText(t).head !== '—'), 'değerlerin gelmesi');
  const T = a.tiles().map(t => ({ ...a.tileText(t), cls: t.className, el: t }));
  assert.equal(T.length, 9);
  assert.deepEqual(T.map(t => t.label), ['S&P 500', 'Nasdaq 100', 'Dow Jones', 'Russell 2000', 'Çip Endeksi (SOX)', 'VIX', 'ABD 10 Yıllık Faiz', 'Dolar Endeksi', 'Ham Petrol (USOIL)']);
  assert.deepEqual(T.map(t => t.cls.includes('value-first')), [false, false, false, false, false, true, true, true, true]);
  // endeksler: manşet = gün içi %, alt = mutlak değer
  assert.deepEqual([T[0].head, T[0].sub], ['+0,62%', '6.512,30']);
  assert.deepEqual([T[1].head, T[1].sub], ['+0,85%', '23.184,55']);
  assert.deepEqual([T[2].head, T[2].sub], ['-0,18%', '45.920,10']);
  assert.deepEqual([T[3].head, T[3].sub], ['+1,12%', '2.415,80']);
  assert.deepEqual([T[4].head, T[4].sub], ['-1,34%', '6.874,20']);
  // göstergeler: manşet = anlık değer, alt = gün içi %
  assert.deepEqual([T[5].head, T[5].sub], ['16,42', '+3,10%']);
  assert.deepEqual([T[6].head, T[6].sub], ['%4,18', '-0,95%']);
  assert.deepEqual([T[7].head, T[7].sub], ['98,74', '+0,21%']);
  assert.deepEqual([T[8].head, T[8].sub], ['$68,45', '-0,74%']);
  // yön renkleri (+ üçgen)
  assert.ok(T[0].el.querySelector('.ind-head-val').classList.contains('ind-up'));
  assert.ok(T[2].el.querySelector('.ind-head-val').classList.contains('ind-down'));
  assert.ok(T[2].el.querySelector('.ind-tri.down') && T[0].el.querySelector('.ind-tri.up'));
  assert.ok(T[5].el.querySelector('.ind-sub').classList.contains('ind-up') && !T[5].el.querySelector('.ind-head-val').classList.contains('ind-up'));
  assert.ok(T[6].el.querySelector('.ind-sub').classList.contains('ind-down'));
  ok('A (kartlar) varsayılan: 9 gösterge, doğru sıra/gruplama, endekslerde manşet % + alt değer, VIX/Faiz/Dolar/Petrol\'de manşet değer + alt %, yön renkleri ve üçgenler');

  // ağ geçidi isteği: tek istek, 9 sembol, assetType "Gösterge"
  assert.equal(pricesReqs(a).length, 1);
  assert.deepEqual(pricesReqs(a)[0].body.items.map(i => i.id).sort(), Object.keys(TARGETS).filter(k => k !== 'GC=F').sort());
  assert.ok(pricesReqs(a)[0].body.items.every(i => i.assetType === 'Gösterge'));
  assert.notEqual(a.d.getElementById('indTime').textContent, '—');
  ok('tek /pricesPost isteği: 9 sembol, assetType "Gösterge"; panel saati güncellendi');

  // sürüm, phase-pill, spacer, Debug şeması
  assert.equal(a.d.querySelector('.brand-version').textContent, 'v0.15.0');
  assert.equal(a.d.querySelector('.phase-pill'), null);
  assert.equal(a.d.querySelectorAll('.dist-layout-spacer').length, 2);
  assert.equal(a.d.querySelectorAll('.dist-layout-spacer.ind-panel').length, 1);
  assert.match(a.d.getElementById('schemaSql').textContent, /CREATE TABLE market_indicators/);
  assert.ok([...a.d.querySelectorAll('#tableGrid .table-card')].some(c => /market_indicators/.test(c.textContent) && /9/.test(c.querySelector('.rowcount').textContent)));
  ok('v0.15.0, phase-pill yok, yalnızca Portföy Dağılımı spacer\'ı panel oldu (Hesap Durumu\'ndaki boş kaldı), Debug şemasında market_indicators 9 satır');

  // =============== 2) A <-> B geçişi ===============
  const toggle = a.d.getElementById('indViewToggleBtn');
  assert.equal(toggle.getAttribute('aria-label'), 'Tablo görünümüne geç');
  a.click(toggle);
  assert.ok(a.d.querySelector('#indPanelBody table.ind-table'));
  assert.equal(a.d.querySelectorAll('#indPanelBody tr.ind-group').length, 2);
  const rows = [...a.d.querySelectorAll('#indPanelBody tbody tr:not(.ind-group)')].map(r => [...r.children].map(c => c.textContent.trim()));
  assert.equal(rows.length, 9);
  assert.deepEqual(rows[0], ['S&P 500', '+0,62%', '6.512,30']);
  assert.deepEqual(rows[5], ['VIX', '16,42', '+3,10%']);
  assert.deepEqual(rows[8], ['Ham Petrol (USOIL)', '$68,45', '-0,74%']);
  assert.equal(a.w.localStorage.getItem('investor_indicator_view'), 'table');
  assert.equal(toggle.getAttribute('aria-label'), 'Kart görünümüne geç');
  assert.ok(a.d.querySelector('#indPanelBody tr:not(.ind-group) .ind-t-head.ind-up'));
  a.click(toggle);
  assert.equal(a.tiles().length, 9); assert.equal(a.w.localStorage.getItem('investor_indicator_view'), 'cards');
  ok('B (tablo) görünümü: iki bölüm başlığı, doğru kolonlar/değerler; düğmeyle A\'ya geri dönüş; tercih localStorage\'da');
  await a.close();

  a = await boot({ localStorage: { investor_indicator_view: 'table' } });
  assert.ok(a.d.querySelector('#indPanelBody table.ind-table'));
  ok('kayıtlı tercih (tablo) yeniden açılışta uygulanıyor');
  await a.close();

  // =============== 3) düzenleme paneli: CRUD ===============
  a = await boot();
  await a.waitFor(() => a.tiles().every(t => a.tileText(t).head !== '—'), 'değerler');
  a.click(a.d.getElementById('indEditBtn'));
  assert.equal(a.d.getElementById('indicatorEditModal').hidden, false);
  let er = () => [...a.d.querySelectorAll('#indEditBody tr[data-i]')];
  assert.equal(er().length, 9);
  assert.equal(er()[0].querySelector('[data-f="symbol"]').value, '^GSPC');
  assert.equal(er()[6].querySelector('[data-f="prefix"]').value, '%');
  // düzenle: ilk etiketi değiştir, ikinciyi sil, yeni (altın) ekle
  a.type(er()[0].querySelector('[data-f="label"]'), 'SPX');
  a.click(er()[1].querySelector('[data-act="del"]'));
  assert.equal(er().length, 8);
  a.click(a.d.getElementById('indEditAddBtn'));
  assert.equal(er().length, 9);
  const nr = er()[8];
  a.type(nr.querySelector('[data-f="label"]'), 'Altın');
  a.type(nr.querySelector('[data-f="symbol"]'), 'gc=f');
  a.type(nr.querySelector('[data-f="headline_mode"]'), 'value');
  a.type(nr.querySelector('[data-f="decimals"]'), '1');
  a.type(nr.querySelector('[data-f="prefix"]'), '$');
  const before = pricesReqs(a).length;
  a.click(a.d.getElementById('indEditSaveBtn'));
  assert.equal(a.d.getElementById('indicatorEditModal').hidden, true);
  await a.waitFor(() => a.tiles().some(t => a.tileText(t).label === 'Altın' && a.tileText(t).head !== '—'), 'Altın değerinin gelmesi');
  let labels = a.tiles().map(t => a.tileText(t).label);
  assert.ok(labels.includes('SPX') && !labels.includes('S&P 500') && !labels.includes('Nasdaq 100') && labels.includes('Altın'));
  assert.equal(labels.length, 9);
  const gold = a.tileText(a.tiles().find(t => a.tileText(t).label === 'Altın'));
  assert.deepEqual([gold.head, gold.sub], ['$2.050,5', '0,00%']);
  assert.equal(labels.at(-1), 'Altın');                       // yeni "değer-öncelikli" gösterge kendi grubunun sonunda
  const newReq = pricesReqs(a).slice(before);
  assert.equal(newReq.length, 1); assert.deepEqual(newReq[0].body.items.map(i => i.id), ['GC=F']);   // sembol büyük harfe çevrildi, yalnızca yeni sembol çekildi
  ok('düzenleme: etiket değiştirme, silme, ekleme (sembol büyük harfe çevrilir), kaydetme — panel güncellendi ve yalnızca yeni sembol çekildi');

  // doğrulama: boş satır kaydedilemez
  a.click(a.d.getElementById('indEditBtn'));
  a.click(a.d.getElementById('indEditAddBtn'));
  a.click(a.d.getElementById('indEditSaveBtn'));
  assert.equal(a.d.getElementById('indicatorEditModal').hidden, false);
  assert.match(a.d.getElementById('indEditError').textContent, /Satır 10: Etiket ve Yahoo sembolü zorunlu/);
  er().at(-1) && a.click(er().at(-1).querySelector('[data-act="del"]'));
  assert.equal(a.d.getElementById('indEditError').textContent, '');
  ok('doğrulama: etiketi/sembolü boş satır kaydedilmiyor, hata mesajı satır numarasıyla gösteriliyor');

  // pasif yapma
  const vixRow = er().find(r => r.querySelector('[data-f="label"]').value === 'VIX');
  const chk = vixRow.querySelector('[data-f="enabled"]'); chk.checked = false; chk.dispatchEvent(new a.w.Event('change', { bubbles: true }));
  a.click(a.d.getElementById('indEditSaveBtn'));
  assert.ok(!a.tiles().some(t => a.tileText(t).label === 'VIX')); assert.equal(a.tiles().length, 8);
  a.click(a.d.getElementById('indEditBtn'));
  const vix2 = er().find(r => r.querySelector('[data-f="label"]').value === 'VIX');
  assert.equal(vix2.querySelector('[data-f="enabled"]').checked, false);
  ok('pasif gösterge panelde gizleniyor ama düzenleme listesinde duruyor');

  // sıralama (yukarı/aşağı) ve İptal
  const firstLabel = () => er()[0].querySelector('[data-f="label"]').value;
  const l0 = firstLabel(), l1 = er()[1].querySelector('[data-f="label"]').value;
  a.click(er()[0].querySelector('[data-act="down"]'));
  assert.equal(firstLabel(), l1); assert.equal(er()[1].querySelector('[data-f="label"]').value, l0);
  assert.ok(er()[0].querySelector('[data-act="up"]').disabled);
  a.click(er()[0].querySelector('[data-act="del"]'));
  a.click(a.d.querySelector('#indicatorEditModal [data-close]'));       // X ile kapat = iptal
  assert.equal(a.tiles().length, 8);
  a.click(a.d.getElementById('indEditBtn'));
  assert.equal(er().length, 9);
  ok('yukarı/aşağı taşıma çalışıyor; iptal/kapat değişiklikleri DB\'ye yazmıyor');

  // varsayılanlara dön
  a.click(a.d.getElementById('indEditResetBtn'));
  assert.deepEqual(er().map(r => r.querySelector('[data-f="label"]').value), ['S&P 500', 'Nasdaq 100', 'Dow Jones', 'Russell 2000', 'Çip Endeksi (SOX)', 'VIX', 'ABD 10 Yıllık Faiz', 'Dolar Endeksi', 'Ham Petrol (USOIL)']);
  a.click(a.d.getElementById('indEditSaveBtn'));
  assert.equal(a.tiles().length, 9); assert.equal(a.tileText(a.tiles()[0]).label, 'S&P 500');
  ok('"Varsayılanlara Dön" + Kaydet ilk listeyi geri yüklüyor');

  // hepsini sil -> boş durum, istek yok
  a.click(a.d.getElementById('indEditBtn'));
  while (er().length) a.click(er()[0].querySelector('[data-act="del"]'));
  a.click(a.d.getElementById('indEditSaveBtn'));
  assert.ok(a.d.querySelector('#indPanelBody .ind-empty')); assert.equal(a.d.getElementById('indTime').textContent, '—');
  ok('tüm göstergeler silinince boş durum mesajı gösteriliyor');
  await a.close();

  // =============== 4) önbellek / yenileme ===============
  const now = Date.now();
  const fresh = {}; Object.entries(TARGETS).filter(([k]) => k !== 'GC=F').forEach(([k, t]) => { fresh['investor_indicator_v1_' + k] = JSON.stringify({ symbol: k, price: t[0], previousClose: t[0] / (1 + t[1] / 100), asOf: null, timestamp: now }); });
  a = await boot({ localStorage: fresh });
  await sleep(300);
  assert.equal(pricesReqs(a).length, 0);
  assert.equal(a.tileText(a.tiles()[0]).head, '+0,62%');
  ok('TTL içindeki önbellek: açılışta ağ isteği yok, değerler önbellekten gösteriliyor');
  // "Fiyatları Yenile" göstergeleri de zorla yeniler
  await a.waitFor(() => !a.d.getElementById('refreshPricesBtn').disabled || true, 'buton');
  a.click(a.d.getElementById('refreshPricesBtn'));
  await a.waitFor(() => pricesReqs(a).length === 1, 'zorla yenileme isteği');
  assert.equal(pricesReqs(a)[0].body.items.length, 9);
  ok('"Fiyatları Yenile" düğmesi göstergeleri de zorla yeniliyor (TTL\'ye bakmadan)');
  await a.close();

  const old = {}; Object.entries(fresh).forEach(([k, v]) => { old[k] = v.replace(String(now), String(now - 10 * 60 * 1000)); });
  a = await boot({ localStorage: old });
  await a.waitFor(() => pricesReqs(a).length === 1, 'süresi dolan önbelleğin yenilenmesi');
  ok('süresi dolmuş (10 dk) önbellek: açılışta yeniden çekiliyor');
  await a.close();

  // =============== 5) hata modları ===============
  a = await boot({ gateway: '404', localStorage: { 'investor_indicator_v1_^GSPC': JSON.stringify({ symbol: '^GSPC', price: 6500, previousClose: 6400, asOf: null, timestamp: now - 3600e3 }) } });
  await a.waitFor(() => a.logLines().some(l => /\/pricesPost bulunamadı/.test(l)), 'Worker 404 uyarısı');
  const t404 = a.tiles().map(t => a.tileText(t));
  assert.equal(t404[0].head, '+1,56%');                     // eski (1 saatlik) değer hâlâ gösteriliyor
  assert.deepEqual([t404[1].head, t404[1].sub], ['—', 'alınamadı']);
  assert.equal(a.logLines().filter(l => /Gösterge değerleri alınamadı/.test(l)).length, 1);
  ok('Worker güncel değil (404): net uyarı (bir kez), önbellekteki eski değer gösterilmeye devam ediyor, değeri olmayanlar "alınamadı"');
  await a.close();

  a = await boot({ gateway: 'down' });
  await a.waitFor(() => a.logLines().some(l => /Gösterge değerleri alınamadı \(Failed to fetch\)/.test(l)), 'ağ hatası uyarısı');
  assert.deepEqual(a.tiles().map(t => a.tileText(t).head), Array(9).fill('—'));
  ok('ağ hatası: panel çökmüyor, "—" gösteriyor, tek uyarı');
  await a.close();

  // tanınmayan sembol: yalnızca o kart hatalı
  a = await boot();
  await a.waitFor(() => a.tiles().every(t => a.tileText(t).head !== '—'), 'değerler');
  a.click(a.d.getElementById('indEditBtn'));
  a.click(a.d.getElementById('indEditAddBtn'));
  const last = er().at(-1);
  a.type(last.querySelector('[data-f="label"]'), 'Bilinmeyen'); a.type(last.querySelector('[data-f="symbol"]'), 'NOPE123');
  a.click(a.d.getElementById('indEditSaveBtn'));
  await a.waitFor(() => a.tiles().some(t => a.tileText(t).label === 'Bilinmeyen' && a.tileText(t).sub === 'alınamadı'), 'bilinmeyen sembol');
  assert.ok(a.tiles().filter(t => a.tileText(t).label !== 'Bilinmeyen').every(t => a.tileText(t).head !== '—'));
  assert.match(a.tiles().find(t => a.tileText(t).label === 'Bilinmeyen').title, /NOPE123: No data found/);
  ok('tanınmayan sembol: yalnızca o kart "alınamadı" (tooltip\'te sebep), diğerleri etkilenmiyor');
  await a.close();

  // =============== 6) eski veritabanı dosyaları (migrasyon) ===============
  const SQLJS = await initSqlJs();
  const schemaSql = [...HTML.matchAll(/sql: `(CREATE TABLE (\w+)[\s\S]*?\);)` \}/g)].filter(m => m[2] !== 'market_indicators').map(m => m[1]);
  assert.equal(schemaSql.length, 7);
  async function importBytes(a, bytes) {
    const input = a.d.getElementById('dbImportInput');
    const fakeFile = { name: 'eski.sqlite', arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    Object.defineProperty(input, 'files', { value: [fakeFile], configurable: true });
    input.dispatchEvent(new a.w.Event('change'));
  }
  // 6a) market_indicators tablosu OLMAYAN eski dosya -> oluşturulur + varsayılanlarla doldurulur
  const oldDb = new SQLJS.Database(); schemaSql.forEach(s => oldDb.run(s));
  a = await boot({ gateway: 'down' });
  a.click(a.d.getElementById('indEditBtn')); a.click(a.d.getElementById('indEditResetBtn'));       // mevcut listeyi değiştir (test için)
  a.d.getElementById('indEditBody').querySelectorAll('[data-act="del"]').forEach(() => {});
  a.click(a.d.querySelector('#indicatorEditModal [data-close]'));
  await importBytes(a, oldDb.export());
  await a.waitFor(() => a.logLines().some(l => /market_indicators tablosu eklendi ve varsayılan göstergeler yüklendi/.test(l)), 'migrasyon günlüğü');
  assert.equal(a.tiles().length, 9);
  ok('eski dosya (market_indicators yok): açılışta tablo oluşturuldu, 9 varsayılan gösterge yüklendi, günlüğe yazıldı');
  // 6b) tablo VAR ama bilerek boşaltılmış -> yeniden doldurulmaz
  const emptyDb = new SQLJS.Database(); schemaSql.forEach(s => emptyDb.run(s));
  const miSql = HTML.match(/sql: `(CREATE TABLE market_indicators[\s\S]*?\);)` \}/)[1]; emptyDb.run(miSql);
  await importBytes(a, emptyDb.export());
  await a.waitFor(() => a.d.querySelector('#indPanelBody .ind-empty'), 'boş tablonun korunması');
  ok('kullanıcı göstergeleri bilerek sildiyse (tablo var, boş): dosya açılınca varsayılanlar GERİ GELMİYOR');
  // 6c) özel gösterge içeren dosya olduğu gibi korunur
  const customDb = new SQLJS.Database(); schemaSql.forEach(s => customDb.run(s)); customDb.run(miSql);
  customDb.run(`INSERT INTO market_indicators (label, symbol, headline_mode, decimals, prefix, suffix, sort_order, enabled) VALUES ('Altın', 'GC=F', 'value', 1, '$', '', 1, 1), ('Gümüş', 'SI=F', 'change', 2, '', '', 2, 1)`);
  await importBytes(a, customDb.export());
  await a.waitFor(() => a.tiles().length === 2, 'özel liste');
  assert.deepEqual(a.tiles().map(t => a.tileText(t).label), ['Gümüş', 'Altın']);   // gruplama: önce "değişim" modu
  ok('özel göstergeli dosya aynen korunuyor (gruplama: önce manşette % gösterilenler)');
  await a.close();

  // =============== 7) şema sıfırlama varsayılana döner ===============
  a = await boot({ gateway: 'down' });
  a.w.confirm = () => true;
  a.click(a.d.getElementById('indEditBtn'));
  [...a.d.querySelectorAll('#indEditBody tr[data-i]')].forEach(() => a.click(a.d.querySelector('#indEditBody [data-act="del"]')));
  a.click(a.d.getElementById('indEditSaveBtn'));
  assert.ok(a.d.querySelector('#indPanelBody .ind-empty'));
  await a.waitFor(() => !a.d.getElementById('btnReset').disabled, 'debug düğmesi');
  a.click(a.d.getElementById('btnReset'));
  await a.waitFor(() => a.tiles().length === 9, 'şema sıfırlama sonrası varsayılan liste');
  ok('Debug "Şemayı sıfırla" gösterge listesini varsayılana döndürüyor');
  await a.close();


  // =============== 8) v0.14 portföy fiyat akışı bozulmadı (regresyon) ===============
  {
    const db = new SQLJS.Database(); schemaSql.forEach(s => db.run(s)); db.run(miSql);
    db.run(`INSERT INTO asset_master (ticker, company_name, asset_type, currency) VALUES ('AFT', NULL, 'Türk TEFAS Fonları', 'TRY'), ('AMZN', NULL, 'Amerikan Hisse Senetleri', 'USD')`);
    db.run(`INSERT INTO investment_transactions (execution_datetime, order_type, ticker, transaction_type, status, quantity, execution_price, commission, currency, hidden) VALUES
      ('20/10/26 11:00:00', 'Piyasa', 'AFT', 'Alış', 'Gerçekleşti', 1000, 1.0, 0, 'TRY', 0),
      ('20/10/26 11:05:00', 'Piyasa', 'AMZN', 'Alış', 'Gerçekleşti', 10, 250, 1, 'USD', 0)`);
    a = await boot();
    await importBytes(a, db.export());
    await a.waitFor(() => pricesReqs(a).some(r => r.body.items.some(i => i.id === 'AFT')), 'portföy fiyat isteği');
    const portReq = pricesReqs(a).find(r => r.body.items.some(i => i.id === 'AFT'));
    assert.deepEqual(portReq.body.items.map(i => i.id).sort(), ['AFT', 'AMZN']);
    assert.equal(portReq.body.items.find(i => i.id === 'AFT').assetType, 'Türk TEFAS Fonları');
    await a.waitFor(() => [...a.d.querySelectorAll('#portfolioDetailTable tbody tr')].some(r => /AFT/.test(r.textContent) && r.querySelector('.price-src-dot.eod')), 'TEFAS satırında eod noktası');
    const rowOf = t => [...a.d.querySelectorAll('#portfolioDetailTable tbody tr')].find(r => r.textContent.includes(t) && r.querySelector('.price-src-dot'));
    const aftRow = rowOf('AFT'), amznRow = rowOf('AMZN');
    assert.match(aftRow.querySelector('.price-src-dot').title, /TEFAS kapanış fiyatı — 02\.11\.2026/);
    assert.ok(aftRow.querySelector('.price-src-dot.eod') && amznRow.querySelector('.price-src-dot.live'));
    assert.match(aftRow.textContent, /\+1,78%/);       // "Bugün": (1,056083-1,037657)/1,037657
    assert.match(amznRow.textContent, /\+0,81%/);
    ok('portföy akışı (v0.14): TEFAS fonu gateway\'e "Türk TEFAS Fonları" tipiyle gidiyor, mavi "eod" noktası + NAV tarihi tooltip\'i, "Bugün" % hem TEFAS hem Yahoo satırında; göstergelerle aynı yenilemede çalışıyor');
    await a.close();
  }

  console.log('\nTÜM E2E TESTLERİ GEÇTİ');
  process.exit(0);
})().catch(e => { console.error('\nTEST HATASI:', e.stack || e); process.exit(1); });

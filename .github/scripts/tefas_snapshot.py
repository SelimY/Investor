#!/usr/bin/env python3
"""TEFAS snapshot — tüm YAT fonlarının son fiyatını ve bir önceki fiyatını tefas_prices.json'a yazar.

Mantık
- Bugünden (İstanbul saati) geriye giderek, TEFAS'ın boş OLMAYAN sonuç döndürdüğü en yeni günleri bulur.
  Hafta sonu / resmî tatil / henüz yayınlanmamış gün => boş sonuç => atlanır.
- Ağ / Akamai hatası boş sonuç DEĞİLDİR: tefasmak istisna fırlatır, script hata ile çıkar ve eski
  snapshot yerinde kalır (tatil ile engellenmeyi karıştırmayız).
- Her fon için: fiyat = fonu içeren EN YENİ günün fiyatı; önceki fiyat = bir sonraki eski günün fiyatı.
  Böylece kısmi yayın (bazı fonlar bugünün fiyatını henüz yayınlamamış) sorun olmaz; tarih fon bazlıdır.
- Sağlık kontrolü: fon sayısı MIN_FUNDS altındaysa yayınlanmaz.
"""
import json
import os
import sys
from datetime import date, datetime, timedelta, timezone

try:
    from zoneinfo import ZoneInfo
    TRT = ZoneInfo("Europe/Istanbul")
except Exception:  # tzdata yoksa sabit UTC+3
    TRT = timezone(timedelta(hours=3))

FUND_TYPE = os.environ.get("TEFAS_FUND_TYPE", "YAT")
MIN_FUNDS = int(os.environ.get("TEFAS_MIN_FUNDS", "1500"))
OUT = os.environ.get("TEFAS_OUT", "tefas_prices.json")
MAX_LOOKBACK_DAYS = 10
PARTIAL_THRESHOLD = 0.95  # en yeni gün, bir öncekinin %95'inden azsa 3. gün de çekilir


def log(*args):
    print(*args, flush=True)


def collect_datasets(fetch, today, want=2):
    """today'den geriye giderek boş olmayan en yeni `want` günü döndürür: [(iso_tarih, {kod: satır})], yeniden eskiye."""
    datasets = []
    d = today
    for _ in range(MAX_LOOKBACK_DAYS):
        if len(datasets) >= want:
            break
        if d.weekday() < 5:
            rows = fetch(d.strftime("%Y%m%d"))
            if rows:
                datasets.append((d.isoformat(), rows))
                log(f"{d.isoformat()}: {len(rows)} fon")
            else:
                log(f"{d.isoformat()}: veri yok (tatil ya da henüz yayınlanmadı)")
        d -= timedelta(days=1)
    return datasets


def build_snapshot(datasets, version):
    codes = set()
    for _, rows in datasets:
        codes.update(rows.keys())
    funds = {}
    for code in codes:
        series = []
        for iso, rows in datasets:
            r = rows.get(code)
            if not r:
                continue
            try:
                price = float(r.get("fiyat"))
            except (TypeError, ValueError):
                continue
            if price > 0:
                series.append((str(r.get("tarih") or iso)[:10], price, r))
        if not series:
            continue
        d0, p0, r0 = series[0]
        entry = {"price": p0, "date": d0, "name": r0.get("fonUnvan")}
        if len(series) > 1:
            entry["prevPrice"] = series[1][1]
            entry["prevDate"] = series[1][0]
        funds[code] = entry
    return {
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": f"tefasmak {version}",
        "fundType": FUND_TYPE,
        "asOfDates": [iso for iso, _ in datasets],
        "count": len(funds),
        "funds": funds,
    }


def run(fetch, version="?", today=None):
    today = today or datetime.now(TRT).date()
    datasets = collect_datasets(fetch, today, want=2)
    if not datasets:
        raise SystemExit("Hiç gün için veri bulunamadı — yayınlanmıyor.")
    if len(datasets) >= 2 and len(datasets[0][1]) < PARTIAL_THRESHOLD * len(datasets[1][1]):
        log("En yeni gün kısmi görünüyor — bir gün daha geriye gidiliyor.")
        more = collect_datasets(fetch, date.fromisoformat(datasets[-1][0]) - timedelta(days=1), want=1)
        datasets.extend(more)
    snap = build_snapshot(datasets, version)
    if snap["count"] < MIN_FUNDS:
        raise SystemExit(f"Sağlık kontrolü başarısız: {snap['count']} fon < {MIN_FUNDS} — yayınlanmıyor.")
    return snap


def main():
    import tefasmak

    def fetch(yyyymmdd):
        return tefasmak.fonlar_son_fiyat_bulk(FUND_TYPE, tarih=yyyymmdd)

    version = getattr(tefasmak, "__version__", "?")
    snap = run(fetch, version)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(snap, f, ensure_ascii=False, separators=(",", ":"))
    size_kb = os.path.getsize(OUT) / 1024
    with_prev = sum(1 for v in snap["funds"].values() if "prevPrice" in v)
    latest = snap["asOfDates"][0]
    on_latest = sum(1 for v in snap["funds"].values() if v["date"] == latest)
    summary = (f"TEFAS snapshot: {snap['count']} fon, en yeni tarih {latest} ({on_latest} fon), "
               f"önceki fiyatı olan {with_prev}, {size_kb:.0f} KB")
    log(summary)
    step_summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if step_summary:
        with open(step_summary, "a", encoding="utf-8") as f:
            f.write(f"### {summary}\n")


if __name__ == "__main__":
    main()

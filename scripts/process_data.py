#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把漁產品交易行情原始資料整理成 docs/data/ 底下網站要用的乾淨檔案：

  docs/data/species.json   魚種主檔（品種代碼、名稱；同名不同代碼分開列，見 data_notes.md 的決策）
  docs/data/markets.json   市場主檔（市場名稱、累積筆數、首/末出現日）
  docs/data/history.json   完整交易紀錄（英文欄位key，含西元/民國日期）
  docs/data/latest.json    最新一個交易日的完整快照
  docs/data/meta.json      資料範圍、更新時間等中繼資訊
  docs/data/fish_calendar.json / taiwan_regional_species_reference.json
      （直接從 data/ 複製過去，讓 docs/ 是可以整包部署的獨立資料夾）

資料來源優先序（後者覆蓋前者，同一 date+speciesCode+market 若重複出現以後者為準）：
  1. 既有的 docs/data/history.json（如果存在，代表之前已經處理過的累積資料）
  2. data/raw/*.json（手動或種子抓取的原始資料，長期保留在repo）
  3. --extra 參數指定的檔案（例如GitHub Actions當次新抓的資料，通常不進repo）

用法：
    python scripts/process_data.py
    python scripts/process_data.py --extra /tmp/incoming.json
"""
import argparse
import json
import shutil
from pathlib import Path
from datetime import date, datetime, timezone

ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / "data" / "raw"
DATA_DIR = ROOT / "data"
DOCS_DATA_DIR = ROOT / "docs" / "data"


def roc_to_iso(roc: str) -> str:
    y, m, d = int(roc[:3]) + 1911, int(roc[3:5]), int(roc[5:7])
    return date(y, m, d).isoformat()


def unify_raw_row(r: dict) -> dict:
    """原始中文欄位格式 -> 網站要用的英文欄位格式"""
    return {
        "date": roc_to_iso(r["交易日期"]),
        "dateRoc": r["交易日期"],
        "speciesCode": r["品種代碼"],
        "speciesName": r["魚貨名稱"],
        "market": r["市場名稱"],
        "priceHigh": r["上價"],
        "priceMid": r["中價"],
        "priceLow": r["下價"],
        "volume": r["交易量"],
        "avgPrice": r["平均價"],
    }


def key_of(r: dict):
    return (r["date"], r["speciesCode"], r["market"])


def load_raw_file(path: Path, merged: dict):
    payload = json.loads(path.read_text(encoding="utf-8"))
    rows = payload.get("data", payload if isinstance(payload, list) else [])
    for r in rows:
        u = unify_raw_row(r)
        merged[key_of(u)] = u


def main():
    ap = argparse.ArgumentParser(description="整理漁產品交易行情資料給網站使用")
    ap.add_argument("--extra", nargs="*", default=[], help="額外的原始JSON檔路徑（中文欄位格式），例如當次新抓的資料")
    ap.add_argument("--raw-dir", default=str(RAW_DIR))
    ap.add_argument("--docs-dir", default=str(DOCS_DATA_DIR))
    args = ap.parse_args()

    raw_dir = Path(args.raw_dir)
    docs_dir = Path(args.docs_dir)
    docs_dir.mkdir(parents=True, exist_ok=True)

    merged = {}

    # 1. 既有的累積資料
    existing_history = docs_dir / "history.json"
    if existing_history.exists():
        for r in json.loads(existing_history.read_text(encoding="utf-8")):
            merged[key_of(r)] = r

    # 2. data/raw/*.json 種子檔
    files_used = []
    for f in sorted(raw_dir.glob("*.json")):
        load_raw_file(f, merged)
        files_used.append(str(f.relative_to(ROOT)))

    # 3. --extra 額外檔案（例如當次新抓的資料，優先度最高）
    for extra_path in args.extra:
        p = Path(extra_path)
        if p.exists():
            load_raw_file(p, merged)
            files_used.append(str(p))
        else:
            print(f"警告：找不到 --extra 指定的檔案 {p}，略過")

    if not merged:
        raise SystemExit("沒有任何資料可以處理，請確認 data/raw/ 或 --extra 是否有效")

    history = sorted(merged.values(), key=lambda x: (x["date"], x["speciesCode"], x["market"]))

    # ---- species.json ----
    species_map = {r["speciesCode"]: r["speciesName"] for r in history}
    species = [{"code": c, "name": n} for c, n in sorted(species_map.items())]

    # ---- markets.json ----
    market_stats = {}
    for r in history:
        s = market_stats.setdefault(r["market"], {"count": 0, "firstDate": r["date"], "lastDate": r["date"]})
        s["count"] += 1
        s["firstDate"] = min(s["firstDate"], r["date"])
        s["lastDate"] = max(s["lastDate"], r["date"])
    markets = [{"name": m, **stats} for m, stats in sorted(market_stats.items(), key=lambda x: -x[1]["count"])]

    # ---- latest.json ----
    latest_date = max(r["date"] for r in history)
    latest_rows = [r for r in history if r["date"] == latest_date]

    # ---- meta.json ----
    all_dates = sorted(set(r["date"] for r in history))
    meta = {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "sourceFiles": files_used,
        "recordCount": len(history),
        "dateRange": {"start": all_dates[0], "end": all_dates[-1]},
        "datesWithData": all_dates,
        "latestDate": latest_date,
        "speciesCount": len(species),
        "marketCount": len(markets),
        "note": "資料來源：農業部漁業署漁產品交易行情OpenData。該網站對自動化請求有防護機制，"
                "本專案以GitHub Actions排程抓取，若排程連續失敗會保留舊資料，"
                "請留意 generatedAt 與 latestDate 是否持續更新。",
    }

    (docs_dir / "history.json").write_text(json.dumps(history, ensure_ascii=False, indent=2), encoding="utf-8")
    (docs_dir / "species.json").write_text(json.dumps(species, ensure_ascii=False, indent=2), encoding="utf-8")
    (docs_dir / "markets.json").write_text(json.dumps(markets, ensure_ascii=False, indent=2), encoding="utf-8")
    (docs_dir / "latest.json").write_text(json.dumps({"date": latest_date, "records": latest_rows}, ensure_ascii=False, indent=2), encoding="utf-8")
    (docs_dir / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

    for fname in ("fish_calendar.json", "taiwan_regional_species_reference.json"):
        src = DATA_DIR / fname
        if src.exists():
            shutil.copy(src, docs_dir / fname)

    print(f"處理完成：{len(history)} 筆紀錄，{len(species)} 個魚種代碼，{len(markets)} 個市場")
    print(f"資料涵蓋日期：{all_dates[0]} ~ {all_dates[-1]}（{len(all_dates)} 天有資料）")
    print(f"輸出到：{docs_dir}")


if __name__ == "__main__":
    main()

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

# ---- 消費地市場 vs 產地市場 ----
# 依據漁業署 efish.fa.gov.tw「漁產品批發市場交易行情站」公開列出的13個消費地魚市場名單，
# 其餘（漁港、批發市場）視為產地市場。見 data_notes.md 說明。
CONSUMER_MARKETS = {
    "台北", "三重", "新竹", "桃園", "苗栗", "台中", "彰化",
    "埔心", "嘉義", "斗南", "佳里", "新營", "高雄",
}


def market_type(market_name: str) -> str:
    return "消費地" if market_name in CONSUMER_MARKETS else "產地"


# ---- 漲跌幅可信度警示 ----
# 「平均價」是政府資料本身算好的當日均價，會受到貨規格/等級組成影響（例如同一魚種
# 某天進的是大尾高價貨、某天進的是小尾雜貨，平均價可以差好幾倍，但不是「行情崩盤」）。
# 這裡不試圖去猜測/修正原始資料，只加兩個保守的警示欄位，讓前端能提示使用者、
# 並避免把這種資料雜訊誤標成「急售」：
#   volatileNote：漲跌幅超過門檻，可能是規格組成差異造成，非同批貨真實漲跌
#   lowVolume：當日交易量過低，數字容易失真，不適合當成「急售」訊號
EXTREME_CHANGE_PCT = 40.0
MIN_VOLUME_KG = 10.0


def load_seafood_guide():
    path = DATA_DIR / "seafood_guide_reference.json"
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


# 沒有養/海字尾標記、也不在1xxx代碼區間，但依《臺灣海鮮選擇指南》或養殖漁業常識
# 可確定主要是養殖供應的品項（例如白蝦在4xxx蝦類區間裡沒有字尾標記，但guide明確寫「養殖白蝦」）。
FARMED_NAME_OVERRIDES = {"白蝦", "鮑魚"}


def classify_farmed(code: int, name: str):
    """判斷是否為養殖：優先看名稱裡的養/海「字尾標記」（資料源本身的命名慣例，
    例如「文蛤(海)」vs「文蛤養」），注意「養」「海」必須是字尾標記才算數，
    避免誤判像「海鱺」「海鰻」這種「海」只是名稱一部分、不是野生標記的魚種。
    其次看代碼區間（1000-1999整段是養殖魚類分類，見 species.json 最後一碼1999「其他養殖」）。
    傳回 True/False/None（None代表無足夠依據判斷，例如加工品6xxx）。"""
    stripped = name.rstrip(")）")
    if stripped.endswith("養"):
        return True
    if stripped.endswith("海"):
        return False
    if stripped in FARMED_NAME_OVERRIDES:
        return True
    if 1000 <= code <= 1999:
        return True
    if 2000 <= code <= 3999:
        return False
    if 6000 <= code <= 6999 or code == 9999:
        return None
    return None


def classify_sustainability(name: str, guide: dict):
    """粗略關鍵字比對「台灣海鮮選擇指南」，傳回 green/yellow/red/None。
    比對優先序 red > yellow > green，避免因為別名重疊而高估安全等級（見指南備註）。"""
    if not guide:
        return None
    for level in ("red", "yellow", "green"):
        for keyword in guide.get(level, []):
            if keyword and keyword in name:
                return level
    return None


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

    # ---- 消費地/產地市場分類 + 養殖/永續分類（依species.json,粗略關鍵字比對，見data_notes.md）----
    guide = load_seafood_guide()
    farmed_cache = {}
    sustain_cache = {}
    for r in history:
        r["marketType"] = market_type(r["market"])
        code = r["speciesCode"]
        name = r["speciesName"]
        if code not in farmed_cache:
            farmed_cache[code] = classify_farmed(code, name)
        if code not in sustain_cache:
            sustain_cache[code] = classify_sustainability(name, guide)
        r["farmed"] = farmed_cache[code]
        r["sustainability"] = sustain_cache[code]

    # ---- 漲跌幅：跟「同一魚種代碼＋同一市場」前一個有交易紀錄的日期比較 ----
    # （不是單純昨天，因為休市/個別市場不是每天都有申報，見 data_notes.md）
    by_group = {}
    for r in history:
        by_group.setdefault((r["speciesCode"], r["market"]), []).append(r)
    for group_rows in by_group.values():
        group_rows.sort(key=lambda x: x["date"])
        prev = None
        for r in group_rows:
            r["lowVolume"] = (r.get("volume") or 0) < MIN_VOLUME_KG
            if prev is not None and prev["avgPrice"]:
                change_abs = round(r["avgPrice"] - prev["avgPrice"], 2)
                change_pct = round(change_abs / prev["avgPrice"] * 100, 2)
                r["prevDate"] = prev["date"]
                r["prevAvgPrice"] = prev["avgPrice"]
                r["changeAbs"] = change_abs
                r["changePct"] = change_pct
                r["direction"] = "up" if change_abs > 0 else ("down" if change_abs < 0 else "flat")
                r["volatileNote"] = abs(change_pct) >= EXTREME_CHANGE_PCT
            else:
                r["prevDate"] = None
                r["prevAvgPrice"] = None
                r["changeAbs"] = None
                r["changePct"] = None
                r["direction"] = "new"
                r["volatileNote"] = False
            prev = r

    # ---- species.json ----
    species_map = {r["speciesCode"]: r["speciesName"] for r in history}
    species = [
        {
            "code": c,
            "name": n,
            "farmed": farmed_cache.get(c),
            "sustainability": sustain_cache.get(c),
        }
        for c, n in sorted(species_map.items())
    ]

    # ---- markets.json ----
    market_stats = {}
    for r in history:
        s = market_stats.setdefault(r["market"], {"count": 0, "firstDate": r["date"], "lastDate": r["date"]})
        s["count"] += 1
        s["firstDate"] = min(s["firstDate"], r["date"])
        s["lastDate"] = max(s["lastDate"], r["date"])
    markets = [{"name": m, **stats} for m, stats in sorted(market_stats.items(), key=lambda x: -x[1]["count"])]

    # ---- latest.json：依跌幅排序，跌最多（最需要出清）排最前面，沒有比較基準的排最後 ----
    latest_date = max(r["date"] for r in history)
    latest_rows = [r for r in history if r["date"] == latest_date]
    latest_rows.sort(key=lambda r: r["changePct"] if r["changePct"] is not None else 999999)

    # 「急售」標記只給前3筆「排除規格價差過大／交易量過低」的可信下跌紀錄，
    # 避免把資料雜訊誤標成真的急售出清（見 EXTREME_CHANGE_PCT / MIN_VOLUME_KG 說明）
    urgent_count = 0
    for r in latest_rows:
        is_eligible = (
            r["direction"] == "down"
            and not r.get("volatileNote")
            and not r.get("lowVolume")
        )
        if is_eligible and urgent_count < 3:
            r["isUrgent"] = True
            urgent_count += 1
        else:
            r["isUrgent"] = False

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
        "marketTypeNote": "市場分為「消費地」（依efish.fa.gov.tw公開的13個消費地魚市場名單）與「產地」（其餘漁港/批發市場）。",
        "farmedSustainabilityNote": "養殖(farmed)欄位優先依資料本身命名的養/海標記判斷，其次依代碼區間（1000-1999為養殖魚類分類）；"
                "永續(sustainability)欄位為與《臺灣海鮮選擇指南 2023.10》粗略關鍵字比對結果（green建議食用/yellow斟酌食用/red避免食用），"
                "非逐魚種官方認證，僅供參考，詳見 data/seafood_guide_reference.json。",
    }

    (docs_dir / "history.json").write_text(json.dumps(history, ensure_ascii=False, indent=2), encoding="utf-8")
    (docs_dir / "species.json").write_text(json.dumps(species, ensure_ascii=False, indent=2), encoding="utf-8")
    (docs_dir / "markets.json").write_text(json.dumps(markets, ensure_ascii=False, indent=2), encoding="utf-8")
    (docs_dir / "latest.json").write_text(json.dumps({"date": latest_date, "records": latest_rows}, ensure_ascii=False, indent=2), encoding="utf-8")
    (docs_dir / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

    for fname in ("fish_calendar.json", "taiwan_regional_species_reference.json", "seafood_guide_reference.json"):
        src = DATA_DIR / fname
        if src.exists():
            shutil.copy(src, docs_dir / fname)

    print(f"處理完成：{len(history)} 筆紀錄，{len(species)} 個魚種代碼，{len(markets)} 個市場")
    print(f"資料涵蓋日期：{all_dates[0]} ~ {all_dates[-1]}（{len(all_dates)} 天有資料）")
    print(f"輸出到：{docs_dir}")


if __name__ == "__main__":
    main()

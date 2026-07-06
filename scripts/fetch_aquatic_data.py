#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
農業部漁業署「漁產品交易行情」OpenData 抓取腳本
資料集：https://data.moa.gov.tw/open_detail.aspx?id=039
API：   https://data.moa.gov.tw/Service/OpenData/FromM/AquaticTransData.aspx

用法範例：
    # 抓最近 7 天（西元日期）
    python fetch_aquatic_data.py --start 2026-06-29 --end 2026-07-05 -o raw/aquatic_20260629_20260705.json

    # 指定魚種代碼 TypeNo，並自訂每頁筆數
    python fetch_aquatic_data.py --start 2026-01-01 --end 2026-01-31 --type-no 100101 --top 500 -o raw/jan.json

注意事項（截至本腳本撰寫時尚未能實際連線驗證，執行前請先小量測試）：
  1. API 的 StartDate / EndDate 需要民國年 (ROC) 格式 "YYYMMDD"（例如 2026-07-01 -> 1150701），
     本腳本會自動把 --start/--end 的西元日期換算成這個格式。
  2. $top / $skip 為 OData 風格分頁參數，本腳本會自動遞增 $skip 直到某頁回傳筆數 < $top 為止。
  3. 若貴機器所在網路環境會被此網域的防護機制擋下（本次開發環境測試時，
     data.moa.gov.tw 對來自本工具鏈網路的請求一律回傳空內容、無錯誤訊息），
     請先用瀏覽器手動打開下列網址確認可以看到 JSON，再執行本腳本：
     https://data.moa.gov.tw/Service/OpenData/FromM/AquaticTransData.aspx?%24top=5&%24skip=0
"""
import argparse
import json
import sys
import time
import urllib.request
import urllib.error
from datetime import date, datetime, timedelta

BASE_URL = "https://data.moa.gov.tw/Service/OpenData/FromM/AquaticTransData.aspx"
MAX_TOP_ALLOWED = 10000  # 實測發現：$top 超過10000會回傳 [{"errMsg": "您所要求的資料量已超過10000筆，請確認您是否正確設定top參數，謝謝。"}]
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json,text/plain,*/*",
}


def ad_to_roc(d: date) -> str:
    """西元日期 -> 民國年緊湊格式 YYYMMDD，例如 2026-07-01 -> '1150701'"""
    roc_year = d.year - 1911
    return f"{roc_year}{d.month:02d}{d.day:02d}"


def roc_to_ad(roc_str: str) -> date:
    """民國年緊湊格式 YYYMMDD -> 西元 date；也相容 YYY/MM/DD、YYY.MM.DD 等含分隔符格式"""
    digits = "".join(ch for ch in roc_str if ch.isdigit())
    if len(digits) == 7:
        roc_year, month, day = int(digits[:3]), int(digits[3:5]), int(digits[5:7])
    elif len(digits) == 6:
        roc_year, month, day = int(digits[:2]), int(digits[2:4]), int(digits[4:6])
    else:
        raise ValueError(f"無法解析的民國日期字串: {roc_str!r}")
    return date(roc_year + 1911, month, day)


def build_url(top: int, skip: int, start_roc: str, end_roc: str, type_no: str | None) -> str:
    params = [f"%24top={top}", f"%24skip={skip}", f"StartDate={start_roc}", f"EndDate={end_roc}"]
    if type_no:
        params.append(f"TypeNo={type_no}")
    return f"{BASE_URL}?{'&'.join(params)}"


def fetch_page(url: str, timeout: int = 30, retries: int = 3):
    last_err = None
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read().decode("utf-8-sig")
                if not raw.strip():
                    raise ValueError("回應內容為空（可能被目標網站的防護機制擋下）")
                return json.loads(raw)
        except (urllib.error.URLError, urllib.error.HTTPError, ValueError, json.JSONDecodeError) as e:
            last_err = e
            print(f"  第 {attempt} 次嘗試失敗：{e}", file=sys.stderr)
            time.sleep(1.5 * attempt)
    raise RuntimeError(f"抓取失敗，已重試 {retries} 次：{url}\n最後錯誤：{last_err}")


def fetch_range(start: date, end: date, top: int = 1000, type_no: str | None = None, sleep_sec: float = 0.5):
    """抓取 [start, end]（西元日期，含頭尾）區間的全部資料，自動分頁。回傳 list[dict]。"""
    start_roc = ad_to_roc(start)
    end_roc = ad_to_roc(end)
    all_rows = []
    skip = 0
    while True:
        url = build_url(top, skip, start_roc, end_roc, type_no)
        print(f"[fetch] skip={skip} top={top} -> {url}")
        page = fetch_page(url)
        rows = page if isinstance(page, list) else page.get("data", page)
        if rows and isinstance(rows, list) and isinstance(rows[0], dict) and "errMsg" in rows[0] and len(rows[0]) == 1:
            raise RuntimeError(f"API回傳錯誤訊息：{rows[0]['errMsg']}（目前top={top}，上限是{MAX_TOP_ALLOWED}）")
        if not rows:
            break
        all_rows.extend(rows)
        if len(rows) < top:
            break
        skip += top
        time.sleep(sleep_sec)
    return all_rows


def daterange_last_n_days(n: int = 7, end: date | None = None):
    end = end or date.today()
    start = end - timedelta(days=n - 1)
    return start, end


def main():
    ap = argparse.ArgumentParser(description="抓取農業部漁產品交易行情 OpenData")
    ap.add_argument("--start", help="西元開始日期 YYYY-MM-DD（預設：最近7天的起日）")
    ap.add_argument("--end", help="西元結束日期 YYYY-MM-DD（預設：今天）")
    ap.add_argument("--days", type=int, default=7, help="當未指定 --start 時，抓最近幾天，預設7")
    ap.add_argument("--type-no", default=None, help="魚種代碼 TypeNo（選填，留空則抓全部魚種）")
    ap.add_argument("--top", type=int, default=5000, help=f"每頁筆數（$top），預設5000，上限{MAX_TOP_ALLOWED}")
    ap.add_argument("-o", "--output", required=True, help="輸出的raw JSON檔路徑")
    args = ap.parse_args()

    if args.top > MAX_TOP_ALLOWED:
        print(f"--top={args.top} 超過API上限{MAX_TOP_ALLOWED}，自動改為{MAX_TOP_ALLOWED}", file=sys.stderr)
        args.top = MAX_TOP_ALLOWED

    if args.end:
        end = datetime.strptime(args.end, "%Y-%m-%d").date()
    else:
        end = date.today()
    if args.start:
        start = datetime.strptime(args.start, "%Y-%m-%d").date()
    else:
        start, end = daterange_last_n_days(args.days, end)

    print(f"抓取區間（西元）: {start} ~ {end}")
    print(f"抓取區間（民國）: {ad_to_roc(start)} ~ {ad_to_roc(end)}")

    rows = fetch_range(start, end, top=args.top, type_no=args.type_no)

    output = {
        "meta": {
            "source_url": BASE_URL,
            "start_date_ad": start.isoformat(),
            "end_date_ad": end.isoformat(),
            "start_date_roc": ad_to_roc(start),
            "end_date_roc": ad_to_roc(end),
            "type_no": args.type_no,
            "fetched_at": datetime.now().isoformat(timespec="seconds"),
            "row_count": len(rows),
        },
        "data": rows,
    }

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f"完成，共 {len(rows)} 筆，已寫入 {args.output}")


if __name__ == "__main__":
    main()

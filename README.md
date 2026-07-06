# 台灣海鮮儀表板

以農業部漁業署「漁產品交易行情」OpenData 與《年年有魚》漁業月曆為資料來源的靜態網站，部署在 GitHub Pages。

線上網址（部署後）：`https://<你的帳號>.github.io/<repo名稱>/`

## 專案結構

```
data/                        資料處理的「後台」，不對外部署
  raw/                       原始交易資料（種子/歷史存檔，長期保留）
  fish_calendar.json         漁業月曆整理結果（12個月）
  taiwan_regional_species_reference.json  月曆封底地圖的區域魚種參考
docs/                        實際部署到 GitHub Pages 的靜態網站
  index.html                 首頁：統計總覽、本月推薦魚種、最新交易快照
  prices.html                魚價查詢：篩選 + 趨勢圖
  calendar.html              漁業月曆：12個月卡片
  assets/css/style.css
  assets/js/common.js        共用的資料讀取工具
  assets/js/prices.js
  data/                      給網站前端讀取的乾淨資料（由 process_data.py 產生，勿手動編輯）
scripts/
  fetch_aquatic_data.py      向 data.moa.gov.tw 抓資料的腳本
  process_data.py            把 data/raw/*.json 整理成 docs/data/*.json
.github/workflows/update-data.yml   排程自動更新資料
data_notes.md                 第一階段資料驗證筆記
```

## 部署到 GitHub Pages

1. 把整個資料夾推上 GitHub repo。
2. Repo 設定 → Pages → Source 選擇 `Deploy from a branch`，Branch 選 `main`（或你的預設分支）、資料夾選 `/docs`。
3. 存檔後幾分鐘網站就會上線。

## 資料自動更新（GitHub Actions）

`.github/workflows/update-data.yml` 預設每天台北時間 07:10 執行一次：

1. 用 `scripts/fetch_aquatic_data.py` 抓最近5天的資料（`--days 5`，比抓當天多留緩衝，避免因為休市或申報延遲漏資料）。
2. 用 `scripts/process_data.py --extra <剛抓到的檔案>` 把新資料併入 `docs/data/history.json`，同步重算 `species.json`、`markets.json`、`latest.json`、`meta.json`。
3. 如果 `docs/data/` 有變更就自動 commit + push，GitHub Pages 會自動重新部署。

也可以在 GitHub 網頁的 Actions 頁籤手動觸發（`workflow_dispatch`），並自訂要抓幾天。

### ⚠️ 已知風險：來源網站會擋自動化請求

開發這個專案的過程中發現 `data.moa.gov.tw` 對非瀏覽器的自動化請求（包含本地開發環境的 fetch 工具）一律回傳空白，判斷是防護機制擋下。**目前不確定 GitHub Actions 的伺服器 IP 是否也會被擋**，這點在把 workflow 實際跑起來、看第一次執行結果之前無法保證。

如果 Actions 執行失敗（在 Actions 頁籤會看到 `⚠️ 抓取失敗` 的警告訊息，且 `docs/data` 不會被覆蓋，網站會繼續顯示舊資料，不會壞掉）：

- 檢查 Actions 的執行紀錄，看錯誤訊息是連線被擋、還是其他問題（例如 `$top` 又超過上限、日期格式錯誤等）。
- 若確定是被擋，目前唯一驗證有效的替代方案是手動用瀏覽器開啟 API 網址、「另存新檔」存成 JSON，再手動放進 `data/raw/`（保留原始資料，長期歷史），本機執行一次 `python scripts/process_data.py` 更新 `docs/data/`，然後手動 commit + push。
- API 單次 `$top` 上限是 10,000 筆，抓超過1~2週的範圍要分段抓。
- 日期參數是民國年緊湊格式 `YYYMMDD`（西元年-1911），腳本已自動換算，不需手動算。

## 本機開發

```bash
# 重新抓資料（需要在不被擋的網路環境執行）
python scripts/fetch_aquatic_data.py --days 7 -o data/raw/aquatic_manual_$(date +%Y%m%d).json

# 重新整理 docs/data
python scripts/process_data.py

# 本機預覽網站
cd docs && python3 -m http.server 8000
# 瀏覽器打開 http://localhost:8000
```

## 資料限制與注意事項（詳見 data_notes.md）

- 品種代碼與魚貨名稱是刻意「分開處理」的設計決策：同名不同代碼（例如黑鯛 1163/2015）視為不同紀錄，不合併。
- 上/中/下價出現 `0.0` 可能代表當天該價格區間無成交，不是真的零元。
- 休市規律是「週末＋國定假日」，並非資料遺漏；個別小型市場（例如興達港、新港）本來就不是每個交易日都有申報，也屬正常。
- `fish_calendar.json` 的「主要產地」是粗略字串比對結果，非官方精確資料，比對依據保留在同筆資料的 `主要產地_比對依據` 欄位方便複核。

# 漁產品交易行情抓取代理（Cloudflare Worker）

解決的問題：GitHub Actions runner 的機房IP會被 data.moa.gov.tw 擋下，排程一直抓不到新資料。
這個Worker改用Cloudflare的邊緣節點IP抓政府API，抓到後寫回repo的
`data/raw/aquatic_worker_live.json`，觸發既有的 GitHub Actions（`.github/workflows/update-data.yml`）
接手做資料整理與發佈（純本機檔案運算，不會被擋）。

不需要用電腦裝任何東西，全程在Cloudflare網站上用滑鼠操作即可。

## 部署步驟（Cloudflare Dashboard，不需要用到Terminal/CLI）

1. 到 https://dash.cloudflare.com/ 註冊/登入一個免費帳號（如果還沒有的話）。
2. 左側選單找到「Workers 和 Pages」（Workers & Pages），按「建立」(Create) →
   「建立Worker」(Create Worker)，取個名字（例如 `taiwan-seafood-fetch-worker`），
   直接部署預設範本即可（先不用管內容）。
3. 部署完成後，進到這個Worker的管理頁面，找到「編輯程式碼」(Edit code) 按鈕，
   打開線上編輯器。
4. 把整個編輯器裡的內容清空，貼上這個資料夾裡 `index.js` 的完整內容，然後按
   右上角「部署」(Deploy)。
5. 回到Worker管理頁面，切到「設定」(Settings) → 「變數與機密」
   (Variables and Secrets)：
   - 新增一般變數（type選 Text）：
     - `GITHUB_OWNER` = `twseafood`
     - `GITHUB_REPO` = `taiwan-seafood-dashboard`
     - `GITHUB_BRANCH` = `master`
     - `FETCH_DAYS` = `10`
   - 新增機密（type選 Secret，畫面上輸入後就看不到明文了）：
     - `GITHUB_TOKEN`：到 GitHub → Settings → Developer settings →
       Personal access tokens → Fine-grained tokens，建立一個新token，
       Repository access選「Only select repositories」→ 選這個repo，
       Permissions裡把 **Contents** 設成 **Read and write**，其他都不用開。
       複製產生的token貼進來。
     - `TRIGGER_KEY`：自己隨便打一串英數字（例如密碼產生器產生的字串），
       記下來，等一下測試要用。
   儲存後記得再按一次「部署」讓變數生效。
6. 切到「觸發器」(Triggers) 頁籤 → 「Cron Triggers」→ 新增：
   - Cron運算式填 `30 23 * * *`（代表UTC時間23:30，也就是台北時間每天07:30）。
7. 測試：瀏覽器直接打開
   `https://<你的worker名稱>.<你的cloudflare帳號>.workers.dev/run?key=你剛剛設定的TRIGGER_KEY`
   （網址在Worker管理頁面最上面可以複製）。
   - 回傳 `"ok": true` 代表成功，且GitHub repo裡應該幾分鐘內就會多一個
     `data/raw/aquatic_worker_live.json` 的commit，接著GitHub Actions會自動
     被觸發去整理資料、更新網站。
   - 如果回傳訊息裡有「回應內容為空」，代表Cloudflare的IP也被data.moa.gov.tw
     擋下了，這條路線就不通，要考慮換其他方案（例如自己的VPS）。
   - 如果回傳 `unauthorized`，代表網址裡的 `key=` 打錯了，跟Secret設定的值對一下。

## 之後如果要調整

- 想改抓幾天的資料：改 `FETCH_DAYS` 這個變數即可，不用改程式碼。
- 想改排程時間：Triggers頁籤裡改Cron運算式即可。
- 想暫停：Triggers頁籤把Cron Trigger刪掉，或整個Worker按「停用」即可，不影響網站本身
  （只是又會回到只能靠瀏覽器即時抓取／舊的靜態資料）。
- GitHub Token過期或要換：回到「變數與機密」重新貼一次新的 `GITHUB_TOKEN` 即可。

## 費用

Cloudflare Workers 免費方案額度：每天10萬次請求、Cron Triggers不限次數（截至撰寫時的方案內容，
實際請以Cloudflare官網公告為準）。這個Worker一天只跑1次排程＋你手動測試的幾次，完全在免費額度內。

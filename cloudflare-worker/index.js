// ============================================================================
// 台灣海鮮儀表板 - 漁產品交易行情抓取代理（Cloudflare Worker）
// ============================================================================
// 背景：data.moa.gov.tw 對「機房/資料中心IP」有防護機制，GitHub Actions runner
// 的請求會被擋下（回傳空內容），所以排程一直抓不到新資料，網站資料因此停滯不前。
//
// 這個Worker的唯一工作：改用Cloudflare的邊緣節點IP去抓政府API，抓到後透過GitHub
// Contents API把原始JSON寫回repo的 data/raw/aquatic_worker_live.json（每次覆蓋
// 同一個檔案，不會讓data/raw/資料夾越長越大）。
//
// 寫入後會觸發repo裡 .github/workflows/update-data.yml 的push條件，由GitHub Actions
// 接手執行 scripts/process_data.py 重新整理 docs/data/*.json 並部署——這一步完全是
// 本機檔案運算，不需要連到data.moa.gov.tw，所以不會被擋。
//
// 也就是說：抓取（可能被擋）交給Worker，整理＋發佈（純檔案運算，不會被擋）交給
// 既有的GitHub Actions，兩邊職責切開，各自維持現有工具不用重寫。
//
// ---- 部署需要設定的東西（在Cloudflare Dashboard，不寫在這個檔案裡）----
// Secrets（Settings > Variables and Secrets，type選Secret）：
//   GITHUB_TOKEN  GitHub Personal Access Token（fine-grained，Contents讀寫權限；
//                 只給這一個repo即可，不要選成全帳號權限）
//   TRIGGER_KEY   自己隨便設一個複雜字串，用來保護手動觸發端點，避免被別人亂觸發
// 一般變數（type選Text，或直接寫在下面 DEFAULT_* 常數裡也可以）：
//   GITHUB_OWNER  例如 "twseafood"
//   GITHUB_REPO   例如 "taiwan-seafood-dashboard"
//   GITHUB_BRANCH 例如 "master"
//   FETCH_DAYS    要抓最近幾天，例如 "10"
// Cron Trigger（Triggers頁籤 > Cron Triggers）：
//   建議 "30 23 * * *"（UTC）= 台北時間每天 07:30
// ============================================================================

const AQUATIC_API_BASE = "https://data.moa.gov.tw/Service/OpenData/FromM/AquaticTransData.aspx";
const RAW_FILE_PATH = "data/raw/aquatic_worker_live.json";

// 沒設環境變數時的預設值，方便快速測試；正式使用請在Dashboard設定對應變數覆蓋。
const DEFAULT_GITHUB_OWNER = "twseafood";
const DEFAULT_GITHUB_REPO = "taiwan-seafood-dashboard";
const DEFAULT_GITHUB_BRANCH = "master";
const DEFAULT_FETCH_DAYS = "10";

function isoToRocCompact(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${y - 1911}${String(m).padStart(2, "0")}${String(d).padStart(2, "0")}`;
}

function addDaysIso(iso, delta) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

// 用台灣時區(UTC+8)算「今天」，Worker執行環境本身是UTC
function todayIsoTaiwan() {
  const now = new Date();
  const twMs = now.getTime() + 8 * 60 * 60 * 1000;
  return new Date(twMs).toISOString().slice(0, 10);
}

async function fetchAquaticRows(days) {
  const end = todayIsoTaiwan();
  const start = addDaysIso(end, -days);
  const url = `${AQUATIC_API_BASE}?$top=10000&$skip=0&StartDate=${isoToRocCompact(start)}&EndDate=${isoToRocCompact(end)}`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept": "application/json,text/plain,*/*",
    },
  });

  if (!res.ok) {
    throw new Error(`API回應失敗 HTTP ${res.status}`);
  }

  const text = await res.text();
  if (!text || !text.trim()) {
    throw new Error("回應內容為空（很可能是被data.moa.gov.tw的防護機制擋下，代表Cloudflare的IP也被列為機房IP）");
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch (e) {
    throw new Error(`回應不是合法JSON（前100字：${text.slice(0, 100)}）`);
  }

  const rows = Array.isArray(payload) ? payload : (payload.data || []);
  if (rows.length && rows[0] && rows[0].errMsg && Object.keys(rows[0]).length === 1) {
    throw new Error(`API回傳錯誤：${rows[0].errMsg}`);
  }

  return { rows, start, end };
}

async function githubGetFileSha(env) {
  const owner = env.GITHUB_OWNER || DEFAULT_GITHUB_OWNER;
  const repo = env.GITHUB_REPO || DEFAULT_GITHUB_REPO;
  const branch = env.GITHUB_BRANCH || DEFAULT_GITHUB_BRANCH;
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${RAW_FILE_PATH}?ref=${branch}`;

  const res = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": "taiwan-seafood-dashboard-worker",
    },
  });

  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`查詢GitHub檔案失敗 HTTP ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  return json.sha;
}

// Workers runtime 內建 btoa 只吃 Latin1，中文內容需要先轉UTF-8 bytes再編碼
function toBase64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function githubPutFile(env, contentObj, sha, commitMessage) {
  const owner = env.GITHUB_OWNER || DEFAULT_GITHUB_OWNER;
  const repo = env.GITHUB_REPO || DEFAULT_GITHUB_REPO;
  const branch = env.GITHUB_BRANCH || DEFAULT_GITHUB_BRANCH;
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${RAW_FILE_PATH}`;

  const body = {
    message: commitMessage,
    content: toBase64Utf8(JSON.stringify(contentObj, null, 2)),
    branch,
  };
  if (sha) body.sha = sha;

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": "taiwan-seafood-dashboard-worker",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`寫入GitHub檔案失敗 HTTP ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function runOnce(env) {
  const days = Number(env.FETCH_DAYS || DEFAULT_FETCH_DAYS);
  const { rows, start, end } = await fetchAquaticRows(days);

  if (!rows.length) {
    return { ok: false, reason: "empty", message: "抓到0筆資料，可能是當天真的無交易，也可能被擋，請多留意幾次結果", start, end };
  }

  const payload = {
    meta: {
      source_url: AQUATIC_API_BASE,
      fetched_by: "cloudflare-worker",
      fetched_at: new Date().toISOString(),
      start_date_ad: start,
      end_date_ad: end,
      row_count: rows.length,
    },
    data: rows,
  };

  const sha = await githubGetFileSha(env);
  await githubPutFile(env, payload, sha, `chore: Cloudflare Worker自動更新漁產品原始資料 ${end}（共${rows.length}筆）`);

  return { ok: true, rowCount: rows.length, start, end };
}

export default {
  // 排程觸發（Cron Trigger）
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runOnce(env).catch((err) => {
        console.error("排程執行失敗：", err.message);
      })
    );
  },

  // 手動觸發測試用：GET /run?key=你設定的TRIGGER_KEY
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/run") {
      const token = url.searchParams.get("key");
      if (!env.TRIGGER_KEY || token !== env.TRIGGER_KEY) {
        return new Response("unauthorized：請帶正確的 ?key=", { status: 401 });
      }
      try {
        const result = await runOnce(env);
        return new Response(JSON.stringify(result, null, 2), {
          status: result.ok ? 200 : 502,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ ok: false, error: err.message }, null, 2), {
          status: 500,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
    }

    return new Response(
      "台灣海鮮儀表板 - 漁產品交易行情抓取代理\n用 GET /run?key=你的TRIGGER_KEY 手動觸發一次測試。",
      { status: 200 }
    );
  },
};

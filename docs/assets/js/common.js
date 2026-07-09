// 共用工具函式：抓資料、日期格式化等
const DataAPI = (() => {
  const cache = {};

  async function fetchJSON(path) {
    if (cache[path]) return cache[path];
    const res = await fetch(path, { cache: "no-cache" });
    if (!res.ok) throw new Error(`載入 ${path} 失敗（HTTP ${res.status}）`);
    const json = await res.json();
    cache[path] = json;
    return json;
  }

  return {
    getMeta: () => fetchJSON("data/meta.json"),
    getSpecies: () => fetchJSON("data/species.json"),
    getMarkets: () => fetchJSON("data/markets.json"),
    getLatest: () => fetchJSON("data/latest.json"),
    getHistory: () => fetchJSON("data/history.json"),
    getFishCalendar: () => fetchJSON("data/fish_calendar.json"),
  };
})();

function formatDateTW(isoDate) {
  if (!isoDate) return "";
  const [y, m, d] = isoDate.split("-");
  return `${y}/${m}/${d}`;
}

function formatDateTime(isoString) {
  try {
    const d = new Date(isoString);
    return d.toLocaleString("zh-TW", { hour12: false });
  } catch (e) {
    return isoString;
  }
}

function money(n) {
  if (n === null || n === undefined) return "-";
  return Number(n).toLocaleString("zh-TW", { maximumFractionDigits: 1 });
}

// 依「中文名、中文名2」格式的字串切出第一個當主要顯示名稱
function primaryName(nameStr) {
  return (nameStr || "").split("、")[0];
}

// 台股慣例：紅漲、綠跌。回傳可直接塞進表格儲存格的 HTML。
function priceChangeBadge(r, opts) {
  opts = opts || {};
  if (r.direction === "new" || r.changePct === null || r.changePct === undefined) {
    return `<span class="price-change new">— <span class="prev-date">(無比較基準)</span></span>`;
  }
  const arrow = r.direction === "up" ? "▲" : (r.direction === "down" ? "▼" : "—");
  const sign = r.changePct > 0 ? "+" : "";
  const prevInfo = opts.showPrevDate === false ? "" : `<span class="prev-date">較${formatDateTW(r.prevDate)}</span>`;
  return `<span class="price-change ${r.direction}">${arrow} ${sign}${r.changePct}%${prevInfo}</span>`;
}

// 市場類型（消費地/產地）小標籤
function marketTypeBadge(r) {
  if (!r.marketType) return "";
  const cls = r.marketType === "消費地" ? "market-type-badge consumer" : "market-type-badge origin";
  return `<span class="${cls}">${r.marketType}</span>`;
}

// 養殖／永續標籤：依使用者需求，只在「消費地市場」的資料才加註（見data_notes.md養殖/永續分類說明）。
// 養殖=資料本身養/海命名慣例＋代碼區間判斷；永續=與《臺灣海鮮選擇指南》綠燈(green)比對相符才顯示「永續」。
function farmedSustainBadges(r) {
  if (r.marketType !== "消費地") return "";
  let html = "";
  if (r.farmed === true) {
    html += `<span class="tag-badge farmed">養殖</span>`;
  }
  if (r.sustainability === "green") {
    html += `<span class="tag-badge sustain">永續</span>`;
  }
  return html;
}

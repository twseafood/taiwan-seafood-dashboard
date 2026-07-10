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
// volatileNote：漲跌幅超過門檻(見EXTREME_CHANGE_PCT)，可能是當日到貨規格/等級組成不同造成，
// 不代表同一批貨的真實漲跌，顯示「規格價差大」提醒使用者謹慎解讀。
function priceChangeBadge(r, opts) {
  opts = opts || {};
  if (r.direction === "new" || r.changePct === null || r.changePct === undefined) {
    return `<span class="price-change new">— <span class="prev-date">(無比較基準)</span></span>`;
  }
  const arrow = r.direction === "up" ? "▲" : (r.direction === "down" ? "▼" : "—");
  const sign = r.changePct > 0 ? "+" : "";
  const noteHtml = r.volatileNote
    ? `<span class="mix-note" title="漲跌幅過大，可能是當日到貨規格/等級組成不同造成，非同批貨的真實漲跌，建議同時參考上/中/下價">規格價差大</span>`
    : "";
  const prevInfo = opts.showPrevDate === false ? "" : `<span class="prev-date">較${formatDateTW(r.prevDate)}</span>`;
  return `<span class="price-change ${r.direction}">${arrow} ${sign}${r.changePct}%${noteHtml}${prevInfo}</span>`;
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

// ================= 即時抓取政府API（瀏覽器端直接fetch，仿照 hsuchihting 的作法） =================
// 原理：GitHub Actions排程用的是資料中心IP，會被data.moa.gov.tw的防護機制擋下；
// 但如果改成「訪客自己打開網頁時，瀏覽器直接呼叫API」，用的是訪客自己家用網路的IP，就不會被擋。
// 這裡只用來抓「最新一天的即時快照」，長期歷史資料（趨勢圖等）還是用docs/data/history.json靜態檔案。
const AQUATIC_API_BASE = "https://data.moa.gov.tw/Service/OpenData/FromM/AquaticTransData.aspx";

const CONSUMER_MARKETS = new Set([
  "台北", "三重", "新竹", "桃園", "苗栗", "台中", "彰化",
  "埔心", "嘉義", "斗南", "佳里", "新營", "高雄",
]);

function marketTypeOfJs(market) {
  return CONSUMER_MARKETS.has(market) ? "消費地" : "產地";
}

function isoToRocCompact(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${y - 1911}${String(m).padStart(2, "0")}${String(d).padStart(2, "0")}`;
}

function rocCompactToIso(roc) {
  const s = String(roc);
  const y = parseInt(s.slice(0, 3), 10) + 1911;
  return `${y}-${s.slice(3, 5)}-${s.slice(5, 7)}`;
}

function addDaysIso(iso, delta) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

// 用台灣時區(UTC+8)算「今天」，避免海外訪客瀏覽器時區不同而抓錯日期區間
function todayIsoTaiwan() {
  const now = new Date();
  const twMs = now.getTime() + 8 * 60 * 60 * 1000 + now.getTimezoneOffset() * 60000;
  return new Date(twMs).toISOString().slice(0, 10);
}

async function fetchLiveAquaticRows(days) {
  days = days || 10;
  const end = todayIsoTaiwan();
  const start = addDaysIso(end, -days);
  const url = `${AQUATIC_API_BASE}?$top=10000&$skip=0&StartDate=${isoToRocCompact(start)}&EndDate=${isoToRocCompact(end)}`;
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`即時API回應失敗（HTTP ${res.status}）`);
  const payload = await res.json();
  const rows = Array.isArray(payload) ? payload : (payload.data || []);
  if (rows.length && rows[0] && rows[0].errMsg) throw new Error(rows[0].errMsg);
  return rows.map((r) => ({
    date: rocCompactToIso(r["交易日期"]),
    dateRoc: r["交易日期"],
    speciesCode: r["品種代碼"],
    speciesName: r["魚貨名稱"],
    market: r["市場名稱"],
    priceHigh: r["上價"],
    priceMid: r["中價"],
    priceLow: r["下價"],
    volume: r["交易量"],
    avgPrice: r["平均價"],
  }));
}

// 漲跌幅可信度警示門檻，需跟 scripts/process_data.py 的 EXTREME_CHANGE_PCT / MIN_VOLUME_KG 保持一致
const EXTREME_CHANGE_PCT = 40.0;
const MIN_VOLUME_KG = 10.0;

// 把即時抓到的資料併入既有的靜態history（即時資料優先覆蓋同一天的靜態資料），
// 重新計算漲跌幅／市場類型／養殖永續標籤，回傳跟 docs/data/latest.json 相同格式的 {date, records}
function buildLiveLatest(staticHistory, liveRows, speciesList) {
  const speciesMeta = new Map((speciesList || []).map((s) => [s.code, s]));
  const keyOf = (r) => `${r.date}|${r.speciesCode}|${r.market}`;

  const merged = new Map();
  for (const r of staticHistory) merged.set(keyOf(r), { ...r });
  for (const r of liveRows) merged.set(keyOf(r), { ...r });

  const all = Array.from(merged.values());
  const groups = new Map();
  for (const r of all) {
    const gk = `${r.speciesCode}|${r.market}`;
    if (!groups.has(gk)) groups.set(gk, []);
    groups.get(gk).push(r);
  }

  for (const rows of groups.values()) {
    rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    let prev = null;
    for (const r of rows) {
      r.marketType = marketTypeOfJs(r.market);
      const meta = speciesMeta.get(r.speciesCode);
      r.farmed = meta ? meta.farmed : null;
      r.sustainability = meta ? meta.sustainability : null;
      r.lowVolume = (r.volume || 0) < MIN_VOLUME_KG;
      if (prev && prev.avgPrice) {
        const changeAbs = Math.round((r.avgPrice - prev.avgPrice) * 100) / 100;
        const changePct = Math.round((changeAbs / prev.avgPrice) * 10000) / 100;
        r.prevDate = prev.date;
        r.prevAvgPrice = prev.avgPrice;
        r.changeAbs = changeAbs;
        r.changePct = changePct;
        r.direction = changeAbs > 0 ? "up" : changeAbs < 0 ? "down" : "flat";
        r.volatileNote = Math.abs(changePct) >= EXTREME_CHANGE_PCT;
      } else {
        r.prevDate = null;
        r.prevAvgPrice = null;
        r.changeAbs = null;
        r.changePct = null;
        r.direction = "new";
        r.volatileNote = false;
      }
      prev = r;
    }
  }

  let latestDate = null;
  for (const r of all) {
    if (!latestDate || r.date > latestDate) latestDate = r.date;
  }
  const latestRows = all.filter((r) => r.date === latestDate);
  latestRows.sort((a, b) => (a.changePct ?? 999999) - (b.changePct ?? 999999));

  // 「急售」只給前3筆排除規格價差過大／交易量過低的可信下跌紀錄，跟 process_data.py 邏輯一致
  let urgentCount = 0;
  for (const r of latestRows) {
    const eligible = r.direction === "down" && !r.volatileNote && !r.lowVolume;
    if (eligible && urgentCount < 3) {
      r.isUrgent = true;
      urgentCount += 1;
    } else {
      r.isUrgent = false;
    }
  }

  return { date: latestDate, records: latestRows };
}

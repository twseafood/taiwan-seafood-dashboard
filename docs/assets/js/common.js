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

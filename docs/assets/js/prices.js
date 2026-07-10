(async function () {
  const MAX_ROWS = 300;
  let history = [];
  let chart = null;

  const el = {
    species: document.getElementById("f-species"),
    market: document.getElementById("f-market"),
    marketType: document.getElementById("f-market-type"),
    start: document.getElementById("f-start"),
    end: document.getElementById("f-end"),
    searchBtn: document.getElementById("btn-search"),
    resetBtn: document.getElementById("btn-reset"),
    tbody: document.getElementById("result-tbody"),
    resultCaption: document.getElementById("result-caption"),
    rangeCaption: document.getElementById("range-caption"),
    chartCard: document.getElementById("chart-card"),
    chartTitle: document.getElementById("chart-title"),
  };

  function populateSelect(select, items, valueKey, labelFn) {
    for (const item of items) {
      const opt = document.createElement("option");
      opt.value = item[valueKey];
      opt.textContent = labelFn(item);
      select.appendChild(opt);
    }
  }

  function currentFilters() {
    return {
      speciesCode: el.species.value ? Number(el.species.value) : null,
      market: el.market.value || null,
      marketType: el.marketType.value || null,
      start: el.start.value || null,
      end: el.end.value || null,
    };
  }

  function applyFilters() {
    const f = currentFilters();
    return history.filter(r => {
      if (f.speciesCode !== null && r.speciesCode !== f.speciesCode) return false;
      if (f.market && r.market !== f.market) return false;
      if (f.marketType && r.marketType !== f.marketType) return false;
      if (f.start && r.date < f.start) return false;
      if (f.end && r.date > f.end) return false;
      return true;
    });
  }

  function renderTable(rows) {
    const sorted = [...rows].sort((a, b) => b.date.localeCompare(a.date));
    const shown = sorted.slice(0, MAX_ROWS);
    el.resultCaption.textContent = rows.length > MAX_ROWS
      ? `符合條件共 ${rows.length} 筆，僅顯示最新 ${MAX_ROWS} 筆（請縮小篩選範圍看更完整結果）`
      : `符合條件共 ${rows.length} 筆`;

    if (shown.length === 0) {
      el.tbody.innerHTML = `<tr><td colspan="10" class="empty-state">沒有符合條件的資料</td></tr>`;
      return;
    }
    el.tbody.innerHTML = shown.map(r => `
      <tr>
        <td>${formatDateTW(r.date)}</td>
        <td>${r.market}${marketTypeBadge(r)}</td>
        <td>${r.speciesName}${farmedSustainBadges(r)}</td>
        <td>${r.speciesCode}</td>
        <td>${money(r.avgPrice)}</td>
        <td>${priceChangeBadge(r)}</td>
        <td>${money(r.priceHigh)}</td>
        <td>${money(r.priceMid)}</td>
        <td>${money(r.priceLow)}</td>
        <td>${money(r.volume)}</td>
      </tr>
    `).join("");
  }

  function renderChart(rows, speciesLabel, marketLabel) {
    const f = currentFilters();
    if (f.speciesCode === null || !f.market) {
      el.chartCard.style.display = "none";
      return;
    }
    const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
    el.chartCard.style.display = "block";
    el.chartTitle.textContent = `${speciesLabel} @ ${marketLabel} — 平均價走勢`;
    const ctx = document.getElementById("price-chart").getContext("2d");
    const data = {
      labels: sorted.map(r => r.date),
      datasets: [
        { label: "平均價", data: sorted.map(r => r.avgPrice), borderColor: "#106b8f", backgroundColor: "rgba(16,107,143,0.15)", tension: 0.25, fill: true },
        { label: "上價", data: sorted.map(r => r.priceHigh), borderColor: "#e2725b", borderDash: [4, 3], pointRadius: 0 },
        { label: "下價", data: sorted.map(r => r.priceLow), borderColor: "#4fa5c9", borderDash: [4, 3], pointRadius: 0 },
      ],
    };
    if (chart) chart.destroy();
    chart = new Chart(ctx, {
      type: "line",
      data,
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        scales: { y: { title: { display: true, text: "元/公斤" } } },
      },
    });
  }

  function runQuery() {
    const rows = applyFilters();
    renderTable(rows);
    const f = currentFilters();
    const speciesLabel = f.speciesCode !== null
      ? el.species.options[el.species.selectedIndex].textContent
      : "";
    renderChart(rows, speciesLabel, f.market || "");
  }

  el.searchBtn.addEventListener("click", runQuery);
  el.resetBtn.addEventListener("click", () => {
    el.species.value = "";
    el.market.value = "";
    el.start.value = "";
    el.end.value = "";
    runQuery();
  });

  try {
    const [meta, species, markets, hist] = await Promise.all([
      DataAPI.getMeta(), DataAPI.getSpecies(), DataAPI.getMarkets(), DataAPI.getHistory(),
    ]);
    history = hist;

    el.rangeCaption.textContent = `資料涵蓋 ${meta.dateRange.start} ~ ${meta.dateRange.end}（共 ${meta.recordCount.toLocaleString()} 筆，最後更新於 ${formatDateTime(meta.generatedAt)}，為每日排程備份的靜態資料）。若要看今天最即時的價格，請至首頁「今日價格榜」查看瀏覽器即時抓取的資料。`;

    populateSelect(el.species, species, "code", (s) => `${s.name}（代碼${s.code}）`);
    populateSelect(el.market, markets, "name", (m) => `${m.name}（${m.count}筆）`);

    el.start.value = meta.dateRange.start;
    el.end.value = meta.dateRange.end;

    runQuery();
  } catch (err) {
    console.error(err);
    el.tbody.innerHTML = `<tr><td colspan="10" class="empty-state">資料載入失敗：${err.message}</td></tr>`;
  }
})();

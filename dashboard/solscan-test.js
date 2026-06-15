const state = {
  payload: null,
  rows: [],
  entityRows: [],
  walletEvidence: [],
  query: "",
  openKey: null,
};

const els = {
  meta: document.getElementById("solscan-meta"),
  subtitle: document.getElementById("solscan-subtitle"),
  generated: document.getElementById("summary-generated"),
  entities: document.getElementById("summary-entities"),
  wallets: document.getElementById("summary-wallets"),
  duplicates: document.getElementById("summary-duplicates"),
  status: document.getElementById("table-status"),
  banner: document.getElementById("status-banner"),
  body: document.getElementById("table-body"),
  search: document.getElementById("search-input"),
  reload: document.getElementById("reload-button"),
};

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function fmtUsd(value) {
  return Number(value || 0).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

function fmtNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value || "-");
  return n.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

function fmtUsdOrDash(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "-";
  return fmtUsd(n);
}

function shortAddress(address) {
  const value = String(address || "");
  return value.length > 14 ? `${value.slice(0, 6)}...${value.slice(-6)}` : value;
}

function rowKey(row) {
  return row.tokenKey || row.tokenAddress || `${row.tokenSymbol}\n${row.tokenName}`;
}

function buildTokenRows(entityRows) {
  const groups = new Map();

  for (const row of entityRows) {
    const tokenKey = row.tokenKey || row.tokenAddress || `${row.tokenSymbol}\n${row.tokenName}`;
    if (!tokenKey) continue;

    if (!groups.has(tokenKey)) {
      groups.set(tokenKey, {
        tokenKey,
        tokenAddress: row.tokenAddress,
        tokenSymbol: row.tokenSymbol || "-",
        tokenName: row.tokenName || row.tokenSymbol || "Unknown Token",
        marketCap: row.marketCap,
        tokenAgeHours: row.tokenAgeHours,
        holdingsUsd: 0,
        balance: 0,
        entities: new Map(),
      });
    }

    const group = groups.get(tokenKey);
    const balanceUsd = Number(row.balanceUsd || 0);
    const balance = Number(row.balance || 0);
    group.holdingsUsd += Number.isFinite(balanceUsd) ? balanceUsd : 0;
    group.balance += Number.isFinite(balance) ? balance : 0;

    const entityKey = row.entityName || row.resolvedLabel || "Unknown Entity";
    const existing = group.entities.get(entityKey) || {
      entityName: row.entityName || entityKey,
      resolvedLabel: row.resolvedLabel || "",
      balanceUsd: 0,
      balance: 0,
      walletCount: 0,
      wallets: new Set(),
    };

    existing.balanceUsd += Number.isFinite(balanceUsd) ? balanceUsd : 0;
    existing.balance += Number.isFinite(balance) ? balance : 0;
    existing.walletCount += Number(row.walletCount || row.wallets?.length || 0) || 0;
    for (const wallet of row.wallets || []) existing.wallets.add(wallet);
    group.entities.set(entityKey, existing);
  }

  return [...groups.values()].map((group) => {
    const holders = [...group.entities.values()]
      .map((holder) => ({
        ...holder,
        wallets: [...holder.wallets],
        walletCount: holder.wallets.size || holder.walletCount,
      }))
      .sort((left, right) => Number(right.balanceUsd || 0) - Number(left.balanceUsd || 0));

    return {
      ...group,
      smwIn: holders.length,
      holders,
    };
  });
}

function getFilteredRows() {
  const query = state.query.trim().toLowerCase();
  const rows = [...state.rows].sort((left, right) => Number(right.holdingsUsd || 0) - Number(left.holdingsUsd || 0));
  if (!query) return rows;
  return rows.filter((row) =>
    [
      row.tokenSymbol,
      row.tokenName,
      row.tokenAddress,
      row.tokenKey,
      ...(row.holders || []).map((holder) => holder.entityName),
      ...(row.holders || []).map((holder) => holder.resolvedLabel),
    ]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query)),
  );
}

function renderSummary() {
  const payload = state.payload;
  if (!payload) {
    els.generated.textContent = "No file";
    els.entities.textContent = "0 entities";
    els.wallets.textContent = "0 wallets";
    els.duplicates.textContent = "0 duplicates collapsed";
    return;
  }

  const generated = payload.generatedAt ? new Date(payload.generatedAt).toLocaleString() : "Unknown time";
  els.generated.textContent = payload.file ? `${payload.file}` : generated;
  els.entities.textContent = `${payload.entitiesScanned || 0} entities scanned`;
  els.wallets.textContent = `${payload.walletsAttempted || 0} wallets attempted`;
  els.duplicates.textContent = `${payload.duplicateRowsCollapsed || 0} duplicates collapsed`;
  els.meta.textContent = `Generated ${generated}; min value ${fmtUsd(payload.minBalanceUsd || 111)}.`;
  els.subtitle.textContent = `${payload.walletRows || 0} wallet rows collapsed into ${payload.entityRows || 0} entity-token rows, grouped into ${state.rows.length || 0} token rows.`;
}

function renderRows() {
  const rows = getFilteredRows();
  els.status.textContent = `${rows.length} rows`;

  if (!rows.length) {
    els.body.innerHTML = `
      <tr>
        <td colspan="8">
          <div class="drilldown-panel">
            <div class="empty-note">No Solscan rows match the current filter.</div>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  els.body.innerHTML = rows
    .map((row) => {
      const key = rowKey(row);
      const isOpen = state.openKey === key;
      const holderList = (row.holders || [])
        .map((holder) => {
          const label = holder.resolvedLabel && holder.resolvedLabel !== holder.entityName
            ? `${holder.entityName} · ${holder.resolvedLabel}`
            : holder.entityName;
          return `
            <div class="holder-list__row">
              <span class="drilldown-entity">${escapeHtml(label)}</span>
              <span class="drilldown-balance">${escapeHtml(fmtUsd(holder.balanceUsd))}</span>
            </div>
          `;
        })
        .join("");

      return `
        <tr class="signal-row ${isOpen ? "is-open" : ""}" data-row-key="${escapeHtml(key)}">
          <td class="ticker-cell">
            <div class="ticker-stack">
              <div class="ticker-mainline">
                <span class="ticker-main">${escapeHtml(row.tokenSymbol)}</span>
              </div>
            </div>
          </td>
          <td>
            <div class="token-cell">
              <strong>${escapeHtml(row.tokenName)}</strong>
              <span>Click to view entity holders</span>
            </div>
          </td>
          <td>${escapeHtml(fmtUsdOrDash(row.marketCap))}</td>
          <td><span class="network-badge">Solana</span></td>
          <td>${Number.isFinite(Number(row.tokenAgeHours)) ? escapeHtml(`${Math.round(Number(row.tokenAgeHours))}h`) : "Pending"}</td>
          <td class="metric-cell">${escapeHtml(fmtUsd(row.holdingsUsd))}</td>
          <td class="metric-cell">${escapeHtml(String(row.smwIn || 0))}</td>
          <td>
            <code class="mint-code" title="${escapeHtml(row.tokenAddress)}">${escapeHtml(shortAddress(row.tokenAddress))}</code>
          </td>
        </tr>
        ${
          isOpen
            ? `
              <tr class="drilldown-row">
                <td colspan="8">
                  <div class="drilldown-panel">
                    <div class="drilldown-detail">
                      <div class="drilldown-detail__header">
                        <div>
                          <h3>${escapeHtml(row.tokenName)} holders</h3>
                          <div class="empty-note">${escapeHtml(fmtNumber(row.balance))} tokens across ${escapeHtml(String(row.smwIn || 0))} entities.</div>
                        </div>
                        <div class="drilldown-summary">
                          <span>${escapeHtml(fmtUsd(row.holdingsUsd))}</span>
                          <strong>Total Solscan holdings</strong>
                        </div>
                      </div>
                      <div class="holder-list">${holderList || '<div class="empty-note">No holder evidence.</div>'}</div>
                    </div>
                  </div>
                </td>
              </tr>
            `
            : ""
        }
      `;
    })
    .join("");
}

function setBanner(message, tone = "info") {
  els.banner.hidden = !message;
  els.banner.textContent = message || "";
  els.banner.classList.toggle("status-banner--error", tone === "error");
}

async function loadLatest() {
  setBanner("Loading latest Solscan output...");
  try {
    const response = await fetch("/api/solscan-test/latest");
    const payload = await response.json();
    if (response.status === 401) {
      window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}`);
      return;
    }
    if (!response.ok) {
      throw new Error(payload.error || `Request failed with ${response.status}`);
    }
    state.payload = payload;
    state.entityRows = Array.isArray(payload.rows) ? payload.rows : [];
    state.rows = buildTokenRows(state.entityRows);
    state.walletEvidence = Array.isArray(payload.walletEvidence) ? payload.walletEvidence : [];
    state.openKey = null;
    renderSummary();
    renderRows();
    setBanner("");
  } catch (error) {
    state.payload = null;
    state.rows = [];
    state.entityRows = [];
    state.walletEvidence = [];
    renderSummary();
    renderRows();
    setBanner(error instanceof Error ? error.message : "Could not load Solscan output", "error");
  }
}

els.reload.addEventListener("click", loadLatest);
els.search.addEventListener("input", () => {
  state.query = els.search.value;
  renderRows();
});
els.body.addEventListener("click", (event) => {
  const button = event.target.closest("[data-row-key]");
  if (!button) return;
  const key = button.getAttribute("data-row-key");
  state.openKey = state.openKey === key ? null : key;
  renderRows();
});

loadLatest();

const els = {
  heroMeta: document.getElementById("hero-meta"),
  refreshButton: document.getElementById("refresh-button"),
  cancelButton: document.getElementById("cancel-button"),
  snapshotSelect: document.getElementById("snapshot-select"),
  minBalanceInput: document.getElementById("min-balance-input"),
  minSmwInput: document.getElementById("min-smw-input"),
  apiKeyInput: document.getElementById("api-key-input"),
  summaryStatus: document.getElementById("summary-status"),
  summaryEntities: document.getElementById("summary-entities"),
  summaryRows: document.getElementById("summary-rows"),
  statusBanner: document.getElementById("status-banner"),
  tableBody: document.getElementById("table-body"),
  tableStatus: document.getElementById("table-status"),
  tableSubtitle: document.getElementById("table-subtitle"),
  jobStatus: document.getElementById("job-status"),
  activitySubtitle: document.getElementById("activity-subtitle"),
  jobProgressLabel: document.getElementById("job-progress-label"),
  jobProgressCount: document.getElementById("job-progress-count"),
  jobProgressFill: document.getElementById("job-progress-fill"),
  logStream: document.getElementById("log-stream"),
  sortButtons: Array.from(document.querySelectorAll("[data-sort-key]")),
};

const state = {
  snapshots: [],
  selectedSnapshotId: null,
  rows: [],
  openTokenKey: null,
  holders: new Map(),
  sortKey: "smwIn",
  sortDir: "desc",
  refreshJob: null,
  refreshPollTimer: null,
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function fmtUsd(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) return "$0.00";
  return numeric.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

function fmtUsdOrDash(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return "—";
  return fmtUsd(numeric);
}

function fmtDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function fmtTokenAge(value) {
  if (value == null || !Number.isFinite(Number(value))) return "Pending";
  const numeric = Number(value);
  if (numeric < 24) return `${numeric.toFixed(1)}h`;
  return `${(numeric / 24).toFixed(1)}d`;
}

function fmtMoniScoreValue(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  if (numeric < 1000) return Math.round(numeric).toLocaleString("en-US");
  return `${Math.round(numeric / 1000).toLocaleString("en-US")}k`;
}

function buildMoniScoreCell(row) {
  const score = fmtMoniScoreValue(row.moniScore);
  const level = Number(row.moniLevel);
  const levelName = String(row.moniLevelName || "").trim();
  if (!score || !Number.isFinite(level) || !levelName) {
    return '<span class="moni-cell__pending">Pending</span>';
  }

  const momentumPct = Number(row.moniMomentumScorePct);
  const momentumRank = Number(row.moniMomentumRank);
  const momentumLine =
    Number.isFinite(momentumPct) && Number.isFinite(momentumRank)
      ? `🚀 ${momentumPct.toLocaleString("en-US", { maximumFractionDigits: 1 })}% · Top ${Math.round(momentumRank).toLocaleString("en-US")}`
      : "No momentum";

  return `
    <div class="moni-cell">
      <div>${escapeHtml(`${score} · ${levelName} ${Math.round(level)}/8`)}</div>
      <span>${escapeHtml(momentumLine)}</span>
    </div>
  `;
}

function setBanner(message, tone = "warning") {
  if (!message) {
    els.statusBanner.hidden = true;
    els.statusBanner.textContent = "";
    return;
  }
  els.statusBanner.hidden = false;
  els.statusBanner.textContent = message;
  els.statusBanner.dataset.tone = tone;
}

async function fetchJson(url, options) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error || "");
    if (/failed to fetch|networkerror|load failed|fetch failed/i.test(message)) {
      throw new Error("API doesn't respond, you might need to insert a new API.");
    }
    throw error;
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload.error || `${response.status} ${response.statusText}`;
    if (/fetch failed|network|timed out|timeout|doesn't respond|does not respond/i.test(message)) {
      throw new Error("API doesn't respond, you might need to insert a new API.");
    }
    throw new Error(message);
  }
  return payload;
}

function getJobStatusTone(status) {
  if (status === "success") return "success";
  if (status === "partial" || status === "running") return "warning";
  if (status === "failed" || status === "canceled") return "danger";
  return "idle";
}

function stopRefreshPolling() {
  if (state.refreshPollTimer) {
    window.clearInterval(state.refreshPollTimer);
    state.refreshPollTimer = null;
  }
}

function startRefreshPolling() {
  if (state.refreshPollTimer) return;
  state.refreshPollTimer = window.setInterval(() => {
    syncRefreshStatus({ silent: true }).catch(() => {
      /* handled in syncRefreshStatus */
    });
  }, 1400);
}

function renderRefreshActivity() {
  const job = state.refreshJob;
  const status = job?.progress?.status || "idle";
  const running = Boolean(job?.running);
  const tone = getJobStatusTone(status);
  const total = Number(job?.progress?.totalEntities || 0);
  const completed = Number(job?.progress?.entitiesCompleted || 0);
  const failed = Number(job?.progress?.entitiesFailed || 0);
  const totalRows = Number(job?.progress?.totalRows || 0);
  const percent = total > 0 ? Math.min(100, Math.max(0, (completed / total) * 100)) : 0;
  const currentLabel = job?.progress?.currentEntity
    ? `${job.progress.currentEntity} (${Number(job.progress.currentEntityIndex || 0)}/${total || "?"})`
    : running
      ? "Preparing refresh..."
      : "No refresh running.";

  els.jobStatus.textContent = running ? "RUNNING" : status.toUpperCase();
  els.jobStatus.className = "pill";
  if (tone === "success") els.jobStatus.classList.add("is-success");
  if (tone === "warning") els.jobStatus.classList.add("is-warning");
  if (tone === "danger") els.jobStatus.classList.add("is-danger");

  els.jobProgressLabel.textContent = running ? currentLabel : job ? `Last run: ${status.toUpperCase()}` : "No refresh running.";
  els.jobProgressCount.textContent = total ? `${completed}/${total} entities · ${failed} failed · ${totalRows} holdings` : "0/0 entities";
  els.jobProgressFill.style.width = `${percent}%`;
  els.refreshButton.disabled = running;
  els.cancelButton.hidden = !running;
  els.cancelButton.disabled = !running;
  els.refreshButton.textContent = running ? "Running..." : "Run Analysis";

  if (!job) {
    els.activitySubtitle.textContent = "Run the refresh and watch live progress here.";
    els.logStream.innerHTML = '<div class="empty-note">No refresh logs yet.</div>';
    return;
  }

  const summary =
    running && currentLabel
      ? `Processing ${currentLabel}.`
      : status === "success"
        ? `Snapshot #${job.progress.snapshotId || "?"} finished successfully.`
        : status === "partial"
          ? `Snapshot #${job.progress.snapshotId || "?"} finished with partial failures.`
          : status === "canceled"
            ? "Refresh canceled."
            : job.progress.errorMessage || "Refresh failed.";
  els.activitySubtitle.textContent = summary;
  if (running) {
    els.heroMeta.textContent = `Refreshing ${currentLabel}. ${completed}/${total || "?"} entities complete · ${failed} failed.`;
  }

  const logs = Array.isArray(job.logs) ? job.logs.slice(-80) : [];
  els.logStream.innerHTML = logs.length
    ? logs
        .map(
          (entry) => `
            <div class="log-entry log-entry--${escapeHtml(entry.tone)}">
              <span class="log-entry__time">${escapeHtml(fmtDate(entry.at))}</span>
              <span class="log-entry__message">${escapeHtml(entry.message)}</span>
            </div>
          `,
        )
        .join("")
    : '<div class="empty-note">No refresh logs yet.</div>';

  if (running) {
    els.logStream.scrollTop = els.logStream.scrollHeight;
  }
}

async function syncRefreshStatus(options = {}) {
  const payload = await fetchJson("/api/refresh/status");
  const nextJob = payload.currentJob || payload.job || payload.latestJob || null;
  const wasRunning = Boolean(state.refreshJob?.running);
  state.refreshJob = nextJob;
  renderRefreshActivity();

  if (nextJob?.running) {
    startRefreshPolling();
  } else {
    stopRefreshPolling();
  }

  if (wasRunning && !nextJob?.running) {
    state.openTokenKey = null;
    state.holders.clear();
    const status = nextJob?.progress?.status;
    const totalRows = Number(nextJob?.progress?.totalRows || 0);
    if (nextJob?.progress?.snapshotId && (status === "success" || status === "partial" || totalRows > 0)) {
      state.selectedSnapshotId = Number(nextJob.progress.snapshotId) || state.selectedSnapshotId;
    }
    await loadSnapshots();
    if (state.selectedSnapshotId) {
      await loadOverview();
    }
    setBanner(
      nextJob?.progress?.status === "success"
        ? `Refresh complete. Snapshot #${nextJob.progress.snapshotId} is ready.`
        : nextJob?.progress?.status === "partial"
          ? `Refresh complete with partial failures. Snapshot #${nextJob.progress.snapshotId} is ready.`
          : nextJob?.progress?.status === "canceled"
            ? "Refresh canceled."
            : nextJob?.progress?.status === "failed" && Number(nextJob?.progress?.entitiesCompleted || 0) === 0
              ? "API doesn't respond, you might need to insert a new API."
              : nextJob?.progress?.errorMessage || "Refresh failed.",
      nextJob?.progress?.status === "success" ? "success" : nextJob?.progress?.status === "partial" ? "warning" : "danger",
    );
  }

  return nextJob;
}

function compareString(a, b, key) {
  return String(a?.[key] || "").localeCompare(String(b?.[key] || ""), undefined, {
    sensitivity: "base",
  });
}

function compareNumber(a, b, key) {
  return Number(a?.[key] || 0) - Number(b?.[key] || 0);
}

function getSortedRows(rows) {
  const direction = state.sortDir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const primary = compareNumber(a, b, state.sortKey);
    if (primary !== 0) return primary * direction;

    const holdingsFallback = compareNumber(a, b, "holdingsUsd");
    if (holdingsFallback !== 0) return holdingsFallback * -1;

    const smwFallback = compareNumber(a, b, "smwIn");
    if (smwFallback !== 0) return smwFallback * -1;

    return compareString(a, b, "tokenSymbol");
  });
}

function updateSortButtons() {
  for (const button of els.sortButtons) {
    const isActive = button.dataset.sortKey === state.sortKey;
    button.classList.toggle("is-active", isActive);
    const indicator = button.querySelector(".sort-indicator");
    if (indicator) {
      indicator.textContent = isActive ? (state.sortDir === "asc" ? "↑" : "↓") : "-";
    }
  }
}

function updateSummary(snapshot) {
  const status = snapshot?.status || "idle";
  els.summaryStatus.textContent = status.toUpperCase();
  els.summaryStatus.className = "pill";
  if (status === "success") els.summaryStatus.classList.add("is-success");
  if (status === "partial" || status === "running") els.summaryStatus.classList.add("is-warning");
  if (status === "failed" || status === "canceled") els.summaryStatus.classList.add("is-danger");

  els.summaryEntities.textContent = `${Number(snapshot?.entitiesCompleted || 0)}/${Number(snapshot?.totalEntities || 0)} entities`;
  els.summaryRows.textContent = `${Number(snapshot?.totalRows || 0)} holdings`;

  if (!snapshot) {
    els.heroMeta.textContent = "No snapshot yet. Paste a Zapper key and run the first analysis.";
    return;
  }

  const suffix =
    snapshot.status === "failed"
      ? snapshot.errorMessage || "Refresh failed"
      : snapshot.status === "partial"
        ? `${snapshot.entitiesFailed} entity fetches failed`
        : snapshot.status === "canceled"
          ? "Refresh canceled"
        : "Ready";

  els.heroMeta.textContent = `${fmtDate(snapshot.finishedAt || snapshot.createdAt)} · ${suffix}`;
}

function getSelectedSnapshot() {
  return state.snapshots.find((item) => item.id === state.selectedSnapshotId) || null;
}

function isUsableSnapshot(snapshot) {
  if (!snapshot) return false;
  if (Number(snapshot.totalRows || 0) > 0) return true;
  return snapshot.status === "success" || snapshot.status === "partial";
}

function chooseDefaultSnapshotId(preferredId = null) {
  const preferred = state.snapshots.find((snapshot) => snapshot.id === preferredId);
  if (isUsableSnapshot(preferred)) return preferred.id;

  const usable = state.snapshots.find(isUsableSnapshot);
  if (usable) return usable.id;

  return state.snapshots[0]?.id || null;
}

function renderSnapshots() {
  els.snapshotSelect.innerHTML = state.snapshots
    .map(
      (snapshot) => `
        <option value="${snapshot.id}" ${snapshot.id === state.selectedSnapshotId ? "selected" : ""}>
          #${snapshot.id} · ${fmtDate(snapshot.finishedAt || snapshot.createdAt)} · ${snapshot.status}
        </option>
      `,
    )
    .join("");
}

function buildDrilldownRows(tokenKey) {
  const rows = state.holders.get(tokenKey);
  if (!rows) {
    return `
      <tr class="drilldown-row">
        <td colspan="9">
          <div class="drilldown-panel">
            <div class="empty-note">Loading entity breakdown...</div>
          </div>
        </td>
      </tr>
    `;
  }

  return rows
    .map(
      (row) => `
        <tr class="drilldown-row drilldown-holder-row">
          <td></td>
          <td>
            <span class="drilldown-entity">${escapeHtml(row.entityName)}</span>
          </td>
          <td></td>
          <td></td>
          <td></td>
          <td></td>
          <td class="drilldown-balance">${escapeHtml(fmtUsd(row.balanceUsd))}</td>
          <td></td>
          <td></td>
        </tr>
      `,
    )
    .join("");
}

function renderTable() {
  const rows = getSortedRows(state.rows);
  els.tableStatus.textContent = `${rows.length} rows`;
  updateSortButtons();

  if (!rows.length) {
    els.tableBody.innerHTML = `
        <tr>
        <td colspan="9">
          <div class="drilldown-panel">
            <div class="empty-note">No token rows match the current snapshot and filters.</div>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  els.tableBody.innerHTML = rows
    .map((row) => {
      const isOpen = row.tokenKey === state.openTokenKey;
      const networkBadge = row.networkName ? `<span class="network-badge">${escapeHtml(row.networkName)}</span>` : "";
      const copyButton = row.tokenAddress
        ? `
            <button
              class="copy-contract-button"
              type="button"
              data-copy-contract="${escapeHtml(row.tokenAddress)}"
              data-copy-symbol="${escapeHtml(row.tokenSymbol)}"
              aria-label="Copy ${escapeHtml(row.tokenSymbol)} contract"
              title="Copy contract"
            >
              <span class="copy-contract-button__icon" aria-hidden="true"></span>
            </button>
          `
        : "";
      return `
        <tr class="signal-row ${isOpen ? "is-open" : ""}" data-token-key="${escapeHtml(row.tokenKey)}">
          <td class="ticker-cell">
            <div class="ticker-stack">
              <div class="ticker-mainline">
                <span class="ticker-main">${escapeHtml(row.tokenSymbol)}</span>
                ${copyButton}
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
          <td>${networkBadge || '<span class="chain-text">Unknown</span>'}</td>
          <td>${escapeHtml(fmtTokenAge(row.tokenAgeHours))}</td>
          <td>${buildMoniScoreCell(row)}</td>
          <td>${escapeHtml(fmtUsd(row.holdingsUsd))}</td>
          <td>${escapeHtml(String(row.smwIn))}</td>
          <td>
            <button class="danger-button" type="button" data-blacklist-key="${escapeHtml(row.tokenKey)}">
              Blacklist
            </button>
          </td>
        </tr>
        ${
          isOpen
            ? buildDrilldownRows(row.tokenKey)
            : ""
        }
      `;
    })
    .join("");
}

async function loadSnapshots() {
  const payload = await fetchJson("/api/snapshots");
  state.snapshots = Array.isArray(payload.snapshots) ? payload.snapshots : [];
  const selected = getSelectedSnapshot();
  if (!selected || !isUsableSnapshot(selected)) {
    state.selectedSnapshotId = chooseDefaultSnapshotId(payload.latest?.id || null);
  }
  renderSnapshots();
  updateSummary(getSelectedSnapshot() || payload.latest || null);
}

async function loadOverview() {
  if (!state.selectedSnapshotId) {
    state.rows = [];
    renderTable();
    return;
  }

  const minBalanceUsd = Number(els.minBalanceInput.value || 111);
  const minSmwIn = Number(els.minSmwInput.value || 1);
  const minLiquidityUsd = 11111;
  const params = new URLSearchParams({
    snapshotId: String(state.selectedSnapshotId),
    minBalanceUsd: String(minBalanceUsd),
    minSmwIn: String(minSmwIn),
    minLiquidityUsd: String(minLiquidityUsd),
  });
  const payload = await fetchJson(`/api/overview?${params.toString()}`);
  state.rows = Array.isArray(payload.rows) ? payload.rows : [];
  const snapshot = getSelectedSnapshot();
  els.tableSubtitle.textContent = `Snapshot #${state.selectedSnapshotId} filtered at ${fmtUsd(minBalanceUsd)} minimum entity balance, SMW In >= ${minSmwIn}, verified liquidity >= ${fmtUsd(minLiquidityUsd)}, 24h volume >= ${fmtUsd(1000)}, and 24h txns >= 11 when available.`;
  if (!state.rows.length && snapshot?.status === "canceled") {
    setBanner(`Snapshot #${snapshot.id} was canceled before matching holdings were saved. Select another snapshot or run analysis again.`, "warning");
  } else if (!state.rows.length && snapshot?.status === "failed") {
    setBanner(snapshot.errorMessage || `Snapshot #${snapshot.id} failed before matching holdings were saved.`, "danger");
  } else if (snapshot?.status === "running" && Number(snapshot.totalRows || 0) > 0) {
    setBanner(`Snapshot #${snapshot.id} is still running. Showing partial holdings saved so far.`, "warning");
  } else if (state.rows.length) {
    setBanner(null);
  }
  renderTable();
}

async function loadHolders(tokenKey) {
  if (state.holders.has(tokenKey)) return;
  const minBalanceUsd = Number(els.minBalanceInput.value || 111);
  const params = new URLSearchParams({
    snapshotId: String(state.selectedSnapshotId),
    tokenKey,
    minBalanceUsd: String(minBalanceUsd),
  });
  const payload = await fetchJson(`/api/token-holders?${params.toString()}`);
  state.holders.set(tokenKey, Array.isArray(payload.rows) ? payload.rows : []);
}

async function handleRefresh() {
  const apiKey = els.apiKeyInput.value.trim();
  if (!apiKey) {
    setBanner("Paste a Zapper API key before running the analysis.", "danger");
    return;
  }

  localStorage.setItem("dex.zapperApiKey", apiKey);
  setBanner("Refresh started. Watching live progress below...", "warning");

  try {
    await fetchJson("/api/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey }),
    });
    state.openTokenKey = null;
    state.holders.clear();
    await syncRefreshStatus({ silent: true });
    startRefreshPolling();
  } catch (error) {
    setBanner(error.message, "danger");
  }
}

async function handleCancel() {
  try {
    await fetchJson("/api/refresh/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    setBanner("Cancel requested. Waiting for the running refresh to stop...", "warning");
    await syncRefreshStatus({ silent: true });
  } catch (error) {
    setBanner(error.message, "danger");
  }
}

document.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  const copyButton = target.closest("[data-copy-contract]");
  if (copyButton instanceof HTMLElement) {
    event.stopPropagation();
    const contract = copyButton.dataset.copyContract;
    const symbol = copyButton.dataset.copySymbol || "Token";
    if (!contract) return;
    try {
      await navigator.clipboard.writeText(contract);
      setBanner(`${symbol} contract copied to clipboard.`, "success");
    } catch (_error) {
      setBanner("Copy failed. Your browser blocked clipboard access.", "danger");
    }
    return;
  }

  const sortButton = target.closest("[data-sort-key]");
  if (sortButton instanceof HTMLElement) {
    const key = sortButton.dataset.sortKey;
    if (!key) return;
    if (state.sortKey === key) {
      state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
    } else {
      state.sortKey = key;
      state.sortDir = "desc";
    }
    renderTable();
    return;
  }

  const blacklistButton = target.closest("[data-blacklist-key]");
  if (blacklistButton instanceof HTMLElement) {
    event.stopPropagation();
    const tokenKey = blacklistButton.dataset.blacklistKey;
    const row = state.rows.find((item) => item.tokenKey === tokenKey);
    if (!row) return;
    await fetchJson("/api/blacklist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tokenKey: row.tokenKey,
        tokenSymbol: row.tokenSymbol,
        tokenName: row.tokenName,
        networkName: row.networkName,
        chainId: row.chainId,
        tokenAddress: row.tokenAddress,
        reason: "Manual blacklist from dashboard",
      }),
    });
    state.openTokenKey = null;
    state.holders.delete(row.tokenKey);
    await loadOverview();
    setBanner(`${row.tokenSymbol} blacklisted. It will stay hidden until restored.`, "success");
    return;
  }

  const row = target.closest("[data-token-key]");
  if (row instanceof HTMLElement) {
    const tokenKey = row.dataset.tokenKey;
    if (!tokenKey) return;
    state.openTokenKey = state.openTokenKey === tokenKey ? null : tokenKey;
    renderTable();
    if (state.openTokenKey === tokenKey) {
      await loadHolders(tokenKey);
      renderTable();
    }
  }
});

els.refreshButton.addEventListener("click", handleRefresh);
els.cancelButton.addEventListener("click", handleCancel);
els.snapshotSelect.addEventListener("change", async () => {
  state.selectedSnapshotId = Number(els.snapshotSelect.value || 0) || null;
  state.openTokenKey = null;
  state.holders.clear();
  updateSummary(getSelectedSnapshot());
  await loadOverview();
});

els.minBalanceInput.addEventListener("change", async () => {
  state.openTokenKey = null;
  state.holders.clear();
  await loadOverview();
});

els.minSmwInput.addEventListener("change", async () => {
  state.openTokenKey = null;
  await loadOverview();
});

async function init() {
  const storedApiKey = localStorage.getItem("dex.zapperApiKey");
  if (storedApiKey) {
    els.apiKeyInput.value = storedApiKey;
  }

  try {
    renderRefreshActivity();
    await syncRefreshStatus({ silent: true });
    await loadSnapshots();
    await loadOverview();
  } catch (error) {
    setBanner(error.message, "danger");
  }
}

init();

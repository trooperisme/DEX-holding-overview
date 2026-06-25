const els = {
  heroMeta: document.getElementById("hero-meta"),
  refreshButton: document.getElementById("refresh-button"),
  cancelButton: document.getElementById("cancel-button"),
  snapshotSelect: document.getElementById("snapshot-select"),
  minBalanceInput: document.getElementById("min-balance-input"),
  minSmwInput: document.getElementById("min-smw-input"),
  maxMarketCapInput: document.getElementById("max-market-cap-input"),
  applyMarketCapButton: document.getElementById("apply-market-cap-button"),
  resetMarketCapButton: document.getElementById("reset-market-cap-button"),
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
  chartTooltip: document.getElementById("chart-tooltip"),
  sortButtons: Array.from(document.querySelectorAll("[data-sort-key]")),
};

const state = {
  snapshots: [],
  selectedSnapshotId: null,
  rows: [],
  openTokenKey: null,
  activeDrilldownTab: "holders",
  holders: new Map(),
  scoreHistory: new Map(),
  holderErrors: new Map(),
  scoreHistoryErrors: new Map(),
  loadingHolders: new Set(),
  loadingScoreHistory: new Set(),
  trendWindow: 10,
  trendScale: "log",
  sortKey: "score",
  sortDir: "desc",
  maxMarketCapUsd: null,
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

function getDisplayTokenName(row) {
  const rawName = String(row?.tokenName || "").trim();
  const fallback = String(row?.tokenSymbol || "Unknown token").trim() || "Unknown token";
  const tokenKeyAddress = String(row?.tokenKey || "").split(":").pop() || "";
  const tokenAddressCandidates = [
    String(row?.tokenAddress || "").trim(),
    tokenKeyAddress.trim(),
  ].filter(Boolean);

  if (!rawName) return fallback;

  for (const tokenAddress of tokenAddressCandidates) {
    if (rawName.toLowerCase().endsWith(tokenAddress.toLowerCase())) {
      const stripped = rawName.slice(0, -tokenAddress.length).trim();
      return stripped || fallback;
    }
  }

  const pumpMintSuffix = rawName.match(/[1-9A-HJ-NP-Za-km-z]{32,44}pump$/);
  if (pumpMintSuffix && pumpMintSuffix.index && pumpMintSuffix.index > 0) {
    const stripped = rawName.slice(0, pumpMintSuffix.index).trim();
    return stripped || fallback;
  }

  const symbol = String(row?.tokenSymbol || "").trim();
  if (symbol && rawName.includes(symbol)) {
    const suffixAfterSymbol = rawName.slice(rawName.lastIndexOf(symbol) + symbol.length);
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(suffixAfterSymbol)) {
      return rawName.slice(0, rawName.length - suffixAfterSymbol.length).trim() || fallback;
    }
  }

  return rawName;
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

function fmtScore(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return "—";
  if (numeric >= 1_000_000) return `${(numeric / 1_000_000).toFixed(1)}M`;
  if (numeric >= 1_000) return `${(numeric / 1_000).toFixed(1)}k`;
  return Math.round(numeric).toLocaleString("en-US");
}

function getMetricMax(rows, key) {
  return rows.reduce((max, row) => {
    const numeric = Number(row?.[key]);
    return Number.isFinite(numeric) && numeric > max ? numeric : max;
  }, 0);
}

function buildMetricCell(value, max, formatter) {
  const numeric = Number(value);
  const width = Number.isFinite(numeric) && numeric > 0 && max > 0
    ? Math.min(100, (numeric / max) * 100)
    : 0;
  const intensity = width > 0 ? Math.max(0.18, Math.min(0.72, width / 100)) : 0;
  const bar = width > 0
    ? `<span class="metric-cell__bar" style="width: ${width.toFixed(3)}%; --metric-intensity: ${intensity.toFixed(3)}" aria-hidden="true"></span>`
    : "";

  return `${bar}<span class="metric-cell__value">${escapeHtml(formatter(value))}</span>`;
}

function parseMarketCapFilterInput() {
  const numeric = Number(els.maxMarketCapInput.value || 0);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function clearOpenRows() {
  state.openTokenKey = null;
  state.activeDrilldownTab = "holders";
  state.holders.clear();
  state.scoreHistory.clear();
  state.holderErrors.clear();
  state.scoreHistoryErrors.clear();
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

function fmtDateShort(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function fmtTokenAge(value) {
  if (value == null || !Number.isFinite(Number(value))) return "Pending";
  const numeric = Number(value);
  if (numeric < 24) return `${numeric.toFixed(1)}h`;
  return `${(numeric / 24).toFixed(1)}d`;
}

function fmtDeltaPct(value) {
  if (value == null) return "—";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "—";
  const sign = numeric > 0 ? "+" : "";
  return `${sign}${numeric.toFixed(1)}%`;
}

function fmtMoniScoreValue(value) {
  if (value == null) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  if (numeric < 1000) return Math.round(numeric).toLocaleString("en-US");
  return `${Math.round(numeric / 1000).toLocaleString("en-US")}k`;
}

function safeNumber(value, fallback = 0) {
  if (value == null || value === "") return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function smwBreadthMultiplier(smwInRaw) {
  const smwIn = safeNumber(smwInRaw, 0);
  if (smwIn <= 0) return 0.75;
  if (smwIn === 1) return 0.9;
  if (smwIn === 2) return 1.15;
  if (smwIn === 3) return 1.35;
  if (smwIn <= 5) return 1.55;
  if (smwIn <= 10) return 1.8;
  if (smwIn <= 20) return 2.05;
  return 2.3;
}

function moniSocialMultiplier(row) {
  const level = safeNumber(row.moniLevel, NaN);
  const momentumPct = safeNumber(row.moniMomentumScorePct, NaN);
  const momentumRank = safeNumber(row.moniMomentumRank, NaN);

  if (!Number.isFinite(level) && !Number.isFinite(momentumPct)) return 1.0;

  let quality = 1.0;
  if (Number.isFinite(level)) {
    if (level <= 1) quality = 0.85;
    else if (level === 2) quality = 0.95;
    else if (level === 3) quality = 1.05;
    else if (level === 4) quality = 1.15;
    else if (level === 5) quality = 1.25;
    else if (level === 6) quality = 1.4;
    else if (level >= 7) quality = 1.55;
  }

  let momentum = 1.0;
  if (Number.isFinite(momentumPct)) {
    if (momentumPct <= 0) momentum = 1.0;
    else if (momentumPct < 100) momentum = 1.1;
    else if (momentumPct < 300) momentum = 1.25;
    else if (momentumPct < 700) momentum = 1.4;
    else momentum = 1.6;
  }

  if (Number.isFinite(momentumRank) && momentumRank > 0) {
    if (momentumRank <= 100) momentum += 0.2;
    else if (momentumRank <= 500) momentum += 0.15;
    else if (momentumRank <= 1000) momentum += 0.1;
    else if (momentumRank <= 5000) momentum += 0.05;
  }

  return Math.min(2.2, Math.max(0.75, quality * momentum));
}

function holdingsToMarketCapFootprintMultiplier(holdingsUsdRaw, marketCapRaw) {
  const holdingsUsd = safeNumber(holdingsUsdRaw, 0);
  const marketCap = safeNumber(marketCapRaw, 0);
  if (holdingsUsd <= 0 || marketCap <= 0) return 1.0;
  const pct = (holdingsUsd / marketCap) * 100;
  if (pct < 0.01) return 0.8;
  if (pct < 0.05) return 0.9;
  if (pct < 0.25) return 1.0;
  if (pct < 1.0) return 1.15;
  if (pct < 3.0) return 1.35;
  if (pct < 8.0) return 1.5;
  if (pct < 15.0) return 1.25;
  return 0.9;
}

function marketCapAsymmetryMultiplier(marketCapRaw) {
  const marketCap = safeNumber(marketCapRaw, 0);
  if (marketCap <= 0) return 0.85;
  if (marketCap < 100_000) return 0.7;
  if (marketCap < 1_000_000) return 1.05;
  if (marketCap < 10_000_000) return 1.35;
  if (marketCap < 50_000_000) return 1.25;
  if (marketCap < 200_000_000) return 1.05;
  if (marketCap < 1_000_000_000) return 0.75;
  return 0.45;
}

function tokenAgeMultiplier(tokenAgeHoursRaw) {
  const hours = safeNumber(tokenAgeHoursRaw, NaN);
  if (!Number.isFinite(hours)) return 0.95;
  const days = hours / 24;
  if (days < 1) return 0.7;
  if (days < 7) return 0.85;
  if (days < 30) return 1.0;
  if (days < 180) return 1.1;
  if (days < 730) return 1.0;
  return 0.85;
}

function scoreFactors(point) {
  return {
    holdingsUsd: safeNumber(point.holdingsUsd, 0),
    smwBreadth: smwBreadthMultiplier(point.smwIn),
    moniSocial: moniSocialMultiplier(point),
    footprint: holdingsToMarketCapFootprintMultiplier(point.holdingsUsd, point.marketCap),
    asymmetry: marketCapAsymmetryMultiplier(point.marketCap),
    age: tokenAgeMultiplier(point.tokenAgeHours),
  };
}

function factorRows(prev, current) {
  if (!prev) return [];
  const currFactors = scoreFactors(current);
  const prevFactors = scoreFactors(prev);
  const rows = [
    {
      label: "Holdings",
      before: fmtUsd(prev.holdingsUsd),
      after: fmtUsd(current.holdingsUsd),
      beforeValue: prevFactors.holdingsUsd,
      afterValue: currFactors.holdingsUsd,
    },
    {
      label: "SMW breadth",
      before: `${prev.smwIn ?? "—"} (${prevFactors.smwBreadth.toFixed(2)}x)`,
      after: `${current.smwIn ?? "—"} (${currFactors.smwBreadth.toFixed(2)}x)`,
      beforeValue: prevFactors.smwBreadth,
      afterValue: currFactors.smwBreadth,
    },
    {
      label: "Market cap footprint",
      before: `${fmtUsdOrDash(prev.marketCap)} (${prevFactors.footprint.toFixed(2)}x)`,
      after: `${fmtUsdOrDash(current.marketCap)} (${currFactors.footprint.toFixed(2)}x)`,
      beforeValue: prevFactors.footprint,
      afterValue: currFactors.footprint,
    },
    {
      label: "Asymmetry",
      before: `${fmtUsdOrDash(prev.marketCap)} (${prevFactors.asymmetry.toFixed(2)}x)`,
      after: `${fmtUsdOrDash(current.marketCap)} (${currFactors.asymmetry.toFixed(2)}x)`,
      beforeValue: prevFactors.asymmetry,
      afterValue: currFactors.asymmetry,
    },
    {
      label: "MONI",
      before: prev.moniScore == null ? "Pending" : `${fmtMoniScoreValue(prev.moniScore)} · ${String(prev.moniLevelName || "—")}`,
      after: current.moniScore == null ? "Pending" : `${fmtMoniScoreValue(current.moniScore)} · ${String(current.moniLevelName || "—")}`,
      beforeValue: prevFactors.moniSocial,
      afterValue: currFactors.moniSocial,
    },
    {
      label: "Token age",
      before: fmtTokenAge(prev.tokenAgeHours),
      after: fmtTokenAge(current.tokenAgeHours),
      beforeValue: prevFactors.age,
      afterValue: currFactors.age,
    },
  ];

  return rows
    .map((row) => {
      const delta = row.afterValue / Math.max(0.0001, row.beforeValue);
      const deltaPct = (delta - 1) * 100;
      return {
        ...row,
        deltaPct,
        direction: deltaPct > 0 ? "positive" : deltaPct < 0 ? "negative" : "",
      };
    })
    .sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct));
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
    clearOpenRows();
    if (nextJob?.progress?.snapshotId) {
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

function getPointTime(point) {
  return point.snapshotFinishedAt || point.snapshotCreatedAt;
}

function getVisibleTrendPoints(points) {
  return state.trendWindow === "all" ? points : points.slice(-Number(state.trendWindow || 10));
}

function getScoreDeltaPct(previous, current) {
  const previousScore = Number(previous?.score || 0);
  if (!previousScore) return null;
  return ((Number(current?.score || 0) - previousScore) / previousScore) * 100;
}

function buildScoreChart(points, tokenKey) {
  const width = 760;
  const height = 230;
  const padding = { top: 24, right: 26, bottom: 38, left: 68 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const scores = points.map((point) => Math.max(1, Number(point.score || 0))).filter((score) => Number.isFinite(score));
  const transform = state.trendScale === "log" ? (score) => Math.log10(Math.max(1, score)) : (score) => score;
  const inverse = state.trendScale === "log" ? (value) => 10 ** value : (value) => value;
  const transformedScores = scores.map(transform);
  const rawMin = Math.min(...transformedScores);
  const rawMax = Math.max(...transformedScores);
  const rawSpread = rawMax - rawMin;
  const paddingValue = rawSpread > 0 ? rawSpread * 0.12 : Math.max(1, Math.abs(rawMax) * 0.08);
  const minScore = rawMin - paddingValue;
  const maxScore = rawMax + paddingValue;
  const spread = Math.max(0.0001, maxScore - minScore);
  const xFor = (index) => padding.left + (points.length <= 1 ? chartWidth / 2 : (index / (points.length - 1)) * chartWidth);
  const yFor = (score) => padding.top + chartHeight - ((transform(Number(score || 0)) - minScore) / spread) * chartHeight;
  const pathPoints = points.map((point, index) => `${xFor(index).toFixed(2)},${yFor(point.score).toFixed(2)}`).join(" ");
  const yTicks = [maxScore, minScore + spread / 2, minScore].map(inverse);
  const xLabels = points.length > 6
    ? points.filter((_, index) => index === 0 || index === points.length - 1 || index === Math.floor((points.length - 1) / 2))
    : points;

  return `
    <svg class="score-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Score trend chart using ${escapeHtml(state.trendScale)} scale">
      <line class="score-chart__axis" x1="${padding.left}" y1="${padding.top + chartHeight}" x2="${padding.left + chartWidth}" y2="${padding.top + chartHeight}"></line>
      ${yTicks
        .map((tick) => {
          const y = yFor(tick);
          return `
            <line class="score-chart__grid" x1="${padding.left}" y1="${y.toFixed(2)}" x2="${padding.left + chartWidth}" y2="${y.toFixed(2)}"></line>
            <text class="score-chart__label" x="${padding.left - 14}" y="${(y + 4).toFixed(2)}" text-anchor="end">${escapeHtml(fmtScore(tick))}</text>
          `;
        })
        .join("")}
      <polyline class="score-chart__line" points="${pathPoints}"></polyline>
      ${points
        .map((point, index) => {
          const x = xFor(index);
          const y = yFor(point.score);
          return `
            <circle
              class="score-chart__dot"
              cx="${x.toFixed(2)}"
              cy="${y.toFixed(2)}"
              r="5"
              tabindex="0"
              data-chart-token-key="${escapeHtml(tokenKey)}"
              data-chart-snapshot-id="${escapeHtml(point.snapshotId)}"
            >
              <title>Snapshot #${escapeHtml(point.snapshotId)} · ${escapeHtml(fmtDate(getPointTime(point)))} · ${escapeHtml(fmtScore(point.score))}</title>
            </circle>
          `;
        })
        .join("")}
      ${xLabels
        .map((point, index) => {
          const originalIndex = points.indexOf(point);
          const x = xFor(originalIndex);
          return `
            <text class="score-chart__label" x="${x.toFixed(2)}" y="${height - 11}" text-anchor="${index === 0 ? "start" : index === xLabels.length - 1 ? "end" : "middle"}">
              #${escapeHtml(point.snapshotId)} · ${escapeHtml(fmtDateShort(getPointTime(point)))}
            </text>
          `;
        })
        .join("")}
    </svg>
  `;
}

function buildDriverExplanation(previous, latest) {
  const drivers = factorRows(previous, latest);
  if (!drivers.length) {
    return `
      <section class="trend-explain">
        <div>
          <h4>What moved</h4>
          <p>At least two snapshots are required to explain the latest score change.</p>
        </div>
      </section>
    `;
  }

  return `
    <section class="trend-explain">
      <div class="trend-explain__header">
        <div>
          <h4>What moved</h4>
          <p>Latest snapshot versus previous snapshot. Ranked by estimated scoring impact.</p>
        </div>
        <span>#${escapeHtml(previous.snapshotId)} → #${escapeHtml(latest.snapshotId)}</span>
      </div>
      <div class="trend-driver-grid">
        ${drivers
          .map(
            (driver) => `
              <article class="trend-driver trend-driver--${escapeHtml(driver.direction || "flat")}">
                <div class="trend-driver__title">
                  <strong>${escapeHtml(driver.label)}</strong>
                  <span>${escapeHtml(fmtDeltaPct(driver.deltaPct))}</span>
                </div>
                <p>${escapeHtml(driver.before)} → ${escapeHtml(driver.after)}</p>
              </article>
            `,
          )
          .join("")}
      </div>
    </section>
  `;
}

function buildScoreTrendPanel(tokenKey) {
  const points = state.scoreHistory.get(tokenKey);
  const error = state.scoreHistoryErrors.get(tokenKey);
  if (error) {
    return `
      <div class="trend-panel">
        <div class="empty-note empty-note--error">Could not load score trend: ${escapeHtml(error)}</div>
      </div>
    `;
  }
  if (!points) {
    return `
      <div class="trend-panel">
        <div class="empty-note">Loading score trend...</div>
      </div>
    `;
  }
  if (!points.length) {
    return `
      <div class="trend-panel">
        <div class="empty-note">No historical score points found for this token yet.</div>
      </div>
    `;
  }

  const latest = points.at(-1);
  const previous = points.at(-2);
  const visiblePoints = getVisibleTrendPoints(points);
  const deltaPct = getScoreDeltaPct(previous, latest);
  const deltaClass = Number(deltaPct) > 0 ? "is-positive" : Number(deltaPct) < 0 ? "is-negative" : "";
  const windowLabel = state.trendWindow === "all" ? "All" : `Last ${state.trendWindow}`;

  return `
    <div class="trend-panel">
      <div class="trend-panel__header">
        <div>
          <h3>Score Trend</h3>
          <p>Showing ${visiblePoints.length} of ${points.length} snapshot point${points.length === 1 ? "" : "s"} · manual refresh history</p>
        </div>
        <div class="trend-stats">
          <span>${escapeHtml(fmtScore(latest.score))}</span>
          <strong class="${deltaClass}">${escapeHtml(fmtDeltaPct(deltaPct))}</strong>
        </div>
      </div>
      <div class="trend-actions" aria-label="Score trend display controls">
        <div class="trend-toggle">
          <span>Range</span>
          <button type="button" data-trend-window="10" class="${state.trendWindow === 10 ? "is-active" : ""}">Last 10</button>
          <button type="button" data-trend-window="all" class="${state.trendWindow === "all" ? "is-active" : ""}">All</button>
        </div>
        <div class="trend-toggle">
          <span>Scale</span>
          <button type="button" data-trend-scale="log" class="${state.trendScale === "log" ? "is-active" : ""}">Log</button>
          <button type="button" data-trend-scale="linear" class="${state.trendScale === "linear" ? "is-active" : ""}">Linear</button>
        </div>
        <span class="trend-actions__meta">${escapeHtml(windowLabel)} · ${escapeHtml(state.trendScale)} scale</span>
      </div>
      ${buildScoreChart(visiblePoints, tokenKey)}
      ${buildDriverExplanation(previous, latest)}
    </div>
  `;
}

function buildDrilldownSummary(tokenKey) {
  const points = state.scoreHistory.get(tokenKey);
  if (!points?.length) return "";

  const latest = points.at(-1);
  const previous = points.at(-2);
  const deltaPct = getScoreDeltaPct(previous, latest);
  const deltaClass = Number(deltaPct) > 0 ? "is-positive" : Number(deltaPct) < 0 ? "is-negative" : "";

  return `
    <div class="drilldown-summary">
      <span>${escapeHtml(fmtScore(latest.score))}</span>
      <strong class="${deltaClass}">${escapeHtml(fmtDeltaPct(deltaPct))}</strong>
    </div>
  `;
}

function buildHolderPanel(tokenKey) {
  const rows = state.holders.get(tokenKey);
  const holderError = state.holderErrors.get(tokenKey);

  if (!rows) {
    return `
      <div class="empty-note ${holderError ? "empty-note--error" : ""}">
        ${holderError ? `Could not load entity breakdown: ${escapeHtml(holderError)}` : "Loading entity breakdown..."}
      </div>
    `;
  }

  if (!rows.length) {
    return '<div class="empty-note">No entity holders match the current filters.</div>';
  }

  return `
    <div class="holder-list">
      ${rows
        .map(
          (row) => `
            <div class="holder-list__row">
              <span class="drilldown-entity">${escapeHtml(row.entityName)}</span>
              <span class="drilldown-balance">${escapeHtml(fmtUsd(row.balanceUsd))}</span>
            </div>
          `,
        )
        .join("")}
    </div>
  `;
}

function buildDrilldownRows(tokenKey) {
  const row = state.rows.find((item) => item.tokenKey === tokenKey);
  const activeTab = state.activeDrilldownTab === "trend" ? "trend" : "holders";
  const title = row ? `${row.tokenSymbol} · ${getDisplayTokenName(row)}` : "Token Detail";
  const body = activeTab === "trend" ? buildScoreTrendPanel(tokenKey) : buildHolderPanel(tokenKey);

  return `
    <tr class="drilldown-row">
      <td colspan="10">
        <div class="drilldown-panel drilldown-detail">
          <div class="drilldown-detail__header">
            <div>
              <h3>${escapeHtml(title)}</h3>
              <div class="drilldown-tabs" role="tablist" aria-label="Token detail tabs">
                <button
                  type="button"
                  role="tab"
                  aria-selected="${activeTab === "holders"}"
                  data-drilldown-tab="holders"
                  class="${activeTab === "holders" ? "is-active" : ""}"
                >
                  Holders
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected="${activeTab === "trend"}"
                  data-drilldown-tab="trend"
                  class="${activeTab === "trend" ? "is-active" : ""}"
                >
                  Score Trend
                </button>
              </div>
            </div>
            ${buildDrilldownSummary(tokenKey)}
          </div>
          <div class="drilldown-detail__body">
            ${body}
          </div>
        </div>
      </td>
    </tr>
  `;
}

function renderTable() {
  const rows = getSortedRows(state.rows);
  const scoreMax = getMetricMax(state.rows, "score");
  const holdingsUsdMax = getMetricMax(state.rows, "holdingsUsd");
  const smwInMax = getMetricMax(state.rows, "smwIn");
  els.tableStatus.textContent = `${rows.length} rows`;
  updateSortButtons();

  if (!rows.length) {
    els.tableBody.innerHTML = `
        <tr>
        <td colspan="10">
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
      const displayTokenName = getDisplayTokenName(row);
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
              <strong title="${escapeHtml(displayTokenName)}">${escapeHtml(displayTokenName)}</strong>
              <span>Click to view score trend and entity holders</span>
            </div>
          </td>
          <td class="metric-cell">${buildMetricCell(row.score, scoreMax, fmtScore)}</td>
          <td>${escapeHtml(fmtUsdOrDash(row.marketCap))}</td>
          <td>${networkBadge || '<span class="chain-text">Unknown</span>'}</td>
          <td>${escapeHtml(fmtTokenAge(row.tokenAgeHours))}</td>
          <td>${buildMoniScoreCell(row)}</td>
          <td class="metric-cell">${buildMetricCell(row.holdingsUsd, holdingsUsdMax, fmtUsd)}</td>
          <td class="metric-cell">${buildMetricCell(row.smwIn, smwInMax, String)}</td>
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

  const selectedSnapshot = state.snapshots.find((item) => item.id === state.selectedSnapshotId) || null;
  const selectedSnapshotIsEmptyFailure =
    selectedSnapshot?.status === "failed" && Number(selectedSnapshot.totalRows || 0) === 0;

  if ((!state.selectedSnapshotId || !selectedSnapshot || selectedSnapshotIsEmptyFailure) && payload.latest?.id) {
    state.selectedSnapshotId = payload.latest.id;
  }
  renderSnapshots();
  updateSummary(state.snapshots.find((item) => item.id === state.selectedSnapshotId) || payload.latest || null);
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
  if (state.maxMarketCapUsd) {
    params.set("maxMarketCapUsd", String(state.maxMarketCapUsd));
  }
  const payload = await fetchJson(`/api/overview?${params.toString()}`);
  state.rows = Array.isArray(payload.rows) ? payload.rows : [];
  const marketCapConstraint = state.maxMarketCapUsd
    ? `Market cap < ${fmtUsd(state.maxMarketCapUsd)}; unknown market cap included`
    : "no market cap constraint";
  els.tableSubtitle.textContent = `Snapshot #${state.selectedSnapshotId} filtered at ${fmtUsd(minBalanceUsd)} minimum entity balance, SMW In >= ${minSmwIn}, verified liquidity >= ${fmtUsd(minLiquidityUsd)}, 24h volume >= ${fmtUsd(1000)}, 24h txns >= 11 when available, and ${marketCapConstraint}.`;
  renderTable();
}

async function loadHolders(tokenKey) {
  if (state.holders.has(tokenKey) || state.loadingHolders.has(tokenKey)) return;
  state.loadingHolders.add(tokenKey);
  state.holderErrors.delete(tokenKey);
  const minBalanceUsd = Number(els.minBalanceInput.value || 111);
  const params = new URLSearchParams({
    snapshotId: String(state.selectedSnapshotId),
    tokenKey,
    minBalanceUsd: String(minBalanceUsd),
  });
  try {
    const payload = await fetchJson(`/api/token-holders?${params.toString()}`);
    state.holders.set(tokenKey, Array.isArray(payload.rows) ? payload.rows : []);
  } catch (error) {
    state.holderErrors.set(tokenKey, error instanceof Error ? error.message : "Unexpected error");
  } finally {
    state.loadingHolders.delete(tokenKey);
    if (state.openTokenKey === tokenKey) renderTable();
  }
}

async function loadScoreHistory(tokenKey) {
  if (state.scoreHistory.has(tokenKey) || state.loadingScoreHistory.has(tokenKey)) return;
  state.loadingScoreHistory.add(tokenKey);
  state.scoreHistoryErrors.delete(tokenKey);
  const minBalanceUsd = Number(els.minBalanceInput.value || 111);
  const params = new URLSearchParams({
    tokenKey,
    minBalanceUsd: String(minBalanceUsd),
  });
  try {
    const payload = await fetchJson(`/api/token-score-history?${params.toString()}`);
    state.scoreHistory.set(tokenKey, Array.isArray(payload.rows) ? payload.rows : []);
  } catch (error) {
    state.scoreHistoryErrors.set(tokenKey, error instanceof Error ? error.message : "Unexpected error");
  } finally {
    state.loadingScoreHistory.delete(tokenKey);
    if (state.openTokenKey === tokenKey) renderTable();
  }
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
    clearOpenRows();
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

  const trendWindowButton = target.closest("[data-trend-window]");
  if (trendWindowButton instanceof HTMLElement) {
    event.stopPropagation();
    state.trendWindow = trendWindowButton.dataset.trendWindow === "all" ? "all" : 10;
    renderTable();
    return;
  }

  const trendScaleButton = target.closest("[data-trend-scale]");
  if (trendScaleButton instanceof HTMLElement) {
    event.stopPropagation();
    state.trendScale = trendScaleButton.dataset.trendScale === "linear" ? "linear" : "log";
    renderTable();
    return;
  }

  const drilldownTabButton = target.closest("[data-drilldown-tab]");
  if (drilldownTabButton instanceof HTMLElement) {
    event.stopPropagation();
    state.activeDrilldownTab = drilldownTabButton.dataset.drilldownTab === "trend" ? "trend" : "holders";
    renderTable();
    if (state.activeDrilldownTab === "trend" && state.openTokenKey) {
      void loadScoreHistory(state.openTokenKey);
    }
    return;
  }

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
    state.scoreHistory.delete(row.tokenKey);
    state.holderErrors.delete(row.tokenKey);
    state.scoreHistoryErrors.delete(row.tokenKey);
    await loadOverview();
    setBanner(`${row.tokenSymbol} blacklisted. It will stay hidden until restored.`, "success");
    return;
  }

  const row = target.closest("[data-token-key]");
  if (row instanceof HTMLElement) {
    const tokenKey = row.dataset.tokenKey;
    if (!tokenKey) return;
    const nextOpenTokenKey = state.openTokenKey === tokenKey ? null : tokenKey;
    const tokenChanged = nextOpenTokenKey && nextOpenTokenKey !== state.openTokenKey;
    state.openTokenKey = nextOpenTokenKey;
    if (tokenChanged) {
      state.activeDrilldownTab = "trend";
    }
    renderTable();
    if (state.openTokenKey === tokenKey) {
      void loadHolders(tokenKey);
      void loadScoreHistory(tokenKey);
    }
  }
});

function hideChartTooltip() {
  if (!els.chartTooltip) return;
  els.chartTooltip.hidden = true;
}

function showChartTooltip(dot, event) {
  if (!els.chartTooltip) return;
  const tokenKey = dot.getAttribute("data-chart-token-key");
  const snapshotId = Number(dot.getAttribute("data-chart-snapshot-id"));
  const points = state.scoreHistory.get(tokenKey) || [];
  const pointIndex = points.findIndex((point) => Number(point.snapshotId) === snapshotId);
  const point = points[pointIndex];
  if (!point) return;
  const deltaPct = getScoreDeltaPct(points[pointIndex - 1], point);
  const deltaClass = Number(deltaPct) > 0 ? "is-positive" : Number(deltaPct) < 0 ? "is-negative" : "";

  els.chartTooltip.innerHTML = `
    <div class="chart-tooltip__header">
      <strong>Snapshot #${escapeHtml(point.snapshotId)}</strong>
      <span>${escapeHtml(fmtDate(getPointTime(point)))}</span>
    </div>
    <div class="chart-tooltip__score">
      <span>Score</span>
      <strong>${escapeHtml(fmtScore(point.score))}</strong>
    </div>
    <dl>
      <div><dt>Δ vs previous</dt><dd class="${deltaClass}">${escapeHtml(fmtDeltaPct(deltaPct))}</dd></div>
      <div><dt>Holdings</dt><dd>${escapeHtml(fmtUsd(point.holdingsUsd))}</dd></div>
      <div><dt>SMW In</dt><dd>${escapeHtml(point.smwIn)}</dd></div>
      <div><dt>Market Cap</dt><dd>${escapeHtml(fmtUsdOrDash(point.marketCap))}</dd></div>
      <div><dt>MONI</dt><dd>${escapeHtml(fmtMoniScoreValue(point.moniScore) || "Pending")}</dd></div>
    </dl>
  `;
  els.chartTooltip.hidden = false;

  const margin = 14;
  const rect = els.chartTooltip.getBoundingClientRect();
  const x = Math.min(window.innerWidth - rect.width - margin, Math.max(margin, event.clientX + margin));
  const y = Math.min(window.innerHeight - rect.height - margin, Math.max(margin, event.clientY + margin));
  els.chartTooltip.style.left = `${x}px`;
  els.chartTooltip.style.top = `${y}px`;
}

document.addEventListener("pointermove", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const dot = target.closest("[data-chart-snapshot-id]");
  if (dot) {
    showChartTooltip(dot, event);
  } else {
    hideChartTooltip();
  }
});

document.addEventListener("focusin", (event) => {
  const target = event.target;
  if (!(target instanceof Element) || !target.matches("[data-chart-snapshot-id]")) return;
  const rect = target.getBoundingClientRect();
  showChartTooltip(target, { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 });
});

document.addEventListener("focusout", hideChartTooltip);

els.refreshButton.addEventListener("click", handleRefresh);
els.cancelButton.addEventListener("click", handleCancel);
els.snapshotSelect.addEventListener("change", async () => {
  state.selectedSnapshotId = Number(els.snapshotSelect.value || 0) || null;
  clearOpenRows();
  updateSummary(state.snapshots.find((item) => item.id === state.selectedSnapshotId) || null);
  await loadOverview();
});

els.minBalanceInput.addEventListener("change", async () => {
  clearOpenRows();
  await loadOverview();
});

els.minSmwInput.addEventListener("change", async () => {
  clearOpenRows();
  await loadOverview();
});

els.applyMarketCapButton.addEventListener("click", async () => {
  state.maxMarketCapUsd = parseMarketCapFilterInput();
  clearOpenRows();
  await loadOverview();
});

els.resetMarketCapButton.addEventListener("click", async () => {
  els.maxMarketCapInput.value = "";
  state.maxMarketCapUsd = null;
  clearOpenRows();
  await loadOverview();
});

els.maxMarketCapInput.addEventListener("keydown", async (event) => {
  if (event.key !== "Enter") return;
  state.maxMarketCapUsd = parseMarketCapFilterInput();
  clearOpenRows();
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

const els = {
  list: document.getElementById("blacklist-list"),
  status: document.getElementById("blacklist-status"),
  banner: document.getElementById("blacklist-banner"),
  heroMeta: document.getElementById("blacklist-hero-meta"),
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setBanner(message, tone = "warning") {
  if (!message) {
    els.banner.hidden = true;
    els.banner.textContent = "";
    return;
  }
  els.banner.hidden = false;
  els.banner.textContent = message;
  els.banner.dataset.tone = tone;
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
    throw new Error(payload.error || `${response.status} ${response.statusText}`);
  }
  return payload;
}

function renderList(rows) {
  els.status.textContent = `${rows.length} rows`;
  els.heroMeta.textContent = rows.length
    ? `${rows.length} tokens are currently hidden from the DEX overview until restored.`
    : "No blacklisted tokens right now.";

  if (!rows.length) {
    els.list.innerHTML = '<div class="empty-note">No blacklisted tokens yet.</div>';
    return;
  }

  els.list.innerHTML = rows
    .map(
      (row) => `
        <div class="blacklist-item">
          <div>
            <strong>${escapeHtml(row.tokenSymbol)}</strong>
            <div class="side-note">${escapeHtml(row.tokenName)} · ${escapeHtml(row.networkName)}</div>
          </div>
          <button class="ghost-button" type="button" data-restore-id="${row.id}">Restore</button>
        </div>
      `,
    )
    .join("");
}

async function loadBlacklist() {
  const payload = await fetchJson("/api/blacklist");
  renderList(Array.isArray(payload.rows) ? payload.rows : []);
}

document.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  const restoreButton = target.closest("[data-restore-id]");
  if (!(restoreButton instanceof HTMLElement)) return;

  const id = Number(restoreButton.dataset.restoreId || 0);
  if (!id) return;

  try {
    await fetchJson("/api/blacklist/restore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
    setBanner("Token restored from blacklist.", "success");
    await loadBlacklist();
  } catch (error) {
    setBanner(error.message, "danger");
  }
});

async function init() {
  try {
    await loadBlacklist();
  } catch (error) {
    setBanner(error.message, "danger");
  }
}

init();

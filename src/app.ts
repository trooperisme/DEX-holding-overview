import path from "node:path";
import crypto from "node:crypto";
import dotenv from "dotenv";
import express from "express";
import { createAuthRouter, createPasswordProtection } from "./auth";
import { fetchDexScreenerMarketData } from "./dexscreener";
import { createRefreshJobManager } from "./refresh-jobs";
import { resolveWorkspacePaths } from "./runtime-paths";
import { withOpportunityScore } from "./scoring";
import { getLatestUsableSnapshot } from "./snapshot-selection";
import { isRunningSnapshotStale } from "./snapshot-reconciliation";
import { createStorage } from "./storage";
import { fetchTrenchIndex } from "./trench-index";
import {
  SnapshotRecord,
  SnapshotStatus,
  TokenBlacklistRecord,
  TokenHolderRow,
} from "./types";

dotenv.config();

const app = express();
const cwd = process.cwd();
const paths = resolveWorkspacePaths(cwd);
const refreshJobs = createRefreshJobManager(cwd);

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(createAuthRouter());

function hasAtlasToken(req: express.Request): boolean {
  const expected = String(process.env.ATLAS_STATUS_TOKEN || "").trim();
  const authorization = String(req.get("authorization") || "");
  const provided = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
  if (!expected || !provided) return false;
  const expectedDigest = crypto.createHash("sha256").update(expected).digest();
  const providedDigest = crypto.createHash("sha256").update(provided).digest();
  return crypto.timingSafeEqual(expectedDigest, providedDigest);
}

function vietnamDay(value: string | null): string | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(time));
}

function todayInVietnam(): string {
  return vietnamDay(new Date().toISOString()) || "";
}

app.get("/api/atlas-status", async (req, res) => {
  if (!hasAtlasToken(req)) {
    res.status(401).json({ product: "dex", snapshotState: "unavailable" });
    return;
  }

  let storage: ReturnType<typeof createStorage> | null = null;
  try {
    storage = createStorage(cwd);
    const snapshots = await storage.getSnapshotSummaries();
    const latestSuccess = snapshots.find((snapshot) => snapshot.status === "success") || null;
    const completedAt = latestSuccess?.finishedAt || latestSuccess?.createdAt || null;
    res.set("Cache-Control", "no-store").json({
      product: "dex",
      snapshotState: vietnamDay(completedAt) === todayInVietnam() ? "fresh" : "missing",
    });
  } catch (error) {
    console.error("Atlas status check failed", error instanceof Error ? error.message : "Unknown storage error");
    res.status(503).set("Cache-Control", "no-store").json({ product: "dex", snapshotState: "unavailable" });
  } finally {
    await storage?.close();
  }
});

app.get("/favicon.ico", (_req, res) => {
  res.status(204).end();
});
app.use(createPasswordProtection());
app.use(express.json({ limit: "100kb" }));
app.use("/dashboard", express.static(paths.dashboardDir));

app.get("/", (_req, res) => {
  res.redirect("/dashboard");
});

app.get("/dashboard", (_req, res) => {
  res.redirect("/dashboard/");
});

app.get("/dashboard/", (_req, res) => {
  res.sendFile(path.join(paths.dashboardDir, "index.html"));
});

app.get("/api/health", (_req, res) => {
  const activeJob = refreshJobs.getCurrent();
  res.json({ ok: true, refreshRunning: Boolean(activeJob?.running), activeJob });
});

function isFreshTrenchIndex(fetchedAt: string): boolean {
  const fetchedAtMs = Date.parse(fetchedAt);
  return Number.isFinite(fetchedAtMs) && Date.now() - fetchedAtMs < 6 * 60 * 60 * 1000;
}

app.get("/api/market-regime", async (_req, res) => {
  const storage = createStorage(cwd);
  try {
    let regime = await storage.getLatestTrenchIndex();
    let stale = Boolean(regime && !isFreshTrenchIndex(regime.fetchedAt));
    if (!regime || stale) {
      try {
        regime = await storage.upsertTrenchIndex(await fetchTrenchIndex());
        stale = false;
      } catch (error) {
        if (!regime) throw error;
        console.warn("Trench Index refresh failed; returning the last saved regime", error instanceof Error ? error.message : "Unknown error");
      }
    }
    res.set("Cache-Control", "private, no-store").json({ regime, stale });
  } catch (error) {
    sendServerError(res, error);
  } finally {
    await storage.close();
  }
});

function parseFavoriteEntityName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name && name.length <= 160 && !/[\u0000-\u001f\u007f]/.test(name) ? name : null;
}

function parseFavoriteEntityNames(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 100) return null;
  const unique = new Map<string, string>();
  for (const valueName of value) {
    const name = parseFavoriteEntityName(valueName);
    if (!name) return null;
    if (!unique.has(name.toLowerCase())) unique.set(name.toLowerCase(), name);
  }
  return [...unique.values()];
}

app.get("/api/favorite-entities", async (_req, res) => {
  const storage = createStorage(cwd);
  try {
    res.set("Cache-Control", "no-store").json({ favoriteEntities: await storage.getFavoriteEntityNames() });
  } catch (error) {
    sendServerError(res, error);
  } finally {
    await storage.close();
  }
});

app.post("/api/favorite-entities/merge", async (req, res) => {
  const names = parseFavoriteEntityNames(req.body?.favoriteEntities);
  if (!names) {
    res.status(400).json({ error: "favoriteEntities must be an array of up to 100 valid names" });
    return;
  }
  const storage = createStorage(cwd);
  try {
    res.set("Cache-Control", "no-store").json({ favoriteEntities: await storage.mergeFavoriteEntities(names) });
  } catch (error) {
    sendServerError(res, error);
  } finally {
    await storage.close();
  }
});

app.post("/api/favorite-entities", async (req, res) => {
  const name = parseFavoriteEntityName(req.body?.name);
  if (!name) {
    res.status(400).json({ error: "name must be a non-empty entity name of at most 160 characters" });
    return;
  }
  const storage = createStorage(cwd);
  try {
    res.set("Cache-Control", "no-store").json({ favoriteEntities: await storage.addFavoriteEntity(name) });
  } catch (error) {
    sendServerError(res, error);
  } finally {
    await storage.close();
  }
});

app.delete("/api/favorite-entities", async (req, res) => {
  const name = parseFavoriteEntityName(req.body?.name);
  if (!name) {
    res.status(400).json({ error: "name must be a non-empty entity name of at most 160 characters" });
    return;
  }
  const storage = createStorage(cwd);
  try {
    res.set("Cache-Control", "no-store").json({ favoriteEntities: await storage.removeFavoriteEntity(name) });
  } catch (error) {
    sendServerError(res, error);
  } finally {
    await storage.close();
  }
});

function sendServerError(res: express.Response, error: unknown): void {
  res.status(500).json({ error: error instanceof Error ? error.message : "Unexpected server error" });
}

function incompleteSnapshotStatus(snapshot: SnapshotRecord): SnapshotStatus {
  return snapshot.entitiesCompleted > 0 || snapshot.totalRows > 0 ? "partial" : "failed";
}

function snapshotToRefreshJob(snapshot: SnapshotRecord) {
  const status = snapshot.status;
  const running = status === "running";
  const totalEntities = Number(snapshot.totalEntities || 0);
  const entitiesCompleted = Number(snapshot.entitiesCompleted || 0);
  const entitiesFailed = Number(snapshot.entitiesFailed || 0);
  const totalRows = Number(snapshot.totalRows || 0);
  return {
    jobId: `snapshot-${snapshot.id}`,
    running,
    startedAt: snapshot.createdAt,
    finishedAt: snapshot.finishedAt,
    providerLabel: snapshot.providerLabel,
    progress: {
      snapshotId: snapshot.id,
      totalEntities,
      entitiesCompleted,
      entitiesFailed,
      totalRows,
      currentEntity: null,
      currentEntityIndex: null,
      status,
      errorMessage: snapshot.errorMessage,
    },
    logs: [
      {
        at: snapshot.createdAt,
        tone: "info" as const,
        message: running
          ? "Refresh progress recovered from the database."
          : `Snapshot ${status}.`,
      },
    ],
    result: running
      ? null
      : {
          snapshotId: snapshot.id,
          totalEntities,
          entitiesCompleted,
          entitiesFailed,
          totalRows,
          status,
        },
  };
}

async function reconcileSnapshots(storage: ReturnType<typeof createStorage>, hasInMemoryJob: boolean) {
  let snapshots = await storage.getSnapshotSummaries();
  if (!hasInMemoryJob) {
    const incompleteRunningSnapshots = snapshots.filter(
      (snapshot) => snapshot.status === "running" && isRunningSnapshotStale(snapshot),
    );
    for (const snapshot of incompleteRunningSnapshots) {
      const status = incompleteSnapshotStatus(snapshot);
      await storage.updateSnapshot({
        id: snapshot.id,
        status,
        errorMessage:
          status === "partial"
            ? "Refresh process stopped before all entities completed. Showing partial results."
            : "Refresh process stopped before any entity completed.",
        finishedAt: new Date().toISOString(),
        entitiesCompleted: snapshot.entitiesCompleted,
        entitiesFailed: Math.max(snapshot.entitiesFailed, snapshot.totalEntities - snapshot.entitiesCompleted),
        totalRows: snapshot.totalRows,
      });
    }
    if (incompleteRunningSnapshots.length) {
      snapshots = await storage.getSnapshotSummaries();
    }
  }

  return {
    snapshots,
    latest: getLatestUsableSnapshot(snapshots),
    runningSnapshot: snapshots.find((snapshot) => snapshot.status === "running") || null,
  };
}

app.get("/api/snapshots", async (_req, res) => {
  const storage = createStorage(cwd);
  try {
    const activeJob = refreshJobs.getCurrent();
    const snapshotState = await reconcileSnapshots(storage, Boolean(activeJob?.running));
    res.json({ snapshots: snapshotState.snapshots, latest: snapshotState.latest });
  } catch (error) {
    sendServerError(res, error);
  } finally {
    await storage.close();
  }
});

app.get("/api/overview", async (req, res) => {
  const snapshotId = Number(req.query.snapshotId || 0);
  const minBalanceUsd = Number(req.query.minBalanceUsd || 111);
  const minSmwIn = Number(req.query.minSmwIn || 1);
  const minLiquidityUsd = Number(req.query.minLiquidityUsd || 11111);
  const maxMarketCapUsdRaw = Number(req.query.maxMarketCapUsd || 0);
  const maxMarketCapUsd = Number.isFinite(maxMarketCapUsdRaw) && maxMarketCapUsdRaw > 0 ? maxMarketCapUsdRaw : null;
  if (!Number.isFinite(snapshotId) || snapshotId <= 0) {
    res.status(400).json({ error: "snapshotId is required" });
    return;
  }

  const storage = createStorage(cwd);
  try {
    const favoriteEntities = await storage.getFavoriteEntityNames();
    const rows = await storage.getOverview(snapshotId, minBalanceUsd, minSmwIn, minLiquidityUsd, maxMarketCapUsd, favoriteEntities);
    res.set("Cache-Control", "private, no-store").json({
      rows: rows.sort((left, right) => right.score - left.score || right.holdingsUsd - left.holdingsUsd),
    });
  } catch (error) {
    sendServerError(res, error);
  } finally {
    await storage.close();
  }
});

app.get("/api/token-holders", async (req, res) => {
  const snapshotId = Number(req.query.snapshotId || 0);
  const tokenKey = String(req.query.tokenKey || "");
  const minBalanceUsd = Number(req.query.minBalanceUsd || 111);
  if (!Number.isFinite(snapshotId) || snapshotId <= 0 || !tokenKey) {
    res.status(400).json({ error: "snapshotId and tokenKey are required" });
    return;
  }

  const storage = createStorage(cwd);
  try {
    res.json({
      rows: await storage.getTokenHolders(snapshotId, tokenKey, minBalanceUsd),
    });
  } catch (error) {
    sendServerError(res, error);
  } finally {
    await storage.close();
  }
});

app.get("/api/token-score-history", async (req, res) => {
  const tokenKey = String(req.query.tokenKey || "");
  const minBalanceUsd = Number(req.query.minBalanceUsd || 111);
  const requestedLimit = Number(req.query.limit || 0);
  const historyLimit = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.min(100, Math.trunc(requestedLimit))
    : null;
  if (!tokenKey) {
    res.status(400).json({ error: "tokenKey is required" });
    return;
  }

  const storage = createStorage(cwd);
  try {
    const favoriteEntities = await storage.getFavoriteEntityNames();
    res.set("Cache-Control", "private, no-store").json({
      rows: await storage.getTokenScoreHistory(tokenKey, minBalanceUsd, favoriteEntities, historyLimit),
    });
  } catch (error) {
    sendServerError(res, error);
  } finally {
    await storage.close();
  }
});

app.get("/api/blacklist", async (_req, res) => {
  const storage = createStorage(cwd);
  try {
    res.json({ rows: await storage.getBlacklist() });
  } catch (error) {
    sendServerError(res, error);
  } finally {
    await storage.close();
  }
});

app.post("/api/blacklist", async (req, res) => {
  const tokenKey = String(req.body?.tokenKey || "").trim();
  const tokenSymbol = String(req.body?.tokenSymbol || "").trim();
  const tokenName = String(req.body?.tokenName || "").trim();
  const networkName = String(req.body?.networkName || "").trim();
  const chainId = req.body?.chainId == null ? null : Number(req.body.chainId);
  const tokenAddress = req.body?.tokenAddress ? String(req.body.tokenAddress) : null;
  const reason = req.body?.reason ? String(req.body.reason) : "Manual blacklist";

  if (!tokenKey || !tokenSymbol || !tokenName || !networkName) {
    res.status(400).json({ error: "Incomplete token payload" });
    return;
  }

  const storage = createStorage(cwd);
  try {
    await storage.upsertBlacklist({
      tokenKey,
      tokenSymbol,
      tokenName,
      networkName,
      chainId: Number.isFinite(chainId) ? chainId : null,
      tokenAddress,
      reason,
    });
    res.json({ ok: true });
  } catch (error) {
    sendServerError(res, error);
  } finally {
    await storage.close();
  }
});

app.post("/api/blacklist/restore", async (req, res) => {
  const id = Number(req.body?.id || 0);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "Blacklist id is required" });
    return;
  }

  const storage = createStorage(cwd);
  try {
    await storage.restoreBlacklist(id);
    res.json({ ok: true });
  } catch (error) {
    sendServerError(res, error);
  } finally {
    await storage.close();
  }
});

app.get("/api/refresh/status", (_req, res) => {
  const currentJob = refreshJobs.getCurrent();
  if (currentJob) {
    const latestJob = refreshJobs.getLatest();
    res.json({
      ok: true,
      refreshRunning: Boolean(currentJob.running),
      currentJob,
      latestJob,
      job: currentJob || latestJob,
    });
    return;
  }

  const storage = createStorage(cwd);
  reconcileSnapshots(storage, false)
    .then((snapshotState) => {
      const persistedJob = snapshotState.runningSnapshot
        ? snapshotToRefreshJob(snapshotState.runningSnapshot)
        : snapshotState.latest
          ? snapshotToRefreshJob(snapshotState.latest)
          : null;
      res.json({
        ok: true,
        refreshRunning: Boolean(snapshotState.runningSnapshot),
        currentJob: snapshotState.runningSnapshot ? persistedJob : null,
        latestJob: persistedJob,
        job: persistedJob,
      });
    })
    .catch((error) => sendServerError(res, error))
    .finally(() => {
      void storage.close();
    });
});

app.post("/api/refresh", async (req, res) => {
  if (!process.env.FIRECRAWL_API_KEY?.trim()) {
    res.status(503).json({ error: "Server refresh is not configured" });
    return;
  }
  if (refreshJobs.getCurrent()) {
    res.status(409).json({ error: "Refresh already running" });
    return;
  }

  const storage = createStorage(cwd);
  try {
    const snapshotState = await reconcileSnapshots(storage, false);
    if (snapshotState.runningSnapshot) {
      res.status(409).json({ error: "Refresh already running" });
      return;
    }
    const job = await refreshJobs.start();
    res.status(202).json({ ok: true, job });
  } catch (error) {
    const message = (error as Error).message;
    res.status(message.includes("already running") ? 409 : 500).json({ error: message });
  } finally {
    await storage.close();
  }
});

app.post("/api/refresh/cancel", (_req, res) => {
  const canceled = refreshJobs.cancel();
  if (!canceled) {
    res.status(409).json({ error: "No running refresh job to cancel" });
    return;
  }
  res.json({ ok: true, job: refreshJobs.getCurrent() || refreshJobs.getLatest() });
});

export function createApp() {
  return app;
}

export default app;

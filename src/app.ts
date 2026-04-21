import path from "node:path";
import dotenv from "dotenv";
import express from "express";
import { createRefreshJobManager } from "./refresh-jobs";
import { resolveWorkspacePaths } from "./runtime-paths";
import { createStorage } from "./storage";

dotenv.config();

const app = express();
const cwd = process.cwd();
const paths = resolveWorkspacePaths(cwd);
const refreshJobs = createRefreshJobManager(cwd);

app.use(express.json());
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

function sendServerError(res: express.Response, error: unknown): void {
  res.status(500).json({ error: error instanceof Error ? error.message : "Unexpected server error" });
}

app.get("/api/snapshots", async (_req, res) => {
  const storage = createStorage(cwd);
  try {
    const snapshots = await storage.getSnapshotSummaries();
    res.json({ snapshots, latest: await storage.getLatestSnapshot() });
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
  if (!Number.isFinite(snapshotId) || snapshotId <= 0) {
    res.status(400).json({ error: "snapshotId is required" });
    return;
  }

  const storage = createStorage(cwd);
  try {
    res.json({
      rows: await storage.getOverview(snapshotId, minBalanceUsd, minSmwIn, minLiquidityUsd),
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
  const latestJob = refreshJobs.getLatest();
  res.json({
    ok: true,
    refreshRunning: Boolean(currentJob?.running),
    currentJob,
    latestJob,
    job: currentJob || latestJob,
  });
});

app.post("/api/refresh", async (req, res) => {
  const apiKey = String(req.body?.apiKey || "").trim();
  if (!apiKey) {
    res.status(400).json({ error: "Zapper API key is required" });
    return;
  }
  if (refreshJobs.getCurrent()) {
    res.status(409).json({ error: "Refresh already running" });
    return;
  }

  try {
    const job = await refreshJobs.start(apiKey);
    res.status(202).json({ ok: true, job });
  } catch (error) {
    const message = (error as Error).message;
    res.status(message.includes("already running") ? 409 : 500).json({ error: message });
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

import path from "node:path";
import fs from "node:fs";
import dotenv from "dotenv";
import express from "express";
import { createAuthRouter, createPasswordProtection } from "./auth";
import { fetchDexScreenerMarketData } from "./dexscreener";
import { fetchMoniScoreDataForToken, getMoniLookupTimeoutMs } from "./moni";
import { createRefreshJobManager } from "./refresh-jobs";
import { resolveWorkspacePaths } from "./runtime-paths";
import { withOpportunityScore } from "./scoring";
import { SOLANA_CHAIN_ID } from "./solscan";
import { createStorage } from "./storage";
import {
  MoniScoreData,
  SnapshotRecord,
  SnapshotStatus,
  TokenBlacklistRecord,
  TokenHolderRow,
  TokenOverviewRow,
} from "./types";

dotenv.config();

const app = express();
const cwd = process.cwd();
const paths = resolveWorkspacePaths(cwd);
const refreshJobs = createRefreshJobManager(cwd);

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(createAuthRouter());
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

app.get("/dashboard/solscan-test", (_req, res) => {
  res.redirect("/dashboard/solscan-test.html");
});

app.get("/api/health", (_req, res) => {
  const activeJob = refreshJobs.getCurrent();
  res.json({ ok: true, refreshRunning: Boolean(activeJob?.running), activeJob });
});

function sendServerError(res: express.Response, error: unknown): void {
  res.status(500).json({ error: error instanceof Error ? error.message : "Unexpected server error" });
}

function findLatestSolscanTestFile(): string | null {
  const tmpDir = path.join(cwd, ".tmp");
  const dataPublishedFile = path.join(cwd, "data", "raw", "solscan-top-holdings-latest.json");

  const files = fs.existsSync(tmpDir)
    ? fs
        .readdirSync(tmpDir)
        .filter((file) => /^solscan-top-holdings-.+\.json$/.test(file))
        .map((file) => path.join(tmpDir, file))
        .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)
    : [];

  return files[0] || (fs.existsSync(dataPublishedFile) ? dataPublishedFile : null);
}

type SolscanEntityTokenRow = {
  entityName?: string;
  resolvedLabel?: string | null;
  tokenKey?: string;
  tokenName?: string;
  tokenSymbol?: string;
  tokenAddress?: string;
  balanceUsd?: number;
  balance?: string;
  walletCount?: number;
  wallets?: string[];
  marketCap?: number | null;
  liquidityUsd?: number | null;
  volume24h?: number | null;
  txns24h?: number | null;
  tokenAgeHours?: number | null;
  moniScore?: number | null;
  moniLevel?: number | null;
  moniLevelName?: string | null;
  moniMomentumScorePct?: number | null;
  moniMomentumRank?: number | null;
};

type SolscanLatestPayload = {
  generatedAt?: string;
  rows?: SolscanEntityTokenRow[];
};

type SolscanOverviewRow = TokenOverviewRow & {
  solscanHolders: TokenHolderRow[];
  solscanLiquidityUsd: number | null;
};

type SolscanEnrichmentData = {
  marketCap: number | null;
  liquidityUsd: number | null;
  volume24h: number | null;
  txns24h: number | null;
  tokenAgeHours: number | null;
  twitterHandle: string | null;
  moniScore: number | null;
  moniLevel: number | null;
  moniLevelName: string | null;
  moniMomentumScorePct: number | null;
  moniMomentumRank: number | null;
};

type SolscanMarketDataCache = {
  cacheKey: string;
  dataByTokenKey: Map<string, SolscanEnrichmentData>;
};

let solscanMarketDataCache: SolscanMarketDataCache | null = null;

function normalizeSolanaTokenKey(tokenAddress: string): string {
  return `${SOLANA_CHAIN_ID}:${tokenAddress.toLowerCase()}`;
}

function isSolanaOverviewRow(row: TokenOverviewRow): boolean {
  return row.chainId === SOLANA_CHAIN_ID || row.networkName.toLowerCase() === "solana";
}

function stableNegativeEntityId(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return -Math.max(1, Math.abs(hash));
}

function readSolscanLatestPayload(): SolscanLatestPayload | null {
  const latestFile = findLatestSolscanTestFile();
  if (!latestFile) return null;
  return JSON.parse(fs.readFileSync(latestFile, "utf8")) as SolscanLatestPayload;
}

function toPendingSolscanEnrichmentData(): SolscanEnrichmentData {
  return {
    marketCap: null,
    liquidityUsd: null,
    volume24h: null,
    txns24h: null,
    tokenAgeHours: null,
    twitterHandle: null,
    moniScore: null,
    moniLevel: null,
    moniLevelName: null,
    moniMomentumScorePct: null,
    moniMomentumRank: null,
  };
}

function applyMoniScore(data: SolscanEnrichmentData, moniData: MoniScoreData | null): SolscanEnrichmentData {
  if (!moniData) return data;
  return {
    ...data,
    moniScore: moniData.moniScore,
    moniLevel: moniData.moniLevel,
    moniLevelName: moniData.moniLevelName,
    moniMomentumScorePct: moniData.moniMomentumScorePct,
    moniMomentumRank: moniData.moniMomentumRank,
  };
}

async function enrichSolscanMoniScores(dataByTokenKey: Map<string, SolscanEnrichmentData>, rows: SolscanOverviewRow[]): Promise<void> {
  const firecrawlApiKey = process.env.FIRECRAWL_API_KEY?.trim();
  if (!firecrawlApiKey) return;

  const lookupLimit = Math.max(0, Number(process.env.SOLSCAN_MONI_LOOKUP_LIMIT || 0));
  if (lookupLimit <= 0) return;

  const candidates = rows
    .map((row) => ({
      row,
      data: dataByTokenKey.get(row.tokenKey),
    }))
    .filter((item): item is { row: SolscanOverviewRow; data: SolscanEnrichmentData } => Boolean(item.data?.twitterHandle))
    .slice(0, lookupLimit);

  let nextIndex = 0;
  const concurrency = Math.max(1, Math.min(Number(process.env.SOLSCAN_MONI_CONCURRENCY || 2), candidates.length || 1));
  const workers = Array.from({ length: concurrency }, async () => {
    while (nextIndex < candidates.length) {
      const item = candidates[nextIndex];
      nextIndex += 1;
      try {
        const moniData = await fetchMoniScoreDataForToken(
          firecrawlApiKey,
          item.data.twitterHandle || "",
          item.row.tokenName,
          {
            tokenSymbol: item.row.tokenSymbol,
            includeTokenFallbacks: true,
            timeoutMs: getMoniLookupTimeoutMs(process.env.MONI_SCRAPE_TIMEOUT_MS),
          },
        );
        dataByTokenKey.set(item.row.tokenKey, applyMoniScore(item.data, moniData));
      } catch (_error) {
        // Keep MONI as Pending for tokens where Firecrawl or MONI is temporarily unavailable.
      }
    }
  });

  await Promise.all(workers);
}

async function getSolscanEnrichmentDataByTokenKey(rows: SolscanOverviewRow[], payload: SolscanLatestPayload | null) {
  const cacheKey = payload?.generatedAt || rows.map((row) => row.tokenKey).sort().join("|");
  if (solscanMarketDataCache?.cacheKey === cacheKey) {
    return solscanMarketDataCache.dataByTokenKey;
  }

  if (!rows.length) {
    solscanMarketDataCache = { cacheKey, dataByTokenKey: new Map() };
    return solscanMarketDataCache.dataByTokenKey;
  }

  const dexScreenerData = await fetchDexScreenerMarketData(
    rows.map((row) => ({
      tokenAddress: row.tokenAddress || "",
      chainId: SOLANA_CHAIN_ID,
      networkName: "Solana",
    })),
  );

  const dataByTokenKey = new Map<string, SolscanEnrichmentData>();

  for (const row of rows) {
    if (!row.tokenAddress) continue;
    const marketData = dexScreenerData.get(`solana:${row.tokenAddress.toLowerCase()}`);
    dataByTokenKey.set(row.tokenKey, marketData ? {
      ...toPendingSolscanEnrichmentData(),
      marketCap: marketData.marketCap,
      liquidityUsd: marketData.liquidityUsd,
      volume24h: marketData.volume24h,
      txns24h: marketData.txns24h,
      tokenAgeHours: marketData.tokenAgeHours,
      twitterHandle: marketData.twitterHandle,
    } : toPendingSolscanEnrichmentData());
  }

  await enrichSolscanMoniScores(dataByTokenKey, rows);

  solscanMarketDataCache = { cacheKey, dataByTokenKey };
  return dataByTokenKey;
}

async function enrichSolscanOverviewRows(rows: SolscanOverviewRow[], payload: SolscanLatestPayload | null): Promise<SolscanOverviewRow[]> {
  const dataByTokenKey = await getSolscanEnrichmentDataByTokenKey(rows, payload);
  return rows.map((row) => {
    const data = dataByTokenKey.get(row.tokenKey);
    if (!data) return row;
    return {
      ...withOpportunityScore({
        ...row,
        marketCap: data.marketCap ?? row.marketCap,
        tokenAgeHours: data.tokenAgeHours ?? row.tokenAgeHours,
        moniScore: data.moniScore ?? row.moniScore,
        moniLevel: data.moniLevel ?? row.moniLevel,
        moniLevelName: data.moniLevelName ?? row.moniLevelName,
        moniMomentumScorePct: data.moniMomentumScorePct ?? row.moniMomentumScorePct,
        moniMomentumRank: data.moniMomentumRank ?? row.moniMomentumRank,
        volume24h: data.volume24h ?? row.volume24h,
        txns24h: data.txns24h ?? row.txns24h,
      }),
      solscanHolders: row.solscanHolders,
      solscanLiquidityUsd: data.liquidityUsd ?? row.solscanLiquidityUsd,
    };
  });
}

function applySolscanMarketFilters(
  rows: SolscanOverviewRow[],
  minLiquidityUsd: number,
  maxMarketCapUsd: number | null,
): SolscanOverviewRow[] {
  return rows.filter((row) => {
    if (row.tokenAddress && row.marketCap != null && maxMarketCapUsd != null && row.marketCap >= maxMarketCapUsd) return false;
    if (row.tokenAddress && row.volume24h != null && row.volume24h < 1000) return false;
    if (row.tokenAddress && row.txns24h != null && row.txns24h < 11) return false;
    if (row.tokenAddress && row.marketCap == null && row.volume24h == null && row.txns24h == null) return true;
    return row.solscanLiquidityUsd == null || row.solscanLiquidityUsd >= minLiquidityUsd;
  });
}

function buildSolscanOverviewRows(options: {
  payload: SolscanLatestPayload | null;
  minBalanceUsd: number;
  minSmwIn: number;
  maxMarketCapUsd: number | null;
  blacklist: TokenBlacklistRecord[];
}): SolscanOverviewRow[] {
  const rows = Array.isArray(options.payload?.rows) ? options.payload.rows : [];
  const activeBlacklist = new Set(
    options.blacklist
      .filter((item) => item.isActive)
      .map((item) => item.tokenKey.toLowerCase()),
  );
  const byToken = new Map<string, {
    tokenKey: string;
    tokenSymbol: string;
    tokenName: string;
    tokenAddress: string;
    holdingsUsd: number;
    balance: number;
    holders: Map<string, TokenHolderRow>;
    marketCap: number | null;
    liquidityUsd: number | null;
    volume24h: number | null;
    txns24h: number | null;
    tokenAgeHours: number | null;
    moniScore: number | null;
    moniLevel: number | null;
    moniLevelName: string | null;
    moniMomentumScorePct: number | null;
    moniMomentumRank: number | null;
  }>();

  for (const row of rows) {
    const tokenAddress = String(row.tokenAddress || "").trim();
    const balanceUsd = Number(row.balanceUsd || 0);
    if (!tokenAddress || !Number.isFinite(balanceUsd) || balanceUsd < options.minBalanceUsd) continue;

    const tokenKey = normalizeSolanaTokenKey(tokenAddress);
    if (activeBlacklist.has(tokenKey.toLowerCase())) continue;

    const group = byToken.get(tokenKey) || {
      tokenKey,
      tokenSymbol: String(row.tokenSymbol || "UNKNOWN"),
      tokenName: String(row.tokenName || row.tokenSymbol || "Unknown token"),
      tokenAddress,
      holdingsUsd: 0,
      balance: 0,
      holders: new Map<string, TokenHolderRow>(),
      marketCap: row.marketCap ?? null,
      liquidityUsd: row.liquidityUsd ?? null,
      volume24h: row.volume24h ?? null,
      txns24h: row.txns24h ?? null,
      tokenAgeHours: row.tokenAgeHours ?? null,
      moniScore: row.moniScore ?? null,
      moniLevel: row.moniLevel ?? null,
      moniLevelName: row.moniLevelName ?? null,
      moniMomentumScorePct: row.moniMomentumScorePct ?? null,
      moniMomentumRank: row.moniMomentumRank ?? null,
    };

    group.holdingsUsd += balanceUsd;
    const balance = Number(row.balance || 0);
    if (Number.isFinite(balance)) group.balance += balance;
    group.marketCap ??= row.marketCap ?? null;
    group.liquidityUsd ??= row.liquidityUsd ?? null;
    group.volume24h ??= row.volume24h ?? null;
    group.txns24h ??= row.txns24h ?? null;
    group.tokenAgeHours ??= row.tokenAgeHours ?? null;
    group.moniScore ??= row.moniScore ?? null;
    group.moniLevel ??= row.moniLevel ?? null;
    group.moniLevelName ??= row.moniLevelName ?? null;
    group.moniMomentumScorePct ??= row.moniMomentumScorePct ?? null;
    group.moniMomentumRank ??= row.moniMomentumRank ?? null;

    const entityName = String(row.entityName || row.resolvedLabel || "Unknown Entity");
    const holder = group.holders.get(entityName) || {
      entityId: stableNegativeEntityId(entityName),
      entityName,
      resolvedLabel: row.resolvedLabel ?? null,
      balanceUsd: 0,
      networkName: "Solana",
      tokenSymbol: group.tokenSymbol,
      tokenName: group.tokenName,
    };
    holder.balanceUsd += balanceUsd;
    group.holders.set(entityName, holder);
    byToken.set(tokenKey, group);
  }

  return Array.from(byToken.values())
    .map((group) => {
      const holders = Array.from(group.holders.values())
        .filter((holder) => holder.balanceUsd >= options.minBalanceUsd)
        .sort((left, right) => right.balanceUsd - left.balanceUsd || left.entityName.localeCompare(right.entityName));

      const row = withOpportunityScore({
        tokenKey: group.tokenKey,
        tokenSymbol: group.tokenSymbol,
        tokenName: group.tokenName,
        networkName: "Solana",
        chainId: SOLANA_CHAIN_ID,
        tokenAddress: group.tokenAddress,
        holdingsUsd: Math.round(group.holdingsUsd * 100) / 100,
        smwIn: holders.length,
        marketCap: group.marketCap,
        tokenAgeHours: group.tokenAgeHours,
        moniScore: group.moniScore,
        moniLevel: group.moniLevel,
        moniLevelName: group.moniLevelName,
        moniMomentumScorePct: group.moniMomentumScorePct,
        moniMomentumRank: group.moniMomentumRank,
        volume24h: group.volume24h,
        txns24h: group.txns24h,
      });

      return { ...row, solscanHolders: holders, solscanLiquidityUsd: group.liquidityUsd };
    })
    .filter((row) => row.smwIn >= options.minSmwIn)
    .filter((row) => options.maxMarketCapUsd == null || row.marketCap == null || row.marketCap < options.maxMarketCapUsd)
    .sort((left, right) => right.score - left.score || right.holdingsUsd - left.holdingsUsd);
}

function getSolscanRowsByTokenKey(rows: SolscanOverviewRow[]): Map<string, SolscanOverviewRow> {
  return new Map(rows.map((row) => [row.tokenKey, row]));
}

function stripSolscanHolders(row: TokenOverviewRow | SolscanOverviewRow): TokenOverviewRow {
  const {
    solscanHolders: _solscanHolders,
    solscanLiquidityUsd: _solscanLiquidityUsd,
    ...overviewRow
  } = row as SolscanOverviewRow;
  return overviewRow;
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
    apiKeyLabel: snapshot.zapperKeyLabel,
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
    const incompleteRunningSnapshots = snapshots.filter((snapshot) => snapshot.status === "running");
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
    latest: snapshots[0] || null,
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

app.get("/api/solscan-test/latest", async (_req, res) => {
  try {
    const latestFile = findLatestSolscanTestFile();
    if (!latestFile) {
      res.status(404).json({
        error: "No Solscan test output found. Run npm run solscan:top-holdings first.",
      });
      return;
    }

    const payload = JSON.parse(fs.readFileSync(latestFile, "utf8")) as Record<string, unknown>;
    res.json({
      file: path.basename(latestFile),
      ...payload,
    });
  } catch (error) {
    sendServerError(res, error);
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
    const zapperRows = await storage.getOverview(snapshotId, minBalanceUsd, minSmwIn, minLiquidityUsd, maxMarketCapUsd);
    const solscanPayload = readSolscanLatestPayload();
    const solscanRows = await enrichSolscanOverviewRows(buildSolscanOverviewRows({
      payload: solscanPayload,
      minBalanceUsd,
      minSmwIn,
      maxMarketCapUsd,
      blacklist: await storage.getBlacklist(),
    }), solscanPayload);
    const filteredSolscanRows = applySolscanMarketFilters(solscanRows, minLiquidityUsd, maxMarketCapUsd);
    const rows = solscanRows.length
      ? [...zapperRows.filter((row) => !isSolanaOverviewRow(row)), ...filteredSolscanRows]
      : zapperRows;

    res.json({
      rows: rows
        .sort((left, right) => right.score - left.score || right.holdingsUsd - left.holdingsUsd)
        .map(stripSolscanHolders),
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
    const solscanRows = buildSolscanOverviewRows({
      payload: readSolscanLatestPayload(),
      minBalanceUsd,
      minSmwIn: 1,
      maxMarketCapUsd: null,
      blacklist: await storage.getBlacklist(),
    });
    const solscanRow = getSolscanRowsByTokenKey(solscanRows).get(tokenKey);
    if (solscanRow) {
      res.json({ rows: solscanRow.solscanHolders });
      return;
    }

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
  if (!tokenKey) {
    res.status(400).json({ error: "tokenKey is required" });
    return;
  }

  const storage = createStorage(cwd);
  try {
    res.json({
      rows: await storage.getTokenScoreHistory(tokenKey, minBalanceUsd),
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
  const apiKey = String(req.body?.apiKey || "").trim();
  if (!apiKey) {
    res.status(400).json({ error: "Zapper API key is required" });
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
    const job = await refreshJobs.start(apiKey);
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

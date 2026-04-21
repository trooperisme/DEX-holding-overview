import {
  fetchDexScreenerMarketData,
  type DexScreenerMarketData,
  toDexScreenerChainId,
} from "./dexscreener";
import { loadImportedEntities, maskApiKey, toTokenKey } from "./entities";
import { fetchMoniScoreDataForToken } from "./moni";
import { resolveWorkspacePaths } from "./runtime-paths";
import { createStorage } from "./storage";
import { fetchZapperTokenBalances } from "./zapper";
import {
  RawHoldingRecord,
  RefreshJobState,
  RefreshLogTone,
  RefreshProgressState,
  RefreshResult,
  SnapshotStatus,
} from "./types";

type RefreshCallbacks = {
  onLog?: (tone: RefreshLogTone, message: string) => void;
  onProgress?: (progress: RefreshProgressState) => void;
};

function isAbortError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "name" in error &&
    (error as { name?: string }).name === "AbortError"
  );
}

function createProgressState(partial: Partial<RefreshProgressState> = {}): RefreshProgressState {
  return {
    snapshotId: null,
    totalEntities: 0,
    entitiesCompleted: 0,
    entitiesFailed: 0,
    totalRows: 0,
    currentEntity: null,
    currentEntityIndex: null,
    status: "running",
    errorMessage: null,
    ...partial,
  };
}

function emitLog(callbacks: RefreshCallbacks, tone: RefreshLogTone, message: string): void {
  callbacks.onLog?.(tone, message);
}

function emitProgress(callbacks: RefreshCallbacks, partial: Partial<RefreshProgressState>): void {
  callbacks.onProgress?.(createProgressState(partial));
}

async function enrichSnapshotMarketData(options: {
  storage: ReturnType<typeof createStorage>;
  snapshotId: number;
  totalEntities: number;
  apiKey: string;
  signal?: AbortSignal;
  callbacks: RefreshCallbacks;
}): Promise<{ attempted: number; enriched: number; failed: number }> {
  const snapshotTokens = (await options.storage.getSnapshotTokensForEnrichment(options.snapshotId, 111, 1))
    .filter(
      (token) =>
        token.tokenAddress &&
        toDexScreenerChainId(token.chainId, token.networkName),
    )
    .slice(0, options.totalEntities <= 1 ? 25 : undefined);

  if (!snapshotTokens.length) {
    emitLog(options.callbacks, "info", "No enrichable token contracts found for DexScreener market-data lookup.");
    return { attempted: 0, enriched: 0, failed: 0 };
  }

  emitLog(
    options.callbacks,
    "info",
    `Enriching ${snapshotTokens.length} unique tokens with DexScreener liquidity, volume, txns, market cap, and age data.`,
  );

  let marketDataByTokenAddress: Map<string, DexScreenerMarketData>;
  try {
    marketDataByTokenAddress = await fetchDexScreenerMarketData(
      snapshotTokens.map((token) => ({
        tokenAddress: token.tokenAddress!,
        chainId: token.chainId,
        networkName: token.networkName,
      })),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitLog(options.callbacks, "warning", `DexScreener enrichment skipped: ${message}`);
    return { attempted: snapshotTokens.length, enriched: 0, failed: snapshotTokens.length };
  }

  let enriched = 0;
  let failed = 0;
  const moniCandidates: Array<{
    tokenKey: string;
    tokenSymbol: string;
    tokenName: string;
    twitterHandle: string;
  }> = [];

  for (const token of snapshotTokens) {
    if (options.signal?.aborted) {
      throw new DOMException("Refresh canceled", "AbortError");
    }

    const dexChainId = toDexScreenerChainId(token.chainId, token.networkName);
    const marketData =
      dexChainId && token.tokenAddress
        ? marketDataByTokenAddress.get(`${dexChainId}:${token.tokenAddress.toLowerCase()}`)
        : null;

    if (!marketData) {
      failed += 1;
      emitLog(options.callbacks, "warning", `DexScreener market-data lookup returned no pair for ${token.tokenSymbol}.`);
      continue;
    }

    await options.storage.updateSnapshotTokenMarketData(options.snapshotId, token.tokenKey, marketData);
    if (marketData.twitterHandle) {
      moniCandidates.push({
        tokenKey: token.tokenKey,
        tokenSymbol: token.tokenSymbol,
        tokenName: token.tokenName,
        twitterHandle: marketData.twitterHandle,
      });
    }
    enriched += 1;
  }

  await enrichSnapshotMoniScores({
    storage: options.storage,
    snapshotId: options.snapshotId,
    candidates: moniCandidates,
    signal: options.signal,
    callbacks: options.callbacks,
  });

  emitLog(
    options.callbacks,
    failed > 0 ? "warning" : "success",
    failed > 0
      ? `DexScreener enrichment finished: ${enriched}/${snapshotTokens.length} enriched, ${failed} missing pair data.`
      : `DexScreener enrichment finished: ${enriched}/${snapshotTokens.length} enriched.`,
  );

  return {
    attempted: snapshotTokens.length,
    enriched,
    failed,
  };
}

async function enrichSnapshotMoniScores(options: {
  storage: ReturnType<typeof createStorage>;
  snapshotId: number;
  candidates: Array<{
    tokenKey: string;
    tokenSymbol: string;
    tokenName: string;
    twitterHandle: string;
  }>;
  signal?: AbortSignal;
  callbacks: RefreshCallbacks;
}): Promise<void> {
  const firecrawlApiKey = process.env.FIRECRAWL_API_KEY?.trim();
  if (!options.candidates.length) {
    emitLog(options.callbacks, "info", "No direct Twitter/X profile handles found for Moni Score lookup.");
    return;
  }
  if (!firecrawlApiKey) {
    emitLog(options.callbacks, "warning", "Moni Score lookup skipped: FIRECRAWL_API_KEY is not configured.");
    return;
  }

  const byHandle = new Map<string, typeof options.candidates>();
  for (const candidate of options.candidates) {
    const key = candidate.twitterHandle.toLowerCase();
    if (!byHandle.has(key)) byHandle.set(key, []);
    byHandle.get(key)!.push(candidate);
  }

  emitLog(options.callbacks, "info", `Enriching ${byHandle.size} Twitter/X handles with Moni Score data.`);

  let enriched = 0;
  let failed = 0;

  for (const candidates of byHandle.values()) {
    if (options.signal?.aborted) {
      throw new DOMException("Refresh canceled", "AbortError");
    }

    const handle = candidates[0].twitterHandle;
    const tokenName = candidates[0].tokenName;
    try {
      const score = await fetchMoniScoreDataForToken(firecrawlApiKey, handle, tokenName, options.signal);
      if (!score) {
        failed += candidates.length;
        continue;
      }

      for (const candidate of candidates) {
        await options.storage.updateSnapshotTokenMoniData(options.snapshotId, candidate.tokenKey, score);
        enriched += 1;
      }
    } catch (error) {
      failed += candidates.length;
      const message = error instanceof Error ? error.message : String(error);
      emitLog(options.callbacks, "warning", `Moni Score lookup skipped for @${handle}: ${message}`);
    }
  }

  emitLog(
    options.callbacks,
    failed > 0 ? "warning" : "success",
    failed > 0
      ? `Moni Score enrichment finished: ${enriched}/${options.candidates.length} enriched, ${failed} pending.`
      : `Moni Score enrichment finished: ${enriched}/${options.candidates.length} enriched.`,
  );
}

export async function runDexRefresh(options: {
  cwd?: string;
  apiKey: string;
  signal?: AbortSignal;
  callbacks?: RefreshCallbacks;
}): Promise<RefreshResult> {
  const cwd = options.cwd || process.cwd();
  const storage = createStorage(cwd);
  const paths = resolveWorkspacePaths(cwd);
  const callbacks = options.callbacks || {};
  const signal = options.signal;
  let snapshotId = 0;
  let totalEntities = 0;
  let entitiesCompleted = 0;
  let entitiesFailed = 0;
  let totalRows = 0;
  let aborted = false;
  let enrichmentFailed = 0;

  const throwIfAborted = (): void => {
    if (signal?.aborted) {
      throw new DOMException("Refresh canceled", "AbortError");
    }
  };

  try {
    throwIfAborted();
    const imported = loadImportedEntities(paths.entitiesCsv);
    emitLog(callbacks, "info", `Imported ${imported.length} tracked entities from CSV.`);
    await storage.replaceEntities(imported);

    const entities = await storage.getEntities();
    snapshotId = await storage.createSnapshot(entities.length, maskApiKey(options.apiKey));
    totalEntities = entities.length;
    const progress = createProgressState({
      snapshotId,
      totalEntities: entities.length,
      status: "running",
    });

    emitProgress(callbacks, progress);
    emitLog(callbacks, "info", `Created snapshot #${snapshotId} for ${entities.length} entities.`);

    for (const [index, entity] of entities.entries()) {
      throwIfAborted();

      const entityLabel = entity.resolvedLabel || entity.entityName;
      const startedAt = new Date().toISOString();
      const runId = await storage.insertEntityFetchRun({
        snapshotId,
        entityId: entity.id,
        status: "running",
        rowsFound: 0,
        totalBalanceUsd: 0,
        errorMessage: null,
        startedAt,
        finishedAt: null,
      });

      emitProgress(callbacks, {
        snapshotId,
        totalEntities: entities.length,
        entitiesCompleted,
        entitiesFailed,
        totalRows,
        currentEntity: entityLabel,
        currentEntityIndex: index + 1,
        status: "running",
        errorMessage: null,
      });
      emitLog(callbacks, "info", `Fetching ${entityLabel} (${index + 1}/${entities.length})...`);

      try {
        const result = await fetchZapperTokenBalances(
          options.apiKey,
          entity.wallets.map((wallet) => wallet.walletAddress),
          signal,
        );

        throwIfAborted();

        const fetchedAt = new Date().toISOString();
        const rows: RawHoldingRecord[] = result.balances.map((holding) => ({
          snapshotId,
          entityId: entity.id,
          tokenKey: toTokenKey(holding),
          tokenSymbol: holding.tokenSymbol,
          tokenName: holding.tokenName,
          tokenAddress: holding.tokenAddress,
          networkName: holding.networkName,
          chainId: holding.chainId,
          balance: holding.balance,
          balanceRaw: holding.balanceRaw,
          balanceUsd: holding.balanceUsd,
          price: holding.price,
          marketCap: holding.marketCap,
          liquidityUsd: holding.liquidityUsd,
          volume24h: holding.volume24h,
          txns24h: holding.txns24h,
          tokenAgeHours: holding.tokenAgeHours,
          moniScore: holding.moniScore,
          moniLevel: holding.moniLevel,
          moniLevelName: holding.moniLevelName,
          moniMomentumScorePct: holding.moniMomentumScorePct,
          moniMomentumRank: holding.moniMomentumRank,
          fetchedAt,
        }));

        await storage.insertRawHoldingsForEntity(snapshotId, entity.id, rows);
        entitiesCompleted += 1;
        totalRows += rows.length;
        await storage.updateEntityFetchRun(runId, {
          status: "success",
          rowsFound: rows.length,
          totalBalanceUsd: result.totalBalanceUsd,
          errorMessage: null,
          finishedAt: new Date().toISOString(),
        });
        await storage.updateSnapshot({
          id: snapshotId,
          entitiesCompleted,
          entitiesFailed,
          totalRows,
        });
        emitProgress(callbacks, {
          snapshotId,
          totalEntities: entities.length,
          entitiesCompleted,
          entitiesFailed,
          totalRows,
          currentEntity: entityLabel,
          currentEntityIndex: index + 1,
          status: "running",
          errorMessage: null,
        });
        emitLog(
          callbacks,
          "success",
          `Completed ${entityLabel}: ${rows.length} token rows, ${result.totalBalanceUsd.toLocaleString("en-US", {
            style: "currency",
            currency: "USD",
            maximumFractionDigits: 2,
          })} total.`,
        );
      } catch (error) {
        if (isAbortError(error)) {
          aborted = true;
          await storage.updateEntityFetchRun(runId, {
            status: "canceled",
            rowsFound: 0,
            totalBalanceUsd: 0,
            errorMessage: "Refresh canceled by user",
            finishedAt: new Date().toISOString(),
          });
          emitLog(callbacks, "warning", `Canceled while processing ${entityLabel}.`);
          break;
        }

        entitiesFailed += 1;
        const message = (error as Error).message;
        await storage.updateEntityFetchRun(runId, {
          status: "failed",
          rowsFound: 0,
          totalBalanceUsd: 0,
          errorMessage: message,
          finishedAt: new Date().toISOString(),
        });
        await storage.updateSnapshot({
          id: snapshotId,
          entitiesCompleted,
          entitiesFailed,
          totalRows,
        });
        emitProgress(callbacks, {
          snapshotId,
          totalEntities: entities.length,
          entitiesCompleted,
          entitiesFailed,
          totalRows,
          currentEntity: entityLabel,
          currentEntityIndex: index + 1,
          status: "running",
          errorMessage: message,
        });
        emitLog(callbacks, "error", `Failed ${entityLabel}: ${message}`);
      }
    }

    if (!aborted && entitiesCompleted > 0) {
      const enrichment = await enrichSnapshotMarketData({
        storage,
        snapshotId,
        totalEntities,
        apiKey: options.apiKey,
        signal,
        callbacks,
      });
      enrichmentFailed = enrichment.failed;
    }

    const status: SnapshotStatus = aborted
      ? "canceled"
      : entitiesCompleted === 0 && entitiesFailed > 0
        ? "failed"
        : entitiesFailed > 0
          ? "partial"
          : "success";

    const errorMessage =
      status === "failed"
        ? "All entity fetches failed"
        : status === "canceled"
          ? "Refresh canceled by user"
          : null;

    await storage.updateSnapshot({
      id: snapshotId,
      status,
      errorMessage,
      finishedAt: new Date().toISOString(),
      entitiesCompleted,
      entitiesFailed,
      totalRows,
    });

    emitProgress(callbacks, {
      snapshotId,
      totalEntities: entities.length,
      entitiesCompleted,
      entitiesFailed,
      totalRows,
      currentEntity: null,
      currentEntityIndex: null,
      status,
      errorMessage,
    });

    if (status === "success") {
      emitLog(callbacks, "success", `Refresh complete: ${entitiesCompleted}/${entities.length} entities, ${totalRows} rows.`);
    } else if (status === "partial") {
      emitLog(
        callbacks,
        "warning",
        `Refresh complete with partial failures: ${entitiesCompleted}/${entities.length} succeeded, ${entitiesFailed} failed.`,
      );
    } else if (status === "canceled") {
      emitLog(callbacks, "warning", `Refresh canceled after ${entitiesCompleted} completed and ${entitiesFailed} failed.`);
    } else {
      emitLog(callbacks, "error", "All entity fetches failed.");
    }

    if (enrichmentFailed > 0) {
      emitLog(
        callbacks,
        "warning",
        `${enrichmentFailed} market-data lookups were skipped. Liquidity filtering is best-effort for this snapshot.`,
      );
    }

    return {
      snapshotId,
      totalEntities,
      entitiesCompleted,
      entitiesFailed,
      totalRows,
      status,
    };
  } catch (error) {
    if (isAbortError(error)) {
      if (snapshotId > 0) {
        await storage.updateSnapshot({
          id: snapshotId,
          status: "canceled",
          errorMessage: "Refresh canceled by user",
          finishedAt: new Date().toISOString(),
          entitiesCompleted,
          entitiesFailed,
          totalRows,
        });
        emitProgress(callbacks, {
          snapshotId,
          totalEntities,
          entitiesCompleted,
          entitiesFailed,
          totalRows,
          currentEntity: null,
          currentEntityIndex: null,
          status: "canceled",
          errorMessage: "Refresh canceled by user",
        });
        emitLog(callbacks, "warning", "Refresh canceled by user.");
        return {
          snapshotId,
          totalEntities,
          entitiesCompleted,
          entitiesFailed,
          totalRows,
          status: "canceled",
        };
      }
    }
    throw error;
  } finally {
    await storage.close();
  }
}

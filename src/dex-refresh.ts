import { canonicalAddress, fetchSnapshotMarketCaps, marketCapTokenKey, selectMarketCap } from "./market-cap";
import {
  fetchGeckoTerminalMarketData,
  type GeckoTerminalMarketData,
  toGeckoTerminalNetworkId,
} from "./geckoterminal";
import { loadTrackedEntities } from "./entities";
import { getCieloProviderConfig, getProviderLabel } from "./holdings-provider";
import { resolveWorkspacePaths } from "./runtime-paths";
import { createStorage } from "./storage";
import { runHoldingSnapshotEntities } from "./holding-snapshot-run";
import { throwIfAborted } from "./refresh-support";
import {
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
  return error !== null && typeof error === "object" && "name" in error && (error as { name?: string }).name === "AbortError";
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
  signal?: AbortSignal;
  callbacks: RefreshCallbacks;
}): Promise<{ attempted: number; enriched: number; failed: number }> {
  const snapshotTokens = (await options.storage.getSnapshotTokensForEnrichment(options.snapshotId, 111, 1))
    .filter((token) => token.tokenAddress)
    .slice(0, options.totalEntities <= 1 ? 25 : undefined);

  if (!snapshotTokens.length) {
    emitLog(options.callbacks, "info", "No enrichable token contracts found for GeckoTerminal market-data lookup.");
    return { attempted: 0, enriched: 0, failed: 0 };
  }

  emitLog(
    options.callbacks,
    "info",
    `Enriching ${snapshotTokens.length} unique tokens with GeckoTerminal pool data and CoinGecko/CoinMarketCap MCAP checks.`,
  );

  let marketDataByTokenAddress: Map<string, GeckoTerminalMarketData>;
  try {
    marketDataByTokenAddress = await fetchGeckoTerminalMarketData(
      snapshotTokens.map((token) => ({
        tokenAddress: token.tokenAddress!,
        chainId: token.chainId,
        networkName: token.networkName,
      })),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitLog(options.callbacks, "warning", `GeckoTerminal enrichment skipped: ${message}`);
    marketDataByTokenAddress = new Map();
  }

  throwIfAborted(options.signal);
  const capQuotes = await fetchSnapshotMarketCaps(snapshotTokens.map(token => ({ tokenAddress: token.tokenAddress!, chainId: token.chainId, networkName: token.networkName })));
  let enriched = 0;
  let failed = 0;
  let marketCapsFound = 0;
  let tokenAgesFound = 0;
  for (const token of snapshotTokens) {
    if (options.signal?.aborted) {
      throw new DOMException("Refresh canceled", "AbortError");
    }

    const geckoNetworkId = toGeckoTerminalNetworkId(token.chainId, token.networkName);
    const marketData = token.tokenAddress
      ? marketDataByTokenAddress.get(`${geckoNetworkId || "unknown"}:${canonicalAddress(token.tokenAddress)}`)
      : null;

    const external = capQuotes.get(marketCapTokenKey({ tokenAddress: token.tokenAddress!, chainId: token.chainId, networkName: token.networkName }));
    if (!marketData && !external?.marketCap && external?.marketCapEvidence.status !== "conflict") {
      failed += 1;
      emitLog(options.callbacks, "warning", `GeckoTerminal market-data lookup returned no token data for ${token.tokenSymbol}.`);
      continue;
    }

    const quote = external?.marketCapEvidence.status === "conflict" || external?.marketCap != null
      ? external
      : selectMarketCap(null, null, new Date().toISOString(), marketData?.marketCap || null);
    const enrichedData = { liquidityUsd: null, volume24h: null, txns24h: null, tokenAgeHours: null, ...marketData, ...quote };
    await options.storage.updateSnapshotTokenMarketData(options.snapshotId, token.tokenKey, enrichedData);
    enriched += 1;
    if (enrichedData.marketCap != null) marketCapsFound += 1;
    if (enrichedData.tokenAgeHours != null) tokenAgesFound += 1;
  }

  emitLog(
    options.callbacks,
    failed > 0 || marketCapsFound < snapshotTokens.length || tokenAgesFound < snapshotTokens.length ? "warning" : "success",
    failed > 0
      ? `GeckoTerminal enrichment finished: ${enriched}/${snapshotTokens.length} tokens with pair data, ${failed} missing pair data; market cap ${marketCapsFound}/${snapshotTokens.length}, token age ${tokenAgesFound}/${snapshotTokens.length}.`
      : `GeckoTerminal enrichment finished: ${enriched}/${snapshotTokens.length} tokens with pair data; market cap ${marketCapsFound}/${snapshotTokens.length}, token age ${tokenAgesFound}/${snapshotTokens.length}.`,
  );

  return {
    attempted: snapshotTokens.length,
    enriched,
    failed,
  };
}

export async function runDexRefresh(options: {
  cwd?: string;
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
  const failureReasons = new Map<string, number>();
  const firecrawlApiKey = process.env.FIRECRAWL_API_KEY?.trim();

  try {
    throwIfAborted(signal);
    if (!firecrawlApiKey) {
      throw new Error("FIRECRAWL_API_KEY is not configured for Cielo portfolio refreshes");
    }

    const imported = loadTrackedEntities(paths.cieloEntitiesCsv);
    emitLog(callbacks, "info", `Using holdings provider ${getProviderLabel()}.`);
    emitLog(callbacks, "info", `Imported ${imported.length} tracked entities from Cielo CSV.`);
    await storage.replaceEntities(imported);

    const sourceUrls = imported.map((entity) => entity.sourceUrl);
    const entities = await storage.getEntitiesByLinks(sourceUrls);
    if (entities.length !== imported.length) {
      emitLog(callbacks, "warning", `Cielo entity selection found ${entities.length}/${imported.length} imported entities after storage sync.`);
    }

    const providerLabel = getProviderLabel();
    snapshotId = await storage.createSnapshot(entities.length, providerLabel);
    totalEntities = entities.length;
    emitProgress(callbacks, createProgressState({ snapshotId, totalEntities, status: "running" }));
    emitLog(callbacks, "info", `Created snapshot #${snapshotId} for ${entities.length} entities.`);

    const cieloConfig = getCieloProviderConfig();
    const refreshConcurrency = Math.max(1, Math.min(entities.length, cieloConfig.concurrency));
    emitLog(
      callbacks,
      "info",
      `Fetching entities with adaptive Cielo concurrency ${refreshConcurrency} (min ${cieloConfig.minConcurrency}, max ${cieloConfig.maxConcurrency}).`,
    );
    const holdingRun = await runHoldingSnapshotEntities({
      storage,
      snapshotId,
      entities,
      concurrency: refreshConcurrency,
      firecrawlApiKey,
      signal,
      callbacks,
      cieloAdaptiveConfig: {
        initialConcurrency: refreshConcurrency,
        minConcurrency: cieloConfig.minConcurrency,
        maxConcurrency: Math.max(1, Math.min(entities.length, cieloConfig.maxConcurrency)),
        successStreakToIncrease: cieloConfig.successStreakToIncrease,
        maxEntityAttempts: cieloConfig.maxEntityAttempts,
        entityRetryBaseDelayMs: cieloConfig.entityRetryBaseDelayMs,
        entityRetryMaxDelayMs: cieloConfig.entityRetryMaxDelayMs,
      },
    });
    entitiesCompleted = holdingRun.entitiesCompleted;
    entitiesFailed = holdingRun.entitiesFailed;
    totalRows = holdingRun.totalRows;
    aborted = holdingRun.aborted;
    for (const [message, count] of holdingRun.failureReasons) failureReasons.set(message, count);

    if (!aborted && entitiesCompleted > 0) {
      emitProgress(callbacks, {
        snapshotId,
        totalEntities,
        entitiesCompleted,
        entitiesFailed,
        totalRows,
        currentEntity: "Enriching market data",
        currentEntityIndex: null,
        status: "running",
        errorMessage: null,
      });
      await enrichSnapshotMarketData({ storage, snapshotId, totalEntities, signal, callbacks });
    }

    const status: SnapshotStatus = aborted
      ? "canceled"
      : entitiesCompleted === 0 && entitiesFailed > 0
        ? "failed"
        : entitiesFailed > 0
          ? "partial"
          : "success";
    const dominantFailureMessage = failureReasons.size
      ? Array.from(failureReasons.entries()).sort((left, right) => right[1] - left[1])[0][0]
      : null;
    const errorMessage = status === "failed"
      ? dominantFailureMessage ? `All entity fetches failed: ${dominantFailureMessage}` : "All entity fetches failed"
      : status === "canceled" ? "Refresh canceled by user" : null;

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
      totalEntities,
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
      emitLog(callbacks, "warning", `Refresh complete with partial failures: ${entitiesCompleted}/${entities.length} succeeded, ${entitiesFailed} failed.`);
    } else if (status === "canceled") {
      emitLog(callbacks, "warning", `Refresh canceled after ${entitiesCompleted} completed and ${entitiesFailed} failed.`);
    } else {
      emitLog(callbacks, "error", errorMessage || "All entity fetches failed.");
    }
    return { snapshotId, totalEntities, entitiesCompleted, entitiesFailed, totalRows, status };
  } catch (error) {
    if (isAbortError(error)) {
      aborted = true;
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
        return { snapshotId, totalEntities, entitiesCompleted, entitiesFailed, totalRows, status: "canceled" };
      }
    }
    throw error;
  } finally {
    await storage.close();
  }
}

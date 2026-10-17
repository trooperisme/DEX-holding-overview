import { toTokenKey } from "./entities";
import { extractCieloBundleId, fetchCieloPortfolio, CieloFetchOptions, CieloScrapeResult } from "./cielo";
import {
  emitLog,
  emitProgress,
  isAbortError,
  RefreshCallbacks,
  throwIfAborted,
} from "./refresh-support";
import { StorageAdapter } from "./storage-types";
import {
  EntityRecord,
  EntityWalletRecord,
  RawHoldingRecord,
  TokenBalance,
} from "./types";

type SnapshotEntity = EntityRecord & { wallets: EntityWalletRecord[] };

type HoldingSourceAdapters = {
  fetchCieloPortfolio: typeof fetchCieloPortfolio;
};

type EntityRunResult = {
  completed: boolean;
  failed: boolean;
  canceled: boolean;
  retryable: boolean;
  rowsFound: number;
  errorMessage: string | null;
};

export type CieloAdaptiveConfig = {
  initialConcurrency: number;
  minConcurrency: number;
  maxConcurrency: number;
  successStreakToIncrease: number;
  entityRetryBaseDelayMs: number;
  entityRetryMaxDelayMs: number;
};

export type HoldingSnapshotRunResult = {
  entitiesCompleted: number;
  entitiesFailed: number;
  totalRows: number;
  aborted: boolean;
  failureReasons: Map<string, number>;
};

const DEFAULT_SOURCE_ADAPTERS: HoldingSourceAdapters = {
  fetchCieloPortfolio,
};

function addDecimalStrings(left: string, right: string): string {
  const sum = Number(left || 0) + Number(right || 0);
  return Number.isFinite(sum) ? String(sum) : left;
}

function aggregateTokenBalancesByKey(balances: TokenBalance[]): TokenBalance[] {
  const byTokenKey = new Map<string, TokenBalance>();

  for (const balance of balances) {
    const key = toTokenKey(balance);
    const existing = byTokenKey.get(key);
    if (!existing) {
      byTokenKey.set(key, { ...balance });
      continue;
    }

    existing.balance = addDecimalStrings(existing.balance, balance.balance);
    existing.balanceRaw = addDecimalStrings(existing.balanceRaw, balance.balanceRaw);
    existing.balanceUsd += balance.balanceUsd;
    existing.price ??= balance.price;
    existing.marketCap ??= balance.marketCap;
    existing.liquidityUsd ??= balance.liquidityUsd;
    existing.volume24h ??= balance.volume24h;
    existing.txns24h ??= balance.txns24h;
    existing.tokenAgeHours ??= balance.tokenAgeHours;
  }

  return Array.from(byTokenKey.values()).map((balance) => ({
    ...balance,
    liquidityUsd: balance.liquidityUsd ?? null,
    balanceUsd: Math.round(balance.balanceUsd * 100) / 100,
  }));
}

function toRawHoldingRows(options: {
  snapshotId: number;
  entityId: number;
  balances: TokenBalance[];
  fetchedAt: string;
}): RawHoldingRecord[] {
  return aggregateTokenBalancesByKey(options.balances).map((holding) => ({
    snapshotId: options.snapshotId,
    entityId: options.entityId,
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
    fetchedAt: options.fetchedAt,
  }));
}

async function fetchEntityBalances(options: {
  sourceAdapters: HoldingSourceAdapters;
  firecrawlApiKey: string;
  entitySourceLink: string;
  cieloFetchCache: Map<string, Promise<CieloScrapeResult>>;
  entityLabel: string;
  signal?: AbortSignal;
  callbacks: RefreshCallbacks;
}): Promise<TokenBalance[]> {
  if (!options.firecrawlApiKey) {
    throw new Error("FIRECRAWL_API_KEY is not configured for Cielo portfolio refreshes");
  }
  const bundleId = extractCieloBundleId(options.entitySourceLink);
  const bundleUrl = new URL(options.entitySourceLink);
  bundleUrl.hash = "";
  let scrapePromise = options.cieloFetchCache.get(bundleId);
  if (!scrapePromise) {
    const request: CieloFetchOptions = {
      firecrawlApiKey: options.firecrawlApiKey,
      bundleUrl: bundleUrl.toString(),
      signal: options.signal,
      cacheMaxAgeMs: 0,
      storeInCache: false,
    };
    scrapePromise = options.sourceAdapters.fetchCieloPortfolio(request).catch((error) => {
      options.cieloFetchCache.delete(bundleId);
      throw error;
    });
    options.cieloFetchCache.set(bundleId, scrapePromise);
  }

  const result = await scrapePromise;
  const metadata = result.metadata;
  emitLog(
    options.callbacks,
    metadata.unknownChainRows > 0 ? "warning" : "info",
    `Cielo bundle ${metadata.bundleId} for ${options.entityLabel}: ${metadata.rowCount} rows, $${metadata.parsedTotalUsd.toFixed(2)} parsed in ${metadata.elapsedMs}ms (parser ${metadata.parserVersion}).${metadata.unknownChainRows > 0 ? ` Unknown chain: ${metadata.unknownChainRows} row(s), $${metadata.unknownChainValueUsd.toFixed(2)}.` : ""}`,
  );
  return result.balances;
}

async function runEntitySnapshotFetch(options: {
  storage: StorageAdapter;
  sourceAdapters: HoldingSourceAdapters;
  cieloFetchCache: Map<string, Promise<CieloScrapeResult>>;
  snapshotId: number;
  totalEntities: number;
  entity: SnapshotEntity;
  entityIndex: number;
  entitiesCompleted: number;
  entitiesFailed: number;
  totalRows: number;
  firecrawlApiKey: string;
  signal?: AbortSignal;
  callbacks: RefreshCallbacks;
  shouldRetryError?: (message: string) => boolean;
}): Promise<EntityRunResult> {
  const entityLabel = options.entity.resolvedLabel || options.entity.entityName;
  emitProgress(options.callbacks, {
    snapshotId: options.snapshotId,
    totalEntities: options.totalEntities,
    entitiesCompleted: options.entitiesCompleted,
    entitiesFailed: options.entitiesFailed,
    totalRows: options.totalRows,
    currentEntity: entityLabel,
    currentEntityIndex: options.entityIndex + 1,
    status: "running",
    errorMessage: null,
  });
  emitLog(options.callbacks, "info", `Fetching ${entityLabel} (${options.entityIndex + 1}/${options.totalEntities})...`);

  const runId = await options.storage.insertEntityFetchRun({
    snapshotId: options.snapshotId,
    entityId: options.entity.id,
    status: "running",
    rowsFound: 0,
    totalBalanceUsd: 0,
    errorMessage: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  });

  try {
    const balances = await fetchEntityBalances({
      sourceAdapters: options.sourceAdapters,
      firecrawlApiKey: options.firecrawlApiKey,
      entitySourceLink: options.entity.sourceUrl,
      cieloFetchCache: options.cieloFetchCache,
      entityLabel,
      signal: options.signal,
      callbacks: options.callbacks,
    });
    const rows = toRawHoldingRows({
      snapshotId: options.snapshotId,
      entityId: options.entity.id,
      balances,
      fetchedAt: new Date().toISOString(),
    });

    await options.storage.insertRawHoldingsForEntity(options.snapshotId, options.entity.id, rows);
    const totalBalanceUsd = rows.reduce((sum, row) => sum + row.balanceUsd, 0);
    await options.storage.updateEntityFetchRun(runId, {
      status: "success",
      rowsFound: rows.length,
      totalBalanceUsd,
      errorMessage: null,
      finishedAt: new Date().toISOString(),
    });
    emitLog(
      options.callbacks,
      "success",
      `Completed ${entityLabel}: ${rows.length} token rows, ${totalBalanceUsd.toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 2,
      })} total.`,
    );

    return {
      completed: true,
      failed: false,
      canceled: false,
      retryable: false,
      rowsFound: rows.length,
      errorMessage: null,
    };
  } catch (error) {
    if (isAbortError(error)) {
      await options.storage.updateEntityFetchRun(runId, {
        status: "canceled",
        rowsFound: 0,
        totalBalanceUsd: 0,
        errorMessage: "Refresh canceled by user",
        finishedAt: new Date().toISOString(),
      });
      emitLog(options.callbacks, "warning", `Canceled while processing ${entityLabel}.`);
      return {
        completed: false,
        failed: false,
        canceled: true,
        retryable: false,
        rowsFound: 0,
        errorMessage: "Refresh canceled by user",
      };
    }

    const message = error instanceof Error ? error.message : String(error);
    const retryable = Boolean(options.shouldRetryError?.(message));
    await options.storage.updateEntityFetchRun(runId, {
      status: retryable ? "canceled" : "failed",
      rowsFound: 0,
      totalBalanceUsd: 0,
      errorMessage: retryable ? `Retry scheduled: ${message}` : message,
      finishedAt: new Date().toISOString(),
    });
    emitLog(options.callbacks, retryable ? "warning" : "error", retryable ? `Transient failure for ${entityLabel}: ${message}` : `Failed ${entityLabel}: ${message}`);

    return {
      completed: false,
      failed: !retryable,
      canceled: false,
      retryable,
      rowsFound: 0,
      errorMessage: message,
    };
  }
}

export async function runHoldingSnapshotEntities(options: {
  storage: StorageAdapter;
  snapshotId: number;
  entities: SnapshotEntity[];
  concurrency: number;
  firecrawlApiKey: string;
  signal?: AbortSignal;
  callbacks: RefreshCallbacks;
  sourceAdapters?: Partial<HoldingSourceAdapters>;
  cieloAdaptiveConfig?: CieloAdaptiveConfig;
}): Promise<HoldingSnapshotRunResult> {
  const sourceAdapters = {
    ...DEFAULT_SOURCE_ADAPTERS,
    ...options.sourceAdapters,
  };
  const cieloFetchCache = new Map<string, Promise<CieloScrapeResult>>();
  const result: HoldingSnapshotRunResult = {
    entitiesCompleted: 0,
    entitiesFailed: 0,
    totalRows: 0,
    aborted: false,
    failureReasons: new Map(),
  };

  const updateSnapshotProgress = async (entity: SnapshotEntity, entityIndex: number, errorMessage: string | null): Promise<void> => {
    await options.storage.updateSnapshot({
      id: options.snapshotId,
      entitiesCompleted: result.entitiesCompleted,
      entitiesFailed: result.entitiesFailed,
      totalRows: result.totalRows,
    });
    emitProgress(options.callbacks, {
      snapshotId: options.snapshotId,
      totalEntities: options.entities.length,
      entitiesCompleted: result.entitiesCompleted,
      entitiesFailed: result.entitiesFailed,
      totalRows: result.totalRows,
      currentEntity: entity.resolvedLabel || entity.entityName,
      currentEntityIndex: entityIndex + 1,
      status: "running",
      errorMessage,
    });
  };

  const applyEntityResult = async (entity: SnapshotEntity, entityIndex: number, entityResult: EntityRunResult): Promise<void> => {
    if (entityResult.canceled) {
      result.aborted = true;
      return;
    }

    if (entityResult.completed) {
      result.entitiesCompleted += 1;
      result.totalRows += entityResult.rowsFound;
      await updateSnapshotProgress(entity, entityIndex, null);
      return;
    }

    if (entityResult.failed) {
      result.entitiesFailed += 1;
      const message = entityResult.errorMessage || "Entity fetch failed";
      result.failureReasons.set(message, (result.failureReasons.get(message) || 0) + 1);
      await updateSnapshotProgress(entity, entityIndex, message);
    }
  };

  {
    const config = options.cieloAdaptiveConfig ?? {
      initialConcurrency: options.concurrency,
      minConcurrency: 1,
      maxConcurrency: Math.max(1, options.concurrency),
      successStreakToIncrease: 5,
      entityRetryBaseDelayMs: 30_000,
      entityRetryMaxDelayMs: 300_000,
    };
    const pendingEntityIndexes = options.entities.map((_, index) => index);
    const attemptsByEntityIndex = new Map<number, number>();
    const retryTimers = new Map<number, ReturnType<typeof setTimeout>>();
    let active = 0;
    let scheduledRetries = 0;
    let totalRetryAttempts = 0;
    let currentConcurrency = Math.max(
      config.minConcurrency,
      Math.min(config.maxConcurrency, config.initialConcurrency, options.entities.length),
    );
    let successStreak = 0;

    emitLog(
      options.callbacks,
      "info",
      `Cielo adaptive scheduler started: concurrency ${currentConcurrency}, min ${config.minConcurrency}, max ${config.maxConcurrency}.`,
    );

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const clearRetryTimers = (): void => {
        for (const timer of retryTimers.values()) clearTimeout(timer);
        retryTimers.clear();
        scheduledRetries = 0;
      };
      const finish = (): void => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        clearRetryTimers();
        options.signal?.removeEventListener("abort", onAbort);
        reject(error);
      };
      const onAbort = (): void => {
        clearRetryTimers();
        finish();
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });

      const schedule = (): void => {
        if (result.aborted) {
          clearRetryTimers();
          finish();
          return;
        }
        if (active === 0 && pendingEntityIndexes.length === 0 && scheduledRetries === 0) {
          finish();
          return;
        }

        while (active < currentConcurrency && pendingEntityIndexes.length > 0 && !result.aborted) {
          throwIfAborted(options.signal);
          const entityIndex = pendingEntityIndexes.shift()!;
          const entity = options.entities[entityIndex];
          active += 1;

          void (async () => {
            try {
              const attempt = (attemptsByEntityIndex.get(entityIndex) || 0) + 1;
              attemptsByEntityIndex.set(entityIndex, attempt);
              const entityResult = await runEntitySnapshotFetch({
                storage: options.storage,
                sourceAdapters,
                cieloFetchCache,
                snapshotId: options.snapshotId,
                totalEntities: options.entities.length,
                entity,
                entityIndex,
                entitiesCompleted: result.entitiesCompleted,
                entitiesFailed: result.entitiesFailed,
                totalRows: result.totalRows,
                firecrawlApiKey: options.firecrawlApiKey,
                signal: options.signal,
                callbacks: options.callbacks,
                shouldRetryError: () => true,
              });

              if (entityResult.retryable) {
                totalRetryAttempts += 1;
                currentConcurrency = config.minConcurrency;
                successStreak = 0;
                const retryDelayMs = Math.min(
                  config.entityRetryMaxDelayMs,
                  config.entityRetryBaseDelayMs * (2 ** Math.min(attempt - 1, 20)),
                );
                emitLog(
                  options.callbacks,
                  "warning",
                  `Cielo adaptive concurrency reduced to ${currentConcurrency} after scrape failure; retrying ${entity.resolvedLabel || entity.entityName} in ${retryDelayMs}ms (attempt ${attempt + 1}, ${totalRetryAttempts} batch retries).`,
                );
                scheduledRetries += 1;
                const timer = setTimeout(() => {
                  retryTimers.delete(entityIndex);
                  scheduledRetries -= 1;
                  if (!options.signal?.aborted) pendingEntityIndexes.push(entityIndex);
                  schedule();
                }, retryDelayMs);
                retryTimers.set(entityIndex, timer);
                return;
              }

              await applyEntityResult(entity, entityIndex, entityResult);
              if (entityResult.completed) {
                successStreak += 1;
                if (successStreak >= config.successStreakToIncrease && currentConcurrency < config.maxConcurrency) {
                  currentConcurrency += 1;
                  successStreak = 0;
                  emitLog(
                    options.callbacks,
                    "info",
                    `Cielo adaptive concurrency increased to ${currentConcurrency} after ${config.successStreakToIncrease} successful scrape(s).`,
                  );
                }
              } else if (entityResult.failed) {
                successStreak = 0;
              }
            } catch (error) {
              fail(error);
              return;
            } finally {
              active -= 1;
              try {
                schedule();
              } catch (error) {
                fail(error);
              }
            }
          })();
        }
      };

      try {
        schedule();
      } catch (error) {
        fail(error);
      }
    });

    return result;
  }

  return result;
}

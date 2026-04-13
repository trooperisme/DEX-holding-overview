import { loadImportedEntities, maskApiKey, toTokenKey } from "./entities";
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

  const throwIfAborted = (): void => {
    if (signal?.aborted) {
      throw new DOMException("Refresh canceled", "AbortError");
    }
  };

  try {
    throwIfAborted();
    const imported = loadImportedEntities(paths.entitiesCsv);
    emitLog(callbacks, "info", `Imported ${imported.length} tracked entities from CSV.`);
    storage.replaceEntities(imported);

    const entities = storage.getEntities();
    snapshotId = storage.createSnapshot(entities.length, maskApiKey(options.apiKey));
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
      const runId = storage.insertEntityFetchRun({
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
          fetchedAt,
        }));

        storage.insertRawHoldingsForEntity(snapshotId, entity.id, rows);
        entitiesCompleted += 1;
        totalRows += rows.length;
        storage.updateEntityFetchRun(runId, {
          status: "success",
          rowsFound: rows.length,
          totalBalanceUsd: result.totalBalanceUsd,
          errorMessage: null,
          finishedAt: new Date().toISOString(),
        });
        storage.updateSnapshot({
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
          storage.updateEntityFetchRun(runId, {
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
        storage.updateEntityFetchRun(runId, {
          status: "failed",
          rowsFound: 0,
          totalBalanceUsd: 0,
          errorMessage: message,
          finishedAt: new Date().toISOString(),
        });
        storage.updateSnapshot({
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

    storage.updateSnapshot({
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
        storage.updateSnapshot({
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
    storage.close();
  }
}

import assert from "node:assert/strict";
import test from "node:test";
import { runHoldingSnapshotEntities } from "./holding-snapshot-run";
import { StorageAdapter } from "./storage-types";
import {
  EntityFetchRunRecord,
  EntityRecord,
  EntityWalletRecord,
  RawHoldingRecord,
  RefreshLogEntry,
  RefreshProgressState,
  TokenBalance,
} from "./types";

function entity(wallets: string[]): EntityRecord & { wallets: EntityWalletRecord[] } {
  return {
    id: 7,
    entityName: "smw-alpha",
    sourceUrl: "https://app.cielo.finance/bundles/100/portfolio",
    resolvedLabel: "SMW Alpha",
    linkType: "bundle",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    wallets: wallets.map((walletAddress, walletIndex) => ({
      entityId: 7,
      walletAddress,
      walletIndex,
    })),
  };
}

function tokenBalance(input: Partial<TokenBalance> = {}): TokenBalance {
  return {
    tokenSymbol: "ALPHA",
    tokenName: "Alpha",
    tokenAddress: "0xalpha",
    networkName: "Base",
    chainId: 8453,
    balance: "10",
    balanceRaw: "10",
    balanceUsd: 100,
    price: null,
    marketCap: null,
    liquidityUsd: null,
    volume24h: null,
    txns24h: null,
    tokenAgeHours: null,
    ...input,
  };
}

function createFakeStorage() {
  const fetchRuns: EntityFetchRunRecord[] = [];
  const fetchRunUpdates: Array<{ id: number; update: Partial<EntityFetchRunRecord> }> = [];
  const rawWrites: Array<{ snapshotId: number; entityId: number; rows: RawHoldingRecord[] }> = [];
  const snapshotUpdates: unknown[] = [];
  let nextRunId = 1;

  const storage = {
    insertEntityFetchRun(run: EntityFetchRunRecord): number {
      const id = nextRunId;
      nextRunId += 1;
      fetchRuns.push({ ...run, id });
      return id;
    },
    updateEntityFetchRun(id: number, update: Partial<EntityFetchRunRecord>): void {
      fetchRunUpdates.push({ id, update });
    },
    insertRawHoldingsForEntity(snapshotId: number, entityId: number, rows: RawHoldingRecord[]): void {
      rawWrites.push({ snapshotId, entityId, rows });
    },
    updateSnapshot(update: unknown): void {
      snapshotUpdates.push(update);
    },
  } as unknown as StorageAdapter;

  return {
    storage,
    fetchRuns,
    fetchRunUpdates,
    rawWrites,
    snapshotUpdates,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

test("runHoldingSnapshotEntities retries a failed Cielo bundle until the full batch succeeds", async () => {
  const fake = createFakeStorage();
  const calls: string[] = [];
  let deletedBundleAttempts = 0;
  const cieloBalance = tokenBalance({ tokenSymbol: "CIELO", tokenName: "Cielo", balanceUsd: 42 });
  const entities = [
    { ...entity([]), id: 1, entityName: "Alpha", sourceUrl: "https://app.cielo.finance/bundles/101/portfolio", resolvedLabel: "Alpha" },
    { ...entity([]), id: 2, entityName: "Alpha copy", sourceUrl: "https://app.cielo.finance/bundles/101/portfolio", resolvedLabel: "Alpha copy" },
    { ...entity([]), id: 3, entityName: "Deleted", sourceUrl: "https://app.cielo.finance/bundles/999/portfolio", resolvedLabel: "Deleted" },
  ];

  const result = await runHoldingSnapshotEntities({
    storage: fake.storage,
    snapshotId: 44,
    entities,
    concurrency: 3,
    firecrawlApiKey: "firecrawl-key",
    callbacks: { onLog: () => undefined },
    cieloAdaptiveConfig: {
      initialConcurrency: 3,
      minConcurrency: 1,
      maxConcurrency: 3,
      successStreakToIncrease: 5,
      entityRetryBaseDelayMs: 0,
      entityRetryMaxDelayMs: 10,
    },
    sourceAdapters: {
      async fetchCieloPortfolio(options) {
        calls.push(options.bundleUrl);
        if (options.bundleUrl.includes("999")) {
          deletedBundleAttempts += 1;
          if (deletedBundleAttempts === 1) throw new Error("Bundle not found");
        }
        return {
          balances: [cieloBalance],
          metadata: {
            bundleId: "101",
            elapsedMs: 2,
            rowCount: 1,
            displayedTotalUsd: 42,
            parsedTotalUsd: 42,
            unknownChainRows: 0,
            unknownChainValueUsd: 0,
            parserVersion: "test",
          },
        };
      },
    },
  });

  assert.equal(result.entitiesCompleted, 3);
  assert.equal(result.entitiesFailed, 0);
  assert.equal(result.totalRows, 3);
  assert.deepEqual(calls.sort(), [
    "https://app.cielo.finance/bundles/101/portfolio",
    "https://app.cielo.finance/bundles/999/portfolio",
    "https://app.cielo.finance/bundles/999/portfolio",
  ]);
  assert.equal(fake.rawWrites.length, 3);
  assert.equal(fake.fetchRunUpdates.filter((item) => item.update.status === "failed").length, 0);
});

test("runHoldingSnapshotEntities flushes Cielo rows after each entity while the snapshot is still running", async () => {
  const fake = createFakeStorage();
  const secondEntity = deferred<{
    balances: TokenBalance[];
    metadata: {
      bundleId: string;
      elapsedMs: number;
      rowCount: number;
      displayedTotalUsd: number;
      parsedTotalUsd: number;
      unknownChainRows: number;
      unknownChainValueUsd: number;
      parserVersion: string;
    };
  }>();
  const entities = [
    { ...entity([]), id: 1, entityName: "First", sourceUrl: "https://app.cielo.finance/bundles/201/portfolio", resolvedLabel: "First" },
    { ...entity([]), id: 2, entityName: "Second", sourceUrl: "https://app.cielo.finance/bundles/202/portfolio", resolvedLabel: "Second" },
  ];

  const runPromise = runHoldingSnapshotEntities({
    storage: fake.storage,
    snapshotId: 45,
    entities,
    concurrency: 1,
    firecrawlApiKey: "firecrawl-key",
    callbacks: { onLog: () => undefined },
    sourceAdapters: {
      async fetchCieloPortfolio(options) {
        if (options.bundleUrl.includes("202")) return secondEntity.promise;
        return {
          balances: [tokenBalance({ tokenSymbol: "FIRST", tokenName: "First", balanceUsd: 10 })],
          metadata: {
            bundleId: "201",
            elapsedMs: 1,
            rowCount: 1,
            displayedTotalUsd: 10,
            parsedTotalUsd: 10,
            unknownChainRows: 0,
            unknownChainValueUsd: 0,
            parserVersion: "test",
          },
        };
      },
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fake.rawWrites.length, 1);
  assert.equal(fake.rawWrites[0].entityId, 1);
  assert.equal((fake.snapshotUpdates.at(-1) as { totalRows?: number } | undefined)?.totalRows, 1);

  secondEntity.resolve({
    balances: [tokenBalance({ tokenSymbol: "SECOND", tokenName: "Second", balanceUsd: 20 })],
    metadata: {
      bundleId: "202",
      elapsedMs: 1,
      rowCount: 1,
      displayedTotalUsd: 20,
      parsedTotalUsd: 20,
      unknownChainRows: 0,
      unknownChainValueUsd: 0,
      parserVersion: "test",
    },
  });

  const result = await runPromise;
  assert.equal(result.entitiesCompleted, 2);
  assert.equal(result.totalRows, 2);
  assert.equal(fake.rawWrites.length, 2);
});

test("runHoldingSnapshotEntities adapts Cielo concurrency and retries transient rate limits", async () => {
  const fake = createFakeStorage();
  const started: string[] = [];
  const logs: RefreshLogEntry[] = [];
  const attemptsByBundle = new Map<string, number>();
  const entities = [
    { ...entity([]), id: 1, entityName: "Alpha", sourceUrl: "https://app.cielo.finance/bundles/301/portfolio", resolvedLabel: "Alpha" },
    { ...entity([]), id: 2, entityName: "Beta", sourceUrl: "https://app.cielo.finance/bundles/302/portfolio", resolvedLabel: "Beta" },
    { ...entity([]), id: 3, entityName: "Gamma", sourceUrl: "https://app.cielo.finance/bundles/303/portfolio", resolvedLabel: "Gamma" },
  ];

  const result = await runHoldingSnapshotEntities({
    storage: fake.storage,
    snapshotId: 46,
    entities,
    concurrency: 2,
    firecrawlApiKey: "firecrawl-key",
    callbacks: {
      onLog: (tone, message) => logs.push({ at: new Date().toISOString(), tone, message }),
    },
    cieloAdaptiveConfig: {
      initialConcurrency: 2,
      minConcurrency: 1,
      maxConcurrency: 3,
      successStreakToIncrease: 1,
      entityRetryBaseDelayMs: 0,
      entityRetryMaxDelayMs: 10,
    },
    sourceAdapters: {
      async fetchCieloPortfolio(options) {
        const bundleId = options.bundleUrl.match(/bundles\/(\d+)/)?.[1] || "unknown";
        started.push(bundleId);
        const attempt = (attemptsByBundle.get(bundleId) || 0) + 1;
        attemptsByBundle.set(bundleId, attempt);
        if (bundleId === "303" && attempt <= 4) {
          throw new Error(attempt < 3 ? "Firecrawl Cielo scrape rate-limited (429)" : "Bundle not found");
        }
        return {
          balances: [tokenBalance({ tokenSymbol: `T${bundleId}`, tokenName: `Token ${bundleId}`, balanceUsd: 10 })],
          metadata: {
            bundleId,
            elapsedMs: 1,
            rowCount: 1,
            displayedTotalUsd: 10,
            parsedTotalUsd: 10,
            unknownChainRows: 0,
            unknownChainValueUsd: 0,
            parserVersion: "test",
          },
        };
      },
    },
  });

  assert.deepEqual(started.slice(0, 2), ["301", "302"]);
  assert.equal(attemptsByBundle.get("303"), 5);
  assert.equal(result.entitiesCompleted, 3);
  assert.equal(result.entitiesFailed, 0);
  assert.equal(result.totalRows, 3);
  assert.equal(fake.rawWrites.length, 3);
  assert.ok(logs.some((entry) => entry.message.includes("Cielo adaptive concurrency increased to 3")));
  assert.ok(logs.some((entry) => entry.message.includes("Cielo adaptive concurrency reduced to 1")));
});

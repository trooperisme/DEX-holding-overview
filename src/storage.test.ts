import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStorage } from "./storage";
import { RawHoldingRecord } from "./types";

function rawHolding(snapshotId: number, entityId: number, moniScore: number | null): RawHoldingRecord {
  return {
    snapshotId,
    entityId,
    tokenKey: "8453:0xnoctest",
    tokenSymbol: "NOCK",
    tokenName: "Nock",
    tokenAddress: "0xnoctest",
    networkName: "Base",
    chainId: 8453,
    balance: "1",
    balanceRaw: "1",
    balanceUsd: 111,
    price: null,
    marketCap: null,
    liquidityUsd: null,
    volume24h: null,
    txns24h: null,
    tokenAgeHours: null,
    moniScore,
    moniLevel: moniScore == null ? null : 5,
    moniLevelName: moniScore == null ? null : "Medium",
    moniMomentumScorePct: moniScore == null ? null : 0,
    moniMomentumRank: moniScore == null ? null : 1467,
    fetchedAt: new Date().toISOString(),
  };
}

test("getLatestTokenMoniDataBeforeSnapshot returns the prior known Moni score", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dex-storage-test-"));
  const previousDatabaseUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;

  const storage = createStorage(cwd);
  try {
    await storage.replaceEntities([
      {
        entityName: "tester",
        fullZapperLink: "https://zapper.xyz/bundle/0xabc?label=tester",
        resolvedLabel: "tester",
        linkType: "bundle",
        walletAddresses: ["0xabc"],
      },
    ]);
    const [entity] = await storage.getEntities();

    const snapshot1 = await storage.createSnapshot(1, null);
    await storage.insertRawHoldingsForEntity(snapshot1, entity.id, [rawHolding(snapshot1, entity.id, 4102)]);

    const snapshot2 = await storage.createSnapshot(1, null);
    await storage.insertRawHoldingsForEntity(snapshot2, entity.id, [rawHolding(snapshot2, entity.id, null)]);

    const fallback = await storage.getLatestTokenMoniDataBeforeSnapshot(snapshot2, "8453:0xnoctest");
    assert.deepEqual(fallback, {
      moniScore: 4102,
      moniLevel: 5,
      moniLevelName: "Medium",
      moniMomentumScorePct: 0,
      moniMomentumRank: 1467,
    });
  } finally {
    await storage.close();
    if (previousDatabaseUrl == null) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

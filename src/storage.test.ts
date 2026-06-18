import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveWorkspacePaths } from "./runtime-paths";
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

function tokenHolding(snapshotId: number, entityId: number, input: Partial<RawHoldingRecord> = {}): RawHoldingRecord {
  return {
    snapshotId,
    entityId,
    tokenKey: "1:0xfaba6f8e4a5e8ab82f62fe7c39859fa577269be3",
    tokenSymbol: "ONDO",
    tokenName: "Ondo",
    tokenAddress: "0xfaba6f8e4a5e8ab82f62fe7c39859fa577269be3",
    networkName: "Ethereum",
    chainId: 1,
    balance: "1000",
    balanceRaw: "1000",
    balanceUsd: 160980.3054685639,
    price: null,
    marketCap: 1730000000,
    liquidityUsd: 100000,
    volume24h: 5000,
    txns24h: 25,
    tokenAgeHours: 1000,
    moniScore: null,
    moniLevel: null,
    moniLevelName: null,
    moniMomentumScorePct: null,
    moniMomentumRank: null,
    fetchedAt: new Date().toISOString(),
    ...input,
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

test("getOverview reuses the latest prior Moni score when the current snapshot is missing it", async () => {
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

    const [overview] = await storage.getOverview(snapshot2, 111, 1, 11111, null);
    assert.equal(overview?.moniScore, 4102);
    assert.equal(overview?.moniLevel, 5);
    assert.equal(overview?.moniLevelName, "Medium");
    assert.equal(overview?.moniMomentumScorePct, 0);
    assert.equal(overview?.moniMomentumRank, 1467);
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

test("token aggregations collapse duplicate database rows for the same logical entity", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dex-storage-test-"));
  const previousDatabaseUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;

  let storage = createStorage(cwd);
  await storage.close();

  const Database = require("better-sqlite3") as typeof import("better-sqlite3");
  const db = new Database(resolveWorkspacePaths(cwd).dbFile);
  const now = new Date().toISOString();
  const insertEntity = db.prepare(`
    INSERT INTO entities (entity_name, full_zapper_link, resolved_label, link_type, created_at, updated_at)
    VALUES (?, ?, ?, 'bundle', ?, ?)
  `);
  const firstId = Number(
    insertEntity.run("JoshuaDeuk", "https://zapper.xyz/bundle/0xfirst?label=JoshuaDeuk", "JoshuaDeuk", now, now)
      .lastInsertRowid,
  );
  const duplicateId = Number(
    insertEntity.run("JoshuaDeuk", "https://zapper.xyz/bundle/0xduplicate?label=JoshuaDeuk", "JoshuaDeuk", now, now)
      .lastInsertRowid,
  );
  db.close();

  storage = createStorage(cwd);
  try {
    const snapshot = await storage.createSnapshot(2, null);
    await storage.insertRawHoldingsForEntity(snapshot, firstId, [tokenHolding(snapshot, firstId)]);
    await storage.insertRawHoldingsForEntity(snapshot, duplicateId, [tokenHolding(snapshot, duplicateId)]);
    await storage.updateSnapshot({
      id: snapshot,
      status: "partial",
      totalRows: 2,
      entitiesCompleted: 2,
      entitiesFailed: 0,
      finishedAt: new Date().toISOString(),
    });

    const [overview] = await storage.getOverview(snapshot, 111, 1, 11111, null);
    assert.equal(overview?.tokenSymbol, "ONDO");
    assert.equal(overview?.smwIn, 1);
    assert.equal(overview?.holdingsUsd, 160980.31);

    const holders = await storage.getTokenHolders(snapshot, "1:0xfaba6f8e4a5e8ab82f62fe7c39859fa577269be3", 111);
    assert.equal(holders.length, 1);
    assert.equal(holders[0].entityName, "JoshuaDeuk");
    assert.equal(holders[0].balanceUsd, 160980.3054685639);

    const [history] = await storage.getTokenScoreHistory("1:0xfaba6f8e4a5e8ab82f62fe7c39859fa577269be3", 111);
    assert.equal(history?.smwIn, 1);
    assert.equal(history?.holdingsUsd, 160980.31);

    const [enrichmentToken] = await storage.getSnapshotTokensForEnrichment(snapshot, 111, 1);
    assert.equal(enrichmentToken?.smwIn, 1);
    assert.equal(enrichmentToken?.holdingsUsd, 160980.31);
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

test("replaceEntities updates an existing named entity when its Zapper bundle link changes", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dex-storage-test-"));
  const previousDatabaseUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;

  const storage = createStorage(cwd);
  try {
    await storage.replaceEntities([
      {
        entityName: "0xUnihaxor",
        fullZapperLink: "https://zapper.xyz/bundle/0xold?label=0xunihaxor",
        resolvedLabel: "0xunihaxor",
        linkType: "bundle",
        walletAddresses: ["0xold"],
      },
    ]);
    await storage.replaceEntities([
      {
        entityName: "0xUnihaxor",
        fullZapperLink: "https://zapper.xyz/bundle/0xnew,So11111111111111111111111111111111111111112?label=0xunihaxor",
        resolvedLabel: "0xunihaxor",
        linkType: "bundle",
        walletAddresses: ["0xnew", "So11111111111111111111111111111111111111112"],
      },
    ]);

    const entities = await storage.getEntities();
    const matches = entities.filter((entity) => entity.entityName === "0xUnihaxor");
    assert.equal(matches.length, 1);
    assert.equal(matches[0].fullZapperLink.includes("0xnew"), true);
    assert.deepEqual(
      matches[0].wallets.map((wallet) => wallet.walletAddress),
      ["0xnew", "So11111111111111111111111111111111111111112"],
    );
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

test("replaceEntities normalizes stale duplicate entity wallet lists", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dex-storage-test-"));
  const previousDatabaseUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;

  const currentWallets = [
    "0x1289894a932ae5b4679b236f96eae4236f4ee9c4",
    "0x8774e69e6fab8fae50cc27a82a224dd9d84a427c",
    "0xa71835dd5179cccb89167a9b1016b5c9043b8f94",
    "0x2fb8a5b21aaa9b77e462e72bbf4980a6ac7df6c5",
    "0x73c8e23e3f2feffcfa7ffa96e44660ed16c92061",
    "7nzGxho8yxAm9qV2rabcCZ8GppC93TZhGNZ69x6UxZiS",
    "AVHjrEs5my3mf6tersAAbYwLXUJqKybsjyzSkdBdqxq4",
    "2GHgLubjWvLtuw6Zxq6KqmaWvPduokpWeukdb9yGTNEi",
    "ACi7K9E5LZFNzW2w134tb1eRmBA7Rp6cwyZCPCyk761t",
    "H5fStxz4scwWuXN4n7wo3GgpYud3t1Mz1fKMkcwaH9XW",
    "FhsHDuhHbhw2HTkz7eWKJn33HSgq4E4MYNBocrk3ya1W",
    "GFiW4FE7QCjW2zgKUyHTZU8hikhGjXR7sgg4oSDo5mPc",
    "2hRepUfb8NNCX43n3ffDEHtMKGt95qBVsEj8AKuMGU6M",
    "oJEyy4MkksJzjNbVCXSctRKC7fq4SCYQ9PJDBM4BYzm",
    "6Y3UN9AnivpDUN5DREHuUSYHPiaXmmNSpCU8aXdXiNAL",
  ];

  let storage = createStorage(cwd);
  await storage.close();

  const Database = require("better-sqlite3") as typeof import("better-sqlite3");
  const db = new Database(resolveWorkspacePaths(cwd).dbFile);
  const now = new Date().toISOString();
  const insertEntity = db.prepare(`
    INSERT INTO entities (entity_name, full_zapper_link, resolved_label, link_type, created_at, updated_at)
    VALUES (?, ?, ?, 'bundle', ?, ?)
  `);
  const insertWallet = db.prepare(`
    INSERT INTO entity_wallets (entity_id, wallet_address, wallet_index, created_at)
    VALUES (?, ?, ?, ?)
  `);
  const staleId = Number(insertEntity.run("0xUnihaxor", "https://zapper.xyz/bundle/0xold?label=0xunihaxor", "0xunihaxor", now, now).lastInsertRowid);
  const oversizeId = Number(insertEntity.run("0xUnihaxor", "https://zapper.xyz/bundle/0xoversize?label=0xunihaxor", "0xunihaxor", now, now).lastInsertRowid);
  for (let index = 0; index < 22; index += 1) {
    insertWallet.run(oversizeId, `stale-wallet-${index}`, index, now);
  }
  insertWallet.run(staleId, "0xold", 0, now);
  db.close();

  storage = createStorage(cwd);
  try {
    await storage.replaceEntities([
      {
        entityName: "0xUnihaxor",
        fullZapperLink: `https://zapper.xyz/bundle/${currentWallets.join(",")}?label=0xunihaxor`,
        resolvedLabel: "0xunihaxor",
        linkType: "bundle",
        walletAddresses: currentWallets,
      },
    ]);
    const entities = await storage.getEntities();
    const active = entities.find((entity) => entity.entityName === "0xUnihaxor");
    assert.ok(active);
    assert.deepEqual(active.wallets.map((wallet) => wallet.walletAddress), currentWallets);
  } finally {
    await storage.close();
  }

  const verifyDb = new Database(resolveWorkspacePaths(cwd).dbFile);
  try {
    const duplicateWalletCounts = verifyDb
      .prepare(
        `SELECT e.id, COUNT(w.wallet_address) as walletCount
         FROM entities e
         LEFT JOIN entity_wallets w ON w.entity_id = e.id
         WHERE lower(e.entity_name) = lower('0xUnihaxor')
         GROUP BY e.id
         ORDER BY e.id`,
      )
      .all() as Array<{ id: number; walletCount: number }>;
    assert.ok(duplicateWalletCounts.length >= 2);
    assert.deepEqual(
      duplicateWalletCounts.map((row) => Number(row.walletCount)),
      duplicateWalletCounts.map(() => currentWallets.length),
    );
  } finally {
    verifyDb.close();
    if (previousDatabaseUrl == null) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

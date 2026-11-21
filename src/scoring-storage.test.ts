import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createStorage } from "./storage";
import { RawHoldingRecord } from "./types";
import { selectMarketCap } from "./market-cap";

test("storage matches successful cohorts and persists snapshot-specific valuation evidence", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dex-v4-storage-"));
  const previousUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  const storage = createStorage(cwd);
  try {
    await storage.replaceEntities(
      ["a", "b"].map((entityName, i) => ({
        entityName,
        sourceUrl: `https://app.cielo.finance/bundles/${i + 1}/portfolio`,
        linkType: "bundle" as const,
        resolvedLabel: null,
        walletAddresses: [],
      })),
    );
    const entities = await storage.getEntities();
    const a = entities.find((e) => e.entityName === "a")!,
      b = entities.find((e) => e.entityName === "b")!;
    const holding = (
      snapshotId: number,
      entityId: number,
      amount: number,
    ): RawHoldingRecord => ({
      snapshotId,
      entityId,
      tokenKey: "1:0xabc",
      tokenSymbol: "ABC",
      tokenName: "ABC",
      tokenAddress: "0xabc",
      networkName: "Ethereum",
      chainId: 1,
      balance: String(amount),
      balanceRaw: String(amount),
      balanceUsd: amount * 500,
      price: 500,
      marketCap: 5e6,
      liquidityUsd: 1e6,
      volume24h: 1e6,
      txns24h: 20,
      tokenAgeHours: 24,
      fetchedAt: "2026-11-20T00:00:00Z",
    });
    const ids: number[] = [];
    for (const [i, amounts] of [
      [100, 0],
      [80, 1000],
    ].entries()) {
      const id = await storage.createSnapshot(2, "test");
      ids.push(id);
      const at = `2026-11-${20 + i}T00:00:00Z`;
      for (const [j, amount] of amounts.entries()) {
        const e = [a, b][j];
        if (i === 0 && j === 1) continue; // b was not observed in the first snapshot.
        await storage.insertEntityFetchRun({
          snapshotId: id,
          entityId: e.id,
          status: "success",
          rowsFound: 1,
          totalBalanceUsd: amount * 500,
          errorMessage: null,
          startedAt: at,
          finishedAt: at,
        });
        await storage.insertRawHoldingsForEntity(id, e.id, [
          holding(id, e.id, amount),
        ]);
      }
      await storage.updateSnapshot({
        id,
        status: "success",
        entitiesCompleted: i + 1,
        entitiesFailed: 0,
        totalRows: i + 1,
        finishedAt: at,
      });
    }
    const row = (await storage.getOverview(ids[1], 111, 1, 0))[0];
    assert.equal(row.holdingDynamics?.cohortSize, 1);
    assert.ok(Math.abs(row.holdingDynamics!.amountChangePct! + 20) < 1e-8);
    assert.ok(row.momentumBoost! < 0);
    const history = await storage.getTokenScoreHistory(
      "1:0xabc",
      111,
      [],
      null,
      ids[1],
    );
    assert.equal(history.at(-1)?.score, row.score);
    assert.deepEqual(history.at(-1)?.holdingDynamics, row.holdingDynamics);
    const quote = selectMarketCap(5e6, 5.1e6, "2026-11-21T00:00:00Z");
    await storage.updateSnapshotTokenMarketData(ids[1], "1:0xabc", {
      ...quote,
      liquidityUsd: 1e6,
      volume24h: 1e6,
      txns24h: 20,
      tokenAgeHours: 24,
    });
    assert.equal(
      (await storage.getOverview(ids[1], 111, 1, 0))[0].marketCapEvidence
        ?.status,
      "cross-checked",
    );
    const conflict = selectMarketCap(1e6, 1e9, "2026-11-21T00:00:00Z");
    await storage.updateSnapshotTokenMarketData(ids[1], "1:0xabc", {
      ...conflict,
      liquidityUsd: 1e6,
      volume24h: 1e6,
      txns24h: 20,
      tokenAgeHours: 24,
    });
    const conflicted = (await storage.getOverview(ids[1], 111, 1, 0))[0];
    assert.equal(conflicted.marketCap, null);
    assert.equal(conflicted.marketCapEvidence?.status, "conflict");
    assert.equal(
      (await storage.getOverview(ids[0], 111, 1, 0))[0].marketCap,
      5e6,
    );
    assert.deepEqual(
      await storage.getTokenScoreHistory("missing-token", 111, []),
      [],
    );
  } finally {
    await storage.close();
    fs.rmSync(cwd, { recursive: true, force: true });
    if (previousUrl == null) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  }
});

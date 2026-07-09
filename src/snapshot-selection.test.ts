import test from "node:test";
import assert from "node:assert/strict";
import { getLatestUsableSnapshot } from "./snapshot-selection";
import { SnapshotRecord } from "./types";

function snapshot(input: Partial<SnapshotRecord> & Pick<SnapshotRecord, "id">): SnapshotRecord {
  return {
    id: input.id,
    status: input.status || "partial",
    zapperKeyLabel: null,
    totalEntities: 52,
    entitiesCompleted: 52,
    entitiesFailed: 0,
    totalRows: input.totalRows ?? 100,
    solanaRows: input.solanaRows,
    nonSolanaRows: input.nonSolanaRows,
    errorMessage: null,
    createdAt: `2026-07-09T00:00:0${input.id}.000Z`,
    finishedAt: `2026-07-09T00:01:0${input.id}.000Z`,
  };
}

test("getLatestUsableSnapshot skips Solana-only partial snapshots when EVM coverage exists", () => {
  const latest = getLatestUsableSnapshot([
    snapshot({ id: 52, status: "partial", totalRows: 194, solanaRows: 194, nonSolanaRows: 0 }),
    snapshot({ id: 51, status: "partial", totalRows: 194, solanaRows: 194, nonSolanaRows: 0 }),
    snapshot({ id: 50, status: "success", totalRows: 5401, solanaRows: 201, nonSolanaRows: 5200 }),
  ]);

  assert.equal(latest?.id, 50);
});

test("getLatestUsableSnapshot still returns a Solana-only snapshot when no EVM-covered snapshot exists", () => {
  const latest = getLatestUsableSnapshot([
    snapshot({ id: 2, status: "partial", totalRows: 194, solanaRows: 194, nonSolanaRows: 0 }),
    snapshot({ id: 1, status: "failed", totalRows: 0, solanaRows: 0, nonSolanaRows: 0 }),
  ]);

  assert.equal(latest?.id, 2);
});

import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SNAPSHOT_STALE_AFTER_MS, isRunningSnapshotStale } from "./snapshot-reconciliation";

test("a recent running snapshot remains visible while an external worker is active", () => {
  const now = Date.parse("2026-10-17T08:00:00.000Z");
  const snapshot = { status: "running" as const, createdAt: new Date(now - 5 * 60 * 1000).toISOString() };
  assert.equal(isRunningSnapshotStale(snapshot, now), false);
});

test("an old running snapshot can be reconciled after the stale threshold", () => {
  const now = Date.parse("2026-10-17T08:00:00.000Z");
  const snapshot = { status: "running" as const, createdAt: new Date(now - DEFAULT_SNAPSHOT_STALE_AFTER_MS - 1).toISOString() };
  assert.equal(isRunningSnapshotStale(snapshot, now), true);
});

test("completed snapshots are never considered stale running snapshots", () => {
  assert.equal(isRunningSnapshotStale({ status: "success", createdAt: "2020-01-01T00:00:00.000Z" }, Date.now()), false);
});

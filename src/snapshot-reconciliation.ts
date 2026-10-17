import { SnapshotRecord } from "./types";

export const DEFAULT_SNAPSHOT_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

function configuredStaleAfterMs(): number {
  const value = Number(process.env.SNAPSHOT_STALE_AFTER_MS || DEFAULT_SNAPSHOT_STALE_AFTER_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_SNAPSHOT_STALE_AFTER_MS;
}

export function isRunningSnapshotStale(
  snapshot: Pick<SnapshotRecord, "status" | "createdAt">,
  nowMs = Date.now(),
): boolean {
  if (snapshot.status !== "running") return false;
  const createdAtMs = Date.parse(snapshot.createdAt);
  if (!Number.isFinite(createdAtMs)) return false;
  return nowMs - createdAtMs >= configuredStaleAfterMs();
}

import { SnapshotRecord } from "./types";

export function isUsableSnapshot(snapshot: SnapshotRecord): boolean {
  return (snapshot.status === "success" || snapshot.status === "partial") && snapshot.totalRows > 0;
}

function hasNonSolanaCoverage(snapshot: SnapshotRecord): boolean {
  return Number(snapshot.nonSolanaRows || 0) > 0;
}

export function getLatestUsableSnapshot(snapshots: SnapshotRecord[]): SnapshotRecord | null {
  const usableSnapshots = snapshots.filter(isUsableSnapshot);
  return usableSnapshots.find(hasNonSolanaCoverage) || usableSnapshots[0] || snapshots[0] || null;
}

import type { ScoreContext, ScoreHistorySample } from "./scoring";

type Snapshot = { id: number; status: string; at: string };
type Position = {
  snapshotId: number;
  tokenKey: string;
  entityKey: string;
  tokenAmount: string | number;
  balanceUsd: number;
};
type Run = { snapshotId: number; entityKey: string; status: string };
export type ObservationIndex = Map<
  number,
  {
    snapshot: Snapshot;
    samples: Map<string, ScoreHistorySample>;
    successful: string[];
  }
>;

export function buildObservationIndex(
  snapshots: Snapshot[],
  positions: Position[],
  runs: Run[],
  favorites: string[],
): ObservationIndex {
  const index: ObservationIndex = new Map(
    snapshots.map((s) => [
      Number(s.id),
      { snapshot: s, samples: new Map(), successful: [] },
    ]),
  );
  const favoriteKeys = new Set(favorites.map((v) => v.toLowerCase()));
  const latestRun = new Set<string>();
  // Callers order fetch runs by descending id, so retries use the final outcome.
  for (const run of runs) {
    const key = `${run.snapshotId}:${run.entityKey}`;
    if (latestRun.has(key)) continue;
    latestRun.add(key);
    if (run.status === "success")
      index.get(Number(run.snapshotId))?.successful.push(run.entityKey);
  }
  const canonical = new Map<string, Position>();
  for (const p of positions) {
    const key = `${p.snapshotId}:${p.tokenKey}:${p.entityKey}`;
    const previous = canonical.get(key);
    if (!previous || Number(p.balanceUsd) > Number(previous.balanceUsd))
      canonical.set(key, p);
  }
  for (const p of canonical.values()) {
    const observation = index.get(Number(p.snapshotId));
    if (!observation) continue;
    let sample = observation.samples.get(p.tokenKey);
    if (!sample) {
      sample = {
        tokenAmount: 0,
        holdingsUsd: 0,
        smwIn: 0,
        favoriteEntityCount: 0,
        favoriteHoldingsUsd: 0,
        at: observation.snapshot.at,
        entityAmounts: {},
        invalidEntityKeys: [],
        observedEntityKeys: observation.successful,
        complete: observation.snapshot.status === "success",
      };
      observation.samples.set(p.tokenKey, sample);
    }
    const amount = Number(p.tokenAmount);
    if (
      !Number.isFinite(amount) ||
      amount < 0 ||
      (amount === 0 && Number(p.balanceUsd) > 0)
    )
      sample.invalidEntityKeys!.push(p.entityKey);
    else sample.entityAmounts![p.entityKey] = amount;
    sample.tokenAmount += Number.isFinite(amount) && amount > 0 ? amount : 0;
    sample.holdingsUsd += Number(p.balanceUsd) || 0;
    sample.smwIn += amount > 0 ? 1 : 0;
    if (favoriteKeys.has(p.entityKey) && amount > 0) {
      sample.favoriteEntityCount++;
      sample.favoriteHoldingsUsd += Number(p.balanceUsd) || 0;
    }
  }
  return index;
}

export function contextFromObservations(
  index: ObservationIndex,
  snapshotId: number,
  tokenKey: string,
  previousIds: number[],
  favorites: string[],
): ScoreContext {
  const get = (id: number | undefined): ScoreHistorySample | undefined => {
    const o = id == null ? undefined : index.get(id);
    if (!o) return undefined;
    return (
      o.samples.get(tokenKey) || {
        tokenAmount: 0,
        holdingsUsd: 0,
        smwIn: 0,
        favoriteEntityCount: 0,
        favoriteHoldingsUsd: 0,
        at: o.snapshot.at,
        entityAmounts: {},
        invalidEntityKeys: [],
        observedEntityKeys: o.successful,
        complete: o.snapshot.status === "success",
      }
    );
  };
  return {
    currentAt: index.get(snapshotId)?.snapshot.at,
    current: get(snapshotId),
    previous: get(previousIds[0]),
    previousPrevious: get(previousIds[1]),
    favoriteKeys: favorites,
  };
}

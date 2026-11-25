import type { MarketCapEvidence } from "./market-cap-types";
import { contextFromObservations, type ObservationIndex } from "./score-observations";
import { withOpportunityScore } from "./scoring";
import type { TokenOverviewRow, TokenScorePoint } from "./types";

export type ScoreReadState = {
  observations: ObservationIndex;
  evidence: Map<string, MarketCapEvidence>;
};

export function previousSuccessfulIds(successfulIds: number[], snapshotId: number): number[] {
  return successfulIds.filter((id) => id < snapshotId).slice(-2).reverse();
}

export function historyObservationIds(
  rows: Array<Pick<TokenScorePoint, "snapshotId">>,
  successfulIds: number[],
): number[] {
  return [...new Set(rows.flatMap((row) => [row.snapshotId, ...previousSuccessfulIds(successfulIds, row.snapshotId)]))];
}

export function scoreOverviewRows(
  rows: Array<Omit<TokenOverviewRow, "score">>,
  snapshotId: number,
  previousIds: number[],
  favoriteKeys: string[],
  state: ScoreReadState,
): TokenOverviewRow[] {
  return rows.map((row) => withOpportunityScore({
    ...row,
    marketCapEvidence: state.evidence.get(`${snapshotId}:${row.tokenKey}`),
  }, contextFromObservations(state.observations, snapshotId, row.tokenKey, previousIds, favoriteKeys)));
}

export function scoreHistoryRows(
  rows: Array<Omit<TokenScorePoint, "score">>,
  successfulIds: number[],
  favoriteKeys: string[],
  convictionBySnapshot: Map<number, number>,
  state: ScoreReadState,
): TokenScorePoint[] {
  return rows.map((row) => withOpportunityScore({
    ...row,
    favoriteEntityCount: Number(row.favoriteEntityCount || 0),
    favoriteHoldingsUsd: Number(row.favoriteHoldingsUsd || 0),
    favoriteEntityNames: row.favoriteEntityNames || [],
    liquidityUsd: row.liquidityUsd == null ? null : Number(row.liquidityUsd),
    entityConviction: convictionBySnapshot.get(row.snapshotId) || 1,
    marketCapEvidence: state.evidence.get(`${row.snapshotId}:${row.tokenKey}`),
  }, contextFromObservations(
    state.observations,
    row.snapshotId,
    row.tokenKey,
    previousSuccessfulIds(successfulIds, row.snapshotId),
    favoriteKeys,
  )));
}

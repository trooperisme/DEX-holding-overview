import { TokenOverviewRow } from "./types";

export const SCORE_VERSION = "v3";
export const SCORE_CAP = 10_000_000;
export const SINGLE_SMALL_HOLDER_SCORE_CAP = 75_000;

export type ScoreHistorySample = {
  tokenAmount: number;
  holdingsUsd: number;
  smwIn: number;
  favoriteEntityCount: number;
  favoriteHoldingsUsd: number;
  at: string;
};

export type ScoreContext = {
  currentAt?: string;
  previous?: ScoreHistorySample;
  previousPrevious?: ScoreHistorySample;
  entityConviction?: number;
};

type ScoreInput = Pick<TokenOverviewRow, "holdingsUsd" | "smwIn" | "marketCap" | "tokenAgeHours">
  & Partial<Pick<TokenOverviewRow, "volume24h" | "liquidityUsd" | "favoriteEntityCount" | "tokenAmount" | "favoriteHoldingsUsd">>;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function safeNumber(value: unknown, fallback = 0): number {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function capForHoldingEvidence(row: ScoreInput, score: number): number {
  // A single sub-$10k position cannot be promoted into the top attention lanes
  // by a favorable market quote or a short-lived momentum spike.
  const evidenceCap = safeNumber(row.smwIn, 0) <= 1 && safeNumber(row.holdingsUsd, 0) < 10_000
    ? SINGLE_SMALL_HOLDER_SCORE_CAP
    : SCORE_CAP;
  return Math.min(evidenceCap, Math.max(0, Math.round(score)));
}

function holdingAttentionFloor(holdingsUsdRaw: unknown, smwInRaw: unknown): number {
  // A single huge balance can be a passive position or bad source data. Keep
  // capital visible without allowing raw USD value to set the entire ranking.
  const holdingsUsd = Math.max(0, safeNumber(holdingsUsdRaw, 0));
  const breadthEvidence = Math.min(1, Math.max(0, safeNumber(smwInRaw, 0)) / 3);
  return Math.min(500_000, Math.round(Math.sqrt(holdingsUsd * 100_000) * breadthEvidence));
}

function marketCapUpsideMultiplier(marketCapRaw: unknown): number {
  const marketCap = safeNumber(marketCapRaw, 0);
  // Unknown cap is uncertainty, not proof of microcap upside. Tiny quoted caps
  // are also easy to manipulate, so they need more than a cheap quote to rank.
  if (marketCap <= 0) return 0.8;
  if (marketCap < 100_000) return 0.4;
  if (marketCap < 1_000_000) return 1.2;
  if (marketCap < 10_000_000) return 2;
  if (marketCap < 50_000_000) return 2.3;
  if (marketCap < 200_000_000) return 1.5;
  if (marketCap < 1_000_000_000) return 0.55;
  return 0.3;
}

function breadthMultiplier(smwInRaw: unknown): number {
  const smwIn = safeNumber(smwInRaw, 0);
  if (smwIn <= 1) return 0.55;
  if (smwIn === 2) return 0.9;
  if (smwIn === 3) return 1.3;
  if (smwIn <= 5) return 1.8;
  if (smwIn <= 10) return 2.2;
  return 2.5;
}

function favoriteConvergence(countRaw: unknown): number {
  const count = Math.max(0, Math.trunc(safeNumber(countRaw, 0)));
  if (count === 1) return 1.35;
  if (count === 2) return 1.8;
  if (count === 3) return 2.4;
  if (count >= 4) return 2.8;
  return 1;
}

function footprintMultiplier(holdingsUsdRaw: unknown, marketCapRaw: unknown): number {
  const holdingsUsd = safeNumber(holdingsUsdRaw, 0);
  const marketCap = safeNumber(marketCapRaw, 0);
  if (holdingsUsd <= 0 || marketCap <= 0) return 1;

  const pct = (holdingsUsd / marketCap) * 100;
  if (pct < 0.01) return 0.75;
  if (pct < 0.05) return 0.9;
  if (pct < 0.25) return 1;
  if (pct < 1) return 1.15;
  if (pct < 3) return 1.35;
  if (pct < 8) return 1.5;
  if (pct < 15) return 1.25;
  return 0.8;
}

function ageMultiplier(tokenAgeHoursRaw: unknown, marketCapRaw: unknown): number {
  const hours = safeNumber(tokenAgeHoursRaw, NaN);
  if (!Number.isFinite(hours)) return 1;
  const days = hours / 24;
  const established = safeNumber(marketCapRaw, 0) >= 200_000_000;
  if (established) {
    if (days < 1) return 0.7;
    if (days < 7) return 0.9;
    return 1;
  }
  if (days < 1) return 0.5;
  if (days < 7) return 0.9;
  if (days < 30) return 1.5;
  if (days < 180) return 1.2;
  return 1;
}

function liquidityMultiplier(valueRaw: unknown): number {
  const value = safeNumber(valueRaw, NaN);
  if (!Number.isFinite(value)) return 1;
  if (value < 25_000) return 0.8;
  if (value < 100_000) return 1;
  if (value < 500_000) return 1.1;
  if (value < 1_000_000) return 1.2;
  return 1.3;
}

function volumeMultiplier(valueRaw: unknown): number {
  const value = safeNumber(valueRaw, NaN);
  if (!Number.isFinite(value)) return 1;
  if (value < 10_000) return 0.85;
  if (value < 100_000) return 0.95;
  if (value < 1_000_000) return 1.05;
  if (value < 10_000_000) return 1.15;
  return 1.2;
}

function capitalEvidenceMultiplier(holdingsUsdRaw: unknown): number {
  const holdingsUsd = safeNumber(holdingsUsdRaw, 0);
  if (holdingsUsd < 250) return 0.015;
  if (holdingsUsd < 1_000) return 0.06;
  if (holdingsUsd < 2_500) return 0.12;
  if (holdingsUsd < 10_000) return 0.35;
  if (holdingsUsd < 25_000) return 0.6;
  if (holdingsUsd < 50_000) return 0.85;
  if (holdingsUsd < 100_000) return 1.1;
  if (holdingsUsd < 250_000) return 1.3;
  return 1.5;
}

function estimateMomentum(row: ScoreInput, context: ScoreContext): number {
  const previous = context.previous;
  if (!previous) return 0;

  const currentAmount = safeNumber(row.tokenAmount, 0);
  const previousAmount = safeNumber(previous.tokenAmount, 0);
  const currentHoldings = safeNumber(row.holdingsUsd, 0);
  const previousHoldings = safeNumber(previous.holdingsUsd, 0);
  const elapsedDays = Math.max(0.25, (Date.parse(context.currentAt || "") - Date.parse(previous.at)) / 86_400_000 || 1);
  const amountVelocity = currentAmount > 0 && previousAmount > 0 && currentAmount > previousAmount
    ? clamp(Math.log2(currentAmount / previousAmount) / elapsedDays, 0, 4)
    : 0;
  const amountComponent = Math.min(2.2, amountVelocity * 0.55);

  const breadthComponent = Math.min(0.5, Math.max(0, safeNumber(row.smwIn, 0) - safeNumber(previous.smwIn, 0)) * 0.1);
  const favoriteCountDelta = Math.max(0, safeNumber(row.favoriteEntityCount, 0) - safeNumber(previous.favoriteEntityCount, 0));
  const favoriteComponent = Math.min(0.6, favoriteCountDelta * 0.2);

  const favoriteHoldings = safeNumber(row.favoriteHoldingsUsd, 0);
  const previousFavoriteHoldings = safeNumber(previous.favoriteHoldingsUsd, 0);
  const favoriteAccumulation = favoriteHoldings > 0 && previousFavoriteHoldings > 0 && favoriteHoldings > previousFavoriteHoldings
    ? Math.min(0.45, Math.max(0, Math.log2(favoriteHoldings / previousFavoriteHoldings)) * 0.2)
    : 0;

  const persistence = context.previousPrevious
    && previousAmount > 0
    && currentAmount > previousAmount
    && previousAmount > safeNumber(context.previousPrevious.tokenAmount, 0)
    ? 0.15
    : 0;

  // Holdings USD can rise because price rose. It is only a small confirmation
  // after token amount growth, so price-only pumps do not dominate ranking.
  const valueVelocity = currentHoldings > 0 && previousHoldings > 0 && currentHoldings > previousHoldings
    ? clamp(Math.log2(currentHoldings / previousHoldings) / elapsedDays, 0, 4)
    : 0;
  const priceOnlyComponent = Math.min(0.25, Math.max(0, valueVelocity - amountVelocity) * 0.1);

  const rawBonus = amountComponent + breadthComponent + favoriteComponent + favoriteAccumulation + persistence + priceOnlyComponent;
  const bluechip = safeNumber(row.marketCap, 0) >= 200_000_000;
  return clamp(rawBonus, 0, bluechip ? 0.5 : 3);
}

export function computeStructuralScore(
  row: ScoreInput & { entityConviction?: number },
): number {
  const conviction = clamp(safeNumber(row.entityConviction, 1), 0.7, 2);
  const structural = 160_000
    * conviction
    * capitalEvidenceMultiplier(row.holdingsUsd)
    * favoriteConvergence(row.favoriteEntityCount)
    * breadthMultiplier(row.smwIn)
    * marketCapUpsideMultiplier(row.marketCap)
    * ageMultiplier(row.tokenAgeHours, row.marketCap)
    * footprintMultiplier(row.holdingsUsd, row.marketCap)
    * liquidityMultiplier(row.liquidityUsd)
    * volumeMultiplier(row.volume24h);

  return capForHoldingEvidence(row, Math.max(holdingAttentionFloor(row.holdingsUsd, row.smwIn), structural));
}

export function computeOpportunityScore(
  row: ScoreInput & { entityConviction?: number },
  context: ScoreContext = {},
): number {
  const structural = computeStructuralScore(row);
  return capForHoldingEvidence(row, structural * (1 + estimateMomentum(row, context)));
}

export function favoriteScoreMultiplier(countRaw: unknown): number {
  return favoriteConvergence(countRaw);
}

export function withOpportunityScore<T extends Omit<TokenOverviewRow, "score">>(row: T, context: ScoreContext = {}): T & {
  score: number;
  baseScore: number;
  structuralScore: number;
  momentumBoost: number;
  momentumPct: number;
  scoreVersion: string;
  favoriteEntityCount: number;
  favoriteEntityNames: string[];
  favoriteHoldingsUsd: number;
  favoriteScoreMultiplier: number;
} {
  const favoriteEntityCount = Math.max(0, Math.trunc(safeNumber(row.favoriteEntityCount, 0)));
  const structuralScore = computeStructuralScore({ ...row, favoriteEntityCount });
  const momentumBoost = estimateMomentum({ ...row, favoriteEntityCount }, context);
  return {
    ...row,
    favoriteEntityCount,
    favoriteEntityNames: row.favoriteEntityNames || [],
    favoriteHoldingsUsd: row.favoriteHoldingsUsd || 0,
    baseScore: structuralScore,
    structuralScore,
    momentumBoost,
    momentumPct: Math.round(momentumBoost * 1000) / 10,
    scoreVersion: SCORE_VERSION,
    favoriteScoreMultiplier: favoriteScoreMultiplier(favoriteEntityCount),
    score: capForHoldingEvidence(row, structuralScore * (1 + momentumBoost)),
  };
}

import { TokenOverviewRow } from "./types";

export const SCORE_VERSION = "v2";
export const SCORE_CAP = 10_000_000;

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

function holdingAttentionFloor(holdingsUsdRaw: unknown): number {
  // Tracked capital is a first-order attention signal. Missing market data
  // must not make a token with a large verified position disappear from the
  // attention lanes; cap it at the global score ceiling so the score remains
  // bounded and comparable with the other structural signals.
  return Math.min(SCORE_CAP, Math.round(Math.max(0, safeNumber(holdingsUsdRaw, 0))));
}

function regimeAnchor(marketCapRaw: unknown): number {
  const marketCap = safeNumber(marketCapRaw, 0);
  if (marketCap <= 0) return 20_000;
  if (marketCap < 100_000) return 15_000;
  if (marketCap < 1_000_000) return 30_000;
  if (marketCap < 10_000_000) return 50_000;
  if (marketCap < 50_000_000) return 70_000;
  if (marketCap < 200_000_000) return 200_000;
  if (marketCap < 1_000_000_000) return 1_000_000;
  return 2_000_000;
}

function breadthMultiplier(smwInRaw: unknown): number {
  const smwIn = safeNumber(smwInRaw, 0);
  if (smwIn <= 1) return 0.8;
  if (smwIn === 2) return 1;
  if (smwIn === 3) return 1.2;
  if (smwIn <= 5) return 1.35;
  if (smwIn <= 10) return 1.5;
  return 1.7;
}

function favoriteConvergence(countRaw: unknown): number {
  const count = Math.max(0, Math.trunc(safeNumber(countRaw, 0)));
  if (count === 1) return 1.5;
  if (count === 2) return 2.5;
  if (count === 3) return 4;
  if (count >= 4) return 5;
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
  if (!Number.isFinite(hours)) return 0.95;
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
  if (!Number.isFinite(value)) return 0.85;
  if (value < 25_000) return 0.8;
  if (value < 100_000) return 1;
  if (value < 500_000) return 1.1;
  if (value < 1_000_000) return 1.2;
  return 1.3;
}

function volumeMultiplier(valueRaw: unknown): number {
  const value = safeNumber(valueRaw, NaN);
  if (!Number.isFinite(value)) return 0.9;
  if (value < 10_000) return 0.85;
  if (value < 100_000) return 0.95;
  if (value < 1_000_000) return 1.05;
  if (value < 10_000_000) return 1.15;
  return 1.2;
}

function evidenceMultiplier(holdingsUsdRaw: unknown, favoriteCountRaw: unknown, marketCapRaw: unknown): number {
  const holdingsUsd = safeNumber(holdingsUsdRaw, 0);
  let multiplier = holdingsUsd < 250 ? 0.02
    : holdingsUsd < 1_000 ? 0.05
      : holdingsUsd < 2_500 ? 0.1
        : holdingsUsd < 10_000 ? 0.2
          : holdingsUsd < 50_000 ? 0.4
            : holdingsUsd < 250_000 ? 0.65
              : holdingsUsd < 1_000_000 ? 0.85
                : 1;

  const favoriteCount = Math.max(0, Math.trunc(safeNumber(favoriteCountRaw, 0)));
  if (favoriteCount === 1) multiplier = Math.max(multiplier, 0.15);
  if (favoriteCount === 2) multiplier = Math.max(multiplier, 0.35);
  if (favoriteCount === 3) multiplier = Math.max(multiplier, 0.6);
  if (favoriteCount >= 4) multiplier = Math.max(multiplier, 0.75);

  // A bluechip's structural lane is about capacity, not whether its current
  // snapshot happens to have a small tracked-wallet position.
  if (safeNumber(marketCapRaw, 0) >= 200_000_000) multiplier = Math.max(multiplier, 0.75);
  return multiplier;
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
  const structural = regimeAnchor(row.marketCap)
    * conviction
    * favoriteConvergence(row.favoriteEntityCount)
    * breadthMultiplier(row.smwIn)
    * ageMultiplier(row.tokenAgeHours, row.marketCap)
    * footprintMultiplier(row.holdingsUsd, row.marketCap)
    * liquidityMultiplier(row.liquidityUsd)
    * volumeMultiplier(row.volume24h)
    * evidenceMultiplier(row.holdingsUsd, row.favoriteEntityCount, row.marketCap);

  const protectedBluechipFloor = safeNumber(row.marketCap, 0) >= 200_000_000 ? 1_000_000 : 0;
  return Math.min(
    SCORE_CAP,
    Math.round(Math.max(protectedBluechipFloor, holdingAttentionFloor(row.holdingsUsd), structural)),
  );
}

export function computeOpportunityScore(
  row: ScoreInput & { entityConviction?: number },
  context: ScoreContext = {},
): number {
  const structural = computeStructuralScore(row);
  return Math.min(SCORE_CAP, Math.round(structural * (1 + estimateMomentum(row, context))));
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
    score: Math.min(SCORE_CAP, Math.round(structuralScore * (1 + momentumBoost))),
  };
}

import { TokenOverviewRow } from "./types";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function safeNumber(value: unknown, fallback = 0): number {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function smwBreadthMultiplier(smwInRaw: unknown): number {
  const smwIn = safeNumber(smwInRaw, 0);

  if (smwIn <= 0) return 0.75;
  if (smwIn === 1) return 0.9;
  if (smwIn === 2) return 1.15;
  if (smwIn === 3) return 1.35;
  if (smwIn <= 5) return 1.55;
  if (smwIn <= 10) return 1.8;
  if (smwIn <= 20) return 2.05;
  return 2.3;
}

function moniSocialMultiplier(row: Pick<TokenOverviewRow, "moniLevel" | "moniMomentumScorePct" | "moniMomentumRank">): number {
  const level = safeNumber(row.moniLevel, NaN);
  const momentumPct = safeNumber(row.moniMomentumScorePct, NaN);
  const momentumRank = safeNumber(row.moniMomentumRank, NaN);

  if (!Number.isFinite(level) && !Number.isFinite(momentumPct)) {
    return 1.0;
  }

  let quality = 1.0;
  if (Number.isFinite(level)) {
    if (level <= 1) quality = 0.85;
    else if (level === 2) quality = 0.95;
    else if (level === 3) quality = 1.05;
    else if (level === 4) quality = 1.15;
    else if (level === 5) quality = 1.25;
    else if (level === 6) quality = 1.4;
    else if (level >= 7) quality = 1.55;
  }

  let momentum = 1.0;
  if (Number.isFinite(momentumPct)) {
    if (momentumPct <= 0) momentum = 1.0;
    else if (momentumPct < 100) momentum = 1.1;
    else if (momentumPct < 300) momentum = 1.25;
    else if (momentumPct < 700) momentum = 1.4;
    else momentum = 1.6;
  }

  if (Number.isFinite(momentumRank) && momentumRank > 0) {
    if (momentumRank <= 100) momentum += 0.2;
    else if (momentumRank <= 500) momentum += 0.15;
    else if (momentumRank <= 1000) momentum += 0.1;
    else if (momentumRank <= 5000) momentum += 0.05;
  }

  return clamp(quality * momentum, 0.75, 2.2);
}

function holdingsToMarketCapFootprintMultiplier(holdingsUsdRaw: unknown, marketCapRaw: unknown): number {
  const holdingsUsd = safeNumber(holdingsUsdRaw, 0);
  const marketCap = safeNumber(marketCapRaw, 0);

  if (holdingsUsd <= 0 || marketCap <= 0) return 1.0;

  const pct = (holdingsUsd / marketCap) * 100;

  if (pct < 0.01) return 0.8;
  if (pct < 0.05) return 0.9;
  if (pct < 0.25) return 1.0;
  if (pct < 1.0) return 1.15;
  if (pct < 3.0) return 1.35;
  if (pct < 8.0) return 1.5;
  if (pct < 15.0) return 1.25;
  return 0.9;
}

function marketCapAsymmetryMultiplier(marketCapRaw: unknown): number {
  const marketCap = safeNumber(marketCapRaw, 0);

  if (marketCap <= 0) return 0.85;
  if (marketCap < 100_000) return 0.7;
  if (marketCap < 1_000_000) return 1.05;
  if (marketCap < 10_000_000) return 1.35;
  if (marketCap < 50_000_000) return 1.25;
  if (marketCap < 200_000_000) return 1.05;
  if (marketCap < 1_000_000_000) return 0.75;
  return 0.45;
}

function tokenAgeMultiplier(tokenAgeHoursRaw: unknown): number {
  const hours = safeNumber(tokenAgeHoursRaw, NaN);

  if (!Number.isFinite(hours)) return 0.95;

  const days = hours / 24;

  if (days < 1) return 0.7;
  if (days < 7) return 0.85;
  if (days < 30) return 1.0;
  if (days < 180) return 1.1;
  if (days < 730) return 1.0;
  return 0.85;
}

export function computeOpportunityScore(
  row: Pick<
    TokenOverviewRow,
    | "holdingsUsd"
    | "smwIn"
    | "marketCap"
    | "tokenAgeHours"
    | "moniLevel"
    | "moniMomentumScorePct"
    | "moniMomentumRank"
  >,
): number {
  const holdingsUsd = safeNumber(row.holdingsUsd, 0);

  const baseSignal =
    holdingsUsd *
    smwBreadthMultiplier(row.smwIn) *
    moniSocialMultiplier(row) *
    holdingsToMarketCapFootprintMultiplier(row.holdingsUsd, row.marketCap);

  const score = baseSignal * marketCapAsymmetryMultiplier(row.marketCap) * tokenAgeMultiplier(row.tokenAgeHours);

  return Math.round(score);
}

export function withOpportunityScore<T extends Omit<TokenOverviewRow, "score">>(row: T): T & { score: number } {
  return { ...row, score: computeOpportunityScore(row) };
}

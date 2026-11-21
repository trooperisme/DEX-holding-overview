import { TokenOverviewRow } from "./types";
import { legacyMarketCapEvidence, MarketCapEvidence } from "./market-cap-types";

export const SCORE_VERSION = "v4";
export const SCORE_CAP = 10_000_000;
export const SINGLE_SMALL_HOLDER_SCORE_CAP = 75_000;
export type ScoreHistorySample = {
  tokenAmount: number;
  holdingsUsd: number;
  smwIn: number;
  favoriteEntityCount: number;
  favoriteHoldingsUsd: number;
  at: string;
  entityAmounts?: Record<string, number>;
  observedEntityKeys?: string[];
  invalidEntityKeys?: string[];
  complete?: boolean;
};
export type ScoreContext = {
  currentAt?: string;
  current?: ScoreHistorySample;
  previous?: ScoreHistorySample;
  previousPrevious?: ScoreHistorySample;
  entityConviction?: number;
  favoriteKeys?: string[];
};
export type HoldingDynamics = {
  status: "comparable" | "insufficient";
  cohortSize: number;
  coverageChanged: boolean;
  amountChangePct: number | null;
  amountRatePerDay: number | null;
  breadthChange: number;
  favoriteChange: number;
  increasedEntities: string[];
  reducedEntities: string[];
  note: string;
};
export type ScoreComponents = Record<string, number>;
type ScoreInput = Pick<
  TokenOverviewRow,
  "holdingsUsd" | "smwIn" | "marketCap" | "tokenAgeHours"
> &
  Partial<
    Pick<
      TokenOverviewRow,
      | "volume24h"
      | "liquidityUsd"
      | "favoriteEntityCount"
      | "tokenAmount"
      | "favoriteHoldingsUsd"
      | "marketCapEvidence"
      | "entityConviction"
    >
  >;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
function num(value: unknown, fallback = 0): number {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// Interpolate on a log axis: valuation/size/age thresholds do not create cliffs.
export function logInterpolate(
  value: number,
  anchors: Array<[number, number]>,
): number {
  if (value <= anchors[0][0]) return anchors[0][1];
  for (let i = 1; i < anchors.length; i++) {
    const [x, y] = anchors[i],
      [px, py] = anchors[i - 1];
    if (value <= x)
      return py + ((y - py) * Math.log(value / px)) / Math.log(x / px);
  }
  return anchors.at(-1)![1];
}
export function marketCapConfidence(evidence: MarketCapEvidence): number {
  const sourceBudget =
    evidence.status === "cross-checked"
      ? 1
      : evidence.status === "single-source"
        ? 0.75
        : 0;
  return (
    sourceBudget * (evidence.identityMatch === "unique-contract" ? 0.5 : 1)
  );
}
export function favoriteScoreMultiplier(value: unknown): number {
  const n = Math.max(0, Math.trunc(num(value)));
  return [1, 1.35, 1.8, 2.4, 2.8][Math.min(n, 4)];
}
function structuralComponents(row: ScoreInput): ScoreComponents {
  const holdings = Math.max(0, num(row.holdingsUsd));
  const breadth = Math.max(0, num(row.smwIn));
  const cap = num(row.marketCap);
  const confidence = marketCapConfidence(
    row.marketCapEvidence || legacyMarketCapEvidence(cap > 0 ? cap : null),
  );
  const capital =
    holdings < 250
      ? (0.015 * holdings) / 250
      : logInterpolate(holdings, [
          [250, 0.015],
          [1000, 0.06],
          [2500, 0.12],
          [10000, 0.35],
          [25000, 0.6],
          [50000, 0.85],
          [100000, 1.1],
          [250000, 1.3],
          [1000000, 1.5],
        ]);
  const capMultiplier =
    cap > 0
      ? logInterpolate(cap, [
          [10000, 0.4],
          [100000, 0.6],
          [1000000, 1.6],
          [10000000, 2.3],
          [50000000, 2.3],
          [200000000, 1.5],
          [1000000000, 0.55],
          [10000000000, 0.3],
        ])
      : 0.8;
  const footprint =
    cap > 0 && holdings > 0
      ? logInterpolate((holdings / cap) * 100, [
          [0.001, 0.75],
          [0.05, 0.9],
          [0.25, 1],
          [1, 1.15],
          [3, 1.35],
          [8, 1.5],
          [15, 1.25],
          [30, 0.8],
        ])
      : 1;
  const evidenceStrength =
    Math.min(1, holdings / 25000) * Math.min(1, breadth / 3);
  const days =
    row.tokenAgeHours == null ? null : Math.max(0, num(row.tokenAgeHours) / 24);
  // Youth is an interaction with holding evidence, not a free new-launch bonus.
  // Longevity alone adds no assumed product-quality premium.
  const age =
    days == null
      ? 1
      : 1 +
        (0.65 * evidenceStrength - 0.3 * (1 - evidenceStrength)) *
          Math.exp(-days / 14);
  return {
    capital,
    breadth:
      breadth <= 0
        ? 0
        : logInterpolate(breadth, [
            [1, 0.55],
            [2, 0.9],
            [3, 1.3],
            [5, 1.8],
            [10, 2.2],
            [15, 2.5],
          ]),
    favorites: favoriteScoreMultiplier(row.favoriteEntityCount),
    conviction: clamp(num(row.entityConviction, 1), 0.7, 2),
    marketCap: 0.8 + confidence * (capMultiplier - 0.8),
    footprint: 1 + confidence * (footprint - 1),
    age,
    liquidity:
      row.liquidityUsd == null
        ? 0.85
        : logInterpolate(Math.max(1, num(row.liquidityUsd)), [
            [1000, 0.8],
            [25000, 0.9],
            [100000, 1],
            [500000, 1.1],
            [1000000, 1.2],
            [5000000, 1.3],
          ]),
    volume:
      row.volume24h == null
        ? 0.9
        : logInterpolate(Math.max(1, num(row.volume24h)), [
            [1000, 0.85],
            [10000, 0.9],
            [100000, 0.95],
            [1000000, 1.05],
            [10000000, 1.15],
            [100000000, 1.2],
          ]),
    attentionFloor:
      Math.min(500000, Math.sqrt(holdings * 100000)) * Math.min(1, breadth / 3),
    evidenceCap:
      breadth <= 1 && holdings < 10000
        ? SINGLE_SMALL_HOLDER_SCORE_CAP
        : SCORE_CAP,
    momentumMultiplier: 1,
  };
}
export function scoreFromComponents(c: ScoreComponents): number {
  const product = [
    "capital",
    "breadth",
    "favorites",
    "conviction",
    "marketCap",
    "footprint",
    "age",
    "liquidity",
    "volume",
  ].reduce((n, key) => n * c[key], 160000);
  const base = Math.min(c.evidenceCap, Math.max(c.attentionFloor, product));
  return Math.round(clamp(base * c.momentumMultiplier, 0, c.evidenceCap));
}
export function measureHoldingDynamics(context: ScoreContext): HoldingDynamics {
  const empty: HoldingDynamics = {
    status: "insufficient",
    cohortSize: 0,
    coverageChanged: false,
    amountChangePct: null,
    amountRatePerDay: null,
    breadthChange: 0,
    favoriteChange: 0,
    increasedEntities: [],
    reducedEntities: [],
    note: "Comparable successful entity observations are required; balances do not prove buys or sales.",
  };
  const a = context.previous,
    b = context.current;
  if (
    !a?.complete ||
    !b?.complete ||
    !a.entityAmounts ||
    !b.entityAmounts ||
    !a.observedEntityKeys?.length ||
    !b.observedEntityKeys?.length
  )
    return empty;
  const days = (Date.parse(b.at) - Date.parse(a.at)) / 86400000;
  if (!(days > 0)) return empty;
  const beforeKeys = new Set(a.observedEntityKeys),
    afterKeys = new Set(b.observedEntityKeys);
  const invalid = new Set([
    ...(a.invalidEntityKeys || []),
    ...(b.invalidEntityKeys || []),
  ]);
  const cohort = [...beforeKeys].filter(
    (k) => afterKeys.has(k) && !invalid.has(k),
  );
  if (!cohort.length) return empty;
  const favorites = new Set(
    (context.favoriteKeys || []).map((v) => v.toLowerCase()),
  );
  let before = 0,
    after = 0,
    breadthChange = 0,
    favoriteChange = 0;
  const increasedEntities: string[] = [],
    reducedEntities: string[] = [];
  for (const k of cohort) {
    const x = Math.max(0, num(a.entityAmounts[k])),
      y = Math.max(0, num(b.entityAmounts[k]));
    before += x;
    after += y;
    const change = Number(y > 0) - Number(x > 0);
    breadthChange += change;
    if (favorites.has(k)) favoriteChange += change;
    if (y > x) increasedEntities.push(k);
    if (y < x) reducedEntities.push(k);
  }
  const coverageChanged =
    beforeKeys.size !== afterKeys.size ||
    [...beforeKeys].some((k) => !afterKeys.has(k)) ||
    invalid.size > 0;
  // A first observed position has no finite percentage growth. Breadth still records its entry.
  const rate =
    before > 0
      ? after > 0
        ? Math.log2(after / before) / days
        : -4 / days
      : null;
  return {
    status: "comparable",
    cohortSize: cohort.length,
    coverageChanged,
    amountChangePct: before > 0 ? (after / before - 1) * 100 : null,
    amountRatePerDay: rate,
    breadthChange,
    favoriteChange,
    increasedEntities: increasedEntities.slice(0, 5),
    reducedEntities: reducedEntities.slice(0, 5),
    note: coverageChanged
      ? "Matched successful entities only; observation coverage changed. Reduced balances are not confirmed sales."
      : "Matched successful entities; changes describe observed holdings, not confirmed buys or sales.",
  };
}
function momentum(context: ScoreContext): {
  boost: number;
  dynamics: HoldingDynamics;
} {
  const dynamics = measureHoldingDynamics(context);
  if (dynamics.status !== "comparable") return { boost: 0, dynamics };
  const days =
    (Date.parse(context.current!.at) - Date.parse(context.previous!.at)) /
    86400000;
  const amount = clamp(dynamics.amountRatePerDay || 0, -4, 4) * 0.55;
  const breadth = clamp((dynamics.breadthChange / days) * 0.1, -0.5, 0.5);
  const favorite = clamp((dynamics.favoriteChange / days) * 0.15, -0.6, 0.6);
  return { boost: clamp(amount + breadth + favorite, -0.75, 2), dynamics };
}
export function computeStructuralScore(row: ScoreInput): number {
  return scoreFromComponents(structuralComponents(row));
}
export function computeOpportunityScore(
  row: ScoreInput,
  context: ScoreContext = {},
): number {
  return withOpportunityScore(row as TokenOverviewRow, context).score;
}
type ScoredFields = {
  favoriteEntityCount: number;
  favoriteEntityNames: string[];
  favoriteHoldingsUsd: number;
  marketCapEvidence: MarketCapEvidence;
  baseScore: number;
  structuralScore: number;
  momentumBoost: number;
  momentumPct: number;
  scoreVersion: string;
  favoriteScoreMultiplier: number;
  scoreComponents: ScoreComponents;
  holdingDynamics: HoldingDynamics;
  score: number;
};
export function withOpportunityScore<T extends Omit<TokenOverviewRow, "score">>(
  row: T,
  context: ScoreContext = {},
): Omit<T, keyof ScoredFields> & ScoredFields {
  const marketCapEvidence =
    row.marketCapEvidence || legacyMarketCapEvidence(row.marketCap);
  const components = structuralComponents({ ...row, marketCapEvidence });
  const structuralScore = scoreFromComponents(components);
  const { boost, dynamics } = momentum(context);
  components.momentumMultiplier = 1 + boost;
  return {
    ...row,
    favoriteEntityCount: Math.max(0, Math.trunc(num(row.favoriteEntityCount))),
    favoriteEntityNames: row.favoriteEntityNames || [],
    favoriteHoldingsUsd: row.favoriteHoldingsUsd || 0,
    marketCapEvidence,
    baseScore: structuralScore,
    structuralScore,
    momentumBoost: boost,
    momentumPct: Math.round(boost * 1000) / 10,
    scoreVersion: SCORE_VERSION,
    favoriteScoreMultiplier: favoriteScoreMultiplier(row.favoriteEntityCount),
    scoreComponents: components,
    holdingDynamics: dynamics,
    score: scoreFromComponents(components),
  };
}

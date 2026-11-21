# DEX score v4: holding evidence, valuation and trajectory

This is an attention-ranking heuristic, not calibrated expected return. Values
and curves are design choices awaiting forward evaluation, not fitted alpha.
The implementation uses **market cap only**. FDV is neither queried as a
fallback nor stored, displayed or used by scoring.

## Acceptance criteria

- Qualified young holdings can outrank otherwise identical older holdings;
  youth alone cannot promote dust. Long life alone implies no product-quality
  premium. Age is explicitly a pool-age proxy, not guaranteed first trading time.
- Unknown/conflicting MCAP receives no low-cap upside or implicit small-cap age
  or momentum classification. Strong holding evidence remains visible.
- Reduced token quantities in a matched successful observation cohort can lower
  score even while USD holdings rise. Transfers/coverage changes are not sales.
- Direction, points/day and points/day² use actual elapsed time. Partial,
  invalid-time and incompatible-version points cannot establish a trajectory.
- Source/coverage changes are visible. Live checks never rewrite past snapshots.
- SQLite and PostgreSQL return the same scoring and provenance semantics;
  overview and selected-snapshot history agree.
- Existing registry, snapshots and unrelated checkout changes are preserved.

## Structural score

160,000 times capital evidence, entity convergence, favorite convergence,
relative conviction, market-cap opportunity, holdings/market-cap footprint,
pool-age evidence interaction, liquidity and volume. Apply the breadth-scaled
holding floor and evidence cap, then multiply by signed holder momentum.

Capital, breadth, market cap, footprint, liquidity and volume interpolate on
log axes between explicit anchors in `src/scoring.ts`. They no longer jump at
market-cap bands or day 7. Favorites represent discrete entity-count events;
conviction bands and explicit safety caps remain deliberate discontinuities.

MCAP curve anchors: $10k=0.4, $100k=0.6, $1M=1.6, $10M–50M=2.3,
$200M=1.5, $1B=0.55, >=$10B=0.3. Missing/conflicting=0.8.
Use 100% of deviation from 0.8 for cross-checked quotes, 75% for single-source,
0% for legacy unprovenanced values (historical pipelines may have substituted FDV). These are influence budgets,
not estimated correctness probabilities. Footprint deviations from 1 receive
the same confidence adjustment. MCAP has no additional hidden age/momentum
regime switch.

Age = 1 + [0.65E - 0.3(1-E)] _ exp(-days/14),
E = min(1, holdingsUSD/25,000) _ min(1, entityCount/3).
Unknown age=1. Older tokens converge to neutral age. This implements the new
launch evidence interaction; it does not pretend to measure narrative quality,
product usage, revenues, or proven established-project economics.

Holding floor = min(500,000, sqrt(holdingsUSD _ 100,000)) _ min(1, holders/3).
Single holders below $10k remain capped at 75k. Global cap remains 10M. The
floor cannot exempt a lone gigantic balance from the breadth requirement.

## Signed holder dynamics

Use quantities from all raw positions, not the dashboard USD threshold. Compare
only entities with successful fetches in both successful snapshots. Exclude
positions with unparseable/nonpositive quantities despite positive USD value.
Newly tracked entities cannot produce matched-cohort momentum. Missing token
rows in successfully observed portfolios are treated as no observed position,
not verified on-chain exits. Registry/coverage differences are flagged.

Bonus = clamp(0.55 \* clipped log2(quantity ratio)/day

- clipped 0.1 \* holder-count change/day
- clipped 0.15 \* favorite-holder change/day, -0.75, 2).
  Percentage growth from a zero base is undefined, so first entries contribute
  through observed breadth rather than invented infinite growth. Missing coverage
  or invalid elapsed time yields neutral momentum. No price-only or favorite-USD
  bonus. No hard $200M momentum discontinuity. No derivative feedback into score.

## Valuation sources and persistence

CoinGecko coin identity resolves by platform+contract; CMC resolves by contract
plus chain metadata (including alternative-chain contract arrays), then numeric
CMC ID. EVM addresses are case-insensitive; Solana addresses retain case.
Accept only positive market-cap fields with source timestamps no older than six
hours. If CG/CMC differ by >25% of the larger value, mark conflict and infer no
valuation upside; do not average away the discrepancy. Agreement is not proof
that either provider's supply methodology is perfect.

Future refreshes use bulk CG identity/CMC top-5000 indexes and batched quotes;
other-chain CMC metadata is batch validated. Long-tail/uncovered tokens may use
GeckoTerminal's actual `market_cap_usd` as explicitly single-source evidence;
FDV is never substituted. Provider failure degrades to explicit missing or
single-source evidence instead of fabricating values. This is bounded coverage,
not a claim that every new launch has verified circulating supply.

Provenance is additive in `snapshot_market_cap_evidence`, keyed by snapshot and
token. Update quote and provenance in one transaction. Null from an unavailable
source preserves a preexisting value within the same snapshot for compatibility;
an explicit conflict clears it. Unprovenanced old snapshots remain `legacy`: displayed for inspection, excluded from valuation and footprint bonuses. No source is retroactively assumed.

`GET /api/market-cap` is authenticated, validates chain/contract and returns live
CG/CMC checks with `affectsSnapshotScore:false`; cache ten minutes and throttle
uncached checks. Old history is never enriched using current market quotes.
API credentials are backend environment variables; scheduled refreshes receive
GitHub repository secrets. API responses/logs do not expose credentials.

## Trajectory and explanation

Existing history recalculates all points with v4 and current favorite/filter
settings. It is a retrospective reconstruction, not the original score seen by
a trader. Chart x-coordinates use actual timestamps. Rate=(S2-S1)/elapsedDays;
acceleration is the difference of adjacent interval rates divided by the
average interval length. Three valid points are needed for acceleration.

Exact point contributions replace groups in fixed documented order: capital+
floor, entity breadth+cap, favorites, conviction, MCAP, holdings/MCAP footprint, age, liquidity,
volume, momentum. Contributions sum to the score difference; allocation is
order-dependent, not causal or independent evidence. Coverage/source status
changes are highlighted separately. Display observed reduced/increased holders
without asserting sales or buys. No new overview columns are required.

## Verification and release

Build, regression tests, API/storage tests, mocked provider cases, live small
provider probes and browser checks. Compare available historical snapshots with
the previous method for sensitivity, not claims of predictive profitability.
Forward validation should compare holdings-only, structural-score-only,
input-level and slope/acceleration baselines per lifecycle and horizon, using
information available at the time and including failures, costs and drawdowns.
No new holdings refresh, historical backfill or registry import is part of this
release. Durable proof: commit/PR, production deployment, API scoreVersion=v4,
provider access, unchanged snapshot IDs and a working user-visible trajectory.

import assert from "node:assert/strict";
import test from "node:test";
import {
  computeStructuralScore,
  marketCapConfidence,
  measureHoldingDynamics,
  withOpportunityScore,
  ScoreHistorySample,
} from "./scoring";
import { selectMarketCap } from "./market-cap";
const evidence = selectMarketCap(
  5000000,
  5000000,
  "2026-11-21T00:00:00Z",
).marketCapEvidence;
const row = {
  tokenKey: "1:0xabc",
  tokenSymbol: "ABC",
  tokenName: "ABC",
  tokenAddress: "0xabc",
  chainId: 1,
  networkName: "Ethereum",
  holdingsUsd: 50000,
  smwIn: 3,
  favoriteEntityCount: 1,
  marketCap: 5000000,
  marketCapEvidence: evidence,
  tokenAgeHours: 24,
  liquidityUsd: 200000,
  volume24h: 500000,
  txns24h: 20,
  tokenAmount: 100,
};
function sample(
  amounts: Record<string, number>,
  at: string,
  observed = Object.keys(amounts),
  complete = true,
): ScoreHistorySample {
  return {
    tokenAmount: Object.values(amounts).reduce((a, b) => a + b, 0),
    holdingsUsd: 50000,
    smwIn: Object.values(amounts).filter((v) => v > 0).length,
    favoriteEntityCount: 0,
    favoriteHoldingsUsd: 0,
    entityAmounts: amounts,
    observedEntityKeys: observed,
    complete,
    at,
  };
}
test("credible new launches receive an age premium without rewarding unsupported dust", () => {
  assert.ok(
    computeStructuralScore(row) >
      computeStructuralScore({ ...row, tokenAgeHours: 30 * 24 }),
  );
  const dust = { ...row, holdingsUsd: 100, smwIn: 1 };
  assert.ok(
    computeStructuralScore(dust) <
      computeStructuralScore({ ...dust, tokenAgeHours: 30 * 24 }),
  );
});
test("age and market-cap boundaries no longer manufacture large score jumps", () => {
  for (const marketCap of [
    100000, 1000000, 10000000, 50000000, 200000000, 1000000000,
  ]) {
    const before = computeStructuralScore({ ...row, marketCap: marketCap - 1 });
    const after = computeStructuralScore({ ...row, marketCap: marketCap + 1 });
    assert.ok(Math.abs(after - before) / before < 0.001);
  }
  const a = computeStructuralScore({ ...row, tokenAgeHours: 6.99 * 24 }),
    b = computeStructuralScore({ ...row, tokenAgeHours: 7.01 * 24 });
  assert.ok(Math.abs(a - b) / a < 0.01);
});
test("unknown and conflicting MCAP never borrow low-cap upside or a small-cap momentum regime", () => {
  const missing = selectMarketCap(null, null, "2026-11-21T00:00:00Z");
  const conflict = selectMarketCap(1000000, 1000000000, "2026-11-21T00:00:00Z");
  assert.equal(
    withOpportunityScore({ ...row, ...missing }).scoreComponents.marketCap,
    0.8,
  );
  assert.equal(
    withOpportunityScore({ ...row, ...conflict, marketCap: 1000000 })
      .scoreComponents.marketCap,
    0.8,
  );
  assert.equal(
    withOpportunityScore({ ...row, ...conflict }).scoreComponents.footprint,
    1,
  );
});
test("quantity reduction is penalized even if USD holdings rise", () => {
  const result = withOpportunityScore(
    { ...row, holdingsUsd: 60000 },
    {
      previous: sample({ a: 100 }, "2026-11-20T00:00:00Z"),
      current: sample({ a: 80 }, "2026-11-21T00:00:00Z"),
    },
  );
  assert.ok(result.momentumBoost < 0);
  assert.ok(result.score < result.structuralScore);
  assert.ok(result.holdingDynamics.note.includes("not confirmed"));
});
test("price-only USD growth has zero holder momentum", () => {
  const result = withOpportunityScore(
    { ...row, holdingsUsd: 100000 },
    {
      previous: sample({ a: 100 }, "2026-11-20T00:00:00Z"),
      current: sample({ a: 100 }, "2026-11-21T00:00:00Z"),
    },
  );
  assert.equal(result.momentumBoost, 0);
});
test("new registry entities cannot masquerade as matched-cohort accumulation", () => {
  const d = measureHoldingDynamics({
    previous: sample({ a: 100 }, "2026-11-20T00:00:00Z"),
    current: sample({ a: 100, newlyTracked: 1000000 }, "2026-11-21T00:00:00Z"),
  });
  assert.equal(d.amountChangePct, 0);
  assert.equal(d.cohortSize, 1);
  assert.equal(d.coverageChanged, true);
  assert.deepEqual(d.increasedEntities, []);
});
test("partial observations, failed fetches and invalid timestamps cannot create sell signals", () => {
  const before = sample({ a: 100 }, "2026-11-20T00:00:00Z");
  for (const after of [
    sample({}, "2026-11-21T00:00:00Z", [], true),
    sample({}, "2026-11-21T00:00:00Z", ["a"], false),
    sample({ a: 50 }, before.at),
    sample({ a: 50 }, "invalid"),
  ])
    assert.equal(
      measureHoldingDynamics({ previous: before, current: after }).status,
      "insufficient",
    );
});
test("confirmed observation coverage permits full exits and finite penalties", () => {
  const result = withOpportunityScore(row, {
    previous: sample({ a: 100 }, "2026-11-20T00:00:00Z"),
    current: sample({}, "2026-11-21T00:00:00Z", ["a"]),
  });
  assert.equal(result.holdingDynamics.amountChangePct, -100);
  assert.equal(result.momentumBoost, -0.75);
  assert.ok(result.score >= 0);
});
test("holding momentum uses actual elapsed time", () => {
  const previous = sample({ a: 100 }, "2026-11-19T00:00:00Z");
  const fast = withOpportunityScore(row, {
    previous,
    current: sample({ a: 120 }, "2026-11-20T00:00:00Z"),
  });
  const slow = withOpportunityScore(row, {
    previous,
    current: sample({ a: 120 }, "2026-11-21T00:00:00Z"),
  });
  assert.ok(Math.abs(fast.momentumBoost - 2 * slow.momentumBoost) < 1e-10);
});

test("legacy values cannot reintroduce historical FDV-derived valuation bonuses", () => {
  const small = withOpportunityScore({
    ...row,
    marketCap: 1000000,
    marketCapEvidence: undefined,
  });
  const big = withOpportunityScore({
    ...row,
    marketCap: 1000000000,
    marketCapEvidence: undefined,
  });
  assert.equal(small.marketCapEvidence.status, "legacy");
  assert.equal(small.scoreComponents.marketCap, 0.8);
  assert.equal(small.score, big.score);
});

test("unknown holding-chain matches receive a lower valuation influence budget", () => {
  assert.equal(
    marketCapConfidence({ ...evidence, identityMatch: "unique-contract" }),
    0.5,
  );
  assert.equal(
    marketCapConfidence({ ...evidence, identityMatch: "chain-contract" }),
    1,
  );
});

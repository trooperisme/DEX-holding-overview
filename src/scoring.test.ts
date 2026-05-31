import assert from "node:assert/strict";
import test from "node:test";
import { computeOpportunityScore } from "./scoring";

test("computeOpportunityScore uses holdings, breadth, asymmetry, age, and moni boosts", () => {
  const score = computeOpportunityScore({
    holdingsUsd: 10_000,
    smwIn: 3,
    marketCap: 5_000_000,
    tokenAgeHours: 24 * 45,
    moniLevel: 6,
    moniMomentumScorePct: 800,
    moniMomentumRank: 80,
  });

  assert.equal(score, 44_105);
});

test("computeOpportunityScore treats missing Moni and token age as near-neutral", () => {
  const score = computeOpportunityScore({
    holdingsUsd: 10_000,
    smwIn: 2,
    marketCap: null,
    tokenAgeHours: null,
    moniLevel: null,
    moniMomentumScorePct: null,
    moniMomentumRank: null,
  });

  assert.equal(score, 9_286);
});

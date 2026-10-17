import assert from "node:assert/strict";
import test from "node:test";
import { computeOpportunityScore, computeStructuralScore, withOpportunityScore } from "./scoring";

test("v2 structural score puts a qualified low-cap in the intended attention lane", () => {
  const score = computeStructuralScore({
    holdingsUsd: 5_952,
    smwIn: 3,
    favoriteEntityCount: 3,
    marketCap: 2_316_988,
    tokenAgeHours: 10.6 * 24,
    liquidityUsd: 200_000,
    volume24h: 1_000_000,
  });

  assert.ok(score >= 100_000 && score < 1_000_000, `unexpected structural score: ${score}`);
});

test("holding attention floor protects large positions when market metadata is missing", () => {
  const scored = withOpportunityScore({
    tokenKey: "unknown:CATE",
    tokenSymbol: "UNKNOWN",
    tokenName: "Unknown token",
    networkName: "Unknown",
    chainId: null,
    tokenAddress: null,
    holdingsUsd: 2_849_506.58,
    smwIn: 4,
    favoriteEntityCount: 0,
    marketCap: null,
    tokenAgeHours: null,
    liquidityUsd: null,
    volume24h: null,
    txns24h: null,
  });

  assert.ok(scored.baseScore >= Math.round(scored.holdingsUsd));
  assert.ok(scored.score >= scored.baseScore);
});

test("holding floor is generic and does not override stronger structural evidence", () => {
  const floorOnly = computeStructuralScore({
    holdingsUsd: 191_586.32,
    smwIn: 5,
    favoriteEntityCount: 0,
    marketCap: null,
    tokenAgeHours: null,
    liquidityUsd: null,
    volume24h: null,
  });
  const structurallyStrong = computeStructuralScore({
    holdingsUsd: 5_952,
    smwIn: 3,
    favoriteEntityCount: 3,
    marketCap: 2_316_988,
    tokenAgeHours: 10.6 * 24,
    liquidityUsd: 200_000,
    volume24h: 1_000_000,
  });

  assert.ok(floorOnly >= 191_586);
  assert.ok(structurallyStrong > 5_952);
});

test("flat bluechip keeps its structural lane without momentum", () => {
  const row = {
    holdingsUsd: 160_980,
    smwIn: 1,
    favoriteEntityCount: 0,
    marketCap: 1_730_000_000,
    tokenAgeHours: 1_000,
    liquidityUsd: 100_000,
    volume24h: 5_000,
  };
  const scored = withOpportunityScore({
    tokenKey: "1:0xbluechip",
    tokenSymbol: "BLUE",
    tokenName: "Bluechip",
    networkName: "Ethereum",
    chainId: 1,
    tokenAddress: "0xbluechip",
    ...row,
    txns24h: 25,
  });

  assert.ok(scored.baseScore >= 1_000_000, `bluechip base too low: ${scored.baseScore}`);
  assert.ok(scored.momentumBoost >= 0);
  assert.ok(scored.score >= scored.baseScore);
});

test("momentum only adds to structural score and persistence can add confirmation", () => {
  const row = {
    holdingsUsd: 60_438,
    smwIn: 3,
    favoriteEntityCount: 1,
    favoriteHoldingsUsd: 8_210,
    marketCap: 23_262_835,
    tokenAgeHours: 10 * 24,
    liquidityUsd: 500_000,
    volume24h: 1_000_000,
    tokenAmount: 288_300_000,
  };
  const scored = withOpportunityScore({
    tokenKey: "1:0xmusebook",
    tokenSymbol: "MUSEBOOK",
    tokenName: "Musebook",
    networkName: "Ethereum",
    chainId: 1,
    tokenAddress: "0xmusebook",
    ...row,
    txns24h: 25,
  }, {
    currentAt: "2026-09-22T08:25:21.107Z",
    previous: {
      tokenAmount: 128_000_000,
      holdingsUsd: 7_632,
      smwIn: 3,
      favoriteEntityCount: 1,
      favoriteHoldingsUsd: 2_000,
      at: "2026-09-21T08:25:21.107Z",
    },
    previousPrevious: {
      tokenAmount: 58_900_000,
      holdingsUsd: 8_376,
      smwIn: 3,
      favoriteEntityCount: 1,
      favoriteHoldingsUsd: 1_500,
      at: "2026-09-18T08:25:21.107Z",
    },
  });

  assert.ok(scored.momentumBoost > 0);
  assert.ok(scored.score > scored.baseScore);
  assert.equal(scored.scoreVersion, "v2");
});

test("favorite convergence reaches the v2 calibration multiplier", () => {
  const row = {
    tokenKey: "ethereum:0xabc",
    tokenSymbol: "ABC",
    tokenName: "Token ABC",
    networkName: "Ethereum",
    chainId: 1,
    tokenAddress: "0xabc",
    holdingsUsd: 10_000,
    smwIn: 3,
    favoriteEntityCount: 3,
    favoriteHoldingsUsd: 2_000,
    favoriteEntityNames: ["Favorite Entity"],
    marketCap: 5_000_000,
    tokenAgeHours: 24 * 45,
    volume24h: 1_000_000,
    txns24h: 100,
    liquidityUsd: 100_000,
  };

  const scored = withOpportunityScore(row);

  assert.equal(scored.favoriteScoreMultiplier, 4);
  assert.equal(scored.score, scored.baseScore);
});

test("negative or price-only movement never creates a negative momentum penalty", () => {
  const scored = withOpportunityScore({
    tokenKey: "ethereum:0xslow",
    tokenSymbol: "SLOW",
    tokenName: "Slow",
    networkName: "Ethereum",
    chainId: 1,
    tokenAddress: "0xslow",
    holdingsUsd: 10_000,
    smwIn: 2,
    favoriteEntityCount: 0,
    marketCap: 5_000_000,
    tokenAgeHours: 24 * 45,
    volume24h: 100_000,
    liquidityUsd: 100_000,
    txns24h: 100,
    tokenAmount: 100,
  }, {
    currentAt: "2026-09-22T00:00:00.000Z",
    previous: {
      tokenAmount: 200,
      holdingsUsd: 5_000,
      smwIn: 2,
      favoriteEntityCount: 0,
      favoriteHoldingsUsd: 0,
      at: "2026-09-21T00:00:00.000Z",
    },
  });

  assert.ok(scored.momentumBoost >= 0);
  assert.ok(scored.score >= scored.baseScore);
});

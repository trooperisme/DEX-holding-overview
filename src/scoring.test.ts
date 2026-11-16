import assert from "node:assert/strict";
import test from "node:test";
import { computeOpportunityScore, computeStructuralScore, withOpportunityScore } from "./scoring";

test("v3 structural score rewards a qualified low-cap", () => {
  const score = computeStructuralScore({
    holdingsUsd: 5_952,
    smwIn: 3,
    favoriteEntityCount: 3,
    marketCap: 2_316_988,
    tokenAgeHours: 10.6 * 24,
    liquidityUsd: 200_000,
    volume24h: 1_000_000,
  });

  assert.ok(score >= 100_000, `unexpected structural score: ${score}`);
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

  assert.ok(scored.baseScore >= 300_000 && scored.baseScore <= 500_000);
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

  assert.ok(floorOnly >= 100_000);
  assert.ok(structurallyStrong > 5_952);
});

test("large market cap alone cannot create a high priority score", () => {
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

  assert.ok(scored.baseScore < 1_000_000, `bluechip base too high: ${scored.baseScore}`);
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
  assert.equal(scored.scoreVersion, "v3");
});

test("favorite convergence reaches the v3 calibration multiplier", () => {
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

  assert.equal(scored.favoriteScoreMultiplier, 2.4);
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

test("trader attention ranks conviction and real capital over passive major dust", () => {
  const score = (holdingsUsd: number, smwIn: number, favoriteEntityCount: number, marketCap: number | null, tokenAgeHours: number | null = null) =>
    computeStructuralScore({ holdingsUsd, smwIn, favoriteEntityCount, marketCap, tokenAgeHours });

  const aero = score(796.90, 2, 0, 617_553_769);
  const cbeth = score(172.48, 1, 0, 416_207_946);
  const surplus = score(329_300.27, 5, 3, 13_424_711, 176.3 * 24);
  const cards = score(102_560.63, 4, 2, null);
  const pendle = score(24_000, 1, 0, 1_000_000_000);

  assert.ok(aero < 25_000 && cbeth < 25_000);
  assert.ok(surplus > cards && cards > pendle && pendle > aero);
  assert.ok(cards > 250_000, `missing market cap buried strong holdings: ${cards}`);
  assert.ok(score(10_000_000_000, 1, 0, null) < cards, "one giant balance dominated conviction");
});

test("one small holder cannot reach the high attention lane through market data or momentum", () => {
  const row = {
    holdingsUsd: 4_326.73,
    smwIn: 1,
    favoriteEntityCount: 1,
    favoriteHoldingsUsd: 4_326.73,
    marketCap: 5_000_000,
    tokenAgeHours: 24 * 45,
    liquidityUsd: 1_000_000,
    volume24h: 10_000_000,
    entityConviction: 2,
    tokenAmount: 100,
  };
  const context = {
    currentAt: "2026-11-16T00:00:00.000Z",
    previous: {
      tokenAmount: 10,
      holdingsUsd: 1_000,
      smwIn: 1,
      favoriteEntityCount: 1,
      favoriteHoldingsUsd: 1_000,
      at: "2026-11-15T00:00:00.000Z",
    },
  };

  assert.ok(computeStructuralScore(row) <= 75_000);
  assert.ok(computeOpportunityScore(row, context) <= 75_000);
});

test("captured PEPE, MORPHO, and CRV positions remain below high attention after v3", () => {
  const positions = [
    { symbol: "PEPE", holdingsUsd: 5_162.08, smwIn: 1, favoriteEntityCount: 1, marketCap: 1_876_287_619, tokenAgeHours: 31_399.43, liquidityUsd: 28_574_117.53, volume24h: 2_682_295.18, entityConviction: 1.6 },
    { symbol: "MORPHO", holdingsUsd: 10_175.24, smwIn: 1, favoriteEntityCount: 1, marketCap: 1_415_660_326, tokenAgeHours: null, liquidityUsd: 1_022_534.09, volume24h: 584_083.48, entityConviction: 1.6 },
    { symbol: "CRV", holdingsUsd: 6_302.58, smwIn: 2, favoriteEntityCount: 2, marketCap: 586_807_181, tokenAgeHours: 28_955.29, liquidityUsd: 1_534_857.47, volume24h: 172_695.53, entityConviction: 1.175 },
  ];

  for (const { symbol, ...row } of positions) {
    const score = computeStructuralScore(row);
    assert.ok(score > 0 && score < 100_000, `${symbol} scored ${score} points`);
  }
});

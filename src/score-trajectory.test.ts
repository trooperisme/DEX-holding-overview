import assert from "node:assert/strict";
import test from "node:test";
import { withScoreTrajectories } from "./score-trajectory";
import { withOpportunityScore } from "./scoring";
import { TokenScorePoint } from "./types";
const base = {
  tokenKey: "1:0xabc",
  tokenSymbol: "ABC",
  tokenName: "ABC",
  tokenAddress: "0xabc",
  chainId: 1,
  networkName: "Ethereum",
  holdingsUsd: 50000,
  smwIn: 3,
  marketCap: 5000000,
  tokenAgeHours: 24,
  liquidityUsd: 200000,
  volume24h: 500000,
  txns24h: 20,
  tokenAmount: 100,
};
function point(id: number, day: number, score: number): TokenScorePoint {
  return {
    ...withOpportunityScore(base),
    score,
    snapshotId: id,
    snapshotStatus: "success",
    snapshotCreatedAt: new Date(Date.UTC(2026, 10, day)).toISOString(),
    snapshotFinishedAt: null,
  };
}
test("trajectory uses elapsed time on irregular intervals", () => {
  const result = withScoreTrajectories([
    point(1, 1, 100),
    point(2, 2, 200),
    point(3, 4, 400),
  ]);
  assert.equal(result[2].trajectory?.ratePointsPerDay, 100);
  assert.equal(result[2].trajectory?.accelerationPointsPerDay2, 0);
});
test("trajectory distinguishes rising acceleration from losing pace", () => {
  assert.equal(
    withScoreTrajectories([
      point(1, 1, 20),
      point(2, 2, 30),
      point(3, 3, 80),
    ])[2].trajectory?.phase,
    "Rising faster",
  );
  assert.equal(
    withScoreTrajectories([
      point(1, 1, 20),
      point(2, 2, 70),
      point(3, 3, 80),
    ])[2].trajectory?.phase,
    "Rising, losing pace",
  );
});
test("partial, same-time and reversed-time points do not generate trajectory claims", () => {
  for (const bad of [
    { ...point(2, 2, 200), snapshotStatus: "partial" as const },
    point(2, 1, 200),
    point(2, 0, 200),
  ])
    assert.equal(
      withScoreTrajectories([point(1, 1, 100), bad])[1].trajectory?.direction,
      "insufficient",
    );
});
test("fixed-order score drivers reconcile exactly including evidence caps and momentum", () => {
  const a = {
    ...point(1, 1, 1),
    ...withOpportunityScore({ ...base, holdingsUsd: 100, smwIn: 1 }),
  };
  const b = {
    ...point(2, 2, 1),
    ...withOpportunityScore({ ...base, holdingsUsd: 100000, smwIn: 5 }),
  };
  const result = withScoreTrajectories([a, b]);
  assert.equal(
    result[1].trajectory!.drivers.reduce((sum, d) => sum + d.points, 0),
    b.score - a.score,
  );
});

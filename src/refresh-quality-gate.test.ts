import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateRefreshQuality,
  getRefreshQualityGateConfig,
} from "./refresh-quality-gate";
import { RefreshResult } from "./types";

function result(overrides: Partial<RefreshResult> = {}): RefreshResult {
  return {
    snapshotId: 123,
    totalEntities: 80,
    entitiesCompleted: 80,
    entitiesFailed: 0,
    totalRows: 12_095,
    status: "success",
    ...overrides,
  };
}

test("full non-empty refresh passes the default quality gate", () => {
  const quality = evaluateRefreshQuality(result());

  assert.equal(quality.ok, true);
  assert.deepEqual(quality.failures, []);
  assert.equal(quality.entityCoverage, 1);
});

test("partial refresh fails even when it produced some rows", () => {
  const quality = evaluateRefreshQuality(result({
    entitiesCompleted: 79,
    entitiesFailed: 1,
    totalRows: 12_000,
    status: "partial",
  }));

  assert.equal(quality.ok, false);
  assert.match(quality.failures.join("; "), /partial/);
  assert.match(quality.failures.join("; "), /1 entity fetches failed/);
});

test("empty refresh fails closed", () => {
  const quality = evaluateRefreshQuality(result({
    totalEntities: 0,
    entitiesCompleted: 0,
    totalRows: 0,
  }));

  assert.equal(quality.ok, false);
  assert.match(quality.failures.join("; "), /no tracked entities/);
  assert.match(quality.failures.join("; "), /minimum is 1/);
});

test("thresholds can be configured without weakening the default", () => {
  const config = getRefreshQualityGateConfig({
    REFRESH_MIN_ENTITY_COVERAGE: "0.9",
    REFRESH_MIN_ROWS: "10",
  });
  const quality = evaluateRefreshQuality(
    result({
      entitiesCompleted: 72,
      entitiesFailed: 8,
      totalRows: 10,
      status: "partial",
    }),
    config,
  );

  assert.equal(config.minEntityCoverage, 0.9);
  assert.equal(config.minRows, 10);
  assert.equal(quality.ok, false);
  assert.match(quality.failures.join("; "), /partial/);
});

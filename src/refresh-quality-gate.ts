import { RefreshResult } from "./types";

export type RefreshQualityGateConfig = {
  minEntityCoverage: number;
  minRows: number;
};

export type RefreshQualityGateResult = {
  ok: boolean;
  failures: string[];
  entityCoverage: number;
};

function readFiniteNumber(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const value = Number(env[name]);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * The scheduled job is a data-publishing job, so its default policy is
 * deliberately fail-closed: every tracked entity must complete and the
 * resulting snapshot must contain at least one holding row.
 */
export function getRefreshQualityGateConfig(
  env: NodeJS.ProcessEnv = process.env,
): RefreshQualityGateConfig {
  const minEntityCoverage = Math.min(
    1,
    Math.max(0, readFiniteNumber(env, "REFRESH_MIN_ENTITY_COVERAGE", 1)),
  );
  const minRows = Math.max(0, Math.trunc(readFiniteNumber(env, "REFRESH_MIN_ROWS", 1)));

  return { minEntityCoverage, minRows };
}

export function evaluateRefreshQuality(
  result: RefreshResult,
  config: RefreshQualityGateConfig = getRefreshQualityGateConfig(),
): RefreshQualityGateResult {
  const failures: string[] = [];
  const entityCoverage = result.totalEntities > 0
    ? result.entitiesCompleted / result.totalEntities
    : 0;

  if (result.status !== "success") {
    failures.push(`snapshot status is ${result.status}`);
  }
  if (result.totalEntities <= 0) {
    failures.push("no tracked entities were loaded");
  }
  if (entityCoverage < config.minEntityCoverage) {
    failures.push(
      `entity coverage ${result.entitiesCompleted}/${result.totalEntities} ` +
      `is below ${config.minEntityCoverage * 100}%`,
    );
  }
  if (result.entitiesFailed > 0) {
    failures.push(`${result.entitiesFailed} entity fetches failed`);
  }
  if (result.totalRows < config.minRows) {
    failures.push(`snapshot contains ${result.totalRows} rows; minimum is ${config.minRows}`);
  }

  return { ok: failures.length === 0, failures, entityCoverage };
}

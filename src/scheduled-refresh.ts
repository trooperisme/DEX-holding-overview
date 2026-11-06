import dotenv from "dotenv";
import { runDexRefresh } from "./dex-refresh";
import {
  evaluateRefreshQuality,
  getRefreshQualityGateConfig,
} from "./refresh-quality-gate";
import { closePostgresPool } from "./storage-postgres";
import { createStorage } from "./storage";
import { fetchTrenchIndex } from "./trench-index";

dotenv.config();

/**
 * Entry point for a scheduled worker (for example GitHub Actions or Railway Cron).
 *
 * Railway starts this process on schedule and expects it to exit when the
 * refresh finishes. The web server remains a separate service/process.
 */
export async function runScheduledRefresh(): Promise<void> {
  const startedAt = new Date().toISOString();
  console.log(`[scheduled-refresh] Starting full scan at ${startedAt}.`);

  const storage = createStorage(process.cwd());
  try {
    const regime = await storage.upsertTrenchIndex(await fetchTrenchIndex());
    console.log(
      `[scheduled-refresh] Stored market regime ${regime.band} (${regime.score}) for ${regime.day}.`,
    );
  } finally {
    await storage.close();
  }

  const result = await runDexRefresh({
    cwd: process.cwd(),
    callbacks: {
      onLog: (_tone, message) => console.log(`[scheduled-refresh] ${message}`),
    },
  });

  console.log(
    `[scheduled-refresh] Finished with status=${result.status}, ` +
      `snapshotId=${result.snapshotId}, ` +
      `entities=${result.entitiesCompleted}/${result.totalEntities}, ` +
      `failed=${result.entitiesFailed}, rows=${result.totalRows}.`,
  );

  const quality = evaluateRefreshQuality(result, getRefreshQualityGateConfig());
  if (!quality.ok) {
    throw new Error(
      `Scheduled refresh quality gate failed: ${quality.failures.join("; ")}`,
    );
  }
}

if (require.main === module) {
  runScheduledRefresh().catch((error: unknown) => {
    console.error(
      "[scheduled-refresh] Fatal error:",
      error instanceof Error ? error.message : error,
    );
    process.exitCode = 1;
  }).finally(() => closePostgresPool());
}

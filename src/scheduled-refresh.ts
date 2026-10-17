import dotenv from "dotenv";
import { runDexRefresh } from "./dex-refresh";
import { closePostgresPool } from "./storage-postgres";

dotenv.config();

/**
 * Entry point for a Railway Cron service.
 *
 * Railway starts this process on schedule and expects it to exit when the
 * refresh finishes. The web server remains a separate service/process.
 */
export async function runScheduledRefresh(): Promise<void> {
  const startedAt = new Date().toISOString();
  console.log(`[scheduled-refresh] Starting full scan at ${startedAt}.`);

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

  if (result.status === "failed") {
    throw new Error("Scheduled refresh failed: all entity fetches failed");
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

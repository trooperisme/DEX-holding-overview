import fs from "node:fs";
import path from "node:path";

function ensureDirExists(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

export function resolveWorkspacePaths(cwd: string) {
  const dataRoot = process.env.DATA_DIR
    ? path.resolve(cwd, process.env.DATA_DIR)
    : path.join(cwd, "data");

  const rawDir = path.join(dataRoot, "raw");
  const dbDir = path.join(dataRoot, "db");
  const dashboardDir = path.join(cwd, "dashboard");
  const dbFile = path.join(dbDir, "dex-holding-overview.db");
  const entitiesCsv =
    process.env.TRADER_ENTITIES_CSV && process.env.TRADER_ENTITIES_CSV.trim()
      ? path.resolve(cwd, process.env.TRADER_ENTITIES_CSV)
      : path.join(rawDir, "dex-entities-zapper.csv");

  ensureDirExists(rawDir);
  ensureDirExists(dbDir);
  ensureDirExists(dashboardDir);

  return {
    cwd,
    dataRoot,
    rawDir,
    dbDir,
    dbFile,
    entitiesCsv,
    dashboardDir,
  };
}

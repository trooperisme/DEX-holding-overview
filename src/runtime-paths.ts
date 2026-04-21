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
    : process.env.VERCEL
      ? path.join("/tmp", "dex-holding-overview-data")
      : path.join(cwd, "data");

  const rawDir = path.join(dataRoot, "raw");
  const dbDir = path.join(dataRoot, "db");
  const publicDashboardDir = path.join(cwd, "public", "dashboard");
  const dashboardDir = fs.existsSync(publicDashboardDir)
    ? publicDashboardDir
    : path.join(cwd, "dashboard");
  const dbFile = path.join(dbDir, "dex-holding-overview.db");
  const entitiesCsv =
    process.env.TRADER_ENTITIES_CSV && process.env.TRADER_ENTITIES_CSV.trim()
      ? path.resolve(cwd, process.env.TRADER_ENTITIES_CSV)
      : path.join(cwd, "data", "raw", "dex-entities-zapper.csv");

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

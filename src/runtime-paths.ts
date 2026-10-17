import fs from "node:fs";
import path from "node:path";

function ensureDirExists(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

export function resolveWorkspacePaths(cwd: string) {
  const dataRoot = process.env.DATA_DIR && !process.env.VERCEL
    ? path.resolve(cwd, process.env.DATA_DIR)
    : process.env.VERCEL
      ? path.join("/tmp", "dex-holding-overview-data")
      : path.join(cwd, "data");

  const rawDir = path.join(dataRoot, "raw");
  const dbDir = path.join(dataRoot, "db");
  const publicDashboardDir = path.join(cwd, "public", "dashboard");
  const sourceDashboardDir = path.join(cwd, "dashboard");
  const dashboardDir = process.env.VERCEL && fs.existsSync(publicDashboardDir)
    ? publicDashboardDir
    : sourceDashboardDir;
  const dbFile = path.join(dbDir, "dex-holding-overview.db");
  const cieloEntitiesCsv = process.env.CIELO_ENTITIES_CSV?.trim()
    ? path.resolve(cwd, process.env.CIELO_ENTITIES_CSV)
    : path.join(cwd, "data", "raw", "entity-cielo-portfolio-links.csv");

  ensureDirExists(rawDir);
  ensureDirExists(dbDir);

  return {
    cwd,
    dataRoot,
    rawDir,
    dbDir,
    dbFile,
    cieloEntitiesCsv,
    dashboardDir,
  };
}

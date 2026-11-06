import crypto from "node:crypto";
import { Pool } from "pg";

type StatusRequest = {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
};

type StatusResponse = {
  setHeader(name: string, value: string): void;
  status(code: number): StatusResponse;
  json(payload: unknown): void;
  end(): void;
};

let pool: Pool | null = null;

function hasAtlasToken(req: StatusRequest): boolean {
  const expected = String(process.env.ATLAS_STATUS_TOKEN || "").trim();
  const authorization = String(req.headers.authorization || "");
  const provided = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
  if (!expected || !provided) return false;
  const expectedDigest = crypto.createHash("sha256").update(expected).digest();
  const providedDigest = crypto.createHash("sha256").update(provided).digest();
  return crypto.timingSafeEqual(expectedDigest, providedDigest);
}

function tableName(): string {
  const schema = String(process.env.DATABASE_SCHEMA || "dex").trim();
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) throw new Error("Invalid database schema");
  return `"${schema}"."holding_snapshots"`;
}

function getPool(): Pool {
  if (pool) return pool;
  const connectionString = String(process.env.DATABASE_URL || "").trim();
  if (!connectionString) throw new Error("Database is not configured");
  const url = new URL(connectionString);
  pool = new Pool({
    connectionString,
    max: 1,
    ssl: ["localhost", "127.0.0.1"].includes(url.hostname) ? undefined : { rejectUnauthorized: false },
  });
  return pool;
}

function vietnamDay(value: string | null | undefined): string | null {
  if (!value || !Number.isFinite(new Date(value).getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

export default async function handler(req: StatusRequest, res: StatusResponse): Promise<void> {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    res.status(405).end();
    return;
  }
  if (!hasAtlasToken(req)) {
    res.status(401).json({ product: "dex", snapshotState: "unavailable" });
    return;
  }
  try {
    const result = await getPool().query(
      `SELECT id, created_at, finished_at FROM ${tableName()} WHERE status = 'success' ORDER BY id DESC LIMIT 1`,
    );
    const snapshot = result.rows[0] || null;
    const completedAt = snapshot?.finished_at || snapshot?.created_at || null;
    const today = vietnamDay(new Date().toISOString());
    res.status(200).json({
      product: "dex",
      snapshotState: vietnamDay(completedAt) === today ? "fresh" : "missing",
      snapshotKey: snapshot ? String(snapshot.id) : null,
    });
  } catch (error) {
    console.error("Atlas status query failed", error instanceof Error ? error.message : "Unknown database error");
    res.status(503).json({ product: "dex", snapshotState: "unavailable" });
  }
}

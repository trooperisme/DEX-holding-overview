import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import Database from "better-sqlite3";
import { Pool, PoolClient } from "pg";

type TableConfig = {
  name: string;
  columns: string[];
  sqliteOrderBy: string;
  batchSize: number;
  transformRow?: (row: Record<string, unknown>) => Record<string, unknown>;
};

const tableConfigs: TableConfig[] = [
  {
    name: "entities",
    columns: ["id", "entity_name", "full_zapper_link", "resolved_label", "link_type", "created_at", "updated_at"],
    sqliteOrderBy: "id ASC",
    batchSize: 250,
  },
  {
    name: "entity_wallets",
    columns: ["id", "entity_id", "wallet_address", "wallet_index", "created_at"],
    sqliteOrderBy: "id ASC",
    batchSize: 500,
  },
  {
    name: "holding_snapshots",
    columns: [
      "id",
      "status",
      "zapper_key_label",
      "total_entities",
      "entities_completed",
      "entities_failed",
      "total_rows",
      "error_message",
      "created_at",
      "finished_at",
    ],
    sqliteOrderBy: "id ASC",
    batchSize: 250,
  },
  {
    name: "entity_fetch_runs",
    columns: [
      "id",
      "snapshot_id",
      "entity_id",
      "status",
      "rows_found",
      "total_balance_usd",
      "error_message",
      "started_at",
      "finished_at",
    ],
    sqliteOrderBy: "id ASC",
    batchSize: 500,
  },
  {
    name: "raw_holdings",
    columns: [
      "id",
      "snapshot_id",
      "entity_id",
      "token_key",
      "token_symbol",
      "token_name",
      "token_address",
      "network_name",
      "chain_id",
      "balance",
      "balance_raw",
      "balance_usd",
      "price",
      "market_cap",
      "liquidity_usd",
      "volume_24h",
      "txns_24h",
      "token_age_hours",
      "moni_score",
      "moni_level",
      "moni_level_name",
      "moni_momentum_score_pct",
      "moni_momentum_rank",
      "fetched_at",
    ],
    sqliteOrderBy: "id ASC",
    batchSize: 400,
  },
  {
    name: "token_blacklist",
    columns: [
      "id",
      "token_key",
      "token_symbol",
      "token_name",
      "network_name",
      "chain_id",
      "token_address",
      "reason",
      "is_active",
      "created_at",
      "updated_at",
    ],
    sqliteOrderBy: "id ASC",
    batchSize: 250,
    transformRow: (row) => ({
      ...row,
      is_active: Boolean(Number(row.is_active ?? 0)),
    }),
  },
];

function readFlag(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function getSchema(): string {
  const schema = process.env.DATABASE_SCHEMA?.trim() || "dex";
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) {
    throw new Error("DATABASE_SCHEMA must be a valid Postgres identifier");
  }
  return schema;
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

function qualifiedTable(schema: string, tableName: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(tableName)}`;
}

function parseArgs(argv: string[]) {
  let sqlitePath = process.env.SQLITE_PATH?.trim() || "";
  let truncate = readFlag("PG_TRUNCATE_BEFORE_IMPORT");

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if ((arg === "--sqlite" || arg === "-s") && argv[index + 1]) {
      sqlitePath = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--truncate") {
      truncate = true;
    }
  }

  return { sqlitePath, truncate };
}

function resolveSqlitePath(inputPath: string): string {
  if (!inputPath) {
    throw new Error("Provide the SQLite file via SQLITE_PATH or --sqlite /path/to/dex-holding-overview.db");
  }

  const resolved = path.resolve(process.cwd(), inputPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`SQLite file not found: ${resolved}`);
  }

  return resolved;
}

function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }

  const url = new URL(connectionString);
  const needsSsl = !["localhost", "127.0.0.1"].includes(url.hostname);

  return new Pool({
    connectionString,
    max: 1,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  });
}

async function assertSchemaReady(client: PoolClient, schema: string): Promise<void> {
  const result = await client.query<{ exists: boolean }>(
    `
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = $1
          AND table_name = 'entities'
      ) AS exists
    `,
    [schema],
  );

  if (!result.rows[0]?.exists) {
    throw new Error(`Schema ${schema} is not initialized. Run supabase/schema.sql first.`);
  }
}

async function assertTargetEmpty(client: PoolClient, schema: string): Promise<void> {
  for (const config of tableConfigs) {
    const tableName = qualifiedTable(schema, config.name);
    const result = await client.query<{ count: string }>(`SELECT COUNT(*) AS count FROM ${tableName}`);
    if (Number(result.rows[0]?.count || 0) > 0) {
      throw new Error(
        `Target table ${schema}.${config.name} is not empty. Use --truncate or PG_TRUNCATE_BEFORE_IMPORT=1 if you want to overwrite it.`,
      );
    }
  }
}

async function truncateTarget(client: PoolClient, schema: string): Promise<void> {
  const orderedTables = [...tableConfigs].reverse().map((config) => qualifiedTable(schema, config.name));
  await client.query(`TRUNCATE TABLE ${orderedTables.join(", ")} RESTART IDENTITY CASCADE`);
}

function normalizeRow(row: Record<string, unknown>, config: TableConfig): Record<string, unknown> {
  return config.transformRow ? config.transformRow(row) : row;
}

async function copyTable(
  sqlite: Database.Database,
  client: PoolClient,
  schema: string,
  config: TableConfig,
): Promise<number> {
  const sqliteQuery = `SELECT ${config.columns.join(", ")} FROM ${config.name} ORDER BY ${config.sqliteOrderBy}`;
  const statement = sqlite.prepare(sqliteQuery);
  const tableName = qualifiedTable(schema, config.name);
  const columnsSql = config.columns.map(quoteIdentifier).join(", ");
  const rows: Record<string, unknown>[] = [];
  let inserted = 0;

  const flush = async () => {
    if (!rows.length) return;

    const values: unknown[] = [];
    const placeholders = rows.map((originalRow, rowIndex) => {
      const row = normalizeRow(originalRow, config);
      const rowValues = config.columns.map((columnName) => row[columnName] ?? null);
      values.push(...rowValues);
      const offset = rowIndex * config.columns.length;
      return `(${config.columns.map((_, columnIndex) => `$${offset + columnIndex + 1}`).join(", ")})`;
    });

    await client.query(
      `INSERT INTO ${tableName} (${columnsSql}) OVERRIDING SYSTEM VALUE VALUES ${placeholders.join(", ")}`,
      values,
    );
    inserted += rows.length;
    rows.length = 0;
  };

  for (const row of statement.iterate() as Iterable<Record<string, unknown>>) {
    rows.push(row);
    if (rows.length >= config.batchSize) {
      await flush();
    }
  }

  await flush();
  return inserted;
}

async function syncSequence(client: PoolClient, schema: string, tableName: string): Promise<void> {
  const qualified = qualifiedTable(schema, tableName);
  await client.query(
    `
      SELECT setval(
        pg_get_serial_sequence($1, 'id'),
        COALESCE((SELECT MAX(id) FROM ${qualified}), 1),
        (SELECT COUNT(*) > 0 FROM ${qualified})
      )
    `,
    [`${schema}.${tableName}`],
  );
}

async function main(): Promise<void> {
  const { sqlitePath, truncate } = parseArgs(process.argv.slice(2));
  const resolvedSqlitePath = resolveSqlitePath(sqlitePath);
  const schema = getSchema();
  const sqlite = new Database(resolvedSqlitePath, { readonly: true });
  const pool = createPool();

  console.log(`SQLite source: ${resolvedSqlitePath}`);
  console.log(`Postgres target schema: ${schema}`);

  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await assertSchemaReady(client, schema);

      if (truncate) {
        console.log(`Truncating existing data in schema ${schema}.`);
        await truncateTarget(client, schema);
      } else {
        await assertTargetEmpty(client, schema);
      }

      for (const config of tableConfigs) {
        const count = await copyTable(sqlite, client, schema, config);
        console.log(`Imported ${count} rows into ${schema}.${config.name}.`);
      }

      for (const config of tableConfigs) {
        await syncSequence(client, schema, config.name);
      }

      await client.query("COMMIT");
      console.log("SQLite to Postgres migration completed.");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } finally {
    sqlite.close();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

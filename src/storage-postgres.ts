import { Pool, PoolClient } from "pg";
import { ScoreContext, ScoreHistorySample, withOpportunityScore } from "./scoring";
import {
  EntityFetchRunRecord,
  EntityRecord,
  EntityWalletRecord,
  ImportedEntity,
  RawHoldingRecord,
  SnapshotRecord,
  TokenBlacklistRecord,
  TokenHolderRow,
  TokenOverviewRow,
  TokenScorePoint,
} from "./types";
import { SnapshotTokenForEnrichment, SnapshotUpdate, StorageAdapter } from "./storage-types";
import { normalizeTokenName } from "./token-name";

let sharedPool: Pool | null = null;

export async function closePostgresPool(): Promise<void> {
  const pool = sharedPool;
  sharedPool = null;
  if (pool) await pool.end();
}

function getSchema(): string {
  const schema = process.env.DATABASE_SCHEMA?.trim() || "dex";
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) {
    throw new Error("DATABASE_SCHEMA must be a valid Postgres identifier");
  }
  return schema;
}

function table(name: string): string {
  return `"${getSchema()}"."${name}"`;
}

function getPool(): Pool {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error("DATABASE_URL is required for Postgres storage");
  }

  if (!sharedPool) {
    const url = new URL(connectionString);
    const needsSsl = !["localhost", "127.0.0.1"].includes(url.hostname);
    sharedPool = new Pool({
      connectionString,
      max: Number(process.env.DATABASE_POOL_MAX || 4),
      ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
    });
  }

  return sharedPool;
}

async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function numberOrNull(value: unknown): number | null {
  if (value == null) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function mapSnapshot(row: any): SnapshotRecord {
  return {
    id: Number(row.id),
    status: row.status,
    providerLabel: row.zapper_key_label,
    totalEntities: Number(row.total_entities),
    entitiesCompleted: Number(row.entities_completed),
    entitiesFailed: Number(row.entities_failed),
    totalRows: Number(row.total_rows),
    solanaRows: numberOrNull(row.solana_rows) ?? undefined,
    nonSolanaRows: numberOrNull(row.non_solana_rows) ?? undefined,
    errorMessage: row.error_message,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    finishedAt: row.finished_at ? (row.finished_at instanceof Date ? row.finished_at.toISOString() : String(row.finished_at)) : null,
  };
}

function normalizeFavoriteEntityKeys(names: string[] = []): string[] {
  return [...new Set(names.map((name) => String(name || "").trim().toLowerCase()).filter(Boolean))];
}

async function getEntityConvictionByToken(snapshotId: number, minBalanceUsd: number): Promise<Map<string, number>> {
  const grouped = await getEntityConvictionByTokenForSnapshots([snapshotId], minBalanceUsd);
  return grouped.get(snapshotId) || new Map();
}

async function getEntityConvictionByTokenForSnapshots(snapshotIds: number[], minBalanceUsd: number): Promise<Map<number, Map<string, number>>> {
  if (!snapshotIds.length) return new Map();
  const result = await getPool().query(
    `WITH positions AS (
       SELECT rh.snapshot_id, rh.token_key, lower(e.entity_name) as entity_key, MAX(rh.balance_usd) as balance_usd
       FROM ${table("raw_holdings")} rh
       INNER JOIN ${table("entities")} e ON e.id = rh.entity_id
       LEFT JOIN ${table("token_blacklist")} bl
         ON bl.token_key = rh.token_key AND bl.is_active = true
       WHERE rh.snapshot_id = ANY($1::bigint[]) AND rh.balance_usd >= $2 AND bl.id IS NULL
       GROUP BY rh.snapshot_id, rh.token_key, lower(e.entity_name)
     ),
     medians AS (
       SELECT snapshot_id, entity_key, percentile_cont(0.5) WITHIN GROUP (ORDER BY balance_usd) as median_balance_usd
       FROM positions
       GROUP BY snapshot_id, entity_key
     )
     SELECT p.snapshot_id, p.token_key, AVG(
       CASE
         WHEN p.balance_usd / GREATEST(m.median_balance_usd, 1) < 0.5 THEN 0.75
         WHEN p.balance_usd / GREATEST(m.median_balance_usd, 1) < 1 THEN 0.9
         WHEN p.balance_usd / GREATEST(m.median_balance_usd, 1) < 2 THEN 1.1
         WHEN p.balance_usd / GREATEST(m.median_balance_usd, 1) < 4 THEN 1.35
         ELSE 1.6
       END
     ) as entity_conviction
     FROM positions p
     INNER JOIN medians m ON m.snapshot_id = p.snapshot_id AND m.entity_key = p.entity_key
     GROUP BY p.snapshot_id, p.token_key`,
    [snapshotIds, minBalanceUsd],
  );
  const output = new Map<number, Map<string, number>>();
  for (const row of result.rows) {
    const byToken = output.get(Number(row.snapshot_id)) || new Map<string, number>();
    byToken.set(row.token_key, Number(row.entity_conviction || 1));
    output.set(Number(row.snapshot_id), byToken);
  }
  return output;
}

async function getEntityConvictionForTokenAtSnapshots(
  snapshotIds: number[],
  tokenKey: string,
  minBalanceUsd: number,
): Promise<Map<number, number>> {
  if (!snapshotIds.length) return new Map();
  const result = await getPool().query(
    `WITH target_entities AS (
       SELECT rh.snapshot_id, lower(e.entity_name) as entity_key
       FROM ${table("raw_holdings")} rh
       INNER JOIN ${table("entities")} e ON e.id = rh.entity_id
       LEFT JOIN ${table("token_blacklist")} bl
         ON bl.token_key = rh.token_key AND bl.is_active = true
       WHERE rh.snapshot_id = ANY($1::bigint[])
         AND rh.token_key = $2
         AND rh.balance_usd >= $3
         AND bl.id IS NULL
       GROUP BY rh.snapshot_id, lower(e.entity_name)
     ),
     positions AS (
       SELECT rh.snapshot_id, rh.token_key, lower(e.entity_name) as entity_key,
              MAX(rh.balance_usd) as balance_usd
       FROM ${table("raw_holdings")} rh
       INNER JOIN ${table("entities")} e ON e.id = rh.entity_id
       INNER JOIN target_entities te
         ON te.snapshot_id = rh.snapshot_id AND te.entity_key = lower(e.entity_name)
       LEFT JOIN ${table("token_blacklist")} bl
         ON bl.token_key = rh.token_key AND bl.is_active = true
       WHERE rh.snapshot_id = ANY($1::bigint[])
         AND rh.balance_usd >= $3
         AND bl.id IS NULL
       GROUP BY rh.snapshot_id, rh.token_key, lower(e.entity_name)
     ),
     medians AS (
       SELECT snapshot_id, entity_key,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY balance_usd) as median_balance_usd
       FROM positions
       GROUP BY snapshot_id, entity_key
     )
     SELECT p.snapshot_id, AVG(
       CASE
         WHEN p.balance_usd / GREATEST(m.median_balance_usd, 1) < 0.5 THEN 0.75
         WHEN p.balance_usd / GREATEST(m.median_balance_usd, 1) < 1 THEN 0.9
         WHEN p.balance_usd / GREATEST(m.median_balance_usd, 1) < 2 THEN 1.1
         WHEN p.balance_usd / GREATEST(m.median_balance_usd, 1) < 4 THEN 1.35
         ELSE 1.6
       END
     ) as entity_conviction
     FROM positions p
     INNER JOIN medians m ON m.snapshot_id = p.snapshot_id AND m.entity_key = p.entity_key
     WHERE p.token_key = $2
     GROUP BY p.snapshot_id, p.token_key`,
    [snapshotIds, tokenKey, minBalanceUsd],
  );
  return new Map(result.rows.map((row) => [Number(row.snapshot_id), Number(row.entity_conviction || 1)]));
}

async function getPreviousScoreSamples(
  snapshotId: number,
  minBalanceUsd: number,
  favoriteEntityKeys: string[],
): Promise<Map<string, ScoreHistorySample[]>> {
  const snapshots = await getPool().query(
    `SELECT id, COALESCE(finished_at, created_at) as at
     FROM ${table("holding_snapshots")}
     WHERE id < $1 AND status = 'success'
     ORDER BY COALESCE(finished_at, created_at) DESC, id DESC
     LIMIT 2`,
    [snapshotId],
  );
  if (!snapshots.rows.length) return new Map();
  const ids = snapshots.rows.map((row) => Number(row.id));
  const result = await getPool().query(
    `WITH canonical AS (
       SELECT rh.snapshot_id, rh.token_key, lower(e.entity_name) as entity_key,
              MAX(rh.balance_usd) as balance_usd,
              MAX(NULLIF(regexp_replace(trim(rh.balance), '([^0-9eE+.-]).*$', ''), '')::numeric) as token_amount
       FROM ${table("raw_holdings")} rh
       INNER JOIN ${table("entities")} e ON e.id = rh.entity_id
       LEFT JOIN ${table("token_blacklist")} bl
         ON bl.token_key = rh.token_key AND bl.is_active = true
       WHERE rh.snapshot_id = ANY($1::bigint[]) AND rh.balance_usd >= $2 AND bl.id IS NULL
       GROUP BY rh.snapshot_id, rh.token_key, lower(e.entity_name)
     )
     SELECT snapshot_id, token_key,
            ROUND(SUM(balance_usd)::numeric, 2) as holdings_usd,
            SUM(token_amount) as token_amount,
            COUNT(*) as smw_in,
            COUNT(*) FILTER (WHERE entity_key = ANY($3::text[])) as favorite_entity_count,
            ROUND(COALESCE(SUM(balance_usd) FILTER (WHERE entity_key = ANY($3::text[])), 0)::numeric, 2) as favorite_holdings_usd
     FROM canonical
     GROUP BY snapshot_id, token_key`,
    [ids, minBalanceUsd, favoriteEntityKeys],
  );
  const snapshotById = new Map(snapshots.rows.map((row) => [Number(row.id), String(row.at)]));
  const grouped = new Map<string, ScoreHistorySample[]>();
  for (const row of result.rows) {
    const at = snapshotById.get(Number(row.snapshot_id));
    if (!at) continue;
    const list = grouped.get(row.token_key) || [];
    list.push({
      tokenAmount: Number(row.token_amount || 0),
      holdingsUsd: Number(row.holdings_usd || 0),
      smwIn: Number(row.smw_in || 0),
      favoriteEntityCount: Number(row.favorite_entity_count || 0),
      favoriteHoldingsUsd: Number(row.favorite_holdings_usd || 0),
      at,
    });
    grouped.set(row.token_key, list);
  }
  for (const list of grouped.values()) list.sort((left, right) => Date.parse(right.at) - Date.parse(left.at));
  return grouped;
}

function normalizeRawHoldingTokenName(row: RawHoldingRecord): string {
  return normalizeTokenName({
    tokenName: row.tokenName,
    tokenSymbol: row.tokenSymbol,
    tokenAddress: row.tokenAddress,
    tokenKey: row.tokenKey,
    networkName: row.networkName,
  });
}

function mapEntity(row: any): EntityRecord {
  return {
    id: Number(row.id),
    entityName: row.entity_name,
    sourceUrl: row.full_zapper_link,
    resolvedLabel: row.resolved_label,
    linkType: row.link_type,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}

function mapOverview(row: any): TokenOverviewRow {
  return withOpportunityScore({
    tokenKey: row.token_key,
    tokenSymbol: row.token_symbol,
    tokenName: row.token_name,
    networkName: row.network_name,
    chainId: numberOrNull(row.chain_id),
    tokenAddress: row.token_address,
    holdingsUsd: Number(row.holdings_usd || 0),
    tokenAmount: Number(row.token_amount || 0),
    smwIn: Number(row.smw_in || 0),
    favoriteEntityCount: Number(row.favorite_entity_count || 0),
    favoriteHoldingsUsd: Number(row.favorite_holdings_usd || 0),
    favoriteEntityNames: Array.isArray(row.favorite_entity_names) ? row.favorite_entity_names.filter(Boolean) : [],
    marketCap: numberOrNull(row.market_cap),
    tokenAgeHours: numberOrNull(row.token_age_hours),
    volume24h: numberOrNull(row.volume_24h),
    txns24h: numberOrNull(row.txns_24h),
    liquidityUsd: numberOrNull(row.liquidity_usd),
    entityConviction: Number(row.entity_conviction || 1),
  });
}

export function createPostgresStorage(): StorageAdapter {
  return {
    close(): void {
      // The shared pool is intentionally reused across Vercel function invocations.
    },

    async replaceEntities(entities: ImportedEntity[]): Promise<void> {
      await withTransaction(async (client) => {
        const now = new Date().toISOString();
        for (const entity of entities) {
          const existing = await client.query<{ id: string }>(
            `SELECT id
             FROM ${table("entities")}
             WHERE full_zapper_link = $2
                OR lower(entity_name) = lower($1)
             ORDER BY
               CASE WHEN full_zapper_link = $2 THEN 0 ELSE 1 END,
               updated_at DESC,
               id DESC
             LIMIT 1`,
            [entity.entityName, entity.sourceUrl],
          );
          const result = existing.rows[0]
            ? await client.query<{ id: string }>(
                `UPDATE ${table("entities")}
                 SET entity_name = $1,
                     full_zapper_link = $2,
                     resolved_label = $3,
                     link_type = $4,
                     updated_at = $5
                 WHERE id = $6
                 RETURNING id`,
                [
                  entity.entityName,
                  entity.sourceUrl,
                  entity.resolvedLabel,
                  entity.linkType,
                  now,
                  existing.rows[0].id,
                ],
              )
            : await client.query<{ id: string }>(
                `INSERT INTO ${table("entities")} (
                   entity_name, full_zapper_link, resolved_label, link_type, created_at, updated_at
                 ) VALUES ($1, $2, $3, $4, $5, $5)
                 ON CONFLICT (full_zapper_link) DO UPDATE SET
                   entity_name = EXCLUDED.entity_name,
                   resolved_label = EXCLUDED.resolved_label,
                   link_type = EXCLUDED.link_type,
                   updated_at = EXCLUDED.updated_at
                 RETURNING id`,
                [entity.entityName, entity.sourceUrl, entity.resolvedLabel, entity.linkType, now],
              );
          const entityId = Number(result.rows[0].id);
          const duplicateResult = await client.query<{ id: string }>(
            `SELECT id
             FROM ${table("entities")}
             WHERE lower(entity_name) = lower($1)
             ORDER BY id ASC`,
            [entity.entityName],
          );

          for (const duplicate of duplicateResult.rows) {
            const duplicateId = Number(duplicate.id);
            if (duplicateId !== entityId) {
              await client.query(
                `UPDATE ${table("entities")}
                 SET entity_name = $1,
                     resolved_label = $2,
                     link_type = $3,
                     updated_at = $4
                 WHERE id = $5`,
                [entity.entityName, entity.resolvedLabel, entity.linkType, now, duplicateId],
              );
            }

            await client.query(`DELETE FROM ${table("entity_wallets")} WHERE entity_id = $1`, [duplicateId]);
            for (const [walletIndex, walletAddress] of entity.walletAddresses.entries()) {
              await client.query(
                `INSERT INTO ${table("entity_wallets")} (
                   entity_id, wallet_address, wallet_index, created_at
                 ) VALUES ($1, $2, $3, $4)`,
                [duplicateId, walletAddress, walletIndex, now],
              );
            }
          }
        }
      });
    },

    async getEntities(): Promise<Array<EntityRecord & { wallets: EntityWalletRecord[] }>> {
      const entitiesResult = await getPool().query(
        `SELECT DISTINCT ON (lower(entity_name))
           id, entity_name, full_zapper_link, resolved_label, link_type, created_at, updated_at
         FROM ${table("entities")}
         ORDER BY lower(entity_name), updated_at DESC, id DESC`,
      );
      const entities = entitiesResult.rows.map(mapEntity);
      if (!entities.length) return [];

      const walletResult = await getPool().query(
        `SELECT entity_id, wallet_address, wallet_index
         FROM ${table("entity_wallets")}
         WHERE entity_id = ANY($1::bigint[])
         ORDER BY entity_id ASC, wallet_index ASC`,
        [entities.map((entity) => entity.id)],
      );
      const walletsByEntity = new Map<number, EntityWalletRecord[]>();
      for (const row of walletResult.rows) {
        const entityId = Number(row.entity_id);
        if (!walletsByEntity.has(entityId)) walletsByEntity.set(entityId, []);
        walletsByEntity.get(entityId)!.push({
          entityId,
          walletAddress: row.wallet_address,
          walletIndex: Number(row.wallet_index),
        });
      }

      return entities.map((entity) => ({
        ...entity,
        wallets: walletsByEntity.get(entity.id) || [],
      }));
    },

    async getEntitiesByLinks(sourceUrls: string[]): Promise<Array<EntityRecord & { wallets: EntityWalletRecord[] }>> {
      if (!sourceUrls.length) return [];
      const entitiesResult = await getPool().query(
        `SELECT id, entity_name, full_zapper_link, resolved_label, link_type, created_at, updated_at
         FROM ${table("entities")} WHERE full_zapper_link = ANY($1::text[]) ORDER BY id ASC`,
        [sourceUrls],
      );
      const entities = entitiesResult.rows.map(mapEntity);
      if (!entities.length) return [];
      const walletResult = await getPool().query(
        `SELECT entity_id, wallet_address, wallet_index
         FROM ${table("entity_wallets")}
         WHERE entity_id = ANY($1::bigint[])
         ORDER BY entity_id ASC, wallet_index ASC`,
        [entities.map((entity) => entity.id)],
      );
      const walletsByEntity = new Map<number, EntityWalletRecord[]>();
      for (const row of walletResult.rows) {
        const entityId = Number(row.entity_id);
        if (!walletsByEntity.has(entityId)) walletsByEntity.set(entityId, []);
        walletsByEntity.get(entityId)!.push({
          entityId,
          walletAddress: row.wallet_address,
          walletIndex: Number(row.wallet_index),
        });
      }
      return entities.map((entity) => ({
        ...entity,
        wallets: walletsByEntity.get(entity.id) || [],
      }));
    },

    async createSnapshot(totalEntities: number, providerLabel: string | null): Promise<number> {
      const result = await getPool().query<{ id: string }>(
        `INSERT INTO ${table("holding_snapshots")} (status, zapper_key_label, total_entities, created_at)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        ["running", providerLabel, totalEntities, new Date().toISOString()],
      );
      return Number(result.rows[0].id);
    },

    async updateSnapshot(update: SnapshotUpdate): Promise<void> {
      await getPool().query(
        `UPDATE ${table("holding_snapshots")}
         SET status = COALESCE($2, status),
             entities_completed = COALESCE($3, entities_completed),
             entities_failed = COALESCE($4, entities_failed),
             total_rows = COALESCE($5, total_rows),
             error_message = $6,
             finished_at = $7
         WHERE id = $1`,
        [
          update.id,
          update.status ?? null,
          update.entitiesCompleted ?? null,
          update.entitiesFailed ?? null,
          update.totalRows ?? null,
          update.errorMessage ?? null,
          update.finishedAt ?? null,
        ],
      );
    },

    async insertEntityFetchRun(run: EntityFetchRunRecord): Promise<number> {
      const result = await getPool().query<{ id: string }>(
        `INSERT INTO ${table("entity_fetch_runs")} (
           snapshot_id, entity_id, status, rows_found, total_balance_usd, error_message, started_at, finished_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          run.snapshotId,
          run.entityId,
          run.status,
          run.rowsFound,
          run.totalBalanceUsd,
          run.errorMessage,
          run.startedAt,
          run.finishedAt,
        ],
      );
      return Number(result.rows[0].id);
    },

    async updateEntityFetchRun(id: number, update: Partial<EntityFetchRunRecord>): Promise<void> {
      await getPool().query(
        `UPDATE ${table("entity_fetch_runs")}
         SET status = COALESCE($2, status),
             rows_found = COALESCE($3, rows_found),
             total_balance_usd = COALESCE($4, total_balance_usd),
             error_message = $5,
             finished_at = $6
         WHERE id = $1`,
        [
          id,
          update.status ?? null,
          update.rowsFound ?? null,
          update.totalBalanceUsd ?? null,
          update.errorMessage ?? null,
          update.finishedAt ?? null,
        ],
      );
    },

    async insertRawHoldingsForEntity(snapshotId: number, entityId: number, rows: RawHoldingRecord[]): Promise<void> {
      await withTransaction(async (client) => {
        await client.query(
          `DELETE FROM ${table("raw_holdings")} WHERE snapshot_id = $1 AND entity_id = $2`,
          [snapshotId, entityId],
        );
        if (!rows.length) return;

        const columns = [
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
          "fetched_at",
        ];
        const batchSize = 400;

        for (let start = 0; start < rows.length; start += batchSize) {
          const batch = rows.slice(start, start + batchSize);
          const values: unknown[] = [];
          const placeholders = batch.map((row, rowIndex) => {
            const rowValues = [
              row.snapshotId,
              row.entityId,
              row.tokenKey,
              row.tokenSymbol,
              normalizeRawHoldingTokenName(row),
              row.tokenAddress,
              row.networkName,
              row.chainId,
              row.balance,
              row.balanceRaw,
              row.balanceUsd,
              row.price,
              row.marketCap,
              row.liquidityUsd,
              row.volume24h,
              row.txns24h,
              row.tokenAgeHours,
              row.fetchedAt,
            ];
            values.push(...rowValues);
            const offset = rowIndex * columns.length;
            return `(${columns.map((_, columnIndex) => `$${offset + columnIndex + 1}`).join(", ")})`;
          });

          await client.query(
            `INSERT INTO ${table("raw_holdings")} (${columns.join(", ")})
             VALUES ${placeholders.join(", ")}`,
            values,
          );
        }
      });
    },

    async updateSnapshotTokenMarketData(snapshotId, tokenKey, marketData): Promise<void> {
      await getPool().query(
        `UPDATE ${table("raw_holdings")}
         SET market_cap = COALESCE($3, market_cap),
             liquidity_usd = $4,
             volume_24h = $5,
             txns_24h = $6,
             token_age_hours = $7
         WHERE snapshot_id = $1 AND token_key = $2`,
        [
          snapshotId,
          tokenKey,
          marketData.marketCap,
          marketData.liquidityUsd,
          marketData.volume24h,
          marketData.txns24h,
          marketData.tokenAgeHours,
        ],
      );
    },

    async getSnapshotSummaries(): Promise<SnapshotRecord[]> {
      const result = await getPool().query(
        `SELECT id, status, zapper_key_label, total_entities, entities_completed, entities_failed,
                total_rows,
                (
                  SELECT COUNT(*)
                  FROM ${table("raw_holdings")} rh
                  WHERE rh.snapshot_id = hs.id
                    AND rh.chain_id = 1151111081
                ) as solana_rows,
                (
                  SELECT COUNT(*)
                  FROM ${table("raw_holdings")} rh
                  WHERE rh.snapshot_id = hs.id
                    AND (rh.chain_id IS NULL OR rh.chain_id <> 1151111081)
                ) as non_solana_rows,
                error_message, created_at, finished_at
         FROM ${table("holding_snapshots")} hs
         ORDER BY id DESC`,
      );
      return result.rows.map(mapSnapshot);
    },

    async getLatestSnapshot(): Promise<SnapshotRecord | null> {
      const result = await getPool().query(
        `SELECT id, status, zapper_key_label, total_entities, entities_completed, entities_failed,
                total_rows,
                (
                  SELECT COUNT(*)
                  FROM ${table("raw_holdings")} rh
                  WHERE rh.snapshot_id = hs.id
                    AND rh.chain_id = 1151111081
                ) as solana_rows,
                (
                  SELECT COUNT(*)
                  FROM ${table("raw_holdings")} rh
                  WHERE rh.snapshot_id = hs.id
                    AND (rh.chain_id IS NULL OR rh.chain_id <> 1151111081)
                ) as non_solana_rows,
                error_message, created_at, finished_at
         FROM ${table("holding_snapshots")} hs
         ORDER BY id DESC
         LIMIT 1`,
      );
      return result.rows[0] ? mapSnapshot(result.rows[0]) : null;
    },

    async getSnapshotTokensForEnrichment(snapshotId: number, minBalanceUsd = 111, minSmwIn = 1): Promise<SnapshotTokenForEnrichment[]> {
      const result = await getPool().query(
        `WITH canonical_holdings AS (
           SELECT
             rh.token_key,
             lower(e.entity_name) as entity_key,
             MAX(rh.token_symbol) as token_symbol,
             MAX(rh.token_name) as token_name,
             MAX(rh.token_address) as token_address,
             MAX(rh.network_name) as network_name,
             MAX(rh.chain_id) as chain_id,
             MAX(rh.balance_usd) as balance_usd
           FROM ${table("raw_holdings")} rh
           INNER JOIN ${table("entities")} e ON e.id = rh.entity_id
           WHERE rh.snapshot_id = $1
             AND rh.balance_usd >= $2
           GROUP BY rh.token_key, lower(e.entity_name)
         )
         SELECT
            token_key,
            MAX(token_symbol) as token_symbol,
            MAX(token_name) as token_name,
            MAX(token_address) as token_address,
            MAX(network_name) as network_name,
            MAX(chain_id) as chain_id,
            COUNT(*) as smw_in,
            ROUND(SUM(balance_usd)::numeric, 2) as holdings_usd
         FROM canonical_holdings
         GROUP BY token_key
         HAVING COUNT(*) >= $3
         ORDER BY smw_in DESC, holdings_usd DESC, token_symbol ASC`,
        [snapshotId, minBalanceUsd, minSmwIn],
      );

      return result.rows.map((row) => ({
        tokenKey: row.token_key,
        tokenSymbol: row.token_symbol,
        tokenName: row.token_name,
        tokenAddress: row.token_address,
        networkName: row.network_name,
        chainId: numberOrNull(row.chain_id),
        smwIn: Number(row.smw_in || 0),
        holdingsUsd: Number(row.holdings_usd || 0),
      }));
    },

    async getOverview(
      snapshotId: number,
      minBalanceUsd = 111,
      minSmwIn = 1,
      minLiquidityUsd = 11111,
      maxMarketCapUsd: number | null = null,
      favoriteEntityNames: string[] = [],
    ): Promise<TokenOverviewRow[]> {
      const favoriteEntityKeys = normalizeFavoriteEntityKeys(favoriteEntityNames);
      const result = await getPool().query(
        `WITH canonical_holdings AS (
           SELECT
             rh.token_key,
             lower(e.entity_name) as entity_key,
             MAX(e.entity_name) as entity_name,
             BOOL_OR(lower(e.entity_name) = ANY($6::text[])) as is_favorite_entity,
             MAX(rh.token_symbol) as token_symbol,
             MAX(rh.token_name) as token_name,
             MAX(rh.network_name) as network_name,
             MAX(rh.chain_id) as chain_id,
             MAX(rh.token_address) as token_address,
             MAX(rh.balance_usd) as balance_usd,
             MAX(NULLIF(regexp_replace(trim(rh.balance), '([^0-9eE+.-]).*$', ''), '')::numeric) as token_amount,
             MAX(rh.market_cap) as market_cap,
             MAX(rh.token_age_hours) as token_age_hours,
             MAX(rh.volume_24h) as volume_24h,
             MAX(rh.txns_24h) as txns_24h,
             MAX(rh.liquidity_usd) as liquidity_usd
           FROM ${table("raw_holdings")} rh
           INNER JOIN ${table("entities")} e ON e.id = rh.entity_id
           LEFT JOIN ${table("token_blacklist")} bl
             ON bl.token_key = rh.token_key AND bl.is_active = true
           WHERE rh.snapshot_id = $1
             AND rh.balance_usd >= $2
             AND bl.id IS NULL
           GROUP BY rh.token_key, lower(e.entity_name)
         ),
         token_rollup AS (
           SELECT
              token_key,
              MAX(token_symbol) as token_symbol,
              MAX(token_name) as token_name,
              MAX(network_name) as network_name,
              MAX(chain_id) as chain_id,
              MAX(token_address) as token_address,
              ROUND(SUM(balance_usd)::numeric, 2) as holdings_usd,
              SUM(token_amount) as token_amount,
              COUNT(*) as smw_in,
              COUNT(*) FILTER (WHERE is_favorite_entity) as favorite_entity_count,
              ROUND(COALESCE(SUM(balance_usd) FILTER (WHERE is_favorite_entity), 0)::numeric, 2) as favorite_holdings_usd,
              COALESCE(ARRAY_AGG(entity_name ORDER BY entity_name) FILTER (WHERE is_favorite_entity), ARRAY[]::text[]) as favorite_entity_names,
              MAX(market_cap) as market_cap,
              MAX(token_age_hours) as token_age_hours,
              MAX(volume_24h) as volume_24h,
              MAX(txns_24h) as txns_24h,
              MAX(liquidity_usd) as liquidity_usd
           FROM canonical_holdings
           GROUP BY token_key
           HAVING COUNT(*) >= $3
             AND (
               MAX(CASE WHEN token_address IS NOT NULL THEN liquidity_usd END) IS NULL
               OR MAX(CASE WHEN token_address IS NOT NULL THEN liquidity_usd END) >= $4
             )
             AND (
               MAX(CASE WHEN token_address IS NOT NULL THEN volume_24h END) IS NULL
               OR MAX(CASE WHEN token_address IS NOT NULL THEN volume_24h END) >= 1000
             )
             AND (
               MAX(CASE WHEN token_address IS NOT NULL THEN txns_24h END) IS NULL
               OR MAX(CASE WHEN token_address IS NOT NULL THEN txns_24h END) >= 11
             )
             AND (
               $5::numeric IS NULL
               OR MAX(market_cap) IS NULL
               OR MAX(market_cap) < $5
             )
         )
         SELECT
            tr.token_key,
            tr.token_symbol,
            tr.token_name,
            tr.network_name,
            tr.chain_id,
            tr.token_address,
            tr.holdings_usd,
            tr.token_amount,
            tr.smw_in,
            tr.favorite_entity_count,
            tr.favorite_holdings_usd,
            tr.favorite_entity_names,
            tr.market_cap,
            tr.token_age_hours,
            tr.volume_24h,
            tr.txns_24h,
            tr.liquidity_usd
         FROM token_rollup tr
         ORDER BY tr.smw_in DESC, tr.holdings_usd DESC, tr.token_symbol ASC`,
        [snapshotId, minBalanceUsd, minSmwIn, minLiquidityUsd, maxMarketCapUsd, favoriteEntityKeys],
      );
      const convictionByToken = await getEntityConvictionByToken(snapshotId, minBalanceUsd);
      const mappedRows = result.rows.map((row) => ({
        ...mapOverview(row),
        entityConviction: convictionByToken.get(row.token_key) || 1,
      }));
      const snapshotResult = await getPool().query(
        `SELECT COALESCE(finished_at, created_at) as at FROM ${table("holding_snapshots")} WHERE id = $1`,
        [snapshotId],
      );
      const currentAt = snapshotResult.rows[0]?.at instanceof Date
        ? snapshotResult.rows[0].at.toISOString()
        : String(snapshotResult.rows[0]?.at || new Date().toISOString());
      const previousByToken = await getPreviousScoreSamples(snapshotId, minBalanceUsd, favoriteEntityKeys);
      return mappedRows.map((row) => {
        const previous = previousByToken.get(row.tokenKey) || [];
        const context: ScoreContext = {
          currentAt,
          previous: previous[0],
          previousPrevious: previous[1],
          entityConviction: row.entityConviction,
        };
        return withOpportunityScore(row, context);
      });
    },

    async getTokenHolders(snapshotId: number, tokenKey: string, minBalanceUsd = 111): Promise<TokenHolderRow[]> {
      const result = await getPool().query(
        `SELECT
           MIN(e.id) as entity_id,
           MAX(e.entity_name) as entity_name,
           MAX(e.resolved_label) as resolved_label,
           MAX(rh.balance_usd) as balance_usd,
           MAX(rh.network_name) as network_name,
           MAX(rh.token_symbol) as token_symbol,
           MAX(rh.token_name) as token_name
         FROM ${table("raw_holdings")} rh
         INNER JOIN ${table("entities")} e ON e.id = rh.entity_id
         WHERE rh.snapshot_id = $1
           AND rh.token_key = $2
           AND rh.balance_usd >= $3
         GROUP BY lower(e.entity_name)
         ORDER BY MAX(rh.balance_usd) DESC, MAX(e.entity_name) ASC`,
        [snapshotId, tokenKey, minBalanceUsd],
      );

      return result.rows.map((row) => ({
        entityId: Number(row.entity_id),
        entityName: row.entity_name,
        resolvedLabel: row.resolved_label,
        balanceUsd: Number(row.balance_usd || 0),
        networkName: row.network_name,
        tokenSymbol: row.token_symbol,
        tokenName: row.token_name,
      }));
    },

    async getTokenScoreHistory(tokenKey: string, minBalanceUsd = 111, favoriteEntityNames: string[] = [], limit: number | null = null): Promise<TokenScorePoint[]> {
      const favoriteEntityKeys = normalizeFavoriteEntityKeys(favoriteEntityNames);
      const historyLimit = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.min(100, Math.trunc(Number(limit))) : null;
      const queryLimit = historyLimit == null ? null : historyLimit + 2;
      const historyOrder = queryLimit == null ? "ASC" : "DESC";
      const historyLimitClause = queryLimit == null ? "" : "LIMIT $4";
      const result = await getPool().query(
        `WITH canonical_holdings AS (
           SELECT
             rh.snapshot_id,
             rh.token_key,
             lower(e.entity_name) as entity_key,
             BOOL_OR(lower(e.entity_name) = ANY($3::text[])) as is_favorite,
             MAX(rh.token_symbol) as token_symbol,
             MAX(rh.token_name) as token_name,
             MAX(rh.network_name) as network_name,
             MAX(rh.chain_id) as chain_id,
             MAX(rh.token_address) as token_address,
             MAX(rh.balance_usd) as balance_usd,
             MAX(NULLIF(regexp_replace(trim(rh.balance), '([^0-9eE+.-]).*$', ''), '')::numeric) as token_amount,
             MAX(rh.market_cap) as market_cap,
             MAX(rh.token_age_hours) as token_age_hours,
             MAX(rh.volume_24h) as volume_24h,
             MAX(rh.txns_24h) as txns_24h,
             MAX(rh.liquidity_usd) as liquidity_usd
           FROM ${table("raw_holdings")} rh
           INNER JOIN ${table("entities")} e ON e.id = rh.entity_id
           WHERE rh.token_key = $1
             AND rh.balance_usd >= $2
           GROUP BY rh.snapshot_id, rh.token_key, lower(e.entity_name)
         )
         SELECT
            hs.id as "snapshotId",
            hs.status as "snapshotStatus",
            hs.created_at as "snapshotCreatedAt",
            hs.finished_at as "snapshotFinishedAt",
            ch.token_key as "tokenKey",
            MAX(ch.token_symbol) as "tokenSymbol",
            MAX(ch.token_name) as "tokenName",
            MAX(ch.network_name) as "networkName",
            MAX(ch.chain_id) as "chainId",
            MAX(ch.token_address) as "tokenAddress",
            ROUND(SUM(ch.balance_usd)::numeric, 2) as "holdingsUsd",
            SUM(ch.token_amount) as "tokenAmount",
            COUNT(*) as "smwIn",
            COUNT(*) FILTER (WHERE ch.is_favorite) as "favoriteEntityCount",
            ROUND(COALESCE(SUM(ch.balance_usd) FILTER (WHERE ch.is_favorite), 0)::numeric, 2) as "favoriteHoldingsUsd",
            MAX(ch.market_cap) as "marketCap",
            MAX(ch.token_age_hours) as "tokenAgeHours",
            MAX(ch.volume_24h) as "volume24h",
            MAX(ch.txns_24h) as "txns24h",
            MAX(ch.liquidity_usd) as "liquidityUsd"
         FROM canonical_holdings ch
         INNER JOIN ${table("holding_snapshots")} hs ON hs.id = ch.snapshot_id
         WHERE ch.token_key = $1
           AND hs.status IN ('success', 'partial')
         GROUP BY hs.id, ch.token_key
         ORDER BY COALESCE(hs.finished_at, hs.created_at) ${historyOrder}, hs.id ${historyOrder}
         ${historyLimitClause}`,
        queryLimit == null ? [tokenKey, minBalanceUsd, favoriteEntityKeys] : [tokenKey, minBalanceUsd, favoriteEntityKeys, queryLimit],
      );

      const rows = result.rows.map((row) => ({
        ...row,
        snapshotId: Number(row.snapshotId),
        snapshotCreatedAt: row.snapshotCreatedAt instanceof Date ? row.snapshotCreatedAt.toISOString() : String(row.snapshotCreatedAt),
        snapshotFinishedAt: row.snapshotFinishedAt instanceof Date ? row.snapshotFinishedAt.toISOString() : row.snapshotFinishedAt ? String(row.snapshotFinishedAt) : null,
        chainId: numberOrNull(row.chainId),
        holdingsUsd: Number(row.holdingsUsd || 0),
        tokenAmount: Number(row.tokenAmount || 0),
        smwIn: Number(row.smwIn || 0),
        favoriteEntityCount: Number(row.favoriteEntityCount || 0),
        favoriteHoldingsUsd: Number(row.favoriteHoldingsUsd || 0),
        marketCap: numberOrNull(row.marketCap),
        tokenAgeHours: numberOrNull(row.tokenAgeHours),
        volume24h: numberOrNull(row.volume24h),
        txns24h: numberOrNull(row.txns24h),
        liquidityUsd: numberOrNull(row.liquidityUsd),
      })) as Array<Omit<TokenScorePoint, "score">>;
      if (queryLimit != null) rows.reverse();
      const convictionBySnapshot = await getEntityConvictionForTokenAtSnapshots(
        [...new Set(rows.map((row) => row.snapshotId))],
        tokenKey,
        minBalanceUsd,
      );
      let previous: ScoreHistorySample | undefined;
      let previousPrevious: ScoreHistorySample | undefined;
      const scoredRows: TokenScorePoint[] = [];
      for (const row of rows) {
        const normalized = {
          ...row,
          entityConviction: convictionBySnapshot.get(row.snapshotId) || 1,
          favoriteEntityNames: [],
        };
        scoredRows.push(withOpportunityScore(normalized, {
          currentAt: row.snapshotFinishedAt || row.snapshotCreatedAt,
          previous,
          previousPrevious,
          entityConviction: normalized.entityConviction,
        }) as TokenScorePoint);
        if (row.snapshotStatus === "success") {
          previousPrevious = previous;
          previous = {
            tokenAmount: row.tokenAmount,
            holdingsUsd: row.holdingsUsd,
            smwIn: row.smwIn,
            favoriteEntityCount: Number(row.favoriteEntityCount || 0),
            favoriteHoldingsUsd: Number(row.favoriteHoldingsUsd || 0),
            at: row.snapshotFinishedAt || row.snapshotCreatedAt,
          };
        }
      }
      return historyLimit == null ? scoredRows : scoredRows.slice(-historyLimit);
    },

    async upsertBlacklist(input): Promise<void> {
      const now = new Date().toISOString();
      await getPool().query(
        `INSERT INTO ${table("token_blacklist")} (
           token_key, token_symbol, token_name, network_name, chain_id, token_address, reason, is_active, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, $8)
         ON CONFLICT (token_key) DO UPDATE SET
           token_symbol = EXCLUDED.token_symbol,
           token_name = EXCLUDED.token_name,
           network_name = EXCLUDED.network_name,
           chain_id = EXCLUDED.chain_id,
           token_address = EXCLUDED.token_address,
           reason = EXCLUDED.reason,
           is_active = true,
           updated_at = EXCLUDED.updated_at`,
        [
          input.tokenKey,
          input.tokenSymbol,
          input.tokenName,
          input.networkName,
          input.chainId,
          input.tokenAddress,
          input.reason,
          now,
        ],
      );
    },

    async restoreBlacklist(id: number): Promise<void> {
      await getPool().query(
        `UPDATE ${table("token_blacklist")}
         SET is_active = false, updated_at = $2
         WHERE id = $1`,
        [id, new Date().toISOString()],
      );
    },

    async getBlacklist(): Promise<TokenBlacklistRecord[]> {
      const result = await getPool().query(
        `SELECT id, token_key, token_symbol, token_name, network_name, chain_id, token_address,
                reason, is_active, created_at, updated_at
         FROM ${table("token_blacklist")}
         WHERE is_active = true
         ORDER BY updated_at DESC, token_symbol ASC`,
      );
      return result.rows.map((row) => ({
        id: Number(row.id),
        tokenKey: row.token_key,
        tokenSymbol: row.token_symbol,
        tokenName: row.token_name,
        networkName: row.network_name,
        chainId: numberOrNull(row.chain_id),
        tokenAddress: row.token_address,
        reason: row.reason,
        isActive: Boolean(row.is_active),
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
        updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
      }));
    },
  };
}

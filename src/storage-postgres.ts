import { Pool, PoolClient } from "pg";
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
} from "./types";
import { SnapshotTokenForEnrichment, SnapshotUpdate, StorageAdapter } from "./storage-types";

let sharedPool: Pool | null = null;

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
    zapperKeyLabel: row.zapper_key_label,
    totalEntities: Number(row.total_entities),
    entitiesCompleted: Number(row.entities_completed),
    entitiesFailed: Number(row.entities_failed),
    totalRows: Number(row.total_rows),
    errorMessage: row.error_message,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    finishedAt: row.finished_at ? (row.finished_at instanceof Date ? row.finished_at.toISOString() : String(row.finished_at)) : null,
  };
}

function mapEntity(row: any): EntityRecord {
  return {
    id: Number(row.id),
    entityName: row.entity_name,
    fullZapperLink: row.full_zapper_link,
    resolvedLabel: row.resolved_label,
    linkType: row.link_type,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}

function mapOverview(row: any): TokenOverviewRow {
  return {
    tokenKey: row.token_key,
    tokenSymbol: row.token_symbol,
    tokenName: row.token_name,
    networkName: row.network_name,
    chainId: numberOrNull(row.chain_id),
    tokenAddress: row.token_address,
    holdingsUsd: Number(row.holdings_usd || 0),
    smwIn: Number(row.smw_in || 0),
    marketCap: numberOrNull(row.market_cap),
    tokenAgeHours: numberOrNull(row.token_age_hours),
    moniScore: numberOrNull(row.moni_score),
    moniLevel: numberOrNull(row.moni_level),
    moniLevelName: row.moni_level_name,
    moniMomentumScorePct: numberOrNull(row.moni_momentum_score_pct),
    moniMomentumRank: numberOrNull(row.moni_momentum_rank),
    volume24h: numberOrNull(row.volume_24h),
    txns24h: numberOrNull(row.txns_24h),
  };
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
          const result = await client.query<{ id: string }>(
            `INSERT INTO ${table("entities")} (
               entity_name, full_zapper_link, resolved_label, link_type, created_at, updated_at
             ) VALUES ($1, $2, $3, $4, $5, $5)
             ON CONFLICT (full_zapper_link) DO UPDATE SET
               entity_name = EXCLUDED.entity_name,
               resolved_label = EXCLUDED.resolved_label,
               link_type = EXCLUDED.link_type,
               updated_at = EXCLUDED.updated_at
             RETURNING id`,
            [entity.entityName, entity.fullZapperLink, entity.resolvedLabel, entity.linkType, now],
          );
          const entityId = Number(result.rows[0].id);
          await client.query(`DELETE FROM ${table("entity_wallets")} WHERE entity_id = $1`, [entityId]);

          for (const [walletIndex, walletAddress] of entity.walletAddresses.entries()) {
            await client.query(
              `INSERT INTO ${table("entity_wallets")} (
                 entity_id, wallet_address, wallet_index, created_at
               ) VALUES ($1, $2, $3, $4)`,
              [entityId, walletAddress, walletIndex, now],
            );
          }
        }
      });
    },

    async getEntities(): Promise<Array<EntityRecord & { wallets: EntityWalletRecord[] }>> {
      const entitiesResult = await getPool().query(
        `SELECT id, entity_name, full_zapper_link, resolved_label, link_type, created_at, updated_at
         FROM ${table("entities")}
         ORDER BY entity_name ASC`,
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

    async createSnapshot(totalEntities: number, zapperKeyLabel: string | null): Promise<number> {
      const result = await getPool().query<{ id: string }>(
        `INSERT INTO ${table("holding_snapshots")} (status, zapper_key_label, total_entities, created_at)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        ["running", zapperKeyLabel, totalEntities, new Date().toISOString()],
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
          "moni_score",
          "moni_level",
          "moni_level_name",
          "moni_momentum_score_pct",
          "moni_momentum_rank",
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
              row.tokenName,
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
              row.moniScore,
              row.moniLevel,
              row.moniLevelName,
              row.moniMomentumScorePct,
              row.moniMomentumRank,
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
         SET market_cap = $3,
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

    async updateSnapshotTokenMoniData(snapshotId, tokenKey, moniData): Promise<void> {
      await getPool().query(
        `UPDATE ${table("raw_holdings")}
         SET moni_score = $3,
             moni_level = $4,
             moni_level_name = $5,
             moni_momentum_score_pct = $6,
             moni_momentum_rank = $7
         WHERE snapshot_id = $1 AND token_key = $2`,
        [
          snapshotId,
          tokenKey,
          moniData.moniScore,
          moniData.moniLevel,
          moniData.moniLevelName,
          moniData.moniMomentumScorePct,
          moniData.moniMomentumRank,
        ],
      );
    },

    async getSnapshotSummaries(): Promise<SnapshotRecord[]> {
      const result = await getPool().query(
        `SELECT id, status, zapper_key_label, total_entities, entities_completed, entities_failed,
                total_rows, error_message, created_at, finished_at
         FROM ${table("holding_snapshots")}
         ORDER BY id DESC`,
      );
      return result.rows.map(mapSnapshot);
    },

    async getLatestSnapshot(): Promise<SnapshotRecord | null> {
      const result = await getPool().query(
        `SELECT id, status, zapper_key_label, total_entities, entities_completed, entities_failed,
                total_rows, error_message, created_at, finished_at
         FROM ${table("holding_snapshots")}
         ORDER BY id DESC
         LIMIT 1`,
      );
      return result.rows[0] ? mapSnapshot(result.rows[0]) : null;
    },

    async getSnapshotTokensForEnrichment(snapshotId: number, minBalanceUsd = 111, minSmwIn = 1): Promise<SnapshotTokenForEnrichment[]> {
      const result = await getPool().query(
        `SELECT
            rh.token_key,
            MAX(rh.token_symbol) as token_symbol,
            MAX(rh.token_name) as token_name,
            MAX(rh.token_address) as token_address,
            MAX(rh.network_name) as network_name,
            MAX(rh.chain_id) as chain_id,
            COUNT(DISTINCT rh.entity_id) as smw_in,
            ROUND(SUM(rh.balance_usd), 2) as holdings_usd
         FROM ${table("raw_holdings")} rh
         WHERE rh.snapshot_id = $1
           AND rh.balance_usd >= $2
         GROUP BY rh.token_key
         HAVING COUNT(DISTINCT rh.entity_id) >= $3
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

    async getOverview(snapshotId: number, minBalanceUsd = 111, minSmwIn = 1, minLiquidityUsd = 11111): Promise<TokenOverviewRow[]> {
      const result = await getPool().query(
        `SELECT
            rh.token_key,
            MAX(rh.token_symbol) as token_symbol,
            MAX(rh.token_name) as token_name,
            MAX(rh.network_name) as network_name,
            MAX(rh.chain_id) as chain_id,
            MAX(rh.token_address) as token_address,
            ROUND(SUM(rh.balance_usd), 2) as holdings_usd,
            COUNT(DISTINCT rh.entity_id) as smw_in,
            MAX(rh.market_cap) as market_cap,
            MAX(rh.token_age_hours) as token_age_hours,
            MAX(rh.moni_score) as moni_score,
            MAX(rh.moni_level) as moni_level,
            MAX(rh.moni_level_name) as moni_level_name,
            MAX(rh.moni_momentum_score_pct) as moni_momentum_score_pct,
            MAX(rh.moni_momentum_rank) as moni_momentum_rank,
            MAX(rh.volume_24h) as volume_24h,
            MAX(rh.txns_24h) as txns_24h
         FROM ${table("raw_holdings")} rh
         LEFT JOIN ${table("token_blacklist")} bl
           ON bl.token_key = rh.token_key AND bl.is_active = true
         WHERE rh.snapshot_id = $1
           AND rh.balance_usd >= $2
           AND bl.id IS NULL
         GROUP BY rh.token_key
         HAVING COUNT(DISTINCT rh.entity_id) >= $3
           AND (
             MAX(CASE WHEN rh.token_address IS NOT NULL THEN rh.liquidity_usd END) IS NULL
             OR MAX(CASE WHEN rh.token_address IS NOT NULL THEN rh.liquidity_usd END) >= $4
           )
           AND (
             MAX(CASE WHEN rh.token_address IS NOT NULL THEN rh.volume_24h END) IS NULL
             OR MAX(CASE WHEN rh.token_address IS NOT NULL THEN rh.volume_24h END) >= 1000
           )
           AND (
             MAX(CASE WHEN rh.token_address IS NOT NULL THEN rh.txns_24h END) IS NULL
             OR MAX(CASE WHEN rh.token_address IS NOT NULL THEN rh.txns_24h END) >= 11
           )
         ORDER BY smw_in DESC, holdings_usd DESC, token_symbol ASC`,
        [snapshotId, minBalanceUsd, minSmwIn, minLiquidityUsd],
      );
      return result.rows.map(mapOverview);
    },

    async getTokenHolders(snapshotId: number, tokenKey: string, minBalanceUsd = 111): Promise<TokenHolderRow[]> {
      const result = await getPool().query(
        `SELECT
           e.id as entity_id,
           e.entity_name,
           e.resolved_label,
           rh.balance_usd,
           rh.network_name,
           rh.token_symbol,
           rh.token_name
         FROM ${table("raw_holdings")} rh
         INNER JOIN ${table("entities")} e ON e.id = rh.entity_id
         WHERE rh.snapshot_id = $1
           AND rh.token_key = $2
           AND rh.balance_usd >= $3
         ORDER BY rh.balance_usd DESC, e.entity_name ASC`,
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

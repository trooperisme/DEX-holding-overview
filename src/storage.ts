import { resolveWorkspacePaths } from "./runtime-paths";
import { createPostgresStorage } from "./storage-postgres";
import { SnapshotTokenForEnrichment, SnapshotUpdate, StorageAdapter } from "./storage-types";
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

export function createStorage(cwd: string): StorageAdapter {
  if (process.env.DATABASE_URL?.trim()) {
    return createPostgresStorage();
  }

  return createSqliteStorage(cwd);
}

function createSqliteStorage(cwd: string): StorageAdapter {
  const Database = require("better-sqlite3") as typeof import("better-sqlite3");
  const paths = resolveWorkspacePaths(cwd);
  const db = new Database(paths.dbFile);

  function ensureColumn(tableName: string, columnName: string, definition: string): void {
    const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === columnName)) {
      db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
    }
  }

  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_name TEXT NOT NULL,
      full_zapper_link TEXT NOT NULL UNIQUE,
      resolved_label TEXT,
      link_type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS entity_wallets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id INTEGER NOT NULL,
      wallet_address TEXT NOT NULL,
      wallet_index INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE,
      UNIQUE(entity_id, wallet_address)
    );

    CREATE TABLE IF NOT EXISTS holding_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL,
      zapper_key_label TEXT,
      total_entities INTEGER NOT NULL DEFAULT 0,
      entities_completed INTEGER NOT NULL DEFAULT 0,
      entities_failed INTEGER NOT NULL DEFAULT 0,
      total_rows INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      created_at TEXT NOT NULL,
      finished_at TEXT
    );

    CREATE TABLE IF NOT EXISTS entity_fetch_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id INTEGER NOT NULL,
      entity_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      rows_found INTEGER NOT NULL DEFAULT 0,
      total_balance_usd REAL NOT NULL DEFAULT 0,
      error_message TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      FOREIGN KEY (snapshot_id) REFERENCES holding_snapshots(id) ON DELETE CASCADE,
      FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS raw_holdings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id INTEGER NOT NULL,
      entity_id INTEGER NOT NULL,
      token_key TEXT NOT NULL,
      token_symbol TEXT NOT NULL,
      token_name TEXT NOT NULL,
      token_address TEXT,
      network_name TEXT NOT NULL,
      chain_id INTEGER,
      balance TEXT NOT NULL,
      balance_raw TEXT NOT NULL,
      balance_usd REAL NOT NULL,
      price REAL,
      market_cap REAL,
      liquidity_usd REAL,
      volume_24h REAL,
      txns_24h REAL,
      token_age_hours REAL,
      fetched_at TEXT NOT NULL,
      FOREIGN KEY (snapshot_id) REFERENCES holding_snapshots(id) ON DELETE CASCADE,
      FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS token_blacklist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_key TEXT NOT NULL UNIQUE,
      token_symbol TEXT NOT NULL,
      token_name TEXT NOT NULL,
      network_name TEXT NOT NULL,
      chain_id INTEGER,
      token_address TEXT,
      reason TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_entity_wallets_entity ON entity_wallets(entity_id, wallet_index);
    CREATE INDEX IF NOT EXISTS idx_raw_holdings_snapshot ON raw_holdings(snapshot_id, token_key, balance_usd DESC);
    CREATE INDEX IF NOT EXISTS idx_snapshot_created ON holding_snapshots(created_at DESC, id DESC);
  `);

  ensureColumn("raw_holdings", "market_cap", "REAL");
  ensureColumn("raw_holdings", "liquidity_usd", "REAL");
  ensureColumn("raw_holdings", "volume_24h", "REAL");
  ensureColumn("raw_holdings", "txns_24h", "REAL");
  ensureColumn("raw_holdings", "token_age_hours", "REAL");
  ensureColumn("raw_holdings", "moni_score", "REAL");
  ensureColumn("raw_holdings", "moni_level", "INTEGER");
  ensureColumn("raw_holdings", "moni_level_name", "TEXT");
  ensureColumn("raw_holdings", "moni_momentum_score_pct", "REAL");
  ensureColumn("raw_holdings", "moni_momentum_rank", "INTEGER");

  const upsertEntity = db.prepare(`
    INSERT INTO entities (entity_name, full_zapper_link, resolved_label, link_type, created_at, updated_at)
    VALUES (@entityName, @fullZapperLink, @resolvedLabel, @linkType, @createdAt, @updatedAt)
    ON CONFLICT(full_zapper_link) DO UPDATE SET
      entity_name = excluded.entity_name,
      resolved_label = excluded.resolved_label,
      link_type = excluded.link_type,
      updated_at = excluded.updated_at
    RETURNING id
  `);

  const clearWalletsForEntity = db.prepare(`DELETE FROM entity_wallets WHERE entity_id = ?`);
  const insertWallet = db.prepare(`
    INSERT INTO entity_wallets (entity_id, wallet_address, wallet_index, created_at)
    VALUES (@entityId, @walletAddress, @walletIndex, @createdAt)
  `);

  const insertSnapshot = db.prepare(`
    INSERT INTO holding_snapshots (status, zapper_key_label, total_entities, created_at)
    VALUES (@status, @zapperKeyLabel, @totalEntities, @createdAt)
  `);

  const updateSnapshotStmt = db.prepare(`
    UPDATE holding_snapshots
    SET status = COALESCE(@status, status),
        entities_completed = COALESCE(@entitiesCompleted, entities_completed),
        entities_failed = COALESCE(@entitiesFailed, entities_failed),
        total_rows = COALESCE(@totalRows, total_rows),
        error_message = @errorMessage,
        finished_at = @finishedAt
    WHERE id = @id
  `);

  const insertFetchRunStmt = db.prepare(`
    INSERT INTO entity_fetch_runs (
      snapshot_id, entity_id, status, rows_found, total_balance_usd, error_message, started_at, finished_at
    ) VALUES (
      @snapshotId, @entityId, @status, @rowsFound, @totalBalanceUsd, @errorMessage, @startedAt, @finishedAt
    )
  `);

  const updateFetchRunStmt = db.prepare(`
    UPDATE entity_fetch_runs
    SET status = COALESCE(@status, status),
        rows_found = COALESCE(@rowsFound, rows_found),
        total_balance_usd = COALESCE(@totalBalanceUsd, total_balance_usd),
        error_message = @errorMessage,
        finished_at = @finishedAt
    WHERE id = @id
  `);

  const deleteRawForSnapshotEntity = db.prepare(`
    DELETE FROM raw_holdings WHERE snapshot_id = ? AND entity_id = ?
  `);

  const insertRawHoldingStmt = db.prepare(`
    INSERT INTO raw_holdings (
      snapshot_id, entity_id, token_key, token_symbol, token_name, token_address, network_name,
      chain_id, balance, balance_raw, balance_usd, price, market_cap, liquidity_usd, volume_24h, txns_24h,
      token_age_hours, moni_score, moni_level, moni_level_name, moni_momentum_score_pct, moni_momentum_rank, fetched_at
    ) VALUES (
      @snapshotId, @entityId, @tokenKey, @tokenSymbol, @tokenName, @tokenAddress, @networkName,
      @chainId, @balance, @balanceRaw, @balanceUsd, @price, @marketCap, @liquidityUsd, @volume24h, @txns24h,
      @tokenAgeHours, @moniScore, @moniLevel, @moniLevelName, @moniMomentumScorePct, @moniMomentumRank, @fetchedAt
    )
  `);

  const updateMarketDataForTokenStmt = db.prepare(`
    UPDATE raw_holdings
    SET market_cap = @marketCap,
        liquidity_usd = @liquidityUsd,
        volume_24h = @volume24h,
        txns_24h = @txns24h,
        token_age_hours = @tokenAgeHours
    WHERE snapshot_id = @snapshotId
      AND token_key = @tokenKey
  `);

  const updateMoniDataForTokenStmt = db.prepare(`
    UPDATE raw_holdings
    SET moni_score = @moniScore,
        moni_level = @moniLevel,
        moni_level_name = @moniLevelName,
        moni_momentum_score_pct = @moniMomentumScorePct,
        moni_momentum_rank = @moniMomentumRank
    WHERE snapshot_id = @snapshotId
      AND token_key = @tokenKey
  `);

  const blacklistUpsertStmt = db.prepare(`
    INSERT INTO token_blacklist (
      token_key, token_symbol, token_name, network_name, chain_id, token_address, reason, is_active, created_at, updated_at
    ) VALUES (
      @tokenKey, @tokenSymbol, @tokenName, @networkName, @chainId, @tokenAddress, @reason, 1, @createdAt, @updatedAt
    )
    ON CONFLICT(token_key) DO UPDATE SET
      token_symbol = excluded.token_symbol,
      token_name = excluded.token_name,
      network_name = excluded.network_name,
      chain_id = excluded.chain_id,
      token_address = excluded.token_address,
      reason = excluded.reason,
      is_active = 1,
      updated_at = excluded.updated_at
  `);

  const restoreBlacklistStmt = db.prepare(`
    UPDATE token_blacklist
    SET is_active = 0, updated_at = @updatedAt
    WHERE id = @id
  `);

  const replaceEntities = db.transaction((entities: ImportedEntity[]) => {
    const now = new Date().toISOString();
    for (const entity of entities) {
      const result = upsertEntity.get({
        entityName: entity.entityName,
        fullZapperLink: entity.fullZapperLink,
        resolvedLabel: entity.resolvedLabel,
        linkType: entity.linkType,
        createdAt: now,
        updatedAt: now,
      }) as { id: number };

      clearWalletsForEntity.run(result.id);
      entity.walletAddresses.forEach((walletAddress, walletIndex) => {
        insertWallet.run({
          entityId: result.id,
          walletAddress,
          walletIndex,
          createdAt: now,
        });
      });
    }
  });

  const insertRawHoldingsForEntity = db.transaction((snapshotId: number, entityId: number, rows: RawHoldingRecord[]) => {
    deleteRawForSnapshotEntity.run(snapshotId, entityId);
    for (const row of rows) {
      insertRawHoldingStmt.run(row);
    }
  });

  return {
    close(): void {
      db.close();
    },

    replaceEntities,

    getEntities(): Array<EntityRecord & { wallets: EntityWalletRecord[] }> {
      const entities = db
        .prepare(
          `SELECT id, entity_name as entityName, full_zapper_link as fullZapperLink,
                  resolved_label as resolvedLabel, link_type as linkType,
                  created_at as createdAt, updated_at as updatedAt
           FROM entities
           ORDER BY entity_name COLLATE NOCASE ASC`,
        )
        .all() as EntityRecord[];

      const walletsStmt = db.prepare(
        `SELECT entity_id as entityId, wallet_address as walletAddress, wallet_index as walletIndex
         FROM entity_wallets
         WHERE entity_id = ?
         ORDER BY wallet_index ASC`,
      );

      return entities.map((entity) => ({
        ...entity,
        wallets: walletsStmt.all(entity.id) as EntityWalletRecord[],
      }));
    },

    createSnapshot(totalEntities: number, zapperKeyLabel: string | null): number {
      const result = insertSnapshot.run({
        status: "running",
        zapperKeyLabel,
        totalEntities,
        createdAt: new Date().toISOString(),
      });
      return Number(result.lastInsertRowid);
    },

    updateSnapshot(update: SnapshotUpdate): void {
      updateSnapshotStmt.run({
        id: update.id,
        status: update.status ?? null,
        entitiesCompleted: update.entitiesCompleted ?? null,
        entitiesFailed: update.entitiesFailed ?? null,
        totalRows: update.totalRows ?? null,
        errorMessage: update.errorMessage ?? null,
        finishedAt: update.finishedAt ?? null,
      });
    },

    insertEntityFetchRun(run: EntityFetchRunRecord): number {
      const result = insertFetchRunStmt.run(run);
      return Number(result.lastInsertRowid);
    },

    updateEntityFetchRun(id: number, update: Partial<EntityFetchRunRecord>): void {
      updateFetchRunStmt.run({
        id,
        status: update.status ?? null,
        rowsFound: update.rowsFound ?? null,
        totalBalanceUsd: update.totalBalanceUsd ?? null,
        errorMessage: update.errorMessage ?? null,
        finishedAt: update.finishedAt ?? null,
      });
    },

    insertRawHoldingsForEntity,

    updateSnapshotTokenMarketData(snapshotId: number, tokenKey: string, marketData: {
      marketCap: number | null;
      liquidityUsd: number | null;
      volume24h: number | null;
      txns24h: number | null;
      tokenAgeHours: number | null;
    }): void {
      updateMarketDataForTokenStmt.run({
        snapshotId,
        tokenKey,
        marketCap: marketData.marketCap,
        liquidityUsd: marketData.liquidityUsd,
        volume24h: marketData.volume24h,
        txns24h: marketData.txns24h,
        tokenAgeHours: marketData.tokenAgeHours,
      });
    },

    updateSnapshotTokenMoniData(snapshotId: number, tokenKey: string, moniData: {
      moniScore: number | null;
      moniLevel: number | null;
      moniLevelName: string | null;
      moniMomentumScorePct: number | null;
      moniMomentumRank: number | null;
    }): void {
      updateMoniDataForTokenStmt.run({
        snapshotId,
        tokenKey,
        moniScore: moniData.moniScore,
        moniLevel: moniData.moniLevel,
        moniLevelName: moniData.moniLevelName,
        moniMomentumScorePct: moniData.moniMomentumScorePct,
        moniMomentumRank: moniData.moniMomentumRank,
      });
    },

    getSnapshotSummaries(): SnapshotRecord[] {
      return db
        .prepare(
          `SELECT id, status, zapper_key_label as zapperKeyLabel, total_entities as totalEntities,
                  entities_completed as entitiesCompleted, entities_failed as entitiesFailed,
                  total_rows as totalRows, error_message as errorMessage,
                  created_at as createdAt, finished_at as finishedAt
           FROM holding_snapshots
           ORDER BY id DESC`,
        )
        .all() as SnapshotRecord[];
    },

    getLatestSnapshot(): SnapshotRecord | null {
      return (
        (db
          .prepare(
            `SELECT id, status, zapper_key_label as zapperKeyLabel, total_entities as totalEntities,
                    entities_completed as entitiesCompleted, entities_failed as entitiesFailed,
                    total_rows as totalRows, error_message as errorMessage,
                    created_at as createdAt, finished_at as finishedAt
             FROM holding_snapshots
             ORDER BY id DESC
             LIMIT 1`,
          )
          .get() as SnapshotRecord | undefined) || null
      );
    },

    getSnapshotTokensForEnrichment(snapshotId: number, minBalanceUsd = 111, minSmwIn = 1): SnapshotTokenForEnrichment[] {
      return db
        .prepare(
          `SELECT
              rh.token_key as tokenKey,
              MAX(rh.token_symbol) as tokenSymbol,
              MAX(rh.token_name) as tokenName,
              MAX(rh.token_address) as tokenAddress,
              MAX(rh.network_name) as networkName,
              MAX(rh.chain_id) as chainId,
              COUNT(DISTINCT rh.entity_id) as smwIn,
              ROUND(SUM(rh.balance_usd), 2) as holdingsUsd
           FROM raw_holdings rh
           WHERE rh.snapshot_id = ?
             AND rh.balance_usd >= ?
           GROUP BY rh.token_key
           HAVING COUNT(DISTINCT rh.entity_id) >= ?
           ORDER BY smwIn DESC, holdingsUsd DESC, tokenSymbol COLLATE NOCASE ASC`,
        )
        .all(snapshotId, minBalanceUsd, minSmwIn) as SnapshotTokenForEnrichment[];
    },

    getOverview(snapshotId: number, minBalanceUsd = 111, minSmwIn = 1, minLiquidityUsd = 11111): TokenOverviewRow[] {
      return db
        .prepare(
          `SELECT
              rh.token_key as tokenKey,
              MAX(rh.token_symbol) as tokenSymbol,
              MAX(rh.token_name) as tokenName,
              MAX(rh.network_name) as networkName,
              MAX(rh.chain_id) as chainId,
              MAX(rh.token_address) as tokenAddress,
              ROUND(SUM(rh.balance_usd), 2) as holdingsUsd,
              COUNT(DISTINCT rh.entity_id) as smwIn,
              MAX(rh.market_cap) as marketCap,
              MAX(rh.token_age_hours) as tokenAgeHours,
              MAX(rh.moni_score) as moniScore,
              MAX(rh.moni_level) as moniLevel,
              MAX(rh.moni_level_name) as moniLevelName,
              MAX(rh.moni_momentum_score_pct) as moniMomentumScorePct,
              MAX(rh.moni_momentum_rank) as moniMomentumRank,
              MAX(rh.volume_24h) as volume24h,
              MAX(rh.txns_24h) as txns24h
           FROM raw_holdings rh
           LEFT JOIN token_blacklist bl
             ON bl.token_key = rh.token_key AND bl.is_active = 1
           WHERE rh.snapshot_id = ?
             AND rh.balance_usd >= ?
             AND bl.id IS NULL
           GROUP BY rh.token_key
           HAVING COUNT(DISTINCT rh.entity_id) >= ?
             AND (
               MAX(CASE WHEN rh.token_address IS NOT NULL THEN rh.liquidity_usd END) IS NULL
               OR MAX(CASE WHEN rh.token_address IS NOT NULL THEN rh.liquidity_usd END) >= ?
             )
             AND (
               MAX(CASE WHEN rh.token_address IS NOT NULL THEN rh.volume_24h END) IS NULL
               OR MAX(CASE WHEN rh.token_address IS NOT NULL THEN rh.volume_24h END) >= 1000
             )
             AND (
               MAX(CASE WHEN rh.token_address IS NOT NULL THEN rh.txns_24h END) IS NULL
               OR MAX(CASE WHEN rh.token_address IS NOT NULL THEN rh.txns_24h END) >= 11
             )
           ORDER BY smwIn DESC, holdingsUsd DESC, tokenSymbol COLLATE NOCASE ASC`,
        )
        .all(snapshotId, minBalanceUsd, minSmwIn, minLiquidityUsd) as TokenOverviewRow[];
    },

    getTokenHolders(snapshotId: number, tokenKey: string, minBalanceUsd = 111): TokenHolderRow[] {
      return db
        .prepare(
          `SELECT
             e.id as entityId,
             e.entity_name as entityName,
             e.resolved_label as resolvedLabel,
             rh.balance_usd as balanceUsd,
             rh.network_name as networkName,
             rh.token_symbol as tokenSymbol,
             rh.token_name as tokenName
           FROM raw_holdings rh
           INNER JOIN entities e ON e.id = rh.entity_id
           WHERE rh.snapshot_id = ?
             AND rh.token_key = ?
             AND rh.balance_usd >= ?
           ORDER BY rh.balance_usd DESC, e.entity_name COLLATE NOCASE ASC`,
        )
        .all(snapshotId, tokenKey, minBalanceUsd) as TokenHolderRow[];
    },

    upsertBlacklist(input: {
      tokenKey: string;
      tokenSymbol: string;
      tokenName: string;
      networkName: string;
      chainId: number | null;
      tokenAddress: string | null;
      reason: string | null;
    }): void {
      const now = new Date().toISOString();
      blacklistUpsertStmt.run({
        tokenKey: input.tokenKey,
        tokenSymbol: input.tokenSymbol,
        tokenName: input.tokenName,
        networkName: input.networkName,
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
        reason: input.reason,
        createdAt: now,
        updatedAt: now,
      });
    },

    restoreBlacklist(id: number): void {
      restoreBlacklistStmt.run({ id, updatedAt: new Date().toISOString() });
    },

    getBlacklist(): TokenBlacklistRecord[] {
      return (db
        .prepare(
          `SELECT id, token_key as tokenKey, token_symbol as tokenSymbol, token_name as tokenName,
                  network_name as networkName, chain_id as chainId, token_address as tokenAddress,
                  reason, is_active as isActive, created_at as createdAt, updated_at as updatedAt
           FROM token_blacklist
           WHERE is_active = 1
           ORDER BY updated_at DESC, token_symbol COLLATE NOCASE ASC`,
        )
        .all() as Array<Omit<TokenBlacklistRecord, "isActive"> & { isActive: number }>).map((row) => ({
        ...row,
        isActive: Boolean(row.isActive),
      }));
    },
  };
}

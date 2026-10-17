import { resolveWorkspacePaths } from "./runtime-paths";
import { ScoreContext, ScoreHistorySample, withOpportunityScore } from "./scoring";
import { createPostgresStorage } from "./storage-postgres";
import { SnapshotTokenForEnrichment, SnapshotUpdate, StorageAdapter } from "./storage-types";
import { normalizeTokenName } from "./token-name";
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

function normalizeFavoriteEntityKeys(names: string[] = []): string[] {
  return [...new Set(names.map((name) => String(name || "").trim().toLowerCase()).filter(Boolean))];
}

function splitFavoriteEntityNames(value: unknown): string[] {
  return String(value || "").split(",").map((name) => name.trim()).filter(Boolean);
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
      source_url TEXT NOT NULL UNIQUE,
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
      provider_label TEXT,
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
    CREATE INDEX IF NOT EXISTS idx_raw_holdings_token_history ON raw_holdings(token_key, snapshot_id, balance_usd DESC, entity_id);
    CREATE INDEX IF NOT EXISTS idx_snapshot_created ON holding_snapshots(created_at DESC, id DESC);
  `);

  ensureColumn("raw_holdings", "market_cap", "REAL");
  ensureColumn("raw_holdings", "liquidity_usd", "REAL");
  ensureColumn("raw_holdings", "volume_24h", "REAL");
  ensureColumn("raw_holdings", "txns_24h", "REAL");
  ensureColumn("raw_holdings", "token_age_hours", "REAL");

  const upsertEntity = db.prepare(`
    INSERT INTO entities (entity_name, source_url, resolved_label, link_type, created_at, updated_at)
    VALUES (@entityName, @sourceUrl, @resolvedLabel, @linkType, @createdAt, @updatedAt)
    ON CONFLICT(source_url) DO UPDATE SET
      entity_name = excluded.entity_name,
      resolved_label = excluded.resolved_label,
      link_type = excluded.link_type,
      updated_at = excluded.updated_at
    RETURNING id
  `);

  const findEntityForImport = db.prepare(`
    SELECT id
    FROM entities
    WHERE source_url = @sourceUrl
       OR lower(entity_name) = lower(@entityName)
    ORDER BY
      CASE WHEN source_url = @sourceUrl THEN 0 ELSE 1 END,
      datetime(updated_at) DESC,
      id DESC
    LIMIT 1
  `);
  const updateEntityForImport = db.prepare(`
    UPDATE entities
    SET entity_name = @entityName,
        source_url = @sourceUrl,
        resolved_label = @resolvedLabel,
        link_type = @linkType,
        updated_at = @updatedAt
    WHERE id = @id
  `);
  const findDuplicateEntitiesForImport = db.prepare(`
    SELECT id
    FROM entities
    WHERE lower(entity_name) = lower(@entityName)
    ORDER BY id ASC
  `);
  const updateDuplicateEntityForImport = db.prepare(`
    UPDATE entities
    SET entity_name = @entityName,
        resolved_label = @resolvedLabel,
        link_type = @linkType,
        updated_at = @updatedAt
    WHERE id = @id
  `);
  const clearWalletsForEntity = db.prepare(`DELETE FROM entity_wallets WHERE entity_id = ?`);
  const insertWallet = db.prepare(`
    INSERT INTO entity_wallets (entity_id, wallet_address, wallet_index, created_at)
    VALUES (@entityId, @walletAddress, @walletIndex, @createdAt)
  `);

  const insertSnapshot = db.prepare(`
    INSERT INTO holding_snapshots (status, provider_label, total_entities, created_at)
    VALUES (@status, @providerLabel, @totalEntities, @createdAt)
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
      token_age_hours, fetched_at
    ) VALUES (
      @snapshotId, @entityId, @tokenKey, @tokenSymbol, @tokenName, @tokenAddress, @networkName,
      @chainId, @balance, @balanceRaw, @balanceUsd, @price, @marketCap, @liquidityUsd, @volume24h, @txns24h,
      @tokenAgeHours, @fetchedAt
    )
  `);

  const updateMarketDataForTokenStmt = db.prepare(`
    UPDATE raw_holdings
    SET market_cap = COALESCE(@marketCap, market_cap),
        liquidity_usd = @liquidityUsd,
        volume_24h = @volume24h,
        txns_24h = @txns24h,
        token_age_hours = @tokenAgeHours
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
      const existing = findEntityForImport.get({
        entityName: entity.entityName,
        sourceUrl: entity.sourceUrl,
      }) as { id: number } | undefined;
      const result = existing || (upsertEntity.get({
        entityName: entity.entityName,
        sourceUrl: entity.sourceUrl,
        resolvedLabel: entity.resolvedLabel,
        linkType: entity.linkType,
        createdAt: now,
        updatedAt: now,
      }) as { id: number });

      if (existing) {
        updateEntityForImport.run({
          id: existing.id,
          entityName: entity.entityName,
          sourceUrl: entity.sourceUrl,
          resolvedLabel: entity.resolvedLabel,
          linkType: entity.linkType,
          updatedAt: now,
        });
      }

      const duplicateEntities = findDuplicateEntitiesForImport.all({ entityName: entity.entityName }) as Array<{ id: number }>;
      for (const duplicate of duplicateEntities) {
        if (duplicate.id !== result.id) {
          updateDuplicateEntityForImport.run({
            id: duplicate.id,
            entityName: entity.entityName,
            resolvedLabel: entity.resolvedLabel,
            linkType: entity.linkType,
            updatedAt: now,
          });
        }
        clearWalletsForEntity.run(duplicate.id);
        entity.walletAddresses.forEach((walletAddress, walletIndex) => {
          insertWallet.run({
            entityId: duplicate.id,
            walletAddress,
            walletIndex,
            createdAt: now,
          });
        });
      }
    }
  });

  const insertRawHoldingsForEntity = db.transaction((snapshotId: number, entityId: number, rows: RawHoldingRecord[]) => {
    deleteRawForSnapshotEntity.run(snapshotId, entityId);
    for (const row of rows) {
      insertRawHoldingStmt.run({
        ...row,
        tokenName: normalizeRawHoldingTokenName(row),
      });
    }
  });

  function entityConvictionByTokenForSnapshots(snapshotIds: number[], minBalanceUsd: number): Map<number, Map<string, number>> {
    if (!snapshotIds.length) return new Map();
    const placeholders = snapshotIds.map(() => "?").join(", ");
    const positions = db.prepare(
      `SELECT rh.snapshot_id as snapshotId, rh.token_key as tokenKey, lower(e.entity_name) as entityKey, MAX(rh.balance_usd) as balanceUsd
       FROM raw_holdings rh
       INNER JOIN entities e ON e.id = rh.entity_id
       LEFT JOIN token_blacklist bl ON bl.token_key = rh.token_key AND bl.is_active = 1
       WHERE rh.snapshot_id IN (${placeholders}) AND rh.balance_usd >= ? AND bl.id IS NULL
       GROUP BY rh.snapshot_id, rh.token_key, lower(e.entity_name)`,
    ).all(...snapshotIds, minBalanceUsd) as Array<{ snapshotId: number; tokenKey: string; entityKey: string; balanceUsd: number }>;
    const bySnapshotEntity = new Map<number, Map<string, number[]>>();
    for (const position of positions) {
      const byEntity = bySnapshotEntity.get(position.snapshotId) || new Map<string, number[]>();
      const values = byEntity.get(position.entityKey) || [];
      values.push(Number(position.balanceUsd || 0));
      byEntity.set(position.entityKey, values);
      bySnapshotEntity.set(position.snapshotId, byEntity);
    }
    const medians = new Map<number, Map<string, number>>();
    for (const [snapshotId, byEntity] of bySnapshotEntity) {
      const snapshotMedians = new Map<string, number>();
      for (const [entityKey, values] of byEntity) {
        values.sort((left, right) => left - right);
        const middle = Math.floor(values.length / 2);
        snapshotMedians.set(entityKey, values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2);
      }
      medians.set(snapshotId, snapshotMedians);
    }
    const totals = new Map<number, Map<string, { total: number; count: number }>>();
    for (const position of positions) {
      const median = Math.max(1, medians.get(position.snapshotId)?.get(position.entityKey) || 1);
      const ratio = Number(position.balanceUsd || 0) / median;
      const conviction = ratio < 0.5 ? 0.75 : ratio < 1 ? 0.9 : ratio < 2 ? 1.1 : ratio < 4 ? 1.35 : 1.6;
      const byToken = totals.get(position.snapshotId) || new Map<string, { total: number; count: number }>();
      const existing = byToken.get(position.tokenKey) || { total: 0, count: 0 };
      existing.total += conviction;
      existing.count += 1;
      byToken.set(position.tokenKey, existing);
      totals.set(position.snapshotId, byToken);
    }
    const output = new Map<number, Map<string, number>>();
    for (const [snapshotId, byToken] of totals) {
      output.set(snapshotId, new Map([...byToken].map(([tokenKey, value]) => [tokenKey, value.total / Math.max(1, value.count)])));
    }
    return output;
  }

  function entityConvictionByToken(snapshotId: number, minBalanceUsd: number): Map<string, number> {
    return entityConvictionByTokenForSnapshots([snapshotId], minBalanceUsd).get(snapshotId) || new Map();
  }

  function entityConvictionForTokenAtSnapshots(snapshotIds: number[], tokenKey: string, minBalanceUsd: number): Map<number, number> {
    if (!snapshotIds.length) return new Map();
    const placeholders = snapshotIds.map(() => "?").join(", ");
    const positions = db.prepare(
      `WITH target_entities AS (
         SELECT rh.snapshot_id as snapshotId, lower(e.entity_name) as entityKey
         FROM raw_holdings rh
         INNER JOIN entities e ON e.id = rh.entity_id
         LEFT JOIN token_blacklist bl ON bl.token_key = rh.token_key AND bl.is_active = 1
         WHERE rh.snapshot_id IN (${placeholders})
           AND rh.token_key = ?
           AND rh.balance_usd >= ?
           AND bl.id IS NULL
         GROUP BY rh.snapshot_id, lower(e.entity_name)
       )
       SELECT rh.snapshot_id as snapshotId, rh.token_key as tokenKey,
              lower(e.entity_name) as entityKey, MAX(rh.balance_usd) as balanceUsd
       FROM raw_holdings rh
       INNER JOIN entities e ON e.id = rh.entity_id
       INNER JOIN target_entities te
         ON te.snapshotId = rh.snapshot_id AND te.entityKey = lower(e.entity_name)
       LEFT JOIN token_blacklist bl ON bl.token_key = rh.token_key AND bl.is_active = 1
       WHERE rh.snapshot_id IN (${placeholders})
         AND rh.balance_usd >= ?
         AND bl.id IS NULL
       GROUP BY rh.snapshot_id, rh.token_key, lower(e.entity_name)`,
    ).all(...snapshotIds, tokenKey, minBalanceUsd, ...snapshotIds, minBalanceUsd) as Array<{
      snapshotId: number;
      tokenKey: string;
      entityKey: string;
      balanceUsd: number;
    }>;
    const bySnapshotEntity = new Map<number, Map<string, number[]>>();
    for (const position of positions) {
      const byEntity = bySnapshotEntity.get(position.snapshotId) || new Map<string, number[]>();
      const values = byEntity.get(position.entityKey) || [];
      values.push(Number(position.balanceUsd || 0));
      byEntity.set(position.entityKey, values);
      bySnapshotEntity.set(position.snapshotId, byEntity);
    }
    const medians = new Map<number, Map<string, number>>();
    for (const [snapshotId, byEntity] of bySnapshotEntity) {
      const snapshotMedians = new Map<string, number>();
      for (const [entityKey, values] of byEntity) {
        values.sort((left, right) => left - right);
        const middle = Math.floor(values.length / 2);
        snapshotMedians.set(entityKey, values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2);
      }
      medians.set(snapshotId, snapshotMedians);
    }
    const totals = new Map<number, { total: number; count: number }>();
    for (const position of positions) {
      if (position.tokenKey !== tokenKey) continue;
      const median = Math.max(1, medians.get(position.snapshotId)?.get(position.entityKey) || 1);
      const ratio = Number(position.balanceUsd || 0) / median;
      const conviction = ratio < 0.5 ? 0.75 : ratio < 1 ? 0.9 : ratio < 2 ? 1.1 : ratio < 4 ? 1.35 : 1.6;
      const existing = totals.get(position.snapshotId) || { total: 0, count: 0 };
      existing.total += conviction;
      existing.count += 1;
      totals.set(position.snapshotId, existing);
    }
    return new Map([...totals].map(([snapshotId, value]) => [snapshotId, value.total / Math.max(1, value.count)]));
  }

  function previousScoreSamples(snapshotId: number, minBalanceUsd: number, favoriteKeys: string[]): Map<string, ScoreHistorySample[]> {
    const snapshots = db.prepare(
      `SELECT id, COALESCE(finished_at, created_at) as at
       FROM holding_snapshots
       WHERE id < ? AND status = 'success'
       ORDER BY datetime(COALESCE(finished_at, created_at)) DESC, id DESC
       LIMIT 2`,
    ).all(snapshotId) as Array<{ id: number; at: string }>;
    if (!snapshots.length) return new Map();

    const snapshotPlaceholders = snapshots.map(() => "?").join(", ");
    const favoritePlaceholders = favoriteKeys.map(() => "?").join(", ");
    const favoriteExpression = favoriteKeys.length
      ? `SUM(CASE WHEN entityKey IN (${favoritePlaceholders}) THEN balanceUsd ELSE 0 END)`
      : "0";
    const favoriteCountExpression = favoriteKeys.length
      ? `SUM(CASE WHEN entityKey IN (${favoritePlaceholders}) THEN 1 ELSE 0 END)`
      : "0";
    const rows = db.prepare(
      `WITH canonical AS (
         SELECT rh.snapshot_id as snapshotId, rh.token_key as tokenKey, lower(e.entity_name) as entityKey,
                MAX(rh.balance_usd) as balanceUsd,
                MAX(CAST(NULLIF(rh.balance, '') AS REAL)) as tokenAmount
         FROM raw_holdings rh
         INNER JOIN entities e ON e.id = rh.entity_id
         LEFT JOIN token_blacklist bl ON bl.token_key = rh.token_key AND bl.is_active = 1
         WHERE rh.snapshot_id IN (${snapshotPlaceholders}) AND rh.balance_usd >= ? AND bl.id IS NULL
         GROUP BY rh.snapshot_id, rh.token_key, lower(e.entity_name)
       )
       SELECT snapshotId, tokenKey, ROUND(SUM(balanceUsd), 2) as holdingsUsd,
              SUM(tokenAmount) as tokenAmount, COUNT(*) as smwIn,
              ${favoriteExpression} as favoriteHoldingsUsd,
              ${favoriteCountExpression} as favoriteEntityCount
       FROM canonical
       GROUP BY snapshotId, tokenKey`,
    ).all(...snapshots.map((snapshot) => snapshot.id), minBalanceUsd, ...favoriteKeys, ...favoriteKeys) as Array<{
      snapshotId: number;
      tokenKey: string;
      holdingsUsd: number;
      tokenAmount: number;
      smwIn: number;
      favoriteHoldingsUsd: number;
      favoriteEntityCount: number;
    }>;
    const snapshotById = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
    const grouped = new Map<string, ScoreHistorySample[]>();
    for (const row of rows) {
      const snapshot = snapshotById.get(row.snapshotId);
      if (!snapshot) continue;
      const list = grouped.get(row.tokenKey) || [];
      list.push({
        tokenAmount: Number(row.tokenAmount || 0),
        holdingsUsd: Number(row.holdingsUsd || 0),
        smwIn: Number(row.smwIn || 0),
        favoriteEntityCount: Number(row.favoriteEntityCount || 0),
        favoriteHoldingsUsd: Number(row.favoriteHoldingsUsd || 0),
        at: snapshot.at,
      });
      grouped.set(row.tokenKey, list);
    }
    for (const list of grouped.values()) {
      list.sort((left, right) => Date.parse(right.at) - Date.parse(left.at));
    }
    return grouped;
  }

  return {
    close(): void {
      db.close();
    },

    replaceEntities,

    getEntities(): Array<EntityRecord & { wallets: EntityWalletRecord[] }> {
      const entities = db
        .prepare(
          `SELECT id, entity_name as entityName, source_url as sourceUrl,
                  resolved_label as resolvedLabel, link_type as linkType,
                  created_at as createdAt, updated_at as updatedAt
           FROM entities
           WHERE id IN (
             SELECT MAX(id)
             FROM entities
             GROUP BY lower(entity_name)
           )
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

    getEntitiesByLinks(sourceUrls: string[]): Array<EntityRecord & { wallets: EntityWalletRecord[] }> {
      if (!sourceUrls.length) return [];
      const placeholders = sourceUrls.map(() => "?").join(", ");
      const entities = db
        .prepare(
          `SELECT id, entity_name as entityName, source_url as sourceUrl,
                  resolved_label as resolvedLabel, link_type as linkType,
                  created_at as createdAt, updated_at as updatedAt
           FROM entities WHERE source_url IN (${placeholders}) ORDER BY id ASC`,
        )
        .all(...sourceUrls) as EntityRecord[];
      const walletsStmt = db.prepare(
        `SELECT entity_id as entityId, wallet_address as walletAddress, wallet_index as walletIndex
         FROM entity_wallets WHERE entity_id = ? ORDER BY wallet_index ASC`,
      );
      return entities.map((entity) => ({
        ...entity,
        wallets: walletsStmt.all(entity.id) as EntityWalletRecord[],
      }));
    },

    createSnapshot(totalEntities: number, providerLabel: string | null): number {
      const result = insertSnapshot.run({
        status: "running",
        providerLabel,
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

    getSnapshotSummaries(): SnapshotRecord[] {
      return db
        .prepare(
          `SELECT id, status, provider_label as providerLabel, total_entities as totalEntities,
                  entities_completed as entitiesCompleted, entities_failed as entitiesFailed,
                  total_rows as totalRows,
                  (
                    SELECT COUNT(*)
                    FROM raw_holdings rh
                    WHERE rh.snapshot_id = holding_snapshots.id
                      AND rh.chain_id = 1151111081
                  ) as solanaRows,
                  (
                    SELECT COUNT(*)
                    FROM raw_holdings rh
                    WHERE rh.snapshot_id = holding_snapshots.id
                      AND (rh.chain_id IS NULL OR rh.chain_id <> 1151111081)
                  ) as nonSolanaRows,
                  error_message as errorMessage,
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
            `SELECT id, status, provider_label as providerLabel, total_entities as totalEntities,
                    entities_completed as entitiesCompleted, entities_failed as entitiesFailed,
                    total_rows as totalRows,
                    (
                      SELECT COUNT(*)
                      FROM raw_holdings rh
                      WHERE rh.snapshot_id = holding_snapshots.id
                        AND rh.chain_id = 1151111081
                    ) as solanaRows,
                    (
                      SELECT COUNT(*)
                      FROM raw_holdings rh
                      WHERE rh.snapshot_id = holding_snapshots.id
                        AND (rh.chain_id IS NULL OR rh.chain_id <> 1151111081)
                    ) as nonSolanaRows,
                    error_message as errorMessage,
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
          `WITH canonical_holdings AS (
             SELECT
               rh.token_key,
               lower(e.entity_name) as entity_key,
               MAX(rh.token_symbol) as tokenSymbol,
               MAX(rh.token_name) as tokenName,
               MAX(rh.token_address) as tokenAddress,
               MAX(rh.network_name) as networkName,
               MAX(rh.chain_id) as chainId,
               MAX(rh.balance_usd) as balanceUsd
             FROM raw_holdings rh
             INNER JOIN entities e ON e.id = rh.entity_id
             WHERE rh.snapshot_id = ?
               AND rh.balance_usd >= ?
             GROUP BY rh.token_key, lower(e.entity_name)
           )
           SELECT
              token_key as tokenKey,
              MAX(tokenSymbol) as tokenSymbol,
              MAX(tokenName) as tokenName,
              MAX(tokenAddress) as tokenAddress,
              MAX(networkName) as networkName,
              MAX(chainId) as chainId,
              COUNT(*) as smwIn,
              ROUND(SUM(balanceUsd), 2) as holdingsUsd
           FROM canonical_holdings
           GROUP BY token_key
           HAVING COUNT(*) >= ?
           ORDER BY smwIn DESC, holdingsUsd DESC, tokenSymbol COLLATE NOCASE ASC`,
        )
        .all(snapshotId, minBalanceUsd, minSmwIn) as SnapshotTokenForEnrichment[];
    },

    getOverview(
      snapshotId: number,
      minBalanceUsd = 111,
      minSmwIn = 1,
      minLiquidityUsd = 11111,
      maxMarketCapUsd: number | null = null,
      favoriteEntityNames: string[] = [],
    ): TokenOverviewRow[] {
      const favoriteEntityKeys = normalizeFavoriteEntityKeys(favoriteEntityNames);
      const favoritePlaceholders = favoriteEntityKeys.map((_, index) => `@favorite${index}`).join(", ");
      const favoriteExpression = favoriteEntityKeys.length ? `CASE WHEN lower(e.entity_name) IN (${favoritePlaceholders}) THEN 1 ELSE 0 END` : "0";
      const favoriteParams = Object.fromEntries(favoriteEntityKeys.map((name, index) => [`favorite${index}`, name]));
      const rows = db
        .prepare(
          `WITH canonical_holdings AS (
             SELECT
               rh.token_key,
               lower(e.entity_name) as entity_key,
               MAX(e.entity_name) as entityName,
               MAX(${favoriteExpression}) as isFavoriteEntity,
               MAX(rh.token_symbol) as tokenSymbol,
               MAX(rh.token_name) as tokenName,
               MAX(rh.network_name) as networkName,
               MAX(rh.chain_id) as chainId,
               MAX(rh.token_address) as tokenAddress,
               MAX(rh.balance_usd) as balanceUsd,
               MAX(CAST(NULLIF(rh.balance, '') AS REAL)) as tokenAmount,
               MAX(rh.market_cap) as marketCap,
               MAX(rh.token_age_hours) as tokenAgeHours,
               MAX(rh.volume_24h) as volume24h,
               MAX(rh.txns_24h) as txns24h,
               MAX(rh.liquidity_usd) as liquidityUsd
             FROM raw_holdings rh
             INNER JOIN entities e ON e.id = rh.entity_id
             LEFT JOIN token_blacklist bl
               ON bl.token_key = rh.token_key AND bl.is_active = 1
             WHERE rh.snapshot_id = @snapshotId
               AND rh.balance_usd >= @minBalanceUsd
               AND bl.id IS NULL
             GROUP BY rh.token_key, lower(e.entity_name)
           ),
           token_rollup AS (
             SELECT
               token_key as tokenKey,
               MAX(tokenSymbol) as tokenSymbol,
               MAX(tokenName) as tokenName,
               MAX(networkName) as networkName,
               MAX(chainId) as chainId,
               MAX(tokenAddress) as tokenAddress,
               ROUND(SUM(balanceUsd), 2) as holdingsUsd,
               SUM(tokenAmount) as tokenAmount,
               COUNT(*) as smwIn,
               SUM(isFavoriteEntity) as favoriteEntityCount,
               ROUND(SUM(CASE WHEN isFavoriteEntity = 1 THEN balanceUsd ELSE 0 END), 2) as favoriteHoldingsUsd,
               GROUP_CONCAT(DISTINCT CASE WHEN isFavoriteEntity = 1 THEN entityName END) as favoriteEntityNames,
               MAX(marketCap) as marketCap,
               MAX(tokenAgeHours) as tokenAgeHours,
               MAX(volume24h) as volume24h,
               MAX(txns24h) as txns24h,
               MAX(liquidityUsd) as liquidityUsd
             FROM canonical_holdings
             GROUP BY token_key
             HAVING COUNT(*) >= @minSmwIn
               AND (
                 MAX(CASE WHEN tokenAddress IS NOT NULL THEN liquidityUsd END) IS NULL
                 OR MAX(CASE WHEN tokenAddress IS NOT NULL THEN liquidityUsd END) >= @minLiquidityUsd
               )
               AND (
                 MAX(CASE WHEN tokenAddress IS NOT NULL THEN volume24h END) IS NULL
                 OR MAX(CASE WHEN tokenAddress IS NOT NULL THEN volume24h END) >= 1000
               )
               AND (
                 MAX(CASE WHEN tokenAddress IS NOT NULL THEN txns24h END) IS NULL
                 OR MAX(CASE WHEN tokenAddress IS NOT NULL THEN txns24h END) >= 11
               )
               AND (
                 @maxMarketCapUsd IS NULL
                 OR MAX(marketCap) IS NULL
                 OR MAX(marketCap) < @maxMarketCapUsd
               )
           )
           SELECT
              tokenKey,
              tokenSymbol,
              tokenName,
              networkName,
              chainId,
              tokenAddress,
              holdingsUsd,
              smwIn,
              favoriteEntityCount,
              favoriteHoldingsUsd,
              favoriteEntityNames,
              marketCap,
              tokenAgeHours,
              volume24h,
              txns24h,
              liquidityUsd,
              tokenAmount
           FROM token_rollup
           ORDER BY smwIn DESC, holdingsUsd DESC, tokenSymbol COLLATE NOCASE ASC`,
        )
        .all({
          snapshotId,
          minBalanceUsd,
          minSmwIn,
          minLiquidityUsd,
          maxMarketCapUsd,
          ...favoriteParams,
        }) as Array<
        Omit<TokenOverviewRow, "score">
      >;
      const currentSnapshot = db.prepare(
        `SELECT COALESCE(finished_at, created_at) as at FROM holding_snapshots WHERE id = ?`,
      ).get(snapshotId) as { at: string } | undefined;
      const convictionByToken = entityConvictionByToken(snapshotId, minBalanceUsd);
      const previousByToken = previousScoreSamples(snapshotId, minBalanceUsd, favoriteEntityKeys);
      return rows.map((row) => {
        const normalized = {
          ...row,
          favoriteEntityCount: Number(row.favoriteEntityCount || 0),
          favoriteHoldingsUsd: Number(row.favoriteHoldingsUsd || 0),
          favoriteEntityNames: splitFavoriteEntityNames(row.favoriteEntityNames),
          tokenAmount: Number(row.tokenAmount || 0),
          liquidityUsd: row.liquidityUsd == null ? null : Number(row.liquidityUsd),
          entityConviction: convictionByToken.get(row.tokenKey) || 1,
        };
        const previous = previousByToken.get(row.tokenKey) || [];
        const currentSample: ScoreHistorySample = {
          tokenAmount: normalized.tokenAmount,
          holdingsUsd: normalized.holdingsUsd,
          smwIn: normalized.smwIn,
          favoriteEntityCount: normalized.favoriteEntityCount,
          favoriteHoldingsUsd: normalized.favoriteHoldingsUsd,
          at: currentSnapshot?.at || new Date().toISOString(),
        };
        const context: ScoreContext = {
          currentAt: currentSample.at,
          previous: previous[0],
          previousPrevious: previous[1],
          entityConviction: normalized.entityConviction,
        };
        return withOpportunityScore(normalized, context);
      });
    },

    getTokenHolders(snapshotId: number, tokenKey: string, minBalanceUsd = 111): TokenHolderRow[] {
      return db
        .prepare(
          `SELECT
             MIN(e.id) as entityId,
             MAX(e.entity_name) as entityName,
             MAX(e.resolved_label) as resolvedLabel,
             MAX(rh.balance_usd) as balanceUsd,
             MAX(rh.network_name) as networkName,
             MAX(rh.token_symbol) as tokenSymbol,
             MAX(rh.token_name) as tokenName
           FROM raw_holdings rh
           INNER JOIN entities e ON e.id = rh.entity_id
           WHERE rh.snapshot_id = ?
             AND rh.token_key = ?
             AND rh.balance_usd >= ?
           GROUP BY lower(e.entity_name)
           ORDER BY MAX(rh.balance_usd) DESC, MAX(e.entity_name) COLLATE NOCASE ASC`,
        )
        .all(snapshotId, tokenKey, minBalanceUsd) as TokenHolderRow[];
    },

    getTokenScoreHistory(tokenKey: string, minBalanceUsd = 111, favoriteEntityNames: string[] = [], limit: number | null = null): TokenScorePoint[] {
      const favoriteEntityKeys = normalizeFavoriteEntityKeys(favoriteEntityNames);
      const historyLimit = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.min(100, Math.trunc(Number(limit))) : null;
      const queryLimit = historyLimit == null ? null : historyLimit + 2;
      const historyOrder = queryLimit == null ? "ASC" : "DESC";
      const historyLimitClause = queryLimit == null ? "" : "LIMIT ?";
      const favoritePlaceholders = favoriteEntityKeys.map(() => "?").join(", ");
      const favoriteFlagExpression = favoriteEntityKeys.length
        ? `MAX(CASE WHEN lower(e.entity_name) IN (${favoritePlaceholders}) THEN 1 ELSE 0 END)`
        : "0";
      const rows = db
        .prepare(
          `WITH canonical_holdings AS (
             SELECT
               rh.snapshot_id,
               rh.token_key,
               lower(e.entity_name) as entity_key,
               ${favoriteFlagExpression} as isFavorite,
               MAX(rh.token_symbol) as tokenSymbol,
               MAX(rh.token_name) as tokenName,
               MAX(rh.network_name) as networkName,
               MAX(rh.chain_id) as chainId,
               MAX(rh.token_address) as tokenAddress,
               MAX(rh.balance_usd) as balanceUsd,
               MAX(CAST(NULLIF(rh.balance, '') AS REAL)) as tokenAmount,
               MAX(rh.market_cap) as marketCap,
               MAX(rh.token_age_hours) as tokenAgeHours,
               MAX(rh.volume_24h) as volume24h,
               MAX(rh.txns_24h) as txns24h,
               MAX(rh.liquidity_usd) as liquidityUsd
             FROM raw_holdings rh
             INNER JOIN entities e ON e.id = rh.entity_id
             WHERE rh.token_key = ?
               AND rh.balance_usd >= ?
             GROUP BY rh.snapshot_id, rh.token_key, lower(e.entity_name)
           )
           SELECT
              hs.id as snapshotId,
              hs.status as snapshotStatus,
              hs.created_at as snapshotCreatedAt,
              hs.finished_at as snapshotFinishedAt,
              ch.token_key as tokenKey,
              MAX(ch.tokenSymbol) as tokenSymbol,
              MAX(ch.tokenName) as tokenName,
              MAX(ch.networkName) as networkName,
              MAX(ch.chainId) as chainId,
              MAX(ch.tokenAddress) as tokenAddress,
              ROUND(SUM(ch.balanceUsd), 2) as holdingsUsd,
              SUM(ch.tokenAmount) as tokenAmount,
              COUNT(*) as smwIn,
              SUM(ch.isFavorite) as favoriteEntityCount,
              ROUND(SUM(CASE WHEN ch.isFavorite = 1 THEN ch.balanceUsd ELSE 0 END), 2) as favoriteHoldingsUsd,
              MAX(ch.marketCap) as marketCap,
              MAX(ch.tokenAgeHours) as tokenAgeHours,
              MAX(ch.volume24h) as volume24h,
              MAX(ch.txns24h) as txns24h,
              MAX(ch.liquidityUsd) as liquidityUsd
           FROM canonical_holdings ch
           INNER JOIN holding_snapshots hs ON hs.id = ch.snapshot_id
           WHERE ch.token_key = ?
             AND hs.status IN ('success', 'partial')
           GROUP BY hs.id, ch.token_key
           ORDER BY datetime(COALESCE(hs.finished_at, hs.created_at)) ${historyOrder}, hs.id ${historyOrder}
           ${historyLimitClause}`,
        )
        .all(...favoriteEntityKeys, tokenKey, minBalanceUsd, tokenKey, ...(queryLimit == null ? [] : [queryLimit])) as Array<Omit<TokenScorePoint, "score"> & { favoriteEntityCount?: number; favoriteHoldingsUsd?: number; liquidityUsd?: number | null }>;
      if (queryLimit != null) rows.reverse();
      const convictionBySnapshot = entityConvictionForTokenAtSnapshots(
        [...new Set(rows.map((row) => row.snapshotId))],
        tokenKey,
        minBalanceUsd,
      );
      let previous: ScoreHistorySample | undefined;
      let previousPrevious: ScoreHistorySample | undefined;
      const scoredRows = rows.map((row) => {
        const normalized = {
          ...row,
          favoriteEntityCount: Number(row.favoriteEntityCount || 0),
          favoriteHoldingsUsd: Number(row.favoriteHoldingsUsd || 0),
          liquidityUsd: row.liquidityUsd == null ? null : Number(row.liquidityUsd),
          entityConviction: convictionBySnapshot.get(row.snapshotId) || 1,
        };
        const scored = withOpportunityScore(normalized, {
          currentAt: row.snapshotFinishedAt || row.snapshotCreatedAt,
          previous,
          previousPrevious,
          entityConviction: normalized.entityConviction,
        });
        if (row.snapshotStatus === "success") {
          previousPrevious = previous;
          previous = {
            tokenAmount: Number(row.tokenAmount || 0),
            holdingsUsd: Number(row.holdingsUsd || 0),
            smwIn: Number(row.smwIn || 0),
            favoriteEntityCount: normalized.favoriteEntityCount,
            favoriteHoldingsUsd: normalized.favoriteHoldingsUsd,
            at: row.snapshotFinishedAt || row.snapshotCreatedAt,
          };
        }
        return scored;
      });
      return historyLimit == null ? scoredRows : scoredRows.slice(-historyLimit);
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

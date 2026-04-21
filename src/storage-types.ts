import {
  EntityFetchRunRecord,
  EntityRecord,
  EntityWalletRecord,
  ImportedEntity,
  RawHoldingRecord,
  SnapshotRecord,
  SnapshotStatus,
  TokenBlacklistRecord,
  TokenHolderRow,
  TokenOverviewRow,
} from "./types";

export type SnapshotTokenForEnrichment = {
  tokenKey: string;
  tokenSymbol: string;
  tokenName: string;
  tokenAddress: string | null;
  networkName: string;
  chainId: number | null;
  smwIn: number;
  holdingsUsd: number;
};

export type SnapshotUpdate = {
  id: number;
  status?: SnapshotStatus;
  entitiesCompleted?: number;
  entitiesFailed?: number;
  totalRows?: number;
  errorMessage?: string | null;
  finishedAt?: string | null;
};

export type StorageResult<T> = T | Promise<T>;

export type StorageAdapter = {
  close(): StorageResult<void>;
  replaceEntities(entities: ImportedEntity[]): StorageResult<void>;
  getEntities(): StorageResult<Array<EntityRecord & { wallets: EntityWalletRecord[] }>>;
  createSnapshot(totalEntities: number, zapperKeyLabel: string | null): StorageResult<number>;
  updateSnapshot(update: SnapshotUpdate): StorageResult<void>;
  insertEntityFetchRun(run: EntityFetchRunRecord): StorageResult<number>;
  updateEntityFetchRun(id: number, update: Partial<EntityFetchRunRecord>): StorageResult<void>;
  insertRawHoldingsForEntity(snapshotId: number, entityId: number, rows: RawHoldingRecord[]): StorageResult<void>;
  updateSnapshotTokenMarketData(snapshotId: number, tokenKey: string, marketData: {
    marketCap: number | null;
    liquidityUsd: number | null;
    volume24h: number | null;
    txns24h: number | null;
    tokenAgeHours: number | null;
  }): StorageResult<void>;
  updateSnapshotTokenMoniData(snapshotId: number, tokenKey: string, moniData: {
    moniScore: number | null;
    moniLevel: number | null;
    moniLevelName: string | null;
    moniMomentumScorePct: number | null;
    moniMomentumRank: number | null;
  }): StorageResult<void>;
  getSnapshotSummaries(): StorageResult<SnapshotRecord[]>;
  getLatestSnapshot(): StorageResult<SnapshotRecord | null>;
  getSnapshotTokensForEnrichment(snapshotId: number, minBalanceUsd?: number, minSmwIn?: number): StorageResult<SnapshotTokenForEnrichment[]>;
  getOverview(snapshotId: number, minBalanceUsd?: number, minSmwIn?: number, minLiquidityUsd?: number): StorageResult<TokenOverviewRow[]>;
  getTokenHolders(snapshotId: number, tokenKey: string, minBalanceUsd?: number): StorageResult<TokenHolderRow[]>;
  upsertBlacklist(input: {
    tokenKey: string;
    tokenSymbol: string;
    tokenName: string;
    networkName: string;
    chainId: number | null;
    tokenAddress: string | null;
    reason: string | null;
  }): StorageResult<void>;
  restoreBlacklist(id: number): StorageResult<void>;
  getBlacklist(): StorageResult<TokenBlacklistRecord[]>;
};

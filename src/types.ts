export type EntityLinkType = "bundle" | "account";

export type ImportedEntity = {
  entityName: string;
  fullZapperLink: string;
  resolvedLabel: string | null;
  linkType: EntityLinkType;
  walletAddresses: string[];
};

export type EntityRecord = {
  id: number;
  entityName: string;
  fullZapperLink: string;
  resolvedLabel: string | null;
  linkType: EntityLinkType;
  createdAt: string;
  updatedAt: string;
};

export type EntityWalletRecord = {
  entityId: number;
  walletAddress: string;
  walletIndex: number;
};

export type SnapshotStatus = "running" | "success" | "partial" | "failed" | "canceled";

export type SnapshotRecord = {
  id: number;
  status: SnapshotStatus;
  zapperKeyLabel: string | null;
  totalEntities: number;
  entitiesCompleted: number;
  entitiesFailed: number;
  totalRows: number;
  errorMessage: string | null;
  createdAt: string;
  finishedAt: string | null;
};

export type EntityFetchRunStatus = "running" | "success" | "failed" | "canceled";

export type EntityFetchRunRecord = {
  id?: number;
  snapshotId: number;
  entityId: number;
  status: EntityFetchRunStatus;
  rowsFound: number;
  totalBalanceUsd: number;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
};

export type ZapperTokenBalance = {
  tokenSymbol: string;
  tokenName: string;
  tokenAddress: string | null;
  networkName: string;
  chainId: number | null;
  balance: string;
  balanceRaw: string;
  balanceUsd: number;
  price: number | null;
};

export type RawHoldingRecord = {
  snapshotId: number;
  entityId: number;
  tokenKey: string;
  tokenSymbol: string;
  tokenName: string;
  tokenAddress: string | null;
  networkName: string;
  chainId: number | null;
  balance: string;
  balanceRaw: string;
  balanceUsd: number;
  price: number | null;
  fetchedAt: string;
};

export type TokenBlacklistRecord = {
  id: number;
  tokenKey: string;
  tokenSymbol: string;
  tokenName: string;
  networkName: string;
  chainId: number | null;
  tokenAddress: string | null;
  reason: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type TokenOverviewRow = {
  tokenKey: string;
  tokenSymbol: string;
  tokenName: string;
  networkName: string;
  chainId: number | null;
  tokenAddress: string | null;
  holdingsUsd: number;
  smwIn: number;
  marketCap: number | null;
  tokenAgeHours: number | null;
};

export type TokenEnrichmentRecord = {
  id: number;
  tokenKey: string;
  tokenSymbol: string;
  tokenName: string;
  networkName: string;
  chainId: number | null;
  tokenAddress: string | null;
  marketCap: number | null;
  tokenAgeHours: number | null;
  createdAt: string;
  updatedAt: string;
};

export type TokenHolderRow = {
  entityId: number;
  entityName: string;
  resolvedLabel: string | null;
  balanceUsd: number;
  networkName: string;
  tokenSymbol: string;
  tokenName: string;
};

export type TokenDetails = TokenOverviewRow & {
  marketCapSource: "manual" | "none";
  tokenAgeSource: "manual" | "none";
};

export type RefreshLogTone = "info" | "success" | "warning" | "error";

export type RefreshLogEntry = {
  at: string;
  tone: RefreshLogTone;
  message: string;
};

export type RefreshProgressState = {
  snapshotId: number | null;
  totalEntities: number;
  entitiesCompleted: number;
  entitiesFailed: number;
  totalRows: number;
  currentEntity: string | null;
  currentEntityIndex: number | null;
  status: SnapshotStatus;
  errorMessage: string | null;
};

export type RefreshJobState = {
  jobId: string;
  running: boolean;
  startedAt: string;
  finishedAt: string | null;
  apiKeyLabel: string | null;
  progress: RefreshProgressState;
  logs: RefreshLogEntry[];
};

export type RefreshResult = {
  snapshotId: number;
  totalEntities: number;
  entitiesCompleted: number;
  entitiesFailed: number;
  totalRows: number;
  status: SnapshotStatus;
};

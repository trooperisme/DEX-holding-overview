import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { loadImportedEntities } from "../src/entities";
import { resolveWorkspacePaths } from "../src/runtime-paths";
import { fetchSolscanTopTokenBalances } from "../src/solscan";

dotenv.config();

type WalletHoldingRow = {
  entityName: string;
  resolvedLabel: string | null;
  walletAddress: string;
  tokenKey: string;
  tokenName: string;
  tokenSymbol: string;
  tokenAddress: string;
  balanceUsd: number;
  balance: string;
};

type EntityTokenRow = {
  entityName: string;
  resolvedLabel: string | null;
  tokenKey: string;
  tokenName: string;
  tokenSymbol: string;
  tokenAddress: string;
  balanceUsd: number;
  balance: string;
  walletCount: number;
  wallets: string[];
};

const SOLANA_WALLET_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function isSolanaWalletAddress(address: string): boolean {
  return !address.startsWith("0x") && SOLANA_WALLET_RE.test(address);
}

function tokenKey(tokenAddress: string): string {
  return `solana:${tokenAddress.toLowerCase()}`;
}

function addDecimalStrings(left: string, right: string): string {
  const sum = Number(left || 0) + Number(right || 0);
  return Number.isFinite(sum) ? String(sum) : left;
}

function dedupeEntityRows(walletRows: WalletHoldingRow[]): EntityTokenRow[] {
  const byEntityToken = new Map<string, EntityTokenRow>();

  for (const row of walletRows) {
    const key = `${row.entityName}\n${row.tokenKey}`;
    const existing = byEntityToken.get(key);
    if (!existing) {
      byEntityToken.set(key, {
        entityName: row.entityName,
        resolvedLabel: row.resolvedLabel,
        tokenKey: row.tokenKey,
        tokenName: row.tokenName,
        tokenSymbol: row.tokenSymbol,
        tokenAddress: row.tokenAddress,
        balanceUsd: row.balanceUsd,
        balance: row.balance,
        walletCount: 1,
        wallets: [row.walletAddress],
      });
      continue;
    }

    existing.balanceUsd += row.balanceUsd;
    existing.balance = addDecimalStrings(existing.balance, row.balance);
    if (!existing.wallets.includes(row.walletAddress)) {
      existing.wallets.push(row.walletAddress);
      existing.walletCount = existing.wallets.length;
    }
  }

  return Array.from(byEntityToken.values()).sort((left, right) => {
    const entity = left.entityName.localeCompare(right.entityName);
    if (entity !== 0) return entity;
    return right.balanceUsd - left.balanceUsd;
  });
}

async function main(): Promise<void> {
  const firecrawlApiKey = process.env.FIRECRAWL_API_KEY?.trim();
  if (!firecrawlApiKey) {
    throw new Error("FIRECRAWL_API_KEY is required for the Solscan workflow");
  }

  const cwd = process.cwd();
  const paths = resolveWorkspacePaths(cwd);
  const minBalanceUsd = Number(process.env.SOLSCAN_MIN_BALANCE_USD || 111);
  const walletLimit = Number(process.env.SOLSCAN_WALLET_LIMIT || 0);
  const entityLimit = Number(process.env.SOLSCAN_ENTITY_LIMIT || 0);
  const imported = loadImportedEntities(paths.entitiesCsv);
  const entities = imported
    .map((entity) => ({
      entityName: entity.entityName,
      resolvedLabel: entity.resolvedLabel,
      wallets: entity.walletAddresses.filter(isSolanaWalletAddress),
    }))
    .filter((entity) => entity.wallets.length > 0)
    .slice(0, entityLimit > 0 ? entityLimit : undefined);

  const walletRows: WalletHoldingRow[] = [];
  const errors: Array<{ entityName: string; walletAddress: string; error: string }> = [];
  let walletsAttempted = 0;

  for (const entity of entities) {
    const wallets = entity.wallets.slice(0, walletLimit > 0 ? walletLimit : undefined);
    for (const walletAddress of wallets) {
      walletsAttempted += 1;
      try {
        const result = await fetchSolscanTopTokenBalances(firecrawlApiKey, walletAddress, { minBalanceUsd });
        for (const holding of result.holdings) {
          walletRows.push({
            entityName: entity.entityName,
            resolvedLabel: entity.resolvedLabel,
            walletAddress,
            tokenKey: tokenKey(holding.tokenAddress),
            tokenName: holding.tokenName,
            tokenSymbol: holding.tokenSymbol,
            tokenAddress: holding.tokenAddress,
            balanceUsd: holding.balanceUsd,
            balance: holding.balance,
          });
        }
        console.log(`${entity.entityName} ${walletAddress}: ${result.holdings.length} top holding(s)`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push({ entityName: entity.entityName, walletAddress, error: message });
        console.warn(`${entity.entityName} ${walletAddress}: ${message}`);
      }
    }
  }

  const entityRows = dedupeEntityRows(walletRows);
  const generatedAt = new Date().toISOString();
  const output = {
    generatedAt,
    source: "firecrawl:solscan",
    minBalanceUsd,
    entitiesScanned: entities.length,
    walletsAttempted,
    walletRows: walletRows.length,
    entityRows: entityRows.length,
    duplicateRowsCollapsed: walletRows.length - entityRows.length,
    rows: entityRows,
    walletEvidence: walletRows,
    errors,
  };

  const outputDir = path.join(cwd, ".tmp");
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `solscan-top-holdings-${generatedAt.replace(/[:.]/g, "-")}.json`);
  const serialized = JSON.stringify(output, null, 2);
  fs.writeFileSync(outputPath, serialized);

  const dataOutputPath = path.join(cwd, "data", "raw", "solscan-top-holdings-latest.json");
  fs.writeFileSync(dataOutputPath, serialized);

  console.log(`Wrote ${outputPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { fetchDexScreenerMarketData } from "../src/dexscreener";
import { fetchMoniScoreDataForToken } from "../src/moni";
import { SOLANA_CHAIN_ID } from "../src/solscan";

dotenv.config();

type SolscanEntityTokenRow = {
  tokenKey: string;
  tokenName: string;
  tokenSymbol: string;
  tokenAddress: string;
  balanceUsd?: number;
  marketCap?: number | null;
  liquidityUsd?: number | null;
  volume24h?: number | null;
  txns24h?: number | null;
  tokenAgeHours?: number | null;
  moniScore?: number | null;
  moniLevel?: number | null;
  moniLevelName?: string | null;
  moniMomentumScorePct?: number | null;
  moniMomentumRank?: number | null;
};

type SolscanPayload = {
  rows?: SolscanEntityTokenRow[];
  enrichedAt?: string;
  enrichment?: Record<string, unknown>;
};

function uniqueTokens(rows: SolscanEntityTokenRow[]): SolscanEntityTokenRow[] {
  const byAddress = new Map<string, SolscanEntityTokenRow>();
  for (const row of rows) {
    const address = String(row.tokenAddress || "").toLowerCase();
    if (!address || byAddress.has(address)) continue;
    byAddress.set(address, row);
  }
  return Array.from(byAddress.values());
}

function tokenHoldingUsd(row: SolscanEntityTokenRow, allRows: SolscanEntityTokenRow[]): number {
  const address = row.tokenAddress.toLowerCase();
  return allRows
    .filter((item) => item.tokenAddress.toLowerCase() === address)
    .reduce((sum, item) => sum + Number(item.balanceUsd || 0), 0);
}

async function enrichMoniScores(options: {
  rows: SolscanEntityTokenRow[];
  twitterHandleByTokenAddress: Map<string, string>;
  limit: number;
  concurrency: number;
}): Promise<number> {
  const firecrawlApiKey = process.env.FIRECRAWL_API_KEY?.trim();
  if (!firecrawlApiKey || options.limit <= 0) return 0;

  const candidates = uniqueTokens(options.rows)
    .sort((left, right) => tokenHoldingUsd(right, options.rows) - tokenHoldingUsd(left, options.rows))
    .map((row) => ({
      row,
      twitterHandle: options.twitterHandleByTokenAddress.get(row.tokenAddress.toLowerCase()) || null,
    }))
    .filter((item): item is { row: SolscanEntityTokenRow; twitterHandle: string } => Boolean(item.twitterHandle))
    .slice(0, options.limit);

  let enriched = 0;
  let nextIndex = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(options.concurrency, candidates.length || 1)) }, async () => {
    while (nextIndex < candidates.length) {
      const candidate = candidates[nextIndex];
      nextIndex += 1;
      try {
        const moni = await fetchMoniScoreDataForToken(
          firecrawlApiKey,
          candidate.twitterHandle,
          candidate.row.tokenName,
          {
            tokenSymbol: candidate.row.tokenSymbol,
            includeTokenFallbacks: true,
            timeoutMs: Math.max(1000, Number(process.env.MONI_SCRAPE_TIMEOUT_MS || 8000)),
          },
        );
        if (!moni) continue;

        for (const row of options.rows) {
          if (row.tokenAddress.toLowerCase() !== candidate.row.tokenAddress.toLowerCase()) continue;
          row.moniScore = moni.moniScore;
          row.moniLevel = moni.moniLevel;
          row.moniLevelName = moni.moniLevelName;
          row.moniMomentumScorePct = moni.moniMomentumScorePct;
          row.moniMomentumRank = moni.moniMomentumRank;
        }
        enriched += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`MONI skipped for ${candidate.row.tokenSymbol}: ${message}`);
      }
    }
  });

  await Promise.all(workers);
  return enriched;
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const filePath = path.join(cwd, "data", "raw", "solscan-top-holdings-latest.json");
  const payload = JSON.parse(fs.readFileSync(filePath, "utf8")) as SolscanPayload;
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  const tokens = uniqueTokens(rows);

  const marketData = await fetchDexScreenerMarketData(
    tokens.map((token) => ({
      tokenAddress: token.tokenAddress,
      chainId: SOLANA_CHAIN_ID,
      networkName: "Solana",
    })),
  );

  const twitterHandleByTokenAddress = new Map<string, string>();
  let marketDataRows = 0;
  for (const token of tokens) {
    const data = marketData.get(`solana:${token.tokenAddress.toLowerCase()}`);
    if (!data) continue;
    if (data.twitterHandle) twitterHandleByTokenAddress.set(token.tokenAddress.toLowerCase(), data.twitterHandle);

    for (const row of rows) {
      if (row.tokenAddress.toLowerCase() !== token.tokenAddress.toLowerCase()) continue;
      row.marketCap = data.marketCap;
      row.liquidityUsd = data.liquidityUsd;
      row.volume24h = data.volume24h;
      row.txns24h = data.txns24h;
      row.tokenAgeHours = data.tokenAgeHours;
    }
    if (data.marketCap != null) marketDataRows += 1;
  }

  const moniLimit = Math.max(0, Number(process.env.SOLSCAN_MONI_LOOKUP_LIMIT || 20));
  const moniConcurrency = Math.max(1, Number(process.env.SOLSCAN_MONI_CONCURRENCY || 2));
  const moniRows = await enrichMoniScores({
    rows,
    twitterHandleByTokenAddress,
    limit: moniLimit,
    concurrency: moniConcurrency,
  });

  payload.enrichedAt = new Date().toISOString();
  payload.enrichment = {
    marketDataSource: "dexscreener",
    moniSource: "discover.getmoni.io",
    uniqueTokens: tokens.length,
    marketDataRows,
    twitterHandleRows: twitterHandleByTokenAddress.size,
    moniRows,
    moniLimit,
  };

  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  console.log(JSON.stringify(payload.enrichment, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

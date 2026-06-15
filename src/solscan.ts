import { ZapperTokenBalance } from "./types";

export const SOLANA_CHAIN_ID = 1151111081;

export type SolscanPortfolioHolding = {
  tokenName: string;
  tokenSymbol: string;
  tokenAddress: string;
  balanceUsd: number;
  balance: string;
};

type FirecrawlScrapeResponse = {
  success?: boolean;
  data?: {
    markdown?: string;
  };
  error?: string;
};

function parseNumber(value: string): number | null {
  const cleaned = value.replace(/[$,%]/g, "").replace(/,/g, "").trim();
  if (!cleaned || cleaned === "-") return null;
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : null;
}

function stripMarkdownImages(value: string): string {
  return value.replace(/!\[[^\]]*]\([^)]*\)/g, "");
}

function parseMarkdownLink(value: string): { label: string; href: string } | null {
  const match = value.match(/\[([^\]]+)]\(([^)]+)\)/);
  if (!match) return null;
  return {
    label: match[1].replace(/\\\s*/g, "").trim(),
    href: match[2].trim(),
  };
}

function splitMarkdownTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

export function parseSolscanPortfolioMarkdown(markdown: string, minBalanceUsd = 111): SolscanPortfolioHolding[] {
  const rows: SolscanPortfolioHolding[] = [];
  const lines = markdown.split(/\r?\n/);

  for (const line of lines) {
    if (!line.startsWith("|") || line.includes("| --- |")) continue;
    const cells = splitMarkdownTableRow(line);
    if (cells.length < 7 || cells[0].toLowerCase().includes("token account")) continue;

    const tokenLink = parseMarkdownLink(stripMarkdownImages(cells[1]));
    const tokenAddress = tokenLink?.href.match(/\/token\/([^)?#]+)/)?.[1] || null;
    const balanceUsd = parseNumber(cells[5]);
    if (!tokenLink || !tokenAddress || balanceUsd == null) continue;
    if (balanceUsd < minBalanceUsd) continue;

    rows.push({
      tokenName: tokenLink.label,
      tokenSymbol: cells[2],
      tokenAddress,
      balanceUsd,
      balance: cells[3].replace(/,/g, ""),
    });
  }

  return rows;
}

export function toSolanaTokenBalance(holding: SolscanPortfolioHolding): ZapperTokenBalance {
  return {
    tokenSymbol: holding.tokenSymbol || "UNKNOWN",
    tokenName: holding.tokenName || "Unknown token",
    tokenAddress: holding.tokenAddress,
    networkName: "Solana",
    chainId: SOLANA_CHAIN_ID,
    balance: holding.balance,
    balanceRaw: holding.balance,
    balanceUsd: holding.balanceUsd,
    price: null,
    marketCap: null,
    liquidityUsd: null,
    volume24h: null,
    txns24h: null,
    tokenAgeHours: null,
    moniScore: null,
    moniLevel: null,
    moniLevelName: null,
    moniMomentumScorePct: null,
    moniMomentumRank: null,
  };
}

export async function fetchSolscanTopTokenBalances(
  firecrawlApiKey: string,
  walletAddress: string,
  options: {
    minBalanceUsd?: number;
    signal?: AbortSignal;
  } = {},
): Promise<{
  totalCount: number;
  totalBalanceUsd: number;
  balances: ZapperTokenBalance[];
  holdings: SolscanPortfolioHolding[];
}> {
  const response = await fetch("https://api.firecrawl.dev/v2/scrape", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${firecrawlApiKey}`,
    },
    signal: options.signal,
    body: JSON.stringify({
      url: `https://solscan.io/account/${encodeURIComponent(walletAddress)}#portfolio`,
      formats: ["markdown"],
      onlyMainContent: false,
      maxAge: 0,
      storeInCache: false,
      proxy: "auto",
      removeBase64Images: true,
      blockAds: true,
      waitFor: 8000,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Firecrawl Solscan scrape failed (${response.status}): ${text}`);
  }

  const payload = (await response.json()) as FirecrawlScrapeResponse;
  if (!payload.success) {
    throw new Error(payload.error || "Firecrawl returned an unsuccessful Solscan response");
  }

  const holdings = parseSolscanPortfolioMarkdown(String(payload.data?.markdown || ""), options.minBalanceUsd ?? 111);
  const balances = holdings.map(toSolanaTokenBalance);

  return {
    totalCount: balances.length,
    totalBalanceUsd: balances.reduce((sum, balance) => sum + balance.balanceUsd, 0),
    balances,
    holdings,
  };
}

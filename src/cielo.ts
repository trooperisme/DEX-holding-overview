import { TokenBalance } from "./types";
import { getCieloProviderConfig } from "./holdings-provider";

const CIELO_PARSER_VERSION = "cielo-portfolio-v1";
const EVM_ADDRESS_RE = /0x[a-fA-F0-9]{40}/;
const SOLANA_ADDRESS_RE = /[1-9A-HJ-NP-Za-km-z]{32,44}/;
const EVM_NATIVE_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000000";

export type CieloParsedPortfolio = {
  balances: TokenBalance[];
  displayedTotalUsd: number | null;
  parsedTotalUsd: number;
  unknownChainRows: number;
  unknownChainValueUsd: number;
};

export type CieloScrapeMetadata = {
  bundleId: string;
  elapsedMs: number;
  rowCount: number;
  displayedTotalUsd: number | null;
  parsedTotalUsd: number;
  unknownChainRows: number;
  unknownChainValueUsd: number;
  parserVersion: string;
};

export type CieloScrapeResult = {
  balances: TokenBalance[];
  metadata: CieloScrapeMetadata;
};

export type CieloFetchOptions = {
  firecrawlApiKey: string;
  bundleUrl: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  waitMs?: number;
  timeoutMs?: number;
  retries?: number;
  retryBaseMs?: number;
  rateLimitRetryMs?: number;
  retryMaxMs?: number;
  cacheMaxAgeMs?: number;
  storeInCache?: boolean;
};

type CieloTableColumns = {
  token: number;
  symbol: number | null;
  chain: number | null;
  amount: number | null;
  price: number | null;
  value: number;
};

function splitMarkdownTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function stripMarkdown(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/\\([|*_])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function markdownCellLines(value: string): string[] {
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "\n")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .split(/\n+/)
    .map((line) => line.replace(/\\([|*_])/g, "$1").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function extractUrls(value: string): string[] {
  return Array.from(value.matchAll(/https?:\/\/[^\s)]+/g), (match) => match[0]);
}

function parseNumeric(value: string): number | null {
  const normalized = value.replace(/[$,%\s]/g, "").replace(/,/g, "").trim();
  if (!normalized || normalized === "-") return null;
  const match = normalized.match(/^(-?\d+(?:\.\d+)?)([KMB])?$/i);
  if (!match) return null;
  const multiplier = { K: 1e3, M: 1e6, B: 1e9 }[String(match[2] || "").toUpperCase() as "K" | "M" | "B"] || 1;
  const parsed = Number(match[1]) * multiplier;
  return Number.isFinite(parsed) ? parsed : null;
}

function parseUsd(value: string): number | null {
  const match = value.match(/(?:\$|USD\s*)\s*(-?\d[\d,]*(?:\.\d+)?\s*[KMB]?)/i);
  return parseNumeric(match?.[1] || value);
}

function normalizedHeader(value: string): string {
  return stripMarkdown(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function findColumn(headers: string[], patterns: RegExp[]): number | null {
  const index = headers.findIndex((header) => patterns.some((pattern) => pattern.test(header)));
  return index >= 0 ? index : null;
}

function findTableColumns(headerCells: string[]): CieloTableColumns | null {
  const headers = headerCells.map(normalizedHeader);
  const token = findColumn(headers, [/^token$/, /asset/, /token name/]);
  const value = findColumn(headers, [/usd value/, /value usd/, /total value/, /value/, /worth/]);
  if (token == null || value == null) return null;

  return {
    token,
    symbol: findColumn(headers, [/^symbol$/, /ticker/]),
    chain: findColumn(headers, [/^chain$/, /network/]),
    amount: findColumn(headers, [/amount/, /balance/, /quantity/]),
    price: findColumn(headers, [/^price$/, /token price/]),
    value,
  };
}

function inferChain(value: string): { networkName: string; chainId: number | null } {
  const normalized = value.toLowerCase();
  if (/\bethereum\b|\beth\b/.test(normalized)) return { networkName: "Ethereum", chainId: 1 };
  if (/\bbase\b/.test(normalized)) return { networkName: "Base", chainId: 8453 };
  if (/\bsolana\b|\bsol\b/.test(normalized)) return { networkName: "Solana", chainId: 1151111081 };
  if (/\barbitrum\b|\barb\b/.test(normalized)) return { networkName: "Arbitrum", chainId: 42161 };
  if (/\bbnb\b|\bbsc\b|\bbinance\b/.test(normalized)) return { networkName: "BNB", chainId: 56 };
  if (normalized.includes("hyperevm") || normalized.includes("hyperliquid") || normalized.includes("hyper")) return { networkName: "HyperEVM", chainId: 999 };
  if (normalized.includes("robinhood")) return { networkName: "Robinhood", chainId: null };
  return { networkName: "Unknown", chainId: null };
}

function extractAddress(value: string): string | null {
  const evm = value.match(EVM_ADDRESS_RE)?.[0];
  if (evm) return evm;
  for (const url of extractUrls(value)) {
    const pathParts = new URL(url).pathname.split("/").filter(Boolean);
    const candidate = (pathParts.at(-1) || "").replace(/\.(webp|png|jpe?g|svg)$/i, "");
    if (SOLANA_ADDRESS_RE.test(candidate) && candidate.length >= 32) return candidate;
  }
  return null;
}

function inferChainFromRow(row: string[]): { networkName: string; chainId: number | null } {
  const source = row.join(" ");
  return inferChain(source);
}

function isShortAddressLabel(value: string): boolean {
  return /^0x[a-f0-9]{2,6}\.\.\.[a-f0-9]{3,8}$/i.test(value) || /^[1-9A-HJ-NP-Za-km-z]{3,8}\.\.\.[1-9A-HJ-NP-Za-km-z]{3,8}$/.test(value);
}

function parseTokenIdentity(value: string, symbolCell: string | null): { tokenName: string; tokenSymbol: string } {
  const label = stripMarkdown(value);
  const explicitSymbol = markdownCellLines(symbolCell || "")[0] || stripMarkdown(symbolCell || "");
  if (explicitSymbol) {
    return { tokenName: label || explicitSymbol, tokenSymbol: explicitSymbol.toUpperCase() };
  }

  const lines = markdownCellLines(value).filter((line) => !isShortAddressLabel(line));
  if (lines.length) {
    const tokenSymbol = lines[0].replace(/[^\w$-]/g, "").toUpperCase() || "UNKNOWN";
    return { tokenName: lines[1] || lines[0] || tokenSymbol, tokenSymbol };
  }

  const parts = label.split(/\s+-\s+|\s+\|\s+/).map((part) => part.trim()).filter(Boolean);
  const tokenSymbol = (parts[0] || label || "UNKNOWN").replace(/[^\w$-]/g, "").toUpperCase() || "UNKNOWN";
  return { tokenName: parts[1] || label || tokenSymbol, tokenSymbol };
}

function parseAmount(value: string): string {
  const firstLine = markdownCellLines(value)[0] || stripMarkdown(value);
  const parsed = parseNumeric(firstLine);
  if (parsed != null) return String(parsed);
  return firstLine.replace(/,/g, "") || "0";
}

function inferNativeTokenAddress(tokenSymbol: string, chain: { networkName: string; chainId: number | null }): string | null {
  const symbol = tokenSymbol.toUpperCase();
  if (chain.chainId === 999 && symbol === "HYPE") return EVM_NATIVE_TOKEN_ADDRESS;
  if (chain.chainId === 56 && symbol === "BNB") return EVM_NATIVE_TOKEN_ADDRESS;
  if ([1, 10, 42161, 8453, 81457, 5000, 130, 480, 534352, 7777777].includes(chain.chainId ?? -1) && symbol === "ETH") {
    return EVM_NATIVE_TOKEN_ADDRESS;
  }
  return null;
}

function findDisplayedTotal(markdown: string): number | null {
  for (const line of markdown.split(/\r?\n/)) {
    if (!/(total|portfolio value|net worth)/i.test(line) || /\|/.test(line)) continue;
    const match = line.match(/(?:\$|USD\s*)\s*(-?\d[\d,]*(?:\.\d+)?\s*[KMB]?)/i);
    const value = parseNumeric(match?.[1] || "");
    if (value != null) return value;
  }
  return null;
}

class CieloFirecrawlError extends Error {
  status: number | null;
  retryAfterMs: number | null;

  constructor(message: string, status: number | null = null, retryAfterMs: number | null = null) {
    super(message);
    this.name = "CieloFirecrawlError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.trunc(seconds * 1000));
  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) return null;
  return Math.max(0, dateMs - Date.now());
}

function isRetryableFirecrawlError(error: unknown): boolean {
  if (error instanceof CieloFirecrawlError) {
    if (error.status == null) return /timeout|timed out/i.test(error.message);
    return [408, 409, 425, 429, 500, 502, 503, 504].includes(error.status);
  }
  if (error instanceof TypeError) return /fetch failed|network/i.test(error.message);
  return false;
}

function isRetryableCieloParseError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /portfolio table is missing|portfolio table contains no parseable rows|parsed zero rows with nonzero displayed total/i.test(error.message);
}

function getRetryDelayMs(error: unknown, attempt: number, options: {
  retryBaseMs: number;
  rateLimitRetryMs: number;
  retryMaxMs: number;
}): number {
  if (error instanceof CieloFirecrawlError && error.retryAfterMs != null) {
    return Math.min(options.retryMaxMs, error.retryAfterMs);
  }
  const base = error instanceof CieloFirecrawlError && error.status === 429
    ? options.rateLimitRetryMs
    : options.retryBaseMs;
  return Math.min(options.retryMaxMs, base * (2 ** attempt));
}

export function extractCieloBundleId(bundleUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(bundleUrl);
  } catch {
    throw new Error(`Invalid Cielo portfolio URL: ${bundleUrl}`);
  }
  const match = parsed.pathname.match(/^\/bundles\/(\d+)\/portfolio\/?$/);
  if (parsed.hostname !== "app.cielo.finance" || !match) {
    throw new Error(`Invalid Cielo portfolio URL: ${bundleUrl}`);
  }
  return match[1];
}

export function parseCieloPortfolioMarkdown(markdown: string): CieloParsedPortfolio {
  if (/bundle\s+not\s+found/i.test(markdown)) {
    throw new Error("Bundle not found");
  }

  const lines = markdown.split(/\r?\n/);
  const balances: TokenBalance[] = [];
  let columns: CieloTableColumns | null = null;

  for (let index = 0; index < lines.length - 1; index += 1) {
    if (!lines[index].trim().startsWith("|")) continue;
    const headerCells = splitMarkdownTableRow(lines[index]);
    if (!/^\s*\|?\s*:?-{2,}/.test(lines[index + 1])) continue;
    columns = findTableColumns(headerCells);
    if (!columns) continue;

    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const line = lines[rowIndex];
      if (!line.trim().startsWith("|")) break;
      const cells = splitMarkdownTableRow(line);
      if (cells.length <= columns.value || cells.length <= columns.token) continue;
      const balanceUsd = parseUsd(cells[columns.value]);
      if (balanceUsd == null) continue;

      const tokenIdentity = parseTokenIdentity(cells[columns.token], columns.symbol == null ? null : cells[columns.symbol]);
      const rowSource = cells.join(" ");
      const chainSource = columns.chain == null ? extractUrls(rowSource).join(" ") : cells[columns.chain];
      const chain = inferChain(chainSource);
      const tokenAddress = extractAddress(rowSource) || inferNativeTokenAddress(tokenIdentity.tokenSymbol, chain);
      const amount = columns.amount == null ? "0" : parseAmount(cells[columns.amount]);
      const price = columns.price == null ? null : parseUsd(cells[columns.price]);
      balances.push({
        ...tokenIdentity,
        tokenAddress,
        networkName: chain.networkName,
        chainId: chain.chainId,
        balance: amount || "0",
        balanceRaw: amount || "0",
        balanceUsd,
        price,
        marketCap: null,
        liquidityUsd: null,
        volume24h: null,
        txns24h: null,
        tokenAgeHours: null,
      });
    }
    break;
  }

  if (!columns) throw new Error("Cielo portfolio table is missing");
  if (!balances.length) {
    const displayedTotalUsd = findDisplayedTotal(markdown);
    if (displayedTotalUsd === 0) {
      return {
        balances: [],
        displayedTotalUsd,
        parsedTotalUsd: 0,
        unknownChainRows: 0,
        unknownChainValueUsd: 0,
      };
    }
    if (displayedTotalUsd != null && displayedTotalUsd > 0) {
      throw new Error(`Cielo portfolio parsed zero rows with nonzero displayed total ($${displayedTotalUsd.toFixed(2)})`);
    }
    throw new Error("Cielo portfolio table contains no parseable rows");
  }

  const displayedTotalUsd = findDisplayedTotal(markdown);
  const unknownRows = balances.filter((balance) => balance.chainId == null && balance.networkName === "Unknown");
  return {
    balances,
    displayedTotalUsd,
    parsedTotalUsd: balances.reduce((sum, balance) => sum + balance.balanceUsd, 0),
    unknownChainRows: unknownRows.length,
    unknownChainValueUsd: unknownRows.reduce((sum, balance) => sum + balance.balanceUsd, 0),
  };
}

export function validateCieloTotals(parsedTotalUsd: number, displayedTotalUsd: number): void {
  const difference = Math.abs(parsedTotalUsd - displayedTotalUsd);
  const allowedDifference = Math.max(5, Math.abs(displayedTotalUsd) * 0.01);
  if (difference > allowedDifference) {
    throw new Error(
      `Cielo total mismatch: displayed $${displayedTotalUsd.toFixed(2)}, parsed $${parsedTotalUsd.toFixed(2)}, difference $${difference.toFixed(2)}`,
    );
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Refresh canceled", "AbortError"));
    }, { once: true });
  });
}

async function scrapeOnce(options: CieloFetchOptions, requestConfig: {
  timeoutMs: number;
  waitMs: number;
  cacheMaxAgeMs: number;
  storeInCache: boolean;
}): Promise<string> {
  const controller = new AbortController();
  let requestTimedOut = false;
  const timeout = setTimeout(() => {
    requestTimedOut = true;
    controller.abort();
  }, requestConfig.timeoutMs);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await (options.fetchImpl || fetch)("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.firecrawlApiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        url: options.bundleUrl,
        formats: ["markdown"],
        onlyMainContent: false,
        maxAge: requestConfig.cacheMaxAgeMs,
        storeInCache: requestConfig.storeInCache,
        proxy: "auto",
        removeBase64Images: true,
        blockAds: true,
        waitFor: requestConfig.waitMs,
        timeout: requestConfig.timeoutMs,
      }),
    });
    if (!response.ok) {
      throw new CieloFirecrawlError(
        response.status === 429 ? "Firecrawl Cielo scrape rate-limited (429)" : `Firecrawl Cielo scrape failed (${response.status})`,
        response.status,
        parseRetryAfterMs(response.headers.get("retry-after")),
      );
    }
    const payload = (await response.json()) as { success?: boolean; data?: { markdown?: string }; error?: string };
    if (!payload.success) throw new Error(payload.error || "Firecrawl returned an unsuccessful Cielo response");
    return String(payload.data?.markdown || "");
  } catch (error) {
    if (requestTimedOut) {
      throw new CieloFirecrawlError(`Firecrawl Cielo scrape timed out after ${requestConfig.timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

export async function fetchCieloPortfolio(options: CieloFetchOptions): Promise<CieloScrapeResult> {
  const bundleId = extractCieloBundleId(options.bundleUrl);
  const config = getCieloProviderConfig();
  const timeoutMs = options.timeoutMs ?? config.timeoutMs;
  const waitMs = options.waitMs ?? config.waitMs;
  const retries = options.retries ?? config.retries;
  const retryBaseMs = options.retryBaseMs ?? config.retryBaseMs;
  const rateLimitRetryMs = options.rateLimitRetryMs ?? config.rateLimitRetryMs;
  const retryMaxMs = options.retryMaxMs ?? config.retryMaxMs;
  const cacheMaxAgeMs = options.cacheMaxAgeMs ?? config.cacheMaxAgeMs;
  const storeInCache = options.storeInCache ?? config.storeInCache;
  const startedAt = Date.now();
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const markdown = await scrapeOnce(options, {
        timeoutMs,
        waitMs,
        cacheMaxAgeMs: attempt === 0 ? cacheMaxAgeMs : 0,
        storeInCache: attempt === 0 ? storeInCache : false,
      });
      const parsed = parseCieloPortfolioMarkdown(markdown);
      if (parsed.displayedTotalUsd != null) {
        validateCieloTotals(parsed.parsedTotalUsd, parsed.displayedTotalUsd);
      }
      return {
        balances: parsed.balances,
        metadata: {
          bundleId,
          elapsedMs: Date.now() - startedAt,
          rowCount: parsed.balances.length,
          displayedTotalUsd: parsed.displayedTotalUsd,
          parsedTotalUsd: parsed.parsedTotalUsd,
          unknownChainRows: parsed.unknownChainRows,
          unknownChainValueUsd: parsed.unknownChainValueUsd,
          parserVersion: CIELO_PARSER_VERSION,
        },
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError" && options.signal?.aborted) throw error;
      lastError = error;
      if (attempt >= retries || (!isRetryableFirecrawlError(error) && !isRetryableCieloParseError(error))) break;
      await delay(getRetryDelayMs(error, attempt, { retryBaseMs, rateLimitRetryMs, retryMaxMs }), options.signal);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError || "Cielo scrape failed"));
}

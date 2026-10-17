type DexScreenerPair = {
  chainId?: string;
  baseToken?: {
    address?: string;
    name?: string;
    symbol?: string;
  };
  liquidity?: {
    usd?: number | null;
  } | null;
  volume?: {
    h24?: number | null;
  } | null;
  txns?: {
    h24?: {
      buys?: number | null;
      sells?: number | null;
    } | null;
  } | null;
  marketCap?: number | null;
  fdv?: number | null;
  pairCreatedAt?: number | null;
};

export type DexScreenerMarketData = {
  marketCap: number | null;
  liquidityUsd: number | null;
  volume24h: number | null;
  txns24h: number | null;
  tokenAgeHours: number | null;
};

const DEXSCREENER_BATCH_LIMIT = 30;
const DEXSCREENER_MAX_ATTEMPTS = 3;
const TOKEN_PAIR_FALLBACK_INTERVAL_MS = 300;
const TOKEN_PAIR_FALLBACK_CONCURRENCY = 4;
let nextTokenPairFallbackAt = 0;

function chunk<T>(items: T[], size: number): T[][]
{
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    output.push(items.slice(index, index + size));
  }
  return output;
}

function normalizeAddress(address: string | null | undefined): string | null {
  return address ? address.toLowerCase() : null;
}

export function toDexScreenerChainId(chainId: number | null, networkName: string): string | null {
  if (chainId != null) {
    const direct = CHAIN_ID_MAP[chainId];
    if (direct) return direct;
  }

  const normalized = networkName.trim().toLowerCase();
  return NETWORK_NAME_MAP[normalized] || null;
}

function getPairTxns24h(pair: DexScreenerPair): number {
  return Number(pair.txns?.h24?.buys || 0) + Number(pair.txns?.h24?.sells || 0);
}

function getPairLiquidity(pair: DexScreenerPair): number {
  return Number(pair.liquidity?.usd || 0);
}

function getPairVolume24h(pair: DexScreenerPair): number {
  return Number(pair.volume?.h24 || 0);
}

function hasPositiveValue(value: number | null | undefined): boolean {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

export function pickBestPair(pairs: DexScreenerPair[]): DexScreenerPair | null {
  if (!pairs.length) return null;
  return [...pairs].sort((left, right) => {
    const liquidityGap = getPairLiquidity(right) - getPairLiquidity(left);
    if (liquidityGap !== 0) return liquidityGap;

    const volumeGap = getPairVolume24h(right) - getPairVolume24h(left);
    if (volumeGap !== 0) return volumeGap;

    const txnsGap = getPairTxns24h(right) - getPairTxns24h(left);
    if (txnsGap !== 0) return txnsGap;

    return Number(right.pairCreatedAt || 0) - Number(left.pairCreatedAt || 0);
  })[0];
}

function toMarketData(pairs: DexScreenerPair[]): DexScreenerMarketData {
  if (!pairs.length) {
    return {
      marketCap: null,
      liquidityUsd: null,
      volume24h: null,
      txns24h: null,
      tokenAgeHours: null,
    };
  }

  const bestPair = pickBestPair(pairs);
  const marketCapPair = pickBestPair(pairs.filter((pair) => hasPositiveValue(pair.marketCap)));
  const fdvPair = marketCapPair ? null : pickBestPair(pairs.filter((pair) => hasPositiveValue(pair.fdv)));
  const valuationPair = marketCapPair || fdvPair;
  const pairCreatedAt = Number(bestPair?.pairCreatedAt || 0);
  const tokenAgeHours =
    pairCreatedAt > 0 ? Math.max(0, (Date.now() - pairCreatedAt) / (1000 * 60 * 60)) : null;

  return {
    marketCap: valuationPair?.marketCap ?? valuationPair?.fdv ?? null,
    liquidityUsd: bestPair?.liquidity?.usd ?? null,
    volume24h: bestPair?.volume?.h24 ?? null,
    txns24h: bestPair ? getPairTxns24h(bestPair) : null,
    tokenAgeHours,
  };
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchJsonWithRetry(url: string): Promise<unknown> {
  let lastError: unknown = new Error("DexScreener request failed");
  for (let attempt = 0; attempt < DEXSCREENER_MAX_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      lastError = error;
      if (attempt < DEXSCREENER_MAX_ATTEMPTS - 1) await wait(200 * (2 ** attempt));
      continue;
    }

    if (!response.ok) {
      lastError = new Error(`DexScreener request failed with ${response.status}`);
      if (![429, 500, 502, 503, 504].includes(response.status)) break;
      const retryAfterSeconds = Number(response.headers.get("retry-after") || 0);
      const delay = retryAfterSeconds > 0
        ? Math.min(4_000, retryAfterSeconds * 1_000)
        : 200 * (2 ** attempt);
      if (attempt < DEXSCREENER_MAX_ATTEMPTS - 1) await wait(delay);
      continue;
    }

    try {
      return await response.json() as unknown;
    } catch (error) {
      lastError = error;
      if (attempt < DEXSCREENER_MAX_ATTEMPTS - 1) await wait(200 * (2 ** attempt));
    }
  }
  throw lastError;
}

async function fetchPairsWithRetry(url: string): Promise<DexScreenerPair[]> {
  const payload = await fetchJsonWithRetry(url);
  return Array.isArray(payload) ? payload as DexScreenerPair[] : [];
}

async function fetchDexScreenerPairs(chainId: string, tokenAddresses: string[]): Promise<DexScreenerPair[]> {
  const url = `https://api.dexscreener.com/tokens/v1/${chainId}/${tokenAddresses.join(",")}`;
  return fetchPairsWithRetry(url);
}

async function fetchDexScreenerTokenPairs(chainId: string, tokenAddress: string): Promise<DexScreenerPair[]> {
  const url = `https://api.dexscreener.com/token-pairs/v1/${chainId}/${tokenAddress}`;
  return fetchPairsWithRetry(url);
}

async function fetchDexScreenerSearchPairs(tokenAddress: string): Promise<DexScreenerPair[]> {
  const query = new URLSearchParams({ q: tokenAddress });
  const payload = await fetchJsonWithRetry(`https://api.dexscreener.com/latest/dex/search?${query}`);
  if (!payload || typeof payload !== "object" || !("pairs" in payload)) return [];
  const pairs = (payload as { pairs?: unknown }).pairs;
  return Array.isArray(pairs) ? pairs as DexScreenerPair[] : [];
}

async function waitForTokenPairFallbackSlot(): Promise<void> {
  const now = Date.now();
  const scheduledAt = Math.max(now, nextTokenPairFallbackAt);
  nextTokenPairFallbackAt = scheduledAt + TOKEN_PAIR_FALLBACK_INTERVAL_MS;
  if (scheduledAt > now) await wait(scheduledAt - now);
}

function mergeMarketData(
  primary: DexScreenerMarketData | undefined,
  fallback: DexScreenerMarketData,
): DexScreenerMarketData {
  if (!primary) return fallback;
  return {
    marketCap: primary.marketCap ?? fallback.marketCap,
    liquidityUsd: primary.liquidityUsd ?? fallback.liquidityUsd,
    volume24h: primary.volume24h ?? fallback.volume24h,
    txns24h: primary.txns24h ?? fallback.txns24h,
    tokenAgeHours: primary.tokenAgeHours ?? fallback.tokenAgeHours,
  };
}

function marketDataKey(chainId: string | null, tokenAddress: string): string {
  return `${chainId || "unknown"}:${tokenAddress}`;
}

export async function fetchDexScreenerMarketData(tokens: Array<{
  tokenAddress: string;
  chainId: number | null;
  networkName: string;
}>): Promise<Map<string, DexScreenerMarketData>> {
  const grouped = new Map<string, Set<string>>();
  const unknownAddresses = new Set<string>();
  for (const token of tokens) {
    const normalizedAddress = normalizeAddress(token.tokenAddress);
    if (!normalizedAddress) continue;
    const dexChainId = toDexScreenerChainId(token.chainId, token.networkName);
    if (!dexChainId) {
      unknownAddresses.add(normalizedAddress);
      continue;
    }
    if (!grouped.has(dexChainId)) grouped.set(dexChainId, new Set());
    grouped.get(dexChainId)!.add(normalizedAddress);
  }

  const results = new Map<string, DexScreenerMarketData>();
  const fallbackTargets: Array<{ chainId: string | null; tokenAddress: string }> =
    Array.from(unknownAddresses, (tokenAddress) => ({ chainId: null, tokenAddress }));
  for (const [dexChainId, addresses] of grouped.entries()) {
    for (const addressBatch of chunk(Array.from(addresses), DEXSCREENER_BATCH_LIMIT)) {
      let pairs: DexScreenerPair[];
      try {
        pairs = await fetchDexScreenerPairs(dexChainId, addressBatch);
      } catch (_error) {
        fallbackTargets.push(...addressBatch.map((tokenAddress) => ({ chainId: dexChainId, tokenAddress })));
        continue;
      }
      const byToken = new Map<string, DexScreenerPair[]>();

      for (const pair of pairs) {
        const tokenAddress = normalizeAddress(pair.baseToken?.address);
        if (!tokenAddress) continue;
        if (!byToken.has(tokenAddress)) byToken.set(tokenAddress, []);
        byToken.get(tokenAddress)!.push(pair);
      }

      for (const tokenAddress of addressBatch) {
        const tokenPairs = byToken.get(tokenAddress) || [];
        const marketData = toMarketData(tokenPairs);
        if (tokenPairs.length) results.set(marketDataKey(dexChainId, tokenAddress), marketData);
        if (marketData.marketCap == null) fallbackTargets.push({ chainId: dexChainId, tokenAddress });
      }
    }
  }

  let nextFallbackIndex = 0;
  const fallbackWorkers = Array.from(
    { length: Math.min(TOKEN_PAIR_FALLBACK_CONCURRENCY, fallbackTargets.length) },
    async () => {
      while (nextFallbackIndex < fallbackTargets.length) {
        const target = fallbackTargets[nextFallbackIndex];
        nextFallbackIndex += 1;
        await waitForTokenPairFallbackSlot();
        try {
          const pairs = target.chainId
            ? await fetchDexScreenerTokenPairs(target.chainId, target.tokenAddress)
            : (await fetchDexScreenerSearchPairs(target.tokenAddress)).filter(
              (pair) => normalizeAddress(pair.baseToken?.address) === target.tokenAddress,
            );
          const fallbackData = toMarketData(pairs);
          const key = marketDataKey(target.chainId, target.tokenAddress);
          const marketData = mergeMarketData(results.get(key), fallbackData);
          if (marketData.marketCap != null || pairs.length) results.set(key, marketData);
        } catch (_error) {
          // Keep any batch result and let the caller report unresolved market data.
        }
      }
    },
  );
  await Promise.all(fallbackWorkers);

  return results;
}

const CHAIN_ID_MAP: Record<number, string> = {
  1: "ethereum",
  10: "optimism",
  56: "bsc",
  100: "gnosis",
  130: "unichain",
  137: "polygon",
  146: "sonic",
  324: "zksync",
  8453: "base",
  42161: "arbitrum",
  43114: "avalanche",
  59144: "linea",
  81457: "blast",
  34443: "mode",
  999: "hyperevm",
  1151111081: "solana",
};

const NETWORK_NAME_MAP: Record<string, string> = {
  arbitrum: "arbitrum",
  avalanche: "avalanche",
  base: "base",
  "bnb chain": "bsc",
  ethereum: "ethereum",
  gnosis: "gnosis",
  hyperevm: "hyperevm",
  "hyper evm": "hyperevm",
  "hyperliquid evm": "hyperevm",
  linea: "linea",
  mode: "mode",
  optimism: "optimism",
  polygon: "polygon",
  robinhood: "robinhood",
  solana: "solana",
  sonic: "sonic",
  unichain: "unichain",
  zksync: "zksync",
};

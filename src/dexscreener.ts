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

function toMarketData(pair: DexScreenerPair | null): DexScreenerMarketData {
  if (!pair) {
    return {
      marketCap: null,
      liquidityUsd: null,
      volume24h: null,
      txns24h: null,
      tokenAgeHours: null,
    };
  }

  const pairCreatedAt = Number(pair.pairCreatedAt || 0);
  const tokenAgeHours =
    pairCreatedAt > 0 ? Math.max(0, (Date.now() - pairCreatedAt) / (1000 * 60 * 60)) : null;

  return {
    marketCap: pair.marketCap ?? pair.fdv ?? null,
    liquidityUsd: pair.liquidity?.usd ?? null,
    volume24h: pair.volume?.h24 ?? null,
    txns24h: getPairTxns24h(pair),
    tokenAgeHours,
  };
}

async function fetchDexScreenerPairs(chainId: string, tokenAddresses: string[]): Promise<DexScreenerPair[]> {
  const url = `https://api.dexscreener.com/tokens/v1/${chainId}/${tokenAddresses.join(",")}`;
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`DexScreener request failed with ${response.status}`);
  }

  const payload = (await response.json()) as DexScreenerPair[];
  return Array.isArray(payload) ? payload : [];
}

export async function fetchDexScreenerMarketData(tokens: Array<{
  tokenAddress: string;
  chainId: number | null;
  networkName: string;
}>): Promise<Map<string, DexScreenerMarketData>> {
  const grouped = new Map<string, Set<string>>();
  for (const token of tokens) {
    const normalizedAddress = normalizeAddress(token.tokenAddress);
    if (!normalizedAddress) continue;
    const dexChainId = toDexScreenerChainId(token.chainId, token.networkName);
    if (!dexChainId) continue;
    if (!grouped.has(dexChainId)) grouped.set(dexChainId, new Set());
    grouped.get(dexChainId)!.add(normalizedAddress);
  }

  const results = new Map<string, DexScreenerMarketData>();
  for (const [dexChainId, addresses] of grouped.entries()) {
    for (const addressBatch of chunk(Array.from(addresses), DEXSCREENER_BATCH_LIMIT)) {
      const pairs = await fetchDexScreenerPairs(dexChainId, addressBatch);
      const byToken = new Map<string, DexScreenerPair[]>();

      for (const pair of pairs) {
        const tokenAddress = normalizeAddress(pair.baseToken?.address);
        if (!tokenAddress) continue;
        if (!byToken.has(tokenAddress)) byToken.set(tokenAddress, []);
        byToken.get(tokenAddress)!.push(pair);
      }

      for (const tokenAddress of addressBatch) {
        const bestPair = pickBestPair(byToken.get(tokenAddress) || []);
        results.set(`${dexChainId}:${tokenAddress}`, toMarketData(bestPair));
      }
    }
  }

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
  1151111081: "solana",
};

const NETWORK_NAME_MAP: Record<string, string> = {
  arbitrum: "arbitrum",
  avalanche: "avalanche",
  base: "base",
  "bnb chain": "bsc",
  ethereum: "ethereum",
  gnosis: "gnosis",
  linea: "linea",
  mode: "mode",
  optimism: "optimism",
  polygon: "polygon",
  solana: "solana",
  sonic: "sonic",
  unichain: "unichain",
  zksync: "zksync",
};

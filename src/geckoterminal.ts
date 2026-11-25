import { canonicalAddress } from "./market-cap";
export type GeckoTerminalMarketData = {
  marketCap: number | null;
  liquidityUsd: number | null;
  volume24h: number | null;
  txns24h: number | null;
  tokenAgeHours: number | null;
};

type JsonRecord = Record<string, unknown>;

const GECKO_TERMINAL_BASE_URL = "https://api.geckoterminal.com/api/v2";
const GECKO_TERMINAL_BATCH_LIMIT = 30;
const GECKO_TERMINAL_REQUEST_INTERVAL_MS = 6_100;
const GECKO_TERMINAL_MAX_ATTEMPTS = 3;
let nextRequestAt = 0;

function chunk<T>(items: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += size)
    output.push(items.slice(index, index + size));
  return output;
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function asNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nestedNumber(value: unknown, key: string): number | null {
  return asNumber(asRecord(value)?.[key]);
}

function normalizeAddress(value: string): string {
  return canonicalAddress(value);
}

export function toGeckoTerminalNetworkId(
  chainId: number | null,
  networkName: string,
): string | null {
  if (chainId != null && CHAIN_ID_MAP[chainId]) return CHAIN_ID_MAP[chainId];
  return NETWORK_NAME_MAP[networkName.trim().toLowerCase()] || null;
}

function emptyMarketData(): GeckoTerminalMarketData {
  return {
    marketCap: null,
    liquidityUsd: null,
    volume24h: null,
    txns24h: null,
    tokenAgeHours: null,
  };
}

function elapsedHours(createdAt: unknown): number | null {
  if (typeof createdAt !== "string") return null;
  const createdAtMs = Date.parse(createdAt);
  if (!Number.isFinite(createdAtMs)) return null;
  return Math.max(0, (Date.now() - createdAtMs) / 3_600_000);
}

function getH24Transactions(poolAttributes: JsonRecord): number | null {
  const h24 = asRecord(asRecord(poolAttributes.transactions)?.h24);
  if (!h24) return null;
  const buys = asNumber(h24.buys) ?? 0;
  const sells = asNumber(h24.sells) ?? 0;
  return buys + sells;
}

export function marketDataFromToken(
  token: JsonRecord,
  includedById: Map<string, JsonRecord>,
): GeckoTerminalMarketData {
  const attributes = asRecord(token.attributes) || {};
  const relationship = asRecord(asRecord(token.relationships)?.top_pools);
  const poolReferences = Array.isArray(relationship?.data)
    ? relationship.data
    : [];
  const pools = poolReferences
    .map((reference) => {
      const id = asRecord(reference)?.id;
      return typeof id === "string" ? includedById.get(id) : undefined;
    })
    .filter((pool): pool is JsonRecord => Boolean(pool));
  const bestPool = [...pools].sort((left, right) => {
    const leftAttributes = asRecord(left.attributes) || {};
    const rightAttributes = asRecord(right.attributes) || {};
    return (
      (asNumber(rightAttributes.reserve_in_usd) ?? 0) -
      (asNumber(leftAttributes.reserve_in_usd) ?? 0)
    );
  })[0];
  const poolAttributes = asRecord(bestPool?.attributes) || {};

  return {
    // GeckoTerminal's market_cap_usd is intentionally used as-is. FDV is not a substitute.
    marketCap: asNumber(attributes.market_cap_usd),
    liquidityUsd: asNumber(poolAttributes.reserve_in_usd),
    volume24h: nestedNumber(poolAttributes.volume_usd, "h24"),
    txns24h: getH24Transactions(poolAttributes),
    // Oldest returned top-pool timestamp is a pool-age proxy, not guaranteed first trade.
    tokenAgeHours: (() => {
      const dates = pools
        .map((p) => asRecord(p.attributes)?.pool_created_at)
        .filter(
          (d): d is string =>
            typeof d === "string" && Number.isFinite(Date.parse(d)),
        );
      return dates.length
        ? elapsedHours(dates.sort((a, b) => Date.parse(a) - Date.parse(b))[0])
        : null;
    })(),
  };
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForRequestSlot(): Promise<void> {
  const now = Date.now();
  const scheduledAt = Math.max(now, nextRequestAt);
  nextRequestAt = scheduledAt + GECKO_TERMINAL_REQUEST_INTERVAL_MS;
  if (scheduledAt > now) await wait(scheduledAt - now);
}

async function fetchBatch(
  networkId: string,
  addresses: string[],
): Promise<unknown> {
  const path = `/networks/${encodeURIComponent(networkId)}/tokens/multi/${addresses.map(encodeURIComponent).join(",")}`;
  const url = new URL(`${GECKO_TERMINAL_BASE_URL}${path}`);
  url.searchParams.set("include", "top_pools");
  let lastError: unknown = new Error("GeckoTerminal request failed");

  for (let attempt = 0; attempt < GECKO_TERMINAL_MAX_ATTEMPTS; attempt += 1) {
    await waitForRequestSlot();
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { accept: "application/json;version=20230203" },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      lastError = error;
      if (attempt < GECKO_TERMINAL_MAX_ATTEMPTS - 1)
        await wait(2_000 * 2 ** attempt);
      continue;
    }

    if (!response.ok) {
      lastError = new Error(
        `GeckoTerminal request failed with ${response.status}`,
      );
      if (![429, 500, 502, 503, 504].includes(response.status)) break;
      const retryAfter = asNumber(response.headers.get("retry-after"));
      const delay =
        retryAfter != null && retryAfter > 0
          ? Math.min(30_000, retryAfter * 1_000)
          : 6_000 * 2 ** attempt;
      if (attempt < GECKO_TERMINAL_MAX_ATTEMPTS - 1) await wait(delay);
      continue;
    }

    return response.json() as Promise<unknown>;
  }
  throw lastError;
}

export async function fetchGeckoTerminalMarketData(
  tokens: Array<{
    tokenAddress: string;
    chainId: number | null;
    networkName: string;
  }>,
): Promise<Map<string, GeckoTerminalMarketData>> {
  const grouped = new Map<string, Set<string>>();
  for (const token of tokens) {
    const networkId = toGeckoTerminalNetworkId(
      token.chainId,
      token.networkName,
    );
    if (!networkId || !token.tokenAddress.trim()) continue;
    if (!grouped.has(networkId)) grouped.set(networkId, new Set());
    grouped.get(networkId)!.add(normalizeAddress(token.tokenAddress.trim()));
  }

  const results = new Map<string, GeckoTerminalMarketData>();
  for (const [networkId, addressSet] of grouped) {
    const addresses = [...addressSet];
    for (const addressBatch of chunk(addresses, GECKO_TERMINAL_BATCH_LIMIT)) {
      let payload: JsonRecord | null;
      try {
        payload = asRecord(await fetchBatch(networkId, addressBatch));
      } catch (_error) {
        // One failed or unsupported batch must not discard data from other networks.
        continue;
      }
      const data = Array.isArray(payload?.data) ? payload.data : [];
      const included = Array.isArray(payload?.included) ? payload.included : [];
      const includedById = new Map<string, JsonRecord>();
      for (const item of included) {
        const record = asRecord(item);
        if (typeof record?.id === "string") includedById.set(record.id, record);
      }

      // Mark every address in a successful batch as resolved, even if Gecko has
      // no token/pool attributes. A missing Map entry then means request failure.
      for (const address of addressBatch)
        results.set(`${networkId}:${address}`, emptyMarketData());

      const addressSetForBatch = new Set(addressBatch);
      for (const item of data) {
        const token = asRecord(item);
        const attributes = asRecord(token?.attributes);
        const address =
          typeof attributes?.address === "string"
            ? normalizeAddress(attributes.address)
            : "";
        if (!token || !addressSetForBatch.has(address)) continue;
        results.set(
          `${networkId}:${address}`,
          marketDataFromToken(token, includedById),
        );
      }
    }
  }
  return results;
}

const CHAIN_ID_MAP: Record<number, string> = {
  1: "eth",
  10: "optimism",
  56: "bsc",
  100: "xdai",
  130: "unichain",
  137: "polygon_pos",
  146: "sonic",
  324: "zksync",
  8453: "base",
  42161: "arbitrum",
  43114: "avax",
  59144: "linea",
  81457: "blast",
  34443: "mode",
  999: "hyperevm",
  1151111081: "solana",
};

const NETWORK_NAME_MAP: Record<string, string> = {
  arbitrum: "arbitrum",
  avalanche: "avax",
  base: "base",
  bnb: "bsc",
  "bnb chain": "bsc",
  ethereum: "eth",
  gnosis: "xdai",
  hyperevm: "hyperevm",
  "hyper evm": "hyperevm",
  "hyperliquid evm": "hyperevm",
  linea: "linea",
  mode: "mode",
  optimism: "optimism",
  polygon: "polygon_pos",
  robinhood: "robinhood",
  solana: "solana",
  sonic: "sonic",
  unichain: "unichain",
  zksync: "zksync",
};

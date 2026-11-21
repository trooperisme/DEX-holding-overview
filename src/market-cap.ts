import { legacyMarketCapEvidence, MarketCapEvidence } from "./market-cap-types";

export type MarketCapToken = {
  tokenAddress: string;
  chainId: number | null;
  networkName: string;
};
export type MarketCapQuote = {
  marketCap: number | null;
  marketCapEvidence: MarketCapEvidence;
};
type Json = Record<string, any>;
type ApiOptions = {
  fetcher?: typeof fetch;
  coingeckoKey?: string;
  coinmarketcapKey?: string;
  tier?: string;
  now?: () => number;
};
export function canonicalAddress(address: string): string {
  return /^0x[0-9a-f]+$/i.test(address) ? address.toLowerCase() : address;
}
const PLATFORM: Record<number, string> = {
  1: "ethereum",
  10: "optimistic-ethereum",
  56: "binance-smart-chain",
  100: "xdai",
  137: "polygon-pos",
  146: "sonic",
  324: "zksync",
  8453: "base",
  42161: "arbitrum-one",
  43114: "avalanche",
  59144: "linea",
  81457: "blast",
  130: "unichain",
  999: "hyperevm",
  1151111081: "solana",
};
const PLATFORM_ALIASES: Record<string, string> = {
  eth: "ethereum",
  ethereum: "ethereum",
  solana: "solana",
  base: "base",
  arbitrum: "arbitrum-one",
  optimism: "optimistic-ethereum",
  bsc: "binance-smart-chain",
  "bnb chain": "binance-smart-chain",
  polygon: "polygon-pos",
  avalanche: "avalanche",
  zksync: "zksync",
  hyperevm: "hyperevm",
  sonic: "sonic",
  linea: "linea",
  unichain: "unichain",
  gnosis: "xdai",
};
export function coinGeckoPlatform(token: MarketCapToken): string | null {
  if (token.chainId != null) return PLATFORM[token.chainId] || null;
  return PLATFORM_ALIASES[token.networkName.toLowerCase()] || null;
}
function unknownChain(token: MarketCapToken): boolean {
  return (
    token.chainId == null &&
    ["", "unknown"].includes(token.networkName.trim().toLowerCase())
  );
}
export function canQueryMarketCapToken(token: MarketCapToken): boolean {
  const platform = coinGeckoPlatform(token);
  if (!platform && !unknownChain(token)) return false;
  return platform === "solana"
    ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(token.tokenAddress)
    : platform
      ? /^0x[0-9a-fA-F]{40}$/.test(token.tokenAddress)
      : /^0x[0-9a-fA-F]{40}$/.test(token.tokenAddress) ||
        /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(token.tokenAddress);
}
function cgIdentityIndex(
  coins: Json[],
): Map<string, Array<{ id: string; platform: string }>> {
  const index = new Map<string, Array<{ id: string; platform: string }>>();
  for (const coin of coins)
    for (const [platform, address] of Object.entries(coin.platforms || {})) {
      if (typeof address !== "string" || !address) continue;
      const key = canonicalAddress(address);
      const entries = index.get(key) || [];
      entries.push({ id: String(coin.id), platform });
      index.set(key, entries);
    }
  return index;
}
function cgIdentity(
  token: MarketCapToken,
  index: ReturnType<typeof cgIdentityIndex>,
) {
  const platform = coinGeckoPlatform(token);
  if (!canQueryMarketCapToken(token))
    return { id: null, platforms: [] as string[], ambiguous: false };
  const entries = (
    index.get(canonicalAddress(token.tokenAddress)) || []
  ).filter((e) => !platform || e.platform === platform);
  const ids = [...new Set(entries.map((e) => e.id))];
  return {
    id: ids.length === 1 ? ids[0] : null,
    platforms: [...new Set(entries.map((e) => e.platform))],
    ambiguous: ids.length > 1,
  };
}
let coinListCache: { at: number; coins: Json[] } | null = null;
async function coinList(
  c: ReturnType<typeof client>,
  bypassCache: boolean,
): Promise<Json[]> {
  if (!c.cgEnabled) return [];
  if (!bypassCache && coinListCache && c.now() - coinListCache.at < 6 * 3600000)
    return coinListCache.coins;
  const data = await c.get("cg", "/coins/list?include_platform=true");
  const coins = Array.isArray(data) ? data : [];
  if (!bypassCache && coins.length) coinListCache = { at: c.now(), coins };
  return coins;
}
function identityQuote(
  quote: MarketCapQuote,
  token: MarketCapToken,
  cgPlatforms: string[],
  cmcPlatforms: string[],
  ambiguous = false,
): MarketCapQuote {
  quote.marketCapEvidence.identityMatch = unknownChain(token)
    ? "unique-contract"
    : "chain-contract";
  if (
    ambiguous ||
    (quote.marketCapEvidence.coingecko &&
      quote.marketCapEvidence.coinmarketcap &&
      !cgPlatforms.some((p) => cmcPlatforms.includes(p)))
  ) {
    return {
      marketCap: null,
      marketCapEvidence: {
        ...quote.marketCapEvidence,
        status: "conflict",
        identityMatch: "ambiguous",
        source: "none",
        note: "Contract identity is ambiguous across assets or chains; no market cap is selected.",
      },
    };
  }
  if (unknownChain(token))
    quote.marketCapEvidence.note =
      quote.marketCap != null
        ? "Asset resolved by exact contract when unique; the holdings chain remains unknown."
        : "An unambiguous market cap could not be verified; the holdings chain remains unknown.";
  return quote;
}
export function marketCapTokenKey(token: MarketCapToken): string {
  return `${coinGeckoPlatform(token) || token.networkName.toLowerCase()}:${canonicalAddress(token.tokenAddress.trim())}`;
}
const positive = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};
function client(options: ApiOptions = {}) {
  const cgKey = options.coingeckoKey ?? process.env.COINGECKO_API_KEY?.trim();
  const cmcKey =
    options.coinmarketcapKey ?? process.env.COINMARKETCAP_API_KEY?.trim();
  const pro = (options.tier ?? process.env.COINGECKO_API_TIER) === "pro";
  return {
    cgEnabled: Boolean(cgKey),
    cmcEnabled: Boolean(cmcKey),
    now: options.now || Date.now,
    async get(source: "cg" | "cmc", path: string): Promise<Json | null> {
      const key = source === "cg" ? cgKey : cmcKey;
      if (!key) return null;
      const base =
        source === "cg"
          ? pro
            ? "https://pro-api.coingecko.com/api/v3"
            : "https://api.coingecko.com/api/v3"
          : "https://pro-api.coinmarketcap.com";
      const header =
        source === "cg"
          ? pro
            ? "x-cg-pro-api-key"
            : "x-cg-demo-api-key"
          : "X-CMC_PRO_API_KEY";
      try {
        const response = await (options.fetcher || fetch)(base + path, {
          headers: { [header]: key, accept: "application/json" },
          signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) return null;
        const data = (await response.json()) as Json;
        if (
          data?.status?.error_code != null &&
          Number(data.status.error_code) !== 0
        )
          return null;
        return data;
      } catch {
        return null;
      } // No response body, request headers or credentials enter logs/errors.
    },
  };
}
export function selectMarketCap(
  coingecko: number | null,
  coinmarketcap: number | null,
  observedAt: string,
  fallback: number | null = null,
): MarketCapQuote {
  const cg = positive(coingecko),
    cmc = positive(coinmarketcap);
  const differencePct =
    cg && cmc ? (Math.abs(cg - cmc) / Math.max(cg, cmc)) * 100 : null;
  if (differencePct != null && differencePct > 25)
    return {
      marketCap: null,
      marketCapEvidence: {
        status: "conflict",
        source: "none",
        observedAt,
        coingecko: cg,
        coinmarketcap: cmc,
        differencePct,
        note: "Sources disagree by more than 25%; no valuation upside is inferred.",
      },
    };
  const marketCap = cg || cmc || positive(fallback);
  return {
    marketCap,
    marketCapEvidence: {
      status:
        cg && cmc ? "cross-checked" : marketCap ? "single-source" : "missing",
      source: cg
        ? "coingecko"
        : cmc
          ? "coinmarketcap"
          : marketCap
            ? "geckoterminal"
            : "none",
      observedAt,
      coingecko: cg,
      coinmarketcap: cmc,
      differencePct,
    },
  };
}
function fresh(at: unknown, now: number): boolean {
  const time = typeof at === "string" ? Date.parse(at) : NaN;
  return (
    Number.isFinite(time) && time <= now + 300000 && now - time <= 6 * 3600000
  );
}
function cmcContractPlatforms(asset: Json, token: MarketCapToken): string[] {
  const address = canonicalAddress(token.tokenAddress);
  const contracts: Json[] = Array.isArray(asset.contract_address)
    ? asset.contract_address
    : [];
  const platforms = contracts
    .filter(
      (c) => canonicalAddress(String(c.contract_address || "")) === address,
    )
    .map((c) => {
      const p = c.platform?.coin || c.platform || {};
      const slug = String(p.slug || p.name || "").toLowerCase();
      return PLATFORM_ALIASES[slug] || slug;
    })
    .filter(Boolean);
  if (
    canonicalAddress(String(asset.platform?.token_address || "")) === address
  ) {
    const slug = String(asset.platform?.slug || "").toLowerCase();
    if (slug) platforms.push(PLATFORM_ALIASES[slug] || slug);
  }
  return [...new Set(platforms)];
}
function cmcContractMatches(asset: Json, token: MarketCapToken): boolean {
  if (!canQueryMarketCapToken(token)) return false;
  const platforms = cmcContractPlatforms(asset, token),
    platform = coinGeckoPlatform(token);
  return platform ? platforms.includes(platform) : platforms.length > 0;
}
function cmcQuoteRows(payload: Json | null): Json[] {
  return !payload
    ? []
    : Array.isArray(payload.data)
      ? payload.data
      : (Object.values(payload.data || {}).flat() as Json[]);
}
function cmcCap(asset: Json, now: number): number | null {
  const quote = Array.isArray(asset.quote)
    ? asset.quote.find((q: Json) => q.symbol === "USD" || Number(q.id) === 2781)
    : asset.quote?.USD;
  return quote && fresh(quote.last_updated || asset.last_updated, now)
    ? positive(quote.market_cap)
    : null;
}

// Small, authenticated lookup for the dashboard. Never writes or backfills a snapshot.
export async function queryMarketCap(
  token: MarketCapToken,
  options: ApiOptions = {},
): Promise<MarketCapQuote> {
  const c = client(options),
    platform = coinGeckoPlatform(token),
    now = c.now();
  if (!canQueryMarketCapToken(token))
    return {
      marketCap: null,
      marketCapEvidence: legacyMarketCapEvidence(null),
    };
  let cgPlatforms: string[] = [],
    ambiguous = false;
  const [cg, cmcInfo] = await Promise.all([
    (async () => {
      if (platform)
        return c.get(
          "cg",
          `/coins/${encodeURIComponent(platform)}/contract/${encodeURIComponent(token.tokenAddress)}?localization=false&tickers=false`,
        );
      const identity = cgIdentity(
        token,
        cgIdentityIndex(await coinList(c, Boolean(options.fetcher))),
      );
      cgPlatforms = identity.platforms;
      ambiguous = identity.ambiguous;
      return identity.id
        ? c.get(
            "cg",
            `/coins/${encodeURIComponent(identity.id)}?localization=false&tickers=false`,
          )
        : null;
    })(),
    c.get(
      "cmc",
      `/v2/cryptocurrency/info?address=${encodeURIComponent(token.tokenAddress)}`,
    ),
  ]);
  const cgMatches =
    cg &&
    Object.entries(cg.platforms || {}).some(
      ([p, a]) =>
        (!platform || p === platform) &&
        canonicalAddress(String(a)) === canonicalAddress(token.tokenAddress),
    );
  if (cgMatches)
    cgPlatforms = Object.entries(cg!.platforms || {})
      .filter(
        ([p, a]) =>
          (!platform || p === platform) &&
          canonicalAddress(String(a)) === canonicalAddress(token.tokenAddress),
      )
      .map(([p]) => p);
  const cgValue =
    cgMatches && fresh(cg!.last_updated, now)
      ? positive(cg!.market_data?.market_cap?.usd)
      : null;
  const matches = cmcQuoteRows(cmcInfo).filter((a) =>
    cmcContractMatches(a, token),
  );
  ambiguous ||= matches.length > 1;
  const quote =
    !ambiguous && matches.length === 1
      ? await c.get(
          "cmc",
          `/v3/cryptocurrency/quotes/latest?id=${matches[0].id}&convert=USD`,
        )
      : null;
  const cmcValue = cmcQuoteRows(quote).find(
    (a) => Number(a.id) === Number(matches[0]?.id),
  );
  return identityQuote(
    selectMarketCap(
      cgValue,
      cmcValue ? cmcCap(cmcValue, now) : null,
      new Date(now).toISOString(),
    ),
    token,
    cgPlatforms,
    matches.length === 1 ? cmcContractPlatforms(matches[0], token) : [],
    ambiguous,
  );
}

// Bulk resolution bounds paid calls: one CG identity index + one CMC top-5000
// index, batched metadata for alternative-chain contracts, then batched quotes.
// Uncovered long-tail tokens keep explicit GeckoTerminal single-source evidence.
let indexCache: { at: number; cg: Json[]; cmc: Json[] } | null = null;
export async function fetchSnapshotMarketCaps(
  tokens: MarketCapToken[],
  options: ApiOptions = {},
): Promise<Map<string, MarketCapQuote>> {
  const c = client(options),
    now = c.now();
  if (!c.cgEnabled && !c.cmcEnabled) return new Map();
  let cg: Json[], cmc: Json[];
  if (!options.fetcher && indexCache && now - indexCache.at < 6 * 3600000)
    ({ cg, cmc } = indexCache);
  else {
    const [cgData, cmcData] = await Promise.all([
      coinList(c, Boolean(options.fetcher)),
      c.get(
        "cmc",
        "/v1/cryptocurrency/map?limit=5000&sort=cmc_rank&aux=platform",
      ),
    ]);
    cg = Array.isArray(cgData) ? cgData : [];
    cmc = Array.isArray(cmcData?.data) ? cmcData.data : [];
    if (!options.fetcher && cg.length && cmc.length)
      indexCache = { at: now, cg, cmc };
  }
  const wanted = new Map(tokens.map((t) => [marketCapTokenKey(t), t]));
  const cgIds = new Map<string, string>(),
    cmcIds = new Map<string, number>();
  const cgIndex = cgIdentityIndex(cg),
    cgPlatforms = new Map<string, string[]>(),
    cmcPlatforms = new Map<string, string[]>(),
    ambiguousKeys = new Set<string>();
  for (const [key, token] of wanted) {
    const identity = cgIdentity(token, cgIndex);
    if (identity.id) cgIds.set(key, identity.id);
    if (identity.ambiguous) ambiguousKeys.add(key);
    cgPlatforms.set(key, identity.platforms);
  }
  const alternativeIds = new Set<number>(),
    slugs = new Set(cgIds.values());
  for (const a of cmc) {
    for (const [key, token] of wanted)
      if (coinGeckoPlatform(token) && cmcContractMatches(a, token)) {
        cmcIds.set(key, Number(a.id));
        cmcPlatforms.set(key, cmcContractPlatforms(a, token));
      }
    if (slugs.has(a.slug)) alternativeIds.add(Number(a.id));
  }
  const batches = <T>(items: T[], n: number): T[][] =>
    Array.from({ length: Math.ceil(items.length / n) }, (_, i) =>
      items.slice(i * n, (i + 1) * n),
    );
  for (const ids of batches([...alternativeIds], 50)) {
    const info = await c.get(
      "cmc",
      `/v2/cryptocurrency/info?id=${ids.join(",")}`,
    );
    for (const a of cmcQuoteRows(info))
      for (const [key, token] of wanted)
        if (cmcContractMatches(a, token)) {
          if (cmcIds.has(key) && cmcIds.get(key) !== Number(a.id))
            ambiguousKeys.add(key);
          cmcIds.set(key, Number(a.id));
          cmcPlatforms.set(key, cmcContractPlatforms(a, token));
        }
  }
  const cgCaps = new Map<string, number>(),
    cmcCaps = new Map<number, number>();
  for (const ids of batches([...new Set(cgIds.values())], 200)) {
    const data = await c.get(
      "cg",
      `/coins/markets?vs_currency=usd&ids=${ids.map(encodeURIComponent).join(",")}&per_page=250`,
    );
    if (Array.isArray(data))
      for (const a of data)
        if (fresh(a.last_updated, now) && positive(a.market_cap))
          cgCaps.set(a.id, Number(a.market_cap));
  }
  for (const ids of batches([...new Set(cmcIds.values())], 200)) {
    const data = await c.get(
      "cmc",
      `/v3/cryptocurrency/quotes/latest?id=${ids.join(",")}&convert=USD`,
    );
    for (const a of cmcQuoteRows(data)) {
      const cap = cmcCap(a, now);
      if (cap) cmcCaps.set(Number(a.id), cap);
    }
  }
  return new Map(
    [...wanted].map(([key, token]) => [
      key,
      identityQuote(
        selectMarketCap(
          cgCaps.get(cgIds.get(key) || "") || null,
          cmcCaps.get(cmcIds.get(key) || -1) || null,
          new Date(now).toISOString(),
        ),
        token,
        cgPlatforms.get(key) || [],
        cmcPlatforms.get(key) || [],
        ambiguousKeys.has(key),
      ),
    ]),
  );
}

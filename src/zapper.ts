import { ZapperTokenBalance } from "./types";

const TOKEN_BALANCE_BATCH_SIZE = 8;
const TOKEN_BALANCE_RETRIES = 2;
const TOKEN_BALANCE_RETRY_DELAY_MS = 1200;

const TOKEN_BALANCES_QUERY = `
  query TokenBalances($addresses: [Address!]!, $first: Int!) {
    portfolioV2(addresses: $addresses, includeProxyAccounts: true) {
      tokenBalances {
        totalBalanceUSD
        byToken(first: $first) {
          totalCount
          edges {
            node {
              name
              symbol
              tokenAddress
              balance
              balanceRaw
              balanceUSD
              price
              network {
                name
                chainId
              }
            }
          }
        }
      }
    }
  }
`;

export async function fetchZapperTokenBalances(
  apiKey: string,
  addresses: string[],
  signal?: AbortSignal,
): Promise<{
  totalBalanceUsd: number;
  totalCount: number;
  balances: ZapperTokenBalance[];
}> {
  return fetchZapperTokenBalancesWithFallback(apiKey, addresses, signal);
}

async function fetchZapperTokenBalancesWithFallback(
  apiKey: string,
  addresses: string[],
  signal?: AbortSignal,
): Promise<{
  totalBalanceUsd: number;
  totalCount: number;
  balances: ZapperTokenBalance[];
}> {
  try {
    return await fetchZapperTokenBalancesSingle(apiKey, addresses, signal);
  } catch (error) {
    if (!shouldSplitTokenBalanceRequest(error, addresses.length)) {
      throw error;
    }

    const batches = chunk(addresses, TOKEN_BALANCE_BATCH_SIZE);
    const results = [];
    for (const batch of batches) {
      results.push(await fetchZapperTokenBalancesWithFallback(apiKey, batch, signal));
    }
    return mergeTokenBalanceResults(results);
  }
}

async function fetchZapperTokenBalancesSingle(
  apiKey: string,
  addresses: string[],
  signal?: AbortSignal,
): Promise<{
  totalBalanceUsd: number;
  totalCount: number;
  balances: ZapperTokenBalance[];
}> {
  for (let attempt = 0; attempt <= TOKEN_BALANCE_RETRIES; attempt += 1) {
  const response = await fetch("https://public.zapper.xyz/graphql", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-zapper-api-key": apiKey,
    },
    signal,
    body: JSON.stringify({
      query: TOKEN_BALANCES_QUERY,
      variables: {
        addresses,
        first: 500,
      },
    }),
  });

    if (!response.ok) {
      const message = `Zapper request failed with ${response.status}`;
      if (shouldRetryTokenBalanceError(message, attempt)) {
        await delay(TOKEN_BALANCE_RETRY_DELAY_MS * (attempt + 1), signal);
        continue;
      }
      throw new Error(message);
    }

    const payload = (await response.json()) as {
      errors?: Array<{ message?: string }>;
      data?: {
        portfolioV2?: {
          tokenBalances?: {
            totalBalanceUSD?: number;
            byToken?: {
              totalCount?: number;
              edges?: Array<{
                node?: {
                  name?: string;
                  symbol?: string;
                  tokenAddress?: string | null;
                  balance?: string;
                  balanceRaw?: string;
                  balanceUSD?: number;
                  price?: number | null;
                  network?: {
                    name?: string;
                    chainId?: number | null;
                  };
                };
              }>;
            };
          };
        };
      };
    };

    if (payload.errors?.length) {
      const message = payload.errors.map((item) => item.message || "Unknown error").join("; ");
      if (shouldRetryTokenBalanceError(message, attempt)) {
        await delay(TOKEN_BALANCE_RETRY_DELAY_MS * (attempt + 1), signal);
        continue;
      }
      throw new Error(message);
    }

    const tokenBalances = payload.data?.portfolioV2?.tokenBalances;
    const balances =
      tokenBalances?.byToken?.edges?.map((edge) => {
        const node = edge.node || {};
        return {
          tokenSymbol: String(node.symbol || "UNKNOWN"),
          tokenName: String(node.name || "Unknown token"),
          tokenAddress: node.tokenAddress || null,
          networkName: String(node.network?.name || "Unknown"),
          chainId: node.network?.chainId ?? null,
          balance: String(node.balance || "0"),
          balanceRaw: String(node.balanceRaw || "0"),
          balanceUsd: Number(node.balanceUSD || 0),
          price: node.price ?? null,
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
      }) || [];

    return {
      totalBalanceUsd: Number(tokenBalances?.totalBalanceUSD || 0),
      totalCount: Number(tokenBalances?.byToken?.totalCount || balances.length),
      balances,
    };
  }

  throw new Error("Zapper token balance request failed");
}

function mergeTokenBalanceResults(
  results: Array<{
    totalBalanceUsd: number;
    totalCount: number;
    balances: ZapperTokenBalance[];
  }>,
): {
  totalBalanceUsd: number;
  totalCount: number;
  balances: ZapperTokenBalance[];
} {
  const merged = new Map<string, ZapperTokenBalance>();

  for (const result of results) {
    for (const balance of result.balances) {
      const key = `${balance.chainId ?? "na"}:${balance.tokenAddress?.toLowerCase() || balance.networkName}:${balance.tokenSymbol}`;
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, { ...balance });
        continue;
      }
      existing.balanceUsd += balance.balanceUsd;
      existing.balance = String(Number(existing.balance) + Number(balance.balance));
      existing.balanceRaw = String(BigInt(existing.balanceRaw || "0") + BigInt(balance.balanceRaw || "0"));
      if (existing.price == null) existing.price = balance.price;
    }
  }

  const balances = Array.from(merged.values()).sort((left, right) => right.balanceUsd - left.balanceUsd);
  return {
    totalBalanceUsd: results.reduce((sum, item) => sum + item.totalBalanceUsd, 0),
    totalCount: balances.length,
    balances,
  };
}

function shouldRetryTokenBalanceError(message: string, attempt: number): boolean {
  if (attempt >= TOKEN_BALANCE_RETRIES) return false;
  return /internal server error|timeout|timed out|too many requests|failed with 5\d\d/i.test(message);
}

function shouldSplitTokenBalanceRequest(error: unknown, addressCount: number): boolean {
  if (addressCount <= 1) return false;
  const message = error instanceof Error ? error.message : String(error);
  return /internal server error|exception|failed with 5\d\d/i.test(message);
}

function chunk<T>(items: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    output.push(items.slice(index, index + size));
  }
  return output;
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return;
  }
  const abortSignal = signal;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      abortSignal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timeout);
      abortSignal.removeEventListener("abort", onAbort);
      reject(new DOMException("Refresh canceled", "AbortError"));
    }
    abortSignal.addEventListener("abort", onAbort);
  });
}

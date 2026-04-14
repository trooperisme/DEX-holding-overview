import { ZapperTokenBalance } from "./types";

const RATE_LIMIT_DELAY_MS = 2500;
const MAX_MARKET_DATA_RETRIES = 3;

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

const FUNGIBLE_TOKEN_MARKET_DATA_QUERY = `
  query TokenMarketData($address: Address!, $chainId: Int!) {
    fungibleTokenV2(address: $address, chainId: $chainId) {
      priceData {
        marketCap
        totalLiquidity
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
    throw new Error(`Zapper request failed with ${response.status}`);
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
      };
    }) || [];

  return {
    totalBalanceUsd: Number(tokenBalances?.totalBalanceUSD || 0),
    totalCount: Number(tokenBalances?.byToken?.totalCount || balances.length),
    balances,
  };
}

export async function fetchZapperTokenMarketData(
  apiKey: string,
  tokenAddress: string,
  chainId: number,
  signal?: AbortSignal,
): Promise<{
  marketCap: number | null;
  liquidityUsd: number | null;
}> {
  for (let attempt = 0; attempt <= MAX_MARKET_DATA_RETRIES; attempt += 1) {
    const response = await fetch("https://public.zapper.xyz/graphql", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-zapper-api-key": apiKey,
      },
      signal,
      body: JSON.stringify({
        query: FUNGIBLE_TOKEN_MARKET_DATA_QUERY,
        variables: {
          address: tokenAddress,
          chainId,
        },
      }),
    });

    if (response.status === 429) {
      if (attempt === MAX_MARKET_DATA_RETRIES) {
        throw new Error("Too many requests");
      }
      await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_DELAY_MS * (attempt + 1)));
      continue;
    }

    if (!response.ok) {
      throw new Error(`Zapper token market-data request failed with ${response.status}`);
    }

    const payload = (await response.json()) as {
      errors?: Array<{ message?: string }>;
      data?: {
        fungibleTokenV2?: {
          priceData?: {
            marketCap?: number | null;
            totalLiquidity?: number | null;
          } | null;
        } | null;
      };
    };

    if (payload.errors?.length) {
      const message = payload.errors.map((item) => item.message || "Unknown error").join("; ");
      if (/too many requests/i.test(message) && attempt < MAX_MARKET_DATA_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_DELAY_MS * (attempt + 1)));
        continue;
      }
      throw new Error(message);
    }

    return {
      marketCap: payload.data?.fungibleTokenV2?.priceData?.marketCap ?? null,
      liquidityUsd: payload.data?.fungibleTokenV2?.priceData?.totalLiquidity ?? null,
    };
  }

  throw new Error("Market-data lookup failed");
}

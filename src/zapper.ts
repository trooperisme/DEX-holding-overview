import { ZapperTokenBalance } from "./types";

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
        volume24h: null,
        txns24h: null,
        tokenAgeHours: null,
      };
    }) || [];

  return {
    totalBalanceUsd: Number(tokenBalances?.totalBalanceUSD || 0),
    totalCount: Number(tokenBalances?.byToken?.totalCount || balances.length),
    balances,
  };
}

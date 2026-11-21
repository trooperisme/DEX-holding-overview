import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalAddress,
  fetchSnapshotMarketCaps,
  marketCapTokenKey,
  queryMarketCap,
  selectMarketCap,
} from "./market-cap";
const at = "2026-11-21T00:00:00Z",
  now = () => Date.parse(at);
const token = {
  tokenAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  chainId: 1,
  networkName: "Ethereum",
};
const options = (fetcher: typeof fetch) => ({
  fetcher,
  coingeckoKey: "test-only-cg",
  coinmarketcapKey: "test-only-cmc",
  now,
});
function fake(
  handler: (url: string, headers: Headers) => unknown,
): typeof fetch {
  return (async (url, init) =>
    new Response(
      JSON.stringify(handler(String(url), new Headers(init?.headers))),
      { status: 200 },
    )) as typeof fetch;
}
test("market-cap selection rejects disagreement and never substitutes valuation estimates", () => {
  assert.equal(selectMarketCap(1e6, 1e9, at, 1e6).marketCap, null);
  assert.equal(
    selectMarketCap(null, null, at).marketCapEvidence.status,
    "missing",
  );
  assert.equal(
    selectMarketCap(1e6, 1.1e6, at).marketCapEvidence.status,
    "cross-checked",
  );
});
test("EVM addresses are case-insensitive while Solana addresses retain case", () => {
  assert.equal(canonicalAddress("0xAbCd"), "0xabcd");
  assert.equal(canonicalAddress("SoLaNaCaseSensitive"), "SoLaNaCaseSensitive");
});
test("contract resolution checks alternative-chain metadata and supports CMC v3 quotes", async () => {
  const fetcher = fake((url, headers) => {
    if (url.includes("coingecko")) {
      assert.equal(headers.get("x-cg-demo-api-key"), "test-only-cg");
      assert.ok(!url.includes("test-only"));
      return {
        platforms: { ethereum: token.tokenAddress },
        last_updated: at,
        market_data: {
          market_cap: { usd: 1e6 },
          fully_diluted_valuation: { usd: 9e9 },
        },
      };
    }
    assert.equal(headers.get("X-CMC_PRO_API_KEY"), "test-only-cmc");
    if (url.includes("/info?"))
      return {
        data: {
          "3408": {
            id: 3408,
            platform: { slug: "zksync", token_address: "different" },
            contract_address: [
              {
                contract_address: token.tokenAddress,
                platform: { coin: { slug: "ethereum" } },
              },
            ],
          },
        },
      };
    return {
      data: [
        {
          id: 3408,
          circulating_supply: 1e6,
          quote: [
            {
              symbol: "USD",
              market_cap: 1.1e6,
              fully_diluted_market_cap: 9e9,
              last_updated: at,
            },
          ],
        },
      ],
    };
  });
  const quote = await queryMarketCap(token, options(fetcher));
  assert.equal(quote.marketCapEvidence.status, "cross-checked");
  assert.equal(quote.marketCap, 1e6);
  assert.ok(!JSON.stringify(quote).toLowerCase().includes("fdv"));
});
test("FDV-only or wrong-chain results never become market cap", async () => {
  const quote = await queryMarketCap(
    token,
    options(
      fake((url) =>
        url.includes("coingecko")
          ? {
              platforms: { ethereum: token.tokenAddress },
              last_updated: at,
              market_data: { fully_diluted_valuation: { usd: 1e6 } },
            }
          : {
              data: {
                "1": {
                  id: 1,
                  platform: { slug: "base", token_address: token.tokenAddress },
                },
              },
            },
      ),
    ),
  );
  assert.equal(quote.marketCap, null);
  assert.equal(quote.marketCapEvidence.status, "missing");
});
test("stale market caps are ignored and provider errors do not leak request details", async () => {
  const stale = await queryMarketCap(
    token,
    options(
      fake((url) =>
        url.includes("coingecko")
          ? {
              platforms: { ethereum: token.tokenAddress },
              last_updated: "2020-01-01",
              market_data: { market_cap: { usd: 1e6 } },
            }
          : { data: {} },
      ),
    ),
  );
  assert.equal(stale.marketCap, null);
  const failed = await queryMarketCap(
    token,
    options((async () => {
      throw new Error("test-only-cg");
    }) as typeof fetch),
  );
  assert.ok(!JSON.stringify(failed).includes("test-only"));
});
test("bulk market-cap enrichment matches contracts and batches quotes", async () => {
  const paths: string[] = [];
  const fetcher = fake((url) => {
    paths.push(url);
    if (url.includes("/coins/list"))
      return [{ id: "sample", platforms: { ethereum: token.tokenAddress } }];
    if (url.includes("/cryptocurrency/map"))
      return {
        data: [
          {
            id: 7,
            slug: "sample",
            platform: { slug: "ethereum", token_address: token.tokenAddress },
          },
        ],
      };
    if (url.includes("/cryptocurrency/info")) return { data: {} };
    if (url.includes("/coins/markets"))
      return [{ id: "sample", market_cap: 1e6, last_updated: at }];
    return {
      data: [
        {
          id: 7,
          quote: [{ symbol: "USD", market_cap: 1e6, last_updated: at }],
        },
      ],
    };
  });
  const result = await fetchSnapshotMarketCaps([token], options(fetcher));
  assert.equal(
    result.get(marketCapTokenKey(token))?.marketCapEvidence.status,
    "cross-checked",
  );
  assert.ok(paths.length <= 5);
});

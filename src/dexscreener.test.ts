import test from "node:test";
import assert from "node:assert/strict";
import { fetchDexScreenerMarketData, pickBestPair, toDexScreenerChainId } from "./dexscreener";

test("toDexScreenerChainId maps supported chain identifiers", () => {
  assert.equal(toDexScreenerChainId(1, "Ethereum"), "ethereum");
  assert.equal(toDexScreenerChainId(56, "BNB Chain"), "bsc");
  assert.equal(toDexScreenerChainId(1151111081, "Solana"), "solana");
  assert.equal(toDexScreenerChainId(999, "HyperEVM"), "hyperevm");
  assert.equal(toDexScreenerChainId(null, "Base"), "base");
  assert.equal(toDexScreenerChainId(null, "Robinhood"), "robinhood");
  assert.equal(toDexScreenerChainId(null, "HyperEVM"), "hyperevm");
});

test("pickBestPair prefers higher liquidity, then volume, then txns", () => {
  const best = pickBestPair([
    {
      liquidity: { usd: 1000 },
      volume: { h24: 10000 },
      txns: { h24: { buys: 100, sells: 100 } },
      pairCreatedAt: 1000,
    },
    {
      liquidity: { usd: 5000 },
      volume: { h24: 100 },
      txns: { h24: { buys: 1, sells: 1 } },
      pairCreatedAt: 500,
    },
  ]);

  assert.equal(best?.liquidity?.usd, 5000);
});

test("market data prefers a pair with market cap and falls back to token-pairs after a failed batch", async () => {
  const originalFetch = globalThis.fetch;
  let batchAttempts = 0;
  let tokenPairRequests = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/tokens/v1/")) {
      batchAttempts += 1;
      if (batchAttempts === 1) {
        return {
          ok: false,
          status: 503,
          headers: { get: () => null },
          json: async () => [],
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => [
          { baseToken: { address: "0xa" }, liquidity: { usd: 10_000 }, fdv: 900 },
          { baseToken: { address: "0xa" }, liquidity: { usd: 100 }, marketCap: 450 },
          { baseToken: { address: "0xb" }, liquidity: { usd: 50 } },
        ],
      } as unknown as Response;
    }

    tokenPairRequests += 1;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => [{ baseToken: { address: "0xb" }, liquidity: { usd: 200 }, marketCap: 321 }],
    } as unknown as Response;
  }) as typeof fetch;

  try {
    const marketData = await fetchDexScreenerMarketData([
      { tokenAddress: "0xa", chainId: 8453, networkName: "Base" },
      { tokenAddress: "0xb", chainId: 8453, networkName: "Base" },
    ]);

    assert.equal(batchAttempts, 2);
    assert.equal(tokenPairRequests, 1);
    assert.equal(marketData.get("base:0xa")?.marketCap, 450);
    assert.equal(marketData.get("base:0xa")?.liquidityUsd, 10_000);
    assert.equal(marketData.get("base:0xb")?.marketCap, 321);
    assert.equal(marketData.get("base:0xb")?.liquidityUsd, 50);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("market data searches by token address when the source chain is unknown", async () => {
  const originalFetch = globalThis.fetch;
  let searchRequests = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    assert.match(url, /\/latest\/dex\/search\?q=0xunknown$/);
    searchRequests += 1;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        pairs: [
          { chainId: "pulsechain", baseToken: { address: "0xunknown" }, liquidity: { usd: 10 }, marketCap: 50 },
          { chainId: "ethereum", baseToken: { address: "0xunknown" }, liquidity: { usd: 1000 }, marketCap: 5000 },
          { chainId: "ethereum", baseToken: { address: "0xother" }, liquidity: { usd: 5000 }, marketCap: 10000 },
        ],
      }),
    } as unknown as Response;
  }) as typeof fetch;

  try {
    const marketData = await fetchDexScreenerMarketData([
      { tokenAddress: "0xunknown", chainId: null, networkName: "Unknown" },
    ]);

    assert.equal(searchRequests, 1);
    assert.equal(marketData.get("unknown:0xunknown")?.marketCap, 5000);
    assert.equal(marketData.get("unknown:0xunknown")?.liquidityUsd, 1000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { extractDirectTwitterHandle, pickBestPair, toDexScreenerChainId } from "./dexscreener";

test("toDexScreenerChainId maps common Zapper chains", () => {
  assert.equal(toDexScreenerChainId(1, "Ethereum"), "ethereum");
  assert.equal(toDexScreenerChainId(56, "BNB Chain"), "bsc");
  assert.equal(toDexScreenerChainId(1151111081, "Solana"), "solana");
  assert.equal(toDexScreenerChainId(null, "Base"), "base");
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

test("extractDirectTwitterHandle accepts only direct X/Twitter profile URLs", () => {
  assert.equal(extractDirectTwitterHandle("https://x.com/GeniusTerminal"), "GeniusTerminal");
  assert.equal(extractDirectTwitterHandle("https://twitter.com/solana"), "solana");
  assert.equal(
    extractDirectTwitterHandle("https://x.com/heyibinance/status/1974489756164575458"),
    null,
  );
  assert.equal(extractDirectTwitterHandle("https://x.com/search?q=unc&src=typed_query&f=top"), null);
  assert.equal(extractDirectTwitterHandle("https://example.com/solana"), null);
});

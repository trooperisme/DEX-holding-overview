import assert from "node:assert/strict";
import test from "node:test";
import { marketDataFromToken, toGeckoTerminalNetworkId } from "./geckoterminal";

test("HyperEVM uses GeckoTerminal's hyperevm network id", () => {
  assert.equal(toGeckoTerminalNetworkId(999, "HyperEVM"), "hyperevm");
  assert.equal(toGeckoTerminalNetworkId(null, "HyperEVM"), "hyperevm");
  assert.equal(toGeckoTerminalNetworkId(null, "Hyperliquid EVM"), "hyperevm");
});
test("GeckoTerminal never substitutes FDV and pool age does not reset to the deepest pool", () => {
  const now = Date.now();
  const token = {
    attributes: { market_cap_usd: null, fdv_usd: "900000000" },
    relationships: { top_pools: { data: [{ id: "new" }, { id: "old" }] } },
  };
  const pools = new Map([
    [
      "new",
      {
        attributes: {
          reserve_in_usd: "1000000",
          volume_usd: { h24: "500000" },
          pool_created_at: new Date(now - 3600000).toISOString(),
        },
      },
    ],
    [
      "old",
      {
        attributes: {
          reserve_in_usd: "100000",
          volume_usd: { h24: "10000" },
          pool_created_at: new Date(now - 10 * 86400000).toISOString(),
        },
      },
    ],
  ]);
  const result = marketDataFromToken(token, pools);
  assert.equal(result.marketCap, null);
  assert.equal(result.liquidityUsd, 1000000);
  assert.ok(Math.abs(result.tokenAgeHours! - 240) < 0.01);
});

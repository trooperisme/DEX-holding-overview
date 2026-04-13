import test from "node:test";
import assert from "node:assert/strict";
import { loadImportedEntities, toTokenKey } from "./entities";

test("loadImportedEntities parses the seed csv", () => {
  const rows = loadImportedEntities(
    "/Users/nguyentrancongnguyen/Documents/Playground/DEX-holding-overview/data/raw/dex-entities-zapper.csv",
  );
  assert.ok(rows.length > 30);
  assert.equal(rows[0].entityName, "Vương MC");
  assert.ok(rows[0].walletAddresses.length > 1);
});

test("toTokenKey prefers chain and address", () => {
  assert.equal(
    toTokenKey({
      chainId: 8453,
      networkName: "Base",
      tokenAddress: "0xAbC",
      tokenSymbol: "USDC",
    }),
    "8453:0xabc",
  );
});

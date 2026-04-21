import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loadImportedEntities, toTokenKey } from "./entities";

test("loadImportedEntities parses the seed csv", () => {
  const rows = loadImportedEntities(path.join(process.cwd(), "data/raw/dex-entities-zapper.csv"));
  assert.ok(rows.length > 30);
  assert.equal(rows[0].entityName, "Vương MC");
  assert.ok(rows[0].walletAddresses.length > 1);
  assert.ok(rows.some((row) => row.entityName === "trollwhale"));
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

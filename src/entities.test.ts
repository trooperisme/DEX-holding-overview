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
  const swansonBenson = rows.find((row) => row.entityName === "SwansonBenson");
  assert.ok(swansonBenson);
  assert.equal(swansonBenson.resolvedLabel, "swansonbenson");
  assert.equal(swansonBenson.walletAddresses.length, 16);
  assert.ok(
    rows.find((row) => row.entityName === "0xDQ")?.walletAddresses.includes("0xCd76E4e8D7F498A728cfAfe088fB3e6fCBbfaB21"),
  );
  const jaiPrasad = rows.find((row) => row.entityName === "jai_prasad 17");
  assert.ok(jaiPrasad);
  assert.equal(jaiPrasad.resolvedLabel, "jai_prasad17");
  assert.equal(jaiPrasad.walletAddresses.length, 15);
  assert.ok(jaiPrasad.walletAddresses.includes("0xc04eb384bb9f0872a3cb41ba74867936d3fb5162"));
  assert.ok(jaiPrasad.walletAddresses.includes("7dAVdLmmtLwo55hwqTVZkfo4MLgmMyvTCUCQCVRjihkS"));
  const uga2Vegas = rows.find((row) => row.entityName === "uga2vegas (research)");
  assert.ok(uga2Vegas);
  assert.equal(uga2Vegas.resolvedLabel, "uga2vegas");
  assert.equal(uga2Vegas.walletAddresses.length, 4);
  assert.ok(uga2Vegas.walletAddresses.includes("0xa1c9d41719c4ffd99463f1cfa579d9b6a96b50c6"));
  assert.ok(uga2Vegas.walletAddresses.includes("zczyNknQCTwCeiAo9QekT3wwJbaW6NUZmbPnJsFk6B1"));
  assert.deepEqual(
    rows.find((row) => row.entityName === "Base Specialist | tommy 🌙")?.walletAddresses.slice(-1),
    ["0xa63d8e8a4dd26544d56d4a015792c3df06e97f25"],
  );
  assert.equal(rows.find((row) => row.entityName === "Base Specialist | tommy 🌙")?.walletAddresses.length, 13);
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

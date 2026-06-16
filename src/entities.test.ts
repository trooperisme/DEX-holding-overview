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
    ["0x80dc3a3f5302d478f9b8168aa439ba35f0425abe"],
  );
  assert.equal(rows.find((row) => row.entityName === "Base Specialist | tommy 🌙")?.walletAddresses.length, 14);

  const expectedNewWalletsByEntity = new Map([
    ["Vương MC", ["FtKc2TkeqTcwHgt3veHMQyqYsx97Hk4tnW89LeupaJ9J"]],
    ["Hansolar", ["CJS2RcjmoDNG8qm1VvTN2RxXidLzeuwkPjTASu4Eojg"]],
    ["JoshuaDeuk", ["0xcddc65c39e79eae6aba12f2cfc7b83d8d3f7188c"]],
    [
      "0xUnihaxor",
      [
        "0x1289894a932ae5b4679b236f96eae4236f4ee9c4",
        "0x8774e69e6fab8fae50cc27a82a224dd9d84a427c",
        "0xa71835dd5179cccb89167a9b1016b5c9043b8f94",
        "0x2fb8a5b21aaa9b77e462e72bbf4980a6ac7df6c5",
        "0x73c8e23e3f2feffcfa7ffa96e44660ed16c92061",
        "7nzGxho8yxAm9qV2rabcCZ8GppC93TZhGNZ69x6UxZiS",
        "AVHjrEs5my3mf6tersAAbYwLXUJqKybsjyzSkdBdqxq4",
        "2GHgLubjWvLtuw6Zxq6KqmaWvPduokpWeukdb9yGTNEi",
        "ACi7K9E5LZFNzW2w134tb1eRmBA7Rp6cwyZCPCyk761t",
        "H5fStxz4scwWuXN4n7wo3GgpYud3t1Mz1fKMkcwaH9XW",
        "FhsHDuhHbhw2HTkz7eWKJn33HSgq4E4MYNBocrk3ya1W",
        "GFiW4FE7QCjW2zgKUyHTZU8hikhGjXR7sgg4oSDo5mPc",
        "2hRepUfb8NNCX43n3ffDEHtMKGt95qBVsEj8AKuMGU6M",
        "oJEyy4MkksJzjNbVCXSctRKC7fq4SCYQ9PJDBM4BYzm",
        "6Y3UN9AnivpDUN5DREHuUSYHPiaXmmNSpCU8aXdXiNAL",
      ],
    ],
    ["Base Specialist | tommy 🌙", ["0x80dc3a3f5302d478f9b8168aa439ba35f0425abe"]],
    ["pendle 4 alfafa", ["C4jdqASx8TDSV3LPtdJt5Z8CVBqjJWrezopkz4LLJ4Dr", "Gt4EbY5Se7z8e4eb9SkF3Rrc6Eoojr6LePPLesmwH9B"]],
  ]);

  for (const [entityName, wallets] of expectedNewWalletsByEntity) {
    const entity = rows.find((row) => row.entityName === entityName);
    assert.ok(entity, `${entityName} is present`);
    for (const wallet of wallets) {
      assert.ok(entity.walletAddresses.includes(wallet), `${entityName} includes ${wallet}`);
    }
  }
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

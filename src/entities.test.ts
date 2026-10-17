import test from "node:test";
import assert from "node:assert/strict";
import { loadTrackedEntities, parseCieloEntityCsv, toTokenKey } from "./entities";
import path from "node:path";

test("loadTrackedEntities parses the tracked Cielo portfolio CSV", () => {
  const rows = loadTrackedEntities(path.join(process.cwd(), "data/raw/entity-cielo-portfolio-links.csv"));
  assert.ok(rows.length > 30);
  assert.ok(rows.every((row) => row.sourceUrl.startsWith("https://app.cielo.finance/bundles/")));
});

test("parseCieloEntityCsv preserves duplicate bundle rows and reports invalid URLs", () => {
  const parsed = parseCieloEntityCsv([
    "entity,cielo_link",
    "Alpha,https://app.cielo.finance/bundles/101/portfolio",
    "Alpha copy,https://app.cielo.finance/bundles/101/portfolio",
    "Broken,https://example.com/not-a-bundle",
  ].join("\n"));
  assert.equal(parsed.entities.length, 2);
  assert.match(parsed.entities[1].sourceUrl, /#entity-row=3$/);
  assert.equal(parsed.invalidRows[0].entityName, "Broken");
});

test("toTokenKey prefers chain and address", () => {
  assert.equal(toTokenKey({ chainId: 8453, networkName: "Base", tokenAddress: "0xAbC", tokenSymbol: "USDC" }), "8453:0xabc");
});

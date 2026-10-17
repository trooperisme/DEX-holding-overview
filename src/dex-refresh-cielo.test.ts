import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runDexRefresh } from "./dex-refresh";
import { createStorage } from "./storage";

const CIELO_MARKDOWN = `Total portfolio value: $42.00

| Token | Chain | Amount | Price | USD Value |
| --- | --- | --- | --- | --- |
| CIELO | Base | 1 | $42.00 | $42.00 |
`;

test("runDexRefresh retries an inaccessible Cielo entity until the full batch succeeds", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dex-refresh-cielo-"));
  const csvPath = path.join(tempDir, "entity-cielo-portfolio-links.csv");
  fs.writeFileSync(csvPath, [
    "entity,cielo_link",
    "Alpha,https://app.cielo.finance/bundles/101/portfolio",
    "Alpha copy,https://app.cielo.finance/bundles/101/portfolio",
    "Deleted,https://app.cielo.finance/bundles/999/portfolio",
  ].join("\n"));

  const envKeys = [
    "DATA_DIR",
    "CIELO_ENTITIES_CSV",
    "FIRECRAWL_API_KEY",
    "CIELO_FIRECRAWL_WAIT_MS",
    "CIELO_FIRECRAWL_TIMEOUT_MS",
    "CIELO_FIRECRAWL_RETRIES",
    "CIELO_FIRECRAWL_RATE_LIMIT_COOLDOWN_MS",
    "DATABASE_URL",
  ] as const;
  const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  const scrapeCacheSettings: Array<{ maxAge?: number; storeInCache?: boolean }> = [];

  process.env.DATA_DIR = tempDir;
  process.env.CIELO_ENTITIES_CSV = csvPath;
  process.env.FIRECRAWL_API_KEY = "test-firecrawl-key";
  process.env.CIELO_FIRECRAWL_WAIT_MS = "0";
  process.env.CIELO_FIRECRAWL_TIMEOUT_MS = "1000";
  process.env.CIELO_FIRECRAWL_RETRIES = "0";
  process.env.CIELO_FIRECRAWL_RATE_LIMIT_COOLDOWN_MS = "0";
  delete process.env.DATABASE_URL;

  const storage = createStorage(process.cwd());
  await storage.replaceEntities([
    {
      entityName: "Stale Entity",
      sourceUrl: "https://app.cielo.finance/bundles/1/portfolio",
      resolvedLabel: "Stale Entity",
      linkType: "bundle",
      walletAddresses: ["0x0000000000000000000000000000000000000001"],
    },
  ]);
  await storage.close();

  globalThis.fetch = (async (input, init) => {
    const body = JSON.parse(String(init?.body || "{}")) as {
      url?: string;
      maxAge?: number;
      storeInCache?: boolean;
    };
    calls.push(body.url || String(input));
    scrapeCacheSettings.push(body);
    if (body.url?.includes("999") && calls.filter((url) => url.includes("999")).length === 1) {
      return new Response(JSON.stringify({ success: false, error: "Bundle not found" }), { status: 200 });
    }
    return new Response(JSON.stringify({ success: true, data: { markdown: CIELO_MARKDOWN } }), { status: 200 });
  }) as typeof fetch;

  try {
    const result = await runDexRefresh({ cwd: process.cwd() });
    assert.equal(result.status, "success");
    assert.equal(result.totalEntities, 3);
    assert.equal(result.entitiesCompleted, 3);
    assert.equal(result.entitiesFailed, 0);
    assert.equal(result.totalRows, 3);
    assert.deepEqual(calls.sort(), [
      "https://app.cielo.finance/bundles/101/portfolio",
      "https://app.cielo.finance/bundles/999/portfolio",
      "https://app.cielo.finance/bundles/999/portfolio",
    ]);
    assert.ok(scrapeCacheSettings.every((settings) => settings.maxAge === 0 && settings.storeInCache === false));

    const storage = createStorage(process.cwd());
    const snapshots = await storage.getSnapshotSummaries();
    const overview = await storage.getOverview(result.snapshotId, 0, 1);
    await storage.close();
    assert.equal(snapshots[0].providerLabel, "Cielo");
    assert.equal(overview.length, 1);
    assert.equal(overview[0].tokenSymbol, "CIELO");
    assert.equal(overview[0].holdingsUsd, 126);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of envKeys) {
      const value = previousEnv.get(key);
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

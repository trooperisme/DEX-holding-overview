import assert from "node:assert/strict";
import test from "node:test";
import {
  extractCieloBundleId,
  fetchCieloPortfolio,
  parseCieloPortfolioMarkdown,
  validateCieloTotals,
} from "./cielo";
import { loadTrackedEntities, parseCieloEntityCsv } from "./entities";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MARKDOWN = `# Portfolio

Total portfolio value: $1,250.00

| Token | Chain | Amount Held | Price | USD Value |
| --- | --- | --- | --- | --- |
| [USDC](https://app.cielo.finance/token/ethereum/0x00000000000000000000000000000000000000a1) | Ethereum | 1,000 | $1.00 | $1,000.00 |
| ETH | Base | 0.1 | $2,500 | $250.00 |
`;

test("parseCieloEntityCsv validates headers, preserves emoji names, and reports invalid URLs", () => {
  const parsed = parseCieloEntityCsv([
    "entity,cielo_link",
    '"🐳 Alpha, Inc.",https://app.cielo.finance/bundles/101/portfolio',
    "Duplicate,https://app.cielo.finance/bundles/101/portfolio",
    "Broken,https://example.com/not-a-bundle",
  ].join("\n"));

  assert.equal(parsed.entities.length, 2);
  assert.equal(parsed.entities[0].entityName, "🐳 Alpha, Inc.");
  assert.equal(parsed.entities[0].sourceUrl, "https://app.cielo.finance/bundles/101/portfolio");
  assert.equal(parsed.invalidRows[0].rowNumber, 4);
  assert.throws(
    () => parseCieloEntityCsv("name,link\nAlpha,https://app.cielo.finance/bundles/101/portfolio"),
    /entity,cielo_link headers/,
  );

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dex-cielo-"));
  const csvPath = path.join(tempDir, "entities.csv");
  fs.writeFileSync(csvPath, "entity,cielo_link\nAlpha,https://app.cielo.finance/bundles/101/portfolio\nBeta,https://app.cielo.finance/bundles/101/portfolio\n");
  const imported = loadTrackedEntities(csvPath);
  assert.equal(imported.length, 2);
  assert.match(imported[1].sourceUrl, /#entity-row=3$/);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("parseCieloPortfolioMarkdown extracts address, native token, chain IDs, and total", () => {
  const parsed = parseCieloPortfolioMarkdown(MARKDOWN);

  assert.equal(parsed.balances.length, 2);
  assert.equal(parsed.displayedTotalUsd, 1250);
  assert.equal(parsed.parsedTotalUsd, 1250);
  assert.deepEqual(parsed.balances[0], {
    tokenSymbol: "USDC",
    tokenName: "USDC",
    tokenAddress: "0x00000000000000000000000000000000000000a1",
    networkName: "Ethereum",
    chainId: 1,
    balance: "1000",
    balanceRaw: "1000",
    balanceUsd: 1000,
    price: 1,
    marketCap: null,
    liquidityUsd: null,
    volume24h: null,
    txns24h: null,
    tokenAgeHours: null,
  });
  assert.equal(parsed.balances[1].tokenAddress, "0x0000000000000000000000000000000000000000");
  assert.equal(parsed.balances[1].chainId, 8453);
});

test("parseCieloPortfolioMarkdown keeps a row with no chain clue as Unknown", () => {
  const parsed = parseCieloPortfolioMarkdown(`Total value: $10

| Token | Amount | USD Value |
| --- | --- | --- |
| ETH | 1 | $10 |
`);

  assert.equal(parsed.balances[0].networkName, "Unknown");
  assert.equal(parsed.balances[0].chainId, null);
  assert.equal(parsed.unknownChainRows, 1);
  assert.equal(parsed.unknownChainValueUsd, 10);
});

test("parseCieloPortfolioMarkdown strips image extensions from Solana token addresses", () => {
  const parsed = parseCieloPortfolioMarkdown(`Total value: $12

| Token | Amount | USD Value |
| --- | --- | --- |
| ![token](https://logos.cielo.finance/solana/9E86P5UzJT8rXpuXDBokbLyGbYzn3k7UHigBrpqFp777.webp) CULTURE | 3 | $12 |
`);

  assert.equal(parsed.balances[0].chainId, 1151111081);
  assert.equal(parsed.balances[0].tokenAddress, "9E86P5UzJT8rXpuXDBokbLyGbYzn3k7UHigBrpqFp777");
});

test("parseCieloPortfolioMarkdown parses current Cielo br-separated token cells", () => {
  const parsed = parseCieloPortfolioMarkdown(`Total value: $234,328.09

| Token | Amount | Price | USD Value |
| --- | --- | --- | --- |
| ![HYPE](https://logos.uniwhales.io/hyperevm/HYPE.jpg)<br>HYPE<br>Hyperliquid | 3.2K<br>HYPE<br>0% | $54.75 | $176,157.28 |
| ![0xf280b16ef293d8e534e370794ef26bf312694126](https://logos.uniwhales.io/ethereum/0xf280b16ef293d8e534e370794ef26bf312694126.jpg)![chain](https://logos.uniwhales.io/ethereum/chain.jpg)<br>ASTEROID<br>Asteroid Shiba<br>0xf2...4126 | 953.7M<br>ASTEROID<br>0.2267% | $0.046099 | $58,170.81 |
`);

  assert.equal(parsed.balances[0].tokenSymbol, "HYPE");
  assert.equal(parsed.balances[0].tokenName, "Hyperliquid");
  assert.equal(parsed.balances[0].balance, "3200");
  assert.equal(parsed.balances[0].tokenAddress, "0x0000000000000000000000000000000000000000");
  assert.equal(parsed.balances[0].chainId, 999);
  assert.equal(parsed.balances[1].tokenSymbol, "ASTEROID");
  assert.equal(parsed.balances[1].tokenName, "Asteroid Shiba");
  assert.equal(parsed.balances[1].balance, "953700000");
});

test("Cielo total validation allows rounding drift and rejects meaningful drift", () => {
  assert.doesNotThrow(() => validateCieloTotals(1_000.5, 1_000));
  assert.throws(() => validateCieloTotals(1_100, 1_000), /Cielo total mismatch/);
  assert.throws(() => parseCieloPortfolioMarkdown("Bundle not found"), /Bundle not found/);
  assert.throws(
    () => parseCieloPortfolioMarkdown("Total portfolio value: $10.00\n\n| Token | USD Value |\n| --- | --- |\n| Broken | - |"),
    /parsed zero rows with nonzero displayed total/,
  );
  assert.equal(extractCieloBundleId("https://app.cielo.finance/bundles/1892/portfolio"), "1892");
  assert.throws(() => extractCieloBundleId("https://app.cielo.finance/bundles/nope/portfolio"), /Invalid Cielo/);
});

test("fetchCieloPortfolio calls Firecrawl with the bundle URL and returns metadata", async () => {
  const requests: Array<{ url: string; body: any }> = [];
  const result = await fetchCieloPortfolio({
    firecrawlApiKey: "test-firecrawl-key",
    bundleUrl: "https://app.cielo.finance/bundles/101/portfolio",
    waitMs: 0,
    timeoutMs: 1000,
    retries: 0,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ success: true, data: { markdown: MARKDOWN } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api.firecrawl.dev/v2/scrape");
  assert.equal(requests[0].body.url, "https://app.cielo.finance/bundles/101/portfolio");
  assert.equal(result.metadata.bundleId, "101");
  assert.equal(result.metadata.parserVersion, "cielo-portfolio-v1");
});

test("fetchCieloPortfolio retries Firecrawl rate limits before succeeding", async () => {
  const statuses: number[] = [];
  const result = await fetchCieloPortfolio({
    firecrawlApiKey: "test-firecrawl-key",
    bundleUrl: "https://app.cielo.finance/bundles/101/portfolio",
    waitMs: 0,
    timeoutMs: 1000,
    retries: 1,
    rateLimitRetryMs: 0,
    retryMaxMs: 0,
    fetchImpl: async () => {
      if (statuses.length === 0) {
        statuses.push(429);
        return new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "0" },
        });
      }
      statuses.push(200);
      return new Response(JSON.stringify({ success: true, data: { markdown: MARKDOWN } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.deepEqual(statuses, [429, 200]);
  assert.equal(result.metadata.rowCount, 2);
});

test("fetchCieloPortfolio retries a timed-out Firecrawl request instead of failing the entity", async () => {
  let attempts = 0;
  const result = await fetchCieloPortfolio({
    firecrawlApiKey: "test-firecrawl-key",
    bundleUrl: "https://app.cielo.finance/bundles/101/portfolio",
    waitMs: 0,
    timeoutMs: 10,
    retries: 1,
    retryBaseMs: 0,
    retryMaxMs: 0,
    fetchImpl: async (_url, init) => {
      attempts += 1;
      if (attempts === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted", "AbortError"));
          }, { once: true });
        });
      }
      return new Response(JSON.stringify({ success: true, data: { markdown: MARKDOWN } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal(attempts, 2);
  assert.equal(result.metadata.rowCount, 2);
});

test("parseCieloPortfolioMarkdown accepts a verified zero-balance portfolio", () => {
  const parsed = parseCieloPortfolioMarkdown([
    "Total portfolio value: $0.00",
    "",
    "| Token | Chain | Amount | Price | USD Value |",
    "| --- | --- | --- | --- | --- |",
  ].join("\n"));

  assert.equal(parsed.balances.length, 0);
  assert.equal(parsed.parsedTotalUsd, 0);
  assert.equal(parsed.displayedTotalUsd, 0);
});

test("fetchCieloPortfolio retries empty Cielo table responses with a fresh scrape", async () => {
  const requestBodies: any[] = [];
  const result = await fetchCieloPortfolio({
    firecrawlApiKey: "test-firecrawl-key",
    bundleUrl: "https://app.cielo.finance/bundles/101/portfolio",
    waitMs: 0,
    timeoutMs: 1000,
    retries: 1,
    retryBaseMs: 0,
    retryMaxMs: 0,
    cacheMaxAgeMs: 300000,
    storeInCache: true,
    fetchImpl: async (_url, init) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      const markdown = requestBodies.length === 1
        ? [
            "Total USD Value",
            "",
            "| Token | Amount Held | Price | USD Value |",
            "| --- | --- | --- | --- |",
          ].join("\n")
        : MARKDOWN;
      return new Response(JSON.stringify({ success: true, data: { markdown } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal(result.metadata.rowCount, 2);
  assert.equal(requestBodies.length, 2);
  assert.equal(requestBodies[0].maxAge, 300000);
  assert.equal(requestBodies[0].storeInCache, true);
  assert.equal(requestBodies[1].maxAge, 0);
  assert.equal(requestBodies[1].storeInCache, false);
});

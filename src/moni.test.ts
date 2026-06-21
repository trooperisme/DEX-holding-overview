import test from "node:test";
import assert from "node:assert/strict";
import { buildMoniHandleCandidates, buildMoniUrl, fetchMoniScoreDataForToken, getMoniLookupTimeoutMs, parseMoniMarkdown } from "./moni";

test("buildMoniUrl builds the discover URL from a Twitter handle", () => {
  assert.equal(buildMoniUrl("GeniusTerminal"), "https://discover.getmoni.io/GeniusTerminal");
});

test("buildMoniHandleCandidates adds case-sensitive Moni fallback slugs", () => {
  assert.deepEqual(buildMoniHandleCandidates("derivexyz", "Derive"), ["derivexyz", "DeriveXYZ"]);
  assert.deepEqual(buildMoniHandleCandidates("rei_labs", "Unit 00 - Rei"), ["rei_labs"]);
});

test("buildMoniHandleCandidates can add token symbol and name fallback slugs", () => {
  assert.deepEqual(
    buildMoniHandleCandidates("pumpfun", "Pump", {
      tokenSymbol: "PUMP",
      includeTokenFallbacks: true,
    }),
    ["pumpfun", "PumpFUN", "PUMP", "pump", "Pump"],
  );
});

test("parseMoniMarkdown extracts score, level, and momentum data", () => {
  const parsed = parseMoniMarkdown(`
Moni Score

The Moni Score is a metric that combines the quality and quantity of smart mentions.

Level: 8. Top

45384

- 0
- 100
- 500
- 2000
- 4000
- 8000
- 15000
- 25000
- infinity

Momentum Score

Momentum Score reflects how quickly a project is gaining traction.

Top 130 of 52125

753%
`);

  assert.deepEqual(parsed, {
    moniScore: 45384,
    moniLevel: 8,
    moniLevelName: "Top",
    moniMomentumScorePct: 753,
    moniMomentumRank: 130,
  });
});

test("parseMoniMarkdown handles profiles without momentum data", () => {
  const parsed = parseMoniMarkdown(`
Moni Score

Level: 3. Developing

722

- 0
- 100
- 500
`);

  assert.deepEqual(parsed, {
    moniScore: 722,
    moniLevel: 3,
    moniLevelName: "Developing",
    moniMomentumScorePct: null,
    moniMomentumRank: null,
  });
});

test("parseMoniMarkdown returns null when the score block is missing", () => {
  assert.equal(parseMoniMarkdown("No project data here"), null);
});

test("getMoniLookupTimeoutMs never allows a timeout shorter than the render wait floor", () => {
  assert.equal(getMoniLookupTimeoutMs(), 10000);
  assert.equal(getMoniLookupTimeoutMs(8000), 10000);
  assert.equal(getMoniLookupTimeoutMs(30000), 30000);
});

test("fetchMoniScoreDataForToken tries fallback candidates after an internal timeout", async () => {
  const originalFetch = global.fetch;
  const requestedUrls: string[] = [];
  try {
    global.fetch = ((_: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const body = JSON.parse(String(init?.body || "{}")) as { url?: string };
        requestedUrls.push(String(body.url || ""));
        if (requestedUrls.length === 1) {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("This operation was aborted", "AbortError"));
          });
          return;
        }

        resolve(
          new Response(
            JSON.stringify({
              success: true,
              data: {
                markdown: `
Moni Score
Level: 3. Developing
722
`,
              },
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
        );
      })) as unknown as typeof fetch;

    const score = await fetchMoniScoreDataForToken("test-key", "pumpfun", "Pump", {
      timeoutMs: 5,
    });

    assert.equal(score?.moniScore, 722);
    assert.deepEqual(requestedUrls, ["https://discover.getmoni.io/pumpfun", "https://discover.getmoni.io/PumpFUN"]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("fetchMoniScoreDataForToken reports exhausted internal timeouts as regular errors", async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = ((_: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("This operation was aborted", "AbortError"));
        });
      })) as unknown as typeof fetch;

    await assert.rejects(
      () =>
        fetchMoniScoreDataForToken("test-key", "pumpfun", "Pump", {
          timeoutMs: 5,
          maxCandidates: 1,
        }),
      /Moni scrape timed out for @pumpfun/,
    );
  } finally {
    global.fetch = originalFetch;
  }
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createStorage } from "./storage";
import { parseTrenchIndexPayload } from "./trench-index";

const payload = {
  today: {
    day: "2026-11-05",
    score: 31,
    band: "cold",
    components: {
      pad_volume: { value: 1_049_254_958.761241 },
      tokens_launched: { value: 53_958 },
      bot_volume: { value: 171_250_043.88578922 },
      bot_fees: { value: 1_203_717.0108815203 },
    },
  },
};

test("Trench Index parser and local storage preserve the source market day", async () => {
  const parsed = parseTrenchIndexPayload(payload, "2026-11-06T10:00:00.000Z");
  assert.deepEqual(parsed, {
    day: "2026-11-05",
    score: 31,
    band: "cold",
    padVolume: 1_049_254_958.761241,
    tokensLaunched: 53_958,
    botVolume: 171_250_043.88578922,
    botFees: 1_203_717.0108815203,
    sourceUrl: "https://tehcscreener.com/api/trench",
    fetchedAt: "2026-11-06T10:00:00.000Z",
  });

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dex-trench-index-test-"));
  const previousDatabaseUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  const storage = createStorage(cwd);
  try {
    const first = await storage.upsertTrenchIndex(parsed);
    const second = await storage.upsertTrenchIndex({ ...parsed, score: 32, fetchedAt: "2026-11-06T11:00:00.000Z" });
    const latest = await storage.getLatestTrenchIndex();
    assert.equal(first.id, second.id);
    assert.equal(latest?.score, 32);
    assert.equal(latest?.day, "2026-11-05");
    assert.equal(latest?.fetchedAt, "2026-11-06T11:00:00.000Z");
  } finally {
    await storage.close();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("Trench Index parser rejects unknown bands and out-of-range scores", () => {
  assert.throws(() => parseTrenchIndexPayload({ today: { day: "2026-11-05", score: 101, band: "hot" } }));
  assert.throws(() => parseTrenchIndexPayload({ today: { day: "2026-11-05", score: 31, band: "unknown" } }));
});

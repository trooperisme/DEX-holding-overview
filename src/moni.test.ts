import test from "node:test";
import assert from "node:assert/strict";
import { buildMoniHandleCandidates, buildMoniUrl, parseMoniMarkdown } from "./moni";

test("buildMoniUrl builds the discover URL from a Twitter handle", () => {
  assert.equal(buildMoniUrl("GeniusTerminal"), "https://discover.getmoni.io/GeniusTerminal");
});

test("buildMoniHandleCandidates adds case-sensitive Moni fallback slugs", () => {
  assert.deepEqual(buildMoniHandleCandidates("derivexyz", "Derive"), ["derivexyz", "DeriveXYZ"]);
  assert.deepEqual(buildMoniHandleCandidates("rei_labs", "Unit 00 - Rei"), ["rei_labs"]);
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

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
function dashboard(source?: string) {
  const node = { addEventListener() {}, value: "", classList: { add() {}, remove() {} } };
  const context = vm.createContext({ document: { getElementById: () => node, querySelector: () => node, querySelectorAll: () => [], addEventListener() {} }, Intl, console });
  vm.runInContext((source || fs.readFileSync(path.resolve(__dirname, "../dashboard/main.js"), "utf8")).replace(/\ninit\(\);\s*$/, ""), context);
  return context;
}
test("delayed completion does not make the score line run backwards or mutate history", () => {
  const c = dashboard();
  const points = [
    { snapshotId: 156, score: 100, snapshotCreatedAt: "2026-11-16T00:00:00Z", snapshotFinishedAt: "2026-11-16T01:00:00Z" },
    { snapshotId: 157, score: 50, snapshotCreatedAt: "2026-11-17T00:00:00Z", snapshotFinishedAt: "2026-11-18T23:00:00Z" },
    { snapshotId: 158, score: 130, snapshotCreatedAt: "2026-11-18T00:00:00Z", snapshotFinishedAt: "2026-11-18T01:00:00Z" },
  ];
  c.points = points;
  const before = JSON.stringify(points);
  for (const scale of ["log", "linear"]) {
    const html = vm.runInContext(`state.trendScale = '${scale}'; buildScoreChart(points, 'token')`, c);
    const xs = [...html.matchAll(/cx="([\d.]+)"/g)].map(m => Number(m[1]));
    assert.equal(xs.length, 3);
    assert.ok(xs.every((x, i) => i === 0 || x >= xs[i - 1]), xs.join(","));
    assert.equal(JSON.stringify(points), before);
  }
});
test("explanation uses three columns and all contribution groups, including unchanged and missing inputs", () => {
  const c = dashboard();
  c.a = { snapshotId: 163, tokenAmount: 100, holdingsUsd: 1000, smwIn: 2, favoriteEntityCount: 0, marketCap: null };
  c.b = { ...c.a, snapshotId: 164, holdingsUsd: 1200, trajectory: { direction: "rising", drivers: [{label: "Holding size", points: 42}] } };
  const html = vm.runInContext("buildDriverExplanation(a,b)", c);
  assert.equal((html.match(/scope="col"/g) || []).length, 3);
  assert.equal((html.match(/scope="row"/g) || []).length, 10);
  assert.match(html, /42 pts/);
  assert.doesNotMatch(html, /trend-driver-grid/);
  const summary = vm.runInContext("buildTrajectorySummary(b)", c);
  assert.doesNotMatch(summary, /Matched|confirmed buys|token amount/);
});

test("captured Nov23 chronology keeps one continuous line including partial #157", () => {
  const c = dashboard();
  c.points = [
    {snapshotId:156, snapshotStatus:'success',score:100, snapshotCreatedAt:'2026-11-15T23:26:25.895Z',snapshotFinishedAt:'2026-11-15T23:42:09.408Z'},
    {snapshotId:157, snapshotStatus:'partial',score:50, snapshotCreatedAt:'2026-11-16T09:47:47.432Z',snapshotFinishedAt:'2026-11-17T16:33:03.928Z'},
    {snapshotId:158, snapshotStatus:'success',score:130, snapshotCreatedAt:'2026-11-17T02:31:44.455Z',snapshotFinishedAt:'2026-11-17T02:47:43.696Z'},
  ];
  const html = vm.runInContext('buildScoreChart(points,"token")', c);
  assert.doesNotMatch(html, /score-chart__dot--partial/);
  assert.match(html, /#157 \(partial\)/);
  const segments = [...html.matchAll(/<polyline[^>]*points="([^"]*)"/g)];
  assert.equal(segments.length, 1);
  assert.equal(segments[0][1].split(' ').length, 3);
});

test("short histories and zero scores render finite chart coordinates", () => {
  const c = dashboard();
  for (const points of [[], [{score: 0, snapshotId:1, snapshotCreatedAt:'2026-11-23T00:00:00Z'}], [{score: 1, snapshotId:1, snapshotCreatedAt:'2026-11-22T00:00:00Z'}, {score:0,snapshotId:2,snapshotCreatedAt:'2026-11-23T00:00:00Z'}]]) {
    c.points = points;
    for (const scale of ['log', 'linear']) {
      const html = vm.runInContext(`state.trendScale='${scale}'; buildScoreChart(points,'key')`, c);
      assert.doesNotMatch(html, /NaN|Infinity/);
    }
  }
});
test("mobile chart uses a compact viewBox and readable endpoint labels", () => {
  const c = dashboard();
  c.document.documentElement = {clientWidth:390};
  c.points = Array.from({length:10}, (_,i)=>({snapshotId:i+1, score:100+i,snapshotCreatedAt:`2026-11-${String(i+1).padStart(2,'0')}T00:00:00Z`}));
  const html = vm.runInContext('buildScoreChart(points,"key")',c);
  assert.match(html, /viewBox="0 0 310 230"/);
  assert.equal((html.match(/#\d+ ·/g)||[]).length, 12); // ten native tooltips plus two axis labels
});
test("raw increases, decreases and flat changes have separate signed styles", () => {
  const c=dashboard();
  c.a={snapshotId:163,holdingsUsd:1000,smwIn:3,favoriteEntityCount:1,tokenAmount:100,marketCap:10000};
  c.b={...c.a,snapshotId:164,holdingsUsd:1200,smwIn:2,trajectory:{direction:'rising',drivers:[{label:'Holding size',points:50},{label:'Entity convergence',points:-20}]}};
  const html=vm.runInContext('buildDriverExplanation(a,b)',c);
  assert.match(html, /trend-factor-delta is-positive">\+20.0%/);
  assert.match(html, /trend-factor-delta is-negative">-33.3%/);
  assert.match(html, /trend-factor-delta is-neutral">0.0%/);
  assert.match(html, /td class="is-positive"[^>]*>\+50 pts/);
  assert.match(html, /td class="is-negative"[^>]*>−20 pts/);
});

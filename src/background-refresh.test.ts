import assert from "node:assert/strict";
import test from "node:test";
import { createBackgroundRefresh, DispatchStore, WorkflowRun, workflowJob } from "./background-refresh";
import { SnapshotRecord } from "./types";

const time = Date.parse("2026-11-26T07:00:00Z");
const run: WorkflowRun = { id: 42, status: "in_progress", conclusion: null, display_title: "Manual scan",
  created_at: new Date(time).toISOString(), updated_at: new Date(time + 60_000).toISOString(),
  html_url: "https://github.com/trooperisme/DEX-holding-overview/actions/runs/42" };
const snapshot: SnapshotRecord = { id: 170, status: "running", providerLabel: "Cielo", totalEntities: 82,
  entitiesCompleted: 20, entitiesFailed: 2, totalRows: 300, errorMessage: null,
  createdAt: new Date(time + 30_000).toISOString(), finishedAt: null };

function memoryStore(): DispatchStore {
  let record: Awaited<ReturnType<DispatchStore['latest']>> = null;
  let tail = Promise.resolve();
  return {
    latest: async () => record,
    locked(fn) {
      const result = tail.then(() => fn(record, async next => { record = { ...next }; }));
      tail = result.then(() => {}, () => {});
      return result;
    },
  };
}

test("worker queue never attaches an older successful snapshot", () => {
  const job = workflowJob({ ...run, status: "queued" }, [{ ...snapshot, createdAt: new Date(time - 60_000).toISOString(), status: "success" }]);
  assert.equal(job.running, true);
  assert.equal(job.phase, "queued");
  assert.equal(job.progress.snapshotId, null);
  assert.equal(job.progress.entitiesCompleted, 0);
});

test("worker exposes durable counts, finalization and partial completion", () => {
  const job = workflowJob(run, [snapshot]);
  assert.equal(job.phase, "fetching");
  assert.equal(job.progress.entitiesFailed, 2);
  const finalizing = workflowJob(run, [{ ...snapshot, entitiesCompleted: 80 }]);
  assert.equal(finalizing.phase, "finalizing");
  assert.equal(finalizing.running, true);
  const done = workflowJob({ ...run, status: "completed", conclusion: "failure" }, [{ ...snapshot, status: "partial" }]);
  assert.equal(done.running, false);
  assert.equal(done.progress.status, "partial");
  assert.equal(done.progress.snapshotId, 170);
});

test("worker failure before scan reports failure instead of an old snapshot", () => {
  const done = workflowJob({ ...run, status: "completed", conclusion: "failure" }, []);
  assert.equal(done.progress.status, "failed");
  assert.equal(done.progress.snapshotId, null);
  assert.match(done.progress.errorMessage!, /before a completed snapshot/);
});

test("cancelled worker does not leave the UI running forever", () => {
  const done = workflowJob({ ...run, status: "completed", conclusion: "cancelled" }, [snapshot]);
  assert.equal(done.running, false);
  assert.equal(done.progress.status, "canceled");
});

test("concurrent manual requests dispatch once and reuse the pending worker", async () => {
  let dispatches = 0;
  const service = createBackgroundRefresh({ store: memoryStore(), now: () => time, token: () => "test-only",
    fetch: (async (url, init) => {
      if (init?.method === "POST") {
        dispatches++;
        const body = JSON.parse(String(init.body));
        assert.equal(body.ref, "main");
        assert.equal(body.return_run_details, true);
        assert.match(body.inputs.requestId, /^[0-9a-f-]{36}$/);
        return new Response(JSON.stringify({ workflow_run_id: 42 }));
      }
      return new Response(JSON.stringify(String(url).endsWith('/runs/42') ? { ...run, status: "queued" } : { workflow_runs: [] }));
    }) as typeof fetch,
  });
  const [first, second] = await Promise.all([service.start([]), service.start([])]);
  assert.equal(dispatches, 1);
  assert.equal(first.running, true);
  assert.equal(second.jobId, "github-42");
  assert.equal((await service.status([]))?.jobId, "github-42");
});

test("a scheduled run is reused without any manual dispatch", async () => {
  let dispatches = 0;
  const service = createBackgroundRefresh({ store: memoryStore(), now: () => time, token: () => "test-only",
    fetch: (async (_url, init) => {
      if (init?.method === "POST") dispatches++;
      return new Response(JSON.stringify({ workflow_runs: [run] }));
    }) as typeof fetch,
  });
  assert.equal((await service.start([snapshot])).jobId, "github-42");
  assert.equal(dispatches, 0);
});

test("uncertain dispatch is retained across service instances and never auto-retried", async () => {
  let dispatches = 0;
  const store = memoryStore();
  const fetcher = (async (_url: unknown, init?: RequestInit) => {
    if (init?.method === "POST") { dispatches++; throw new Error("connection lost after acceptance"); }
    return new Response(JSON.stringify({ workflow_runs: [] }));
  }) as typeof fetch;
  const options = { store, fetch: fetcher, now: () => time, token: () => "test-only" };
  const first = await createBackgroundRefresh(options).start([]);
  const second = await createBackgroundRefresh(options).start([]);
  assert.equal(dispatches, 1);
  assert.equal(first.jobId, second.jobId);
  assert.equal(second.running, true);
});

test("missing worker token fails closed before network or storage access", async () => {
  const service = createBackgroundRefresh({ token: () => "", fetch: (() => { throw new Error("must not fetch"); }) as typeof fetch });
  assert.equal(await service.status([]), null);
  await assert.rejects(service.start([]), /DEX_GITHUB_ACTIONS_TOKEN/);
});

test("explicit dispatch rejection produces a visible error", async () => {
  const service = createBackgroundRefresh({ store: memoryStore(), now: () => time, token: () => "test-only",
    fetch: (async (_url, init) => init?.method === "POST" ? new Response('{}', { status: 403 })
      : new Response(JSON.stringify({ workflow_runs: [] }))) as typeof fetch,
  });
  await assert.rejects(service.start([]), /HTTP 403/);
  assert.equal((await service.status([]))?.progress.status, "failed");
});

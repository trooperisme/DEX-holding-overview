import { randomUUID } from "node:crypto";
import { getPostgresPool, withPostgresTransaction } from "./storage-postgres";
import { RefreshJobState, SnapshotRecord, SnapshotStatus } from "./types";

const REPO = "trooperisme/DEX-holding-overview";
const WORKFLOW = "dex-refresh.yml";
const PENDING_TIMEOUT_MS = 15 * 60_000;
type DispatchRecord = { id: string; createdAt: string; runId?: number; error?: string };
export type WorkflowRun = {
  id: number; status: string; conclusion: string | null; display_title: string;
  created_at: string; updated_at: string; html_url: string;
};
export type BackgroundJob = RefreshJobState & { phase: "queued" | "preparing" | "fetching" | "finalizing" | "complete"; workerUrl?: string };

export function workflowJob(run: WorkflowRun, snapshots: SnapshotRecord[]): BackgroundJob {
  const running = run.status !== "completed";
  const queued = ["queued", "waiting", "requested", "pending"].includes(run.status);
  // The workflow's concurrency group permits only one scanner. Never attach an
  // older snapshot to a worker that has not reached the scan step yet.
  const snapshot = snapshots.find(s => Date.parse(s.createdAt) >= Date.parse(run.created_at)
    && (running || Date.parse(s.createdAt) <= Date.parse(run.updated_at)));
  const processed = (snapshot?.entitiesCompleted || 0) + (snapshot?.entitiesFailed || 0);
  const phase = !running ? "complete" : queued ? "queued" : !snapshot ? "preparing"
    : processed >= snapshot.totalEntities ? "finalizing" : "fetching";
  const status: SnapshotStatus = running ? "running" : run.conclusion === "cancelled" ? "canceled"
    : snapshot && ["success", "partial"].includes(snapshot.status) ? snapshot.status : "failed";
  const error = !running && status === "failed"
    ? snapshot?.errorMessage || "Background worker stopped before a completed snapshot was saved."
    : null;
  const activity = phase === "queued" ? "Waiting for background worker" : phase === "preparing" ? "Preparing background worker"
    : phase === "finalizing" ? "Finalizing snapshot" : phase === "fetching" ? "Fetching tracked portfolios" : null;
  return {
    jobId: `github-${run.id}`, running, startedAt: run.created_at, finishedAt: running ? null : run.updated_at,
    providerLabel: snapshot?.providerLabel || "Cielo", phase, workerUrl: run.html_url,
    progress: {
      snapshotId: snapshot?.id || null, totalEntities: snapshot?.totalEntities || 0,
      entitiesCompleted: snapshot?.entitiesCompleted || 0, entitiesFailed: snapshot?.entitiesFailed || 0,
      totalRows: snapshot?.totalRows || 0, currentEntity: activity, currentEntityIndex: null, status, errorMessage: error,
    },
    logs: [{ at: run.updated_at, tone: error ? "error" : "info", message: error || activity || `Worker finished: ${status}.` }],
  };
}

function pendingJob(record: DispatchRecord, now: number): BackgroundJob {
  const error = record.error || (now - Date.parse(record.createdAt) > PENDING_TIMEOUT_MS
    ? "The worker did not appear within 15 minutes. Check the worker before trying again." : null);
  return {
    jobId: record.id, running: !error, startedAt: record.createdAt, finishedAt: error ? new Date(now).toISOString() : null,
    providerLabel: "Cielo", phase: error ? "complete" : "queued",
    progress: { snapshotId: null, totalEntities: 0, entitiesCompleted: 0, entitiesFailed: 0, totalRows: 0,
      currentEntity: error ? null : "Confirming background worker", currentEntityIndex: null,
      status: error ? "failed" : "running", errorMessage: error },
    logs: [],
  };
}

export interface DispatchStore {
  latest(): Promise<DispatchRecord | null>;
  locked<T>(fn: (record: DispatchRecord | null, save: (record: DispatchRecord) => Promise<void>) => Promise<T>): Promise<T>;
}

function postgresStore(): DispatchStore {
  const schema = process.env.DATABASE_SCHEMA?.trim() || "dex";
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) throw new Error("Invalid database schema");
  const table = `"${schema}"."manual_refresh_dispatch"`;
  let ready: Promise<void> | null = null;
  async function ensure() {
    if (!ready) ready = withPostgresTransaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1), 117092)", [schema]);
      await client.query(`CREATE TABLE IF NOT EXISTS ${table} (singleton integer primary key CHECK (singleton = 1), request jsonb NOT NULL)`);
    }).catch(error => { ready = null; throw error; });
    await ready;
  }
  return {
    async latest() {
      await ensure();
      const result = await getPostgresPool().query(`SELECT request FROM ${table} WHERE singleton = 1`);
      return result.rows[0]?.request || null;
    },
    async locked(fn) {
      await ensure();
      return withPostgresTransaction(async client => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1), 117093)", [schema]);
        const result = await client.query(`SELECT request FROM ${table} WHERE singleton = 1`);
        return fn(result.rows[0]?.request || null, async record => {
          await client.query(`INSERT INTO ${table} (singleton, request) VALUES (1, $1::jsonb)
            ON CONFLICT (singleton) DO UPDATE SET request = EXCLUDED.request`, [JSON.stringify(record)]);
        });
      });
    },
  };
}

export function createBackgroundRefresh(options: {
  store?: DispatchStore; fetch?: typeof fetch; now?: () => number; token?: () => string;
} = {}) {
  const token = options.token || (() => process.env.DEX_GITHUB_ACTIONS_TOKEN?.trim() || "");
  const now = options.now || Date.now;
  const fetcher = options.fetch || fetch;
  let store: DispatchStore | null = options.store || null;
  const getStore = () => store ||= postgresStore();
  async function github(endpoint: string, body?: object) {
    const response = await fetcher(`https://api.github.com/repos/${REPO}/actions/${endpoint}`, {
      method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${token()}`, accept: "application/vnd.github+json",
        "content-type": "application/json", "X-GitHub-Api-Version": "2026-03-10" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      const error = new Error(`Background worker API returned HTTP ${response.status}.`);
      Object.assign(error, { status: response.status });
      throw error;
    }
    return response.status === 204 ? {} : response.json();
  }
  async function runs(): Promise<WorkflowRun[]> {
    const result = await github(`workflows/${WORKFLOW}/runs?branch=main&per_page=30`);
    return result.workflow_runs || [];
  }
  async function resolve(record: DispatchRecord | null, list: WorkflowRun[], snapshots: SnapshotRecord[]) {
    const active = list.find(run => run.status === "in_progress") || list.find(run => run.status !== "completed");
    if (active) return workflowJob(active, snapshots);
    let match = record && list.find(run => run.id === record.runId || run.display_title.includes(record.id));
    if (!match && record?.runId) match = await github(`runs/${record.runId}`) as WorkflowRun;
    const newest = list[0];
    if (record && (!newest || Date.parse(record.createdAt) >= Date.parse(newest.created_at) || match)) {
      if (match && (!newest || Date.parse(match.created_at) >= Date.parse(newest.created_at))) return workflowJob(match, snapshots);
      if (!match && (!newest || Date.parse(record.createdAt) >= Date.parse(newest.created_at))) return pendingJob(record, now());
    }
    return newest ? workflowJob(newest, snapshots) : null;
  }
  return {
    configured: () => Boolean(token()),
    async status(snapshots: SnapshotRecord[]): Promise<BackgroundJob | null> {
      if (!token()) return null;
      const [record, list] = await Promise.all([getStore().latest(), runs()]);
      return resolve(record, list, snapshots);
    },
    async start(snapshots: SnapshotRecord[]): Promise<BackgroundJob> {
      if (!token()) throw new Error("Manual scan needs DEX_GITHUB_ACTIONS_TOKEN configured on Vercel.");
      const result = await getStore().locked(async (previous, save) => {
        const existing = await resolve(previous, await runs(), snapshots);
        if (existing?.running) return { job: existing };
        const record: DispatchRecord = { id: randomUUID(), createdAt: new Date(now()).toISOString() };
        await save(record);
        try {
          const response = await github(`workflows/${WORKFLOW}/dispatches`, {
            ref: "main", inputs: { requestId: record.id }, return_run_details: true,
          });
          if (Number.isSafeInteger(response.workflow_run_id)) record.runId = response.workflow_run_id;
        } catch (error) {
          // An explicit rejection is retryable. A timeout may already have
          // accepted the dispatch: retain the pending record to prevent repeats.
          const status = (error as Error & { status?: number }).status;
          if (status && status < 500) record.error = (error as Error).message;
        }
        await save(record);
        return { job: pendingJob(record, now()), error: record.error };
      });
      if (result.error) throw new Error(result.error);
      return result.job;
    },
  };
}

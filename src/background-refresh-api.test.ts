import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import * as background from "./background-refresh";
import * as storageModule from "./storage";
import * as jobsModule from "./refresh-jobs";

function request(server: http.Server, pathname: string, method = "GET", cookie = "", body = "") {
  const address = server.address();
  assert(address && typeof address !== "string");
  return new Promise<{ status: number; body: string; cookies: string[] }>((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: address.port, path: pathname, method,
      headers: { cookie, "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(body) } }, res => {
      let text = "";
      res.on("data", chunk => text += chunk);
      res.on("end", () => resolve({ status: res.statusCode!, body: text, cookies: res.headers["set-cookie"] || [] }));
    });
    req.on("error", reject); req.end(body);
  });
}

test("Vercel manual refresh uses the background dispatcher and never the in-process scanner", async () => {
  const oldEnv = { ...process.env };
  const oldStorage = storageModule.createStorage;
  const oldBackground = background.createBackgroundRefresh;
  const oldJobs = jobsModule.createRefreshJobManager;
  let dispatches = 0;
  let localScans = 0;
  const queued = { jobId: "test-queued-worker", running: true, startedAt: new Date().toISOString(), finishedAt: null,
    providerLabel: "Cielo", phase: "queued", logs: [], progress: { snapshotId: null, totalEntities: 0,
      entitiesCompleted: 0, entitiesFailed: 0, totalRows: 0, currentEntity: "Waiting for worker",
      currentEntityIndex: null, status: "running", errorMessage: null } };
  Object.assign(process.env, { VERCEL: "1", DATABASE_URL: "test-only-not-a-real-database", DASHBOARD_PASSWORD: "test-only-password", NODE_ENV: "test" });
  // These substitutes make a real scan/network/database connection impossible.
  (storageModule as any).createStorage = () => ({ getSnapshotSummaries: async () => [], close: async () => {} });
  (background as any).createBackgroundRefresh = () => ({ configured: () => true, status: async () => queued,
    start: async () => { dispatches++; return queued; } });
  (jobsModule as any).createRefreshJobManager = () => ({ getCurrent: () => null, getLatest: () => null,
    start: () => { localScans++; throw new Error("must not run a scan on Vercel"); } });
  let server: http.Server | null = null;
  const appPath = require.resolve("./app");
  delete require.cache[appPath];
  try {
    const app = require("./app").default;
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server!.once("listening", resolve));
    assert.equal((await request(server!, "/api/refresh", "POST")).status, 401);
    const login = await request(server!, "/login", "POST", "", "password=test-only-password&next=%2Fdashboard%2F");
    const cookie = login.cookies[0].split(";")[0];
    const response = await request(server!, "/api/refresh", "POST", cookie);
    assert.equal(response.status, 202);
    assert.equal(JSON.parse(response.body).job.phase, "queued");
    const status = JSON.parse((await request(server!, "/api/refresh/status", "GET", cookie)).body);
    assert.equal(status.currentJob.jobId, queued.jobId);
    assert.equal(status.manualScanConfigured, true);
    assert.equal(dispatches, 1);
    assert.equal(localScans, 0);
  } finally {
    if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    (storageModule as any).createStorage = oldStorage;
    (background as any).createBackgroundRefresh = oldBackground;
    (jobsModule as any).createRefreshJobManager = oldJobs;
    delete require.cache[appPath];
    for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
    Object.assign(process.env, oldEnv);
  }
});

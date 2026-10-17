import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createStorage } from "./storage";
import { RawHoldingRecord } from "./types";

function tokenHolding(snapshotId: number, entityId: number): RawHoldingRecord {
  return {
    snapshotId,
    entityId,
    tokenKey: "8453:0xfav",
    tokenSymbol: "FAV",
    tokenName: "Favorite Token",
    tokenAddress: "0xfav",
    networkName: "Base",
    chainId: 8453,
    balance: "1000",
    balanceRaw: "1000",
    balanceUsd: 1000,
    price: null,
    marketCap: 5_000_000,
    liquidityUsd: 100000,
    volume24h: 5000,
    txns24h: 25,
    tokenAgeHours: 24 * 40,
    fetchedAt: new Date().toISOString(),
  };
}

function request(
  server: http.Server,
  requestPath: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const address = server.address();
  assert(address && typeof address !== "string");

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: address.port,
        path: requestPath,
        method: options.method || "GET",
        headers: options.headers,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode || 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function getSessionCookie(header: string | string[] | undefined): string {
  const cookies = Array.isArray(header) ? header : header ? [header] : [];
  const sessionCookie = cookies.find((cookie) => cookie.startsWith("dex_dashboard_session="));
  assert(sessionCookie);
  return sessionCookie.split(";")[0];
}

test("overview API applies favorite entity scoring", async () => {
  const originalCwd = process.cwd();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dex-overview-api-test-"));
  const previousDatabaseUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  process.chdir(cwd);

  try {
    const storage = createStorage(cwd);
    await storage.replaceEntities([
      {
        entityName: "Crypto Andrew",
        sourceUrl: "https://app.cielo.finance/bundles/101/portfolio",
        resolvedLabel: "andrew",
        linkType: "bundle",
        walletAddresses: ["0xandrew"],
      },
    ]);
    const [entity] = await storage.getEntities();
    const snapshotId = await storage.createSnapshot(1, null);
    await storage.insertRawHoldingsForEntity(snapshotId, entity.id, [tokenHolding(snapshotId, entity.id)]);
    await storage.updateSnapshot({
      id: snapshotId,
      status: "success",
      entitiesCompleted: 1,
      entitiesFailed: 0,
      totalRows: 1,
      finishedAt: new Date().toISOString(),
    });
    await storage.close();

    const { createApp } = await import("./app");
    const server = await new Promise<http.Server>((resolve) => {
      const listening = createApp().listen(0, "127.0.0.1", () => resolve(listening));
    });
    try {
      const loginBody = new URLSearchParams({ username: "admin", password: "112233" }).toString();
      const login = await request(server, "/login", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "content-length": String(Buffer.byteLength(loginBody)),
        },
        body: loginBody,
      });
      const sessionCookie = getSessionCookie(login.headers["set-cookie"]);
      const response = await request(
        server,
        `/api/overview?snapshotId=${snapshotId}&minBalanceUsd=111&minSmwIn=1&minLiquidityUsd=11111&favoriteEntities=${encodeURIComponent(JSON.stringify(["Crypto Andrew"]))}`,
        { headers: { cookie: sessionCookie } },
      );
      assert.equal(response.status, 200);
      const payload = JSON.parse(response.body);
      assert.equal(payload.rows.length, 1);
      assert.equal(payload.rows[0].tokenSymbol, "FAV");
      assert.equal(payload.rows[0].favoriteEntityCount, 1);
      assert.deepEqual(payload.rows[0].favoriteEntityNames, ["Crypto Andrew"]);
      assert.equal(payload.rows[0].favoriteScoreMultiplier, 1.5);
      assert.ok(payload.rows[0].score >= payload.rows[0].baseScore);
      assert.ok(Number.isFinite(payload.rows[0].score));
    } finally {
      await closeServer(server);
    }
  } finally {
    process.chdir(originalCwd);
    if (previousDatabaseUrl == null) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createStorage } from "./storage";

function request(
  server: http.Server,
  requestPath: string,
  options: { method?: string; cookie?: string; json?: unknown; form?: URLSearchParams } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: any }> {
  const address = server.address();
  assert(address && typeof address !== "string");
  const body = options.json === undefined ? options.form?.toString() : JSON.stringify(options.json);
  const contentType = options.json === undefined ? "application/x-www-form-urlencoded" : "application/json";
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port: address.port,
      path: requestPath,
      method: options.method || "GET",
      headers: {
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...(body ? { "content-type": contentType, "content-length": String(Buffer.byteLength(body)) } : {}),
      },
    }, (res) => {
      let responseBody = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { responseBody += chunk; });
      res.on("end", () => resolve({
        status: res.statusCode || 0,
        headers: res.headers,
        body: responseBody && res.headers["content-type"]?.includes("application/json")
          ? JSON.parse(responseBody)
          : responseBody,
      }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

test("favorite entities persist and sync across browser sessions", async () => {
  const originalCwd = process.cwd();
  const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "dex-favorites-api-test-"));
  const previousDatabaseUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  process.chdir(tempCwd);

  try {
    const { createApp } = require(path.join(__dirname, "app")) as typeof import("./app");
    const server = await new Promise<http.Server>((resolve) => {
      const listening = createApp().listen(0, "127.0.0.1", () => resolve(listening));
    });
    try {
      const unauthorized = await request(server, "/api/favorite-entities");
      assert.equal(unauthorized.status, 401);

      const loginForm = new URLSearchParams({ username: "admin", password: "112233" });
      const firstLogin = await request(server, "/login", { method: "POST", form: loginForm });
      const secondLogin = await request(server, "/login", { method: "POST", form: loginForm });
      const firstCookie = (firstLogin.headers["set-cookie"] || [])[0]?.split(";")[0];
      const secondCookie = (secondLogin.headers["set-cookie"] || [])[0]?.split(";")[0];
      assert(firstCookie && secondCookie);

      const initial = await request(server, "/api/favorite-entities", { cookie: firstCookie });
      assert.deepEqual(initial.body.favoriteEntities, []);

      const merged = await request(server, "/api/favorite-entities/merge", {
        method: "POST",
        cookie: firstCookie,
        json: { favoriteEntities: ["Base Specialist | tommy 🌙", "Tux | DCDAO", "tux | dcdao"] },
      });
      assert.equal(merged.status, 200);
      assert.deepEqual(merged.body.favoriteEntities, ["Base Specialist | tommy 🌙", "Tux | DCDAO"]);

      const secondBrowser = await request(server, "/api/favorite-entities", { cookie: secondCookie });
      assert.deepEqual(secondBrowser.body.favoriteEntities, merged.body.favoriteEntities);

      const added = await request(server, "/api/favorite-entities", {
        method: "POST",
        cookie: secondCookie,
        json: { name: "Hansolar" },
      });
      assert.deepEqual(added.body.favoriteEntities, ["Base Specialist | tommy 🌙", "Tux | DCDAO", "Hansolar"]);

      const removed = await request(server, "/api/favorite-entities", {
        method: "DELETE",
        cookie: firstCookie,
        json: { name: "tux | dcdao" },
      });
      assert.deepEqual(removed.body.favoriteEntities, ["Base Specialist | tommy 🌙", "Hansolar"]);

      const invalid = await request(server, "/api/favorite-entities/merge", {
        method: "POST",
        cookie: firstCookie,
        json: { favoriteEntities: [""] },
      });
      assert.equal(invalid.status, 400);
    } finally {
      await closeServer(server);
    }

    const reopenedStorage = createStorage(tempCwd);
    assert.deepEqual(await reopenedStorage.getFavoriteEntityNames(), ["Base Specialist | tommy 🌙", "Hansolar"]);
    await reopenedStorage.close();
  } finally {
    process.chdir(originalCwd);
    if (previousDatabaseUrl == null) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    fs.rmSync(tempCwd, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import type http from "node:http";
import test from "node:test";

test("Vercel directs manual refresh to the long-running GitHub workflow before creating a snapshot", async () => {
  const previousVercel = process.env.VERCEL;
  process.env.VERCEL = "1";
  const { createApp } = require("./app") as typeof import("./app");
  const server = await new Promise<http.Server>((resolve) => {
    const listener = createApp().listen(0, "127.0.0.1", () => resolve(listener));
  });
  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const login = await fetch(`${base}/login`, {
      method: "POST",
      body: new URLSearchParams({ username: "admin", password: "112233", next: "/dashboard/" }),
      redirect: "manual",
    });
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    assert(cookie);
    const response = await fetch(`${base}/api/refresh`, { method: "POST", headers: { cookie } });
    assert.equal(response.status, 503);
    const payload = await response.json() as { manualRefreshUrl: string };
    assert.match(payload.manualRefreshUrl, /github\.com\/trooperisme\/DEX-holding-overview\/actions\/workflows\/dex-refresh\.yml/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (previousVercel == null) delete process.env.VERCEL;
    else process.env.VERCEL = previousVercel;
  }
});

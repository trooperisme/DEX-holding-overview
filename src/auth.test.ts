import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createApp } from "./app";

function startServer(): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = createApp().listen(0, "127.0.0.1", () => resolve(server));
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function request(
  server: http.Server,
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const address = server.address();
  assert(address && typeof address !== "string");

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: address.port,
        path,
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

function getSessionCookie(header: string | string[] | undefined): string {
  const cookies = Array.isArray(header) ? header : header ? [header] : [];
  const sessionCookie = cookies.find((cookie) => cookie.startsWith("dex_dashboard_session="));
  assert(sessionCookie);
  return sessionCookie.split(";")[0];
}

test("password protection redirects dashboard and blocks API requests without a session", async () => {
  const server = await startServer();
  try {
    const dashboardResponse = await request(server, "/dashboard/");
    const apiResponse = await request(server, "/api/health");

    assert.equal(dashboardResponse.status, 302);
    assert.equal(dashboardResponse.headers.location, "/login?next=%2Fdashboard%2F");
    assert.equal(apiResponse.status, 401);
    assert.deepEqual(JSON.parse(apiResponse.body), { error: "Authentication required" });
  } finally {
    await closeServer(server);
  }
});

test("login page creates a session cookie that unlocks the API", async () => {
  const server = await startServer();
  try {
    const body = new URLSearchParams({
      username: "admin",
      password: "112233",
      next: "/dashboard/",
    }).toString();
    const loginResponse = await request(server, "/login", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "content-length": String(Buffer.byteLength(body)),
      },
      body,
    });
    const sessionCookie = getSessionCookie(loginResponse.headers["set-cookie"]);
    const response = await request(server, "/api/health", {
      headers: { cookie: sessionCookie },
    });

    assert.equal(loginResponse.status, 302);
    assert.equal(loginResponse.headers.location, "/dashboard/");
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.body).ok, true);
    assert.equal(response.headers["x-powered-by"], undefined);
  } finally {
    await closeServer(server);
  }
});

test("login page rejects the wrong password without setting a session cookie", async () => {
  const server = await startServer();
  try {
    const body = new URLSearchParams({
      username: "admin",
      password: "wrong",
      next: "/dashboard/",
    }).toString();
    const response = await request(server, "/login", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "content-length": String(Buffer.byteLength(body)),
      },
      body,
    });

    assert.equal(response.status, 401);
    assert.equal(response.headers["set-cookie"], undefined);
    assert.match(response.body, /Invalid password/);
  } finally {
    await closeServer(server);
  }
});

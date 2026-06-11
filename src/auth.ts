import { createHmac, timingSafeEqual } from "node:crypto";
import express from "express";

const DEFAULT_DASHBOARD_PASSWORD = "112233";
const SESSION_COOKIE = "dex_dashboard_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function getDashboardPassword(): string {
  return process.env.DASHBOARD_PASSWORD?.trim() || DEFAULT_DASHBOARD_PASSWORD;
}

function getSessionSecret(): string {
  return process.env.DASHBOARD_SESSION_SECRET?.trim() || getDashboardPassword();
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    timingSafeEqual(leftBuffer, leftBuffer);
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function sign(value: string): string {
  return createHmac("sha256", getSessionSecret()).update(value).digest("base64url");
}

function createSessionValue(): string {
  const payload = `v1:${Date.now()}`;
  return `${payload}.${sign(payload)}`;
}

function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key) cookies.set(key, decodeURIComponent(value));
  }
  return cookies;
}

function hasValidSession(req: express.Request): boolean {
  const session = parseCookies(req.get("cookie")).get(SESSION_COOKIE);
  if (!session) return false;

  const separator = session.lastIndexOf(".");
  if (separator < 0) return false;

  const payload = session.slice(0, separator);
  const signature = session.slice(separator + 1);
  if (!constantTimeEqual(signature, sign(payload))) return false;

  const [, createdAtRaw] = payload.split(":");
  const createdAt = Number(createdAtRaw);
  return Number.isFinite(createdAt) && Date.now() - createdAt <= SESSION_TTL_MS;
}

function isSecureRequest(req: express.Request): boolean {
  return req.secure || req.get("x-forwarded-proto") === "https";
}

function setSessionCookie(req: express.Request, res: express.Response): void {
  res.cookie(SESSION_COOKIE, createSessionValue(), {
    httpOnly: true,
    maxAge: SESSION_TTL_MS,
    sameSite: "lax",
    secure: isSecureRequest(req),
    path: "/",
  });
}

function clearSessionCookie(req: express.Request, res: express.Response): void {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureRequest(req),
    path: "/",
  });
}

function normalizeNextPath(value: unknown): string {
  const nextPath = typeof value === "string" ? value : "/dashboard/";
  if (!nextPath.startsWith("/") || nextPath.startsWith("//")) return "/dashboard/";
  if (nextPath.startsWith("/login")) return "/dashboard/";
  return nextPath;
}

function renderLoginPage(options: { nextPath: string; error?: string | null }): string {
  const errorHtml = options.error
    ? `<div class="access-error" role="alert">${escapeHtml(options.error)}</div>`
    : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>DEX Holding Overview · Private Access</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;600;700;800&family=Space+Grotesk:wght@500;700&display=swap" rel="stylesheet" />
    <style>
      :root {
        color-scheme: dark;
        --bg: #070b10;
        --panel: rgba(14, 18, 28, 0.94);
        --line: rgba(255, 255, 255, 0.12);
        --line-strong: rgba(90, 242, 196, 0.52);
        --text: #f2f6ff;
        --muted: #9aa4b3;
        --accent: #5af2c4;
        --danger: #ff9c9c;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 28px;
        color: var(--text);
        font-family: "Manrope", system-ui, sans-serif;
        background:
          radial-gradient(circle at 0% 0%, rgba(90, 242, 196, 0.11), transparent 24%),
          radial-gradient(circle at 88% 10%, rgba(83, 115, 255, 0.12), transparent 28%),
          linear-gradient(180deg, #060a10 0%, #0a0f16 100%);
      }
      body::before {
        content: "";
        position: fixed;
        inset: 0;
        pointer-events: none;
        background-image:
          linear-gradient(rgba(255, 255, 255, 0.018) 1px, transparent 1px),
          linear-gradient(90deg, rgba(255, 255, 255, 0.018) 1px, transparent 1px);
        background-size: 52px 52px;
        mask-image: linear-gradient(180deg, rgba(0, 0, 0, 0.78), transparent 94%);
      }
      .access-card {
        position: relative;
        width: min(100%, 650px);
        padding: clamp(32px, 5vw, 42px);
        border: 1px solid var(--line);
        border-radius: 38px;
        background: var(--panel);
        box-shadow: 0 34px 110px rgba(0, 0, 0, 0.46);
        backdrop-filter: blur(20px);
      }
      .eyebrow {
        margin: 0 0 20px;
        color: var(--accent);
        font-size: 0.78rem;
        font-weight: 800;
        letter-spacing: 0.2em;
        text-transform: uppercase;
      }
      h1 {
        margin: 0;
        max-width: 520px;
        font-family: "Space Grotesk", system-ui, sans-serif;
        font-size: clamp(3.4rem, 9vw, 5.35rem);
        line-height: 0.92;
        letter-spacing: -0.07em;
      }
      .subtitle {
        margin: 22px 0 30px;
        color: var(--muted);
        font-size: clamp(1.05rem, 2vw, 1.45rem);
      }
      label {
        display: block;
        margin: 20px 0 10px;
        color: var(--muted);
        font-size: 0.78rem;
        font-weight: 800;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }
      input {
        width: 100%;
        height: 76px;
        padding: 0 24px;
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 22px;
        outline: none;
        background: rgba(3, 7, 12, 0.86);
        color: var(--text);
        font: 700 1.35rem "Manrope", system-ui, sans-serif;
        transition: border-color 160ms ease, box-shadow 160ms ease;
      }
      input:focus {
        border-color: var(--line-strong);
        box-shadow: 0 0 0 4px rgba(90, 242, 196, 0.12);
      }
      button {
        width: 100%;
        min-height: 76px;
        margin-top: 20px;
        border: 1px solid var(--line-strong);
        border-radius: 22px;
        color: var(--text);
        background: linear-gradient(135deg, rgba(90, 242, 196, 0.28), rgba(83, 115, 255, 0.22));
        font: 800 1.25rem "Manrope", system-ui, sans-serif;
        cursor: pointer;
        transition: transform 160ms ease, filter 160ms ease;
      }
      button:hover { transform: translateY(-1px); filter: brightness(1.07); }
      .access-error {
        margin: 0 0 20px;
        padding: 14px 16px;
        border: 1px solid rgba(255, 156, 156, 0.3);
        border-radius: 16px;
        color: var(--danger);
        background: rgba(255, 156, 156, 0.08);
        font-weight: 800;
      }
      @media (max-width: 640px) {
        body { padding: 16px; }
        .access-card { border-radius: 28px; }
        input, button { height: 64px; border-radius: 18px; font-size: 1.08rem; }
      }
    </style>
  </head>
  <body>
    <main class="access-card">
      <p class="eyebrow">Private Access</p>
      <h1>DEX Holding Overview</h1>
      <p class="subtitle">Sign in to access the private holdings dashboard.</p>
      ${errorHtml}
      <form method="post" action="/login">
        <input type="hidden" name="next" value="${escapeHtml(options.nextPath)}" />
        <label for="username">Username</label>
        <input id="username" name="username" type="text" autocomplete="username" value="admin" />
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" autofocus required />
        <button type="submit">Open Dashboard</button>
      </form>
    </main>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function createAuthRouter(): express.Router {
  const router = express.Router();

  router.get("/login", (req, res) => {
    if (hasValidSession(req)) {
      res.redirect(normalizeNextPath(req.query.next));
      return;
    }
    res.type("html").send(renderLoginPage({ nextPath: normalizeNextPath(req.query.next) }));
  });

  router.post("/login", express.urlencoded({ extended: false, limit: "10kb" }), (req, res) => {
    const password = String(req.body?.password || "");
    const nextPath = normalizeNextPath(req.body?.next);
    if (constantTimeEqual(password, getDashboardPassword())) {
      setSessionCookie(req, res);
      res.redirect(nextPath);
      return;
    }

    res.status(401).type("html").send(renderLoginPage({ nextPath, error: "Invalid password. Try again." }));
  });

  router.post("/logout", (req, res) => {
    clearSessionCookie(req, res);
    res.redirect("/login");
  });

  return router;
}

export function createPasswordProtection(): express.RequestHandler {
  return (req, res, next) => {
    if (hasValidSession(req)) {
      next();
      return;
    }

    if (req.path.startsWith("/api/")) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const nextPath = encodeURIComponent(req.originalUrl || "/dashboard/");
    res.redirect(`/login?next=${nextPath}`);
  };
}

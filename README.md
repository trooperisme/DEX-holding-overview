# DEX Holding Overview

Local DEX holdings dashboard for Zapper bundle entities.

The dashboard and all API routes require a private login. Set
`DASHBOARD_PASSWORD` in the deployment environment. The local fallback password is
`112233`; replace it before exposing the app publicly. Any username is accepted.
For stable signed sessions across deploys, set `DASHBOARD_SESSION_SECRET` too.

## Features

- Imports tracked entities from `data/raw/dex-entities-zapper.csv`
- Fetches holdings from Zapper using an API key entered in the UI
- Stores snapshot history in SQLite
- Aggregates token rows by `token key`
- Supports a persistent blacklist with restore actions
- Shows per-token entity drilldowns in the dashboard

## Local run

1. Install dependencies with `npm install`
2. Start the local app with `npm run dev`
3. Open `http://127.0.0.1:3001`

## Vercel notes

- Static dashboard assets are served from `public/dashboard`
- API routes are handled by the Express app exported from `api/index.ts`
- Set `DATABASE_URL` to use Supabase Postgres storage on Vercel
- Run `supabase/schema.sql` in Supabase before enabling `DATABASE_URL`
- Do not copy Railway's `DATA_DIR=/data` to Vercel; without `DATA_DIR`, Vercel uses `/tmp/dex-holding-overview-data`
- `/tmp` storage is ephemeral on Vercel, so SQLite snapshots are not durable there
- Use `FIRECRAWL_API_KEY` only as a Vercel environment variable, never in source control

## Data

- Seed CSV: `data/raw/dex-entities-zapper.csv`
- SQLite DB: `data/db/dex-holding-overview.db`

## Railway SQLite to Supabase migration

Use this once if your old Railway project stored data in `/data/db/dex-holding-overview.db` and you want future Railway accounts to reuse Supabase instead of a Railway volume.

1. Run `supabase/schema.sql` in Supabase
2. Download the old SQLite file from Railway volume
3. Run:

```bash
DATABASE_URL='postgresql://...'
DATABASE_SCHEMA=dex
SQLITE_PATH=/absolute/path/to/dex-holding-overview.db
npm run migrate:sqlite-to-postgres
```

If the target schema already has data and you want to replace it:

```bash
DATABASE_URL='postgresql://...'
DATABASE_SCHEMA=dex
SQLITE_PATH=/absolute/path/to/dex-holding-overview.db
PG_TRUNCATE_BEFORE_IMPORT=1
npm run migrate:sqlite-to-postgres -- --truncate
```

After the import, point every new Railway project at Supabase with:

```bash
DATABASE_URL='postgresql://...'
DATABASE_SCHEMA=dex
FIRECRAWL_API_KEY=...
TRADER_ENTITIES_CSV=data/raw/dex-entities-zapper.csv
HOST=0.0.0.0
```

With that setup, Railway becomes disposable compute and Supabase keeps the durable history.

# DEX Holding Overview

Local DEX holdings dashboard for Zapper bundle entities.

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

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

## Data

- Seed CSV: `data/raw/dex-entities-zapper.csv`
- SQLite DB: `data/db/dex-holding-overview.db`

# Full Scan on Vercel

The authenticated Full Scan button dispatches the existing `dex-refresh.yml`
workflow on `main`. It never starts the long scanner inside a Vercel function.
The daily 02:17 Asia/Ho_Chi_Minh schedule and its concurrency group are unchanged.

Configure production `DEX_GITHUB_ACTIONS_TOKEN` as a sensitive Vercel variable:
a fine-grained GitHub token restricted to `trooperisme/DEX-holding-overview`, with
Actions read/write and the automatically required Metadata read permission.
Renew the credential before its chosen expiry. Never put it in client code.

The dashboard polls worker state and persisted Supabase snapshot counts. Queued
and preparing workers have no new snapshot yet. Finalization is indeterminate;
entity collection percentages are not presented as complete market enrichment.
Closing the dialog, leaving the page, or changing the selected snapshot does
not cancel the worker. The new snapshot opens only when explicitly selected.

A small `dex.manual_refresh_dispatch` coordination table is created lazily.
Its singleton row stores a request UUID, request time, and GitHub run ID. A
Postgres advisory transaction lock serializes dispatches across Vercel instances.
An ambiguous upstream timeout retains the pending request rather than silently
dispatching again. Worker failures before snapshot creation cannot attach an old
successful snapshot to the new request.

Local verification uses fake worker responses. Releasing this feature does not
require triggering a real scan. After release, verify auth, assets, snapshot
reads and `/api/refresh/status`; a real manual scan remains a user action.

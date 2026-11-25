# Refresh runtime and execution path (2026-11-25)

The scheduled refresh runs in [GitHub Actions](../.github/workflows/dex-refresh.yml),
with a 60-minute job limit. Run [#47](https://github.com/trooperisme/DEX-holding-overview/actions/runs/45537371050)
completed successfully in 18 minutes 46 seconds (03:04:56-03:23:42 UTC).
It loaded 83 entities and 11,201 holdings. Market enrichment started at
03:19:02 and finished at 03:23:42: about 4 minutes 40 seconds for 446 tokens.

The Vercel function limit is 300 seconds. The measured refresh cannot finish
inside one Vercel invocation, even before accounting for retries. The dashboard
therefore directs manual runs on Vercel to the existing GitHub Actions workflow;
the server rejects direct Vercel refresh requests before creating a snapshot.
Local or long-lived hosts retain the direct refresh path.

`snapshot-market-evidence.ts` now logs Gecko, market-cap-source, and total
enrichment durations in future runs. Recheck this decision if the refresh
runtime or hosting limits change. The timing above is a measurement of one
successful scheduled run, not a guarantee about future runs.

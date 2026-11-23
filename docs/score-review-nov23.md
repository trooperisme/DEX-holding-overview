# Local score/UI review — snapshot 164, 23 November 2026

Release scope: score v4.1 and the UI feedback fixes from branch `codex/score-trend-review`. The initial analysis was local-only; production release was authorized afterward. No refresh, historical backfill, registry changes or production snapshot writes are required.

## Source and method

Exported the existing authenticated production `/api/snapshots`, `/api/overview?snapshotId=164`, favorites and score histories for CASHCAT, DRV (both canonical keys), SURPLUS and CARDS. Default overview filters: minimum per-entity holding $111, minimum 1 holder, minimum liquidity $11,111 with the API's existing unknown-data policy, no MCAP maximum. Snapshot 164 succeeded: 83/83 entities, 11,356 raw holdings; collection 2026-11-23 00:22:42–00:40:30 UTC (07:22–07:40 ICT). Export contains 1,073 overview rows. Favorites are the current saved preferences at export, not a historical favorite registry.

Run `node -r ts-node/register scripts/compare-holdings-weight.ts .tmp/nov23` to replay the frozen baseline inputs. All 1,073 baseline scores reconcile exactly from exported components before applying a candidate. This is a snapshot sensitivity replay, **not a return backtest or evidence of predictive alpha**. No future price outcomes were evaluated. Token symbols are not merged; tokenKey remains canonical.

## Candidate chosen for local review

v4.1 changes only the capital component:

`capital_v4.1 = capital_v4 × min(2.5, 1 + 0.25 × log2(max(1, holdingsUsd / 50,000)))`

No extra bonus below $50k; continuous increase thereafter; bounded bonus. Compared weights 0, 0.25 and 0.5 on the same exported components. Other factors, MCAP-only provenance, negative holder momentum, the attention floor, and score caps are unchanged. All points displayed locally are recomputed under the same candidate version. Holdings USD is marked value, so price appreciation can increase this bonus without token accumulation.

| Snapshot token | v4 score / rank | Local v4.1 score / rank |
|---|---:|---:|
| DRV `na:0x9d0e8f5b25384c7310cb8c6ae32c8fbeb645d083` | 818,847 / 11 | 1,653,722 / 8 |
| SURPLUS `na:0xc52aedec3374422d7510e294cfaa90799595cba3` | 230,661 / 33 | 335,389 / 28 |
| DRV `na:0xb1d1eae60eea9525032a6dcb4c1ce336a1de71be` | 53,330 / 116 | 53,330 / 116 |
| CARDS `unknown:CARDS` | 17,734 / 279 | 17,734 / 279 |

37/1,073 scores increase; top-20 membership overlap is 18/20 for weight 0.25 versus 16/20 for 0.5. One row hits its evidence cap under all variants (no increased saturation). The moderate candidate is a conservative design choice, not an optimized or statistically validated weight.

SURPLUS's observed matched-cohort token amount fell 45.54%, with one fewer holder and favorite; its momentum multiplier is 0.2827. That remains intact. CARDS has $4,500.70 across two holders, no favorite holders, missing MCAP and no contract in the exported identity. It remains low: increasing large-holdings weight does not resolve coverage/identity gaps. Do not assume this symbol-only row represents all CARDS holdings. DRV's main row has $844,613.51 across eight holders and two favorites; liquidity and volume are missing and receive fallback factors.

Broad effect: the USDG-labelled row also rises from 3.08M to 6.44M, remaining rank 1. Large marked holdings alone do not establish an attractive trade; this candidate does not add new asset-category exclusions.

## UI and chronology fix

The production line connects snapshot-ID order but used completion-time X positions. Captured partial #157 started 16 November 09:47 UTC, closed 17 November 16:33 UTC, while #158 completed 17 November 02:47 UTC. This reproduces the backwards segment independently of log/linear scale.

Use snapshot collection-start time on the chart, sort a copy for rendering, and connect all recorded observations with the same continuous line and dot style; partial status remains in the hover/focus tooltip. Scores, API history order, selected-snapshot boundaries and trajectory calculations remain untouched by the chart fix. Start time is the run's beginning, not the exact time every individual wallet balance was measured. Tooltips/axis use that same chart timestamp.

Replaced the two factor-card grids with one table: Parameter / Thay đổi / Đóng góp vào score. Ten attribution groups include unchanged and unavailable inputs. Raw amount change and matched-cohort momentum are distinguished in the same table row. Missing input/attribution displays a dash, not an invented zero. Contributions retain backend fixed-order reconciliation; interaction attribution is not independent causal evidence (available in cell tooltip).

Removed the requested snapshot-count/recalculation paragraph and both matched-entity explanatory paragraphs from the trajectory card. Kept phase, speed and acceleration. A short data-change notice remains conditional on actual evidence/coverage changes.

## Local preview

`node -r ts-node/register scripts/preview-score-review.ts .tmp/nov23`

Open http://127.0.0.1:3012/dashboard/. This server replays frozen exports and never connects to production; writes return 405. Only the target histories above were exported. Holder drilldowns and live MCAP queries are deliberately unavailable in the offline preview. It does not pretend to provide live refreshes or filters beyond the exported default scope.

UI feedback revision: percentage increases and positive point contributions use bold green, decreases use bold red, and zero uses neutral text. Removed the unrequested yellow partial-dot/gap treatment; all recorded points remain connected in chronological order.

## Release verification

Local release gate: TypeScript build and 95 tests pass. Browser checks cover 320/390/768/1440px in light and dark themes, continuous chart geometry, signed colors and unclipped three-column cells. Nested detail width, chart viewBox and inherited token-name column widths are explicitly corrected for small screens. Deployment and authenticated production results are recorded separately after release.

# Launch Radar: 198 pre-token protocols ranked, comps fit R²=0.25 tested held-out twice, 758/758 accounted for, costed farm plans netted to the dollar

[![Competition](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![Rank](https://make.fun/badge/token-radar-01/joyrichh/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![Reward](https://make.fun/badge/token-radar-01/joyrichh/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

An offline entry for [Make.Fun’s token launch radar competition](https://make.fun/bounty/token-radar-01). Sealed DefiLlama snapshot dated **2026-11-14**: 758 protocols, 198 ranked pre-token records, 416 token records, and 144 excluded pre-token records (42 CEX, 11 versioned, 81 bridge/wrapped/staked, 10 exchange-named). All 40 watchlist slugs are ranked. “Pre-token” means all three of market cap, Gecko ID and symbol are null in this snapshot, not proof that a token does not exist. The eligibility screen uses the house’s category and name checks without a TVL floor; the sealed snapshot does not expose parent-protocol relationships.

## Fitted, not hand-tuned

`lib/model.ts` implements ordinary least squares using normal equations and Gaussian elimination with partial pivoting. The fit uses all 128 token records with positive reported market cap and TVL:

```text
log10(market cap) = 3.1732871986558155
                 + 0.5264691914564136 × log10(TVL)
                 − 1.6273846322369614 × clipped_growth / 100
                 − 0.11672868127460274 × log10(age_days + 1)
                 + category_offset
```

Growth clips to [−60%, +120%], with null → 0%; age is days from first tracking to snapshot, null → 365 days. A category with at least five training rows gets half its median residual, capped at ±0.3 log points; other offsets are zero. Exponentiated fitted cap is clamped to $1–$100T. In-sample log-space R² including offsets: **0.25355815759507216**.

Token odds use zero-initialized batch logistic regression, 2,000 iterations, learning rate 0.5, on all 758 records. Non-intercept numerical features (log TVL, log age, growth) are standardized using fit-partition population means and standard deviations. Category indicators require 30 fit-partition records. Final mean log loss: **0.5904008697706685**; full-data AUC: **0.7465418353576249**. `data.js` includes the learned weights, scaling and category offsets.

`implied_value_usd = max(1, round(fitted_mcap × unrounded_token_odds))`. Displayed odds round to four decimal places; ranking uses the unrounded probability. Slug order breaks ties. No protocol name is hardcoded.

## Real held-out results

A = even sum of slug character codes; B = odd. Each variant refits on the same training partition and predicts the same test rows. TVL-only omits category offsets; the category ratio uses a median for categories with at least five training rows and falls back to the global median. Odds scaling and category indicators are also relearned per partition. MAPE and MdAPE are the mean and median absolute percentage error in dollar space; log R² uses the held-out target mean baseline. AUC gives half credit to tied scores.

Each cell is **log R² / MAPE / MdAPE**. Full precision is in `model-report.json` under `model_comparison`.

| Model | A → B (69 fit / 59 test) | B → A (59 / 69) | Walk-forward (75 / 20) |
| --- | ---: | ---: | ---: |
| OLS-full (primary) | −0.188 / 3603.91% / 95.26% | 0.153 / 713.25% / 84.56% | −0.773 / 278.93% / 91.92% |
| OLS TVL-only | 0.126 / 1403.89% / 95.73% | 0.204 / 657.17% / 86.91% | −0.421 / 491.48% / 90.43% |
| Per-category median mcap/TVL | −0.160 / 3228.13% / 98.67% | −0.057 / 827.10% / 89.73% | −0.974 / 1865.43% / 93.97% |
| Global median mcap/TVL | −0.150 / 2925.75% / 126.40% | 0.041 / 689.07% / 87.46% | −0.886 / 1824.13% / 93.35% |

OLS-full pooled split-half MAPE is **2045.66%** and MdAPE is **88.19%**. Walk-forward trains on `listed_at < 2025-06-01`, tests on `>= 2025-06-01`, and omits 33 unknown listing dates. It uses snapshot-time features: this is a cohort test, **not a historical backtest**.

TVL-only leads on log R² across all three tests; OLS-full leads on MdAPE in both split halves but not in walk-forward. OLS-full remains primary because it uses TVL, growth and age, not because it wins every test. Its negative growth coefficient is consistent with the snapshot’s fastest-growing quartile of comps being younger (median 576.5 vs. 774 days) and having smaller caps (median $8,040,225 vs. $13,245,699.50). This descriptive comparison does not establish causation.

| Held-out odds test | Fit rows | Test rows | AUC |
| --- | ---: | ---: | ---: |
| A → B | 389 | 369 | 0.6853254437869822 |
| B → A | 369 | 389 | 0.6890119888674802 |

**The fit is weak on unseen peers.** A few extreme relative errors on small caps pull up MAPE; MdAPE shows that typical errors are still large. Negative R² means worse than the held-out mean baseline. Odds classify existing token records, not the probability or timing of future issuance. Implied values are research scenarios, not forecasts, quotes, or promises of allocation.

## Run locally

Requires Node 22.18+ (standard library only; no package install, network, clock or randomness).

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input /path/to/snapshot.json
```

`--input` accepts a file or directory; the default is `/input`. The default output is `/output`. Open `out/dashboard/index.html` directly from disk. The generated `data.js` is next to the dashboard directory. Outputs: `board.json`, `data.js`, dashboard sources, three screenshots, and the vendor-built `dossier.json`. A gate violation exits nonzero. Screenshots must first be captured with the supplied script; they are copied, not re-rendered by the competition runtime. See `VERIFY.md` for current capture and build status.

For development before screenshots exist, add `--preview` (writes the board, data and dashboard only). To reproduce screenshots after a preview build, run:

```sh
/home/hatch/workspace/venvs/crawl4ai/bin/python shot.py --out out
MAKEFUN_OUTPUT_DIR=out node main.ts --input /path/to/snapshot.json
```

The capture script uses Playwright’s installed Chromium and tests tabs, filtering, sorting, empty states, pagination, detail navigation, mobile width and offline rendering. An optional `--executable /path/to/chromium` uses another installed Chromium. Reproduce deep links with `#detail=<slug>` and `#filter=category:Dexs`. Filters also accept `chain:`, `status:ranked`, `status:live`, `status:excluded`, `band:0` through `band:3`, and `search:`.

After capture, run two complete builds into fresh `out1/` and `out2/`, then `node verify.ts /path/to/snapshot.json` to check their hashes, dossier source inclusion, image limits and board gates, and regenerate `VERIFY.md`. The independent developer check `verify-model.py` needs NumPy; it is not a runtime dependency of the entry.

## Costed farm scenarios

- Deposit budgets: $250 at TVL ≥$5B, $150 at ≥$1B, $100 at ≥$100M, otherwise $50. Each plan names its protocol, first listed chain, category-specific action, receipt checks, hold and exit.
- Hold 60 days if age <180, 45 if <365, otherwise 30. Unknown listing date uses a 30-day hold, even though its model age is imputed to 365.
- **Assumed farmer allocation: 10% of supply**, shared pro rata against **$1,000,000 total farmed capital**. Expected farmer value = `round(implied_value_usd × 0.10 × deposit_usd / 1,000,000)`. There is no confirmed allocation.
- Net = expected value minus assumed round-trip gas and, for insurance, the full premium budget. Deposit principal is at risk but is not treated as a fee. Slippage, funding, lost premiums beyond budget, principal losses, taxes, lock-up costs and opportunity costs are not estimated by the snapshot. Perpetual plans assume no leverage and require existing exposure to hedge.
- Routes are conditional on app support, minimums, eligibility and current quotes. The snapshot cannot verify any of them; skip unsupported actions rather than improvising a transaction.

Assumed **round-trip**, not per-transaction gas, in USD:

| Chain | Budget | Chain | Budget |
| --- | ---: | --- | ---: |
| Ethereum | 8 | Bitcoin | 6 |
| Arbitrum | 2 | Base | 1 |
| Optimism | 1 | Polygon | 1 |
| Starknet | 2 | zkSync Era | 2 |
| Linea | 2 | Scroll | 2 |
| Mantle | 2 | Solana | 0.50 |
| Sui | 0.50 | Avalanche | 1 |
| BSC | 1 | Hyperliquid L1 | 1 |
| Tron | 3 | All other chains | 3 |

## License

MIT; see `LICENSE` (SPDX identifier included). The provided vendor dossier library and license are unchanged. No bundle, GitHub repository creation or submission is performed by this entry.

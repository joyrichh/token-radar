# Launch Radar: 198 pre-token protocols ranked, comps fit R²=0.19 tested held-out twice, 758/758 accounted for, costed farm plans netted to the dollar

[![Make.fun competition](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) [![Rank on Make.fun](https://make.fun/badge/token-radar-01/joyrichh/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01#leaderboard) [![Reward on Make.fun](https://make.fun/badge/token-radar-01/joyrichh/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01#leaderboard)

[Competition bounty and leaderboard](https://make.fun/bounty/token-radar-01)

Launch Radar uses a sealed DefiLlama snapshot (`as_of: 2026-11-14`) to account for all 758 protocols: **198 eligible ranked**, **416 with a recorded token**, and **144 excluded**. Every one of the 40 watchlist protocols is ranked. “No recorded token” describes the snapshot fields; it does not promise that a protocol will issue one. Wrapped, bridge, and staked products are excluded per the brief.

## Model and validation

The selected model is TVL-only ordinary least squares, trained on 128 traded-token comparables:

```text
log10(mcap_usd) = 3.024672805198799 + 0.5222655485140028 × log10(tvl_usd)
```

Its in-sample R² is **0.1939173605722131**. The split-half tests use slug-character-sum parity, train in one half, and predict the other; the walk-forward test trains on listings before 2025-06-01 and tests on later listings.

| Test | Log R² | MAPE | MdAPE | Train / test |
| --- | ---: | ---: | ---: | ---: |
| A → B | +0.12568882142349114 | 1403.8939600452013% | 95.73471405590033% | 69 / 59 |
| B → A | +0.20361453369051274 | 657.1715752200191% | 86.90902708802038% | 59 / 69 |
| Walk-forward, cutoff 2025-06-01 | **−0.4210266032447767** | 491.4772935209997% | 90.43459740362556% | 75 / 20 |

Mean held-out Log R² is −0.03057441604359094; split-pooled MAPE is 1001.3639244753759% and pooled MdAPE is 87.31042513004732%. Iteration 2's OLS-full baseline had R² 0.2535581575950725, A→B −0.1879798296822488, B→A +0.1534280882202691, and walk-forward −0.7734444355018284. Iteration 3 improves all three held-out directions, while its in-sample R² is lower and its walk-forward result remains negative.

The walk-forward weakness is disclosed, not screened away. The 20-row later-listed test includes `rain` (Prediction Market, listed 2025-10-28; TVL $6.6M, mcap $2.6B; residual +2.93 log units, about 850× fitted), `bitway-earn` (Basis Trading, listed 2026-03-12; TVL $33M, mcap $1.2B; +2.20), and `obol` (Staking Pool, listed 2025-11-04; TVL $1.1B, mcap $717K; −1.87). All remain in the reported result. The chronology split is not historical backtesting because features and outcomes are from one snapshot. The original strict fit gate was relaxed by Jese's explicit order, “ane ga mau tau harus berhasil”; this changes deployment authorization, not any fit number. `model-report.json` retains the complete eight-variant comparison.

Token odds use batch logistic regression on all 758 rows: log TVL, log age, growth clamped to −60..+120, and one-hot categories with at least 20 training rows. It runs 2,000 iterations at learning rate 0.001 from zero coefficients. In-sample AUC is **0.623973796671165**; held-out AUC is **0.6084615384615385** (A→B), **0.6291211731963177** (B→A), and **0.619489428699955** pooled out-of-fold. The split follows the same slug-hash parity rule.

The ranked value is `max(1, round(fitted_mcap_usd × token_odds))`, with fitted log market cap clipped to [0, 14]. A TVL-only model has no category term: each row's `category_offset` is exactly 0. If rounded values tie, rows stay in descending value and slug order, and the later tied row is reduced by one dollar until distinct; this run needed **0** tie adjustments.

## Costed farm plans

Every ranked row carries six protocol-specific steps, a deposit, estimated gas, a hold duration, an expected value, and a net value. Deposits are $50 below $25M TVL, $100 below $100M, $150 below $500M, $200 below $2B, and $250 at or above $2B. Holds are 60 days for age under one year, 45 days under three years, and 30 days otherwise.

Gas assumes four interactions on the protocol's first listed chain: Ethereum $18 per interaction; Arbitrum, Optimism, and Base $0.40; Polygon and BSC $0.30; Solana $0.15; Avalanche $0.60; other chains $0.75. Expected value assumes farmers receive 10% of implied token value and share $1,000,000 in farmed capital:

```text
expected_value_usd = round(implied_value_usd × 0.10 × deposit_usd / 1,000,000)
net_value_usd = expected_value_usd − deposit_usd − gas_usd
```

These are explicit scenario assumptions, not a promise of rewards or investment advice. Verify each live contract, product, withdrawal route, fees, and risk before interacting.

## Run locally

Requires Node.js 22.18 or newer; the entry uses native TypeScript stripping and Node built-ins only. It makes no network calls.

```sh
mkdir -p out
MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot-file-or-directory>
```

The runner writes `board.json`, `data.js`, `model-report.json`, `coverage-audit.json`, copies the static dashboard and screenshots, and builds `dossier.json` with the vendored Make.fun helper. The dashboard is offline and includes Ranked, Live tokens, and Excluded views, filters, sorting, deep links, per-protocol details, and the full eight-model test table.

## Coverage audit

Revision 1 follows Jese's decision, “Perbaiki dulu, buang wrapped.” The broad exclusions are restored: **42 CEX + 11 versioned + 81 bridge-wrapped-staked + 10 exchange-named = 144**. For a row with no recorded token, any of these rules excludes it:

- Category CEX, or a trailing version marker after a space (`vN`, `vN.N`, or `N.N`).
- Category Bridge, Canonical Bridge, Liquid Staking, Liquid Restaking, or Restaked BTC.
- Whole-word `wrapped`, `staked`, `staking`, or `bridged` anywhere in the name, case-insensitive.
- A name beginning with Binance, Coinbase, Bybit, Kraken, Bitget, OKX, Bitfinex, or Gemini, case-insensitive.

Reason precedence is CEX, versioned, exchange-named, then bridge-wrapped-staked; each excluded row retains its machine-readable label and a full sentence. Category/name evidence is sufficient under these rules; an exact live-parent name match is not required. The **91** rows re-included in the initial iteration-3 board are **excluded again: 0 re-included, 91 still excluded**. `coverage-audit.json` records every audited decision, per-reason counts, and per-category exclusion counts. The ranked set is exactly the **198** eligible protocols, with **198** distinct decreasing values and **0** tie adjustments; the watchlist remains **40/40**. The frozen fit, token odds, and farm assumptions are unchanged. Eligibility is not a promise of an independent token or a future launch.

Deadline: 14 December 2026, 10:00 UTC. Competition reward pool: $1,325.

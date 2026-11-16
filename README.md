# Token Radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Every pre-token protocol in a sealed DefiLlama snapshot, ranked by implied
launch value — the whole watchlist, plus the early radar below the floor.

## What it is

`main.ts` reads the sealed snapshot (`/input/snapshot.json`, or
`--input <snapshot.json|directory>`), scores every rankable pre-token
protocol with model `radar-2`, and writes the entry's output:

- `board.json` — the ranked board (198 rows for the 2026-11-14 snapshot):
  rank 1..N, implied launch value, the model's own inputs, and a seven-step
  farm plan per protocol, each step with its cost and its time.
- `data.js` — the same board for the dashboard, as `window.RADAR`.
- `dashboard/` — a static page, no network: sortable and filterable board,
  a detail view per protocol (model breakdown + farm plan), a live-token
  view kept apart, and the model printed in full so any row can be
  recomputed by hand.
- `screenshots/` — the board, a detail view, and a filtered view.
- `dossier.json` — the judge's summary, built with the vendored
  `vendor/makefun-board.ts`.

## The model (radar-2)

Implied value follows only from the snapshot's own figures — TVL, seven-day
growth, age with no token, chain count and category. No protocol name is
ever special-cased.

```
base       = TVL × 0.30
growth     = clamp(7d change, −50%, +150%)
growthMult = 1 + growth × 0.60
maturity   = 0.70 + 0.30 × min(age, 730d) / 730d, easing down 0.15 over the next 1,095 days
breadth    = 1 + 0.03 × min(chains − 1, 5)
category   = stated prior, 0.90–1.15
implied    = max(1, round(base × growthMult × maturity × breadth × category))
```

A protocol is rankable when its record carries no token at all (no market
cap, no CoinGecko id, no symbol) and it is not a wrapped, staked, bridged
or exchange product, under the same rule the house uses for its watchlist.
Live-token protocols are shown apart with the market's own values, never
mixed into the ranked board.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../kit/input/snapshot.json
```

Node 22.18+ (tested on Node 24.22.1), standard library only, no
dependencies. Deterministic: the same snapshot in always writes the same
bytes out. The program refuses to write a board the gate would refuse
(missing watchlist slugs, ranks out of order, a flat implied value, or a
farm step outside 20–600 characters), and it checks every screenshot's
size and dimensions before writing the dossier.

## Verify it

```sh
# the board the gate checks
python3 -c "import json; b=json.load(open('out/board.json')); print(len(b['rows']), 'rows;', b['rows'][0]['name'], b['rows'][0]['implied_value_usd'])"
# run it twice: the two outputs must be byte-identical
MAKEFUN_OUTPUT_DIR=out2 node main.ts --input ../kit/input/snapshot.json
diff -r out out2 && echo "deterministic"
```

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>

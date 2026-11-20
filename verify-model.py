import json
import re
from datetime import date
from pathlib import Path

import numpy as np


root = Path(__file__).resolve().parent
snapshot = json.loads((root.parent / "kit/token-radar-01-kit/input/snapshot.json").read_text())
board = json.loads((root / "out/board.json").read_text())
as_of = date.fromisoformat(snapshot["as_of"])
peers = snapshot["protocols"]


def pre_token(peer):
    return all(peer[key] is None for key in ("mcap_usd", "gecko_id", "symbol"))


def numeric(peer):
    age = max(0, (as_of - date.fromisoformat(peer["listed_at"])).days) if peer["listed_at"] else 365
    return [np.log10(max(1, peer["tvl_usd"])), np.log10(age + 1), np.clip(peer["change_7d"] or 0, -60, 120) / 100]


def fit_comps(training, testing, variant="OLS-full"):
    indices = (0, 2, 1) if variant == "OLS-full" else (0,)
    def design(rows):
        return np.array([[1, *[numeric(peer)[index] for index in indices]] for peer in rows])

    features = design(training)
    targets = np.log10([peer["mcap_usd"] for peer in training])
    coefficients = np.linalg.lstsq(features, targets, rcond=None)[0]
    residuals = targets - features @ coefficients
    offsets = {}
    for category in {peer["category"] for peer in training}:
        group = [residuals[index] for index, peer in enumerate(training) if peer["category"] == category]
        if len(group) >= 5 and variant == "OLS-full":
            offsets[category] = np.clip(np.median(group) * 0.5, -0.3, 0.3)
    if variant.startswith("OLS"):
        predictions = design(testing) @ coefficients + [offsets.get(peer["category"], 0) for peer in testing]
    else:
        ratios = [peer["mcap_usd"] / peer["tvl_usd"] for peer in training]
        global_ratio = np.median(ratios)
        category_ratios = {}
        if variant == "Per-category median mcap/TVL":
            for category in {peer["category"] for peer in training}:
                group = [ratio for peer, ratio in zip(training, ratios) if peer["category"] == category]
                if len(group) >= 5:
                    category_ratios[category] = np.median(group)
        predictions = np.log10([peer["tvl_usd"] * category_ratios.get(peer["category"], global_ratio) for peer in testing])
    predictions = np.clip(predictions, 0, 14)
    actual = np.log10([peer["mcap_usd"] for peer in testing])
    errors = np.abs(10 ** predictions / 10 ** actual - 1) * 100
    r2 = 1 - np.sum((actual - predictions) ** 2) / np.sum((actual - actual.mean()) ** 2)
    return coefficients, np.mean(errors), np.median(errors), r2


training = [peer for peer in peers if not pre_token(peer) and (peer["mcap_usd"] or 0) > 0 and peer["tvl_usd"] > 0]
even = [peer for peer in training if sum(map(ord, peer["slug"])) % 2 == 0]
odd = [peer for peer in training if peer not in even]
before = [peer for peer in training if peer["listed_at"] and peer["listed_at"] < "2025-06-01"]
after = [peer for peer in training if peer["listed_at"] and peer["listed_at"] >= "2025-06-01"]
meta = board["meta"]
coefficients, _, _, r2 = fit_comps(training, training)
np.testing.assert_allclose(coefficients, list(meta["coefficients"].values()), atol=1e-9)
np.testing.assert_allclose(r2, meta["r2_in_sample"], atol=1e-12)
for variant in meta["model_comparison"]:
    for label, fit, test in (("A_to_B", even, odd), ("B_to_A", odd, even), ("walk_forward", before, after)):
        _, mape, mdape, r2 = fit_comps(fit, test, variant["model"])
        np.testing.assert_allclose([mape, mdape, r2], [variant[label][key] for key in ("mape_pct", "mdape_pct", "r2")], rtol=1e-9)
        print(f"{variant['model']} {label}: MAPE={mape:.12f}%, MdAPE={mdape:.12f}%, R2={r2:.12f}: PASS")

rows = board["rows"]
assert len(rows) == 198
excluded_categories = {"CEX", "Bridge", "Canonical Bridge", "Liquid Staking", "Liquid Restaking", "Restaked BTC"}
eligible = {peer["slug"] for peer in peers if pre_token(peer) and peer["category"] not in excluded_categories
            and not re.search(r"\b(wrapped|staked|staking)\b|^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)|\s(v\d+(\.\d+)?|\d+\.\d+)$", peer["name"], re.I)}
assert {row["slug"] for row in rows} == eligible
assert set(snapshot["watchlist"]) <= {row["slug"] for row in rows}
assert [row["rank"] for row in rows] == list(range(1, len(rows) + 1))
assert all(left["implied_value_usd"] >= right["implied_value_usd"] for left, right in zip(rows, rows[1:]))
assert len({row["implied_value_usd"] for row in rows}) > 1
assert all(len(row["farm_steps"]) == 6 and all(20 <= len(step.strip()) <= 600 for step in row["farm_steps"]) for row in rows)
for row in rows:
    farm = row["farm"]
    expected = np.floor(row["implied_value_usd"] * 0.10 * farm["deposit_usd"] / 1_000_000 + 0.5)
    assert farm["expected_value_usd"] == expected
    assert farm["net_value_usd"] == expected - farm["total_cost_usd"]
    assert 0 <= row["model"]["token_odds"] <= 1
print(f"Board: {len(rows)} ranked; {len(snapshot['watchlist'])} watchlist covered; ranks, value order, six steps, odds and farm arithmetic: PASS")
print(f"Unique implied values: {len({row['implied_value_usd'] for row in rows})}; step lengths: {min(len(step) for row in rows for step in row['farm_steps'])}–{max(len(step) for row in rows for step in row['farm_steps'])}")

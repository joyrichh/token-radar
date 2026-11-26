import hashlib
import json
import sys
from datetime import date

import numpy as np


def main():
    if len(sys.argv) != 3:
        raise SystemExit('Usage: python3 verify-model.py <snapshot.json> <model-report.json>')
    with open(sys.argv[1]) as handle:
        snapshot = json.load(handle)
    with open(sys.argv[2]) as handle:
        report = json.load(handle)
    comparison_bytes = json.dumps(report['model_comparison'], sort_keys=True, separators=(',', ':'), allow_nan=False).encode()
    comparison_hash = hashlib.sha256(comparison_bytes).hexdigest()
    assert comparison_hash == 'a932bcc4b7e08ff076252dea39a456ce709daf788d6b26ee5d6abdb8ea8abd4a', 'Frozen iteration-3 comps comparison changed.'
    assert report['status'] == 'fit_gate_failed'
    assert report['deployed_primary'] is None and report['passing_candidates'] == []
    assert report['primary_candidate'] == 'OLS TVL-only'
    print(f'Frozen iteration-3 comps comparison PASS: every recorded fit value is unchanged; canonical SHA-256 {comparison_hash}.')
    as_of = date.fromisoformat(snapshot['as_of'])
    rows = sorted([row for row in snapshot['protocols'] if (row['mcap_usd'] or 0) > 0 and row['tvl_usd'] > 0], key=lambda row: row['slug'])
    by_slug = {row['slug']: row for row in rows}
    maximum_log_difference = 0
    fits_checked = 0
    inner_scores_checked = 0

    def feature(row, kind):
        age = max(0, (as_of - date.fromisoformat(row['listed_at'])).days) if row['listed_at'] else 365
        full = [np.log10(row['tvl_usd']), max(-60, min(120, row['change_7d'] or 0)) / 100, np.log10(age + 1)]
        if kind == 'tvl':
            return full[:1]
        return [full[0], full[2]] if kind == 'no-growth' else full

    def target(row):
        return np.log10(row['mcap_usd'])

    def is_validation(row):
        return sum((index + 1) * ord(character) for index, character in enumerate(row['slug'])) % 5 == 0

    def linear(training, kind, penalty=0, robust=False, category=False):
        raw = np.array([feature(row, kind) for row in training])
        centers, scales = raw.mean(axis=0), raw.std(axis=0)
        scales[scales == 0] = 1
        categories = sorted({row['category'] or 'Uncategorized' for row in training}) if category else []

        def encode(row):
            indicators = [float((row['category'] or 'Uncategorized') == name) for name in categories]
            return np.concatenate(([1], (feature(row, kind) - centers) / scales, indicators))

        features = np.array([encode(row) for row in training])
        truth = np.array([target(row) for row in training])
        regularizer = np.eye(features.shape[1]) * penalty
        regularizer[0, 0] = 0
        weights = np.ones(len(training))
        for iteration in range(60 if robust else 1):
            coefficients = np.linalg.lstsq(features.T @ (features * weights[:, None]) + regularizer,
                                           features.T @ (truth * weights), rcond=None)[0]
            residual = truth - features @ coefficients
            scale = max(0.05, 1.4826 * np.median(np.abs(residual - np.median(residual))))
            weights = np.minimum(1, 1.345 * scale / np.maximum(1e-10, np.abs(residual)))
        return lambda row: float(np.clip(encode(row) @ coefficients, 0, 14))

    def ridge(training, kind='full', category=False, parameters=None):
        nonlocal inner_scores_checked
        learn = [row for row in training if not is_validation(row)]
        valid = [row for row in training if is_validation(row)]
        penalties = [0.01, 0.1, 1, 10, 100, 1000]
        losses = []
        for penalty in penalties:
            predict = linear(learn, kind, penalty, category=category)
            losses.append(float(np.mean([(target(row) - predict(row)) ** 2 for row in valid])))
        selected = penalties[int(np.argmin(losses))]
        if parameters:
            tuning = parameters['tuning']
            assert tuning['selected_lambda'] == selected
            assert tuning['fit_slugs'] == [row['slug'] for row in learn]
            assert tuning['validation_slugs'] == [row['slug'] for row in valid]
            np.testing.assert_allclose(losses, [value['validation_log_mse'] for value in tuning['candidates']], rtol=1e-9, atol=1e-9)
            inner_scores_checked += len(losses)
        return linear(training, kind, selected, category=category)

    def fit(training, name, parameters):
        if name == 'OLS TVL-only':
            return linear(training, 'tvl')
        if name == 'Huber-full':
            return linear(training, 'full', robust=True)
        if name.startswith('Ridge'):
            kind = 'no-growth' if name == 'Ridge without growth' else 'full'
            return ridge(training, kind, name == 'Ridge with category indicators', parameters)
        if name == 'Category median log ratio':
            groups = {}
            ratios = []
            for row in training:
                ratio = target(row) - np.log10(row['tvl_usd'])
                ratios.append(ratio)
                groups.setdefault(row['category'], []).append(ratio)
            medians = {key: np.median(values) for key, values in groups.items() if len(values) >= 5}
            fallback = np.median(ratios)
            return lambda row: np.clip(np.log10(row['tvl_usd']) + medians.get(row['category'], fallback), 0, 14)
        global_fit = linear(training, 'full') if name == 'OLS-full' else ridge(training, 'tvl', parameters=parameters['base'])
        groups = {}
        for row in training:
            groups.setdefault(row['category'], []).append(target(row) - global_fit(row))
        if name == 'OLS-full':
            offsets = {key: np.clip(0.5 * np.median(values), -0.3, 0.3) for key, values in groups.items() if len(values) >= 5}
        else:
            assert name == 'Category intercept shrinkage'
            offsets = {key: np.mean(values) * len(values) / (len(values) + 10) for key, values in groups.items()}
        return lambda row: np.clip(global_fit(row) + offsets.get(row['category'], 0), 0, 14)

    for variant in report['model_comparison']:
        for key in ['in_sample', 'A_to_B', 'B_to_A', 'walk_forward']:
            partition = variant[key]
            training = [by_slug[slug] for slug in partition['training_slugs']]
            test = [by_slug[value['slug']] for value in partition['predictions']]
            predict = fit(training, variant['model'], partition['fit'])
            predictions = np.array([predict(row) for row in test])
            recorded = np.array([value['predicted_log10_mcap'] for value in partition['predictions']])
            maximum_log_difference = max(maximum_log_difference, float(np.max(np.abs(predictions - recorded))))
            np.testing.assert_allclose(predictions, recorded, rtol=1e-9, atol=1e-9)
            truth = np.array([target(row) for row in test])
            errors = 100 * np.abs(10 ** (predictions - truth) - 1)
            metrics = [1 - np.sum((truth - predictions) ** 2) / np.sum((truth - truth.mean()) ** 2), np.mean(errors), np.median(errors)]
            np.testing.assert_allclose(metrics, [partition['log_r2'], partition['mape_pct'], partition['mdape_pct']], rtol=1e-9, atol=1e-9)
            fits_checked += 1
    print(f'Independent NumPy validation PASS: {fits_checked} fits, {inner_scores_checked} inner-lambda losses; maximum absolute log prediction difference {maximum_log_difference:.15g}.')

    all_rows = sorted(snapshot['protocols'], key=lambda row: row['slug'])

    def odds_features(row, categories):
        age = max(0, (as_of - date.fromisoformat(row['listed_at'])).days) if row['listed_at'] else 365
        growth = max(-60, min(120, row['change_7d'] if row['change_7d'] is not None else 0))
        category = row['category'] or 'Uncategorized'
        return [1.0, np.log10(max(1, row['tvl_usd'])), np.log10(age + 1), growth] + [float(category == item) for item in categories]

    def fit_odds(training):
        category_counts = {}
        for row in training:
            category = row['category'] or 'Uncategorized'
            category_counts[category] = category_counts.get(category, 0) + 1
        categories = sorted(name for name, count in category_counts.items() if count >= 20)
        feature_names = ['intercept', 'log10(tvl_usd)', 'log10(age_days+1)', 'growth_pct'] + [f'category:{name}' for name in categories]
        matrix = np.array([odds_features(row, categories) for row in training])
        labels = np.array([float(row['mcap_usd'] is not None or row['gecko_id'] is not None or row['symbol'] is not None) for row in training])
        coefficients = np.zeros(matrix.shape[1])
        for _ in range(2000):
            logits = matrix @ coefficients
            probabilities = np.empty_like(logits)
            positive = logits >= 0
            probabilities[positive] = 1 / (1 + np.exp(-logits[positive]))
            exponential = np.exp(logits[~positive])
            probabilities[~positive] = exponential / (1 + exponential)
            coefficients -= 0.001 * (matrix.T @ (probabilities - labels)) / len(training)
        return feature_names, categories, coefficients

    def predict_odds(rows, categories, coefficients):
        matrix = np.array([odds_features(row, categories) for row in rows])
        logits = matrix @ coefficients
        probabilities = np.empty_like(logits)
        positive = logits >= 0
        probabilities[positive] = 1 / (1 + np.exp(-logits[positive]))
        exponential = np.exp(logits[~positive])
        probabilities[~positive] = exponential / (1 + exponential)
        return probabilities

    def auc(labels, scores):
        ordered = sorted(zip(scores, labels), key=lambda pair: pair[0])
        positives = sum(labels)
        negatives = len(labels) - positives
        rank_total = 0.0
        start = 0
        while start < len(ordered):
            end = start + 1
            while end < len(ordered) and ordered[end][0] == ordered[start][0]:
                end += 1
            mean_rank = ((start + 1) + end) / 2
            rank_total += mean_rank * sum(label for _, label in ordered[start:end])
            start = end
        return (rank_total - positives * (positives + 1) / 2) / (positives * negatives)

    def labels_for(rows):
        return [int(row['mcap_usd'] is not None or row['gecko_id'] is not None or row['symbol'] is not None) for row in rows]

    def parity(slug):
        return sum(ord(character) for character in slug) % 2

    feature_names, categories, coefficients = fit_odds(all_rows)
    in_sample_scores = predict_odds(all_rows, categories, coefficients)
    half_a = [row for row in all_rows if parity(row['slug']) == 0]
    half_b = [row for row in all_rows if parity(row['slug']) == 1]
    _, categories_a, coefficients_a = fit_odds(half_a)
    _, categories_b, coefficients_b = fit_odds(half_b)
    scores_a_to_b = predict_odds(half_b, categories_a, coefficients_a)
    scores_b_to_a = predict_odds(half_a, categories_b, coefficients_b)
    labels_a_to_b = labels_for(half_b)
    labels_b_to_a = labels_for(half_a)
    aucs = {
        'in_sample_auc': auc(labels_for(all_rows), in_sample_scores.tolist()),
        'A_to_B': auc(labels_a_to_b, scores_a_to_b.tolist()),
        'B_to_A': auc(labels_b_to_a, scores_b_to_a.tolist()),
        'pooled_out_of_fold': auc(labels_a_to_b + labels_b_to_a, scores_a_to_b.tolist() + scores_b_to_a.tolist()),
    }
    odds = report['token_odds']
    assert odds['status'] == 'built'
    assert odds['iterations'] == 2000 and odds['learning_rate'] == 0.001
    assert odds['features'] == feature_names
    np.testing.assert_allclose(coefficients, [odds['coefficients'][name] for name in feature_names], rtol=1e-9, atol=1e-11)
    np.testing.assert_allclose(aucs['in_sample_auc'], odds['in_sample_auc'], rtol=1e-12, atol=1e-12)
    np.testing.assert_allclose([aucs['A_to_B'], aucs['B_to_A'], aucs['pooled_out_of_fold']],
                               [odds['held_out_auc']['A_to_B'], odds['held_out_auc']['B_to_A'], odds['held_out_auc']['pooled_out_of_fold']],
                               rtol=1e-12, atol=1e-12)
    print(f"Independent NumPy token-odds validation PASS: coefficients and AUCs reproduce; in-sample {aucs['in_sample_auc']:.12f}, held-out {aucs['A_to_B']:.12f}/{aucs['B_to_A']:.12f}, pooled {aucs['pooled_out_of_fold']:.12f}.")


if __name__ == '__main__':
    main()

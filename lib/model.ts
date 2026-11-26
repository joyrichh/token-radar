import { readFileSync } from 'node:fs';

export type Protocol = {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
};

export type Snapshot = {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
};

export type Observation = Protocol & {
  age_days: number;
  growth_pct: number;
  records_token: boolean;
};

type FeatureSet = 'full' | 'tvl' | 'no-growth';
type Parameters = Record<string, unknown>;
type ValueFit = { predictLog: (row: Observation) => number; parameters: Parameters };
type Trainer = (rows: Observation[]) => ValueFit;
type Tuning = {
  selected_lambda: number;
  fit_slugs: string[];
  validation_slugs: string[];
  candidates: { lambda: number; validation_log_mse: number }[];
};

export const MODEL_VERSION = '2.0.0';
export const CUTOFF = '2025-06-01';
const PENALTIES = [0.01, 0.1, 1, 10, 100, 1000];
const VERSION_SUFFIX = /\s(?:v\d+(?:\.\d+)?|\d+\.\d+)$/i;
const OLD_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC']);
const OLD_EXCHANGE_PREFIX = /^(?:Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)/i;
const MAX_VALUE = 100_000_000_000_000;

export const eligibilityRules = [
  'A live row records at least one of mcap_usd, gecko_id or symbol; live rows are never launch-ranked.',
  'A pre-token row in category CEX is excluded: custodial exchange balances are not a farmable protocol.',
  'A pre-token name ending in a space plus vN, vN.N or N.N is excluded as a versioned product.',
  'A pre-token row in Bridge, Canonical Bridge, Liquid Staking, Liquid Restaking or Restaked BTC is excluded as a bridge/wrapped/staked product per the brief.',
  'A pre-token name containing the whole word wrapped, staked, staking or bridged (case-insensitive) is excluded as a bridge/wrapped/staked product.',
  'A pre-token name beginning with Binance, Coinbase, Bybit, Kraken, Bitget, OKX, Bitfinex or Gemini (case-insensitive) is excluded as exchange-named.',
  'Eligibility uses snapshot category/name evidence, not an exact live-parent match; no recorded token is not a promise of an independent token or a future launch.',
];

const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value));
const average = (values: number[]) => values.reduce((total, value) => total + value, 0) / values.length;
const dotProduct = (left: number[], right: number[]) => left.reduce((total, value, index) => total + value * right[index], 0);

function median(values: number[]): number {
  if (values.length === 0) throw new Error('Cannot take the median of an empty sample.');
  const sorted = [...values].sort((left, right) => left - right);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
}

function validDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

/** Validate the sealed input without consulting the clock, network or protocol identities. */
export function readSnapshot(filename: string): Snapshot {
  const snapshot = JSON.parse(readFileSync(filename, 'utf8')) as Snapshot;
  if (!snapshot || !validDate(snapshot.as_of) || typeof snapshot.source !== 'string' ||
      !Number.isFinite(snapshot.floor_usd) || !Array.isArray(snapshot.protocols) || !Array.isArray(snapshot.watchlist)) {
    throw new Error('Invalid snapshot header: expected as_of, source, floor_usd, protocols and watchlist.');
  }
  const slugs = new Set<string>();
  for (const row of snapshot.protocols) {
    if (!row || typeof row.slug !== 'string' || !row.slug.trim() || slugs.has(row.slug) ||
        typeof row.name !== 'string' || !row.name.trim() ||
        ![row.category, row.gecko_id, row.symbol].every(value => value === null || typeof value === 'string') ||
        !Array.isArray(row.chains) || !row.chains.every(chain => typeof chain === 'string' && chain.trim()) ||
        !Number.isSafeInteger(row.tvl_usd) || row.tvl_usd < 0 ||
        ![row.change_7d, row.mcap_usd].every(value => value === null || typeof value === 'number' && Number.isFinite(value)) ||
        (row.listed_at !== null && (!validDate(row.listed_at) || row.listed_at > snapshot.as_of))) {
      throw new Error(`Invalid or duplicate snapshot row: ${row?.slug ?? '(missing slug)'}.`);
    }
    slugs.add(row.slug);
  }
  if (new Set(snapshot.watchlist).size !== snapshot.watchlist.length ||
      !snapshot.watchlist.every(slug => typeof slug === 'string' && slugs.has(slug))) {
    throw new Error('Watchlist must contain distinct snapshot slugs.');
  }
  return snapshot;
}

function observe(snapshot: Snapshot): Observation[] {
  return [...snapshot.protocols].sort((left, right) => compareText(left.slug, right.slug)).map(row => ({
    ...row,
    age_days: row.listed_at === null ? 365 : Math.max(0, (Date.parse(snapshot.as_of) - Date.parse(row.listed_at)) / 86_400_000),
    growth_pct: clamp(row.change_7d ?? 0, -60, 120),
    records_token: row.mcap_usd !== null || row.gecko_id !== null || row.symbol !== null,
  }));
}

export function slugParity(slug: string): number {
  return [...slug].reduce((total, character) => total + character.charCodeAt(0), 0) % 2;
}

/** This independent hash subdivides training only; outer-test labels never tune lambda. */
export function innerValidation(slug: string): boolean {
  return [...slug].reduce((total, character, index) => total + (index + 1) * character.charCodeAt(0), 0) % 5 === 0;
}

function featureNames(kind: FeatureSet): string[] {
  if (kind === 'tvl') return ['log10(tvl_usd)'];
  if (kind === 'no-growth') return ['log10(tvl_usd)', 'log10(age_days+1)'];
  return ['log10(tvl_usd)', 'growth_pct/100', 'log10(age_days+1)'];
}

function rawFeatures(row: Observation, kind: FeatureSet): number[] {
  const logTvl = Math.log10(Math.max(1, row.tvl_usd));
  const logAge = Math.log10(row.age_days + 1);
  if (kind === 'tvl') return [logTvl];
  if (kind === 'no-growth') return [logTvl, logAge];
  return [logTvl, row.growth_pct / 100, logAge];
}

const logCap = (row: Observation) => Math.log10(row.mcap_usd!);

/** Deterministic partial-pivot elimination; all penalized columns are standardized. */
function solveSystem(matrix: number[][], targets: number[]): number[] {
  const width = targets.length;
  const augmented = matrix.map((row, index) => [...row, targets[index]]);
  for (let column = 0; column < width; column++) {
    let pivot = column;
    for (let candidate = column + 1; candidate < width; candidate++) {
      if (Math.abs(augmented[candidate][column]) > Math.abs(augmented[pivot][column])) pivot = candidate;
    }
    if (Math.abs(augmented[pivot][column]) < 1e-12) throw new Error('Singular fitted design.');
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    for (let row = column + 1; row < width; row++) {
      const multiplier = augmented[row][column] / augmented[column][column];
      for (let entry = column; entry <= width; entry++) augmented[row][entry] -= multiplier * augmented[column][entry];
    }
  }
  const solution = Array<number>(width).fill(0);
  for (let row = width - 1; row >= 0; row--) {
    let remainder = augmented[row][width];
    for (let column = row + 1; column < width; column++) remainder -= augmented[row][column] * solution[column];
    solution[row] = remainder / augmented[row][row];
  }
  return solution;
}

function weightedLeastSquares(features: number[][], targets: number[], weights: number[], penalty: number): number[] {
  const width = features[0].length;
  const gram = Array.from({ length: width }, () => Array<number>(width).fill(0));
  const rhs = Array<number>(width).fill(0);
  for (const [index, feature] of features.entries()) {
    for (let column = 0; column < width; column++) {
      rhs[column] += feature[column] * targets[index] * weights[index];
      for (let other = 0; other < width; other++) gram[column][other] += feature[column] * feature[other] * weights[index];
    }
  }
  for (let column = 1; column < width; column++) gram[column][column] += penalty;
  return solveSystem(gram, rhs);
}

function fitLinear(rows: Observation[], kind: FeatureSet, penalty = 0, robust = false, withCategories = false): ValueFit {
  if (rows.length < 5) throw new Error('Too few training observations.');
  const raw = rows.map(row => rawFeatures(row, kind));
  const means = raw[0].map((_, index) => average(raw.map(feature => feature[index])));
  const scales = means.map((center, index) => Math.sqrt(average(raw.map(feature => (feature[index] - center) ** 2))) || 1);
  const categories = withCategories ? [...new Set(rows.map(row => row.category ?? 'Uncategorized'))].sort(compareText) : [];
  const encode = (row: Observation) => [1,
    ...rawFeatures(row, kind).map((value, index) => (value - means[index]) / scales[index]),
    ...categories.map(category => Number((row.category ?? 'Uncategorized') === category)),
  ];
  const features = rows.map(encode);
  const targets = rows.map(logCap);
  let weights = rows.map(() => 1);
  let coefficients: number[] = [];
  let residualScale = 0;
  for (let iteration = 0; iteration < (robust ? 60 : 1); iteration++) {
    coefficients = weightedLeastSquares(features, targets, weights, penalty);
    const residuals = targets.map((target, index) => target - dotProduct(features[index], coefficients));
    const center = median(residuals);
    residualScale = Math.max(0.05, 1.4826 * median(residuals.map(residual => Math.abs(residual - center))));
    weights = residuals.map(residual => Math.min(1, 1.345 * residualScale / Math.max(1e-10, Math.abs(residual))));
  }
  return {
    predictLog: row => clamp(dotProduct(encode(row), coefficients), 0, 14),
    parameters: {
      kind, feature_names: ['intercept', ...featureNames(kind), ...categories.map(category => `category:${category}`)],
      means, scales, coefficients, categories, lambda: penalty,
      formula: 'log10(mcap) = intercept + sum(beta_j * (x_j - mean_j) / scale_j) + category_indicator_terms',
      huber: robust ? { iterations: 60, delta: 1.345, mad_multiplier: 1.4826, minimum_scale: 0.05, residual_scale: residualScale } : null,
    },
  };
}

function fitRidge(rows: Observation[], kind: FeatureSet = 'full', categories = false): ValueFit {
  const fitRows = rows.filter(row => !innerValidation(row.slug));
  const validationRows = rows.filter(row => innerValidation(row.slug));
  if (fitRows.length < 5 || validationRows.length < 2) throw new Error('Inner training/validation split is too small.');
  const candidates = PENALTIES.map(lambda => {
    const fit = fitLinear(fitRows, kind, lambda, false, categories);
    return { lambda, validation_log_mse: average(validationRows.map(row => (logCap(row) - fit.predictLog(row)) ** 2)) };
  });
  const winner = [...candidates].sort((left, right) => left.validation_log_mse - right.validation_log_mse || left.lambda - right.lambda)[0];
  const finalFit = fitLinear(rows, kind, winner.lambda, false, categories);
  const tuning: Tuning = {
    selected_lambda: winner.lambda,
    fit_slugs: fitRows.map(row => row.slug), validation_slugs: validationRows.map(row => row.slug), candidates,
  };
  return { ...finalFit, parameters: { ...finalFit.parameters, tuning } };
}

function residualGroups(rows: Observation[], fit: ValueFit): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  for (const row of rows) {
    const category = row.category ?? 'Uncategorized';
    const residuals = groups.get(category) ?? [];
    residuals.push(logCap(row) - fit.predictLog(row));
    groups.set(category, residuals);
  }
  return groups;
}

/** Recreate the iteration-2 statistical baseline, not its source implementation. */
function fitOlsBaseline(rows: Observation[]): ValueFit {
  const global = fitLinear(rows, 'full');
  const offsets = Object.fromEntries([...residualGroups(rows, global)].filter(([, group]) => group.length >= 5)
    .map(([category, group]) => [category, clamp(0.5 * median(group), -0.3, 0.3)]));
  return {
    predictLog: row => clamp(global.predictLog(row) + (offsets[row.category ?? 'Uncategorized'] ?? 0), 0, 14),
    parameters: { base: global.parameters, category_offsets: offsets, minimum_category_count: 5, median_shrinkage: 0.5, maximum_offset: 0.3 },
  };
}

/** Empirical category intercepts shrink by n/(n+10); a new category gets zero. */
function fitCategoryShrinkage(rows: Observation[]): ValueFit {
  const global = fitRidge(rows, 'tvl');
  const offsets = Object.fromEntries([...residualGroups(rows, global)]
    .map(([category, residuals]) => [category, average(residuals) * residuals.length / (residuals.length + 10)]));
  return {
    predictLog: row => clamp(global.predictLog(row) + (offsets[row.category ?? 'Uncategorized'] ?? 0), 0, 14),
    parameters: { base: global.parameters, category_offsets: offsets, shrinkage_pseudocount: 10 },
  };
}

/** Medians are taken in log space, not after exponentiating ratios. */
function fitCategoryMedian(rows: Observation[]): ValueFit {
  const groups = new Map<string, number[]>();
  const ratios = rows.map(row => logCap(row) - Math.log10(row.tvl_usd));
  for (const [index, row] of rows.entries()) {
    const category = row.category ?? 'Uncategorized';
    groups.set(category, [...(groups.get(category) ?? []), ratios[index]]);
  }
  const globalMedian = median(ratios);
  const categoryMedians = Object.fromEntries([...groups].filter(([, group]) => group.length >= 5)
    .map(([category, group]) => [category, median(group)]));
  return {
    predictLog: row => clamp(Math.log10(row.tvl_usd) + (categoryMedians[row.category ?? 'Uncategorized'] ?? globalMedian), 0, 14),
    parameters: {
      formula: 'log10(mcap) = log10(tvl) + median(log10(mcap/tvl)); category n>=5 else global',
      global_median_log_ratio: globalMedian, category_median_log_ratios: categoryMedians, minimum_category_count: 5,
    },
  };
}

const variants: { name: string; rationale: string; train: Trainer }[] = [
  { name: 'OLS-full', rationale: 'Iteration-2 baseline: TVL, growth, age plus clipped median category residuals.', train: fitOlsBaseline },
  { name: 'OLS TVL-only', rationale: 'Lower-variance single predictor, no category offset.', train: rows => fitLinear(rows, 'tvl') },
  { name: 'Ridge-full', rationale: 'Standardized numeric features; L2 lambda selected strictly inside training.', train: rows => fitRidge(rows) },
  { name: 'Huber-full', rationale: 'IRLS on log market cap with Huber delta 1.345 and training-only MAD scale.', train: rows => fitLinear(rows, 'full', 0, true) },
  { name: 'Category intercept shrinkage', rationale: 'TVL ridge plus training residual category means shrunk by n/(n+10).', train: fitCategoryShrinkage },
  { name: 'Category median log ratio', rationale: 'Category median log10(mcap/tvl), n>=5; global median fallback.', train: fitCategoryMedian },
  { name: 'Ridge without growth', rationale: 'Ablation of the volatile 7-day feature; identical inner lambda selection.', train: rows => fitRidge(rows, 'no-growth') },
  { name: 'Ridge with category indicators', rationale: 'Jointly penalize numeric effects and category indicators, vocabulary learned on training only.', train: rows => fitRidge(rows, 'full', true) },
];

function assessFit(fit: ValueFit, rows: Observation[]) {
  const actualMean = average(rows.map(logCap));
  const predictions = rows.map(row => {
    const prediction = fit.predictLog(row);
    return {
      slug: row.slug, actual_mcap_usd: row.mcap_usd!, predicted_log10_mcap: prediction,
      predicted_mcap_usd: 10 ** prediction, absolute_percentage_error: 100 * Math.abs(10 ** prediction / row.mcap_usd! - 1),
    };
  });
  const squaredError = predictions.reduce((total, row) => total + (Math.log10(row.actual_mcap_usd) - row.predicted_log10_mcap) ** 2, 0);
  const totalVariation = rows.reduce((total, row) => total + (logCap(row) - actualMean) ** 2, 0);
  if (!(totalVariation > 0)) throw new Error('Log R² requires a varying target.');
  return {
    n_test: rows.length, log_r2: 1 - squaredError / totalVariation,
    mape_pct: average(predictions.map(row => row.absolute_percentage_error)),
    mdape_pct: median(predictions.map(row => row.absolute_percentage_error)), predictions,
  };
}

function evaluatePartition(train: Trainer, training: Observation[], test: Observation[]) {
  const fit = train(training);
  return { n_train: training.length, training_slugs: training.map(row => row.slug), fit: fit.parameters, ...assessFit(fit, test) };
}

/** Every candidate sees exactly the same three outer holdouts. Missing dates never enter the walk-forward. */
export function evaluateModels(snapshot: Snapshot) {
  const traded = observe(snapshot).filter(row => row.records_token && (row.mcap_usd ?? 0) > 0 && row.tvl_usd > 0);
  const halfA = traded.filter(row => slugParity(row.slug) === 0);
  const halfB = traded.filter(row => slugParity(row.slug) === 1);
  const early = traded.filter(row => row.listed_at !== null && row.listed_at < CUTOFF);
  const late = traded.filter(row => row.listed_at !== null && row.listed_at >= CUTOFF);
  const comparison = variants.map(variant => {
    const inSample = evaluatePartition(variant.train, traded, traded);
    const forward = evaluatePartition(variant.train, halfA, halfB);
    const reverse = evaluatePartition(variant.train, halfB, halfA);
    const walk = evaluatePartition(variant.train, early, late);
    const pooled = [...forward.predictions, ...reverse.predictions].map(row => row.absolute_percentage_error);
    return {
      model: variant.name, rationale: variant.rationale,
      in_sample_r2: inSample.log_r2, in_sample: inSample,
      A_to_B: forward, B_to_A: reverse,
      walk_forward: { ...walk, cutoff: CUTOFF, n_unknown: traded.length - early.length - late.length },
      mean_held_out_log_r2: average([forward.log_r2, reverse.log_r2, walk.log_r2]),
      split_pooled_mape_pct: average(pooled), split_pooled_mdape_pct: median(pooled),
      passes_fit_gate: forward.log_r2 > 0 && reverse.log_r2 > 0 && walk.log_r2 > 0,
    };
  });
  const selected = [...comparison].sort((left, right) => right.mean_held_out_log_r2 - left.mean_held_out_log_r2 || compareText(left.model, right.model))[0];
  return {
    model_version: MODEL_VERSION, as_of: snapshot.as_of, source: snapshot.source,
    status: selected.passes_fit_gate ? 'fit_gate_passed' : 'fit_gate_failed',
    primary_candidate: selected.model, deployed_primary: selected.passes_fit_gate ? selected.model : null,
    selection_rule: 'Highest unweighted mean of A→B, B→A and walk-forward Log R²; ties by model name. No candidate deploys unless all three Log R² values are strictly positive.',
    evaluation: {
      outer_split: 'sum of slug character codes mod 2: A=0, B=1',
      inner_validation: 'sum((character_index+1)*character_code) mod 5 = 0, applied only inside each training partition',
      lambda_grid: PENALTIES, ridge_objective: 'sum squared log errors + lambda*sum(beta_j^2), intercept unpenalized',
      normalization: 'population mean/std fitted on that training partition only; category vocabulary from training only',
      ridge_selection: 'Minimum inner-validation log MSE; lower lambda breaks exact ties; refit on all outer-training rows.',
      target: 'log10(mcap_usd)', prediction_log_clip: [0, 14],
      growth_clip_pct: [-60, 120], missing_growth_pct: 0, missing_age_days: 365,
      mape_definition: '100*mean(abs(predicted_mcap/actual_mcap-1))',
      log_r2_definition: '1 - sum((actual_log-predicted_log)^2)/sum((actual_log-mean(actual_log_in_test))^2)',
      selection_caveat: 'Outer scores select among eight candidates; they are not a fresh unbiased test of the selected candidate.',
      walk_forward_caveat: 'Listing chronology is not historical snapshot backtesting: all covariates and labels are observed as of the same sealed snapshot.',
      n_traded: traded.length, n_A: halfA.length, n_B: halfB.length,
      n_walk_train: early.length, n_walk_test: late.length, n_unknown_listing_date: traded.length - early.length - late.length,
    },
    model_comparison: comparison.map(row => ({ ...row, primary: row.model === selected.model })),
    passing_candidates: comparison.filter(row => row.passes_fit_gate).map(row => row.model),
    token_odds: { status: 'not_rebuilt', reason: 'Stop at failed comps-fit gate before odds, board, dashboard and screenshot production.' },
  };
}

export type ModelReport = ReturnType<typeof evaluateModels>;

const ODDS_ITERATIONS = 2_000;
const ODDS_LEARNING_RATE = 0.001;
const LARGE_CATEGORY_MIN_COUNT = 20;

type LogisticFit = {
  coefficients: number[];
  featureNames: string[];
  categories: string[];
  predict: (row: Observation) => number;
};

function sigmoid(value: number): number {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exponential = Math.exp(value);
  return exponential / (1 + exponential);
}

function logisticFeatures(row: Observation, categories: string[]): number[] {
  const category = row.category ?? 'Uncategorized';
  return [1, Math.log10(Math.max(1, row.tvl_usd)), Math.log10(row.age_days + 1), row.growth_pct,
    ...categories.map(value => Number(value === category))];
}

function fitLogistic(rows: Observation[]): LogisticFit {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const category = row.category ?? 'Uncategorized';
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  const categories = [...counts].filter(([, count]) => count >= LARGE_CATEGORY_MIN_COUNT)
    .map(([category]) => category).sort(compareText);
  const featureNames = ['intercept', 'log10(tvl_usd)', 'log10(age_days+1)', 'growth_pct',
    ...categories.map(category => `category:${category}`)];
  const features = rows.map(row => logisticFeatures(row, categories));
  const labels = rows.map(row => Number(row.records_token));
  const coefficients = Array<number>(featureNames.length).fill(0);
  for (let iteration = 0; iteration < ODDS_ITERATIONS; iteration++) {
    const gradient = Array<number>(featureNames.length).fill(0);
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const error = sigmoid(dotProduct(features[rowIndex], coefficients)) - labels[rowIndex];
      for (let featureIndex = 0; featureIndex < gradient.length; featureIndex++) {
        gradient[featureIndex] += error * features[rowIndex][featureIndex];
      }
    }
    for (let featureIndex = 0; featureIndex < coefficients.length; featureIndex++) {
      coefficients[featureIndex] -= ODDS_LEARNING_RATE * gradient[featureIndex] / rows.length;
    }
  }
  return {
    coefficients, featureNames, categories,
    predict: row => sigmoid(dotProduct(logisticFeatures(row, categories), coefficients)),
  };
}

function areaUnderCurve(labels: number[], scores: number[]): number {
  const ordered = labels.map((label, index) => ({ label, score: scores[index] }))
    .sort((left, right) => left.score - right.score);
  const positives = labels.reduce((count, label) => count + label, 0);
  const negatives = labels.length - positives;
  if (!positives || !negatives) throw new Error('Token-odds AUC requires both outcome classes.');
  let positiveRankSum = 0;
  for (let start = 0; start < ordered.length;) {
    let end = start + 1;
    while (end < ordered.length && ordered[end].score === ordered[start].score) end++;
    const meanRank = ((start + 1) + end) / 2;
    for (let index = start; index < end; index++) positiveRankSum += ordered[index].label * meanRank;
    start = end;
  }
  return (positiveRankSum - positives * (positives + 1) / 2) / (positives * negatives);
}

export type TokenOddsReport = {
  status: 'built';
  target: string;
  features: string[];
  large_category_min_count: number;
  large_categories: string[];
  coefficients: Record<string, number>;
  iterations: number;
  learning_rate: number;
  initialization: string;
  optimization: string;
  sample_counts: { total: number; token: number; no_token: number; A: number; B: number };
  in_sample_auc: number;
  held_out_auc: { A_to_B: number; B_to_A: number; pooled_out_of_fold: number };
};

export function fitTokenOdds(snapshot: Snapshot): { report: TokenOddsReport; probabilities: Map<string, number> } {
  const rows = observe(snapshot);
  const labels = rows.map(row => Number(row.records_token));
  const fullFit = fitLogistic(rows);
  const fullScores = rows.map(row => fullFit.predict(row));
  const halfA = rows.filter(row => slugParity(row.slug) === 0);
  const halfB = rows.filter(row => slugParity(row.slug) === 1);
  const fitA = fitLogistic(halfA);
  const fitB = fitLogistic(halfB);
  const scoresAtoB = halfB.map(row => fitA.predict(row));
  const scoresBtoA = halfA.map(row => fitB.predict(row));
  const labelsA = halfB.map(row => Number(row.records_token));
  const labelsB = halfA.map(row => Number(row.records_token));
  const report: TokenOddsReport = {
    status: 'built',
    target: '1 when mcap_usd, gecko_id or symbol is non-null; otherwise 0',
    features: fullFit.featureNames,
    large_category_min_count: LARGE_CATEGORY_MIN_COUNT,
    large_categories: fullFit.categories,
    coefficients: Object.fromEntries(fullFit.featureNames.map((name, index) => [name, fullFit.coefficients[index]])),
    iterations: ODDS_ITERATIONS,
    learning_rate: ODDS_LEARNING_RATE,
    initialization: 'all coefficients zero',
    optimization: 'batch gradient descent on mean binary cross-entropy; unscaled numeric inputs; category indicators for categories with at least 20 training rows',
    sample_counts: {
      total: rows.length, token: labels.reduce((total, label) => total + label, 0),
      no_token: labels.length - labels.reduce((total, label) => total + label, 0), A: halfA.length, B: halfB.length,
    },
    in_sample_auc: areaUnderCurve(labels, fullScores),
    held_out_auc: {
      A_to_B: areaUnderCurve(labelsA, scoresAtoB),
      B_to_A: areaUnderCurve(labelsB, scoresBtoA),
      pooled_out_of_fold: areaUnderCurve([...labelsA, ...labelsB], [...scoresAtoB, ...scoresBtoA]),
    },
  };
  return { report, probabilities: new Map(rows.map((row, index) => [row.slug, fullScores[index]])) };
}

function oldExclusion(row: Observation): string | null {
  if (row.records_token) return null;
  if (row.category === 'CEX') return 'CEX';
  if (VERSION_SUFFIX.test(row.name)) return 'versioned';
  if (OLD_EXCHANGE_PREFIX.test(row.name)) return 'exchange-named';
  if (OLD_CATEGORIES.has(row.category ?? '') || /\b(?:wrapped|staked|staking|bridged)\b/i.test(row.name)) return 'bridge-wrapped-staked';
  return null;
}

function exclusionReason(row: Observation): string | null {
  switch (oldExclusion(row)) {
    case 'CEX': return 'CEX: This custodial exchange balance sheet is not a farmable protocol.';
    case 'versioned': return 'versioned: This name ends in vN, vN.N or N.N and identifies a versioned product, not a separate launch identity.';
    case 'exchange-named': return 'exchange-named: This name begins with an exchange prefix and is excluded as an exchange product under the brief.';
    case 'bridge-wrapped-staked': return 'bridge-wrapped-staked: This category or whole-word name modifier identifies a bridge, wrapped or staked product excluded under the brief.';
    default: return null;
  }
}

export function auditCoverage(snapshot: Snapshot) {
  const rows = observe(snapshot);
  const live = rows.filter(row => row.records_token);
  const decisions = rows.map(row => ({ ...row, exclusion_reason: exclusionReason(row), previous_rule: oldExclusion(row) }));
  const eligible = decisions.filter(row => !row.records_token && row.exclusion_reason === null);
  const excluded = decisions.filter(row => row.exclusion_reason !== null);
  const exclusionLabels = ['CEX', 'versioned', 'bridge-wrapped-staked', 'exchange-named'];
  const exclusionCounts = Object.fromEntries(exclusionLabels.map(rule =>
    [rule, excluded.filter(row => row.previous_rule === rule).length]));
  const exclusionCategories = Object.fromEntries(exclusionLabels.map(rule => {
    const categories = new Map<string, number>();
    for (const row of excluded.filter(row => row.previous_rule === rule)) {
      const category = row.category ?? 'Uncategorized';
      categories.set(category, (categories.get(category) ?? 0) + 1);
    }
    return [rule, Object.fromEntries([...categories].sort(([left], [right]) => compareText(left, right)))];
  }));
  const audit = decisions.filter(row => row.previous_rule === 'bridge-wrapped-staked' || row.previous_rule === 'exchange-named')
    .map(row => ({
      slug: row.slug, name: row.name, category: row.category, tvl_usd: row.tvl_usd, chains: row.chains,
      previous_rule: row.previous_rule, decision: row.exclusion_reason ? 'excluded' : 'eligible',
      reason: row.exclusion_reason,
      warning: 'Re-included in the initial iteration-3 board, then excluded again by the restored broad rules; no independent token opportunity is asserted.',
    }));
  const rankedSlugs = new Set(eligible.map(row => row.slug));
  return {
    model_version: MODEL_VERSION, as_of: snapshot.as_of, rules: eligibilityRules,
    status: 'eligibility_partition_applied_to_board',
    counts: {
      total: rows.length, eligible: eligible.length, live: live.length, excluded: excluded.length,
      cex: exclusionCounts.CEX,
      versioned: exclusionCounts.versioned,
      bridge_wrapped_staked: exclusionCounts['bridge-wrapped-staked'],
      exchange_named: exclusionCounts['exchange-named'],
      audited: audit.length, re_included: audit.filter(row => row.decision === 'eligible').length,
      audit_still_excluded: audit.filter(row => row.decision === 'excluded').length,
      previous_bridge_wrapped_staked: audit.filter(row => row.previous_rule === 'bridge-wrapped-staked').length,
      previous_exchange_named: audit.filter(row => row.previous_rule === 'exchange-named').length,
    },
    exclusion_counts: exclusionCounts,
    exclusion_counts_by_category: exclusionCategories,
    all_watchlist_eligible: snapshot.watchlist.every(slug => rankedSlugs.has(slug)),
    watchlist_count: snapshot.watchlist.length,
    eligible_slugs: eligible.map(row => row.slug), live_slugs: live.map(row => row.slug),
    excluded: excluded.map(row => ({ slug: row.slug, name: row.name, category: row.category, rule: row.previous_rule, reason: row.exclusion_reason })),
    audited_protocols: audit,
  };
}

export function fitGateIssue(report: ModelReport): string | null {
  const primary = report.model_comparison.find(row => row.primary);
  if (!primary) return 'No primary candidate selected.';
  const failures = [
    ['A→B', primary.A_to_B.log_r2], ['B→A', primary.B_to_A.log_r2], ['walk-forward', primary.walk_forward.log_r2],
  ].filter(([, value]) => typeof value !== 'number' || !Number.isFinite(value) || value <= 0);
  if (failures.length) return `${primary.model}: ${failures.map(([name, value]) => `${name} Log R²=${value}`).join('; ')}. All three must be > 0. No board, dashboard or dossier is authorized.`;
  return null;
}

type Board = {
  rows: { slug: string; rank: number; implied_value_usd: number; farm_steps: string[] }[];
  live: { slug: string }[];
  excluded: { slug: string; reason: string }[];
};

/** A future successful fit still must satisfy every independent board contract. */
export function boardIssue(board: Board, snapshot: Snapshot, report: ModelReport): string | null {
  void report;
  const expectedSlugs = new Set(snapshot.protocols.map(row => row.slug));
  const accounted = [...board.rows, ...board.live, ...board.excluded].map(row => row.slug);
  if (accounted.length !== expectedSlugs.size || new Set(accounted).size !== expectedSlugs.size ||
      accounted.some(slug => !expectedSlugs.has(slug))) return 'Coverage is not an exact partition of the snapshot.';
  const rankedSlugs = new Set(board.rows.map(row => row.slug));
  if (snapshot.watchlist.some(slug => !rankedSlugs.has(slug))) return 'A watchlist protocol is missing from ranked rows.';
  const coverage = auditCoverage(snapshot);
  if (coverage.eligible_slugs.length !== board.rows.length || coverage.eligible_slugs.some(slug => !rankedSlugs.has(slug))) return 'Ranked rows differ from eligible protocols.';
  const values = new Set<number>();
  for (const [index, row] of board.rows.entries()) {
    if (row.rank !== index + 1) return `Ranks are not exactly 1..N at ${row.slug}.`;
    if (!Number.isSafeInteger(row.implied_value_usd) || row.implied_value_usd < 1 || row.implied_value_usd > MAX_VALUE ||
        (index > 0 && row.implied_value_usd > board.rows[index - 1].implied_value_usd) || values.has(row.implied_value_usd)) return `Invalid, tied or out-of-order value at ${row.slug}.`;
    values.add(row.implied_value_usd);
    if (!Array.isArray(row.farm_steps) || row.farm_steps.length !== 6 || row.farm_steps.some(step =>
      typeof step !== 'string' || step.trim().length < 20 || step.trim().length > 600)) return `Invalid farm steps at ${row.slug}.`;
  }
  if (board.excluded.some(row => !row.reason?.trim())) return 'Every exclusion must display a reason.';
  if (board.live.length !== coverage.counts.live || board.live.some(row => !coverage.live_slugs.includes(row.slug))) return 'Live partition does not match recorded token evidence.';
  return null;
}

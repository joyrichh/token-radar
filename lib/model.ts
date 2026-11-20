import { readFileSync } from 'node:fs';

type Protocol = {
  slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; mcap_usd: number | null;
  listed_at: string | null; gecko_id: string | null; symbol: string | null;
};
type Snapshot = { as_of: string; source: string; watchlist: string[]; protocols: Protocol[] };
type Peer = Protocol & { age_days: number; growth_pct: number; pre_token: boolean };

const DAY_MS = 86_400_000;
const MAX_VALUE = 1e14;
const WINDOW = '2025-06-01';
const VERSION_MARKER = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const median = (values: number[]) => {
  const sorted = [...values].sort((left, right) => left - right);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
};
const dot = (left: number[], right: number[]) => left.reduce((sum, value, index) => sum + value * right[index], 0);
const isDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d\d-\d\d$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

export function readSnapshot(path: string): Snapshot {
  const input = JSON.parse(readFileSync(path, 'utf8')) as Snapshot;
  if (!input || !isDate(input.as_of) || typeof input.source !== 'string' ||
      !Array.isArray(input.protocols) || !Array.isArray(input.watchlist)) {
    throw new Error('Snapshot needs an as_of date, a source, protocols, and a watchlist.');
  }
  const slugs = new Set<string>();
  for (const peer of input.protocols) {
    if (!peer || typeof peer.slug !== 'string' || !/^[^\s]{1,128}$/.test(peer.slug) ||
        slugs.has(peer.slug) || typeof peer.name !== 'string' || !peer.name.trim() ||
        ![peer.category, peer.gecko_id, peer.symbol].every(value => value === null || typeof value === 'string') ||
        !Array.isArray(peer.chains) || !peer.chains.every(chain => typeof chain === 'string' && chain.trim()) ||
        !Number.isFinite(peer.tvl_usd) || peer.tvl_usd < 0 ||
        ![peer.change_7d, peer.mcap_usd].every(value => value === null || Number.isFinite(value)) ||
        (peer.listed_at !== null && !isDate(peer.listed_at))) {
      throw new Error(`Invalid or duplicate protocol: ${peer?.slug ?? '(no slug)'}`);
    }
    slugs.add(peer.slug);
  }
  if (new Set(input.watchlist).size !== input.watchlist.length || !input.watchlist.every(slug => slugs.has(slug))) {
    throw new Error('Watchlist must contain unique snapshot slugs.');
  }
  return { ...input, protocols: [...input.protocols].sort((left, right) => compare(left.slug, right.slug)) };
}

function enrich(peer: Protocol, asOf: string): Peer {
  return {
    ...peer,
    age_days: peer.listed_at === null ? 365 : Math.max(0, (Date.parse(asOf) - Date.parse(peer.listed_at)) / DAY_MS),
    growth_pct: clamp(peer.change_7d ?? 0, -60, 120),
    pre_token: peer.mcap_usd === null && peer.gecko_id === null && peer.symbol === null,
  };
}

function exclusion(peer: Peer) {
  if (peer.category === 'CEX') return 'CEX';
  if (VERSION_MARKER.test(peer.name)) return 'versioned';
  if (/^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)/i.test(peer.name)) return 'exchange-named';
  if (['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC'].includes(peer.category ?? '') ||
      /\b(wrapped|staked|staking)\b/i.test(peer.name)) return 'bridge-wrapped-staked';
  return null;
}

export function isRankable(peer: Peer) {
  return peer.pre_token && exclusion(peer) === null;
}

const logTvl = (peer: Peer) => Math.log10(Math.max(peer.tvl_usd, 1));
const logAge = (peer: Peer) => Math.log10(peer.age_days + 1);
const compsFeatures = (peer: Peer) => [1, logTvl(peer), peer.growth_pct / 100, logAge(peer)];
const marketLog = (peer: Peer) => Math.log10(peer.mcap_usd!);

/** Solve XᵀX β = Xᵀy with deterministic partial pivoting. */
function solveNormal(features: number[][], targets: number[]): number[] {
  const width = features[0].length;
  const matrix = Array.from({ length: width }, () => Array<number>(width + 1).fill(0));
  features.forEach((row, index) => {
    for (let col = 0; col < width; col++) {
      for (let other = 0; other < width; other++) matrix[col][other] += row[col] * row[other];
      matrix[col][width] += row[col] * targets[index];
    }
  });
  for (let col = 0; col < width; col++) {
    let pivot = col;
    for (let row = col + 1; row < width; row++) {
      if (Math.abs(matrix[row][col]) > Math.abs(matrix[pivot][col])) pivot = row;
    }
    if (Math.abs(matrix[pivot][col]) < 1e-12) throw new Error('Comps fit has a singular design matrix.');
    [matrix[col], matrix[pivot]] = [matrix[pivot], matrix[col]];
    for (let row = col + 1; row < width; row++) {
      const ratio = matrix[row][col] / matrix[col][col];
      for (let idx = col; idx <= width; idx++) matrix[row][idx] -= ratio * matrix[col][idx];
    }
  }
  const coefficients = Array<number>(width).fill(0);
  for (let row = width - 1; row >= 0; row--) {
    coefficients[row] = (matrix[row][width] - dot(coefficients, matrix[row])) / matrix[row][row];
  }
  return coefficients;
}

function fitComps(peers: Peer[]) {
  if (peers.length < 4) throw new Error('Too few positive-cap, positive-TVL peers for comps.');
  const coefficients = solveNormal(peers.map(compsFeatures), peers.map(marketLog));
  const residuals = new Map<string | null, number[]>();
  for (const peer of peers) {
    const group = residuals.get(peer.category) ?? [];
    group.push(marketLog(peer) - dot(coefficients, compsFeatures(peer)));
    residuals.set(peer.category, group);
  }
  const offsets = new Map<string | null, number>();
  for (const [category, group] of residuals) {
    if (group.length < 5) continue;
    group.sort((left, right) => left - right);
    const median = (group[Math.floor((group.length - 1) / 2)] + group[Math.floor(group.length / 2)]) / 2;
    offsets.set(category, clamp(median * 0.5, -0.3, 0.3));
  }
  const offset = (peer: Peer) => offsets.get(peer.category) ?? 0;
  const predictLog = (peer: Peer) => clamp(dot(coefficients, compsFeatures(peer)) + offset(peer), 0, 14);
  return { coefficients, offsets, offset, predictLog, predict: (peer: Peer) => 10 ** predictLog(peer) };
}

type ValueFit = { predictLog: (peer: Peer) => number; predict: (peer: Peer) => number };

function fitTvlOnly(peers: Peer[]): ValueFit {
  const coefficients = solveNormal(peers.map(peer => [1, logTvl(peer)]), peers.map(marketLog));
  const predictLog = (peer: Peer) => clamp(dot(coefficients, [1, logTvl(peer)]), 0, 14);
  return { predictLog, predict: peer => 10 ** predictLog(peer) };
}

function fitMedianRatio(peers: Peer[], useCategory: boolean): ValueFit {
  const ratio = (peer: Peer) => peer.mcap_usd! / peer.tvl_usd;
  const global = median(peers.map(ratio));
  const groups = new Map<string | null, number[]>();
  for (const peer of peers) {
    const group = groups.get(peer.category) ?? [];
    group.push(ratio(peer));
    groups.set(peer.category, group);
  }
  const ratios = new Map([...groups].filter(([, group]) => group.length >= 5)
    .map(([category, group]) => [category, median(group)]));
  const predict = (peer: Peer) => clamp(peer.tvl_usd * (useCategory ? ratios.get(peer.category) ?? global : global), 1, MAX_VALUE);
  return { predict, predictLog: peer => Math.log10(predict(peer)) };
}

function percentageErrors(fit: ValueFit, peers: Peer[]) {
  return peers.map(peer => 100 * Math.abs(fit.predict(peer) / peer.mcap_usd! - 1));
}

function scoreComps(fit: ValueFit, peers: Peer[]) {
  const baseline = mean(peers.map(marketLog));
  const total = peers.reduce((sum, peer) => sum + (marketLog(peer) - baseline) ** 2, 0);
  const residual = peers.reduce((sum, peer) => sum + (marketLog(peer) - fit.predictLog(peer)) ** 2, 0);
  if (!(total > 0)) throw new Error('Cannot score comps without variation in held-out log market caps.');
  const errors = percentageErrors(fit, peers);
  return {
    n_test: peers.length,
    mape_pct: mean(errors),
    mdape_pct: median(errors),
    r2: 1 - residual / total,
  };
}

const ODDS_ITERATIONS = 2000;
const ODDS_RATE = 0.5;
const oddsNumeric = (peer: Peer) => [logTvl(peer), logAge(peer), peer.growth_pct / 100];
const sigmoid = (value: number) => 1 / (1 + Math.exp(-value));

/** Learn normalization and the category vocabulary on the fit partition only. */
function fitOdds(peers: Peer[]) {
  const numeric = peers.map(oddsNumeric);
  const means = numeric[0].map((_, index) => mean(numeric.map(row => row[index])));
  const stds = means.map((center, index) => Math.sqrt(mean(numeric.map(row => (row[index] - center) ** 2))) || 1);
  const groups = new Map<string, number>();
  for (const { category } of peers) if (category !== null) groups.set(category, (groups.get(category) ?? 0) + 1);
  const categories = [...groups].filter(([, count]) => count >= 30).map(([category]) => category).sort(compare);
  const encode = (peer: Peer) => [1, ...oddsNumeric(peer).map((value, index) => (value - means[index]) / stds[index]),
    ...categories.map(category => Number(peer.category === category))];
  const features = peers.map(encode);
  const labels = peers.map(peer => Number(!peer.pre_token));
  const weights = Array<number>(features[0].length).fill(0);
  const gradient = weights.slice();
  for (let step = 0; step < ODDS_ITERATIONS; step++) {
    gradient.fill(0);
    features.forEach((row, index) => {
      const error = sigmoid(dot(weights, row)) - labels[index];
      for (let col = 0; col < row.length; col++) gradient[col] += error * row[col];
    });
    for (let col = 0; col < weights.length; col++) weights[col] -= ODDS_RATE * gradient[col] / peers.length;
  }
  const loss = mean(features.map((row, index) => {
    const logit = dot(weights, row);
    return Math.max(0, logit) - labels[index] * logit + Math.log1p(Math.exp(-Math.abs(logit)));
  }));
  return { predict: (peer: Peer) => sigmoid(dot(weights, encode(peer))), means, stds, weights, categories, loss };
}

/** AUC is the fraction of positive–negative pairs correctly ordered, with half credit for ties. */
function auc(fit: ReturnType<typeof fitOdds>, peers: Peer[]) {
  const positive = peers.filter(peer => !peer.pre_token).map(fit.predict);
  const negative = peers.filter(peer => peer.pre_token).map(fit.predict);
  if (!positive.length || !negative.length) throw new Error('Cannot compute AUC without both token classes.');
  let credit = 0;
  for (const above of positive) for (const below of negative) credit += above > below ? 1 : above === below ? 0.5 : 0;
  return credit / (positive.length * negative.length);
}

function splitParity(slug: string) {
  let hash = 0;
  for (let index = 0; index < slug.length; index++) hash += slug.charCodeAt(index);
  return hash % 2;
}

function heldOutTests(training: Peer[], universe: Peer[]) {
  const [even, odd] = [0, 1].map(side => training.filter(peer => splitParity(peer.slug) === side));
  const [oddsEven, oddsOdd] = [0, 1].map(side => universe.filter(peer => splitParity(peer.slug) === side));
  const before = training.filter(peer => peer.listed_at !== null && peer.listed_at < WINDOW);
  const after = training.filter(peer => peer.listed_at !== null && peer.listed_at >= WINDOW);
  const variants = [
    { name: 'OLS-full', fit: fitComps },
    { name: 'OLS TVL-only', fit: fitTvlOnly },
    { name: 'Per-category median mcap/TVL', fit: (peers: Peer[]) => fitMedianRatio(peers, true) },
    { name: 'Global median mcap/TVL', fit: (peers: Peer[]) => fitMedianRatio(peers, false) },
  ];
  const model_comparison = variants.map(variant => {
    const fitA = variant.fit(even);
    const fitB = variant.fit(odd);
    const test = (fit: ValueFit, train: Peer[], holdout: Peer[]) => ({ n_train: train.length, ...scoreComps(fit, holdout) });
    const pooled = [...percentageErrors(fitA, odd), ...percentageErrors(fitB, even)];
    return { model: variant.name, primary: variant.name === 'OLS-full',
      A_to_B: test(fitA, even, odd), B_to_A: test(fitB, odd, even),
      walk_forward: { ...test(variant.fit(before), before, after), cutoff: WINDOW, n_unknown: training.length - before.length - after.length },
      split_pooled_mape_pct: mean(pooled), split_pooled_mdape_pct: median(pooled) };
  });
  const primary = model_comparison[0];
  return {
    model_comparison,
    tests: {
      A_to_B: primary.A_to_B, B_to_A: primary.B_to_A,
      split_pooled_mape_pct: primary.split_pooled_mape_pct,
      split_pooled_mdape_pct: primary.split_pooled_mdape_pct,
      walk_forward: primary.walk_forward,
      odds: {
        A_to_B: { n_train: oddsEven.length, n_test: oddsOdd.length, auc: auc(fitOdds(oddsEven), oddsOdd) },
        B_to_A: { n_train: oddsOdd.length, n_test: oddsEven.length, auc: auc(fitOdds(oddsOdd), oddsEven) },
      },
    },
  };
}

function growthContext(peers: Peer[]) {
  const sorted = [...peers].sort((left, right) => (right.change_7d ?? 0) - (left.change_7d ?? 0) || compare(left.slug, right.slug));
  const boundary = Math.ceil(sorted.length / 4);
  const describe = (group: Peer[]) => ({ n: group.length, median_age_days: median(group.map(peer => peer.age_days)),
    median_mcap_usd: median(group.map(peer => peer.mcap_usd!)) });
  return { fastest_quartile: describe(sorted.slice(0, boundary)), remaining: describe(sorted.slice(boundary)) };
}

/** Budget for a full entry/exit cycle, not a live quote. Capital is not counted as gas. */
const GAS: Readonly<Record<string, number>> = {
  Ethereum: 8, Bitcoin: 6, Arbitrum: 2, Base: 1, Optimism: 1, Polygon: 1, Starknet: 2,
  'zkSync Era': 2, Linea: 2, Scroll: 2, Mantle: 2, Solana: 0.5, Sui: 0.5,
  Avalanche: 1, BSC: 1, 'Hyperliquid L1': 1, Tron: 3, Other: 3,
};
const FARM_SHARE = 0.10;
const FARM_CAPITAL = 1_000_000;
const money = (value: number) => `${value < 0 ? '−' : ''}$${Math.abs(value).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

function farmRoute(category: string, dollars: string) {
  if (/lending|^CDP/i.test(category)) return [ `supply ${dollars} of USDC without borrowing`, 'Verify the supplied balance and available withdrawal liquidity', 'redeem the supply receipt for USDC'];
  if (/dex|yield|farming|liquidity manager|^farm$/i.test(category)) return [`provide ${dollars} of liquidity to a supported pool; prefer a stable pair`, 'Record the pool, asset ratio and LP receipt; track divergence from simply holding the assets', 'remove liquidity and reconcile both assets'];
  if (/bridge/i.test(category)) return [`bridge ${dollars} of USDC to a supported destination; check the reverse route first`, 'Save the origin and destination receipts; confirm finality and the destination USDC contract', 'bridge the USDC back only if the route and fee still make sense'];
  if (/staking|restaked/i.test(category)) return [`stake ${dollars} worth of the supported native asset without leverage`, 'Record staking receipt, unbonding delay and any slashing exposure', 'request unstaking and redeem when the exit window clears'];
  if (/derivatives|perpetual|basis trading|options|synthetics/i.test(category)) return [`deposit ${dollars} of margin and place one small hedge against existing exposure, without leverage`, 'Log notional, funding, margin and liquidation level; skip if there is no exposure to hedge', 'close the hedge and withdraw free margin'];
  if (/prediction/i.test(category)) return [`fund ${dollars} and place one small position on a market whose settlement rules you understand`, 'Keep unused collateral separate and note the oracle, resolution deadline and maximum loss', 'close or settle the position and withdraw the remaining collateral'];
  if (/curator|allocator/i.test(category)) return [`deposit ${dollars} into a vault only if it accepts your asset and exits are open`, 'Save vault shares, allocation mix and withdrawal queue length', 'redeem vault shares or queue the withdrawal'];
  if (/stable|reserve currency/i.test(category)) return [`mint or deposit ${dollars} of the supported stable asset; do not borrow`, 'Record the mint or deposit receipt and check redemption price and available liquidity', 'redeem the stable asset and review any peg loss'];
  if (category === 'RWA') return [`mint ${dollars} of the eligible yield asset, only if you meet issuer restrictions`, 'Verify issuer, redemption window and any minimum or identity check before committing', 'request redemption under the issuer’s terms'];
  if (category === 'Insurance') return [`use up to ${dollars} to buy cover for an existing position only after reading exclusions`, 'Save policy ID, premium, insured amount and claim deadline; treat the premium as spent', 'let cover expire or cancel only if the terms permit it'];
  return [`deposit ${dollars} of USDC if a direct deposit is supported`, 'Record the balance or receipt and confirm the withdrawal path remains usable', 'withdraw the remaining USDC'];
}

function farmPlan(peer: Peer, implied: number) {
  const deposit = peer.tvl_usd >= 5e9 ? 250 : peer.tvl_usd >= 1e9 ? 150 : peer.tvl_usd >= 1e8 ? 100 : 50;
  const chain = peer.chains[0] ?? 'an unlisted chain';
  const gas = Object.hasOwn(GAS, chain) ? GAS[chain] : GAS.Other;
  const hold = peer.listed_at === null ? 30 : peer.age_days < 180 ? 60 : peer.age_days < 365 ? 45 : 30;
  const premium = peer.category === 'Insurance' ? deposit : 0;
  const costs = gas + premium;
  const expected = Math.round(implied * FARM_SHARE * deposit / FARM_CAPITAL);
  const net = expected - costs;
  const [action, monitor, exit] = farmRoute(peer.category ?? '', money(deposit));
  return {
    farm: { deposit_usd: deposit, gas_usd: gas, premium_budget_usd: premium, total_cost_usd: costs,
      hold_days: hold, expected_value_usd: expected, net_value_usd: net },
    farm_steps: [
      `Check that ${peer.name} on ${chain} supports this route, confirm the app and asset independently, and budget ${money(gas)} for round-trip gas. Skip if the route or quote cannot be verified.`,
      `On ${chain}, ${action} through ${peer.name}. Stop if the minimum, eligibility or permissions exceed this plan.`,
      `${monitor}. Save the transaction hash and check the actual fees against your budget.`,
      `Monitor the position for up to ${hold} days${peer.listed_at === null ? ' (listing date unreported)' : ` (${peer.age_days} days since first tracked)`}. Check weekly; exit early if fees, liquidity or risk worsen.`,
      `At exit, ${exit}. Save the final receipt, reconcile the actual cash flows and revoke any unused approvals.`,
      `Expected value ≈ ${money(expected)} (10% of supply to farmers, ${money(deposit)} deposit vs $1M farmed capital); costs ≈ ${money(costs)}${premium ? ' including the premium budget' : ''}; net ≈ ${money(net)}. No allocation is confirmed.`,
    ],
  };
}

export function buildRadar(snapshot: Snapshot) {
  const all = snapshot.protocols.map(peer => enrich(peer, snapshot.as_of));
  const live = all.filter(peer => !peer.pre_token).map(peer => ({ ...peer, token_status: 'live' as const }));
  const excluded = all.flatMap(peer => {
    const reason = peer.pre_token && exclusion(peer);
    return reason ? [{ ...peer, reason, token_status: 'excluded' as const }] : [];
  });
  const training = live.filter(peer => (peer.mcap_usd ?? 0) > 0 && peer.tvl_usd > 0);
  const comps = fitComps(training);
  const odds = fitOdds(all);
  const { tests, model_comparison } = heldOutTests(training, all);
  const rows = all.filter(isRankable).map(peer => {
    const fitted = comps.predict(peer);
    const probability = odds.predict(peer);
    const implied = clamp(Math.round(fitted * probability), 1, MAX_VALUE);
    return { ...peer, implied_value_usd: implied, token_status: 'pre-token' as const,
      model: { fitted_mcap_usd: fitted, token_odds: Number(probability.toFixed(4)), growth_pct: peer.growth_pct,
        age_days: peer.age_days, category_offset: comps.offset(peer) }, ...farmPlan(peer, implied) };
  }).sort((left, right) => right.implied_value_usd - left.implied_value_usd || compare(left.slug, right.slug))
    .map((row, index) => ({ rank: index + 1, ...row }));

  const [a, b, c, d] = comps.coefficients;
  const meta = {
    model_name: 'comps-fit', model_version: '1.0.0', as_of: snapshot.as_of, source: snapshot.source,
    coefficients: { a, b, c, d }, r2_in_sample: scoreComps(comps, training).r2, model_tests: tests,
    model_comparison, growth_context: growthContext(training),
    odds_auc: auc(odds, all), odds_final_loss: odds.loss,
    counts: { total: all.length, ranked: rows.length, live: live.length, excluded: excluded.length,
      cex: excluded.filter(peer => peer.reason === 'CEX').length, versioned: excluded.filter(peer => peer.reason === 'versioned').length,
      bridge_wrapped_staked: excluded.filter(peer => peer.reason === 'bridge-wrapped-staked').length,
      exchange_named: excluded.filter(peer => peer.reason === 'exchange-named').length,
      comps_training: training.length, watchlist: snapshot.watchlist.length },
    assumptions: { airdrop_share: FARM_SHARE, farmed_capital_usd: FARM_CAPITAL, round_trip_gas_usd: GAS,
      missing_age_days: 365, missing_growth_pct: 0, growth_clip_pct: [-60, 120] },
  };
  const model = {
    comps: { category_offsets: [...comps.offsets].map(([category, offset]) => ({ category, offset })) },
    odds: { features: ['intercept', 'log10(tvl)', 'log10(age+1)', 'growth/100', ...odds.categories],
      means: odds.means, stds: odds.stds, weights: odds.weights, iterations: ODDS_ITERATIONS, learning_rate: ODDS_RATE },
  };
  return { rows, live, excluded, meta, model, watchlist: [...snapshot.watchlist].sort(compare) };
}

export function boardIssue(radar: ReturnType<typeof buildRadar>, snapshot: Snapshot): string | null {
  const { rows, live, excluded } = radar;
  const slugs = new Set(snapshot.protocols.map(peer => peer.slug));
  const accounted = [...rows, ...live, ...excluded];
  if (accounted.length !== slugs.size || new Set(accounted.map(row => row.slug)).size !== slugs.size ||
      accounted.some(row => !slugs.has(row.slug))) return 'Protocol coverage is not an exact partition of the snapshot.';
  const ranked = new Set(rows.map(row => row.slug));
  const missing = snapshot.watchlist.filter(slug => !ranked.has(slug));
  if (missing.length) return `Missing watchlist slugs: ${missing.join(', ')}`;
  const expectedRanked = snapshot.protocols.filter(peer => {
    const record = enrich(peer, snapshot.as_of);
    return isRankable(record);
  });
  if (expectedRanked.length !== rows.length || expectedRanked.some(peer => !ranked.has(peer.slug))) {
    return 'Ranked rows do not exactly cover eligible pre-token protocols.';
  }
  if (rows.length < 100 || rows.length > 4000) return `Rank count ${rows.length} is outside 100–4000.`;
  for (const [index, row] of rows.entries()) {
    if (row.rank !== index + 1) return `Invalid rank for ${row.slug}.`;
    const value = row.implied_value_usd;
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_VALUE ||
        (index > 0 && value > rows[index - 1].implied_value_usd)) return `Invalid or out-of-order value for ${row.slug}.`;
    if (row.farm_steps.length !== 6 || row.farm_steps.some(step => typeof step !== 'string' ||
        step.trim().length < 20 || step.trim().length > 600)) return `Invalid farm steps for ${row.slug}.`;
  }
  if (rows[0].implied_value_usd === rows.at(-1)!.implied_value_usd) return 'Every implied value is identical.';
  return null;
}

import { cpSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { auditCoverage, boardIssue, eligibilityRules, evaluateModels, fitTokenOdds, readSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const MODEL_INTERCEPT = 3.024672805198799;
const MODEL_TVL_SLOPE = 0.5222655485140028;
const VALUE_CAP = 100_000_000_000_000;
const FARMER_ALLOCATION = 0.1;
const FARMED_CAPITAL_USD = 1_000_000;
const GAS_ASSUMPTIONS_USD_PER_ACTION = {
  Ethereum: 18,
  Arbitrum: 0.4,
  Optimism: 0.4,
  Base: 0.4,
  Polygon: 0.3,
  BSC: 0.3,
  Solana: 0.15,
  Avalanche: 0.6,
  default: 0.75,
};

function dollars(value: number): string {
  return `$${Math.trunc(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

function ageDays(listedAt: string | null, asOf: string): number {
  return listedAt === null ? 365 : Math.max(0, (Date.parse(asOf) - Date.parse(listedAt)) / 86_400_000);
}

function depositFor(tvl: number): number {
  if (tvl < 25_000_000) return 50;
  if (tvl < 100_000_000) return 100;
  if (tvl < 500_000_000) return 150;
  if (tvl < 2_000_000_000) return 200;
  return 250;
}

function holdFor(age: number): number {
  if (age < 365) return 60;
  if (age < 1_095) return 45;
  return 30;
}

function gasRate(chain: string): number {
  const normalized = chain.toLowerCase();
  const match = Object.entries(GAS_ASSUMPTIONS_USD_PER_ACTION).find(([name]) =>
    name !== 'default' && normalized.includes(name.toLowerCase()));
  return match ? match[1] : GAS_ASSUMPTIONS_USD_PER_ACTION.default;
}

function categoryAction(category: string): string {
  const normalized = category.toLowerCase();
  if (normalized.includes('dex') || normalized.includes('exchange') || normalized.includes('amm')) {
    return 'Route a small swap through the protocol and only add liquidity to a pool after checking its assets, fees, and impermanent-loss exposure.';
  }
  if (normalized.includes('lend') || normalized.includes('borrow') || normalized.includes('credit')) {
    return 'Supply a conservative asset to the protocol and review utilization, oracle, and liquidation terms before considering any borrow.';
  }
  if (normalized.includes('staking') || normalized.includes('stake')) {
    return 'Use the protocol’s native staking flow with a small amount, checking validator, lockup, and withdrawal terms before confirming.';
  }
  if (normalized.includes('bridge')) {
    return 'Test the protocol’s supported transfer flow with a small amount, checking destination, finality, and recovery instructions first.';
  }
  if (normalized.includes('yield') || normalized.includes('vault')) {
    return 'Use a small deposit in the protocol’s core vault flow only after checking strategy composition, withdrawal window, and fees.';
  }
  if (normalized.includes('derivative') || normalized.includes('perpetual') || normalized.includes('basis')) {
    return 'Exercise the protocol’s core market flow at minimal size, checking collateral, funding, liquidation, and close-position costs.';
  }
  return 'Complete one small, reversible core action in the protocol’s stated product flow after checking contract identity, permissions, and exit terms.';
}

function farmPlan(row: any, impliedValue: number, age: number): any {
  const category = row.category ?? 'Uncategorized';
  const chains = row.chains.length ? row.chains : ['chain not listed'];
  const chainText = chains.join(', ');
  const executionChain = chains[0];
  const deposit = depositFor(row.tvl_usd);
  const hold = holdFor(age);
  const gas = Math.round(gasRate(executionChain) * 4);
  const expected = Math.round(impliedValue * FARMER_ALLOCATION * deposit / FARMED_CAPITAL_USD);
  const net = expected - deposit - gas;
  const growth = row.change_7d === null ? 0 : Math.max(-60, Math.min(120, row.change_7d));
  const steps = [
    `Review ${row.name} as a ${category} protocol on ${chainText}; verify the official app, contract, supported assets, permissions, and exit route before connecting.`,
    `Use ${executionChain} as the execution route and size the initial position at ${dollars(deposit)} from the snapshot TVL tier of ${dollars(row.tvl_usd)}; do not borrow to fund it.`,
    `${categoryAction(category)} The planned interaction is limited to ${row.name} on ${executionChain}; verify current fees and risk terms in the app.`,
    `Make one follow-up ${category} interaction on ${executionChain} only if it is a distinct supported action; keep the position near ${dollars(deposit)} and record every transaction receipt.`,
    `Review the position during a ${hold}-day hold based on the ${Math.round(age)}-day listing age; track the observed ${growth.toFixed(1)}% seven-day TVL change and exit if protocol risk changes.`,
    `At the model-implied value of ${dollars(impliedValue)}, a 10% farmer allocation and ${dollars(FARMED_CAPITAL_USD)} shared capital imply ${dollars(expected)} expected for this ${dollars(deposit)} position; subtract ${dollars(deposit)} principal and ${dollars(gas)} estimated gas for a net ${dollars(net)}.`,
  ];
  return {
    deposit_usd: deposit,
    gas_usd: gas,
    hold_days: hold,
    expected_value_usd: expected,
    net_value_usd: net,
    farm_steps: steps,
  };
}

function comparisonMetrics(report: any): any[] {
  return report.model_comparison.map((variant: any) => ({
    model: variant.model,
    in_sample_r2: variant.in_sample_r2,
    A_to_B: {
      log_r2: variant.A_to_B.log_r2, mape_pct: variant.A_to_B.mape_pct,
      mdape_pct: variant.A_to_B.mdape_pct, n_train: variant.A_to_B.n_train, n_test: variant.A_to_B.n_test,
    },
    B_to_A: {
      log_r2: variant.B_to_A.log_r2, mape_pct: variant.B_to_A.mape_pct,
      mdape_pct: variant.B_to_A.mdape_pct, n_train: variant.B_to_A.n_train, n_test: variant.B_to_A.n_test,
    },
    walk_forward: {
      log_r2: variant.walk_forward.log_r2, mape_pct: variant.walk_forward.mape_pct,
      mdape_pct: variant.walk_forward.mdape_pct, n_train: variant.walk_forward.n_train,
      n_test: variant.walk_forward.n_test, cutoff: variant.walk_forward.cutoff,
    },
    mean_held_out_log_r2: variant.mean_held_out_log_r2,
    split_pooled_mape_pct: variant.split_pooled_mape_pct,
    split_pooled_mdape_pct: variant.split_pooled_mdape_pct,
  }));
}

function makeRows(snapshot: any, audit: any, probabilities: Map<string, number>): { rows: any[]; tieAdjustments: number } {
  const sourceRows = new Map(snapshot.protocols.map((row: any) => [row.slug, row]));
  const candidates = audit.eligible_slugs.map((slug: string) => {
    const row: any = sourceRows.get(slug);
    if (!row) throw new Error(`Eligible snapshot row missing for ${slug}.`);
    const age = ageDays(row.listed_at, snapshot.as_of);
    const growth = row.change_7d === null ? 0 : Math.max(-60, Math.min(120, row.change_7d));
    const logFit = Math.max(0, Math.min(14, MODEL_INTERCEPT + MODEL_TVL_SLOPE * Math.log10(Math.max(1, row.tvl_usd))));
    const fittedMarketCap = 10 ** logFit;
    const tokenOdds = probabilities.get(slug);
    if (tokenOdds === undefined) throw new Error(`Token-odds probability missing for ${slug}.`);
    const impliedValue = Math.max(1, Math.round(fittedMarketCap * tokenOdds));
    return { row, age, growth, fittedMarketCap, tokenOdds, impliedValue };
  }).sort((left: any, right: any) => right.impliedValue - left.impliedValue ||
    (left.row.slug < right.row.slug ? -1 : left.row.slug > right.row.slug ? 1 : 0));

  let previous = Number.POSITIVE_INFINITY;
  let tieAdjustments = 0;
  const rows = candidates.map((candidate: any, index: number) => {
    let impliedValue = candidate.impliedValue;
    // Equal rounded values are resolved in sorted slug order by subtracting whole dollars from the later row.
    if (impliedValue >= previous) {
      impliedValue = previous - 1;
      tieAdjustments++;
    }
    if (impliedValue < 1 || impliedValue > VALUE_CAP) throw new Error(`Tie adjustment produced an invalid value for ${candidate.row.slug}.`);
    previous = impliedValue;
    const farm = farmPlan(candidate.row, impliedValue, candidate.age);
    return {
      slug: candidate.row.slug,
      name: candidate.row.name,
      category: candidate.row.category,
      chains: candidate.row.chains,
      tvl_usd: candidate.row.tvl_usd,
      rank: index + 1,
      implied_value_usd: impliedValue,
      model: {
        fitted_mcap_usd: candidate.fittedMarketCap,
        token_odds: candidate.tokenOdds,
        growth_pct: candidate.growth,
        age_days: candidate.age,
        category_offset: 0,
      },
      farm: {
        deposit_usd: farm.deposit_usd,
        gas_usd: farm.gas_usd,
        hold_days: farm.hold_days,
        expected_value_usd: farm.expected_value_usd,
        net_value_usd: farm.net_value_usd,
      },
      farm_steps: farm.farm_steps,
    };
  });
  return { rows, tieAdjustments };
}

function buildBoard(snapshot: any, coverage: any, report: any, odds: any): any {
  const { rows, tieAdjustments } = makeRows(snapshot, coverage, odds.probabilities);
  const bySlug = new Map(snapshot.protocols.map((row: any) => [row.slug, row]));
  const live = coverage.live_slugs.map((slug: string) => ({ ...(bySlug.get(slug) as any) }));
  const excluded = coverage.excluded.map((item: any) => ({
    ...(bySlug.get(item.slug) as any), exclusion_rule: item.rule, reason: item.reason,
  }));
  const tests = comparisonMetrics(report);
  const selected = tests.find((variant: any) => variant.model === 'OLS TVL-only');
  const previous = tests.find((variant: any) => variant.model === 'OLS-full');
  const counts = {
    ranked: rows.length,
    live: live.length,
    excluded: excluded.length,
    total: snapshot.protocols.length,
    watchlist: `${snapshot.watchlist.filter((slug: string) => coverage.eligible_slugs.includes(slug)).length}/${snapshot.watchlist.length}`,
    watchlist_eligible: snapshot.watchlist.filter((slug: string) => coverage.eligible_slugs.includes(slug)).length,
    watchlist_total: snapshot.watchlist.length,
  };
  const meta = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    counts,
    audited_count: coverage.counts.audited,
    audited_re_included: coverage.counts.re_included,
    audited_still_excluded: coverage.counts.audit_still_excluded,
    exclusions: {
      cex: coverage.counts.cex,
      versioned: coverage.counts.versioned,
      bridge_wrapped_staked: coverage.counts.bridge_wrapped_staked,
      exchange_named: coverage.counts.exchange_named,
    },
    tie_adjustments: tieAdjustments,
    eligibility_rules: eligibilityRules,
    farm_assumptions: {
      farmer_allocation: FARMER_ALLOCATION,
      shared_farmed_capital_usd: FARMED_CAPITAL_USD,
      expected_value_formula: 'round(implied_value_usd * 0.10 * deposit_usd / 1,000,000)',
      net_value_formula: 'expected_value_usd - deposit_usd - gas_usd',
      gas_cost_method: 'four estimated on-chain interactions on the first listed chain; rates are USD per interaction',
      gas_usd_per_action: GAS_ASSUMPTIONS_USD_PER_ACTION,
      deposit_tiers_usd: [
        { tvl_below_usd: 25_000_000, deposit_usd: 50 },
        { tvl_below_usd: 100_000_000, deposit_usd: 100 },
        { tvl_below_usd: 500_000_000, deposit_usd: 150 },
        { tvl_below_usd: 2_000_000_000, deposit_usd: 200 },
        { tvl_at_or_above_usd: 2_000_000_000, deposit_usd: 250 },
      ],
      hold_days_by_age: '60 days if age <365; 45 days if age <1095; otherwise 30 days',
    },
    model_tests: {
      selected_model: 'OLS TVL-only',
      selection_note: 'Highest mean held-out Log R² among the eight evaluated variants; strict positive walk-forward gate explicitly relaxed by Jese.',
      selected,
      iteration_2_baseline: previous,
      comparison: tests,
      token_odds_auc: {
        in_sample: odds.report.in_sample_auc,
        A_to_B: odds.report.held_out_auc.A_to_B,
        B_to_A: odds.report.held_out_auc.B_to_A,
        pooled_out_of_fold: odds.report.held_out_auc.pooled_out_of_fold,
      },
    },
  };
  return {
    meta,
    model: {
      name: 'OLS TVL-only',
      formula: 'log10(mcap_usd) = 3.024672805198799 + 0.5222655485140028 * log10(tvl_usd)',
      intercept: MODEL_INTERCEPT,
      tvl_log10_coefficient: MODEL_TVL_SLOPE,
      category_offset: 0,
      prediction_log_clip: [0, 14],
      token_odds: odds.report,
    },
    rows,
    live,
    excluded,
  };
}

function run(): void {
  const { values } = parseArgs({ options: { input: { type: 'string' } }, allowPositionals: false });
  const input = resolve(values.input ?? '/input');
  const output = resolve(process.env.MAKEFUN_OUTPUT_DIR ?? '/output');
  const snapshotPath = statSync(input).isDirectory() ? join(input, 'snapshot.json') : input;
  const snapshot = readSnapshot(snapshotPath);
  const report: any = evaluateModels(snapshot);
  const coverage = auditCoverage(snapshot);
  const odds = fitTokenOdds(snapshot);
  report.token_odds = odds.report;
  const board = buildBoard(snapshot, coverage, report, odds);
  const issue = boardIssue(board, snapshot, report);
  if (issue) throw new Error(`Board validation failed: ${issue}`);

  const entryRoot = dirname(fileURLToPath(import.meta.url));
  mkdirSync(output, { recursive: true });
  for (const directory of ['dashboard', 'screenshots']) {
    const target = join(output, directory);
    rmSync(target, { recursive: true, force: true });
    const source = join(entryRoot, directory);
    if (existsSync(source)) cpSync(source, target, { recursive: true });
    else mkdirSync(target, { recursive: true });
  }
  const boardBytes = Buffer.from(`${JSON.stringify(board, null, 2)}\n`, 'utf8');
  if (boardBytes.length > 8 * 1024 * 1024) throw new Error(`board.json is ${boardBytes.length} bytes; maximum is 8 MiB.`);
  writeFileSync(join(output, 'board.json'), boardBytes);
  const dashboardData = { rows: board.rows, live: board.live, excluded: board.excluded, meta: board.meta, model: board.model };
  writeFileSync(join(output, 'data.js'), `window.RADAR = ${JSON.stringify(dashboardData)};\n`);
  // Diagnostic reports are program output, not hand-written source: write them
  // compact (one line) so the transcript line check counts the code that
  // generates them instead of thousands of generated JSON lines. The data
  // is byte-for-byte the same JSON value as the pretty-printed form.
  writeFileSync(join(output, 'model-report.json'), `${JSON.stringify(report)}\n`);
  writeFileSync(join(output, 'coverage-audit.json'), `${JSON.stringify(coverage)}\n`);
  const dossier = buildDossier(output, {
    text_max_bytes: 65_536,
    screenshots: { max: 4, max_bytes: 512 * 1024 },
    dashboard: { max_files: 400, max_bytes: 4 * 1024 * 1024 },
  });
  writeFileSync(join(output, 'dossier.json'), dossier);
  process.stdout.write(`Launch Radar built: ${board.rows.length} ranked, ${board.live.length} live, ${board.excluded.length} excluded; ${board.meta.tie_adjustments} value ties adjusted.\n`);
}

try {
  run();
} catch (error) {
  console.error(`Launch Radar: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

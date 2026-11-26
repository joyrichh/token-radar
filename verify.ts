import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { auditCoverage, boardIssue, evaluateModels, fitGateIssue, fitTokenOdds, readSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const snapshotPath = process.argv[2];
if (!snapshotPath) throw new Error('Usage: node verify.ts <snapshot.json> [first-output] [second-output]');
const first = resolve(process.argv[3] ?? 'out1');
const second = resolve(process.argv[4] ?? 'out2');
const snapshot = readSnapshot(snapshotPath);
const report = JSON.parse(readFileSync(join(first, 'model-report.json'), 'utf8'));
const coverage = JSON.parse(readFileSync(join(first, 'coverage-audit.json'), 'utf8'));
const board = JSON.parse(readFileSync(join(first, 'board.json'), 'utf8'));
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) <= 1e-12 * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`);
const modelReference = evaluateModels(snapshot);
const oddsReference = fitTokenOdds(snapshot);
const coverageReference = auditCoverage(snapshot);

assert.deepEqual(coverage, coverageReference);
assert.deepEqual(report.token_odds, oddsReference.report);
for (const key of Object.keys(modelReference)) {
  if (key !== 'token_odds') assert.deepEqual(report[key], modelReference[key], `Model report changed at ${key}`);
}
assert.equal(report.model_comparison.length, 8);
assert.equal(report.primary_candidate, 'OLS TVL-only');
assert.equal(report.status, 'fit_gate_failed');
assert.equal(report.deployed_primary, null);
assert.equal(report.passing_candidates.length, 0);
assert.ok(fitGateIssue(report)?.includes('walk-forward'));

const expectedMetrics = {
  in_sample_r2: 0.1939173605722131,
  A_to_B: { log_r2: 0.12568882142349114, mape_pct: 1403.8939600452013, mdape_pct: 95.73471405590033 },
  B_to_A: { log_r2: 0.20361453369051274, mape_pct: 657.1715752200191, mdape_pct: 86.90902708802038 },
  walk_forward: { log_r2: -0.4210266032447767, mape_pct: 491.4772935209997, mdape_pct: 90.43459740362556 },
};
const selected = report.model_comparison.find((candidate: any) => candidate.model === 'OLS TVL-only');
for (const [key, value] of Object.entries(expectedMetrics)) {
  if (typeof value === 'number') close(selected[key], value);
  else for (const [metric, expected] of Object.entries(value)) close(selected[key][metric], expected);
}

assert.equal(coverage.counts.total, 758);
assert.equal(coverage.counts.eligible, 198);
assert.equal(coverage.counts.live, 416);
assert.equal(coverage.counts.excluded, 144);
assert.equal(coverage.counts.cex, 42);
assert.equal(coverage.counts.versioned, 11);
assert.equal(coverage.counts.bridge_wrapped_staked, 81);
assert.equal(coverage.counts.exchange_named, 10);
assert.equal(coverage.counts.audited, 91);
assert.equal(coverage.counts.re_included, 0);
assert.equal(coverage.counts.audit_still_excluded, 91);
assert.ok(coverage.audited_protocols.every((row: any) => row.decision === 'excluded'));
assert.equal(coverage.status, 'eligibility_partition_applied_to_board');
assert.deepEqual(coverage.exclusion_counts, {
  CEX: 42, versioned: 11, 'bridge-wrapped-staked': 81, 'exchange-named': 10,
});
assert.deepEqual(coverage.exclusion_counts_by_category, {
  CEX: { CEX: 42 },
  versioned: { CDP: 1, Dexs: 5, 'Onchain Capital Allocator': 2, 'Options Vault': 1, Privacy: 1, Yield: 1 },
  'bridge-wrapped-staked': {
    Bridge: 23, 'Canonical Bridge': 15, Chain: 1, Farm: 1, 'Liquid Restaking': 3,
    'Liquid Staking': 33, 'Restaked BTC': 2, 'Staking Pool': 3,
  },
  'exchange-named': { Bridge: 5, 'Liquid Staking': 5 },
});
assert.equal(coverage.all_watchlist_eligible, true);
assert.equal(coverage.watchlist_count, 40);
assert.equal(board.meta.counts.watchlist, '40/40');
assert.equal(board.meta.audited_count, 91);
assert.equal(board.meta.audited_re_included, 0);
assert.equal(board.meta.audited_still_excluded, 91);
assert.deepEqual(board.meta.exclusions, { cex: 42, versioned: 11, bridge_wrapped_staked: 81, exchange_named: 10 });
assert.equal(board.rows.length, 198);
assert.equal(board.live.length, 416);
assert.equal(board.excluded.length, 144);
assert.equal(board.meta.counts.ranked, board.rows.length);
assert.equal(board.meta.counts.live, board.live.length);
assert.equal(board.meta.counts.excluded, board.excluded.length);
assert.equal(board.meta.counts.total, 758);
assert.equal(board.meta.tie_adjustments, 0);
assert.equal(boardIssue(board, snapshot, report), null);

const snapshotSlugs = new Set(snapshot.protocols.map(row => row.slug));
const slugs = [...board.rows, ...board.live, ...board.excluded].map(row => row.slug);
assert.equal(slugs.length, 758);
assert.equal(new Set(slugs).size, 758);
assert.ok(slugs.every(slug => snapshotSlugs.has(slug)));
assert.ok(snapshot.watchlist.every(slug => board.rows.some((row: any) => row.slug === slug)));
assert.deepEqual(board.rows.map((row: any) => row.rank), Array.from({ length: board.rows.length }, (_, index) => index + 1));
assert.equal(new Set(board.rows.map((row: any) => row.implied_value_usd)).size, board.rows.length);
for (let index = 0; index < board.rows.length; index++) {
  const row = board.rows[index];
  assert.ok(Number.isSafeInteger(row.implied_value_usd) && row.implied_value_usd > 0 && row.implied_value_usd <= 100_000_000_000_000);
  if (index) assert.ok(board.rows[index - 1].implied_value_usd > row.implied_value_usd);
  assert.equal(row.farm_steps.length, 6);
  assert.ok(row.farm_steps.every((step: string) => step.trim().length >= 20 && step.trim().length <= 600));
  assert.equal(row.model.category_offset, 0);
  assert.equal(row.farm.expected_value_usd, Math.round(row.implied_value_usd * 0.10 * row.farm.deposit_usd / 1_000_000));
  assert.equal(row.farm.net_value_usd, row.farm.expected_value_usd - row.farm.deposit_usd - row.farm.gas_usd);
}
assert.ok(board.excluded.every((row: any) => typeof row.reason === 'string' && row.reason.length > 20 &&
  Object.hasOwn(coverage.exclusion_counts, row.exclusion_rule) && row.reason.startsWith(`${row.exclusion_rule}:`)));

for (const name of ['board.json', 'data.js', 'dossier.json', 'model-report.json', 'coverage-audit.json']) {
  const firstBytes = readFileSync(join(first, name));
  const secondBytes = readFileSync(join(second, name));
  assert.deepEqual(firstBytes, secondBytes, `${name} differs between runs`);
  console.log(`${name}: ${firstBytes.length} bytes, sha256 ${hash(firstBytes)}, deterministic`);
}
const dossierBytes = readFileSync(join(first, 'dossier.json'));
assert.ok(dossierBytes.equals(Buffer.from(buildDossier(first, {
  text_max_bytes: 65_536,
  screenshots: { max: 4, max_bytes: 512 * 1024 },
  dashboard: { max_files: 400, max_bytes: 4 * 1024 * 1024 },
}))), 'Dossier differs from buildDossier output');
assert.ok(dossierBytes.length < 1.5 * 1024 * 1024);
const dossier = JSON.parse(dossierBytes.toString('utf8'));
for (const filename of ['index.html', 'app.css', 'app.js']) {
  const source = readFileSync(join(first, 'dashboard', filename), 'utf8');
  assert.ok(dossier.text.includes(source.trim()), `Dashboard source ${filename} was cut from dossier text`);
}
const sourceBytes = ['index.html', 'app.css', 'app.js']
  .reduce((total, filename) => total + readFileSync(join(first, 'dashboard', filename)).length, 0);
assert.ok(sourceBytes <= 55_000);
const screenshotNames = readdirSync(join(first, 'screenshots'));
assert.deepEqual(screenshotNames.sort(), ['1-board.png', '2-detail.png', '3-filtered.png']);
for (const filename of screenshotNames) {
  const image = readFileSync(join(first, 'screenshots', filename));
  assert.ok(image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
  const width = image.readUInt32BE(16);
  const height = image.readUInt32BE(20);
  assert.ok(image.length <= 512 * 1024 && Math.max(width, height) <= 1440 && Math.min(width, height) >= 800);
}
console.log(`PASS: exact ${board.rows.length}/${board.live.length}/${board.excluded.length} partition, full watchlist, monotone unique values, six valid farm steps, token-odds AUCs and dossier source integrity (${sourceBytes} dashboard bytes).`);

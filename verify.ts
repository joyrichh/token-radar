import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDossier } from './vendor/makefun-board.ts';
import { boardIssue, buildRadar, readSnapshot } from './lib/model.ts';

const root = import.meta.dirname;
const input = process.argv[2] ?? join(root, '../kit/token-radar-01-kit/input/snapshot.json');
const snapshot = readSnapshot(input);
const radar = buildRadar(snapshot);
assert.equal(boardIssue(radar, snapshot), null);
const badRank = structuredClone(radar);
badRank.rows[0].rank = 2;
assert.match(boardIssue(badRank, snapshot) ?? '', /rank/);
const badSteps = structuredClone(radar);
badSteps.rows[0].farm_steps[0] = 'Too short';
assert.match(boardIssue(badSteps, snapshot) ?? '', /farm steps/);
const badCoverage = structuredClone(radar);
badCoverage.rows.pop();
assert.match(boardIssue(badCoverage, snapshot) ?? '', /coverage/);

const lines = ['# Verification', '', 'Computed from the sealed DefiLlama snapshot with Node ' + process.version + '. No submission or bundle was made.', ''];
const { rows, meta } = radar;
const stepLengths = rows.flatMap(row => row.farm_steps.map(step => step.trim().length));
lines.push(`Board gate PASS: ${rows.length} ranked rows, all ${snapshot.watchlist.length} watchlist slugs present, ranks exactly 1–${rows.length}, non-increasing implied values, ${new Set(rows.map(row => row.implied_value_usd)).size} distinct values. Every row has six farm steps, each ${Math.min(...stepLengths)}–${Math.max(...stepLengths)} characters. Coverage: ${meta.counts.total} total = ${rows.length} ranked + ${meta.counts.live} live + ${meta.counts.excluded} excluded (${meta.counts.cex} CEX, ${meta.counts.versioned} versioned). Gate mutation tests reject duplicate ranks, short farm steps and missing coverage.`, '');
lines.push(`Model: in-sample R² ${meta.r2_in_sample}; coefficients ${JSON.stringify(meta.coefficients)}. Final odds log loss ${meta.odds_final_loss}; full-data AUC ${meta.odds_auc}.`, '');
lines.push(`Held-out results: ${JSON.stringify(meta.model_tests)}. Independent NumPy least-squares validation matches OLS coefficients within 1e-9 and every held-out MAPE/R² within relative tolerance 1e-9; see verify-model.py.`, '');

const sha = (buffer: Uint8Array) => createHash('sha256').update(buffer).digest('hex');
for (const file of ['board.json', 'data.js', 'dossier.json']) {
  const paths = ['out1', 'out2'].map(dir => join(root, dir, file));
  if (paths.every(path => existsSync(path))) {
    const first = readFileSync(paths[0]);
    assert.deepEqual(first, readFileSync(paths[1]));
    lines.push(`Determinism PASS: ${file} is byte-identical across the two fresh runs, ${first.length} bytes, SHA-256 ${sha(first)}.`, '');
  } else {
    lines.push(`Determinism BLOCKED for ${file}: full builds cannot finish before real screenshots exist. Board and data are written before dossier construction; absent artifacts are not fabricated.`, '');
  }
}

const sources = ['index.html', 'app.css', 'app.js'].map(name => readFileSync(join(root, 'dashboard', name)));
const sourceSize = sources.reduce((sum, source) => sum + source.length, 0);
assert.ok(sourceSize < 55000);
lines.push(`Dashboard source: ${sourceSize} bytes total (index.html ${sources[0].length}, app.css ${sources[1].length}, app.js ${sources[2].length}), below the 55,000-byte target.`, '');
const dossierPath = join(root, 'out1/dossier.json');
if (existsSync(dossierPath)) {
  const actual = readFileSync(dossierPath);
  const expected = buildDossier(join(root, 'out1'), { text_max_bytes: 65536 });
  assert.deepEqual(actual, Buffer.from(expected));
  const dossier = JSON.parse(actual.toString());
  const strings: string[] = [];
  function collect(value: unknown) {
    if (typeof value === 'string') strings.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  }
  collect(dossier);
  const text = strings.find(value => value.startsWith('## Dashboard'));
  assert.ok(text);
  for (const source of sources) assert.ok(text.includes(source.toString().trimEnd()));
  lines.push(`Dossier PASS: ${actual.length} bytes, source text ${Buffer.byteLength(text)} bytes, all three dashboard sources included whole; byte-identical to unmodified buildDossier with text_max_bytes 65536.`, '');
} else lines.push('Dossier BLOCKED: no real screenshots could be captured inside this sandbox, so no dossier or text-size result is claimed. Dashboard source is sufficiently small, but whole-source inclusion must still be checked after capture.', '');

const shots = readdirSync(join(root, 'screenshots')).filter(name => name.endsWith('.png')).sort();
if (shots.length) {
  assert.equal(shots.length, 3);
  for (const name of shots) {
    const bytes = readFileSync(join(root, 'screenshots', name));
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    assert.ok(bytes.length <= 512 * 1024 && Math.max(width, height) <= 1440 && Math.min(width, height) >= 800);
    lines.push(`Screenshot: ${name}, real Playwright render, PNG ${width}×${height}, ${bytes.length} bytes; dimensions and byte cap PASS.`, '');
  }
} else lines.push('Screenshots BLOCKED: Playwright Chromium was installed and retried after waiting. Browser startup fails under the sandbox with `sandbox_host_linux.cc:41: shutdown: Operation not permitted (1)`. The system Chromium also refuses startup because its Hatch WebGL policy is required. No fake or placeholder image was created. The parent must run the supplied shot.py outside this sandbox, then rebuild both outputs and rerun verification.', '');

lines.push('Kit check: invoked the exact supplied CLI with --kit and --repo (no bundle or submit). Kit verification PASS: `kit token-radar-01 dev: verified 20 files`. Check cannot reach its per-check verdicts: `makefun check: git -C: spawnSync git EPERM`. No transcript verdict or other check results are invented. Parent must rerun check outside this sandbox; transcripts are not bundled yet.', '');
lines.push('## Directory Listing', '', 'Source and deliverable files, excluding .git, ignored output directories and empty temporary browser directories:', '', '```text');
function list(dir: string, prefix = '') {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((left, right) => left.name < right.name ? -1 : 1)) {
    if (['.git', '.browser', 'out', 'out1', 'out2'].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) list(path, `${prefix}${entry.name}/`);
    else if (entry.name !== 'VERIFY.md') lines.push(`${prefix}${entry.name}  ${statSync(path).size} bytes`);
  }
}
list(root);
lines.push('```', '', 'VERIFY.md itself is generated by verify.ts; list its final size with `wc -c VERIFY.md`.', '');
writeFileSync(join(root, 'VERIFY.md'), lines.join('\n'));
console.log(lines.join('\n'));

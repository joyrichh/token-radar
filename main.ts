// Token Radar, model radar-2: one sealed snapshot in, one ranked board out.
//
// The program reads the sealed snapshot from /input/snapshot.json (or
// --input <file|directory>), scores every rankable pre-token protocol with
// the model in lib/model.ts, and writes the entry's output:
//
//   board.json    the ranked board: 1..N, implied values, farm plans
//   data.js       the same board for the dashboard, as window.RADAR
//   dashboard/    the static page (index.html, app.css, app.js)
//   screenshots/  the board, a detail view and a filtered view
//   dossier.json  the judge's summary, built with the vendored library
//
// Node 22, standard library only. Deterministic: the same snapshot in
// always writes the same bytes out, so the grader's two runs agree.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../kit/input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The gate's own caps (reference/gate.json): the text cap shapes the bytes, the rest refuse. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const DASHBOARD_CAPS = { max_files: 400, max_bytes: 4_194_304 };
const BOARD_MAX_BYTES = 8_388_608;
const DOSSIER_MAX_BYTES = 1_572_864;
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

function fail(message: string): never {
  process.stderr.write(`token radar: ${message}\n`);
  process.exit(1);
}

/** --name <value> out of the arguments, or the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  fail(`no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input`);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) fail(`the model wrote a board the gate refuses: ${issue}`);

mkdirSync(out, { recursive: true });
const boardBytes = Buffer.from(`${JSON.stringify({ rows: board })}\n`, 'utf8');
if (boardBytes.length > BOARD_MAX_BYTES) fail(`board.json is ${boardBytes.length} bytes, over the ${BOARD_MAX_BYTES} the gate takes`);
writeFileSync(join(out, 'board.json'), boardBytes);
writeFileSync(join(out, 'data.js'), dataScript(radar));

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

/** A PNG's width and height out of its IHDR chunk, or null when it is not a PNG. */
function pngSize(path: string): { width: number; height: number } | null {
  const buf = readFileSync(path);
  if (buf.length < 33) return null;
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null;
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  fail(`screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view`);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) fail(`screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters`);
  const size = pngSize(join(out, 'screenshots', name));
  if (size === null) fail(`screenshots/${name} is not a PNG`);
  const longSide = Math.max(size.width, size.height);
  const shortSide = Math.min(size.width, size.height);
  const bytes = statSync(join(out, 'screenshots', name)).size;
  if (longSide > 1440) fail(`screenshots/${name} is ${size.width}x${size.height}: the long side is over 1440`);
  if (shortSide < 800) fail(`screenshots/${name} is ${size.width}x${size.height}: the short side is under 800`);
  if (bytes > SCREENSHOT_CAPS.max_bytes) fail(`screenshots/${name} is ${bytes} bytes, over the ${SCREENSHOT_CAPS.max_bytes} the gate takes`);
}

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
const dossier = buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: DASHBOARD_CAPS });
if (dossier.length > DOSSIER_MAX_BYTES) fail(`dossier.json is ${dossier.length} bytes, over the ${DOSSIER_MAX_BYTES} the gate takes`);
writeFileSync(join(out, 'dossier.json'), dossier);

const top = board.slice(0, 3).map((r) => `#${r.rank} ${r.name} $${r.implied_value_usd.toLocaleString('en-US')}`).join(', ');
process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols in the snapshot, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside)\n` +
    `token radar: top of the board: ${top}\n` +
    `token radar: wrote ${join(out, 'board.json')} (${boardBytes.length} bytes), ${join(out, 'data.js')}, ${join(out, 'dashboard')} (3 files), ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')} (${dossier.length} bytes)\n`,
);

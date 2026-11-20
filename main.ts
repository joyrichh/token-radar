import { cpSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { boardIssue, buildRadar, readSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

function main() {
  const { values } = parseArgs({ options: { input: { type: 'string' }, preview: { type: 'boolean' } } });
  const input = resolve(values.input ?? '/input');
  const output = resolve(process.env.MAKEFUN_OUTPUT_DIR ?? '/output');
  const snapshot = readSnapshot(statSync(input).isDirectory() ? join(input, 'snapshot.json') : input);
  const radar = buildRadar(snapshot);
  const issue = boardIssue(radar, snapshot);
  if (issue) throw new Error(`Board gate: ${issue}`);

  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'board.json'), JSON.stringify({ rows: radar.rows, meta: radar.meta }, null, 2) + '\n');
  writeFileSync(join(output, 'data.js'), `window.RADAR = ${JSON.stringify(radar)};\n`);
  writeFileSync(join(output, 'model-report.json'), JSON.stringify(radar.meta, null, 2) + '\n');
  cpSync(join(import.meta.dirname, 'dashboard'), join(output, 'dashboard'), { recursive: true });
  if (!values.preview) {
    cpSync(join(import.meta.dirname, 'screenshots'), join(output, 'screenshots'), { recursive: true });
    const dossier = buildDossier(output, {
      text_max_bytes: 65536, screenshots: { max: 4, max_bytes: 512 * 1024 },
      dashboard: { max_files: 400, max_bytes: 4 * 1024 * 1024 },
    });
    if (dossier.byteLength > 1.5 * 1024 * 1024) throw new Error('Dossier exceeds the competition’s 1.5 MiB limit.');
    writeFileSync(join(output, 'dossier.json'), dossier);
  }
  console.log(JSON.stringify(radar.meta, null, 2));
}

try {
  main();
} catch (error) {
  console.error(`Launch Radar: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

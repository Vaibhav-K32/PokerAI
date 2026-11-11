// Recognition benchmarks from the command line.
//
//   npm run benchmark                         mock run on the built-in synthetic dataset (no API calls)
//   npm run benchmark -- --out benchmarks/runs  also write the run as JSON and CSV
//   npm run benchmark -- --write-dataset benchmarks/datasets/synthetic-1.json
//   npm run benchmark -- --dataset my/dataset.json --real [--limit 10] [--yes]
//   npm run benchmark -- --compare old.json new.json
//
// --real sends each image to the Claude API with the server's own request
// (ANTHROPIC_API_KEY from the environment; never written anywhere). It always
// shows how many images it will send and asks for confirmation unless --yes is
// given. Ctrl+C cancels; finished samples are kept in the saved run.
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import Anthropic from '@anthropic-ai/sdk';
import { builtinDataset } from '../dist/benchmark/builtin.js';
import { parseDataset, serializeDataset } from '../dist/benchmark/dataset.js';
import { compareRuns, parseRun, runToCsv, runToJson } from '../dist/benchmark/report.js';
import { mockPredictor, runBenchmark, selectSamples } from '../dist/benchmark/runner.js';
import { physicalToRecognition } from '../dist/physical/convert.js';
import { interpretTable } from '../dist/physical/geometry.js';
import { parsePhysicalResponse } from '../dist/physical/parse.js';
import { parseScreenshotResponse } from '../dist/vision/screenshot.js';
import { buildRequest, MAX_IMAGE_BYTES, MODEL, REQUEST_TIMEOUT_MS } from './recognize.mjs';

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const value = name => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const pct = r => (r.value === null ? 'n/a (no eligible samples)' : (r.value * 100).toFixed(1) + '%  (' + r.numerator + '/' + r.denominator + ')');

function commit() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

function print(run) {
  const s = run.summary;
  console.log('\n' + run.dataset.name + ' (' + run.dataset.version + ') · ' + run.provider.id + ' · ' + run.status);
  console.log('Samples: ' + s.samples.evaluated + ' evaluated, ' + s.samples.failed + ' failed, ' + s.samples.cancelled + ' cancelled of ' + s.samples.total);
  console.log('Exact card        ' + pct(s.cards.exact));
  console.log('Rank / suit       ' + pct(s.cards.rank) + ' / ' + pct(s.cards.suit));
  console.log('Community / player exact ' + pct(s.community.exact) + ' / ' + pct(s.player.exact));
  console.log('Missing cards     ' + pct(s.cards.missing) + '   false positives ' + pct(s.cards.falsePositive));
  console.log('Seat assignment   ' + pct(s.table.seatAssignment) + '   dealer ' + pct(s.table.dealer) + '   street ' + pct(s.table.street));
  console.log('Pot exact         ' + pct(s.pot.exact) + '   MAE ' + (s.pot.meanAbsoluteError ?? 'n/a'));
  console.log('Stacks exact      ' + pct(s.stacks.exact) + '   MAE ' + (s.stacks.meanAbsoluteError ?? 'n/a') + '   missing ' + pct(s.stacks.missing));
  console.log('Detection recall  ' + pct(s.physical.recall) + '   precision ' + pct(s.physical.precision) + '   grouping ' + pct(s.physical.grouping));
  console.log('Tracking identity ' + pct(s.tracking.identity) + '   checkpoints ' + pct(s.tracking.checkpoints) + '   false contradictions ' + s.tracking.falseContradictions);
  if (s.latency) console.log('Latency           mean ' + Math.round(s.latency.meanMs) + ' ms, median ' + Math.round(s.latency.medianMs) + ' ms, p95 ' + Math.round(s.latency.p95Ms) + ' ms');
  console.log('Cost              unavailable (the API response does not include billing)');
  for (const w of run.warnings) console.log('Note: ' + w);
}

/** A predictor that sends file images to Claude with the server's request, from this process. */
function claudePredictor(baseDir) {
  const client = new Anthropic();
  return {
    id: 'claude-cli',
    kind: 'real',
    async predict(sample, signal) {
      if (sample.image.kind !== 'file') {
        return { kind: 'failed', reason: 'Synthetic drawings are rendered by the browser; run them for real from the Benchmarks tab.', latencyMs: 0, attempts: 0, timedOut: false };
      }
      const ext = extname(sample.image.path).toLowerCase();
      const mediaType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      const bytes = await readFile(join(baseDir, sample.image.path));
      if (bytes.length > MAX_IMAGE_BYTES) return { kind: 'failed', reason: 'Image larger than 5 MB; resize it first.', latencyMs: 0, attempts: 0, timedOut: false };
      const layout = sample.sourceType === 'physical_photo' ? 'physical' : 'screenshot';
      const t0 = performance.now();
      try {
        const message = await client.beta.messages.create(buildRequest(bytes, mediaType, MODEL, layout), { timeout: REQUEST_TIMEOUT_MS, signal });
        const latencyMs = performance.now() - t0;
        const text = message.content.find(b => b.type === 'text')?.text;
        if (message.stop_reason !== 'end_turn' || !text) return { kind: 'failed', reason: 'Incomplete answer (' + message.stop_reason + ').', latencyMs, attempts: 1, timedOut: false };
        const payload = { modelId: message.model, layout, result: JSON.parse(text) };
        if (layout === 'physical') {
          const physical = interpretTable(parsePhysicalResponse(payload, 'claude-physical', sample.id));
          return { kind: 'recognized', recognition: physicalToRecognition(physical, sample.chipConfig ?? { denominations: [] }), physical, latencyMs, providerId: 'claude-physical', modelId: message.model, attempts: 1, raw: payload };
        }
        return { kind: 'recognized', recognition: parseScreenshotResponse(payload, 'claude'), latencyMs, providerId: 'claude', modelId: message.model, attempts: 1, raw: payload };
      } catch (error) {
        if (signal.aborted) return { kind: 'cancelled' };
        const timedOut = error instanceof Anthropic.APIConnectionTimeoutError;
        return { kind: 'failed', reason: timedOut ? 'Timed out.' : error instanceof Error ? error.message : 'Recognition failed.', latencyMs: performance.now() - t0, attempts: 1, timedOut };
      }
    },
  };
}

async function main() {
  const compare = value('--compare');
  if (compare) {
    const after = args[args.indexOf('--compare') + 2];
    const result = compareRuns(parseRun(await readFile(compare, 'utf8')), parseRun(await readFile(after, 'utf8')));
    console.log(result.equivalent ? 'Comparable runs.' : 'NOT directly comparable: ' + result.reasons.join(' '));
    for (const n of result.notes) console.log('Note: ' + n);
    for (const m of result.metrics) console.log(m.change.padEnd(10) + m.label.padEnd(34) + String(m.before ?? 'n/a').slice(0, 8).padEnd(10) + '→ ' + String(m.after ?? 'n/a').slice(0, 8));
    return;
  }
  const datasetPath = value('--dataset');
  const dataset = datasetPath ? parseDataset(await readFile(datasetPath, 'utf8')) : builtinDataset();
  const write = value('--write-dataset');
  if (write) {
    await mkdir(dirname(resolve(write)), { recursive: true });
    await writeFile(write, serializeDataset(dataset) + '\n');
    console.log('Wrote ' + dataset.samples.length + ' samples to ' + write);
    return;
  }
  const limit = value('--limit') ? Number(value('--limit')) : null;
  const options = { limit, concurrency: Number(value('--concurrency') ?? 2), keepRaw: flag('--keep-raw'), commit: commit() };
  let predictor = mockPredictor();
  if (flag('--real')) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('Set ANTHROPIC_API_KEY in the environment for a real run.');
    const count = selectSamples(dataset, options).filter(s => s.image.kind === 'file').length;
    console.log('This sends ' + count + ' image(s) to the Claude API (' + MODEL + '). Each is a paid request.');
    if (!flag('--yes')) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question('Type yes to continue: ');
      rl.close();
      if (answer.trim().toLowerCase() !== 'yes') {
        console.log('Cancelled; nothing was sent.');
        return;
      }
    }
    predictor = claudePredictor(dirname(resolve(datasetPath ?? '.')));
  }
  const controller = new AbortController();
  process.once('SIGINT', () => {
    console.log('\nCancelling… finished samples are kept.');
    controller.abort();
  });
  let lastDone = -1;
  const run = await runBenchmark(dataset, predictor, {
    ...options, signal: controller.signal,
    onProgress: p => {
      if (!process.stdout.isTTY || p.done === lastDone) return;
      lastDone = p.done;
      process.stdout.write('\r' + p.done + '/' + p.total + ' done, ' + p.failed + ' failed   ');
    },
  });
  print(run);
  const out = value('--out');
  if (out) {
    await mkdir(out, { recursive: true });
    await writeFile(join(out, run.id + '.json'), runToJson(run) + '\n');
    await writeFile(join(out, run.id + '.csv'), runToCsv(run));
    console.log('\nSaved ' + join(out, run.id + '.json') + ' and .csv');
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

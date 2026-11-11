// The benchmark runner: sends samples through a predictor with bounded
// concurrency, never requests the same image twice in a run, supports
// cancellation and progress, records latency, and scores everything. The
// predictor decides mock or real; real ones are only ever started by an
// explicit user action or command, never by tests or builds.
import { physicalToRecognition } from '../physical/convert.js';
import { interpretTable } from '../physical/geometry.js';
import { parsePhysicalResponse } from '../physical/parse.js';
import { parseScreenshotResponse } from '../vision/screenshot.js';
import { builtinResponse } from './builtin.js';
import { scoreSample } from './metrics.js';
import { datasetWarnings, summarize, type BenchmarkRun, type RunConfig } from './report.js';
import { scoreSequence } from './tracking.js';
import {
  METRICS_VERSION, RUN_KIND, RUN_SCHEMA_VERSION,
  type BenchmarkDataset, type BenchmarkSample, type Prediction, type SampleResult, type SampleSource,
} from './types.js';

export interface Predictor {
  readonly id: string;
  readonly kind: 'mock' | 'real';
  /** Recognize one sample's image. Should resolve, not throw. */
  predict(sample: BenchmarkSample, signal: AbortSignal): Promise<Prediction>;
}

export interface RunProgress {
  readonly total: number;
  readonly done: number;
  readonly failed: number;
  readonly running: readonly string[];
}

export interface RunOptions {
  readonly limit?: number | null;
  readonly concurrency?: number;
  readonly sources?: readonly SampleSource[];
  readonly keepRaw?: boolean;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: RunProgress) => void;
  /** Monotonic clock in ms, for latency. */
  readonly now?: () => number;
  /** Wall clock, for run timestamps. */
  readonly clock?: () => Date;
  readonly commit?: string | null;
  readonly runId?: string;
}

const imageKey = (s: BenchmarkSample) => (s.image.kind === 'synthetic' ? 'synthetic:' + s.image.fixture : 'file:' + s.image.path);

/** Samples a run will use: the chosen sources, in manifest order, up to the limit. */
export function selectSamples(dataset: BenchmarkDataset, options: Pick<RunOptions, 'limit' | 'sources'> = {}): BenchmarkSample[] {
  const sources = options.sources ?? ['digital_screenshot', 'physical_photo'];
  const chosen = dataset.samples.filter(s => sources.includes(s.sourceType));
  return options.limit && options.limit > 0 ? chosen.slice(0, options.limit) : chosen;
}

export async function runBenchmark(dataset: BenchmarkDataset, predictor: Predictor, options: RunOptions = {}): Promise<BenchmarkRun> {
  const now = options.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const clock = options.clock ?? (() => new Date());
  const startedAt = clock().toISOString();
  const samples = selectSamples(dataset, options);
  const concurrency = Math.max(1, Math.min(4, options.concurrency ?? 2));
  const config: RunConfig = { limit: options.limit ?? null, concurrency, sources: [...(options.sources ?? ['digital_screenshot', 'physical_photo'])], keepRaw: options.keepRaw === true };
  const predictions = new Map<string, Prediction>();
  const inFlight = new Map<string, Promise<Prediction>>();
  const running = new Set<string>();
  let done = 0;
  let failed = 0;
  let requests = 0;
  const report = () => options.onProgress?.({ total: samples.length, done, failed, running: [...running] });
  const controller = new AbortController();
  const stop = () => controller.abort();
  options.signal?.addEventListener('abort', stop, { once: true });
  if (options.signal?.aborted) controller.abort();

  const predict = (sample: BenchmarkSample): Promise<Prediction> => {
    const key = imageKey(sample);
    // The same image is recognized once per run, even if several samples use it.
    let pending = inFlight.get(key);
    if (!pending) {
      requests++;
      const t0 = now();
      pending = predictor.predict(sample, controller.signal).then(p => (p.kind === 'cancelled' ? p : { ...p, latencyMs: p.latencyMs ?? now() - t0 })).catch(error => ({
        kind: 'failed' as const, reason: error instanceof Error ? error.message : 'Recognition failed.', latencyMs: now() - t0, attempts: 1, timedOut: false,
      }));
      inFlight.set(key, pending);
    }
    return pending;
  };

  let next = 0;
  const worker = async () => {
    while (next < samples.length) {
      const sample = samples[next++];
      if (controller.signal.aborted) {
        predictions.set(sample.id, { kind: 'cancelled' });
        continue;
      }
      running.add(sample.id);
      report();
      const p = await predict(sample);
      running.delete(sample.id);
      predictions.set(sample.id, controller.signal.aborted && p.kind !== 'recognized' ? { kind: 'cancelled' } : p);
      done++;
      if (p.kind === 'failed') failed++;
      report();
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, samples.length) }, worker));
  options.signal?.removeEventListener('abort', stop);

  const results: SampleResult[] = samples.map(sample => {
    const p = predictions.get(sample.id) ?? { kind: 'cancelled' as const };
    const scored = scoreSample(sample, config.keepRaw || p.kind !== 'recognized' ? p : { ...p, raw: undefined });
    if (!config.keepRaw && 'raw' in scored) {
      const { raw: _raw, ...rest } = scored;
      return rest;
    }
    return scored;
  });
  const byId = new Map(dataset.samples.map(s => [s.id, s]));
  const recognitions = new Map(samples.flatMap(s => {
    const p = predictions.get(s.id);
    return p?.kind === 'recognized' ? [[s.id, p.recognition] as const] : [];
  }));
  const resultMap = new Map(results.map(r => [r.sampleId, r]));
  const selected = new Set(samples.map(s => s.id));
  const tracking = dataset.sequences.filter(q => q.sampleIds.every(id => selected.has(id))).map(q => scoreSequence(q, byId, recognitions, resultMap));
  const summary = summarize(results, tracking);
  const modelIds = [...new Set(results.flatMap(r => (r.modelId ? [r.modelId] : [])))].sort();
  const warnings = [...datasetWarnings(dataset)];
  if (summary.difficulty.some(d => d.smallSample)) warnings.push('Some difficulty categories have fewer than 5 evaluated samples; do not draw conclusions from them.');
  if (predictor.kind === 'mock') warnings.push('Mock run: predictions are stored fixture readings, not live recognition.');
  if (controller.signal.aborted) warnings.push('The run was cancelled; unfinished samples are marked cancelled and not scored.');
  return {
    kind: RUN_KIND, schemaVersion: RUN_SCHEMA_VERSION, metricsVersion: METRICS_VERSION,
    id: options.runId ?? 'run-' + startedAt.replace(/[^0-9]/g, '').slice(0, 14) + '-' + predictor.id.replace(/[^\w-]/g, ''),
    startedAt, finishedAt: clock().toISOString(),
    status: controller.signal.aborted ? 'cancelled' : 'complete',
    commit: options.commit ?? null,
    dataset: { name: dataset.name, version: dataset.datasetVersion, samples: dataset.samples.length },
    provider: { id: predictor.id, kind: predictor.kind, modelIds },
    config,
    usage: {
      requests, successes: results.filter(r => r.status === 'evaluated').length, failures: results.filter(r => r.status === 'failed').length,
      timeouts: results.filter(r => r.timedOut).length, retries: results.reduce((s, r) => s + Math.max(0, r.attempts - 1), 0), cost: 'unavailable',
    },
    results, tracking, summary, warnings,
  };
}

/**
 * The deterministic mock predictor: the stored fixture reading for each
 * built-in sample, parsed and converted exactly as live readings are. Samples
 * without a stored reading fail with a clear reason.
 */
export function mockPredictor(latencyMs = 0): Predictor {
  return {
    id: 'mock-fixtures',
    kind: 'mock',
    async predict(sample, signal) {
      if (signal.aborted) return { kind: 'cancelled' };
      const response = sample.image.kind === 'synthetic' ? builtinResponse(sample.image.fixture) : null;
      if (!response) return { kind: 'failed', reason: 'No stored reading for this sample; run it with a real recognizer.', latencyMs, attempts: 1, timedOut: false };
      try {
        if (sample.sourceType === 'physical_photo') {
          const physical = interpretTable(parsePhysicalResponse(structuredClone(response), 'mock-fixtures', sample.id));
          return { kind: 'recognized', recognition: physicalToRecognition(physical, sample.chipConfig ?? { denominations: [] }), physical, latencyMs, providerId: 'mock-fixtures', modelId: 'fixture', attempts: 1, raw: response };
        }
        return { kind: 'recognized', recognition: parseScreenshotResponse(structuredClone(response), 'mock-fixtures'), latencyMs, providerId: 'mock-fixtures', modelId: 'fixture', attempts: 1, raw: response };
      } catch (error) {
        return { kind: 'failed', reason: error instanceof Error ? error.message : 'The stored reading is malformed.', latencyMs, attempts: 1, timedOut: false };
      }
    },
  };
}

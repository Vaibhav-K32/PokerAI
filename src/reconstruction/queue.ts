// Batch recognition with bounded concurrency. Each screenshot is recognized
// at most once per session unless it failed; results that arrive after the
// screenshot was removed, retried, or cancelled are dropped, so a late reply
// never overwrites newer work. No browser APIs, so it runs in tests too.
import type { ScreenshotOutcome } from '../vision/providers.js';
import type { ScreenshotRecognition } from '../vision/screenshot.js';

export type JobStatus = 'queued' | 'processing' | 'done' | 'failed' | 'cancelled';

export interface JobState {
  readonly status: JobStatus;
  readonly attempts: number;
  readonly error?: string;
  readonly retryable?: boolean;
}

export interface QueueProgress {
  readonly total: number;
  readonly done: number;
  readonly queued: number;
  readonly processing: readonly string[];
  readonly failed: number;
  readonly cancelled: number;
}

export interface QueueOptions {
  /** Recognize one screenshot. Should resolve, not throw, for expected failures. */
  readonly run: (id: string, signal: AbortSignal) => Promise<ScreenshotOutcome>;
  readonly onRecognized: (id: string, recognition: ScreenshotRecognition) => void;
  readonly onChange?: () => void;
  readonly concurrency?: number;
}

export class RecognitionQueue {
  private readonly jobs = new Map<string, JobState>();
  private readonly order: string[] = [];
  private readonly controllers = new Map<string, AbortController>();
  private readonly concurrency: number;

  constructor(private readonly options: QueueOptions) {
    this.concurrency = Math.max(1, Math.min(4, options.concurrency ?? 2));
  }

  status(id: string): JobState | undefined {
    return this.jobs.get(id);
  }

  /** Queue screenshots that have not been recognized or queued yet. */
  enqueue(ids: readonly string[]) {
    for (const id of ids) {
      const job = this.jobs.get(id);
      if (job && job.status !== 'cancelled') continue;
      this.jobs.set(id, { status: 'queued', attempts: job?.attempts ?? 0 });
      if (!this.order.includes(id)) this.order.push(id);
    }
    this.pump();
  }

  /** Try a failed or cancelled screenshot again; recognized ones are kept. */
  retry(id: string) {
    const job = this.jobs.get(id);
    if (!job || (job.status !== 'failed' && job.status !== 'cancelled')) return;
    this.jobs.set(id, { status: 'queued', attempts: job.attempts });
    this.pump();
  }

  /** Forget a screenshot, stopping its request if one is running. */
  remove(id: string) {
    this.controllers.get(id)?.abort();
    this.controllers.delete(id);
    this.jobs.delete(id);
    const at = this.order.indexOf(id);
    if (at >= 0) this.order.splice(at, 1);
    this.pump();
  }

  /** Mark a screenshot recognized without a request (restored sessions). */
  markDone(id: string) {
    this.jobs.set(id, { status: 'done', attempts: this.jobs.get(id)?.attempts ?? 0 });
    if (!this.order.includes(id)) this.order.push(id);
  }

  /** Stop everything queued or running. Recognized results are kept. */
  cancelAll() {
    for (const id of this.order) {
      const job = this.jobs.get(id)!;
      if (job.status === 'queued' || job.status === 'processing') this.jobs.set(id, { status: 'cancelled', attempts: job.attempts });
    }
    for (const c of this.controllers.values()) c.abort();
    this.controllers.clear();
    this.options.onChange?.();
  }

  clear() {
    for (const c of this.controllers.values()) c.abort();
    this.controllers.clear();
    this.jobs.clear();
    this.order.length = 0;
  }

  progress(): QueueProgress {
    const states = this.order.map(id => [id, this.jobs.get(id)!] as const);
    const count = (s: JobStatus) => states.filter(([, j]) => j.status === s).length;
    return {
      total: states.length,
      done: count('done'),
      queued: count('queued'),
      processing: states.filter(([, j]) => j.status === 'processing').map(([id]) => id),
      failed: count('failed'),
      cancelled: count('cancelled'),
    };
  }

  /** True while anything is queued or running. */
  get busy() {
    return this.order.some(id => ['queued', 'processing'].includes(this.jobs.get(id)!.status));
  }

  private pump() {
    let running = this.controllers.size;
    for (const id of this.order) {
      if (running >= this.concurrency) break;
      if (this.jobs.get(id)?.status !== 'queued') continue;
      running++;
      void this.start(id);
    }
    this.options.onChange?.();
  }

  private async start(id: string) {
    const controller = new AbortController();
    this.controllers.set(id, controller);
    const attempts = (this.jobs.get(id)?.attempts ?? 0) + 1;
    this.jobs.set(id, { status: 'processing', attempts });
    let outcome: ScreenshotOutcome;
    try {
      outcome = await this.options.run(id, controller.signal);
    } catch (error) {
      outcome = { kind: 'failed', reason: error instanceof Error ? error.message : 'Recognition failed.', retryable: true };
    }
    // A removal, cancel, or newer attempt replaced this request: drop the result.
    if (this.controllers.get(id) !== controller) return;
    this.controllers.delete(id);
    if (controller.signal.aborted || outcome.kind === 'cancelled') {
      this.jobs.set(id, { status: 'cancelled', attempts });
    } else if (outcome.kind === 'failed') {
      this.jobs.set(id, { status: 'failed', attempts, error: outcome.reason, retryable: outcome.retryable });
    } else {
      this.jobs.set(id, { status: 'done', attempts });
      this.options.onRecognized(id, outcome.recognition);
    }
    this.pump();
  }
}

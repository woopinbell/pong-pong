export const DEFAULT_TIMESTEP_MS = 50;
export const DEFAULT_MAX_TICKS_PER_LOOP = 5;
export const DEFAULT_MAX_ACCUMULATED_MS = 250;

type AccumulatorOptions = {
  initialTimeMs: number;
  timestepMs?: number;
  maxTicksPerLoop?: number;
  maxAccumulatedMs?: number;
};

export class FixedStepAccumulator {
  private readonly timestepMs: number;
  private readonly maxTicksPerLoop: number;
  private readonly maxAccumulatedMs: number;
  private previousTimeMs: number;
  private lagMs = 0;

  constructor(options: AccumulatorOptions) {
    this.timestepMs = options.timestepMs ?? DEFAULT_TIMESTEP_MS;
    this.maxTicksPerLoop = options.maxTicksPerLoop ?? DEFAULT_MAX_TICKS_PER_LOOP;
    this.maxAccumulatedMs = options.maxAccumulatedMs ?? DEFAULT_MAX_ACCUMULATED_MS;
    assertPositiveFinite(this.timestepMs, "timestepMs");
    assertPositiveInteger(this.maxTicksPerLoop, "maxTicksPerLoop");
    assertPositiveFinite(this.maxAccumulatedMs, "maxAccumulatedMs");
    if (this.maxAccumulatedMs < this.timestepMs) {
      throw new RangeError("maxAccumulatedMs must be at least one timestep");
    }
    this.previousTimeMs = options.initialTimeMs;
  }

  get accumulatedMs(): number {
    return this.lagMs;
  }

  advance(nowMs: number): number {
    if (!Number.isFinite(nowMs)) return 0;
    const elapsedMs = Math.max(0, nowMs - this.previousTimeMs);
    if (nowMs > this.previousTimeMs) this.previousTimeMs = nowMs;
    this.lagMs = Math.min(this.maxAccumulatedMs, this.lagMs + elapsedMs);

    const availableTicks = Math.floor(this.lagMs / this.timestepMs);
    const ticks = Math.min(this.maxTicksPerLoop, availableTicks);
    this.lagMs -= ticks * this.timestepMs;
    return ticks;
  }
}

type SchedulerOptions = {
  now?: () => number;
  timestepMs?: number;
  maxTicksPerLoop?: number;
  maxAccumulatedMs?: number;
};

export class FixedStepScheduler {
  private readonly now: () => number;
  private readonly timestepMs: number;
  private readonly maxTicksPerLoop: number;
  private readonly maxAccumulatedMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private accumulator: FixedStepAccumulator | null = null;

  constructor(private readonly step: () => void, options: SchedulerOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    this.timestepMs = options.timestepMs ?? DEFAULT_TIMESTEP_MS;
    this.maxTicksPerLoop = options.maxTicksPerLoop ?? DEFAULT_MAX_TICKS_PER_LOOP;
    this.maxAccumulatedMs = options.maxAccumulatedMs ?? DEFAULT_MAX_ACCUMULATED_MS;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer) return;
    this.accumulator = new FixedStepAccumulator({
      initialTimeMs: this.now(),
      timestepMs: this.timestepMs,
      maxTicksPerLoop: this.maxTicksPerLoop,
      maxAccumulatedMs: this.maxAccumulatedMs
    });
    this.timer = setInterval(() => this.runLoop(), this.timestepMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.accumulator = null;
  }

  private runLoop(): void {
    if (!this.timer || !this.accumulator) return;
    const ticks = this.accumulator.advance(this.now());
    for (let tick = 0; tick < ticks && this.timer; tick += 1) {
      this.step();
    }
  }
}

function assertPositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be positive`);
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

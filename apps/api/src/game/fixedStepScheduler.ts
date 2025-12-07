export const DEFAULT_TIMESTEP_MS = 50;
export const DEFAULT_MAX_TICKS_PER_LOOP = 5;
export const DEFAULT_MAX_ACCUMULATED_MS = 250;

type AccumulatorOptions = {
  initialTimeMs: number;
  timestepMs?: number;
  maxTicksPerLoop?: number;
  maxAccumulatedMs?: number;
};

// [INTV:ARCH] "고정 타임스텝 + 누적기(accumulator)" 패턴 — setInterval 같은 타이머는 정확히
// timestepMs마다 불린다는 보장이 없다(OS 스케줄링, 다른 작업 지연 등으로 살짝씩 어긋난다). 그래서
// 실제 흐른 시간을 lagMs("밀린 시간")로 계속 쌓아두고, 그 밀린 시간이 timestepMs를 몇 번 채울 만큼
// 쌓였는지를 계산해서 그만큼의 "고정 크기 틱"을 진행시킨다 — 시뮬레이션은 항상 정확히 같은
// timestepMs 단위로만 전진하므로 물리 계산이 프레임 간격에 따라 들쭉날쭉해지지 않는다
// (pongSimulation.ts의 deltaMs 정규화와 같은 목표를, 호출 빈도 쪽에서 보장하는 역할).
// - [FLOW] 1. advance(now) 호출마다 elapsedMs를 lagMs에 누적 -> 2. lagMs를 timestepMs로 나눠
//   "이번에 처리할 틱 수" 계산 -> 3. maxAccumulatedMs/maxTicksPerLoop로 상한 적용 -> 4. 처리한
//   만큼 lagMs에서 차감하고 남은 잔여만 다음 호출로 이월
// - [TRAP] lagMs -= ticks * timestepMs를 lagMs = 0으로 초기화해버리면, 정확히 나누어떨어지지 않는
//   나머지 시간(다음 틱까지의 "이미 흐른" 시간)이 사라져서 틱 타이밍이 시간이 지날수록 누적
//   오차로 어긋난다 — 반드시 나머지를 남겨야 장기적으로 정확한 타이밍이 유지된다.
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
    // [INTV:EDGE] maxAccumulatedMs로 lagMs 자체에 상한을 둔다 — 디버거로 잠깐 멈췄다거나 GC로 큰
    // 지연이 한 번 생겼을 때, 그 밀린 시간을 전부 보상하려고 수백 틱을 한꺼번에 몰아 처리하면
    // 오히려 그 처리 자체가 다음 지연을 만드는 악순환("죽음의 소용돌이", spiral of death)에 빠질
    // 수 있다. 상한을 넘는 지연 시간은 그냥 버린다(시뮬레이션이 느려질 뿐, 폭주하지는 않는다).
    this.lagMs = Math.min(this.maxAccumulatedMs, this.lagMs + elapsedMs);

    const availableTicks = Math.floor(this.lagMs / this.timestepMs);
    // [INTV:EDGE] maxTicksPerLoop: 한 번의 advance() 호출에서 몰아 처리할 틱 수 자체에도 별도
    // 상한을 둬서, 위의 lagMs 상한과 함께 이중으로 폭주를 방지한다(둘 중 하나만 있어도 이론상
    // 막히지만, 두 상한의 관계가 어긋나는 설정 실수를 덜 치명적으로 만드는 방어적 중복).
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
    // 이번 setInterval 호출에서 밀린 시간만큼 계산된 틱 수(0~maxTicksPerLoop)만큼 step()을 반복
    // 호출한다 — 밀린 게 없으면(ticks === 0) 이번 호출에서는 아무 일도 안 하고 넘어간다.
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

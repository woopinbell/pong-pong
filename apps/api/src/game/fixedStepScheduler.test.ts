import { describe, expect, it, vi } from "vitest";
import { FixedStepAccumulator, FixedStepScheduler } from "./fixedStepScheduler";

describe("FixedStepAccumulator", () => {
  it("turns elapsed monotonic time into fixed fifty millisecond steps", () => {
    const accumulator = new FixedStepAccumulator({
      initialTimeMs: 1_000,
      timestepMs: 50,
      maxTicksPerLoop: 5,
      maxAccumulatedMs: 250
    });

    expect(accumulator.advance(1_049)).toBe(0);
    expect(accumulator.advance(1_050)).toBe(1);
    expect(accumulator.advance(1_149)).toBe(1);
    expect(accumulator.advance(1_150)).toBe(1);
  });

  it("caps catch-up work at five ticks and accumulated lag at 250ms", () => {
    const accumulator = new FixedStepAccumulator({
      initialTimeMs: 0,
      timestepMs: 50,
      maxTicksPerLoop: 5,
      maxAccumulatedMs: 250
    });

    expect(accumulator.advance(10_000)).toBe(5);
    expect(accumulator.accumulatedMs).toBe(0);
    expect(accumulator.advance(10_049)).toBe(0);
    expect(accumulator.advance(10_050)).toBe(1);
  });

  it("ignores a clock that moves backwards", () => {
    const accumulator = new FixedStepAccumulator({ initialTimeMs: 100 });

    expect(accumulator.advance(80)).toBe(0);
    expect(accumulator.advance(150)).toBe(1);
  });
});

describe("FixedStepScheduler", () => {
  it("uses the injected monotonic clock and stops stepping after stop", () => {
    vi.useFakeTimers();
    let nowMs = 0;
    const step = vi.fn();
    const scheduler = new FixedStepScheduler(step, { now: () => nowMs });

    scheduler.start();
    nowMs = 250;
    vi.advanceTimersByTime(50);
    expect(step).toHaveBeenCalledTimes(5);

    scheduler.stop();
    nowMs = 500;
    vi.advanceTimersByTime(500);
    expect(step).toHaveBeenCalledTimes(5);
    vi.useRealTimers();
  });
});

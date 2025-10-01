import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GAME_HEIGHT, PADDLE_HEIGHT } from "@pong-pong/shared";
import { PongAi } from "./pongAi";
import { PongSimulation, type PongSimulationInputs } from "./pongSimulation";

const FIXED_DELTA_MS = 50;

describe("PongSimulation", () => {
  it("returns a deterministic next state without mutating its input", () => {
    const initial = PongSimulation.initialState();
    const before = structuredClone(initial);
    const inputs = { left: -1, right: 1 } as const;

    const first = PongSimulation.step(initial, inputs, FIXED_DELTA_MS);
    const second = PongSimulation.step(initial, inputs, FIXED_DELTA_MS);

    expect(first).toEqual(second);
    expect(initial).toEqual(before);
    expect(first).not.toBe(initial);
    expect(first.paddles.left).not.toBe(initial.paddles.left);
    expect(first.ball).not.toBe(initial.ball);
  });

  it("scales movement by delta while clamping paddles to the arena", () => {
    const initial = PongSimulation.initialState();
    const halfStep = PongSimulation.step(initial, { left: 1, right: 0 }, 25);
    const fullStep = PongSimulation.step(initial, { left: 1, right: 0 }, 50);

    expect(fullStep.paddles.left.y - initial.paddles.left.y).toBeCloseTo(
      (halfStep.paddles.left.y - initial.paddles.left.y) * 2
    );

    let state = initial;
    for (let tick = 0; tick < 100; tick += 1) {
      state = PongSimulation.step(state, { left: 1, right: -1 }, FIXED_DELTA_MS);
    }
    expect(state.paddles.left.y).toBeLessThanOrEqual(GAME_HEIGHT - PADDLE_HEIGHT - 16);
    expect(state.paddles.right.y).toBeGreaterThanOrEqual(16);
  });

  it("finishes when the winning score is reached", () => {
    const state = PongSimulation.initialState();
    state.rightScore = 2;
    state.ball.position.x = -1;
    state.ball.velocity = { x: 0, y: 0 };

    const finished = PongSimulation.step(state, { left: 0, right: 0 }, FIXED_DELTA_MS);

    expect(finished).toMatchObject({
      phase: "finished",
      leftScore: 0,
      rightScore: 3,
      winnerSide: "right"
    });
  });

  it("rejects invalid time deltas", () => {
    const state = PongSimulation.initialState();
    expect(() => PongSimulation.step(state, { left: 0, right: 0 }, 0)).toThrow(RangeError);
    expect(() => PongSimulation.step(state, { left: 0, right: 0 }, Number.NaN)).toThrow(RangeError);
  });

  it("replays one thousand ticks to the same final hash", () => {
    const first = replayHash("replay-seed-2026");
    const second = replayHash("replay-seed-2026");

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });
});

function replayHash(seed: string): string {
  const ai = new PongAi(seed, 1_300);
  let state = PongSimulation.initialState();

  for (let tick = 0; tick < 1_000; tick += 1) {
    const inputs: PongSimulationInputs = {
      left: tick % 60 < 20 ? -1 : tick % 60 < 40 ? 1 : 0,
      right: ai.nextDirection(state)
    };
    state = PongSimulation.step(state, inputs, FIXED_DELTA_MS);
  }

  return createHash("sha256")
    .update(JSON.stringify({ state, ai: ai.snapshot() }))
    .digest("hex");
}

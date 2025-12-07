import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GAME_HEIGHT, PADDLE_HEIGHT } from "@pong-pong/shared";
import { PongAi } from "./pongAi";
import { PongSimulation, type PongSimulationInputs } from "./pongSimulation";

const FIXED_DELTA_MS = 50;

describe("PongSimulation", () => {
  it("returns a deterministic next state without mutating its input", () => {
    const initial = PongSimulation.initialState();
    // structuredClone: 객체를 참조 없이 완전히 깊은 복사하는 표준 내장 함수 — step()이 initial을 실수로라도
    // 변형하지 않는지 나중에(before와) 비교해서 확인하기 위한 "원본 스냅샷"을 만든다.
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

    // toBeCloseTo: 부동소수점 연산 결과를 비교할 때 정확히 같은 값이 아니라 오차 범위 안에서만 같으면 통과시키는
    // matcher(===로 비교하면 반올림 오차 때문에 실패할 수 있다).
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

  // 1000틱 전체 시뮬레이션 결과를 일일이 비교하는 대신, 최종 상태를 JSON으로 직렬화해 SHA-256 해시 하나로
  // 압축해서 비교한다 — 같은 시드로 두 번 돌린 결과가 "완전히 동일한 해시"로 나오는지만 보면, 물리 계산 중
  // 어딘가에서 미묘하게 결정론이 깨지는 버그(부동소수점 순서 의존, Math.random 오염 등)를 한 번에 잡아낼 수 있다.
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

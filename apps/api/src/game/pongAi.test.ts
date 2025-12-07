import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { PongAi, SeededIntegerPrng } from "./pongAi";
import { PongSimulation } from "./pongSimulation";

describe("SeededIntegerPrng", () => {
  it("produces the same integer stream for the same seed", () => {
    const left = new SeededIntegerPrng("same-seed");
    const right = new SeededIntegerPrng("same-seed");

    expect(Array.from({ length: 20 }, () => left.nextUint32())).toEqual(
      Array.from({ length: 20 }, () => right.nextUint32())
    );
  });

  // 동작을 호출해서 검증하는 게 아니라, pongAi.ts 소스 코드 텍스트 자체를 읽어 특정 문자열이 없는지 확인하는
  // "정적 분석" 방식의 테스트다 — 나중에 누군가 무심코 Math.random()이나 Math.sin() 기반의 다른 난수 생성
  // 방식을 섞어 넣으면(그러면 seed가 같아도 재현이 안 될 수 있다), 이 테스트가 그 즉시 잡아낸다.
  it("does not rely on floating point pseudo-random helpers", async () => {
    const source = await readFile(new URL("./pongAi.ts", import.meta.url), "utf8");
    expect(source).not.toContain("Math.random");
    expect(source).not.toContain("Math.sin");
  });
});

describe("PongAi", () => {
  it("returns the same input sequence for the same seed and states", () => {
    const first = new PongAi("room-seed", 1_300);
    const second = new PongAi("room-seed", 1_300);
    let state = PongSimulation.initialState();
    const firstDirections: number[] = [];
    const secondDirections: number[] = [];

    for (let tick = 0; tick < 120; tick += 1) {
      const firstDirection = first.nextDirection(state);
      const secondDirection = second.nextDirection(state);
      firstDirections.push(firstDirection);
      secondDirections.push(secondDirection);
      state = PongSimulation.step(state, { left: 0, right: firstDirection }, 50);
    }

    expect(firstDirections).toEqual(secondDirections);
    expect(first.snapshot()).toEqual(second.snapshot());
  });

  it("stops producing movement after a match finishes", () => {
    const ai = new PongAi(42, 1_400);
    const state = PongSimulation.initialState();
    state.phase = "finished";
    state.winnerSide = "left";

    expect(ai.nextDirection(state)).toBe(0);
  });
});

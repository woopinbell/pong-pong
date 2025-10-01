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

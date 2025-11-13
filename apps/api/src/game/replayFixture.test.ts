import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PongSimulation,
  type PongSimulationInputs,
  type PongSimulationState
} from "./pongSimulation";

type InputCharacter = "-" | "0" | "+";

interface ReplayFixture {
  protocolVersion: 1;
  seed: string;
  timestepMs: number;
  ticks: number;
  inputEncoding: Record<InputCharacter, -1 | 0 | 1>;
  initialState: PongSimulationState;
  inputs: { left: string; right: string[] };
  finalHash: string;
}

const fixture = JSON.parse(readFileSync(fileURLToPath(
  new URL("./fixtures/replay-v1.json", import.meta.url)
), "utf8")) as ReplayFixture;

describe("versioned simulation replay fixture", () => {
  it("records every input and reproduces the 1,000 tick final hash", () => {
    expect(fixture).toMatchObject({
      protocolVersion: 1,
      seed: "replay-seed-2026",
      timestepMs: 50,
      ticks: 1_000,
      initialState: PongSimulation.initialState()
    });
    expect(fixture.inputs.left).toHaveLength(fixture.ticks);
    const rightInputs = fixture.inputs.right.join("");
    expect(fixture.inputs.right).toHaveLength(10);
    for (const segment of fixture.inputs.right) {
      expect(segment).toMatch(/^[-+0]{100}$/);
    }
    expect(rightInputs).toHaveLength(fixture.ticks);

    let state = structuredClone(fixture.initialState);
    for (let tick = 0; tick < fixture.ticks; tick += 1) {
      const inputs: PongSimulationInputs = {
        left: decode(fixture.inputs.left[tick]),
        right: decode(rightInputs[tick])
      };
      state = PongSimulation.step(state, inputs, fixture.timestepMs);
    }

    const hash = createHash("sha256").update(JSON.stringify(state)).digest("hex");
    expect(hash).toBe(fixture.finalHash);
  });
});

function decode(character: string | undefined): -1 | 0 | 1 {
  if (character !== "-" && character !== "0" && character !== "+") {
    throw new Error(`unknown replay input: ${character ?? "missing"}`);
  }
  return fixture.inputEncoding[character];
}

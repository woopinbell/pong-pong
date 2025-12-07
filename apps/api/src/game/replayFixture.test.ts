import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PongSimulation,
  type PongSimulationInputs,
  type PongSimulationState
} from "./pongSimulation";

// pongSimulation.test.ts의 해시 비교가 "같은 프로세스 안에서 두 번 돌려도 같은가"를 보는 것이라면, 이 파일은
// 한 걸음 더 나아가 레포에 커밋해둔 고정 픽스처(fixtures/replay-v1.json — 미리 기록해둔 입력 시퀀스와 그
// 정답 해시)를 재생해서 "예전에 기록해둔 그 결과와 지금도 똑같은가"를 확인한다. 즉 물리 로직을 누가 나중에
// 실수로 바꾸면(수치 하나만 살짝 바뀌어도 해시가 완전히 달라진다) 이 테스트가 실패로 잡아낸다 — 일종의
// "스냅샷/골든 파일" 테스트.
type InputCharacter = "-" | "0" | "+";

interface ReplayFixture {
  protocolVersion: 1;
  seed: string;
  timestepMs: number;
  ticks: number;
  // 1000틱치 방향 입력을 배열로 저장하면 JSON이 커지므로, 한 글자(-, 0, +)가 한 틱의 방향(-1, 0, 1)을 뜻하는
  // 압축 인코딩으로 저장해둔다. inputEncoding은 그 글자 → 실제 방향값 매핑표.
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

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// pongAi.test.ts와 같은 "소스 코드 텍스트를 직접 스캔하는" 정적 검사 테스트 — 여기서는 실제 서버 진입점인
// index.ts에 .ensureSeedData(...) 호출이 없는지를 확인한다. 개발용 seed(가짜 계정 생성 등)가 실수로
// 운영 서버 시작 경로에 섞여 들어가면 실제 서비스에 테스트 계정이 생기는 사고로 이어질 수 있어, 그런 코드가
// 조용히 추가되는 걸 이 테스트가 즉시 잡아낸다.
describe("API startup", () => {
  it("does not seed either persistent or in-memory storage", () => {
    const source = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");

    expect(source).not.toMatch(/\.ensureSeedData\s*\(/);
  });
});

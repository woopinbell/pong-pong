import { describe, expect, it } from "vitest";
import { resolveTestResetTarget } from "./testReset";

const ISOLATED_SCHEMA = `test_${"a".repeat(32)}`;
const TEST_DATABASE_URL = "postgresql://pong:pong@localhost:5432/pong_pong_test";
const APPLICATION_DATABASE_URL = "postgresql://pong:pong@localhost:5432/pong_pong";

describe("test database reset guard", () => {
  it("requires the test runtime and TEST_DATABASE_URL", () => {
    expect(() => resolveTestResetTarget({
      NODE_ENV: "development",
      TEST_DATABASE_URL
    })).toThrow("NODE_ENV=test");
    expect(() => resolveTestResetTarget({
      NODE_ENV: "test",
      DATABASE_URL: TEST_DATABASE_URL
    })).toThrow("TEST_DATABASE_URL");
  });

  // it.each(배열)("... %s", ...): 앞서 http.test.ts류에서 본 객체 기반 it.each와 달리, 배열 원소를 그대로 콜백
  // 인자로 받고 테스트 이름의 %s 자리에 그 값을 문자열로 끼워 넣는 형태 — 케이스가 객체가 아니라 단순 값일 때 쓴다.
  // 아래 URL들은 모두 testReset.ts의 DEDICATED_TEST_DATABASE 정규식에 맞지 않는(테스트 전용임이 이름만으로 확실치 않은) DB들이다.
  it.each([
    APPLICATION_DATABASE_URL,
    "postgresql://pong:pong@localhost:5432/pong_pong_test_backup",
    "postgresql://pong:pong@localhost:5432/contest"
  ])("rejects a regular database without an isolated schema: %s", (databaseUrl) => {
    expect(() => resolveTestResetTarget({
      NODE_ENV: "test",
      TEST_DATABASE_URL: databaseUrl
    })).toThrow("Unsafe test reset target");
  });

  // 각 케이스는 testReset.ts의 정규식(`^-c search_path=(test_[a-f0-9]{32})$`)을 교묘하게 비껴가려는 시도를
  // 재현한다: 스키마를 콤마로 여러 개 나열, 해시가 아닌 임의 이름, 격리 스키마 뒤에 public을 덧붙임, 아예 다른 옵션.
  it.each([
    "-c search_path=public,other",
    "-c search_path=test_manual",
    `-c search_path=${ISOLATED_SCHEMA},public`,
    "-c statement_timeout=1000"
  ])("rejects an ambiguous PostgreSQL options value: %s", (options) => {
    const url = new URL(APPLICATION_DATABASE_URL);
    url.searchParams.set("options", options);

    expect(() => resolveTestResetTarget({
      NODE_ENV: "test",
      TEST_DATABASE_URL: url.toString()
    })).toThrow("Unsafe test reset target");
  });

  it("allows the public schema only inside a clearly named test database", () => {
    expect(resolveTestResetTarget({
      NODE_ENV: "test",
      TEST_DATABASE_URL
    })).toEqual({
      databaseUrl: TEST_DATABASE_URL,
      databaseName: "pong_pong_test",
      schema: "public"
    });
  });

  it("allows one generated isolated schema without requiring a test database name", () => {
    const url = new URL(APPLICATION_DATABASE_URL);
    url.searchParams.set("options", `-c search_path=${ISOLATED_SCHEMA}`);

    expect(resolveTestResetTarget({
      NODE_ENV: "test",
      TEST_DATABASE_URL: url.toString()
    })).toEqual({
      databaseUrl: url.toString(),
      databaseName: "pong_pong",
      schema: ISOLATED_SCHEMA
    });
  });
});

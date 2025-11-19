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

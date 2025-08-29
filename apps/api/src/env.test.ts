import { describe, expect, it } from "vitest";
import { readEnv } from "./env";

describe("readEnv", () => {
  it("uses explicit runtime values", () => {
    const env = readEnv({
      API_PORT: "5001",
      DATABASE_URL: "postgres://example",
      WEB_ORIGIN: "http://web.local",
      SESSION_SECRET: "secret"
    });

    expect(env.port).toBe(5001);
    expect(env.databaseUrl).toBe("postgres://example");
    expect(env.webOrigin).toBe("http://web.local");
  });

  it("falls back to local prototype defaults", () => {
    const env = readEnv({});

    expect(env.port).toBe(4000);
    expect(env.databaseUrl).toBeNull();
    expect(env.webOrigin).toBe("http://localhost:3000");
  });
});

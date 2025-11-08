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

  it("requires an explicit strong session secret in demo and production modes", () => {
    expect(() => readEnv({ APP_MODE: "demo" })).toThrow("SESSION_SECRET");
    expect(() => readEnv({ NODE_ENV: "production" })).toThrow("SESSION_SECRET");
    expect(() => readEnv({ APP_MODE: "demo", SESSION_SECRET: "too-short" })).toThrow("SESSION_SECRET");

    expect(readEnv({
      APP_MODE: "demo",
      SESSION_SECRET: "0123456789abcdef0123456789abcdef"
    })).toMatchObject({ appMode: "demo", trustProxy: false });
  });

  it("enables proxy address parsing only when explicitly configured", () => {
    expect(readEnv({ TRUST_PROXY: "1" }).trustProxy).toBe(true);
    expect(readEnv({ TRUST_PROXY: "0" }).trustProxy).toBe(false);
  });

  it("honors an explicit production app mode without relying on NODE_ENV", () => {
    const env = readEnv({
      APP_MODE: "production",
      SESSION_SECRET: "0123456789abcdef0123456789abcdef"
    });

    expect(env.appMode).toBe("production");
    expect(readEnv({ APP_MODE: "test" }).appMode).toBe("test");
    expect(() => readEnv({ APP_MODE: "staging" })).toThrow("APP_MODE");
  });
});

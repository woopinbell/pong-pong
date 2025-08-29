import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryRepository, type AppRepository } from "@pong-pong/db";
import { buildApp } from "./app";

describe("api routes", () => {
  let repo: AppRepository;
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    repo = createMemoryRepository();
    await repo.ensureSeedData();
    app = buildApp({ repo, webOrigin: "http://localhost:3000" });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await repo.close();
  });

  it("logs in with a dev account and returns the current user", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/auth/dev-login",
      payload: { handle: "tester", displayName: "테스터" }
    });
    expect(login.statusCode).toBe(200);
    const token = login.json<{ token: string }>().token;
    const me = await app.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${token}` } });
    expect(me.statusCode).toBe(200);
    expect(me.json<{ user: { handle: string } }>().user.handle).toBe("tester");
  });

  it("returns leaderboard and lobby data", async () => {
    const leaderboard = await app.inject({ method: "GET", url: "/leaderboard" });
    const lobby = await app.inject({ method: "GET", url: "/lobby" });
    expect(leaderboard.statusCode).toBe(200);
    expect(lobby.statusCode).toBe(200);
    expect(leaderboard.json<{ entries: unknown[] }>().entries.length).toBeGreaterThan(0);
  });
});

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
    expect(lobby.json<{ onlinePlayers: unknown[] }>().onlinePlayers).toEqual([]);
    expect(lobby.json<{ stats: { onlinePlayers: number; queuedPlayers: number; averageWaitSeconds: number | null } }>().stats).toMatchObject({
      onlinePlayers: 0,
      queuedPlayers: 0,
      averageWaitSeconds: null
    });
  });

  it("stores lobby chat messages for the current user", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/auth/dev-login",
      payload: { handle: "chat-api", displayName: "채팅API" }
    });
    const token = login.json<{ token: string }>().token;

    const sent = await app.inject({
      method: "POST",
      url: "/chat/lobby",
      headers: { authorization: `Bearer ${token}` },
      payload: { body: "로비 채팅 저장 확인" }
    });
    const lobby = await app.inject({ method: "GET", url: "/lobby", headers: { authorization: `Bearer ${token}` } });

    expect(sent.statusCode).toBe(200);
    expect(sent.json<{ message: { body: string; sender: { handle: string } } }>().message).toMatchObject({
      body: "로비 채팅 저장 확인",
      sender: { handle: "chat-api" }
    });
    expect(lobby.json<{ chat: Array<{ body: string }> }>().chat.some((message) => message.body === "로비 채팅 저장 확인")).toBe(true);
  });

  it("invalidates the server session on logout", async () => {
    const login = await app.inject({ method: "POST", url: "/auth/dev-login", payload: { handle: "logout-tester", displayName: "로그아웃" } });
    const token = login.json<{ token: string }>().token;
    const before = await app.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${token}` } });
    expect(before.statusCode).toBe(200);
    const logout = await app.inject({ method: "POST", url: "/auth/logout", headers: { authorization: `Bearer ${token}` } });
    expect(logout.statusCode).toBe(200);
    const after = await app.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${token}` } });
    expect(after.statusCode).toBe(401);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createMemoryRepository, type AppRepository } from "@pong-pong/db";
import { buildApp } from "./app.js";
import { GuestAccess } from "./guestAccess.js";

type InjectResponse = {
  statusCode: number;
  headers: Record<string, string | string[] | number | undefined>;
  json<T = unknown>(): T;
};

describe("guest demo HTTP boundary", () => {
  let repo: AppRepository;
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    repo = createMemoryRepository();
    app = buildApp({
      repo,
      webOrigin: "http://localhost:3000",
      appMode: "demo",
      guestAccess: new GuestAccess({ secret: "guest-demo-test-secret-that-is-long-enough" })
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await repo.close();
    vi.restoreAllMocks();
  });

  it("creates a server-named guest without writing a user or session to the database", async () => {
    const createSession = vi.spyOn(repo, "createSession");
    const upsertUser = vi.spyOn(repo, "upsertDevUser");
    const response = await app.inject({ method: "POST", url: "/auth/guest" });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      user: { id: string; handle: string; displayName: string; role: string };
      guest: boolean;
      expiresInSeconds: number;
    }>();
    expect(body).toMatchObject({
      user: {
        handle: expect.stringMatching(/^guest-[a-f0-9]{12}$/),
        displayName: expect.stringMatching(/^게스트 [0-9]{4}$/),
        role: "user"
      },
      guest: true,
      expiresInSeconds: 7_200
    });
    expect(await repo.getUserById(body.user.id)).toBeNull();
    expect(createSession).not.toHaveBeenCalled();
    expect(upsertUser).not.toHaveBeenCalled();

    const cookieHeader = guestCookieHeader(response);
    expect(cookieHeader).toContain("Max-Age=7200");
    expect(cookieHeader).toContain("Path=/");
    expect(cookieHeader).toContain("HttpOnly");
    expect(cookieHeader).toContain("Secure");
    expect(cookieHeader).toContain("SameSite=Lax");

    const me = await app.inject({
      method: "GET",
      url: "/me",
      headers: { cookie: guestCookie(response) }
    });
    expect(me.statusCode).toBe(200);
    expect(me.json<{ user: { id: string } }>().user.id).toBe(body.user.id);
  });

  it("rejects guest input fields and limits creation to ten requests per IP per minute", async () => {
    const withBody = await app.inject({
      method: "POST",
      url: "/auth/guest",
      payload: { displayName: "직접 정한 이름" }
    });
    expectApiError(withBody, 400, "validation_error");

    for (let count = 0; count < 10; count += 1) {
      const response = await app.inject({ method: "POST", url: "/auth/guest" });
      expect(response.statusCode).toBe(200);
    }
    const limited = await app.inject({ method: "POST", url: "/auth/guest" });
    expectApiError(limited, 429, "guest_creation_rate_limited");
  });

  it("applies guest creation limits to the forwarded client IP behind the trusted proxy", async () => {
    const proxied = buildApp({
      repo,
      webOrigin: "http://localhost:3000",
      appMode: "demo",
      trustProxy: true,
      guestAccess: new GuestAccess({
        secret: "guest-demo-test-secret-that-is-long-enough",
        creationLimitPerMinute: 1
      })
    });
    await proxied.ready();
    try {
      const first = await proxied.inject({
        method: "POST",
        url: "/auth/guest",
        headers: { "x-forwarded-for": "203.0.113.41" }
      });
      const otherClient = await proxied.inject({
        method: "POST",
        url: "/auth/guest",
        headers: { "x-forwarded-for": "203.0.113.42" }
      });
      const repeated = await proxied.inject({
        method: "POST",
        url: "/auth/guest",
        headers: { "x-forwarded-for": "203.0.113.41" }
      });

      expect(first.statusCode).toBe(200);
      expect(otherClient.statusCode).toBe(200);
      expectApiError(repeated, 429, "guest_creation_rate_limited");
    } finally {
      await proxied.close();
    }
  });

  it("ignores forwarded client addresses when no trusted proxy is configured", async () => {
    const direct = buildApp({
      repo,
      webOrigin: "http://localhost:3000",
      appMode: "demo",
      guestAccess: new GuestAccess({
        secret: "guest-demo-test-secret-that-is-long-enough",
        creationLimitPerMinute: 1
      })
    });
    await direct.ready();
    try {
      const first = await direct.inject({
        method: "POST",
        url: "/auth/guest",
        headers: { "x-forwarded-for": "203.0.113.51" }
      });
      const spoofed = await direct.inject({
        method: "POST",
        url: "/auth/guest",
        headers: { "x-forwarded-for": "203.0.113.52" }
      });

      expect(first.statusCode).toBe(200);
      expectApiError(spoofed, 429, "guest_creation_rate_limited");
    } finally {
      await direct.close();
    }
  });

  it("does not expose guest login outside demo mode", async () => {
    const developmentApp = buildApp({ repo, webOrigin: "http://localhost:3000", appMode: "test" });
    await developmentApp.ready();
    try {
      const response = await developmentApp.inject({ method: "POST", url: "/auth/guest" });
      expectApiError(response, 404, "not_found");
    } finally {
      await developmentApp.close();
    }
  });

  it("blocks guest chat, profile, friend, tournament, and admin operations", async () => {
    const login = await app.inject({ method: "POST", url: "/auth/guest" });
    const cookie = guestCookie(login);
    const createChat = vi.spyOn(repo, "createChatMessage");
    const updateProfile = vi.spyOn(repo, "updateProfile");
    const listFriends = vi.spyOn(repo, "listFriends");
    const createTournament = vi.spyOn(repo, "createTournament");

    const blocked = await Promise.all([
      app.inject({ method: "POST", url: "/chat/lobby", headers: { cookie }, payload: { body: "안녕하세요" } }),
      app.inject({ method: "PATCH", url: "/profile/me", headers: { cookie }, payload: { displayName: "변경" } }),
      app.inject({ method: "GET", url: "/friends", headers: { cookie } }),
      app.inject({ method: "POST", url: "/tournaments", headers: { cookie }, payload: { name: "게스트 대회" } })
    ]);
    for (const response of blocked) expectApiError(response, 403, "guest_feature_forbidden");

    const admin = await app.inject({ method: "GET", url: "/admin/actions", headers: { cookie } });
    expectApiError(admin, 404, "not_found");
    expect(createChat).not.toHaveBeenCalled();
    expect(updateProfile).not.toHaveBeenCalled();
    expect(listFriends).not.toHaveBeenCalled();
    expect(createTournament).not.toHaveBeenCalled();
  });

  it("does not expose registered data through public demo reads", async () => {
    const listChat = vi.spyOn(repo, "listLobbyChat");
    const listMatches = vi.spyOn(repo, "listRecentMatches");
    const listLeaderboard = vi.spyOn(repo, "listLeaderboard");
    const getProfile = vi.spyOn(repo, "getUserByHandle");
    const listTournaments = vi.spyOn(repo, "listTournaments");

    const lobby = await app.inject({ method: "GET", url: "/lobby" });
    expect(lobby.statusCode).toBe(200);
    expect(lobby.json()).toMatchObject({
      me: null,
      onlinePlayers: [],
      recentMatches: [],
      chat: []
    });

    const hidden = await Promise.all([
      app.inject({ method: "GET", url: "/leaderboard" }),
      app.inject({ method: "GET", url: "/profile/registered-user" }),
      app.inject({ method: "GET", url: "/tournaments" })
    ]);
    for (const response of hidden) expectApiError(response, 404, "not_found");

    expect(listChat).not.toHaveBeenCalled();
    expect(listMatches).not.toHaveBeenCalled();
    expect(listLeaderboard).not.toHaveBeenCalled();
    expect(getProfile).not.toHaveBeenCalled();
    expect(listTournaments).not.toHaveBeenCalled();
  });

  it("issues a one-time websocket ticket from the guest cookie without database storage", async () => {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const wsBaseUrl = address.replace(/^http/, "ws");
    const login = await app.inject({ method: "POST", url: "/auth/guest" });
    const createTicket = vi.spyOn(repo, "createWsTicket");
    const ticketResponse = await app.inject({
      method: "POST",
      url: "/auth/ws-ticket",
      headers: { cookie: guestCookie(login) }
    });
    expect(ticketResponse.statusCode).toBe(200);
    const { ticket } = ticketResponse.json<{ ticket: string }>();
    expect(createTicket).not.toHaveBeenCalled();

    const accepted = new WebSocket(`${wsBaseUrl}/ws?ticket=${ticket}&v=1`);
    await onceOpen(accepted);
    await expectStillOpen(accepted);
    accepted.close(1000, "test complete");

    const reused = new WebSocket(`${wsBaseUrl}/ws?ticket=${ticket}&v=1`);
    await onceOpen(reused);
    await expectClose(reused, 1008, "invalid websocket ticket");
  });
});

function guestCookie(response: InjectResponse): string {
  return guestCookieHeader(response).split(";", 1)[0];
}

function guestCookieHeader(response: InjectResponse): string {
  const value = response.headers["set-cookie"];
  const header = Array.isArray(value)
    ? value.find((item) => item.startsWith("pp_guest="))
    : typeof value === "string" ? value : undefined;
  if (!header) throw new Error("pp_guest cookie was not set");
  return header;
}

function expectApiError(response: InjectResponse, statusCode: number, code: string): void {
  expect(response.statusCode).toBe(statusCode);
  expect(response.json()).toEqual({
    error: expect.objectContaining({ code, message: expect.any(String), requestId: expect.any(String) })
  });
}

function onceOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function expectStillOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 30);
    socket.once("close", (code, reason) => {
      clearTimeout(timer);
      reject(new Error(`unexpected close: ${code} ${reason.toString("utf8")}`));
    });
  });
}

function expectClose(socket: WebSocket, expectedCode: number, expectedReason: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for close")), 2_000);
    socket.once("close", (code, reason) => {
      clearTimeout(timer);
      try {
        expect({ code, reason: reason.toString("utf8") }).toEqual({
          code: expectedCode,
          reason: expectedReason
        });
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}

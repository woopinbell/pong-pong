import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createMemoryRepository, type AppRepository } from "@pong-pong/db";
import { buildApp } from "./app";
import { createRawWsTicket, hashWsTicket } from "./wsTicket";

type InjectResponse = {
  statusCode: number;
  headers: Record<string, string | string[] | number | undefined>;
  json<T = unknown>(): T;
};

type CloseDetails = {
  code: number;
  reason: string;
};

describe("one-time websocket tickets", () => {
  let repo: AppRepository;
  let app: ReturnType<typeof buildApp>;
  let sockets: WebSocket[];
  let wsBaseUrl: string;

  beforeEach(async () => {
    sockets = [];
    repo = createMemoryRepository();
    await repo.ensureSeedData("development");
    app = buildApp({ repo, webOrigin: "http://localhost:3000", appMode: "test" });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    wsBaseUrl = address.replace(/^http/, "ws");
  });

  afterEach(async () => {
    for (const socket of sockets) {
      if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    }
    await app.close();
    await repo.close();
    vi.restoreAllMocks();
  });

  it("issues a random raw ticket for exactly 30 seconds after cookie authentication", async () => {
    const unauthenticated = await app.inject({ method: "POST", url: "/auth/ws-ticket" });
    expectApiError(unauthenticated, 401, "authentication_required");

    const { cookie, userId } = await login("ticket-issuer");
    const authorizationOnly = await app.inject({
      method: "POST",
      url: "/auth/ws-ticket",
      headers: { authorization: `Bearer ${cookie.slice("pp_session=".length)}` }
    });
    expectApiError(authorizationOnly, 401, "authentication_required");

    const createTicket = vi.spyOn(repo, "createWsTicket");
    const first = await issueTicket(cookie);
    const second = await issueTicket(cookie);

    expect(first).toMatchObject({ expiresInSeconds: 30, protocolVersion: 1 });
    expect(first.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.ticket).not.toBe(first.ticket);
    expect(createTicket).toHaveBeenNthCalledWith(1, {
      userId,
      ticketHash: hashWsTicket(first.ticket),
      ttlSeconds: 30
    });
    expect(createTicket.mock.calls[0]?.[0].ticketHash).not.toBe(first.ticket);
  });

  it("does not issue tickets for suspended users", async () => {
    const { cookie, userId } = await login("suspended-issuer");
    await repo.setUserBan(userId, userId, true, "ws ticket test");

    const response = await app.inject({
      method: "POST",
      url: "/auth/ws-ticket",
      headers: { cookie }
    });

    expectApiError(response, 403, "account_suspended");
  });

  it("accepts a valid ticket once and rejects its reuse", async () => {
    const { cookie } = await login("single-use");
    const { ticket } = await issueTicket(cookie);
    const accepted = await connect(`/ws?ticket=${ticket}&v=1`);
    await expectAccepted(accepted);
    accepted.close(1000, "test complete");

    const reused = await connect(`/ws?ticket=${ticket}&v=1`);
    await expectClose(reused, 1008, "invalid websocket ticket");
  });

  it("rejects forged and expired tickets with the stable authentication close", async () => {
    const { cookie, userId } = await login("invalid-ticket");
    const { ticket } = await issueTicket(cookie);
    const forgedTicket = `${ticket.slice(0, -1)}${ticket.endsWith("A") ? "B" : "A"}`;
    const forged = await connect(`/ws?ticket=${forgedTicket}&v=1`);
    await expectClose(forged, 1008, "invalid websocket ticket");

    const expiredTicket = createRawWsTicket();
    await repo.createWsTicket({
      userId,
      ticketHash: hashWsTicket(expiredTicket),
      ttlSeconds: 0
    });
    const expired = await connect(`/ws?ticket=${expiredTicket}&v=1`);
    await expectClose(expired, 1008, "invalid websocket ticket");
  });

  it("rejects a ticket when its user becomes suspended", async () => {
    const { cookie, userId } = await login("suspended-socket");
    const { ticket } = await issueTicket(cookie);
    await repo.setUserBan(userId, userId, true, "ws connection test");

    const socket = await connect(`/ws?ticket=${ticket}&v=1`);

    await expectClose(socket, 1008, "invalid websocket ticket");
  });

  it("rejects unsupported versions without consuming the ticket", async () => {
    const { cookie } = await login("version-check");
    const { ticket } = await issueTicket(cookie);
    const unsupported = await connect(`/ws?ticket=${ticket}&v=2`);
    await expectClose(unsupported, 1008, "unsupported websocket version");

    const supported = await connect(`/ws?ticket=${ticket}&v=1`);
    await expectAccepted(supported);
    supported.close(1000, "test complete");
  });

  it("does not authenticate a long session through cookie or Authorization", async () => {
    const { cookie } = await login("session-only");
    const sessionToken = cookie.slice("pp_session=".length);

    const socket = await connect(`/ws?v=1&session=${encodeURIComponent(sessionToken)}`, {
      cookie,
      authorization: `Bearer ${sessionToken}`
    });

    await expectClose(socket, 1008, "invalid websocket ticket");
  });

  it("closes on an individual pre-authentication payload above 8 KiB", async () => {
    const { socket, releaseAuthentication } = await connectWithDelayedAuthentication();
    try {
      const closed = closeDetails(socket);
      socket.send(Buffer.alloc(8 * 1024 + 1));
      expect(await closed).toEqual({ code: 1009, reason: "pre-auth payload too large" });
    } finally {
      releaseAuthentication();
    }
  });

  it("allows 16 pre-authentication messages and closes on the seventeenth", async () => {
    const { socket, releaseAuthentication } = await connectWithDelayedAuthentication();
    try {
      for (let index = 0; index < 16; index += 1) socket.send("{}");
      await nextTurn();
      expect(socket.readyState).toBe(WebSocket.OPEN);

      const closed = closeDetails(socket);
      socket.send("{}");
      expect(await closed).toEqual({ code: 1009, reason: "pre-auth buffer limit exceeded" });
    } finally {
      releaseAuthentication();
    }
  });

  it("allows 32 KiB of pre-authentication data and closes above the total limit", async () => {
    const { socket, releaseAuthentication } = await connectWithDelayedAuthentication();
    try {
      for (let index = 0; index < 4; index += 1) socket.send(Buffer.alloc(8 * 1024, 97));
      await nextTurn();
      expect(socket.readyState).toBe(WebSocket.OPEN);

      const closed = closeDetails(socket);
      socket.send("a");
      expect(await closed).toEqual({ code: 1009, reason: "pre-auth buffer limit exceeded" });
    } finally {
      releaseAuthentication();
    }
  });

  async function login(handle: string): Promise<{ cookie: string; userId: string }> {
    const response = await app.inject({
      method: "POST",
      url: "/auth/dev-login",
      payload: { handle, displayName: handle }
    });
    expect(response.statusCode).toBe(200);
    return {
      cookie: sessionCookie(response),
      userId: response.json<{ user: { id: string } }>().user.id
    };
  }

  async function issueTicket(cookie: string): Promise<{
    ticket: string;
    expiresInSeconds: number;
    protocolVersion: number;
  }> {
    const response = await app.inject({
      method: "POST",
      url: "/auth/ws-ticket",
      headers: { cookie }
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  }

  async function connect(path: string, headers: Record<string, string> = {}): Promise<WebSocket> {
    const socket = new WebSocket(`${wsBaseUrl}${path}`, { headers });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    return socket;
  }

  async function connectWithDelayedAuthentication(): Promise<{
    socket: WebSocket;
    releaseAuthentication(): void;
  }> {
    const { cookie } = await login(`buffer-${Math.random().toString(36).slice(2)}`);
    const { ticket } = await issueTicket(cookie);
    const gate = deferred<void>();
    const consumeTicket = repo.consumeWsTicket.bind(repo);
    repo.consumeWsTicket = async (ticketHash) => {
      await gate.promise;
      return consumeTicket(ticketHash);
    };
    const socket = await connect(`/ws?ticket=${ticket}&v=1`);
    return { socket, releaseAuthentication: () => gate.resolve() };
  }
});

function sessionCookie(response: InjectResponse): string {
  const value = response.headers["set-cookie"];
  const header = Array.isArray(value)
    ? value.find((item) => item.startsWith("pp_session="))
    : typeof value === "string" ? value : undefined;
  if (!header) throw new Error("pp_session cookie was not set");
  return header.split(";", 1)[0];
}

function expectApiError(response: InjectResponse, statusCode: number, code: string): void {
  expect(response.statusCode).toBe(statusCode);
  expect(response.json()).toEqual({
    error: expect.objectContaining({
      code,
      message: expect.any(String),
      requestId: expect.any(String)
    })
  });
}

async function expectAccepted(socket: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("close", onClose);
      resolve();
    }, 30);
    const onClose = (code: number, reason: Buffer) => {
      clearTimeout(timer);
      reject(new Error(`WebSocket closed during authentication: ${code} ${reason.toString("utf8")}`));
    };
    socket.once("close", onClose);
  });
  expect(socket.readyState).toBe(WebSocket.OPEN);
}

async function expectClose(socket: WebSocket, code: number, reason: string): Promise<void> {
  await expect(closeDetails(socket)).resolves.toEqual({ code, reason });
}

function closeDetails(socket: WebSocket): Promise<CloseDetails> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("Timed out waiting for WebSocket close"));
    }, 2_000);
    socket.once("close", (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString("utf8") });
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function deferred<T>(): { promise: Promise<T>; resolve(value?: T): void } {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value?: T) {
      resolvePromise(value as T);
    }
  };
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

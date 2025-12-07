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
    // port: 0은 "아무 빈 포트나 OS가 골라서 배정해달라"는 뜻 — 테스트를 병렬로 여러 개 돌려도 포트 충돌이 안 나게
    // 한다. 이 파일은 REST 엔드포인트는 아래 app.inject()(소켓을 실제로 열지 않는 인메모리 요청)로 테스트하지만,
    // WS 업그레이드만큼은 진짜 소켓이 있어야 하므로 여기서만 실제로 listen해서 포트를 확보해둔다.
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
    // app.inject(): Fastify가 제공하는 테스트용 API — 실제 TCP 소켓/포트 없이 라우팅과 핸들러 로직만
    // 인메모리로 실행해 요청/응답을 흉내 낸다. 진짜 HTTP 서버를 띄우는 것보다 훨씬 빠르고, REST 엔드포인트
    // 테스트에는 이걸로 충분하다(WS 업그레이드만 위에서처럼 실제 listen이 필요하다).
    const unauthenticated = await app.inject({ method: "POST", url: "/auth/ws-ticket" });
    expectApiError(unauthenticated, 401, "authentication_required");

    const { cookie, userId } = await login("ticket-issuer");
    const authorizationOnly = await app.inject({
      method: "POST",
      url: "/auth/ws-ticket",
      headers: { authorization: `Bearer ${cookie.slice("pp_session=".length)}` }
    });
    expectApiError(authorizationOnly, 401, "authentication_required");

    // vi.spyOn(객체, "메서드"): vi.fn()과 달리 원래 구현은 그대로 실행하면서(진짜 티켓이 발급된다) 호출
    // 내역만 훔쳐본다 — 동작을 대체하지 않고 "실제로 이 인자로 호출됐는지"만 검증하고 싶을 때 쓴다.
    const createTicket = vi.spyOn(repo, "createWsTicket");
    const first = await issueTicket(cookie);
    const second = await issueTicket(cookie);

    expect(first).toMatchObject({ expiresInSeconds: 30, protocolVersion: 1 });
    expect(first.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.ticket).not.toBe(first.ticket);
    // toHaveBeenNthCalledWith(1, ...): 그냥 "이 인자로 호출된 적이 있다"가 아니라 "정확히 첫 번째 호출이
    // 이 인자였다"까지 확인한다 — 이 테스트에서는 두 번 발급했으므로 순서를 짚어 검증할 필요가 있었다.
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
    // WebSocket close 코드는 RFC로 정해진 표준값들이다: 1000은 "정상 종료", 1008은 "정책 위반"(여기서는
    // 인증 실패를 뭉뚱그려 이 코드로 통일해서, 클라이언트에 "왜 실패했는지" 세세한 단서를 주지 않는다),
    // 1009는 아래에서 나오듯 "메시지가 너무 큼"을 뜻한다.
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

  // 아래 세 테스트는 "인증이 아직 안 끝난(티켓 검증이 진행 중인) 소켓"에 미리 데이터를 퍼붓는 상황을 검증한다 —
  // 티켓 검증은 비동기(DB/메모리 조회)라 그 사이에 클라이언트가 얼마든지 메시지를 보낼 수 있는데, 인증되지
  // 않은 소켓이 서버 메모리를 무제한으로 채우게 두면 안 되므로 개수·용량 상한을 걸어두고 넘으면 끊는다.
  it("closes on an individual pre-authentication payload above 8 KiB", async () => {
    const { socket, releaseAuthentication } = await connectWithDelayedAuthentication();
    try {
      const closed = closeDetails(socket);
      socket.send(Buffer.alloc(8 * 1024 + 1));
      expect(await closed).toEqual({ code: 1009, reason: "" });
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

  it("closes an authenticated socket on a transport payload above 8 KiB", async () => {
    const { cookie } = await login("auth-payload-limit");
    const { ticket } = await issueTicket(cookie);
    const socket = await connect(`/ws?ticket=${ticket}&v=1`);
    await expectAccepted(socket);

    const closed = closeDetails(socket);
    socket.send(Buffer.alloc(8 * 1024 + 1));

    expect(await closed).toEqual({ code: 1009, reason: "" });
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

  // 티켓 검증(repo.consumeWsTicket)이 "누군가 releaseAuthentication()을 부를 때까지" 멈춰 있도록 그 메서드
  // 자체를 가로채 바꿔치기한다 — 실제 네트워크 지연이나 DB 지연을 흉내 내는 대신, 인증이 끝나기 전 짧은 창(window)
  // 동안 소켓에 메시지를 원하는 만큼 밀어넣을 수 있게 테스트가 그 타이밍을 직접 통제하는 트릭이다.
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
  // expect.any(String): "정확히 이 문자열"이 아니라 "String 타입이기만 하면" 통과하는 matcher — message나
  // requestId처럼 매번 값이 달라지는 필드는 타입만 확인하고, code처럼 고정된 값만 정확히 비교한다.
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

// "deferred" 패턴: Promise 생성자 안에서만 쓸 수 있는 resolve 함수를 바깥으로 꺼내와, 프로미스를 만든 시점과
// 완료시키는 시점을 코드 상에서 분리한다 — connectWithDelayedAuthentication처럼 "언제 끝날지"를 테스트가
// 직접 결정해야 할 때 쓰는 표준적인 테스트 유틸리티.
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

// setImmediate: Node 고유의 스케줄링 API로, 현재 이벤트 루프 턴에 이미 쌓여있던 I/O 콜백(여기서는 방금 보낸
// WS 메시지들이 서버에서 처리되는 것)이 다 실행된 뒤에 실행된다. Promise.resolve()로 만드는 마이크로태스크
// 대기보다 한 단계 더 뒤까지 기다리는 셈 — 소켓으로 보낸 메시지가 서버에서 실제로 처리될 시간을 벌어준다.
function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

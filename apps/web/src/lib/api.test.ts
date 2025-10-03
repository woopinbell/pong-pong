import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { okResponseSchema, type PublicUser, type SessionUser } from "@pong-pong/shared";
import {
  ApiError,
  SESSION_EXPIRED_EVENT,
  apiFetch,
  createTournament,
  devLogin,
  getAdminActions,
  getAdminUsers,
  getDashboard,
  getLeaderboard,
  getLobby,
  getMe,
  getProfile,
  getTournaments,
  joinTournament,
  requestFriend,
  requestWsTicket,
  sendLobbyChat,
  setUserStatus
} from "./api";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_ID = "22222222-2222-4222-8222-222222222222";

const publicUser = {
  id: USER_ID,
  handle: "tester",
  displayName: "테스터",
  avatarKey: "avatar-1",
  role: "user",
  status: "active",
  rating: 1_000,
  wins: 3,
  losses: 2,
  online: true,
  isNpc: false
} satisfies PublicUser;

const sessionUser = {
  ...publicUser,
  email: "tester@example.com"
} satisfies SessionUser;

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init
  });
}

describe("apiFetch", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends cookie-authenticated JSON requests without reading or adding a bearer token", async () => {
    const getItem = vi.fn(() => "legacy-token");
    vi.stubGlobal("window", { localStorage: { getItem } });
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    await expect(
      apiFetch("/resource", okResponseSchema, {
        method: "POST",
        headers: { "x-request-source": "web" },
        body: JSON.stringify({ value: 1 })
      })
    ).resolves.toEqual({ ok: true });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(url).toBe("http://localhost:4000/resource");
    expect(init).toMatchObject({ method: "POST", credentials: "include" });
    expect(headers.has("authorization")).toBe(false);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-request-source")).toBe("web");
    expect(getItem).not.toHaveBeenCalled();
  });

  it("preserves an explicit content type", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    await apiFetch("/form", okResponseSchema, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "payload"
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get("content-type")).toBe("text/plain");
  });

  it("rejects a successful response that violates its shared schema", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: false }));

    await expect(apiFetch("/resource", okResponseSchema)).rejects.toMatchObject({ name: "ZodError" });
  });

  it("throws the structured API error returned by the server", async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      error: {
        code: "INVALID_REQUEST",
        message: "입력값을 확인해주세요.",
        requestId: "req-123",
        fieldErrors: { body: ["메시지를 입력해주세요."] }
      }
    }, { status: 400 }));

    const request = apiFetch("/failure", okResponseSchema);

    await expect(request).rejects.toMatchObject({
      name: "ApiError",
      status: 400,
      code: "INVALID_REQUEST",
      message: "입력값을 확인해주세요.",
      requestId: "req-123",
      fieldErrors: { body: ["메시지를 입력해주세요."] }
    });
  });

  it("keeps malformed error responses inside the common ApiError boundary", async () => {
    fetchMock.mockResolvedValue(new Response("gateway failure", {
      status: 502,
      statusText: "Bad Gateway",
      headers: { "x-request-id": "gateway-1" }
    }));

    await expect(apiFetch("/failure", okResponseSchema)).rejects.toEqual(
      expect.objectContaining({
        status: 502,
        code: "HTTP_ERROR",
        message: "Bad Gateway",
        requestId: "gateway-1"
      })
    );
  });

  it("signals cookie expiration after a 401 response", async () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });
    fetchMock.mockResolvedValue(jsonResponse({
      error: {
        code: "UNAUTHORIZED",
        message: "로그인이 필요합니다.",
        requestId: "req-401"
      }
    }, { status: 401 }));

    await expect(apiFetch("/me", okResponseSchema)).rejects.toBeInstanceOf(ApiError);
    expect(dispatchEvent).toHaveBeenCalledOnce();
    expect(dispatchEvent.mock.calls[0][0]).toMatchObject({ type: SESSION_EXPIRED_EVENT });
  });

  it("passes AbortSignal through to fetch and preserves cancellation", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));

    const request = apiFetch("/slow", okResponseSchema, { signal: controller.signal });
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBe(controller.signal);
  });
});

describe("API endpoint helpers", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("logs in from a token-free user envelope", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ user: sessionUser }));

    await expect(devLogin("tester", "테스터")).resolves.toEqual(sessionUser);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:4000/auth/dev-login");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ handle: "tester", displayName: "테스터" }));
    expect(new Headers(init.headers).has("authorization")).toBe(false);
  });

  it("always requests the current cookie session", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ user: sessionUser }));

    await expect(getMe()).resolves.toEqual(sessionUser);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4000/me",
      expect.objectContaining({ credentials: "include" })
    );
  });

  it("returns null only when the current cookie session is unauthorized", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      error: { code: "UNAUTHORIZED", message: "로그인이 필요합니다.", requestId: "req-401" }
    }, { status: 401 }));
    await expect(getMe()).resolves.toBeNull();

    fetchMock.mockResolvedValueOnce(jsonResponse({
      error: { code: "UNAVAILABLE", message: "잠시 후 다시 시도해주세요.", requestId: "req-503" }
    }, { status: 503 }));
    await expect(getMe()).rejects.toMatchObject({ status: 503, code: "UNAVAILABLE" });
  });

  it("requests and validates a one-time websocket ticket", async () => {
    const ticketResponse = {
      ticket: "a".repeat(43),
      expiresInSeconds: 30,
      protocolVersion: 1
    } as const;
    const controller = new AbortController();
    fetchMock.mockResolvedValue(jsonResponse(ticketResponse));

    await expect(requestWsTicket(controller.signal)).resolves.toEqual(ticketResponse);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:4000/auth/ws-ticket");
    expect(init).toMatchObject({ method: "POST", credentials: "include", signal: controller.signal });
  });

  it("extracts endpoint payloads from their validated response envelopes", async () => {
    const leaderboardEntry = { rank: 1, user: publicUser, winRate: 60 };
    const chatMessage = {
      id: ITEM_ID,
      scope: "lobby",
      roomId: null,
      sender: publicUser,
      body: "안녕하세요",
      createdAt: "2026-07-23T00:00:00.000Z"
    };
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ entries: [leaderboardEntry] }))
      .mockResolvedValueOnce(jsonResponse({ message: chatMessage }));

    await expect(getLeaderboard()).resolves.toEqual([leaderboardEntry]);
    await expect(sendLobbyChat("안녕하세요")).resolves.toEqual(chatMessage);

    const [chatUrl, chatInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(chatUrl).toBe("http://localhost:4000/chat/lobby");
    expect(chatInit).toMatchObject({ method: "POST", body: JSON.stringify({ body: "안녕하세요" }) });
  });

  it("forwards cancellation from endpoint helpers", async () => {
    const controller = new AbortController();
    fetchMock.mockResolvedValue(jsonResponse({ entries: [] }));

    await getLeaderboard(controller.signal);

    expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBe(controller.signal);
  });

  it.each([
    { name: "devLogin", call: () => devLogin("tester", "테스터") },
    { name: "getMe", call: () => getMe() },
    { name: "getLobby", call: () => getLobby() },
    { name: "sendLobbyChat", call: () => sendLobbyChat("안녕하세요") },
    { name: "getDashboard", call: () => getDashboard() },
    { name: "getLeaderboard", call: () => getLeaderboard() },
    { name: "getTournaments", call: () => getTournaments() },
    { name: "createTournament", call: () => createTournament("주간 컵") },
    { name: "joinTournament", call: () => joinTournament(ITEM_ID) },
    { name: "getProfile", call: () => getProfile("tester") },
    { name: "requestFriend", call: () => requestFriend("friend") },
    { name: "getAdminUsers", call: () => getAdminUsers() },
    { name: "getAdminActions", call: () => getAdminActions() },
    { name: "setUserStatus", call: () => setUserStatus(USER_ID, "banned", "검토") },
    { name: "requestWsTicket", call: () => requestWsTicket() }
  ])("validates $name responses with its shared schema", async ({ call }) => {
    fetchMock.mockResolvedValue(jsonResponse({}));

    await expect(call()).rejects.toMatchObject({ name: "ZodError" });
  });
});

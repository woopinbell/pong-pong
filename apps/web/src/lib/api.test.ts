import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@pong-pong/shared";
import {
  apiFetch,
  clearToken,
  devLogin,
  getLeaderboard,
  getMe,
  getToken,
  sendLobbyChat,
  setToken
} from "./api";

const sessionUser = {
  id: "user-1",
  handle: "tester",
  displayName: "테스터",
  avatarKey: "avatar-1",
  role: "user",
  status: "active",
  rating: 1_000,
  wins: 3,
  losses: 2,
  online: true,
  isNpc: false,
  email: "tester@example.com"
} satisfies SessionUser;

function createStorage(): Storage {
  const values = new Map<string, string>();

  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, value);
    }
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init
  });
}

describe("token storage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns null when rendered without a browser window", () => {
    expect(getToken()).toBeNull();
  });

  it("stores, reads, and clears the browser token", () => {
    vi.stubGlobal("window", { localStorage: createStorage() });

    setToken("session-token");
    expect(getToken()).toBe("session-token");

    clearToken();
    expect(getToken()).toBeNull();
  });
});

describe("apiFetch", () => {
  let storage: Storage;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    storage = createStorage();
    fetchMock = vi.fn();
    vi.stubGlobal("window", { localStorage: storage });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends authenticated JSON requests with browser credentials", async () => {
    storage.setItem("pong-pong-token", "session-token");
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    await expect(
      apiFetch<{ ok: boolean }>("/resource", {
        method: "POST",
        headers: { "x-request-source": "web" },
        body: JSON.stringify({ value: 1 })
      })
    ).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(url).toBe("http://localhost:4000/resource");
    expect(init).toMatchObject({ method: "POST", credentials: "include" });
    expect(headers.get("authorization")).toBe("Bearer session-token");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-request-source")).toBe("web");
  });

  it("does not add authentication or content type to a public GET request", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    await apiFetch("/public");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(init.credentials).toBe("include");
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("content-type")).toBe(false);
  });

  it("preserves an explicit content type", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    await apiFetch("/form", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "payload"
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get("content-type")).toBe("text/plain");
  });

  it("throws the response body for a failed request", async () => {
    fetchMock.mockResolvedValue(new Response("요청이 거절되었습니다.", { status: 403 }));

    await expect(apiFetch("/forbidden")).rejects.toThrow("요청이 거절되었습니다.");
  });

  it("uses the fallback message when a failed response has no body", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 500 }));

    await expect(apiFetch("/failure")).rejects.toThrow("요청을 처리하지 못했습니다.");
  });

  it("clears the stored token after an unauthorized response", async () => {
    storage.setItem("pong-pong-token", "expired-token");
    fetchMock.mockResolvedValue(new Response("인증이 만료되었습니다.", { status: 401 }));

    await expect(apiFetch("/me")).rejects.toThrow("인증이 만료되었습니다.");
    expect(storage.getItem("pong-pong-token")).toBeNull();
  });
});

describe("API endpoint helpers", () => {
  let storage: Storage;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    storage = createStorage();
    fetchMock = vi.fn();
    vi.stubGlobal("window", { localStorage: storage });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("logs in with the current request shape and stores the returned token", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ user: sessionUser, token: "new-token" }));

    await expect(devLogin("tester", "테스터")).resolves.toEqual(sessionUser);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:4000/auth/dev-login");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ handle: "tester", displayName: "테스터" }));
    expect(storage.getItem("pong-pong-token")).toBe("new-token");
  });

  it("does not request the current user without a stored token", async () => {
    await expect(getMe()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the current user for a valid stored token", async () => {
    storage.setItem("pong-pong-token", "session-token");
    fetchMock.mockResolvedValue(jsonResponse({ user: sessionUser }));

    await expect(getMe()).resolves.toEqual(sessionUser);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4000/me",
      expect.objectContaining({ credentials: "include" })
    );
  });

  it("returns null when the current-user request fails", async () => {
    storage.setItem("pong-pong-token", "expired-token");
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));

    await expect(getMe()).resolves.toBeNull();
  });

  it("extracts endpoint payloads from their response envelopes", async () => {
    const leaderboardEntry = {
      rank: 1,
      user: sessionUser,
      winRate: 60
    };
    const chatMessage = {
      id: "message-1",
      scope: "lobby",
      roomId: null,
      sender: sessionUser,
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
});

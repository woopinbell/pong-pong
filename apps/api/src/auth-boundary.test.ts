import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryRepository, type AppRepository } from "@pong-pong/db";
import { buildApp } from "./app";

describe("authentication boundary", () => {
  let repo: AppRepository;
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    repo = createMemoryRepository();
    await repo.ensureSeedData("development");
    app = buildApp({ repo, webOrigin: "http://localhost:3000" });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await repo.close();
  });

  it("returns the session only through an httpOnly cookie", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/auth/dev-login",
      payload: { handle: "cookie-user", displayName: "쿠키 사용자" }
    });

    expect(login.statusCode).toBe(200);
    expect(login.json<Record<string, unknown>>()).toEqual({
      user: expect.objectContaining({ handle: "cookie-user", role: "user" })
    });
    const setCookie = sessionCookieHeader(login);
    expect(setCookie.toLowerCase()).toContain("httponly");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("SameSite=Lax");

    const me = await app.inject({
      method: "GET",
      url: "/me",
      headers: { cookie: setCookie.split(";", 1)[0] }
    });
    expect(me.statusCode).toBe(200);
  });

  it("does not authenticate Authorization headers or session query parameters", async () => {
    const user = await repo.upsertDevUser({ handle: "boundary-user", displayName: "인증 경계" });
    const token = await repo.createSession(user.id);

    const cookieResponse = await app.inject({
      method: "GET",
      url: "/me",
      headers: { cookie: `pp_session=${token}` }
    });
    const authorizationResponse = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${token}` }
    });
    const queryResponse = await app.inject({
      method: "GET",
      url: `/me?session=${encodeURIComponent(token)}`
    });

    expect(cookieResponse.statusCode).toBe(200);
    expectApiError(authorizationResponse, 401);
    expectApiError(queryResponse, 401);
  });

  it("does not grant administrator privileges from the dev-login handle", async () => {
    const isolatedRepo = createMemoryRepository();
    await isolatedRepo.ensureSeedData("demo");
    const isolatedApp = buildApp({ repo: isolatedRepo, webOrigin: "http://localhost:3000" });
    await isolatedApp.ready();

    try {
      const login = await isolatedApp.inject({
        method: "POST",
        url: "/auth/dev-login",
        payload: { handle: "admin", displayName: "일반 사용자" }
      });

      expect(login.statusCode).toBe(200);
      expect(login.json<{ user: { role: string } }>().user.role).toBe("user");
      const adminRoute = await isolatedApp.inject({
        method: "GET",
        url: "/admin/actions",
        headers: { cookie: sessionCookie(login) }
      });
      expectApiError(adminRoute, 403);
    } finally {
      await isolatedApp.close();
      await isolatedRepo.close();
    }
  });

  it("uses the standard error envelope for 400, 401, 403, and 404 responses", async () => {
    const user = await repo.upsertDevUser({ handle: "error-user", displayName: "오류 사용자" });
    const cookie = `pp_session=${await repo.createSession(user.id)}`;
    const responses = await Promise.all([
      app.inject({ method: "POST", url: "/chat/lobby", headers: { cookie }, payload: { body: "   " } }),
      app.inject({ method: "GET", url: "/me" }),
      app.inject({ method: "GET", url: "/admin/actions", headers: { cookie } }),
      app.inject({ method: "GET", url: "/missing-route" })
    ]);

    for (const [index, statusCode] of [400, 401, 403, 404].entries()) {
      expectApiError(responses[index], statusCode);
    }
  });
});

describe("dev-login availability", () => {
  it.each([
    { appMode: "production" as const },
    { appMode: "demo" as const }
  ])("does not expose dev-login in the $appMode runtime", async ({ appMode }) => {
    const repo = createMemoryRepository();
    await repo.ensureSeedData(appMode === "demo" ? "demo" : "development");
    const app = buildApp({ repo, webOrigin: "http://localhost:3000", appMode });
    await app.ready();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/auth/dev-login",
        payload: { handle: "hidden-user", displayName: "숨김 사용자" }
      });

      expectApiError(response, 404);
    } finally {
      await app.close();
      await repo.close();
    }
  });
});

type InjectResponse = {
  statusCode: number;
  headers: Record<string, string | string[] | number | undefined>;
  json<T = unknown>(): T;
};

function sessionCookieHeader(response: InjectResponse): string {
  const value = response.headers["set-cookie"];
  const header = Array.isArray(value)
    ? value.find((item) => item.startsWith("pp_session="))
    : typeof value === "string" ? value : undefined;
  if (!header) throw new Error("pp_session cookie was not set");
  return header;
}

function sessionCookie(response: InjectResponse): string {
  return sessionCookieHeader(response).split(";", 1)[0];
}

function expectApiError(response: InjectResponse, statusCode: number): void {
  expect(response.statusCode).toBe(statusCode);
  const payload = response.json<{
    error: {
      code: string;
      message: string;
      requestId: string;
      fieldErrors?: Record<string, unknown>;
    };
  }>();
  expect(payload).toEqual({
    error: expect.objectContaining({
      code: expect.any(String),
      message: expect.any(String),
      requestId: expect.any(String)
    })
  });
  expect(payload.error.code.length).toBeGreaterThan(0);
  expect(payload.error.message.length).toBeGreaterThan(0);
  expect(payload.error.requestId.length).toBeGreaterThan(0);
  if (payload.error.fieldErrors !== undefined) {
    expect(payload.error.fieldErrors).toEqual(expect.any(Object));
  }
}

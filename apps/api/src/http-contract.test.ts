import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apiErrorBodySchema, jsonHttpRequestContracts } from "@pong-pong/shared";
import { createMemoryRepository, type AppRepository } from "@pong-pong/db";
import { buildApp } from "./app";

type JsonRouteCase = {
  method: "GET" | "POST" | "PATCH";
  url: string;
  payload?: Record<string, unknown>;
};

const userId = "018f4af4-3223-7a17-a0c1-2f4f2404d8ef";

const jsonRoutes: JsonRouteCase[] = [
  { method: "GET", url: "/health" },
  { method: "GET", url: "/health/live" },
  { method: "GET", url: "/health/ready" },
  {
    method: "POST",
    url: "/auth/dev-login",
    payload: { handle: "contract-user", displayName: "계약 사용자" }
  },
  { method: "POST", url: "/auth/logout" },
  { method: "POST", url: "/auth/ws-ticket" },
  { method: "GET", url: "/me" },
  { method: "GET", url: "/auth/me" },
  { method: "GET", url: `/users/${userId}` },
  { method: "GET", url: "/lobby" },
  { method: "POST", url: "/chat/lobby", payload: { body: "계약 검사" } },
  { method: "GET", url: "/leaderboard" },
  { method: "GET", url: "/dashboard" },
  { method: "GET", url: "/profile/contract-user" },
  { method: "GET", url: "/profile/me" },
  { method: "PATCH", url: "/profile/me", payload: { displayName: "새 이름" } },
  { method: "GET", url: "/friends" },
  { method: "POST", url: "/friends/request", payload: { handle: "opponent" } },
  { method: "POST", url: "/friends", payload: { handle: "opponent" } },
  { method: "POST", url: `/friends/${userId}/accept` },
  { method: "GET", url: "/tournaments" },
  { method: "POST", url: "/tournaments", payload: { name: "계약 대회" } },
  { method: "POST", url: `/tournaments/${userId}/join` },
  { method: "GET", url: "/admin/users" },
  { method: "GET", url: "/admin/actions" },
  { method: "POST", url: `/admin/users/${userId}/ban` },
  {
    method: "PATCH",
    url: `/admin/users/${userId}/status`,
    payload: { status: "banned" }
  }
];

const jsonBodyRoutes: JsonRouteCase[] = [
  {
    method: "POST",
    url: "/auth/dev-login",
    payload: { handle: "contract-user", displayName: "계약 사용자" }
  },
  { method: "POST", url: "/auth/logout", payload: {} },
  { method: "POST", url: "/auth/ws-ticket", payload: {} },
  { method: "POST", url: "/chat/lobby", payload: { body: "계약 검사" } },
  { method: "PATCH", url: "/profile/me", payload: { displayName: "새 이름" } },
  { method: "POST", url: "/friends/request", payload: { handle: "opponent" } },
  { method: "POST", url: "/friends", payload: { handle: "opponent" } },
  { method: "POST", url: `/friends/${userId}/accept`, payload: {} },
  { method: "POST", url: "/tournaments", payload: { name: "계약 대회" } },
  { method: "POST", url: `/tournaments/${userId}/join`, payload: {} },
  { method: "POST", url: `/admin/users/${userId}/ban`, payload: {} },
  {
    method: "PATCH",
    url: `/admin/users/${userId}/status`,
    payload: { status: "banned" }
  }
];

describe("JSON HTTP request contracts", () => {
  let repo: AppRepository;
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    repo = createMemoryRepository();
    await repo.ensureSeedData();
    app = buildApp({ repo, webOrigin: "http://localhost:3000", appMode: "test" });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await repo.close();
  });

  it.each(jsonRoutes)(
    "$method $url rejects an unknown query field with the shared error envelope",
    async ({ method, url, payload }) => {
      const response = await app.inject({
        method,
        url: `${url}?unexpected=1`,
        ...(payload ? { payload } : {})
      });

      expectValidationError(response);
    }
  );

  it.each(jsonBodyRoutes)(
    "$method $url rejects an unknown body field with the shared error envelope",
    async ({ method, url, payload = {} }) => {
      const response = await app.inject({
        method,
        url,
        payload: { ...payload, unexpected: true }
      });

      expectValidationError(response);
    }
  );

  it("keeps an explicit strict body contract for a bodyless JSON GET route", () => {
    expect(jsonHttpRequestContracts.leaderboard.body.safeParse({ unexpected: true }).success)
      .toBe(false);
  });

  it.each([
    { method: "GET" as const, url: "/users/not-a-uuid" },
    { method: "GET" as const, url: `/profile/${"a".repeat(65)}` },
    { method: "POST" as const, url: "/friends/not-a-uuid/accept" },
    { method: "POST" as const, url: "/tournaments/not-a-uuid/join" },
    { method: "POST" as const, url: "/admin/users/not-a-uuid/ban" },
    {
      method: "PATCH" as const,
      url: "/admin/users/not-a-uuid/status",
      payload: { status: "banned" }
    }
  ])("$method $url validates path parameters before route work", async ({ method, url, payload }) => {
    const response = await app.inject({
      method,
      url,
      ...(payload ? { payload } : {})
    });

    expectValidationError(response);
  });

  it("keeps the demo guest body and query contracts strict", async () => {
    await app.close();
    await repo.close();

    repo = createMemoryRepository();
    app = buildApp({
      repo,
      webOrigin: "http://localhost:3000",
      appMode: "demo",
      sessionSecret: "guest-contract-session-secret-32-bytes"
    });
    await app.ready();

    const bodyResponse = await app.inject({
      method: "POST",
      url: "/auth/guest",
      payload: { unexpected: true }
    });
    const queryResponse = await app.inject({
      method: "POST",
      url: "/auth/guest?unexpected=1"
    });

    expectValidationError(bodyResponse);
    expectValidationError(queryResponse);
  });
});

function expectValidationError(response: {
  statusCode: number;
  json<T>(): T;
}): void {
  expect(response.statusCode).toBe(400);
  const body = apiErrorBodySchema.parse(response.json());
  expect(body.error.code).toBe("validation_error");
  expect(body.error.requestId).not.toHaveLength(0);
  expect(body.error.fieldErrors).toBeDefined();
}

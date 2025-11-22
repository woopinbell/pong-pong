import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryRepository, type AppRepository } from "@pong-pong/db";
import { buildApp } from "./app";

describe("admin routes", () => {
  let repo: AppRepository;
  let app: ReturnType<typeof buildApp>;
  let adminCookie: string;

  beforeEach(async () => {
    repo = createMemoryRepository();
    await repo.ensureSeedData("development");
    const admin = await repo.getUserByHandle("admin");
    if (!admin) throw new Error("seed:dev admin was not created");
    adminCookie = `pp_session=${await repo.createSession(admin.id)}`;
    app = buildApp({ repo, webOrigin: "http://localhost:3000" });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await repo.close();
  });

  it("allows an admin to toggle a user status", async () => {
    const targetLogin = await app.inject({
      method: "POST",
      url: "/auth/dev-login",
      payload: { handle: "target", displayName: "대상" }
    });

    const targetId = targetLogin.json<{ user: { id: string } }>().user.id;
    const ban = await app.inject({
      method: "POST",
      url: `/admin/users/${targetId}/ban`,
      headers: { cookie: adminCookie },
      payload: { banned: true, reason: "smoke" }
    });
    const actions = await app.inject({
      method: "GET",
      url: "/admin/actions",
      headers: { cookie: adminCookie }
    });
    const blockedChat = await app.inject({
      method: "POST",
      url: "/chat/lobby",
      headers: { cookie: sessionCookie(targetLogin) },
      payload: { body: "정지 후 채팅" }
    });

    expect(ban.statusCode).toBe(200);
    expect(ban.json<{ user: { status: string } }>().user.status).toBe("banned");
    expect(actions.json<{ actions: Array<{ reason: string }> }>().actions[0].reason).toBe("smoke");
    expect(blockedChat.statusCode).toBe(403);
  });

  it("rejects an existing administrator session after the account is banned", async () => {
    const admin = await repo.getUserByHandle("admin");
    if (!admin) throw new Error("seed:dev admin was not created");
    await repo.setUserBan(admin.id, admin.id, true, "운영자 계정 정지 검사");

    const actions = await app.inject({
      method: "GET",
      url: "/admin/actions",
      headers: { cookie: adminCookie }
    });

    expect(actions.statusCode).toBe(403);
    expect(actions.json()).toEqual({
      error: expect.objectContaining({
        code: "account_suspended",
        message: expect.any(String),
        requestId: expect.any(String)
      })
    });
  });
});

function sessionCookie(response: { headers: Record<string, string | string[] | number | undefined> }): string {
  const value = response.headers["set-cookie"];
  const header = Array.isArray(value)
    ? value.find((item) => item.startsWith("pp_session="))
    : typeof value === "string" ? value : undefined;
  if (!header) throw new Error("pp_session cookie was not set");
  return header.split(";", 1)[0];
}

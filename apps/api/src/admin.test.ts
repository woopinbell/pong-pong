import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryRepository, type AppRepository } from "@pong-pong/db";
import { buildApp } from "./app";

describe("admin routes", () => {
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

  it("allows an admin to toggle a user status", async () => {
    const adminLogin = await app.inject({
      method: "POST",
      url: "/auth/dev-login",
      payload: { handle: "admin", displayName: "운영자" }
    });
    const targetLogin = await app.inject({
      method: "POST",
      url: "/auth/dev-login",
      payload: { handle: "target", displayName: "대상" }
    });

    const adminToken = adminLogin.json<{ token: string }>().token;
    const targetId = targetLogin.json<{ user: { id: string } }>().user.id;
    const ban = await app.inject({
      method: "POST",
      url: `/admin/users/${targetId}/ban`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { banned: true, reason: "smoke" }
    });
    const actions = await app.inject({
      method: "GET",
      url: "/admin/actions",
      headers: { authorization: `Bearer ${adminToken}` }
    });
    const blockedChat = await app.inject({
      method: "POST",
      url: "/chat/lobby",
      headers: { authorization: `Bearer ${targetLogin.json<{ token: string }>().token}` },
      payload: { body: "정지 후 채팅" }
    });

    expect(ban.statusCode).toBe(200);
    expect(ban.json<{ user: { status: string } }>().user.status).toBe("banned");
    expect(actions.json<{ actions: Array<{ reason: string }> }>().actions[0].reason).toBe("smoke");
    expect(blockedChat.statusCode).toBe(403);
  });
});

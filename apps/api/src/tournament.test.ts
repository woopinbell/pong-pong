import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryRepository, type AppRepository } from "@pong-pong/db";
import { buildApp } from "./app";

describe("tournament routes", () => {
  let repo: AppRepository;
  let app: ReturnType<typeof buildApp>;
  let token: string;

  beforeEach(async () => {
    repo = createMemoryRepository();
    await repo.ensureSeedData();
    app = buildApp({ repo, webOrigin: "http://localhost:3000" });
    await app.ready();
    const login = await app.inject({
      method: "POST",
      url: "/auth/dev-login",
      payload: { handle: "cup", displayName: "컵참가자" }
    });
    token = login.json<{ token: string }>().token;
  });

  afterEach(async () => {
    await app.close();
    await repo.close();
  });

  it("creates a cup and lists it back", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/tournaments",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "목요일 컵" }
    });
    const listed = await app.inject({ method: "GET", url: "/tournaments" });

    expect(created.statusCode).toBe(200);
    expect(listed.json<{ tournaments: Array<{ name: string }> }>().tournaments[0].name).toBe("목요일 컵");
  });
});

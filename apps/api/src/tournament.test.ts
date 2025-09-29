import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryRepository, type AppRepository } from "@pong-pong/db";
import { buildApp } from "./app";

describe("tournament routes", () => {
  let repo: AppRepository;
  let app: ReturnType<typeof buildApp>;
  let cookie: string;

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
    cookie = sessionCookie(login);
  });

  afterEach(async () => {
    await app.close();
    await repo.close();
  });

  it("creates a cup and lists it back", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/tournaments",
      headers: { cookie },
      payload: { name: "목요일 컵" }
    });
    const listed = await app.inject({ method: "GET", url: "/tournaments" });

    expect(created.statusCode).toBe(200);
    expect(listed.json<{ tournaments: Array<{ name: string }> }>().tournaments[0].name).toBe("목요일 컵");
  });

  it("creates semifinal matches when a cup fills", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/tournaments",
      headers: { cookie },
      payload: { name: "브래킷 컵" }
    });
    const tournamentId = created.json<{ tournament: { id: string } }>().tournament.id;
    for (const handle of ["cup-two", "cup-three", "cup-four"]) {
      const login = await app.inject({
        method: "POST",
        url: "/auth/dev-login",
        payload: { handle, displayName: handle }
      });
      await app.inject({
        method: "POST",
        url: `/tournaments/${tournamentId}/join`,
        headers: { cookie: sessionCookie(login) }
      });
    }
    const listed = await app.inject({ method: "GET", url: "/tournaments" });
    const cup = listed.json<{ tournaments: Array<{ id: string; status: string; matches: Array<{ round: string; status: string }> }> }>().tournaments.find((item) => item.id === tournamentId);

    expect(cup?.status).toBe("running");
    expect(cup?.matches.filter((match) => match.round === "semifinal")).toHaveLength(2);
    expect(cup?.matches.every((match) => match.status === "ready")).toBe(true);
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

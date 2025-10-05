import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createMemoryRepository } from "./index";

describe("memory repository", () => {
  it("seeds rating-banded npc opponents separately from players", async () => {
    const repo = createMemoryRepository();
    await repo.ensureSeedData();

    const npcs = await repo.listNpcOpponents();

    expect(npcs.map((npc) => npc.rating)).toEqual([1100, 1200, 1300, 1400]);
    expect(npcs.every((npc) => npc.isNpc)).toBe(true);
    expect(npcs.every((npc) => npc.online === false)).toBe(true);
  });

  it("creates sessions and keeps match results in the dashboard", async () => {
    const repo = createMemoryRepository();
    await repo.ensureSeedData();
    const left = await repo.upsertDevUser({ handle: "left", displayName: "왼쪽" });
    const right = await repo.upsertDevUser({ handle: "right", displayName: "오른쪽" });
    const token = await repo.createSession(left.id);
    await repo.createMatch({ mode: "queue", winnerId: left.id, loserId: right.id, scoreLeft: 3, scoreRight: 1 });
    await repo.createMatch({ mode: "ai", winnerId: left.id, loserId: null, scoreLeft: 3, scoreRight: 0 });

    const session = await repo.getSessionUser(token);
    const dashboard = await repo.getDashboard(left.id);

    expect(session?.handle).toBe("left");
    expect(dashboard.recentMatches[0].result).toBe("win");
    expect(dashboard.recentMatches.map((match) => match.mode)).toEqual(["ai", "queue"]);
    expect(dashboard.me.wins).toBe(2);
    expect(dashboard.me.rating).toBe(left.rating + 32);
  });

  it("derives the best streak from recent match results", async () => {
    const repo = createMemoryRepository();
    await repo.ensureSeedData();
    const me = await repo.upsertDevUser({ handle: "streaker", displayName: "연승선수" });
    const rival = await repo.upsertDevUser({ handle: "streak-rival", displayName: "라이벌" });
    await repo.createMatch({ mode: "queue", winnerId: me.id, loserId: rival.id, scoreLeft: 3, scoreRight: 1 });
    await repo.createMatch({ mode: "queue", winnerId: rival.id, loserId: me.id, scoreLeft: 3, scoreRight: 2 });
    await repo.createMatch({ mode: "ai", winnerId: me.id, loserId: null, scoreLeft: 3, scoreRight: 0 });
    await repo.createMatch({ mode: "queue", winnerId: me.id, loserId: rival.id, scoreLeft: 3, scoreRight: 2 });

    const dashboard = await repo.getDashboard(me.id);

    expect(dashboard.recentMatches.map((match) => match.result)).toEqual(["win", "win", "loss", "win"]);
    expect(dashboard.bestStreak).toBe(2);
  });

  it("stores lobby and match chat with sender details", async () => {
    const repo = createMemoryRepository();
    await repo.ensureSeedData();
    const user = await repo.upsertDevUser({ handle: "speaker", displayName: "말하는선수" });

    const lobby = await repo.createChatMessage({ scope: "lobby", senderId: user.id, body: "로비 메시지" });
    const match = await repo.createChatMessage({ scope: "match", roomId: "room-1", senderId: user.id, body: "매치 메시지" });

    expect(lobby.sender.handle).toBe("speaker");
    expect(match.roomId).toBe("room-1");
    expect((await repo.listLobbyChat()).map((message) => message.body)).toContain("로비 메시지");
  });

  it("tracks friend requests and tournament entries", async () => {
    const repo = createMemoryRepository();
    await repo.ensureSeedData();
    const me = await repo.upsertDevUser({ handle: "me", displayName: "나" });
    const p2 = await repo.upsertDevUser({ handle: "p2", displayName: "둘" });
    const p3 = await repo.upsertDevUser({ handle: "p3", displayName: "셋" });
    const p4 = await repo.upsertDevUser({ handle: "p4", displayName: "넷" });
    const friend = await repo.requestFriend(me.id, "spin-doctor");
    const tournament = await repo.createTournament({ name: "테스트 컵", createdBy: me.id });
    await repo.joinTournament(tournament.id, p2.id);
    await repo.joinTournament(tournament.id, p3.id);
    const full = await repo.joinTournament(tournament.id, p4.id);
    const [semiA, semiB] = full.matches.filter((match) => match.round === "semifinal");
    const semiMatchA = await repo.createMatch({ mode: "tournament", winnerId: me.id, loserId: p4.id, scoreLeft: 3, scoreRight: 1 });
    const semiMatchB = await repo.createMatch({ mode: "tournament", winnerId: p2.id, loserId: p3.id, scoreLeft: 3, scoreRight: 2 });
    await repo.completeTournamentMatch({ tournamentMatchId: semiA.id, roomId: "room-a", matchId: semiMatchA, winnerId: me.id, scoreLeft: 3, scoreRight: 1 });
    const withFinal = await repo.completeTournamentMatch({ tournamentMatchId: semiB.id, roomId: "room-b", matchId: semiMatchB, winnerId: p2.id, scoreLeft: 3, scoreRight: 2 });
    const final = withFinal.matches.find((match) => match.round === "final");

    expect(friend.status).toBe("pending");
    expect(full.playerCount).toBe(4);
    expect(full.matches.filter((match) => match.round === "semifinal")).toHaveLength(2);
    expect(final?.left?.id).toBe(me.id);
    expect(final?.right?.id).toBe(p2.id);
    expect((await repo.listTournaments())[0].name).toBe("테스트 컵");
  });

  it("consumes websocket tickets once and rejects expired or suspended users", async () => {
    const repo = createMemoryRepository();
    const user = await repo.upsertDevUser({ handle: "ws-user", displayName: "WS 사용자" });
    const ticketHash = newTicketHash();
    await repo.createWsTicket({ userId: user.id, ticketHash, ttlSeconds: 30 });

    const attempts = await Promise.all([
      repo.consumeWsTicket(ticketHash),
      repo.consumeWsTicket(ticketHash)
    ]);
    expect(attempts.filter((result) => result !== null)).toHaveLength(1);
    await expect(repo.consumeWsTicket(ticketHash)).resolves.toBeNull();

    const expiredHash = newTicketHash();
    await repo.createWsTicket({ userId: user.id, ticketHash: expiredHash, ttlSeconds: 0 });
    await expect(repo.consumeWsTicket(expiredHash)).resolves.toBeNull();

    const suspendedHash = newTicketHash();
    await repo.createWsTicket({ userId: user.id, ticketHash: suspendedHash, ttlSeconds: 30 });
    await repo.setUserBan(user.id, user.id, true, "ticket test");
    await expect(repo.consumeWsTicket(suspendedHash)).resolves.toBeNull();
  });
});

function newTicketHash(): string {
  const rawTicket = randomBytes(32).toString("base64url");
  return createHash("sha256").update(rawTicket, "utf8").digest("hex");
}

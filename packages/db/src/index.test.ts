import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createMemoryRepository } from "./index";

describe("memory repository", () => {
  it("exposes tournament completion only through finalizeMatch", () => {
    const repo = createMemoryRepository();

    expect(repo).toHaveProperty("finalizeMatch");
    expect(repo).not.toHaveProperty("completeTournamentMatch");
  });

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

  it("finalizes the same match result once when commands are repeated", async () => {
    const repo = createMemoryRepository();
    const winner = await repo.upsertDevUser({ handle: "winner", displayName: "승자" });
    const loser = await repo.upsertDevUser({ handle: "loser", displayName: "패자" });
    const command = {
      resultKey: "room:memory-finalize:finished",
      mode: "queue" as const,
      winnerId: winner.id,
      loserId: loser.id,
      scoreLeft: 3,
      scoreRight: 1
    };

    const results = await Promise.all(
      Array.from({ length: 20 }, () => repo.finalizeMatch(command))
    );
    const dashboard = await repo.getDashboard(winner.id);
    const updatedLoser = await repo.getUserById(loser.id);

    expect(new Set(results.map((result) => result.matchId)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(dashboard.recentMatches).toHaveLength(1);
    expect(dashboard.me.wins).toBe(1);
    expect(dashboard.me.rating).toBe(winner.rating + 16);
    expect(updatedLoser?.losses).toBe(1);
    expect(updatedLoser?.rating).toBe(loser.rating - 12);
  });

  it("links concurrent semifinal results and creates one final", async () => {
    const repo = createMemoryRepository();
    const players = await Promise.all(
      ["semi-one", "semi-two", "semi-three", "semi-four"].map((handle, index) =>
        repo.upsertDevUser({ handle, displayName: `선수 ${index + 1}` })
      )
    );
    const tournament = await repo.createTournament({
      name: "동시 종료 컵",
      createdBy: players[0].id
    });
    await repo.joinTournament(tournament.id, players[1].id);
    await repo.joinTournament(tournament.id, players[2].id);
    const ready = await repo.joinTournament(tournament.id, players[3].id);
    const [semiA, semiB] = ready.matches.filter((match) => match.round === "semifinal");

    await Promise.all([
      repo.finalizeMatch({
        resultKey: "room:memory-semi-a:finished",
        mode: "tournament",
        winnerId: semiA.left?.id ?? null,
        loserId: semiA.right?.id ?? null,
        scoreLeft: 3,
        scoreRight: 1,
        tournament: { tournamentMatchId: semiA.id, roomId: "memory-semi-a" }
      }),
      repo.finalizeMatch({
        resultKey: "room:memory-semi-b:finished",
        mode: "tournament",
        winnerId: semiB.left?.id ?? null,
        loserId: semiB.right?.id ?? null,
        scoreLeft: 3,
        scoreRight: 2,
        tournament: { tournamentMatchId: semiB.id, roomId: "memory-semi-b" }
      })
    ]);

    const completed = (await repo.listTournaments()).find((item) => item.id === tournament.id);
    const finalMatches = completed?.matches.filter((match) => match.round === "final") ?? [];

    expect(finalMatches).toHaveLength(1);
    expect(finalMatches[0].left?.id).toBe(semiA.left?.id);
    expect(finalMatches[0].right?.id).toBe(semiB.left?.id);
    expect(completed?.matches.filter((match) => match.round === "semifinal" && match.matchId)).toHaveLength(2);
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
    await repo.finalizeMatch({
      resultKey: "room:room-a:finished",
      mode: "tournament",
      winnerId: me.id,
      loserId: p4.id,
      scoreLeft: 3,
      scoreRight: 1,
      tournament: { tournamentMatchId: semiA.id, roomId: "room-a" }
    });
    await repo.finalizeMatch({
      resultKey: "room:room-b:finished",
      mode: "tournament",
      winnerId: p2.id,
      loserId: p3.id,
      scoreLeft: 3,
      scoreRight: 2,
      tournament: { tournamentMatchId: semiB.id, roomId: "room-b" }
    });
    const withFinal = (await repo.listTournaments()).find((item) => item.id === tournament.id);
    const final = withFinal?.matches.find((match) => match.round === "final");

    expect(friend.status).toBe("pending");
    expect(full.playerCount).toBe(4);
    expect(full.matches.filter((match) => match.round === "semifinal")).toHaveLength(2);
    expect(withFinal).toBeDefined();
    expect(final?.left?.id).toBe(me.id);
    expect(final?.right?.id).toBe(p2.id);
    expect((await repo.listTournaments())[0].name).toBe("테스트 컵");
  });

  it("keeps one friendship for both request directions", async () => {
    const repo = createMemoryRepository();
    const firstUser = await repo.upsertDevUser({ handle: "friend-first", displayName: "첫 번째 사용자" });
    const secondUser = await repo.upsertDevUser({ handle: "friend-second", displayName: "두 번째 사용자" });

    await expect(repo.requestFriend(firstUser.id, firstUser.handle)).rejects.toThrow("cannot friend yourself");

    const firstRequest = await repo.requestFriend(firstUser.id, secondUser.handle);
    const repeatedRequest = await repo.requestFriend(firstUser.id, secondUser.handle);
    const reverseRequest = await repo.requestFriend(secondUser.id, firstUser.handle);

    expect(firstRequest.status).toBe("pending");
    expect(repeatedRequest).toEqual(firstRequest);
    expect(reverseRequest.id).toBe(firstRequest.id);
    expect(reverseRequest.status).toBe("accepted");
    expect(reverseRequest.user.id).toBe(firstUser.id);
    await expect(repo.listFriends(firstUser.id)).resolves.toEqual([
      expect.objectContaining({ id: firstRequest.id, status: "accepted", user: expect.objectContaining({ id: secondUser.id }) })
    ]);
    await expect(repo.listFriends(secondUser.id)).resolves.toEqual([
      expect.objectContaining({ id: firstRequest.id, status: "accepted", user: expect.objectContaining({ id: firstUser.id }) })
    ]);
  });

  it("admits one of ten users into the final tournament slot", async () => {
    const repo = createMemoryRepository();
    const creator = await repo.upsertDevUser({ handle: "memory-capacity-owner", displayName: "개설자" });
    const earlyEntries = await Promise.all(
      ["memory-capacity-two", "memory-capacity-three"].map((handle) =>
        repo.upsertDevUser({ handle, displayName: handle })
      )
    );
    const candidates = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        repo.upsertDevUser({ handle: `memory-candidate-${index}`, displayName: `후보 ${index}` })
      )
    );
    const tournament = await repo.createTournament({ name: "마지막 자리", createdBy: creator.id });
    await repo.joinTournament(tournament.id, earlyEntries[0].id);
    await repo.joinTournament(tournament.id, earlyEntries[1].id);

    const attempts = await Promise.allSettled(
      candidates.map((candidate) => repo.joinTournament(tournament.id, candidate.id))
    );
    const accepted = attempts.filter((attempt) => attempt.status === "fulfilled");
    const rejected = attempts.filter((attempt) => attempt.status === "rejected");
    const completed = (await repo.listTournaments()).find((item) => item.id === tournament.id);
    const semifinalSlots = completed?.matches
      .filter((match) => match.round === "semifinal")
      .map((match) => match.slot)
      .sort() ?? [];

    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(9);
    expect(rejected.every((attempt) => String(attempt.reason).includes("tournament full"))).toBe(true);
    expect(completed?.playerCount).toBe(4);
    expect(new Set(completed?.entries.map((entry) => entry.id)).size).toBe(4);
    expect(semifinalSlots).toEqual([1, 2]);

    const acceptedUser = completed?.entries.find((entry) => candidates.some((candidate) => candidate.id === entry.id));
    await expect(repo.joinTournament(tournament.id, acceptedUser?.id ?? "")).resolves.toMatchObject({
      playerCount: 4
    });
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

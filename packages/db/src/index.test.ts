import { describe, expect, it } from "vitest";
import { createMemoryRepository } from "./index";

describe("memory repository", () => {
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
    const friend = await repo.requestFriend(me.id, "spin-doctor");
    const tournament = await repo.createTournament({ name: "테스트 컵", createdBy: me.id });

    expect(friend.status).toBe("pending");
    expect(tournament.playerCount).toBe(1);
    expect((await repo.listTournaments())[0].name).toBe("테스트 컵");
  });
});

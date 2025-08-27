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

    const session = await repo.getSessionUser(token);
    const dashboard = await repo.getDashboard(left.id);

    expect(session?.handle).toBe("left");
    expect(dashboard.recentMatches[0].result).toBe("win");
    expect(dashboard.me.wins).toBe(1);
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

import { describe, expect, it } from "vitest";
import {
  createNavigation,
  demoLobbyPresentation,
  formatTransientResultNotice,
  shouldResumeGameFromLobby,
  isDemoRestrictedPath
} from "./demoPolicy";

describe("guest demo presentation policy", () => {
  it("keeps only lobby and play navigation in demo mode", () => {
    expect(createNavigation(true, "/profile/guest-1").map((item) => item.id)).toEqual([
      "lobby",
      "play"
    ]);
    expect(createNavigation(false, "/profile/player-1").map((item) => item.id)).toEqual([
      "lobby",
      "play",
      "dashboard",
      "leaderboard",
      "tournaments",
      "profile",
      "admin"
    ]);
  });

  it("hides persisted progress, ranking links, and chat from the guest lobby", () => {
    expect(demoLobbyPresentation).toMatchObject({
      showPersistedProgress: false,
      showLeaderboardLink: false,
      showLobbyChat: false,
      showMatchChat: false
    });
    expect(demoLobbyPresentation.description).not.toMatch(/전적|순위.*갱신|저장/);
  });

  it("blocks direct navigation to registered-account pages in demo mode", () => {
    for (const path of [
      "/dashboard",
      "/leaderboard",
      "/tournaments",
      "/profile/registered-user",
      "/admin/users"
    ]) {
      expect(isDemoRestrictedPath(path)).toBe(true);
    }
    expect(isDemoRestrictedPath("/")).toBe(false);
    expect(isDemoRestrictedPath("/play")).toBe(false);
  });

  it("labels recovered guest results as transient", () => {
    expect(formatTransientResultNotice({
      persisted: false,
      leftScore: 1,
      rightScore: 3
    })).toBe("임시 경기 종료: 1 - 3 · 전적에 저장되지 않았습니다.");
  });

  it("moves an accidentally recovered room back to the game screen", () => {
    expect(shouldResumeGameFromLobby({ type: "queue.matched" })).toBe(true);
    expect(shouldResumeGameFromLobby({ type: "game.snapshot" })).toBe(true);
    expect(shouldResumeGameFromLobby({ type: "game.finished" })).toBe(false);
  });
});

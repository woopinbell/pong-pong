import { describe, expect, it } from "vitest";
import {
  createNavigation,
  demoLobbyPresentation,
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
});

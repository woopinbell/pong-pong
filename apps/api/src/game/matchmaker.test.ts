import { describe, expect, it } from "vitest";
import { Matchmaker, type MatchmakingPlayer } from "./matchmaker";

describe("Matchmaker", () => {
  it("matches the closest queued player within the configured rating difference", () => {
    const clock = mutableClock(1_000);
    const matchmaker = new Matchmaker({ clock: clock.now, maxRatingDifference: 150 });

    expect(matchmaker.enqueue(player("farther", 1_000))).toMatchObject({ type: "queued" });
    clock.advance(10);
    expect(matchmaker.enqueue(player("closer", 1_180))).toMatchObject({ type: "queued" });
    clock.advance(10);

    expect(matchmaker.enqueue(player("entrant", 1_120))).toEqual({
      type: "matched",
      match: {
        left: player("closer", 1_180),
        right: player("entrant", 1_120),
        ratingDifference: 60
      }
    });
    expect(matchmaker.queuedPlayers()).toEqual([player("farther", 1_000)]);
  });

  it("keeps players queued when their rating difference is outside the limit", () => {
    const matchmaker = new Matchmaker({ clock: () => 0, maxRatingDifference: 100 });

    expect(matchmaker.enqueue(player("first", 1_000))).toMatchObject({ type: "queued" });
    expect(matchmaker.enqueue(player("second", 1_101))).toMatchObject({ type: "queued" });
    expect(matchmaker.queuedCount).toBe(2);
  });

  it("never matches a guest with a registered user", () => {
    const matchmaker = new Matchmaker({ clock: () => 0, maxRatingDifference: 500 });

    matchmaker.enqueue(player("registered", 1_200));
    expect(matchmaker.enqueue(player("guest-one", 1_200, "guest"))).toMatchObject({ type: "queued" });

    expect(matchmaker.enqueue(player("guest-two", 1_200, "guest"))).toEqual({
      type: "matched",
      match: {
        left: player("guest-one", 1_200, "guest"),
        right: player("guest-two", 1_200, "guest"),
        ratingDifference: 0
      }
    });
    expect(matchmaker.queuedPlayers()).toEqual([player("registered", 1_200)]);
  });

  it("makes a queued player eligible for AI fallback after exactly six seconds", () => {
    const clock = mutableClock(10_000);
    const matchmaker = new Matchmaker({ clock: clock.now, maxRatingDifference: 100 });
    expect(matchmaker.enqueue(player("waiting", 1_200, "guest"))).toEqual({
      type: "queued",
      queuedAtMs: 10_000,
      aiFallbackAtMs: 16_000
    });

    clock.advance(5_999);
    expect(matchmaker.claimAiFallback("waiting")).toEqual({
      type: "waiting",
      remainingMs: 1
    });

    clock.advance(1);
    expect(matchmaker.claimAiFallback("waiting")).toEqual({
      type: "ready",
      player: player("waiting", 1_200, "guest"),
      waitedMs: 6_000
    });
    expect(matchmaker.queuedCount).toBe(0);
    expect(matchmaker.claimAiFallback("waiting")).toEqual({ type: "unavailable" });
  });

  it("prevents the same user from joining twice until their slot is released", () => {
    const matchmaker = new Matchmaker({ clock: () => 0, maxRatingDifference: 100 });

    matchmaker.enqueue(player("same-user", 1_200));
    expect(matchmaker.enqueue(player("same-user", 1_250, "guest"))).toEqual({
      type: "duplicate",
      status: "queued"
    });
    expect(matchmaker.queuedCount).toBe(1);

    matchmaker.enqueue(player("opponent", 1_200));
    expect(matchmaker.enqueue(player("same-user", 1_200))).toEqual({
      type: "duplicate",
      status: "matched"
    });

    expect(matchmaker.release("same-user")).toBe(true);
    expect(matchmaker.enqueue(player("same-user", 1_200))).toMatchObject({ type: "queued" });
  });

  it("removes only queued players and leaves matched reservations intact", () => {
    const matchmaker = new Matchmaker({ clock: () => 0, maxRatingDifference: 100 });

    matchmaker.enqueue(player("queued", 1_000));
    expect(matchmaker.leaveQueue("queued")).toBe(true);
    expect(matchmaker.leaveQueue("queued")).toBe(false);

    matchmaker.enqueue(player("left", 1_200));
    matchmaker.enqueue(player("right", 1_200));
    expect(matchmaker.leaveQueue("left")).toBe(false);
    expect(matchmaker.enqueue(player("left", 1_200))).toEqual({
      type: "duplicate",
      status: "matched"
    });
  });
});

function player(
  userId: string,
  rating: number,
  kind: MatchmakingPlayer["kind"] = "registered"
): MatchmakingPlayer {
  return { userId, rating, kind };
}

function mutableClock(initialMs: number): { now: () => number; advance: (milliseconds: number) => void } {
  let nowMs = initialMs;
  return {
    now: () => nowMs,
    advance: (milliseconds) => {
      nowMs += milliseconds;
    }
  };
}

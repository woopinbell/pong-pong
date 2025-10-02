import { describe, expect, it } from "vitest";
import { RoomSession } from "./roomSession";

describe("RoomSession", () => {
  it("starts only after both sides are ready", () => {
    const session = new RoomSession();
    expect(session.state).toBe("waiting");
    expect(session.markReady("left")).toBe("waiting");
    expect(session.markReady("right")).toBe("playing");
  });

  it("allows pause and resume only from the matching state", () => {
    const session = playingSession();
    expect(session.pause()).toBe("paused");
    expect(session.pause()).toBe("paused");
    expect(session.resume()).toBe("playing");
  });

  it("restores the previous state when a side reconnects within 15 seconds", () => {
    const session = playingSession();
    session.pause();
    expect(session.disconnect("left", 1_000)).toBe("reconnecting");
    expect(session.reconnectDeadline).toBe(16_000);

    expect(session.reconnect("left", 15_999)).toBe(true);
    expect(session.state).toBe("paused");
    expect(session.reconnectDeadline).toBeNull();
  });

  it("rejects a reconnect after the deadline", () => {
    const session = playingSession();
    session.disconnect("right", 5_000);

    expect(session.reconnect("right", 20_001)).toBe(false);
    expect(session.state).toBe("reconnecting");
  });

  it("turns one missing side into a single forfeit result", () => {
    const session = playingSession();
    session.disconnect("right", 10_000);

    expect(session.expireReconnect(24_999)).toBeNull();
    expect(session.expireReconnect(25_000)).toEqual({
      forfeitingSide: "right",
      winnerSide: "left"
    });
    expect(session.state).toBe("finished");
    expect(session.expireReconnect(30_000)).toBeNull();
  });

  it("does not select a winner when both sides disconnect", () => {
    const session = playingSession();
    session.disconnect("left", 0);
    session.disconnect("right", 1_000);

    expect(session.expireReconnect(16_000)).toEqual({
      forfeitingSide: null,
      winnerSide: null
    });
  });
});

function playingSession(): RoomSession {
  const session = new RoomSession();
  session.markReady("left");
  session.markReady("right");
  return session;
}

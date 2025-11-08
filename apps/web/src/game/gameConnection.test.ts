import { describe, expect, it } from "vitest";
import type { GameSnapshot } from "@pong-pong/shared";
import {
  gameConnectionReducer,
  initialGameConnectionState,
  canStartNewMatch,
  type GameConnectionStatus
} from "./gameConnection";

const allowedStatuses = new Set<GameConnectionStatus>([
  "idle",
  "connecting",
  "matching",
  "waitingReady",
  "playing",
  "paused",
  "reconnecting",
  "finished",
  "failed"
]);

describe("gameConnectionReducer", () => {
  it("keeps connection state inside the explicit lifecycle", () => {
    const connecting = gameConnectionReducer(initialGameConnectionState, { type: "connectStarted" });
    const matching = gameConnectionReducer(connecting, {
      type: "socketOpened",
      notice: "매칭 큐 참가 중"
    });
    const waiting = gameConnectionReducer(matching, {
      type: "matched",
      roomId: "room-1",
      opponent: "상대 선수"
    });
    const playing = gameConnectionReducer(waiting, {
      type: "snapshotReceived",
      snapshot: snapshot(1, "playing")
    });
    const paused = gameConnectionReducer(playing, {
      type: "snapshotReceived",
      snapshot: snapshot(2, "paused")
    });
    const reconnecting = gameConnectionReducer(paused, { type: "socketClosed" });
    const failed = gameConnectionReducer(initialGameConnectionState, { type: "socketClosed" });
    const finished = gameConnectionReducer(playing, {
      type: "gameFinished",
      result: { leftScore: 3, rightScore: 1 }
    });

    for (const state of [connecting, matching, waiting, playing, paused, reconnecting, failed, finished]) {
      expect(allowedStatuses.has(state.status)).toBe(true);
    }
    expect([connecting.status, matching.status, waiting.status, playing.status, paused.status]).toEqual([
      "connecting",
      "matching",
      "waitingReady",
      "playing",
      "paused"
    ]);
    expect(reconnecting).toMatchObject({ status: "reconnecting", roomId: "room-1" });
    expect(failed.status).toBe("failed");
    expect(finished).toMatchObject({ status: "finished", notice: "경기 종료: 3 - 1" });
  });

  it("discards snapshots whose sequence is not newer than the accepted snapshot", () => {
    const matched = gameConnectionReducer(initialGameConnectionState, {
      type: "matched",
      roomId: "room-1",
      opponent: "상대 선수"
    });
    const current = gameConnectionReducer(matched, {
      type: "snapshotReceived",
      snapshot: snapshot(7, "playing")
    });

    expect(gameConnectionReducer(current, {
      type: "snapshotReceived",
      snapshot: snapshot(7, "paused")
    })).toBe(current);
    expect(gameConnectionReducer(current, {
      type: "snapshotReceived",
      snapshot: snapshot(6, "paused")
    })).toBe(current);

    const next = gameConnectionReducer(current, {
      type: "snapshotReceived",
      snapshot: snapshot(8, "paused")
    });
    expect(next).toMatchObject({ status: "paused", lastSnapshotSequence: 8 });
  });

  it("clears per-room sequence state before a new connection attempt", () => {
    const current = gameConnectionReducer({
      ...initialGameConnectionState,
      status: "playing",
      roomId: "room-1",
      snapshot: snapshot(12, "playing"),
      lastSnapshotSequence: 12,
      messages: ["이전 메시지"]
    }, { type: "connectStarted" });

    expect(current).toMatchObject({
      status: "connecting",
      roomId: null,
      snapshot: null,
      lastSnapshotSequence: -1,
      messages: []
    });
  });

  it("does not start another queue command while a room is reconnecting", () => {
    expect(canStartNewMatch({
      ...initialGameConnectionState,
      status: "reconnecting",
      roomId: "room-1"
    })).toBe(false);
    expect(canStartNewMatch({
      ...initialGameConnectionState,
      status: "finished"
    })).toBe(true);
  });
});

function snapshot(sequence: number, phase: GameSnapshot["state"]["phase"]): GameSnapshot {
  return {
    roomId: "room-1",
    tick: sequence,
    sequence,
    serverTimeMs: sequence * 50,
    state: {
      phase,
      leftScore: 0,
      rightScore: 0,
      paddles: {
        left: { y: 100, dy: 0 },
        right: { y: 100, dy: 0 }
      },
      ball: {
        position: { x: 480, y: 270 },
        velocity: { x: 0, y: 0 }
      },
      players: []
    }
  };
}

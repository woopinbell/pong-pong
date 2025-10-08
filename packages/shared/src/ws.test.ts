import { describe, expect, it } from "vitest";
import {
  encodeServerEvent,
  parseClientEvent,
  parseServerEvent,
  type ServerEvent
} from "./ws";
import type { GameSnapshot } from "./game";

describe("version 1 client events", () => {
  it.each([
    { payload: { v: 1, type: "queue.join", mode: "ai" } },
    { payload: { v: 1, type: "queue.leave" } },
    { payload: { v: 1, type: "tournament.join", matchId: "match-1" } },
    { payload: { v: 1, type: "game.ready", roomId: "room-1" } },
    { payload: { v: 1, type: "game.pause", roomId: "room-1" } },
    { payload: { v: 1, type: "game.resume", roomId: "room-1" } },
    { payload: { v: 1, type: "game.input", roomId: "room-1", inputSeq: 7, direction: -1 } },
    { payload: { v: 1, type: "chat.send", scope: "match", roomId: "room-1", body: "hello" } }
  ])("accepts $payload.type", ({ payload }) => {
    expect(parseClientEvent(JSON.stringify(payload))).toEqual(payload);
  });

  it("defaults queue mode without defaulting the protocol version", () => {
    expect(parseClientEvent(JSON.stringify({ v: 1, type: "queue.join" }))).toEqual({
      v: 1,
      type: "queue.join",
      mode: "queue"
    });
    expect(() => parseClientEvent(JSON.stringify({ type: "queue.join" }))).toThrow();
  });

  it.each([
    { name: "missing version", payload: { type: "queue.leave" } },
    { name: "unsupported version", payload: { v: 2, type: "queue.leave" } },
    { name: "unexpected field", payload: { v: 1, type: "queue.leave", token: "secret" } },
    { name: "missing input sequence", payload: { v: 1, type: "game.input", roomId: "room-1", direction: 0 } },
    { name: "negative input sequence", payload: { v: 1, type: "game.input", roomId: "room-1", inputSeq: -1, direction: 0 } },
    { name: "fractional input sequence", payload: { v: 1, type: "game.input", roomId: "room-1", inputSeq: 1.5, direction: 0 } },
    { name: "invalid direction", payload: { v: 1, type: "game.input", roomId: "room-1", inputSeq: 1, direction: 2 } }
  ])("rejects $name", ({ payload }) => {
    expect(() => parseClientEvent(JSON.stringify(payload))).toThrow();
  });

  it("trims bounded chat bodies", () => {
    expect(parseClientEvent(JSON.stringify({
      v: 1,
      type: "chat.send",
      scope: "lobby",
      body: "  hello  "
    }))).toEqual({ v: 1, type: "chat.send", scope: "lobby", body: "hello" });

    expect(() => parseClientEvent(JSON.stringify({
      v: 1,
      type: "chat.send",
      scope: "lobby",
      body: "a".repeat(241)
    }))).toThrow();
  });
});

describe("version 1 server events", () => {
  const snapshot: GameSnapshot = {
    roomId: "room-1",
    tick: 12,
    sequence: 15,
    serverTimeMs: 1_784_764_800_000,
    state: {
      phase: "playing",
      leftScore: 1,
      rightScore: 0,
      paddles: {
        left: { y: 100, dy: -1 },
        right: { y: 200, dy: 1 }
      },
      ball: {
        position: { x: 480, y: 270 },
        velocity: { x: 6, y: -2 }
      },
      players: [
        { id: "player-1", handle: "left-player", displayName: "Left Player", side: "left", ready: true, ai: false },
        { id: "player-2", handle: "right-player", displayName: "Right Player", side: "right", ready: true, ai: false }
      ]
    }
  };

  const events = [
    { v: 1, type: "queue.matched", roomId: "room-1", side: "left", opponent: "Opponent" },
    { v: 1, type: "game.snapshot", snapshot },
    {
      v: 1,
      type: "game.finished",
      result: {
        roomId: "room-1",
        matchId: "match-1",
        persisted: true,
        winnerSide: "left",
        leftScore: 3,
        rightScore: 1,
        ratingDelta: 16
      }
    },
    {
      v: 1,
      type: "chat.message",
      message: {
        id: "11111111-1111-4111-8111-111111111111",
        scope: "lobby",
        roomId: null,
        sender: {
          id: "22222222-2222-4222-8222-222222222222",
          handle: "left-player",
          displayName: "Left Player",
          avatarKey: "avatar-1",
          role: "user",
          status: "active",
          rating: 1000,
          wins: 1,
          losses: 0,
          online: true,
          isNpc: false
        },
        body: "hello",
        createdAt: "2026-07-23T00:00:00.000Z"
      }
    },
    { v: 1, type: "presence.changed", online: 12, playing: 4 },
    { v: 1, type: "error", code: "invalid_event", message: "invalid event" }
  ] satisfies ServerEvent[];

  it.each(events)("validates and serializes $type", (event) => {
    const encoded = encodeServerEvent(event);

    expect(parseServerEvent(encoded)).toEqual(event);
  });

  it("rejects stale protocol shapes", () => {
    expect(() => parseServerEvent(JSON.stringify({ type: "presence.changed", online: 1, playing: 0 }))).toThrow();
    expect(() => parseServerEvent(JSON.stringify({
      v: 1,
      type: "game.snapshot",
      snapshot: { ...snapshot, sequence: -1 }
    }))).toThrow();
    expect(() => parseServerEvent(JSON.stringify({
      v: 1,
      type: "game.finished",
      result: {
        roomId: "room-1",
        matchId: null,
        persisted: true,
        winnerSide: "left",
        leftScore: 3,
        rightScore: 0,
        ratingDelta: 16
      }
    }))).toThrow();
  });
});

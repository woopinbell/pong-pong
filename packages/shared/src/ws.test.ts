import { describe, expect, it } from "vitest";
import { encodeServerEvent, parseClientEvent, type ServerEvent } from "./ws";

describe("parseClientEvent", () => {
  it.each([
    {
      name: "queue join",
      payload: { type: "queue.join", mode: "ai" },
      expected: { type: "queue.join", mode: "ai" }
    },
    {
      name: "queue leave",
      payload: { type: "queue.leave" },
      expected: { type: "queue.leave" }
    },
    {
      name: "game ready",
      payload: { type: "game.ready", roomId: "room-1" },
      expected: { type: "game.ready", roomId: "room-1" }
    },
    {
      name: "game input",
      payload: { type: "game.input", roomId: "room-1", direction: -1 },
      expected: { type: "game.input", roomId: "room-1", direction: -1 }
    },
    {
      name: "chat send",
      payload: { type: "chat.send", scope: "match", roomId: "room-1", body: "hello" },
      expected: { type: "chat.send", scope: "match", roomId: "room-1", body: "hello" }
    }
  ])("accepts $name events", ({ payload, expected }) => {
    expect(parseClientEvent(JSON.stringify(payload))).toEqual(expected);
  });

  it("defaults queue joins to queue mode", () => {
    expect(parseClientEvent(JSON.stringify({ type: "queue.join" }))).toEqual({
      type: "queue.join",
      mode: "queue"
    });
  });

  it("rejects unknown event types", () => {
    expect(() => parseClientEvent(JSON.stringify({ type: "game.unknown" }))).toThrow();
  });

  it.each([
    { name: "ready room id", payload: { type: "game.ready" } },
    { name: "input room id", payload: { type: "game.input", direction: 0 } },
    { name: "input direction", payload: { type: "game.input", roomId: "room-1" } },
    { name: "chat scope", payload: { type: "chat.send", body: "hello" } },
    { name: "chat body", payload: { type: "chat.send", scope: "lobby" } }
  ])("rejects events without the required $name", ({ payload }) => {
    expect(() => parseClientEvent(JSON.stringify(payload))).toThrow();
  });

  it.each([
    { name: "queue mode", payload: { type: "queue.join", mode: "ranked" } },
    { name: "chat scope", payload: { type: "chat.send", scope: "private", body: "hello" } },
    { name: "direction below the range", payload: { type: "game.input", roomId: "room-1", direction: -2 } },
    { name: "direction above the range", payload: { type: "game.input", roomId: "room-1", direction: 2 } },
    { name: "non-numeric direction", payload: { type: "game.input", roomId: "room-1", direction: "1" } }
  ])("rejects an invalid $name", ({ payload }) => {
    expect(() => parseClientEvent(JSON.stringify(payload))).toThrow();
  });

  it.each([-1, 0, 1])("accepts %i as an input direction", (direction) => {
    expect(
      parseClientEvent(JSON.stringify({ type: "game.input", roomId: "room-1", direction }))
    ).toEqual({ type: "game.input", roomId: "room-1", direction });
  });

  it("trims chat bodies", () => {
    expect(
      parseClientEvent(JSON.stringify({ type: "chat.send", scope: "lobby", body: "  hello  " }))
    ).toEqual({ type: "chat.send", scope: "lobby", body: "hello" });
  });

  it("accepts chat bodies at the 1 and 240 character boundaries", () => {
    const oneCharacter = parseClientEvent(
      JSON.stringify({ type: "chat.send", scope: "lobby", body: "a" })
    );
    const twoHundredFortyCharacters = parseClientEvent(
      JSON.stringify({ type: "chat.send", scope: "lobby", body: "a".repeat(240) })
    );

    expect(oneCharacter).toMatchObject({ body: "a" });
    expect(twoHundredFortyCharacters).toMatchObject({ body: "a".repeat(240) });
  });

  it.each(["", "   ", "a".repeat(241)])("rejects an invalid chat body length", (body) => {
    expect(() =>
      parseClientEvent(JSON.stringify({ type: "chat.send", scope: "lobby", body }))
    ).toThrow();
  });

  it("rejects malformed JSON", () => {
    expect(() => parseClientEvent('{"type":"queue.leave"')).toThrow(SyntaxError);
  });
});

describe("encodeServerEvent", () => {
  const serverEvents = [
    {
      type: "queue.matched",
      roomId: "room-1",
      side: "left",
      opponent: "opponent"
    },
    {
      type: "game.snapshot",
      snapshot: {
        roomId: "room-1",
        phase: "playing",
        tick: 12,
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
          {
            id: "player-1",
            handle: "left-player",
            displayName: "Left Player",
            side: "left",
            ready: true,
            ai: false
          },
          {
            id: "player-2",
            handle: "right-player",
            displayName: "Right Player",
            side: "right",
            ready: true,
            ai: false
          }
        ],
        serverTime: "2026-07-23T00:00:00.000Z"
      }
    },
    {
      type: "game.finished",
      result: {
        roomId: "room-1",
        matchId: "match-1",
        winnerSide: "left",
        leftScore: 3,
        rightScore: 1,
        ratingDelta: 16
      }
    },
    {
      type: "chat.message",
      message: {
        id: "message-1",
        scope: "lobby",
        roomId: null,
        sender: {
          id: "player-1",
          handle: "left-player",
          displayName: "Left Player",
          avatarKey: "avatar-1",
          role: "user",
          status: "active",
          rating: 1000,
          wins: 1,
          losses: 0,
          online: true
        },
        body: "hello",
        createdAt: "2026-07-23T00:00:00.000Z"
      }
    },
    {
      type: "presence.changed",
      online: 12,
      playing: 4
    },
    {
      type: "error",
      message: "invalid event"
    }
  ] satisfies ServerEvent[];

  it.each(serverEvents)("serializes $type events", (event) => {
    const encoded = encodeServerEvent(event);

    expect(encoded).toBe(JSON.stringify(event));
    expect(JSON.parse(encoded)).toEqual(event);
  });
});

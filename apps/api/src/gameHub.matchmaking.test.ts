import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createMemoryRepository } from "@pong-pong/db";
import { parseServerEvent, type ServerEvent, type SessionUser } from "@pong-pong/shared";
import { GameHub } from "./gameHub.js";

describe("GameHub matchmaking boundary", () => {
  const repositories: Array<ReturnType<typeof createMemoryRepository>> = [];
  const sockets: FakeSocket[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    vi.clearAllTimers();
    vi.useRealTimers();
    await Promise.all(repositories.splice(0).map((repository) => repository.close()));
  });

  it("keeps a player queued when the rating gap is too large", async () => {
    const hub = setup().hub;
    const lowerRated = connect(hub, player("lower-rated", 1_000));
    const higherRated = connect(hub, player("higher-rated", 2_000));

    lowerRated.receive({ v: 1, type: "queue.join", mode: "queue" });
    higherRated.receive({ v: 1, type: "queue.join", mode: "queue" });
    await flushEvents();

    expect(lowerRated.latest("queue.matched")).toBeUndefined();
    expect(higherRated.latest("queue.matched")).toBeUndefined();
    expect(hub.liveStats().queuedPlayers).toBe(2);

    const nearby = connect(hub, player("nearby", 1_050));
    nearby.receive({ v: 1, type: "queue.join", mode: "queue" });
    await flushEvents();

    expect(lowerRated.latest("queue.matched")).toEqual(
      expect.objectContaining({ opponent: "nearby" })
    );
    expect(nearby.latest("queue.matched")).toEqual(
      expect.objectContaining({ opponent: "lower-rated" })
    );
    expect(higherRated.latest("queue.matched")).toBeUndefined();
    expect(hub.liveStats().queuedPlayers).toBe(1);
  });

  it("releases both matched reservations after a forfeit is finalized", async () => {
    const { hub, repository } = setup();
    vi.spyOn(repository, "finalizeMatch").mockResolvedValue({
      matchId: "forfeit-match",
      resultKey: "forfeit-result",
      created: true
    });
    const left = connect(hub, player("left", 1_200));
    const right = connect(hub, player("right", 1_200));
    const roomId = await pair(left, right);

    left.receive({ v: 1, type: "game.ready", roomId });
    right.receive({ v: 1, type: "game.ready", roomId });
    await flushEvents();
    left.terminate();
    await vi.advanceTimersByTimeAsync(15_000);
    await flushEvents();

    expect(hub.liveStats().activeRooms).toBe(0);
    const reconnectedLeft = connect(hub, player("left", 1_200));
    right.receive({ v: 1, type: "queue.join", mode: "queue" });
    reconnectedLeft.receive({ v: 1, type: "queue.join", mode: "queue" });
    await flushEvents();

    expect(right.latest("queue.matched")).toEqual(
      expect.objectContaining({ opponent: "left" })
    );
    expect(reconnectedLeft.latest("queue.matched")).toEqual(
      expect.objectContaining({ opponent: "right" })
    );
  });

  it("releases both matched reservations when an empty room is abandoned", async () => {
    const { hub } = setup();
    const left = connect(hub, player("abandoned-left", 1_200));
    const right = connect(hub, player("abandoned-right", 1_200));
    await pair(left, right);

    left.terminate();
    right.terminate();
    await vi.advanceTimersByTimeAsync(15_000);
    await flushEvents();

    expect(hub.liveStats().activeRooms).toBe(0);
    const recoveredLeft = connect(hub, player("abandoned-left", 1_200));
    const recoveredRight = connect(hub, player("abandoned-right", 1_200));
    await pair(recoveredLeft, recoveredRight);
  });

  it("rolls back the room and reservations when room creation fails", async () => {
    const repository = createMemoryRepository();
    repositories.push(repository);
    let failOnce = true;
    const hub = new GameHub(repository, {
      roomCreated: () => {
        if (!failOnce) return;
        failOnce = false;
        throw new Error("observer failed");
      }
    });
    const left = connect(hub, player("retry-left", 1_200));
    const right = connect(hub, player("retry-right", 1_200));

    left.receive({ v: 1, type: "queue.join", mode: "queue" });
    right.receive({ v: 1, type: "queue.join", mode: "queue" });
    await flushEvents();
    expect(hub.liveStats()).toEqual(expect.objectContaining({ activeRooms: 0, queuedPlayers: 0 }));

    left.receive({ v: 1, type: "queue.join", mode: "queue" });
    right.receive({ v: 1, type: "queue.join", mode: "queue" });
    await flushEvents();

    expect(left.latest("queue.matched")).toEqual(
      expect.objectContaining({ opponent: "retry-right" })
    );
    expect(right.latest("queue.matched")).toEqual(
      expect.objectContaining({ opponent: "retry-left" })
    );
    expect(hub.liveStats()).toEqual(expect.objectContaining({ activeRooms: 1, queuedPlayers: 0 }));
  });

  function setup() {
    const repository = createMemoryRepository();
    repositories.push(repository);
    return { repository, hub: new GameHub(repository) };
  }

  function connect(hub: GameHub, user: SessionUser): FakeSocket {
    const socket = new FakeSocket();
    sockets.push(socket);
    hub.connect(socket as unknown as WebSocket, {} as IncomingMessage, user);
    return socket;
  }
});

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  private readonly payloads: string[] = [];

  send(payload: string, callback?: (error?: Error) => void): void {
    this.payloads.push(payload);
    callback?.();
  }

  ping(): void {}

  close(): void {
    this.terminate();
  }

  terminate(): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }

  receive(event: object): void {
    this.emit("message", Buffer.from(JSON.stringify(event)));
  }

  latest(type: ServerEvent["type"]): ServerEvent | undefined {
    return this.payloads
      .map((payload) => parseServerEvent(payload))
      .filter((event) => event.type === type)
      .at(-1);
  }
}

async function pair(left: FakeSocket, right: FakeSocket): Promise<string> {
  left.receive({ v: 1, type: "queue.join", mode: "queue" });
  right.receive({ v: 1, type: "queue.join", mode: "queue" });
  await flushEvents();
  const matched = right.latest("queue.matched");
  if (matched?.type !== "queue.matched") throw new Error("expected a match");
  return matched.roomId;
}

async function flushEvents(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function player(handle: string, rating: number): SessionUser {
  return {
    id: `${handle}-id`,
    handle,
    displayName: handle,
    avatarKey: "default",
    role: "user",
    status: "active",
    rating,
    wins: 0,
    losses: 0,
    online: true,
    isNpc: false,
    email: null
  };
}

import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createMemoryRepository } from "@pong-pong/db";
import { parseServerEvent, type ServerEvent, type SessionUser } from "@pong-pong/shared";
import { GameHub } from "./gameHub";

describe("GameHub connection recovery", () => {
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

  it("replaces an active connection without starting a forfeit timeout", async () => {
    const { hub, finalizeMatch } = setup();
    const first = connect(hub, player("left-user", "왼쪽 사용자"));
    const roomId = await joinAiMatch(first);

    const replacement = connect(hub, player("left-user", "왼쪽 사용자"));
    await flushEvents();

    expect(first.closed).toEqual({ code: 4001, reason: "connection replaced" });
    expect(replacement.latest("queue.matched")).toEqual(
      expect.objectContaining({ roomId, side: "left" })
    );
    expect(replacement.latest("game.snapshot")).toEqual(
      expect.objectContaining({
        snapshot: expect.objectContaining({
          roomId,
          state: expect.objectContaining({ phase: "waiting" })
        })
      })
    );
    first.receive({ v: 1, type: "queue.join", mode: "ai" });
    await flushEvents();
    expect(hub.liveStats().activeRooms).toBe(1);
    expect(hub.scheduledRoomCount).toBe(0);

    await vi.advanceTimersByTimeAsync(15_001);
    expect(finalizeMatch).not.toHaveBeenCalled();
    expect(hub.liveStats().activeRooms).toBe(1);
  });

  it("restores the reserved side and sends the latest snapshot within 15 seconds", async () => {
    const { hub, finalizeMatch } = setup();
    const first = connect(hub, player("left-user", "왼쪽 사용자"));
    const roomId = await joinAiMatch(first);
    first.receive({ v: 1, type: "game.ready", roomId });
    await vi.advanceTimersByTimeAsync(100);
    expect(hub.scheduledRoomCount).toBe(1);

    const sequenceBeforeDisconnect = snapshotSequence(first);
    first.terminate();
    await flushEvents();
    expect(hub.scheduledRoomCount).toBe(0);
    await vi.advanceTimersByTimeAsync(14_999);

    const recovered = connect(hub, player("left-user", "왼쪽 사용자"));
    await flushEvents();
    expect(hub.scheduledRoomCount).toBe(1);
    const snapshot = recovered.latest("game.snapshot");

    expect(recovered.latest("queue.matched")).toEqual(
      expect.objectContaining({ roomId, side: "left" })
    );
    expect(snapshot).toEqual(
      expect.objectContaining({
        snapshot: expect.objectContaining({
          roomId,
          sequence: expect.any(Number),
          state: expect.objectContaining({ phase: "playing" })
        })
      })
    );
    if (snapshot?.type !== "game.snapshot") throw new Error("expected recovered snapshot");
    expect(snapshot.snapshot.sequence).toBeGreaterThan(sequenceBeforeDisconnect);

    await vi.advanceTimersByTimeAsync(2);
    expect(finalizeMatch).not.toHaveBeenCalled();
  });

  it("finalizes one forfeit when the reserved side does not reconnect", async () => {
    const { hub, finalizeMatch, matchFinalized } = setup();
    const leftUser = player("left-user", "왼쪽 사용자");
    const rightUser = player("right-user", "오른쪽 사용자");
    const left = connect(hub, leftUser);
    const right = connect(hub, rightUser);

    left.receive({ v: 1, type: "queue.join", mode: "queue" });
    await flushEvents();
    right.receive({ v: 1, type: "queue.join", mode: "queue" });
    await flushEvents();
    const matched = right.latest("queue.matched");
    if (matched?.type !== "queue.matched") throw new Error("expected a match");

    left.receive({ v: 1, type: "game.ready", roomId: matched.roomId });
    right.receive({ v: 1, type: "game.ready", roomId: matched.roomId });
    await flushEvents();
    left.terminate();

    await vi.advanceTimersByTimeAsync(14_999);
    expect(finalizeMatch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await flushEvents();

    expect(finalizeMatch).toHaveBeenCalledTimes(1);
    expect(finalizeMatch).toHaveBeenCalledWith(
      expect.objectContaining({
        resultKey: `room:${matched.roomId}:finished`,
        winnerId: rightUser.id,
        loserId: leftUser.id
      })
    );
    expect(right.latest("game.finished")).toEqual(
      expect.objectContaining({
        result: expect.objectContaining({ roomId: matched.roomId, winnerSide: "right" })
      })
    );
    expect(matchFinalized).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "success",
        persistence: "database",
        created: true
      })
    );
    expect(hub.scheduledRoomCount).toBe(0);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(finalizeMatch).toHaveBeenCalledTimes(1);
  });

  function setup() {
    const repository = createMemoryRepository();
    repositories.push(repository);
    const matchFinalized = vi.fn();
    const finalizeMatch = vi.spyOn(repository, "finalizeMatch").mockResolvedValue({
      matchId: "forfeit-match",
      resultKey: "forfeit-result",
      created: true
    });
    return {
      hub: new GameHub(repository, { matchFinalized }),
      finalizeMatch,
      matchFinalized
    };
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
  closed: { code: number; reason: string } | null = null;
  private readonly payloads: string[] = [];

  send(payload: string, callback?: (error?: Error) => void): void {
    this.payloads.push(payload);
    callback?.();
  }

  ping(): void {}

  close(code = 1000, reason = ""): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.closed = { code, reason };
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }

  terminate(): void {
    this.close(1006, "terminated");
  }

  receive(event: object): void {
    this.emit("message", Buffer.from(JSON.stringify(event)));
  }

  latest(type: ServerEvent["type"]): ServerEvent | undefined {
    return this.events().filter((event) => event.type === type).at(-1);
  }

  private events(): ServerEvent[] {
    return this.payloads.map((payload) => parseServerEvent(payload));
  }
}

async function joinAiMatch(socket: FakeSocket): Promise<string> {
  socket.receive({ v: 1, type: "queue.join", mode: "ai" });
  await flushEvents();
  const matched = socket.latest("queue.matched");
  if (matched?.type !== "queue.matched") throw new Error("expected an AI match");
  return matched.roomId;
}

function snapshotSequence(socket: FakeSocket): number {
  const event = socket.latest("game.snapshot");
  if (event?.type !== "game.snapshot") throw new Error("expected a snapshot");
  return event.snapshot.sequence;
}

async function flushEvents(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function player(handle: string, displayName: string): SessionUser {
  return {
    id: `${handle}-id`,
    handle,
    displayName,
    avatarKey: "default",
    role: "user",
    status: "active",
    rating: 1_200,
    wins: 0,
    losses: 0,
    online: true,
    isNpc: false,
    email: null
  };
}

import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createMemoryRepository } from "@pong-pong/db";
import { parseServerEvent, type ServerEvent, type SessionUser } from "@pong-pong/shared";
import { GameHub } from "./gameHub.js";

describe("GameHub finalization recovery", () => {
  const hubs: GameHub[] = [];
  const repositories: Array<ReturnType<typeof createMemoryRepository>> = [];

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    for (const hub of hubs.splice(0)) hub.close();
    vi.clearAllTimers();
    vi.useRealTimers();
    await Promise.all(repositories.splice(0).map((repository) => repository.close()));
  });

  it("retries a transient persistence failure with one stable result key", async () => {
    const repository = createMemoryRepository();
    repositories.push(repository);
    const finalizedEvents: Array<{ outcome: "success" | "failure"; created: boolean | null }> = [];
    const hub = new GameHub(repository, {
      matchFinalized: (event) => finalizedEvents.push({ outcome: event.outcome, created: event.created })
    });
    hubs.push(hub);
    const finalizeMatch = vi.spyOn(repository, "finalizeMatch")
      .mockRejectedValueOnce(new Error("database temporarily unavailable"))
      .mockResolvedValueOnce({
        matchId: "22222222-2222-4222-8222-222222222222",
        resultKey: "unused-stub-key",
        created: true
      });
    const socket = connect(hub);
    const roomId = await startAiRoom(socket);

    socket.receive({ v: 1, type: "game.ready", roomId });
    await advanceUntil(() => finalizeMatch.mock.calls.length === 1);
    expect(finalizeMatch).toHaveBeenCalledTimes(1);
    expect(socket.events("game.finished")).toHaveLength(0);
    expect(hub.liveStats().activeRooms).toBe(1);

    await vi.advanceTimersByTimeAsync(250);
    await flushEvents();

    expect(finalizeMatch).toHaveBeenCalledTimes(2);
    expect(finalizeMatch.mock.calls[0]?.[0].resultKey).toBe(`room:${roomId}:finished`);
    expect(finalizeMatch.mock.calls[1]?.[0].resultKey).toBe(`room:${roomId}:finished`);
    expect(socket.events("game.finished")).toHaveLength(1);
    expect(hub.liveStats().activeRooms).toBe(0);
    expect(finalizedEvents).toEqual([
      { outcome: "failure", created: null },
      { outcome: "success", created: true }
    ]);
  });

  it("keeps drain pending until a finalization retry succeeds", async () => {
    const repository = createMemoryRepository();
    repositories.push(repository);
    const hub = new GameHub(repository);
    hubs.push(hub);
    vi.spyOn(repository, "finalizeMatch")
      .mockRejectedValueOnce(new Error("temporary outage"))
      .mockResolvedValueOnce({
        matchId: "33333333-3333-4333-8333-333333333333",
        resultKey: "unused-stub-key",
        created: true
      });
    const socket = connect(hub);
    const roomId = await startAiRoom(socket);
    socket.receive({ v: 1, type: "game.ready", roomId });
    const drain = hub.beginDrain(60_000);

    const finalizeMatch = vi.mocked(repository.finalizeMatch);
    await advanceUntil(() => finalizeMatch.mock.calls.length === 1);
    let settled = false;
    void drain.then(() => { settled = true; });
    await flushEvents();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(250);
    await expect(drain).resolves.toEqual({ drained: true, activeRooms: 0 });
  });
});

function connect(hub: GameHub): FakeSocket {
  const socket = new FakeSocket();
  hub.connect(socket as unknown as WebSocket, {} as IncomingMessage, player());
  return socket;
}

async function startAiRoom(socket: FakeSocket): Promise<string> {
  socket.receive({ v: 1, type: "queue.join", mode: "ai" });
  await flushEvents();
  const matched = socket.latest("queue.matched");
  if (matched?.type !== "queue.matched") throw new Error("expected a match");
  return matched.roomId;
}

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
    return this.events(type).at(-1);
  }

  events(type: ServerEvent["type"]): ServerEvent[] {
    return this.payloads
      .map((payload) => parseServerEvent(payload))
      .filter((event) => event.type === type);
  }
}

async function flushEvents(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function advanceUntil(predicate: () => boolean): Promise<void> {
  for (let elapsed = 0; elapsed < 30_000 && !predicate(); elapsed += 10) {
    await vi.advanceTimersByTimeAsync(10);
    await flushEvents();
  }
  if (!predicate()) throw new Error("timed out waiting for room finalization");
}

function player(): SessionUser {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    handle: "finalization-player",
    displayName: "Finalization Player",
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

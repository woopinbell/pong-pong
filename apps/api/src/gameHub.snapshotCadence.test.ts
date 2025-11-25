import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createMemoryRepository } from "@pong-pong/db";
import { parseServerEvent, type ServerEvent, type SessionUser } from "@pong-pong/shared";
import { GameHub } from "./gameHub";

describe("GameHub snapshot cadence", () => {
  const repositories: Array<ReturnType<typeof createMemoryRepository>> = [];
  const hubs: GameHub[] = [];
  const sockets: FakeSocket[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    for (const hub of hubs.splice(0)) hub.close();
    for (const socket of sockets.splice(0)) socket.terminate();
    vi.clearAllTimers();
    vi.useRealTimers();
    await Promise.all(repositories.splice(0).map((repository) => repository.close()));
  });

  it("keeps 20Hz simulation while staggering 10Hz snapshots across rooms", async () => {
    const repository = createMemoryRepository();
    repositories.push(repository);
    const hub = new GameHub(repository);
    hubs.push(hub);
    const first = connect(hub, player("cadence-left"));
    const second = connect(hub, player("cadence-right"));
    const firstRoomId = await joinAiMatch(first);
    const secondRoomId = await joinAiMatch(second);

    first.receive({ v: 1, type: "game.ready", roomId: firstRoomId });
    second.receive({ v: 1, type: "game.ready", roomId: secondRoomId });
    await flushEvents();
    first.clear();
    second.clear();

    const deliveries: Array<[number, number]> = [];
    for (let tick = 0; tick < 4; tick += 1) {
      vi.advanceTimersByTime(50);
      deliveries.push([first.snapshotCount(), second.snapshotCount()]);
      first.clear();
      second.clear();
    }

    expect(deliveries.map(([left, right]) => left + right)).toEqual([1, 1, 1, 1]);
    expect(deliveries.reduce((total, [left]) => total + left, 0)).toBe(2);
    expect(deliveries.reduce((total, [, right]) => total + right, 0)).toBe(2);
  });

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
  private payloads: string[] = [];

  send(payload: string, callback?: (error?: Error) => void): void {
    this.payloads.push(payload);
    callback?.();
  }

  ping(): void {}

  close(): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }

  terminate(): void {
    this.close();
  }

  receive(event: object): void {
    this.emit("message", Buffer.from(JSON.stringify(event)));
  }

  clear(): void {
    this.payloads = [];
  }

  snapshotCount(): number {
    return this.events().filter((event) => event.type === "game.snapshot").length;
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

async function flushEvents(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function player(handle: string): SessionUser {
  return {
    id: `${handle}-id`,
    handle,
    displayName: handle,
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

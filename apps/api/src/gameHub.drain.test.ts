import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createMemoryRepository } from "@pong-pong/db";
import { parseServerEvent, type ServerEvent, type SessionUser } from "@pong-pong/shared";
import { GameHub } from "./gameHub";

describe("GameHub drain boundary", () => {
  const sockets: FakeSocket[] = [];
  const repositories: Array<ReturnType<typeof createMemoryRepository>> = [];

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    vi.clearAllTimers();
    vi.useRealTimers();
    await Promise.all(repositories.splice(0).map((repository) => repository.close()));
  });

  it("clears waiting players and rejects new queue commands during drain", async () => {
    const hub = setup();
    const waiting = connect(hub, player("waiting-user"));
    waiting.receive({ v: 1, type: "queue.join", mode: "queue" });
    await flushEvents();
    expect(hub.liveStats().queuedPlayers).toBe(1);

    const drain = hub.beginDrain(60_000);
    expect(hub.liveStats().queuedPlayers).toBe(0);

    const newcomer = connect(hub, player("new-user"));
    newcomer.receive({ v: 1, type: "queue.join", mode: "ai" });
    await flushEvents();

    expect(newcomer.latest("error")).toEqual(expect.objectContaining({
      code: "server_draining"
    }));
    await expect(drain).resolves.toEqual({ drained: true, activeRooms: 0 });
  });

  it("waits for active rooms but never exceeds the drain timeout", async () => {
    const hub = setup();
    const socket = connect(hub, player("active-user"));
    socket.receive({ v: 1, type: "queue.join", mode: "ai" });
    await flushEvents();
    expect(hub.liveStats().activeRooms).toBe(1);

    let result: Awaited<ReturnType<GameHub["beginDrain"]>> | undefined;
    const drain = hub.beginDrain(60_000).then((value) => {
      result = value;
      return value;
    });

    await vi.advanceTimersByTimeAsync(59_999);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);

    await expect(drain).resolves.toEqual({ drained: false, activeRooms: 1 });
  });

  function setup(): GameHub {
    const repository = createMemoryRepository();
    repositories.push(repository);
    return new GameHub(repository);
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

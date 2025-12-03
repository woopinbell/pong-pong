import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createMemoryRepository } from "@pong-pong/db";
import { parseServerEvent, type ServerEvent, type SessionUser } from "@pong-pong/shared";
import { GameHub } from "./gameHub.js";

describe("GameHub pause input boundary", () => {
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

  it("does not carry a pre-pause paddle direction into resume", async () => {
    const repository = createMemoryRepository();
    repositories.push(repository);
    const hub = new GameHub(repository);
    hubs.push(hub);
    const socket = new FakeSocket();
    hub.connect(socket as unknown as WebSocket, {} as IncomingMessage, player());

    socket.receive({ v: 1, type: "queue.join", mode: "ai" });
    await flushEvents();
    const matched = socket.latest("queue.matched");
    if (matched?.type !== "queue.matched") throw new Error("expected a match");

    socket.receive({ v: 1, type: "game.ready", roomId: matched.roomId });
    socket.receive({
      v: 1,
      type: "game.input",
      roomId: matched.roomId,
      inputSeq: 0,
      direction: 1
    });
    socket.receive({ v: 1, type: "game.pause", roomId: matched.roomId });
    await flushEvents();

    expect(latestSnapshot(socket).state.phase).toBe("paused");
    expect(latestSnapshot(socket).state.paddles.left.dy).toBe(0);

    socket.receive({
      v: 1,
      type: "game.input",
      roomId: matched.roomId,
      inputSeq: 1,
      direction: 0
    });
    socket.receive({ v: 1, type: "game.resume", roomId: matched.roomId });
    await vi.advanceTimersByTimeAsync(100);
    await flushEvents();

    expect(latestSnapshot(socket).state.phase).toBe("playing");
    expect(latestSnapshot(socket).state.paddles.left.dy).toBe(0);
  });
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

function latestSnapshot(socket: FakeSocket) {
  const event = socket.latest("game.snapshot");
  if (event?.type !== "game.snapshot") throw new Error("missing game snapshot");
  return event.snapshot;
}

async function flushEvents(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function player(): SessionUser {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    handle: "pause-player",
    displayName: "Pause Player",
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

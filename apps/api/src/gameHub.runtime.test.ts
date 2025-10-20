import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createMemoryRepository } from "@pong-pong/db";
import { parseServerEvent, type ServerEvent, type SessionUser } from "@pong-pong/shared";
import { GameHub } from "./gameHub";

describe("GameHub runtime protection", () => {
  const repositories: Array<ReturnType<typeof createMemoryRepository>> = [];

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(repositories.splice(0).map((repository) => repository.close()));
  });

  it("returns the stable rate_limited error after the input burst is exhausted", async () => {
    const repository = createMemoryRepository();
    repositories.push(repository);
    const hub = new GameHub(repository);
    const socket = new FakeSocket();
    hub.connect(socket as unknown as WebSocket, {} as IncomingMessage, user());

    socket.receive({ v: 1, type: "queue.join", mode: "ai" });
    const matched = await socket.waitForEvent("queue.matched");
    if (matched.type !== "queue.matched") throw new Error("expected a match");
    socket.receive({ v: 1, type: "game.ready", roomId: matched.roomId });

    for (let inputSeq = 0; inputSeq < 9; inputSeq += 1) {
      socket.receive({
        v: 1,
        type: "game.input",
        roomId: matched.roomId,
        inputSeq,
        direction: inputSeq % 2 === 0 ? 1 : -1
      });
    }

    await expect.poll(() => socket.events().filter((event) => event.type === "error")).toEqual([
      expect.objectContaining({ type: "error", code: "rate_limited" })
    ]);
    socket.terminate();
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

  terminate(): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }

  receive(event: object): void {
    this.emit("message", Buffer.from(JSON.stringify(event)));
  }

  events(): ServerEvent[] {
    return this.payloads.map((payload) => parseServerEvent(payload));
  }

  async waitForEvent(type: ServerEvent["type"]): Promise<ServerEvent> {
    await expect.poll(() => this.events().some((event) => event.type === type)).toBe(true);
    const event = this.events().find((candidate) => candidate.type === type);
    if (!event) throw new Error(`missing ${type} event`);
    return event;
  }
}

function user(): SessionUser {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    handle: "runtime-user",
    displayName: "런타임 사용자",
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

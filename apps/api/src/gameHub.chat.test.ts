import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createMemoryRepository } from "@pong-pong/db";
import {
  parseServerEvent,
  type ChatMessage,
  type ServerEvent,
  type SessionUser
} from "@pong-pong/shared";
import { GameHub } from "./gameHub.js";

describe("GameHub chat authorization", () => {
  const hubs: GameHub[] = [];
  const repositories: Array<ReturnType<typeof createMemoryRepository>> = [];

  afterEach(async () => {
    for (const hub of hubs.splice(0)) hub.close();
    await Promise.all(repositories.splice(0).map((repository) => repository.close()));
  });

  it("rejects cross-room injection before persistence", async () => {
    const context = setup();
    const roomA = await pair(context, "a-left", "a-right");
    const roomB = await pair(context, "b-left", "b-right");
    const intruder = context.sockets.get("b-left");
    if (!intruder) throw new Error("missing intruder socket");

    intruder.receive({
      v: 1,
      type: "chat.send",
      scope: "match",
      roomId: roomA,
      body: "cross-room message"
    });
    await flushEvents();

    expect(roomB).not.toBe(roomA);
    expect(context.createChatMessage).not.toHaveBeenCalled();
    expect(intruder.latest("error")).toEqual(expect.objectContaining({
      type: "error",
      code: "forbidden"
    }));
    expect([...context.sockets.values()].flatMap((socket) => socket.events("chat.message"))).toEqual([]);
  });

  it("delivers match chat only to the active room audience", async () => {
    const context = setup();
    const roomA = await pair(context, "a-left", "a-right");
    await pair(context, "b-left", "b-right");
    const sender = context.sockets.get("a-left");
    if (!sender) throw new Error("missing sender socket");

    sender.receive({
      v: 1,
      type: "chat.send",
      scope: "match",
      roomId: roomA,
      body: "room A only"
    });
    await flushEvents();

    expect(context.createChatMessage).toHaveBeenCalledWith(expect.objectContaining({
      scope: "match",
      roomId: roomA,
      senderId: context.users.get("a-left")?.id
    }));
    expect(context.sockets.get("a-left")?.events("chat.message")).toHaveLength(1);
    expect(context.sockets.get("a-right")?.events("chat.message")).toHaveLength(1);
    expect(context.sockets.get("b-left")?.events("chat.message")).toHaveLength(0);
    expect(context.sockets.get("b-right")?.events("chat.message")).toHaveLength(0);
  });

  it("normalizes lobby chat to a null room and broadcasts it globally", async () => {
    const context = setup();
    await pair(context, "a-left", "a-right");
    await pair(context, "b-left", "b-right");
    const sender = context.sockets.get("a-left");
    if (!sender) throw new Error("missing sender socket");

    sender.receive({
      v: 1,
      type: "chat.send",
      scope: "lobby",
      body: "lobby message"
    });
    await flushEvents();

    expect(context.createChatMessage).toHaveBeenCalledWith(expect.objectContaining({
      scope: "lobby",
      roomId: null,
      senderId: context.users.get("a-left")?.id
    }));
    for (const socket of context.sockets.values()) {
      expect(socket.events("chat.message")).toHaveLength(1);
    }
  });

  function setup() {
    const repository = createMemoryRepository();
    repositories.push(repository);
    const hub = new GameHub(repository);
    hubs.push(hub);
    const users = new Map<string, SessionUser>();
    const sockets = new Map<string, FakeSocket>();
    const createChatMessage = vi.spyOn(repository, "createChatMessage").mockImplementation(async (input) => {
      const sender = [...users.values()].find((candidate) => candidate.id === input.senderId);
      if (!sender) throw new Error("missing chat sender");
      const message: ChatMessage = {
        id: randomUUID(),
        scope: input.scope,
        roomId: input.roomId ?? null,
        sender,
        body: input.body,
        createdAt: new Date().toISOString()
      };
      return message;
    });
    return { repository, hub, users, sockets, createChatMessage };
  }
});

interface ConnectionContext {
  hub: GameHub;
  users: Map<string, SessionUser>;
  sockets: Map<string, FakeSocket>;
}

async function pair(context: ConnectionContext, leftHandle: string, rightHandle: string): Promise<string> {
  const left = connect(context, leftHandle);
  const right = connect(context, rightHandle);
  left.receive({ v: 1, type: "queue.join", mode: "queue" });
  right.receive({ v: 1, type: "queue.join", mode: "queue" });
  await flushEvents();
  const matched = left.latest("queue.matched");
  if (matched?.type !== "queue.matched") throw new Error("expected a match");
  return matched.roomId;
}

function connect(context: ConnectionContext, handle: string): FakeSocket {
  const user = player(handle, context.users.size + 1);
  const socket = new FakeSocket();
  context.users.set(handle, user);
  context.sockets.set(handle, socket);
  context.hub.connect(socket as unknown as WebSocket, {} as IncomingMessage, user);
  return socket;
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

function player(handle: string, ordinal: number): SessionUser {
  return {
    id: `00000000-0000-4000-8000-${ordinal.toString().padStart(12, "0")}`,
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

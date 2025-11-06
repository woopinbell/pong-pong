import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createMemoryRepository } from "@pong-pong/db";
import { parseServerEvent, type ServerEvent, type SessionUser } from "@pong-pong/shared";
import { GameHub } from "./gameHub.js";
import type { GuestSessionUser } from "./guestAccess.js";

describe("GameHub guest isolation", () => {
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

  it("never pairs a guest with a registered user", async () => {
    const { hub } = setup();
    const guestLeft = connect(hub, guest("guest-left", "게스트 1001"));
    const registered = connect(hub, player("registered", "등록 사용자"));

    guestLeft.receive({ v: 1, type: "queue.join", mode: "queue" });
    registered.receive({ v: 1, type: "queue.join", mode: "queue" });
    await flushEvents();
    expect(guestLeft.latest("queue.matched")).toBeUndefined();
    expect(registered.latest("queue.matched")).toBeUndefined();

    const guestRight = connect(hub, guest("guest-right", "게스트 1002"));
    guestRight.receive({ v: 1, type: "queue.join", mode: "queue" });
    await flushEvents();

    expect(guestLeft.latest("queue.matched")).toEqual(
      expect.objectContaining({ opponent: "게스트 1002" })
    );
    expect(guestRight.latest("queue.matched")).toEqual(
      expect.objectContaining({ opponent: "게스트 1001" })
    );
    expect(registered.latest("queue.matched")).toBeUndefined();
  });

  it("moves a waiting guest to an in-memory AI after six seconds", async () => {
    const { hub, repository } = setup();
    const listNpcs = vi.spyOn(repository, "listNpcOpponents");
    const socket = connect(hub, guest("guest-fallback", "게스트 2001"));
    socket.receive({ v: 1, type: "queue.join", mode: "queue" });

    await vi.advanceTimersByTimeAsync(5_999);
    expect(socket.latest("queue.matched")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await flushEvents();

    expect(socket.latest("queue.matched")).toEqual(
      expect.objectContaining({ opponent: "연습 AI" })
    );
    expect(listNpcs).not.toHaveBeenCalled();
  });

  it("rejects guest chat and tournament commands before repository access", async () => {
    const { hub, repository } = setup();
    const chat = vi.spyOn(repository, "createChatMessage");
    const tournament = vi.spyOn(repository, "getTournamentMatch");
    const socket = connect(hub, guest("guest-commands", "게스트 3001"));

    socket.receive({ v: 1, type: "chat.send", scope: "lobby", body: "게스트 채팅" });
    socket.receive({ v: 1, type: "tournament.join", matchId: "match-1" });
    await flushEvents();

    expect(socket.events().filter((event) => event.type === "error")).toEqual([
      expect.objectContaining({ code: "forbidden" }),
      expect.objectContaining({ code: "forbidden" })
    ]);
    expect(chat).not.toHaveBeenCalled();
    expect(tournament).not.toHaveBeenCalled();
  });

  it("returns a transient result without finalizing or rating changes and remembers it for two minutes", async () => {
    const { hub, repository } = setup();
    const finalize = vi.spyOn(repository, "finalizeMatch");
    const leftUser = guest("guest-result-left", "게스트 4001");
    const rightUser = guest("guest-result-right", "게스트 4002");
    const left = connect(hub, leftUser);
    const right = connect(hub, rightUser);

    left.receive({ v: 1, type: "queue.join", mode: "queue" });
    right.receive({ v: 1, type: "queue.join", mode: "queue" });
    await flushEvents();
    const matched = right.latest("queue.matched");
    if (matched?.type !== "queue.matched") throw new Error("expected a guest match");
    left.receive({ v: 1, type: "game.ready", roomId: matched.roomId });
    right.receive({ v: 1, type: "game.ready", roomId: matched.roomId });
    await flushEvents();

    left.terminate();
    await vi.advanceTimersByTimeAsync(15_000);
    await flushEvents();

    expect(finalize).not.toHaveBeenCalled();
    expect(right.latest("game.finished")).toEqual({
      v: 1,
      type: "game.finished",
      result: {
        roomId: matched.roomId,
        matchId: null,
        persisted: false,
        winnerSide: "right",
        leftScore: 0,
        rightScore: 3,
        ratingDelta: 0
      }
    });
    expect(hub.retainedGuestResultCount).toBe(2);

    const recovered = connect(hub, leftUser);
    await flushEvents();
    expect(recovered.latest("game.finished")).toEqual(right.latest("game.finished"));
    recovered.terminate();

    await vi.advanceTimersByTimeAsync(120_001);
    expect(hub.retainedGuestResultCount).toBe(0);
    const expired = connect(hub, leftUser);
    await flushEvents();
    expect(expired.latest("game.finished")).toBeUndefined();
  });

  function setup() {
    const repository = createMemoryRepository();
    repositories.push(repository);
    return { repository, hub: new GameHub(repository) };
  }

  function connect(hub: GameHub, user: SessionUser | GuestSessionUser): FakeSocket {
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
    return this.events().filter((event) => event.type === type).at(-1);
  }

  events(): ServerEvent[] {
    return this.payloads.map((payload) => parseServerEvent(payload));
  }
}

function guest(handle: string, displayName: string): GuestSessionUser {
  return { ...player(handle, displayName), sessionKind: "guest" };
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

async function flushEvents(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

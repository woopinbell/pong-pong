import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createMemoryRepository } from "@pong-pong/db";
import { parseServerEvent, type ServerEvent, type SessionUser } from "@pong-pong/shared";
import { GameHub } from "./gameHub.js";

describe("GameHub tournament boundary", () => {
  const repositories: Array<ReturnType<typeof createMemoryRepository>> = [];
  const hubs: GameHub[] = [];

  afterEach(async () => {
    for (const hub of hubs.splice(0)) hub.close();
    await Promise.all(repositories.splice(0).map((repository) => repository.close()));
  });

  it("rolls back the room when marking the tournament match as started fails", async () => {
    const repository = createMemoryRepository();
    repositories.push(repository);
    vi.spyOn(repository, "getTournamentMatch").mockResolvedValue({
      id: "tournament-match-1",
      tournamentId: "tournament-1",
      round: "semifinal",
      slot: 1,
      status: "ready",
      leftUserId: "left-id",
      rightUserId: "right-id",
      winnerId: null
    });
    const startTournamentMatch = vi.spyOn(repository, "startTournamentMatch")
      .mockRejectedValueOnce(new Error("database start failed"))
      .mockResolvedValueOnce(undefined);
    const hub = new GameHub(repository);
    hubs.push(hub);
    const left = connect(hub, player("left"));
    const right = connect(hub, player("right"));

    left.receive({ v: 1, type: "tournament.join", matchId: "tournament-match-1" });
    right.receive({ v: 1, type: "tournament.join", matchId: "tournament-match-1" });

    await expect.poll(() => startTournamentMatch.mock.calls.length).toBe(1);
    await expect.poll(() => hub.liveStats().activeRooms).toBe(0);
    expect(hub.scheduledRoomCount).toBe(0);

    left.receive({ v: 1, type: "tournament.join", matchId: "tournament-match-1" });
    right.receive({ v: 1, type: "tournament.join", matchId: "tournament-match-1" });

    await expect.poll(() => startTournamentMatch.mock.calls.length).toBe(2);
    expect(hub.liveStats().activeRooms).toBe(1);
    expect(left.latest("queue.matched")).toEqual(expect.objectContaining({ side: "left" }));
    expect(right.latest("queue.matched")).toEqual(expect.objectContaining({ side: "right" }));
  });
});

function connect(hub: GameHub, user: SessionUser): FakeSocket {
  const socket = new FakeSocket();
  hub.connect(socket as unknown as WebSocket, {} as IncomingMessage, user);
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

function player(handle: "left" | "right"): SessionUser {
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

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
    // mockRejectedValueOnce(...).mockResolvedValueOnce(...): 호출될 때마다 다른 결과를 순서대로 내놓도록
    // 예약해둔다 — 첫 호출은 실패, 두 번째 호출부터는 성공. gameHub.ts의 재시도 로직(waitForFinalizationRetry)이
    // 첫 실패 후 정말로 다시 시도해서 결국 성공하는지를 재현하기 위한 설정.
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

    // vi.mocked(fn): 이미 vi.spyOn 등으로 모의 처리된 함수를 다시 받아올 때, 그 반환 타입을 "모의 함수
    // (mock.calls 등의 속성을 가진)"로 좁혀준다 — 타입 단언 없이 .mock.calls에 접근하기 위한 헬퍼.
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

// expect.poll과 달리, 여기서는 가짜 타이머를 "직접 조금씩 전진시키면서" 조건을 확인해야 한다 — 재시도 사이의
// setTimeout 지연 자체가 가짜 타이머로 제어되므로, 시간을 흘려보내는 주체가 테스트 코드 자신이어야 하기 때문
// (expect.poll은 그냥 재확인만 반복할 뿐 시간을 흐르게 하지는 않는다).
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

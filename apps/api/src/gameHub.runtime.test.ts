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

    // expect.poll(콜백): 콜백을 반복 호출해가며 그 반환값이 뒤에 이어붙인 matcher를 만족할 때까지 기다리는
    // vitest API — GameHub 내부 처리는 비동기(await this.repo...)라 소켓에 에러 이벤트가 "언제" 도착할지
    // 정확히 알 수 없을 때, 특정 Promise 하나를 기다리는 대신 "결국 이 상태가 될 때까지" 폴링한다.
    await expect.poll(() => socket.events().filter((event) => event.type === "error")).toEqual([
      expect.objectContaining({ type: "error", code: "rate_limited" })
    ]);
    socket.terminate();
  });

  it("does not expose repository errors through websocket responses", async () => {
    const repository = createMemoryRepository();
    repositories.push(repository);
    vi.spyOn(repository, "createChatMessage").mockRejectedValue(
      new Error("select password_hash from users failed: database.internal:5432")
    );
    const hub = new GameHub(repository);
    const socket = new FakeSocket();
    hub.connect(socket as unknown as WebSocket, {} as IncomingMessage, user());

    socket.receive({ v: 1, type: "chat.send", scope: "lobby", body: "안전한 오류 응답" });

    await expect.poll(() => socket.events().filter((event) => event.type === "error")).toEqual([
      {
        v: 1,
        type: "error",
        code: "internal_error",
        message: "메시지를 처리하지 못했습니다."
      }
    ]);
    expect(JSON.stringify(socket.events())).not.toContain("password_hash");
    expect(JSON.stringify(socket.events())).not.toContain("database.internal");
    socket.terminate();
  });
});

// GameHub가 기대하는 WS 소켓 인터페이스(readyState/bufferedAmount/send/ping/terminate + "message"/"close"
// 이벤트를 내는 EventEmitter)만 최소한으로 흉내 낸 가짜 소켓 — 실제 ws 라이브러리나 네트워크 없이도
// GameHub의 로직을 단위 테스트할 수 있게 해준다.
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

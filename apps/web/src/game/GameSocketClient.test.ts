import { afterEach, describe, expect, it, vi } from "vitest";
import type { WsTicketResponse } from "@pong-pong/shared";
import {
  GameSocketClient,
  type GameSocketHandlers,
  type GameWebSocket
} from "./GameSocketClient";

const ticket = {
  ticket: "a".repeat(43),
  expiresInSeconds: 30,
  protocolVersion: 1
} satisfies WsTicketResponse;

describe("GameSocketClient", () => {
  afterEach(() => vi.useRealTimers());

  it("cancels an unused one-time ticket request before starting another connection", async () => {
    const signals: AbortSignal[] = [];
    const ticketProvider = vi.fn((signal?: AbortSignal) => new Promise<WsTicketResponse>((resolve, reject) => {
      if (!signal) throw new Error("AbortSignal is required");
      signals.push(signal);
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      if (signals.length === 2) resolve(ticket);
    }));
    const sockets: FakeSocket[] = [];
    const client = new GameSocketClient({
      url: "ws://localhost:4000/ws",
      ticketProvider,
      socketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      }
    });

    const first = client.connect({ v: 1, type: "queue.join", mode: "queue" }, handlers());
    const second = client.connect({ v: 1, type: "queue.join", mode: "ai" }, handlers());
    await Promise.all([first, second]);

    expect(signals).toHaveLength(2);
    expect(signals[0].aborted).toBe(true);
    expect(sockets).toHaveLength(1);
    expect(sockets[0].url).toBe(`ws://localhost:4000/ws?ticket=${ticket.ticket}&v=1`);
  });

  it("parses versioned server events through the shared protocol parser", async () => {
    const onEvent = vi.fn();
    const onFailure = vi.fn();
    const socket = new FakeSocket("");
    const client = new GameSocketClient({
      url: "ws://localhost:4000/ws",
      ticketProvider: async () => ticket,
      socketFactory: (url) => {
        socket.url = url;
        return socket;
      }
    });

    await client.connect(
      { v: 1, type: "queue.join", mode: "queue" },
      handlers({ onEvent, onFailure })
    );
    socket.open();
    socket.message(JSON.stringify({
      v: 1,
      type: "queue.matched",
      roomId: "room-1",
      side: "left",
      opponent: "상대 선수"
    }));
    socket.message(JSON.stringify({ type: "queue.matched", roomId: "room-2" }));

    expect(JSON.parse(socket.sent[0])).toEqual({ v: 1, type: "queue.join", mode: "queue" });
    expect(onEvent).toHaveBeenCalledOnce();
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ v: 1, type: "queue.matched" }));
    expect(onFailure).toHaveBeenCalledOnce();
  });

  it("assigns a strictly increasing input sequence to every direction command", async () => {
    const socket = new FakeSocket("");
    const client = new GameSocketClient({
      url: "ws://localhost:4000/ws",
      ticketProvider: async () => ticket,
      socketFactory: () => socket
    });

    await client.connect({ v: 1, type: "queue.join", mode: "queue" }, handlers());
    socket.open();
    expect(client.sendDirection("room-1", -1)).toBe(1);
    expect(client.sendDirection("room-1", 0)).toBe(2);
    expect(client.sendDirection("room-1", 1)).toBe(3);

    expect(socket.sent.slice(1).map((payload) => JSON.parse(payload))).toEqual([
      { v: 1, type: "game.input", roomId: "room-1", inputSeq: 1, direction: -1 },
      { v: 1, type: "game.input", roomId: "room-1", inputSeq: 2, direction: 0 },
      { v: 1, type: "game.input", roomId: "room-1", inputSeq: 3, direction: 1 }
    ]);
  });

  it("uses a fresh ticket to reconnect without sending the original queue command again", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const ticketProvider = vi.fn(async () => ticket);
    const onClosed = vi.fn(() => true);
    const client = new GameSocketClient({
      url: "ws://localhost:4000/ws",
      ticketProvider,
      socketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      }
    });

    await client.connect(
      { v: 1, type: "queue.join", mode: "queue" },
      handlers({ onClosed })
    );
    sockets[0].open();
    expect(sockets[0].sent).toHaveLength(1);

    sockets[0].close();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onClosed).toHaveBeenCalledOnce();
    expect(ticketProvider).toHaveBeenCalledTimes(2);
    expect(sockets).toHaveLength(2);

    sockets[1].open();
    expect(sockets[1].sent).toEqual([]);
    client.close();
  });
});

class FakeSocket implements GameWebSocket {
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {}

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  message(data: unknown): void {
    this.onmessage?.({ data });
  }
}

function handlers(overrides: Partial<GameSocketHandlers> = {}): GameSocketHandlers {
  return {
    onConnecting: vi.fn(),
    onOpen: vi.fn(),
    onEvent: vi.fn(),
    onClosed: vi.fn(),
    onFailure: vi.fn(),
    ...overrides
  };
}

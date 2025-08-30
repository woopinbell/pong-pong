import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import type { AppRepository } from "@pong-pong/db";
import {
  GAME_HEIGHT,
  GAME_WIDTH,
  PADDLE_HEIGHT,
  encodeServerEvent,
  parseClientEvent,
  type GameSnapshot,
  type PlayerSide,
  type ServerEvent,
  type SessionUser
} from "@pong-pong/shared";

type Client = {
  id: string;
  socket: WebSocket;
  user: SessionUser;
  roomId: string | null;
};

type Room = {
  id: string;
  clients: Partial<Record<PlayerSide, Client>>;
  ai: boolean;
  snapshot: GameSnapshot;
};

export class GameHub {
  private readonly clients = new Map<string, Client>();
  private readonly queue: Client[] = [];
  private readonly rooms = new Map<string, Room>();

  constructor(private readonly repo: AppRepository) {}

  connect(socket: WebSocket, _request: IncomingMessage, user: SessionUser): void {
    const client: Client = { id: randomUUID(), socket, user, roomId: null };
    this.clients.set(client.id, client);
    socket.on("message", (payload) => this.receive(client, payload.toString()));
    socket.on("close", () => this.disconnect(client));
    this.broadcastPresence();
  }

  private async receive(client: Client, payload: string): Promise<void> {
    try {
      const event = parseClientEvent(payload);
      if (event.type === "queue.join") this.joinQueue(client, event.mode);
      if (event.type === "queue.leave") this.leaveQueue(client);
      if (event.type === "chat.send") {
        const message = await this.repo.createChatMessage({
          scope: event.scope,
          roomId: event.roomId ?? null,
          senderId: client.user.id,
          body: event.body
        });
        if (event.scope === "match" && event.roomId) {
          this.broadcastRoom(event.roomId, { type: "chat.message", message });
        } else {
          this.broadcastAll({ type: "chat.message", message });
        }
      }
    } catch (error) {
      this.send(client, { type: "error", message: error instanceof Error ? error.message : "메시지를 처리하지 못했습니다." });
    }
  }

  private disconnect(client: Client): void {
    this.leaveQueue(client);
    this.clients.delete(client.id);
    if (client.roomId) {
      const room = this.rooms.get(client.roomId);
      if (room) {
        for (const participant of Object.values(room.clients)) {
          if (participant) participant.roomId = null;
        }
        this.rooms.delete(room.id);
      }
    }
    this.broadcastPresence();
  }

  private joinQueue(client: Client, mode: "queue" | "ai"): void {
    this.leaveQueue(client);
    if (mode === "ai") {
      this.createRoom(client, null, true);
      return;
    }
    const opponent = this.queue.shift();
    if (!opponent) {
      this.queue.push(client);
      this.broadcastPresence();
      return;
    }
    this.createRoom(opponent, client, false);
  }

  private leaveQueue(client: Client): void {
    const index = this.queue.findIndex((queued) => queued.id === client.id);
    if (index >= 0) this.queue.splice(index, 1);
  }

  private createRoom(left: Client, right: Client | null, ai: boolean): void {
    const roomId = randomUUID();
    const room: Room = {
      id: roomId,
      clients: { left, ...(right ? { right } : {}) },
      ai,
      snapshot: {
        roomId,
        phase: "waiting",
        tick: 0,
        leftScore: 0,
        rightScore: 0,
        paddles: {
          left: { y: GAME_HEIGHT / 2 - PADDLE_HEIGHT / 2, dy: 0 },
          right: { y: GAME_HEIGHT / 2 - PADDLE_HEIGHT / 2, dy: 0 }
        },
        ball: { position: { x: GAME_WIDTH / 2, y: GAME_HEIGHT / 2 }, velocity: { x: 7, y: 4 } },
        players: [
          { id: left.user.id, handle: left.user.handle, displayName: left.user.displayName, side: "left", ready: false, ai: false },
          {
            id: right?.user.id ?? "ai-opponent",
            handle: right?.user.handle ?? "ai",
            displayName: right?.user.displayName ?? "연습 AI",
            side: "right",
            ready: ai,
            ai
          }
        ],
        serverTime: new Date().toISOString()
      }
    };
    this.rooms.set(roomId, room);
    left.roomId = roomId;
    if (right) right.roomId = roomId;
    this.send(left, { type: "queue.matched", roomId, side: "left", opponent: right?.user.displayName ?? "연습 AI" });
    if (right) this.send(right, { type: "queue.matched", roomId, side: "right", opponent: left.user.displayName });
    this.broadcastRoom(roomId, { type: "game.snapshot", snapshot: room.snapshot });
    this.broadcastPresence();
  }

  private broadcastPresence(): void {
    this.broadcastAll({ type: "presence.changed", online: this.clients.size, playing: this.rooms.size * 2 });
  }

  private broadcastAll(event: ServerEvent): void {
    for (const client of this.clients.values()) this.send(client, event);
  }

  private broadcastRoom(roomId: string, event: ServerEvent): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    for (const client of Object.values(room.clients)) {
      if (client) this.send(client, event);
    }
  }

  private send(client: Client, event: ServerEvent): void {
    if (client.socket.readyState === WebSocket.OPEN) client.socket.send(encodeServerEvent(event));
  }
}

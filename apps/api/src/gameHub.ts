import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import type { AppRepository } from "@pong-pong/db";
import {
  BALL_RADIUS,
  GAME_HEIGHT,
  GAME_WIDTH,
  PADDLE_HEIGHT,
  TICK_RATE,
  WINNING_SCORE,
  encodeServerEvent,
  parseClientEvent,
  type GameFinished,
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

type QueueEntry = {
  client: Client;
  queuedAt: number;
};

type Room = {
  id: string;
  clients: Partial<Record<PlayerSide, Client>>;
  ai: boolean;
  ready: Partial<Record<PlayerSide, boolean>>;
  snapshot: GameSnapshot;
  timer: NodeJS.Timeout | null;
};

export class GameHub {
  private readonly clients = new Map<string, Client>();
  private readonly queue: QueueEntry[] = [];
  private readonly rooms = new Map<string, Room>();
  private readonly waitSamples: number[] = [];

  constructor(private readonly repo: AppRepository) {}

  connect(socket: WebSocket, request: IncomingMessage, user: SessionUser, pendingPayloads: string[] = []): void {
    const client: Client = { id: randomUUID(), socket, user, roomId: null };
    this.clients.set(client.id, client);
    socket.on("message", (payload) => this.receive(client, payload.toString()));
    socket.on("close", () => this.disconnect(client));
    this.broadcastPresence();
    for (const payload of pendingPayloads) {
      this.receive(client, payload).catch(() => undefined);
    }
  }

  private async receive(client: Client, payload: string): Promise<void> {
    try {
      const event = parseClientEvent(payload);
      if (event.type === "queue.join") this.joinQueue(client, event.mode);
      if (event.type === "queue.leave") this.leaveQueue(client);
      if (event.type === "game.ready") this.markReady(client, event.roomId);
      if (event.type === "game.pause") this.pauseRoom(client, event.roomId);
      if (event.type === "game.resume") this.resumeRoom(client, event.roomId);
      if (event.type === "game.input") this.applyInput(client, event.roomId, event.direction);
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
        this.finishRoom(room, client === room.clients.left ? "right" : "left").catch(() => undefined);
      }
    }
    this.broadcastPresence();
  }

  private joinQueue(client: Client, mode: "queue" | "ai"): void {
    this.leaveQueue(client);
    this.pruneQueue();
    if (mode === "ai") {
      this.createRoom(client, null, true);
      return;
    }
    const opponentIndex = this.findClosestQueuedOpponent(client);
    if (opponentIndex < 0) {
      this.queue.push({ client, queuedAt: Date.now() });
      this.broadcastPresence();
      return;
    }
    const [opponent] = this.queue.splice(opponentIndex, 1);
    this.recordWaitSample(opponent.queuedAt);
    this.createRoom(opponent.client, client, false);
  }

  private findClosestQueuedOpponent(client: Client): number {
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < this.queue.length; index += 1) {
      const candidate = this.queue[index];
      const distance = Math.abs(candidate.client.user.rating - client.user.rating);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
    return bestIndex;
  }

  private leaveQueue(client: Client): void {
    const index = this.queue.findIndex((queued) => queued.client.id === client.id);
    if (index >= 0) this.queue.splice(index, 1);
  }

  private pruneQueue(): void {
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      if (this.queue[index].client.socket.readyState !== WebSocket.OPEN) {
        this.queue.splice(index, 1);
      }
    }
  }

  liveStats() {
    const playingPlayers = [...this.rooms.values()].reduce((count, room) => count + Object.values(room.clients).filter(Boolean).length, 0);
    const averageWaitSeconds = this.waitSamples.length === 0
      ? null
      : Math.round(this.waitSamples.reduce((sum, value) => sum + value, 0) / this.waitSamples.length);
    return {
      onlinePlayers: this.clients.size,
      playingPlayers,
      queuedPlayers: this.queue.length,
      activeRooms: this.rooms.size,
      averageWaitSeconds
    };
  }

  private recordWaitSample(queuedAt: number): void {
    const seconds = Math.max(0, Math.round((Date.now() - queuedAt) / 1000));
    this.waitSamples.push(seconds);
    if (this.waitSamples.length > 20) {
      this.waitSamples.shift();
    }
  }

  private createRoom(left: Client, right: Client | null, ai: boolean): void {
    const roomId = randomUUID();
    const room: Room = {
      id: roomId,
      clients: { left, ...(right ? { right } : {}) },
      ai,
      ready: {},
      timer: null,
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
        ball: {
          position: { x: GAME_WIDTH / 2, y: GAME_HEIGHT / 2 },
          velocity: { x: 7, y: 4 }
        },
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

  private markReady(client: Client, roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const side = sideFor(room, client);
    if (!side) return;
    room.ready[side] = true;
    for (const player of room.snapshot.players) {
      if (player.side === side) player.ready = true;
    }
    if (room.ai) room.ready.right = true;
    if (room.ready.left && room.ready.right && !room.timer) {
      room.snapshot.phase = "playing";
      room.timer = setInterval(() => this.tick(room).catch(() => undefined), 1000 / TICK_RATE);
    }
    this.broadcastRoom(roomId, { type: "game.snapshot", snapshot: room.snapshot });
  }

  private applyInput(client: Client, roomId: string, direction: -1 | 0 | 1): void {
    const room = this.rooms.get(roomId);
    if (!room || room.snapshot.phase !== "playing") return;
    const side = sideFor(room, client);
    if (side) room.snapshot.paddles[side].dy = direction;
  }

  private pauseRoom(client: Client, roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room || room.snapshot.phase !== "playing" || !sideFor(room, client)) return;
    if (room.timer) clearInterval(room.timer);
    room.timer = null;
    room.snapshot.phase = "paused";
    room.snapshot.serverTime = new Date().toISOString();
    this.broadcastRoom(roomId, { type: "game.snapshot", snapshot: room.snapshot });
  }

  private resumeRoom(client: Client, roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room || room.snapshot.phase !== "paused" || !sideFor(room, client)) return;
    room.snapshot.phase = "playing";
    room.snapshot.serverTime = new Date().toISOString();
    if (!room.timer) {
      room.timer = setInterval(() => this.tick(room).catch(() => undefined), 1000 / TICK_RATE);
    }
    this.broadcastRoom(roomId, { type: "game.snapshot", snapshot: room.snapshot });
  }

  private async tick(room: Room): Promise<void> {
    const state = room.snapshot;
    if (state.phase !== "playing") return;
    state.tick += 1;
    state.serverTime = new Date().toISOString();

    const speed = 13;
    state.paddles.left.y = clamp(state.paddles.left.y + state.paddles.left.dy * speed, 16, GAME_HEIGHT - PADDLE_HEIGHT - 16);
    if (room.ai) {
      const center = state.paddles.right.y + PADDLE_HEIGHT / 2;
      state.paddles.right.dy = state.ball.position.y > center + 14 ? 1 : state.ball.position.y < center - 14 ? -1 : 0;
    }
    state.paddles.right.y = clamp(state.paddles.right.y + state.paddles.right.dy * speed, 16, GAME_HEIGHT - PADDLE_HEIGHT - 16);

    state.ball.position.x += state.ball.velocity.x;
    state.ball.position.y += state.ball.velocity.y;
    if (state.ball.position.y < BALL_RADIUS || state.ball.position.y > GAME_HEIGHT - BALL_RADIUS) {
      state.ball.velocity.y *= -1;
    }
    collidePaddle(state, "left", 32);
    collidePaddle(state, "right", GAME_WIDTH - 32);

    if (state.ball.position.x < 0) {
      state.rightScore += 1;
      resetBall(state, -1);
    }
    if (state.ball.position.x > GAME_WIDTH) {
      state.leftScore += 1;
      resetBall(state, 1);
    }
    this.broadcastRoom(room.id, { type: "game.snapshot", snapshot: state });

    if (state.leftScore >= WINNING_SCORE || state.rightScore >= WINNING_SCORE || state.tick >= TICK_RATE * 45) {
      await this.finishRoom(room, state.leftScore >= state.rightScore ? "left" : "right");
    }
  }

  private async finishRoom(room: Room, winnerSide: PlayerSide): Promise<void> {
    if (room.timer) clearInterval(room.timer);
    room.timer = null;
    room.snapshot.phase = "finished";
    const winner = winnerSide === "left" ? room.clients.left : room.clients.right;
    const loser = winnerSide === "left" ? room.clients.right : room.clients.left;
    const matchId = await this.repo.createMatch({
      mode: room.ai ? "ai" : "queue",
      winnerId: winner?.user.id ?? null,
      loserId: loser?.user.id ?? null,
      scoreLeft: room.snapshot.leftScore,
      scoreRight: room.snapshot.rightScore
    });
    const result: GameFinished = {
      roomId: room.id,
      matchId,
      winnerSide,
      leftScore: room.snapshot.leftScore,
      rightScore: room.snapshot.rightScore,
      ratingDelta: 16
    };
    this.broadcastRoom(room.id, { type: "game.finished", result });
    for (const client of Object.values(room.clients)) {
      if (client) client.roomId = null;
    }
    this.rooms.delete(room.id);
    this.broadcastPresence();
  }

  private broadcastPresence(): void {
    this.broadcastAll({
      type: "presence.changed",
      online: this.clients.size,
      playing: this.rooms.size * 2
    });
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
    if (client.socket.readyState === WebSocket.OPEN) {
      client.socket.send(encodeServerEvent(event));
    }
  }
}

function sideFor(room: Room, client: Client): PlayerSide | null {
  if (room.clients.left?.id === client.id) return "left";
  if (room.clients.right?.id === client.id) return "right";
  return null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function resetBall(state: GameSnapshot, xDirection: 1 | -1): void {
  state.ball.position = { x: GAME_WIDTH / 2, y: GAME_HEIGHT / 2 };
  state.ball.velocity = { x: 7 * xDirection, y: state.tick % 2 === 0 ? 4 : -4 };
}

function collidePaddle(state: GameSnapshot, side: PlayerSide, x: number): void {
  const paddle = state.paddles[side];
  const ball = state.ball;
  const withinY = ball.position.y >= paddle.y && ball.position.y <= paddle.y + PADDLE_HEIGHT;
  const withinX = side === "left" ? ball.position.x - BALL_RADIUS <= x + 18 : ball.position.x + BALL_RADIUS >= x - 18;
  if (withinX && withinY && Math.sign(ball.velocity.x) === (side === "left" ? -1 : 1)) {
    ball.velocity.x *= -1.04;
    const offset = (ball.position.y - (paddle.y + PADDLE_HEIGHT / 2)) / (PADDLE_HEIGHT / 2);
    ball.velocity.y = offset * 7;
  }
}

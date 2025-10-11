import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import type { AppRepository } from "@pong-pong/db";
import {
  encodeServerEvent,
  parseClientEvent,
  type GameFinished,
  type GameSnapshot,
  type MatchMode,
  type PlayerSide,
  type PublicUser,
  type ServerEvent,
  type SessionUser
} from "@pong-pong/shared";
import { PongAi } from "./game/pongAi";
import { PongSimulation, type PongSimulationState } from "./game/pongSimulation";

type Client = {
  id: string;
  socket: WebSocket;
  user: SessionUser;
  roomId: string | null;
  lastInputSequenceByRoom: Map<string, number>;
};

type VersionlessServerEvent = ServerEvent extends infer Event
  ? Event extends { v: 1 }
    ? Omit<Event, "v">
    : never
  : never;

type QueueEntry = {
  client: Client;
  queuedAt: number;
  npcFallbackTimer: NodeJS.Timeout | null;
};

type Room = {
  id: string;
  clients: Partial<Record<PlayerSide, Client>>;
  ai: boolean;
  ready: Partial<Record<PlayerSide, boolean>>;
  snapshot: GameSnapshot;
  timer: NodeJS.Timeout | null;
  mode: MatchMode;
  tournamentMatchId: string | null;
  npcUser: PublicUser | null;
  simulation: PongSimulationState;
  aiController: PongAi | null;
  finishing: Promise<void> | null;
};

const NPC_QUEUE_FALLBACK_MS = 6000;
const SIMULATION_TIMESTEP_MS = 50;

export class GameHub {
  private readonly clients = new Map<string, Client>();
  private readonly queue: QueueEntry[] = [];
  private readonly rooms = new Map<string, Room>();
  private readonly tournamentWaiters = new Map<string, Client[]>();
  private readonly waitSamples: number[] = [];

  constructor(private readonly repo: AppRepository) {}

  connect(socket: WebSocket, request: IncomingMessage, user: SessionUser, pendingPayloads: string[] = []): void {
    const client: Client = {
      id: randomUUID(),
      socket,
      user,
      roomId: null,
      lastInputSequenceByRoom: new Map()
    };
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
      if (event.type === "queue.join") await this.joinQueue(client, event.mode);
      if (event.type === "queue.leave") this.leaveQueue(client);
      if (event.type === "tournament.join") await this.joinTournamentMatch(client, event.matchId);
      if (event.type === "game.ready") this.markReady(client, event.roomId);
      if (event.type === "game.pause") this.pauseRoom(client, event.roomId);
      if (event.type === "game.resume") this.resumeRoom(client, event.roomId);
      if (event.type === "game.input") this.applyInput(client, event.roomId, event.inputSeq, event.direction);
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
      this.send(client, {
        type: "error",
        code: "invalid_event",
        message: error instanceof Error ? error.message : "메시지를 처리하지 못했습니다."
      });
    }
  }

  private disconnect(client: Client): void {
    this.leaveQueue(client);
    this.leaveTournamentWaiters(client);
    this.clients.delete(client.id);
    if (client.roomId) {
      const room = this.rooms.get(client.roomId);
      if (room) {
        this.finishRoom(room, client === room.clients.left ? "right" : "left").catch(() => undefined);
      }
    }
    this.broadcastPresence();
  }

  private async joinQueue(client: Client, mode: "queue" | "ai"): Promise<void> {
    this.leaveQueue(client);
    this.pruneQueue();
    if (mode === "ai") {
      this.createRoom(client, null, { ai: true, mode: "ai" });
      return;
    }
    const opponentIndex = this.findClosestQueuedOpponent(client);
    if (opponentIndex < 0) {
      const entry: QueueEntry = { client, queuedAt: Date.now(), npcFallbackTimer: null };
      entry.npcFallbackTimer = setTimeout(() => {
        this.matchQueuedClientWithNpc(entry).catch((error) => {
          this.send(client, {
            type: "error",
            code: "internal_error",
            message: error instanceof Error ? error.message : "AI 상대를 찾지 못했습니다."
          });
        });
      }, NPC_QUEUE_FALLBACK_MS);
      this.queue.push(entry);
      this.broadcastPresence();
      return;
    }
    const [opponent] = this.queue.splice(opponentIndex, 1);
    clearQueueTimer(opponent);
    this.recordWaitSample(opponent.queuedAt);
    this.createRoom(opponent.client, client, { ai: false, mode: "queue" });
  }

  private async matchQueuedClientWithNpc(entry: QueueEntry): Promise<void> {
    const index = this.queue.findIndex((queued) => queued.client.id === entry.client.id);
    if (index < 0 || entry.client.socket.readyState !== WebSocket.OPEN || entry.client.roomId) return;
    const npc = await this.findClosestNpc(entry.client);
    if (!npc) return;
    const [queued] = this.queue.splice(index, 1);
    clearQueueTimer(queued);
    this.recordWaitSample(queued.queuedAt);
    this.createRoom(queued.client, null, { ai: true, mode: "queue", npc });
  }

  private async findClosestNpc(client: Client): Promise<PublicUser | null> {
    const npcs = await this.repo.listNpcOpponents();
    let closest: PublicUser | null = null;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (const npc of npcs) {
      const distance = Math.abs(npc.rating - client.user.rating);
      if (distance < closestDistance) {
        closest = npc;
        closestDistance = distance;
      }
    }
    return closest;
  }

  private async joinTournamentMatch(client: Client, matchId: string): Promise<void> {
    this.leaveQueue(client);
    this.leaveTournamentWaiters(client);
    const match = await this.repo.getTournamentMatch(matchId);
    if (!match || match.status !== "ready") {
      this.send(client, { type: "error", code: "not_found", message: "참가할 수 없는 토너먼트 경기입니다." });
      return;
    }
    if (match.leftUserId !== client.user.id && match.rightUserId !== client.user.id) {
      this.send(client, { type: "error", code: "forbidden", message: "토너먼트 경기 참가자가 아닙니다." });
      return;
    }
    if (client.roomId) {
      this.send(client, { type: "error", code: "forbidden", message: "이미 진행 중인 경기가 있습니다." });
      return;
    }
    const waiters = this.tournamentWaiters.get(matchId) ?? [];
    const existing = waiters.find((waiter) => waiter.user.id === client.user.id);
    if (existing) return;
    const opponent = waiters.find((waiter) => waiter.user.id === match.leftUserId || waiter.user.id === match.rightUserId);
    if (!opponent) {
      this.tournamentWaiters.set(matchId, [...waiters, client]);
      return;
    }
    this.tournamentWaiters.delete(matchId);
    const left = client.user.id === match.leftUserId ? client : opponent;
    const right = left === client ? opponent : client;
    const roomId = this.createRoom(left, right, { ai: false, mode: "tournament", tournamentMatchId: matchId });
    await this.repo.startTournamentMatch(matchId, roomId);
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
    if (index >= 0) {
      const [entry] = this.queue.splice(index, 1);
      clearQueueTimer(entry);
    }
  }

  private leaveTournamentWaiters(client: Client): void {
    for (const [matchId, waiters] of this.tournamentWaiters.entries()) {
      const next = waiters.filter((waiter) => waiter.id !== client.id);
      if (next.length === 0) this.tournamentWaiters.delete(matchId);
      else this.tournamentWaiters.set(matchId, next);
    }
  }

  private pruneQueue(): void {
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      if (this.queue[index].client.socket.readyState !== WebSocket.OPEN) {
        const [entry] = this.queue.splice(index, 1);
        clearQueueTimer(entry);
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

  onlinePlayers(): PublicUser[] {
    const users = new Map<string, PublicUser>();
    for (const client of this.clients.values()) {
      const { email: _email, ...user } = client.user;
      users.set(user.id, { ...user, online: true });
    }
    return [...users.values()].sort((left, right) => right.rating - left.rating || left.displayName.localeCompare(right.displayName));
  }

  private recordWaitSample(queuedAt: number): void {
    const seconds = Math.max(0, Math.round((Date.now() - queuedAt) / 1000));
    this.waitSamples.push(seconds);
    if (this.waitSamples.length > 20) {
      this.waitSamples.shift();
    }
  }

  private createRoom(left: Client, right: Client | null, options: { ai: boolean; mode: MatchMode; tournamentMatchId?: string | null; npc?: PublicUser | null }): string {
    const roomId = randomUUID();
    const npcUser = options.npc ?? null;
    const rightPlayer = right?.user ?? npcUser;
    const simulation = PongSimulation.initialState();
    const room: Room = {
      id: roomId,
      clients: { left, ...(right ? { right } : {}) },
      ai: options.ai,
      ready: {},
      timer: null,
      mode: options.mode,
      tournamentMatchId: options.tournamentMatchId ?? null,
      npcUser,
      simulation,
      aiController: options.ai ? new PongAi(roomId, npcUser?.rating ?? 1200) : null,
      finishing: null,
      snapshot: {
        roomId,
        tick: 0,
        sequence: 0,
        serverTimeMs: Date.now(),
        state: {
          phase: "waiting",
          leftScore: 0,
          rightScore: 0,
          paddles: {
            left: { y: simulation.paddles.left.y, dy: simulation.paddles.left.direction },
            right: { y: simulation.paddles.right.y, dy: simulation.paddles.right.direction }
          },
          ball: {
            position: { ...simulation.ball.position },
            velocity: { ...simulation.ball.velocity }
          },
          players: [
            { id: left.user.id, handle: left.user.handle, displayName: left.user.displayName, side: "left", ready: false, ai: false },
            {
              id: rightPlayer?.id ?? "ai-opponent",
              handle: rightPlayer?.handle ?? "ai",
              displayName: rightPlayer?.displayName ?? "연습 AI",
              side: "right",
              ready: options.ai,
              ai: options.ai
            }
          ]
        }
      }
    };
    this.rooms.set(roomId, room);
    left.roomId = roomId;
    if (right) right.roomId = roomId;
    this.send(left, { type: "queue.matched", roomId, side: "left", opponent: rightPlayer?.displayName ?? "연습 AI" });
    if (right) this.send(right, { type: "queue.matched", roomId, side: "right", opponent: left.user.displayName });
    this.broadcastSnapshot(room);
    this.broadcastPresence();
    return roomId;
  }

  private markReady(client: Client, roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const side = sideFor(room, client);
    if (!side) return;
    room.ready[side] = true;
    for (const player of room.snapshot.state.players) {
      if (player.side === side) player.ready = true;
    }
    if (room.ai) room.ready.right = true;
    if (room.ready.left && room.ready.right && !room.timer) {
      room.snapshot.state.phase = "playing";
      room.timer = setInterval(() => this.tick(room).catch(() => undefined), SIMULATION_TIMESTEP_MS);
    }
    this.broadcastSnapshot(room);
  }

  private applyInput(client: Client, roomId: string, inputSeq: number, direction: -1 | 0 | 1): void {
    const room = this.rooms.get(roomId);
    if (!room || room.snapshot.state.phase !== "playing") return;
    const side = sideFor(room, client);
    if (!side) return;
    const previousSequence = client.lastInputSequenceByRoom.get(roomId) ?? -1;
    if (inputSeq <= previousSequence) return;
    client.lastInputSequenceByRoom.set(roomId, inputSeq);
    room.snapshot.state.paddles[side].dy = direction;
  }

  private pauseRoom(client: Client, roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room || room.snapshot.state.phase !== "playing" || !sideFor(room, client)) return;
    if (room.timer) clearInterval(room.timer);
    room.timer = null;
    room.snapshot.state.phase = "paused";
    this.broadcastSnapshot(room);
  }

  private resumeRoom(client: Client, roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room || room.snapshot.state.phase !== "paused" || !sideFor(room, client)) return;
    room.snapshot.state.phase = "playing";
    if (!room.timer) {
      room.timer = setInterval(() => this.tick(room).catch(() => undefined), SIMULATION_TIMESTEP_MS);
    }
    this.broadcastSnapshot(room);
  }

  private async tick(room: Room): Promise<void> {
    if (room.snapshot.state.phase !== "playing") return;
    const rightDirection = room.aiController
      ? room.aiController.nextDirection(room.simulation)
      : room.snapshot.state.paddles.right.dy;
    room.simulation = PongSimulation.step(room.simulation, {
      left: room.snapshot.state.paddles.left.dy,
      right: rightDirection
    }, SIMULATION_TIMESTEP_MS);
    syncSnapshot(room);
    this.broadcastSnapshot(room);

    if (room.simulation.phase === "finished" && room.simulation.winnerSide) {
      await this.finishRoom(room, room.simulation.winnerSide);
    }
  }

  private finishRoom(room: Room, winnerSide: PlayerSide): Promise<void> {
    if (room.finishing) return room.finishing;
    const finalization = this.finalizeRoom(room, winnerSide);
    room.finishing = finalization;
    void finalization.catch(() => {
      if (room.finishing === finalization) room.finishing = null;
    });
    return finalization;
  }

  private async finalizeRoom(room: Room, winnerSide: PlayerSide): Promise<void> {
    if (room.timer) clearInterval(room.timer);
    room.timer = null;
    room.snapshot.state.phase = "finished";
    const leftUser = room.clients.left?.user ?? null;
    const rightUser = room.clients.right?.user ?? room.npcUser ?? null;
    const winner = winnerSide === "left" ? leftUser : rightUser;
    const loser = winnerSide === "left" ? rightUser : leftUser;
    const finalized = await this.repo.finalizeMatch({
      resultKey: `room:${room.id}:finished`,
      mode: room.mode,
      winnerId: winner?.id ?? null,
      loserId: loser?.id ?? null,
      scoreLeft: room.snapshot.state.leftScore,
      scoreRight: room.snapshot.state.rightScore,
      ...(room.tournamentMatchId ? {
        tournament: {
          tournamentMatchId: room.tournamentMatchId,
          roomId: room.id
        }
      } : {})
    });
    const result: GameFinished = {
      roomId: room.id,
      matchId: finalized.matchId,
      persisted: true,
      winnerSide,
      leftScore: room.snapshot.state.leftScore,
      rightScore: room.snapshot.state.rightScore,
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

  private broadcastAll(event: VersionlessServerEvent): void {
    for (const client of this.clients.values()) this.send(client, event);
  }

  private broadcastRoom(roomId: string, event: VersionlessServerEvent): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    for (const client of Object.values(room.clients)) {
      if (client) this.send(client, event);
    }
  }

  private broadcastSnapshot(room: Room): void {
    room.snapshot.sequence += 1;
    room.snapshot.serverTimeMs = Date.now();
    this.broadcastRoom(room.id, { type: "game.snapshot", snapshot: room.snapshot });
  }

  private send(client: Client, event: VersionlessServerEvent): void {
    if (client.socket.readyState === WebSocket.OPEN) {
      client.socket.send(encodeServerEvent({ ...event, v: 1 } as ServerEvent));
    }
  }
}

function sideFor(room: Room, client: Client): PlayerSide | null {
  if (room.clients.left?.id === client.id) return "left";
  if (room.clients.right?.id === client.id) return "right";
  return null;
}

function clearQueueTimer(entry: QueueEntry): void {
  if (entry.npcFallbackTimer) {
    clearTimeout(entry.npcFallbackTimer);
    entry.npcFallbackTimer = null;
  }
}

function syncSnapshot(room: Room): void {
  const state = room.simulation;
  room.snapshot.tick = state.tick;
  room.snapshot.state.leftScore = state.leftScore;
  room.snapshot.state.rightScore = state.rightScore;
  room.snapshot.state.paddles.left = {
    y: state.paddles.left.y,
    dy: state.paddles.left.direction
  };
  room.snapshot.state.paddles.right = {
    y: state.paddles.right.y,
    dy: state.paddles.right.direction
  };
  room.snapshot.state.ball = {
    position: { ...state.ball.position },
    velocity: { ...state.ball.velocity }
  };
}

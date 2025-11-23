import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import type { AppRepository, MatchResultRepository } from "@pong-pong/db";
import {
  encodeServerEvent,
  parseClientEvent,
  type GameFinished,
  type GameSnapshot,
  type MatchMode,
  type PlayerSide,
  type PublicUser,
  type ServerEvent,
  type SessionUser,
  WINNING_SCORE
} from "@pong-pong/shared";
import { DEFAULT_TIMESTEP_MS } from "./game/fixedStepScheduler.js";
import { ConnectionHeartbeat } from "./game/heartbeat.js";
import { InputGate } from "./game/inputGate.js";
import { HARD_BUFFERED_AMOUNT_BYTES, LatestSnapshotBuffer } from "./game/latestSnapshotBuffer.js";
import { Matchmaker, type MatchmakingPlayer } from "./game/matchmaker.js";
import { PongAi } from "./game/pongAi.js";
import { PongSimulation, type PongSimulationState } from "./game/pongSimulation.js";
import { RoomSession } from "./game/roomSession.js";
import { SharedRoomScheduler } from "./game/sharedRoomScheduler.js";
import type { GuestSessionUser } from "./guestAccess.js";

type ConnectedUser = SessionUser | GuestSessionUser;

type Client = {
  id: string;
  socket: WebSocket;
  user: ConnectedUser;
  roomId: string | null;
  heartbeat: ConnectionHeartbeat;
  snapshots: LatestSnapshotBuffer;
  requestId: string | null;
};

type VersionlessServerEvent = ServerEvent extends infer Event
  ? Event extends { v: 1 }
    ? Omit<Event, "v">
    : never
  : never;

type QueueEntry = {
  client: Client;
  queuedAtMs: number;
  npcFallbackTimer: NodeJS.Timeout | null;
};

type GameHubRepository = Pick<
  AppRepository,
  | "createChatMessage"
  | "getTournamentMatch"
  | "listNpcOpponents"
  | "startTournamentMatch"
> & MatchResultRepository;

type Room = {
  id: string;
  clients: Partial<Record<PlayerSide, Client>>;
  ai: boolean;
  ready: Partial<Record<PlayerSide, boolean>>;
  snapshot: GameSnapshot;
  mode: MatchMode;
  tournamentMatchId: string | null;
  npcUser: PublicUser | null;
  simulation: PongSimulationState;
  aiController: PongAi | null;
  finishing: Promise<void> | null;
  session: RoomSession;
  reconnectTimer: NodeJS.Timeout | null;
  disconnectedUsers: Partial<Record<PlayerSide, string>>;
  guest: boolean;
};

const MAX_MATCHMAKING_RATING_DIFFERENCE = 200;
const SIMULATION_TIMESTEP_MS = DEFAULT_TIMESTEP_MS;
const CONNECTION_REPLACED_CLOSE_CODE = 4001;
const CONNECTION_REPLACED_REASON = "connection replaced";
const GUEST_RESULT_RETENTION_MS = 2 * 60 * 1_000;
const INVALID_EVENT_MESSAGE = "올바르지 않은 메시지입니다.";
const INTERNAL_ERROR_MESSAGE = "메시지를 처리하지 못했습니다.";

export interface DrainResult {
  drained: boolean;
  activeRooms: number;
}

export interface GameHubObserver {
  roomCreated?(context: {
    roomId: string;
    requestIds: string[];
    userIds: string[];
  }): void;
  reconnect?(context: {
    outcome: "success" | "expired";
    roomId: string;
    requestId?: string;
    userId?: string;
  }): void;
  matchFinalized?(context: {
    outcome: "success" | "failure";
    persistence: "database" | "memory";
    roomId: string;
    matchId: string | null;
    userIds: string[];
  }): void;
  snapshotDelivered?(delayMs: number): void;
  snapshotDropped?(reason: "replaced" | "connection_closed" | "congestion"): void;
}

export class GameHub {
  private readonly clients = new Map<string, Client>();
  private readonly clientsByUser = new Map<string, Client>();
  private readonly queueEntries = new Map<string, QueueEntry>();
  private readonly matchmaker = new Matchmaker({
    clock: () => Date.now(),
    maxRatingDifference: MAX_MATCHMAKING_RATING_DIFFERENCE
  });
  private readonly rooms = new Map<string, Room>();
  private readonly tournamentWaiters = new Map<string, Client[]>();
  private readonly waitSamples: number[] = [];
  private readonly inputGate = new InputGate();
  private readonly roomScheduler = new SharedRoomScheduler();
  private readonly recentGuestResults = new Map<string, {
    result: GameFinished;
    expiresAtMs: number;
    cleanupTimer: NodeJS.Timeout;
  }>();
  private acceptingMatches = true;
  private drainWaiter: {
    promise: Promise<DrainResult>;
    resolve: (result: DrainResult) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  constructor(
    private readonly repo: GameHubRepository,
    private readonly observer: GameHubObserver = {}
  ) {}

  get retainedGuestResultCount(): number {
    return this.recentGuestResults.size;
  }

  get scheduledRoomCount(): number {
    return this.roomScheduler.activeRooms;
  }

  connect(
    socket: WebSocket,
    _request: IncomingMessage,
    user: ConnectedUser,
    pendingPayloads: string[] = [],
    requestId: string | null = null
  ): void {
    const heartbeat = new ConnectionHeartbeat({
      ping: () => {
        if (socket.readyState === WebSocket.OPEN) socket.ping();
      },
      terminate: () => socket.terminate()
    });
    const client: Client = {
      id: randomUUID(),
      socket,
      user,
      roomId: null,
      heartbeat,
      snapshots: new LatestSnapshotBuffer(socket, {
        onDelivered: (delayMs) => this.observer.snapshotDelivered?.(delayMs),
        onDropped: (reason) => this.observer.snapshotDropped?.(reason)
      }),
      requestId
    };
    const previous = this.clientsByUser.get(user.id);
    this.clients.set(client.id, client);
    this.clientsByUser.set(user.id, client);
    socket.on("message", (payload) => this.receive(client, payload.toString()));
    socket.on("pong", () => heartbeat.acknowledge());
    socket.on("close", () => this.disconnect(client));
    if (previous) {
      this.replaceConnection(previous, client);
      if (!client.roomId) this.sendRecentGuestResult(client);
    } else if (!this.recoverConnection(client)) {
      this.sendRecentGuestResult(client);
    }
    if (this.clients.get(client.id) === client && socket.readyState === WebSocket.OPEN) {
      heartbeat.start();
    }
    this.broadcastPresence();
    for (const payload of pendingPayloads) {
      this.receive(client, payload).catch(() => undefined);
    }
  }

  private async receive(client: Client, payload: string): Promise<void> {
    if (this.clients.get(client.id) !== client) return;
    let event: ReturnType<typeof parseClientEvent>;
    try {
      event = parseClientEvent(payload);
    } catch {
      this.send(client, {
        type: "error",
        code: "invalid_event",
        message: INVALID_EVENT_MESSAGE
      });
      return;
    }

    try {
      if (isGuest(client.user) && (event.type === "chat.send" || event.type === "tournament.join")) {
        this.send(client, {
          type: "error",
          code: "forbidden",
          message: "게스트 계정에서는 사용할 수 없는 기능입니다."
        });
        return;
      }
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
    } catch {
      this.send(client, {
        type: "error",
        code: "internal_error",
        message: INTERNAL_ERROR_MESSAGE
      });
    }
  }

  private disconnect(client: Client): void {
    if (!this.clients.has(client.id)) return;
    client.heartbeat.stop();
    client.snapshots.close();
    this.leaveQueue(client);
    this.leaveTournamentWaiters(client);
    this.clients.delete(client.id);
    if (this.clientsByUser.get(client.user.id)?.id === client.id) {
      this.clientsByUser.delete(client.user.id);
    }
    this.inputGate.releaseUser(client.user.id);
    if (client.roomId) {
      const room = this.rooms.get(client.roomId);
      const side = room ? sideFor(room, client) : null;
      if (room && side) this.reserveRoomSide(room, side, client.user.id);
    }
    this.broadcastPresence();
  }

  private replaceConnection(previous: Client, replacement: Client): void {
    previous.heartbeat.stop();
    previous.snapshots.close();
    this.leaveQueue(previous);
    this.leaveTournamentWaiters(previous);
    this.clients.delete(previous.id);
    this.inputGate.releaseUser(previous.user.id);

    if (previous.roomId) {
      const room = this.rooms.get(previous.roomId);
      const side = room ? sideFor(room, previous) : null;
      if (room && side) {
        room.clients[side] = replacement;
        replacement.roomId = room.id;
        previous.roomId = null;
        this.sendMatchContext(replacement, room, side);
        this.send(replacement, { type: "game.snapshot", snapshot: room.snapshot });
      }
    }

    if (previous.socket.readyState === WebSocket.OPEN) {
      previous.socket.close(CONNECTION_REPLACED_CLOSE_CODE, CONNECTION_REPLACED_REASON);
    }
  }

  private recoverConnection(client: Client): boolean {
    const nowMs = Date.now();
    for (const room of this.rooms.values()) {
      for (const side of ["left", "right"] as const) {
        if (room.disconnectedUsers[side] !== client.user.id) continue;
        if (!room.session.reconnect(side, nowMs)) continue;

        const disconnected = room.clients[side];
        if (disconnected) disconnected.roomId = null;
        room.clients[side] = client;
        client.roomId = room.id;
        delete room.disconnectedUsers[side];
        this.sendMatchContext(client, room, side);
        this.observer.reconnect?.({
          outcome: "success",
          roomId: room.id,
          requestId: client.requestId ?? undefined,
          userId: client.user.id
        });

        if (room.session.state === "reconnecting") {
          this.send(client, { type: "game.snapshot", snapshot: room.snapshot });
        } else {
          this.clearReconnectTimer(room);
          room.snapshot.state.phase = room.session.state;
          if (room.session.state === "playing") this.startRoomScheduler(room);
          this.broadcastSnapshot(room);
        }
        return true;
      }
    }
    return false;
  }

  private reserveRoomSide(room: Room, side: PlayerSide, userId: string): void {
    if (room.finishing || room.session.state === "finished") return;
    room.session.disconnect(side, Date.now());
    room.disconnectedUsers[side] = userId;
    this.roomScheduler.unregister(room.id);
    room.snapshot.state.paddles[side].dy = 0;
    room.snapshot.state.phase = "paused";
    this.armReconnectTimer(room);
    this.broadcastSnapshot(room);
  }

  private armReconnectTimer(room: Room): void {
    this.clearReconnectTimer(room);
    const deadline = room.session.reconnectDeadline;
    if (deadline === null) return;
    room.reconnectTimer = setTimeout(() => this.expireReconnect(room.id), Math.max(0, deadline - Date.now()));
  }

  private expireReconnect(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room || room.finishing) return;
    room.reconnectTimer = null;
    const expiry = room.session.expireReconnect(Date.now());
    if (!expiry) {
      this.armReconnectTimer(room);
      return;
    }

    for (const userId of Object.values(room.disconnectedUsers)) {
      if (userId) this.observer.reconnect?.({ outcome: "expired", roomId, userId });
    }

    room.disconnectedUsers = {};
    if (!expiry.winnerSide) {
      this.abandonRoom(room);
      return;
    }
    if (expiry.winnerSide === "left") {
      room.snapshot.state.leftScore = Math.max(room.snapshot.state.leftScore, WINNING_SCORE);
    } else {
      room.snapshot.state.rightScore = Math.max(room.snapshot.state.rightScore, WINNING_SCORE);
    }
    this.finishRoom(room, expiry.winnerSide).catch(() => undefined);
  }

  private abandonRoom(room: Room): void {
    this.roomScheduler.unregister(room.id);
    this.clearReconnectTimer(room);
    this.releaseMatchmakingReservations(room);
    for (const client of Object.values(room.clients)) {
      if (client) client.roomId = null;
    }
    this.rooms.delete(room.id);
    this.notifyDrainProgress();
    this.broadcastPresence();
  }

  private clearReconnectTimer(room: Room): void {
    if (room.reconnectTimer) clearTimeout(room.reconnectTimer);
    room.reconnectTimer = null;
  }

  private sendMatchContext(client: Client, room: Room, side: PlayerSide): void {
    const opponent = side === "left"
      ? room.clients.right?.user.displayName ?? room.npcUser?.displayName ?? "연습 AI"
      : room.clients.left?.user.displayName ?? "상대 선수";
    this.send(client, { type: "queue.matched", roomId: room.id, side, opponent });
  }

  private async joinQueue(client: Client, mode: "queue" | "ai"): Promise<void> {
    if (!this.acceptingMatches) {
      this.sendDrainingError(client);
      return;
    }
    if (client.roomId) {
      this.send(client, { type: "error", code: "forbidden", message: "이미 진행 중인 경기가 있습니다." });
      return;
    }
    this.pruneQueue();
    if (mode === "ai") {
      this.leaveQueue(client);
      this.createRoom(client, null, { ai: true, mode: "ai" });
      return;
    }

    const join = this.matchmaker.enqueue(matchmakingPlayer(client));
    if (join.type === "duplicate") {
      this.send(client, {
        type: "error",
        code: "forbidden",
        message: join.status === "queued" ? "이미 대기열에 참가했습니다." : "이미 경기가 배정되었습니다."
      });
      return;
    }
    if (join.type === "queued") {
      const entry: QueueEntry = {
        client,
        queuedAtMs: join.queuedAtMs,
        npcFallbackTimer: null
      };
      this.queueEntries.set(client.user.id, entry);
      this.armAiFallback(entry, join.aiFallbackAtMs - Date.now());
      this.broadcastPresence();
      return;
    }

    const opponent = this.queueEntries.get(join.match.left.userId);
    if (!opponent) {
      this.matchmaker.release(join.match.left.userId);
      this.matchmaker.release(join.match.right.userId);
      throw new Error("대기 중인 상대 연결을 찾지 못했습니다.");
    }
    this.queueEntries.delete(opponent.client.user.id);
    clearQueueTimer(opponent);
    this.recordWaitSample(opponent.queuedAtMs);
    try {
      this.createRoom(opponent.client, client, { ai: false, mode: "queue" });
    } catch (error) {
      this.matchmaker.release(opponent.client.user.id);
      this.matchmaker.release(client.user.id);
      throw error;
    }
  }

  private armAiFallback(entry: QueueEntry, delayMs: number): void {
    clearQueueTimer(entry);
    entry.npcFallbackTimer = setTimeout(() => {
      this.matchQueuedClientWithNpc(entry).catch(() => {
        this.send(entry.client, {
          type: "error",
          code: "internal_error",
          message: INTERNAL_ERROR_MESSAGE
        });
      });
    }, Math.max(0, delayMs));
  }

  private async matchQueuedClientWithNpc(entry: QueueEntry): Promise<void> {
    if (this.queueEntries.get(entry.client.user.id) !== entry) return;
    if (entry.client.socket.readyState !== WebSocket.OPEN || entry.client.roomId) {
      this.leaveQueue(entry.client);
      return;
    }
    const fallback = this.matchmaker.claimAiFallback(entry.client.user.id);
    if (fallback.type === "waiting") {
      this.armAiFallback(entry, fallback.remainingMs);
      return;
    }
    if (fallback.type === "unavailable") {
      this.queueEntries.delete(entry.client.user.id);
      clearQueueTimer(entry);
      return;
    }
    clearQueueTimer(entry);
    const guest = isGuest(entry.client.user);
    try {
      const npc = guest ? null : await this.findClosestNpc(entry.client);
      if (
        this.queueEntries.get(entry.client.user.id) !== entry ||
        !this.acceptingMatches ||
        entry.client.socket.readyState !== WebSocket.OPEN ||
        entry.client.roomId
      ) {
        this.matchmaker.release(entry.client.user.id);
        return;
      }
      this.queueEntries.delete(entry.client.user.id);
      if (!guest && !npc) {
        this.matchmaker.release(entry.client.user.id);
        throw new Error("AI 상대를 찾지 못했습니다.");
      }
      this.recordWaitSample(entry.queuedAtMs);
      this.createRoom(entry.client, null, { ai: true, mode: "queue", npc });
    } catch (error) {
      if (this.queueEntries.get(entry.client.user.id) === entry) {
        this.queueEntries.delete(entry.client.user.id);
      }
      this.matchmaker.release(entry.client.user.id);
      throw error;
    }
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
    if (!this.acceptingMatches) {
      this.sendDrainingError(client);
      return;
    }
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
    try {
      await this.repo.startTournamentMatch(matchId, roomId);
    } catch (error) {
      const room = this.rooms.get(roomId);
      if (room) this.abandonRoom(room);
      throw error;
    }
  }

  private leaveQueue(client: Client): void {
    const entry = this.queueEntries.get(client.user.id);
    const leftQueue = this.matchmaker.leaveQueue(client.user.id);
    if (!entry) return;
    if (!leftQueue) this.matchmaker.release(client.user.id);
    this.queueEntries.delete(client.user.id);
    clearQueueTimer(entry);
  }

  private leaveTournamentWaiters(client: Client): void {
    for (const [matchId, waiters] of this.tournamentWaiters.entries()) {
      const next = waiters.filter((waiter) => waiter.id !== client.id);
      if (next.length === 0) this.tournamentWaiters.delete(matchId);
      else this.tournamentWaiters.set(matchId, next);
    }
  }

  private pruneQueue(): void {
    for (const entry of this.queueEntries.values()) {
      if (entry.client.socket.readyState !== WebSocket.OPEN) this.leaveQueue(entry.client);
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
      queuedPlayers: this.matchmaker.queuedCount,
      activeRooms: this.rooms.size,
      averageWaitSeconds
    };
  }

  beginDrain(timeoutMs: number): Promise<DrainResult> {
    this.acceptingMatches = false;
    for (const entry of [...this.queueEntries.values()]) {
      this.leaveQueue(entry.client);
      this.sendDrainingError(entry.client);
    }
    for (const waiters of this.tournamentWaiters.values()) {
      for (const client of waiters) this.sendDrainingError(client);
    }
    this.tournamentWaiters.clear();
    this.broadcastPresence();

    if (this.rooms.size === 0) {
      return Promise.resolve({ drained: true, activeRooms: 0 });
    }
    if (this.drainWaiter) return this.drainWaiter.promise;

    let resolveDrain: (result: DrainResult) => void = () => undefined;
    const promise = new Promise<DrainResult>((resolve) => {
      resolveDrain = resolve;
    });
    const timer = setTimeout(() => {
      this.finishDrain({ drained: false, activeRooms: this.rooms.size });
    }, Math.max(0, timeoutMs));
    timer.unref?.();
    this.drainWaiter = { promise, resolve: resolveDrain, timer };
    return promise;
  }

  close(): void {
    this.acceptingMatches = false;
    for (const entry of [...this.queueEntries.values()]) this.leaveQueue(entry.client);
    this.tournamentWaiters.clear();
    this.roomScheduler.stop();
    for (const room of this.rooms.values()) {
      this.clearReconnectTimer(room);
      this.releaseMatchmakingReservations(room);
    }
    this.rooms.clear();
    for (const recent of this.recentGuestResults.values()) clearTimeout(recent.cleanupTimer);
    this.recentGuestResults.clear();
    const clients = [...this.clients.values()];
    this.clients.clear();
    this.clientsByUser.clear();
    for (const client of clients) {
      client.heartbeat.stop();
      client.snapshots.close();
      if (client.socket.readyState === WebSocket.OPEN) client.socket.terminate();
    }
  }

  onlinePlayers(): PublicUser[] {
    const users = new Map<string, PublicUser>();
    for (const client of this.clients.values()) {
      if (isGuest(client.user)) continue;
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
    const session = new RoomSession();
    if (options.ai) session.markReady("right");
    const room: Room = {
      id: roomId,
      clients: { left, ...(right ? { right } : {}) },
      ai: options.ai,
      ready: {},
      mode: options.mode,
      tournamentMatchId: options.tournamentMatchId ?? null,
      npcUser,
      simulation,
      aiController: options.ai ? new PongAi(roomId, npcUser?.rating ?? 1200) : null,
      finishing: null,
      session,
      reconnectTimer: null,
      disconnectedUsers: {},
      guest: isGuest(left.user),
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
    try {
      this.rooms.set(roomId, room);
      this.observer.roomCreated?.({
        roomId,
        requestIds: [left.requestId, right?.requestId]
          .filter((requestId): requestId is string => Boolean(requestId)),
        userIds: [left.user.id, ...(right ? [right.user.id] : [])]
      });
      left.roomId = roomId;
      if (right) right.roomId = roomId;
      this.send(left, { type: "queue.matched", roomId, side: "left", opponent: rightPlayer?.displayName ?? "연습 AI" });
      if (right) this.send(right, { type: "queue.matched", roomId, side: "right", opponent: left.user.displayName });
      this.broadcastSnapshot(room);
      this.broadcastPresence();
      return roomId;
    } catch (error) {
      this.roomScheduler.unregister(roomId);
      this.clearReconnectTimer(room);
      this.rooms.delete(roomId);
      if (left.roomId === roomId) left.roomId = null;
      if (right?.roomId === roomId) right.roomId = null;
      this.notifyDrainProgress();
      this.broadcastPresence();
      throw error;
    }
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
    const sessionState = room.session.markReady(side);
    if (room.ready.left && room.ready.right && sessionState === "playing") {
      room.snapshot.state.phase = sessionState;
      this.startRoomScheduler(room);
    }
    this.broadcastSnapshot(room);
  }

  private applyInput(client: Client, roomId: string, inputSeq: number, direction: -1 | 0 | 1): void {
    const room = this.rooms.get(roomId);
    if (!room || room.snapshot.state.phase !== "playing") return;
    const side = sideFor(room, client);
    if (!side) return;
    const decision = this.inputGate.check({
      userId: client.user.id,
      roomId,
      inputSeq,
      nowMs: performance.now()
    });
    if (decision === "stale") return;
    if (decision === "rate_limited") {
      this.send(client, {
        type: "error",
        code: "rate_limited",
        message: "게임 입력 전송 한도를 초과했습니다."
      });
      return;
    }
    room.snapshot.state.paddles[side].dy = direction;
  }

  private pauseRoom(client: Client, roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room || room.snapshot.state.phase !== "playing" || !sideFor(room, client)) return;
    this.roomScheduler.unregister(room.id);
    const sessionState = room.session.pause();
    if (sessionState !== "paused") return;
    room.snapshot.state.phase = sessionState;
    this.broadcastSnapshot(room);
  }

  private resumeRoom(client: Client, roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room || room.snapshot.state.phase !== "paused" || !sideFor(room, client)) return;
    const sessionState = room.session.resume();
    if (sessionState !== "playing") return;
    room.snapshot.state.phase = sessionState;
    this.startRoomScheduler(room);
    this.broadcastSnapshot(room);
  }

  private startRoomScheduler(room: Room): void {
    this.roomScheduler.register(room.id, () => this.tick(room));
  }

  private tick(room: Room): void {
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
      this.finishRoom(room, room.simulation.winnerSide).catch(() => undefined);
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
    this.roomScheduler.unregister(room.id);
    this.clearReconnectTimer(room);
    room.disconnectedUsers = {};
    room.session.finish();
    room.snapshot.state.phase = "finished";
    const leftUser = room.clients.left?.user ?? null;
    const rightUser = room.clients.right?.user ?? room.npcUser ?? null;
    const winner = winnerSide === "left" ? leftUser : rightUser;
    const loser = winnerSide === "left" ? rightUser : leftUser;
    if (room.guest) {
      const result: GameFinished = {
        roomId: room.id,
        matchId: null,
        persisted: false,
        winnerSide,
        leftScore: room.snapshot.state.leftScore,
        rightScore: room.snapshot.state.rightScore,
        ratingDelta: 0
      };
      try {
        this.observer.matchFinalized?.({
          outcome: "success",
          persistence: "memory",
          roomId: room.id,
          matchId: null,
          userIds: roomUserIds(room)
        });
        this.rememberGuestResult(room, result);
        this.broadcastRoom(room.id, { type: "game.finished", result });
      } finally {
        this.removeFinishedRoom(room);
      }
      return;
    }
    let finalized: Awaited<ReturnType<MatchResultRepository["finalizeMatch"]>>;
    try {
      finalized = await this.repo.finalizeMatch({
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
    } catch (error) {
      this.releaseMatchmakingReservations(room);
      this.observer.matchFinalized?.({
        outcome: "failure",
        persistence: "database",
        roomId: room.id,
        matchId: null,
        userIds: roomUserIds(room)
      });
      throw error;
    }
    try {
      this.observer.matchFinalized?.({
        outcome: "success",
        persistence: "database",
        roomId: room.id,
        matchId: finalized.matchId,
        userIds: roomUserIds(room)
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
    } finally {
      this.removeFinishedRoom(room);
    }
  }

  private rememberGuestResult(room: Room, result: GameFinished): void {
    const expiresAtMs = Date.now() + GUEST_RESULT_RETENTION_MS;
    for (const client of Object.values(room.clients)) {
      if (client && isGuest(client.user)) {
        const userId = client.user.id;
        const previous = this.recentGuestResults.get(userId);
        if (previous) clearTimeout(previous.cleanupTimer);
        const cleanupTimer = setTimeout(() => {
          const current = this.recentGuestResults.get(userId);
          if (current?.expiresAtMs === expiresAtMs) this.recentGuestResults.delete(userId);
        }, GUEST_RESULT_RETENTION_MS);
        cleanupTimer.unref();
        this.recentGuestResults.set(userId, { result, expiresAtMs, cleanupTimer });
      }
    }
  }

  private sendRecentGuestResult(client: Client): void {
    if (!isGuest(client.user)) return;
    const recent = this.recentGuestResults.get(client.user.id);
    if (!recent) return;
    if (Date.now() > recent.expiresAtMs) {
      clearTimeout(recent.cleanupTimer);
      this.recentGuestResults.delete(client.user.id);
      return;
    }
    this.send(client, { type: "game.finished", result: recent.result });
  }

  private removeFinishedRoom(room: Room): void {
    this.roomScheduler.unregister(room.id);
    this.releaseMatchmakingReservations(room);
    for (const client of Object.values(room.clients)) {
      if (client) client.roomId = null;
    }
    this.rooms.delete(room.id);
    this.notifyDrainProgress();
    this.broadcastPresence();
  }

  private releaseMatchmakingReservations(room: Room): void {
    for (const client of Object.values(room.clients)) {
      if (client) this.matchmaker.release(client.user.id);
    }
  }

  private sendDrainingError(client: Client): void {
    this.send(client, {
      type: "error",
      code: "server_draining",
      message: "서버 점검을 준비하고 있어 새 경기를 시작할 수 없습니다."
    });
  }

  private notifyDrainProgress(): void {
    if (this.drainWaiter && this.rooms.size === 0) {
      this.finishDrain({ drained: true, activeRooms: 0 });
    }
  }

  private finishDrain(result: DrainResult): void {
    const waiter = this.drainWaiter;
    if (!waiter) return;
    this.drainWaiter = null;
    clearTimeout(waiter.timer);
    waiter.resolve(result);
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
    if (client.socket.readyState !== WebSocket.OPEN) return;
    const payload = encodeServerEvent({ ...event, v: 1 } as ServerEvent);
    if (event.type === "game.snapshot") {
      client.snapshots.enqueue(payload);
      return;
    }
    if (client.socket.bufferedAmount >= HARD_BUFFERED_AMOUNT_BYTES) {
      client.socket.terminate();
      return;
    }
    client.socket.send(payload, (error) => {
      if (error && client.socket.readyState === WebSocket.OPEN) client.socket.terminate();
    });
  }
}

function sideFor(room: Room, client: Client): PlayerSide | null {
  if (room.clients.left?.id === client.id) return "left";
  if (room.clients.right?.id === client.id) return "right";
  return null;
}

function isGuest(user: ConnectedUser): user is GuestSessionUser {
  return "sessionKind" in user && user.sessionKind === "guest";
}

function matchmakingPlayer(client: Client): MatchmakingPlayer {
  return {
    userId: client.user.id,
    rating: client.user.rating,
    kind: isGuest(client.user) ? "guest" : "registered"
  };
}

function roomUserIds(room: Room): string[] {
  return Object.values(room.clients)
    .filter((client): client is Client => Boolean(client))
    .map((client) => client.user.id);
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

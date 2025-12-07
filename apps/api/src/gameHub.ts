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

// [INTV:ARCH] 조건부 타입 + infer + 유니온 분배: ServerEvent의 모든 변형은 v:1 필드를 갖고 있는데,
// 이 허브 내부의 send/broadcast 계열 메서드는 그 v를 직접 넣지 않고 호출부에서 생략한 이벤트를 받아
// 마지막에 한 번만 v:1을 붙인다(아래 send() 참고). "extends infer Event"로 유니온을 하나씩 떼어내
// 각 변형마다 개별적으로 Omit<Event, "v">를 적용하므로("분배 조건부 타입"), 결과도 여전히 유니온
// 형태를 유지한다.
// - [TRAP] 그냥 Omit<ServerEvent, "v">로 썼다면 유니온이 분배되지 않고 "모든 변형의 필드를 합친
//   하나의 넓은 타입"이 돼서, 각 이벤트 타입별로 서로 다른 나머지 필드가 있다는 정보(판별 유니온의
//   장점)가 사라진다 — extends infer로 감싸는 이 패턴이 분배를 강제하는 핵심.
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

// [INTV:ARCH] AppRepository 전체가 아니라 GameHub가 실제로 쓰는 메서드 몇 개만 요구하는 최소
// 인터페이스(poolError.ts의 Pick<Pool, "on">과 같은 이유, 인터페이스 분리 원칙) — 나머지는 이
// 파일이 알 필요도, 테스트에서 흉내 낼 필요도 없다(테스트에서 mock repo를 만들 때 AppRepository의
// 수십 개 메서드를 전부 구현할 필요 없이 이 몇 개만 채우면 된다).
type GameHubRepository = Pick<
  AppRepository,
  | "createChatMessage"
  | "getTournamentMatch"
  | "listNpcOpponents"
  | "startTournamentMatch"
> & MatchResultRepository;

// [INTV:ARCH] 진행 중인 매치(방) 하나의 서버 측 전체 상태. simulation(물리 연산용, pongSimulation.ts의
// 내부 표현)과 snapshot(네트워크로 내보내는 표현, @pong-pong/shared의 GameSnapshot 모양)을 따로
// 들고 있다가 매 틱마다 syncSnapshot()으로 맞춰준다 — 물리 계산에 편한 모양(direction: -1|0|1)과
// 프로토콜에 정의된 모양(dy 필드명 등)이 달라서, 하나로 억지로 합치면 둘 중 한쪽이 부자연스러워진다.
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
  finalizationRetryTimer: NodeJS.Timeout | null;
  session: RoomSession;
  reconnectTimer: NodeJS.Timeout | null;
  disconnectedUsers: Partial<Record<PlayerSide, string>>;
  guest: boolean;
  snapshotDeliverySlot: number;
};

const MAX_MATCHMAKING_RATING_DIFFERENCE = 200;
const SIMULATION_TIMESTEP_MS = DEFAULT_TIMESTEP_MS;
const SNAPSHOT_DELIVERY_DIVISOR = 2;
const CONNECTION_REPLACED_CLOSE_CODE = 4001;
const CONNECTION_REPLACED_REASON = "connection replaced";
const ACCOUNT_SUSPENDED_CLOSE_CODE = 4003;
const ACCOUNT_SUSPENDED_REASON = "account suspended";
const FINALIZATION_RETRY_BASE_DELAY_MS = 250;
const FINALIZATION_RETRY_MAX_DELAY_MS = 5_000;
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
    created: boolean | null;
    roomId: string;
    matchId: string | null;
    userIds: string[];
  }): void;
  snapshotDelivered?(delayMs: number): void;
  snapshotDropped?(reason: "replaced" | "connection_closed" | "congestion"): void;
}

// [INTV:ARCH] 이 클래스가 WS 프로토콜 전체(ws.ts에 정의된 클라이언트/서버 이벤트)를 실제로 처리하는
// 중앙 허브다 — 접속 중인 클라이언트, 매치메이킹 대기열, 진행 중인 방(Room)들, 토너먼트 대진 대기자,
// 드레인(점검 모드) 상태를 전부 이 인스턴스 하나가 들고 있다. 클라이언트별 개별 소켓 이벤트(connect/
// message/close)는 이 클래스의 메서드 호출로 들어오고, 그 결과로 다른 클라이언트에게 나가는 이벤트는
// send/broadcast 계열 메서드로 나간다 — 소켓 레이어(index.ts/wsTicket.ts)와 게임 로직을 분리해,
// 이 클래스 자체는 순수 WebSocket 인스턴스에 의존할 뿐 HTTP 서버 부트스트랩을 몰라도 된다.
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
  private nextSnapshotDeliverySlot = 0;
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

  // [INTV:EDGE] pendingPayloads: WS 업그레이드/티켓 인증이 끝나기 전에 클라이언트가 이미 보내둔
  // 메시지들(ws-ticket.test.ts의 "pre-authentication" 버퍼링 참고) — 인증이 끝나 이 connect()가
  // 불리는 시점에야 비로소 처리해도 안전해지므로 여기서 한꺼번에 재생한다. 인증 전에 받은 메시지를
  // 그냥 버리면, 연결 직후 곧바로 queue.join을 보내는 정상적인 클라이언트의 첫 요청이 유실되는
  // 경합이 생긴다.
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
    // [INTV:ARCH] 한 유저(계정)당 활성 소켓은 하나만 허용한다 — clientsByUser에 이미 같은 유저의
    // 연결(previous)이 있으면 "새 탭/새 기기에서 다시 접속한 것"으로 보고 이전 연결을 대체
    // (replaceConnection)한다. 아니라면 이전에 끊겼던 매치로 재접속하는 상황인지(recoverConnection)
    // 먼저 확인하고, 둘 다 아니면 혹시 최근에 끝난 게스트 매치 결과가 안 보내졌던 게 있으면 그걸
    // 보내준다.
    // - [FLOW] 1. Client 객체 생성(heartbeat/snapshots 버퍼 포함) -> 2. 같은 유저의 기존 연결이
    //   있으면 replaceConnection, 없으면 recoverConnection 시도 -> 3. 둘 다 아니면 최근 게스트
    //   결과 발송 -> 4. 최종적으로 이 클라이언트가 여전히 유효하면 heartbeat 시작 -> 5. presence
    //   브로드캐스트 -> 6. 버퍼링된 메시지 재생
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

  // [INTV:ARCH] 관리자가 유저를 정지시키는 등, 서버가 능동적으로 한 유저의 접속을 강제 종료해야 할
  // 때 호출된다 — 클라이언트 스스로 끊은 게 아니라서 disconnect()와 달리 소켓을 직접 close()시키는
  // 절차가 포함된다(disconnect()는 "close" 이벤트의 반응일 뿐이라 소켓이 이미 닫혀 있다).
  revokeUser(userId: string): void {
    const client = this.clientsByUser.get(userId);
    if (!client) return;
    client.heartbeat.stop();
    client.snapshots.close();
    this.leaveQueue(client);
    this.leaveTournamentWaiters(client);
    this.clients.delete(client.id);
    this.clientsByUser.delete(userId);
    this.inputGate.releaseUser(userId);
    if (client.roomId) {
      const room = this.rooms.get(client.roomId);
      const side = room ? sideFor(room, client) : null;
      if (room && side) this.reserveRoomSide(room, side, userId);
    }
    if (client.socket.readyState === WebSocket.OPEN) {
      client.socket.close(ACCOUNT_SUSPENDED_CLOSE_CODE, ACCOUNT_SUSPENDED_REASON);
    }
    this.broadcastPresence();
  }

  // [INTV:EDGE] 소켓에서 들어오는 모든 메시지가 거치는 단일 진입점 — 파싱, 게스트 권한 체크,
  // event.type별 분기, 그리고 그 분기 로직 안에서 예상치 못한 예외가 나더라도 소켓을 끊지 않고
  // "internal_error" 이벤트로만 응답하도록 바깥 try/catch로 감싼다(한 클라이언트의 처리 실패가
  // 그 클라이언트 연결 자체를 죽이지 않게 하려는 방어 — 파싱 실패는 별도의 안쪽 try/catch로 먼저
  // 걸러, "잘못된 메시지 형식"과 "처리 중 내부 오류"를 서로 다른 에러 코드로 구분해서 응답한다).
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
      // [INTV:EDGE] 게스트 계정은 채팅과 토너먼트 참가가 막혀 있다 — 가입 없이 즉석에서 만들어지는
      // 계정이라 악용(도배, 대회 교란 등)의 비용이 낮기 때문에 이 두 기능만 기능 자체를 차단한다.
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
        if (event.scope === "match") {
          const room = this.rooms.get(event.roomId);
          if (!room || client.roomId !== room.id || !sideFor(room, client)) {
            this.send(client, {
              type: "error",
              code: "forbidden",
              message: "현재 경기방에만 채팅을 보낼 수 있습니다."
            });
            return;
          }
          const message = await this.repo.createChatMessage({
            scope: "match",
            roomId: event.roomId,
            senderId: client.user.id,
            body: event.body
          });
          this.broadcastRoom(event.roomId, { type: "chat.message", message });
        } else {
          const message = await this.repo.createChatMessage({
            scope: "lobby",
            roomId: null,
            senderId: client.user.id,
            body: event.body
          });
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

  // [INTV:EDGE] 같은 유저가 새 소켓으로 다시 접속해서 기존 연결을 대체하는 경우 — 이전 연결이 방에
  // 참여 중이었다면 그 자리를 그대로 새 연결에 넘겨주고(재입장을 따로 거칠 필요 없이 즉시 이어서
  // 플레이), 이전 소켓은 전용 close 코드(4001)로 닫아 "다른 곳에서 새로 접속해서 끊겼다"는 걸
  // 클라이언트가 구분할 수 있게 한다(일반 네트워크 단절과 구분되는 코드라 UI에서 다른 메시지를
  // 보여줄 수 있다).
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

  // [INTV:TRADE_OFF] 접속이 끊겼던 유저가 (같은 소켓이 아니라 새 연결로) 다시 들어왔을 때, 그 유저가
  // 남겨뒀던 방의 자리를 찾아 되돌려준다 — roomSession.ts의 reconnect()가 유예 시간(15초) 안인지까지
  // 함께 판단한다. 모든 방을 순회하는 건 어느 방인지 클라이언트가 스스로 알려주지 않기 때문(재접속
  // 요청 자체엔 방 정보가 없다) — 동시 방 수가 아주 많아지면 O(방 수) 선형 탐색이 병목이 될 수
  // 있지만, 재접속은 흔한 이벤트가 아니라 이 정도 규모에선 용인 가능한 트레이드오프로 판단했다.
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

  // [INTV:EDGE] 한쪽 플레이어의 연결이 끊겼을 때(진짜로 끊었든, 새 연결로 교체됐든) 그 자리를
  // "재접속을 기다리는 상태"로 표시한다 — 게임 진행은 멈추고(paused로 전환, 패들 입력도 0으로),
  // 재접속 유예 타이머를 건다. roomScheduler.unregister로 이 방의 틱 처리 자체를 멈춰, 아무도
  // 움직이지 않는데 계속 물리 연산만 도는 낭비를 막는다.
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
    this.clearFinalizationRetryTimer(room);
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

  private clearFinalizationRetryTimer(room: Room): void {
    if (room.finalizationRetryTimer) clearTimeout(room.finalizationRetryTimer);
    room.finalizationRetryTimer = null;
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

    // [INTV:FLOW] matchmaker.enqueue()는 세 가지 결과 중 하나를 준다: 이미 대기/배정 중이면
    // "duplicate", 아직 짝을 못 찾았으면 "queued"(이 경우 사람 상대를 못 찾으면 나중에 AI로
    // 대체되도록 armAiFallback으로 타이머를 건다), 마침 대기 중이던 다른 클라이언트와 바로
    // 맞아떨어지면 "matched".
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

  // [INTV:EDGE] 사람 상대를 오래 못 찾은 대기자를 AI로 대체 매칭한다 — armAiFallback이 건 타이머가
  // 만료되면 호출된다. "waiting"(아직 사람 매칭 시도가 진행형이라 좀 더 기다려야 함)이면 타이머를
  // 다시 걸고, "unavailable"이면 큐 상태가 이미 정리된 것이므로 조용히 빠진다 — 타이머 콜백이
  // 실행되는 시점과 큐 상태가 실제로 유효한 시점 사이에 간극이 있을 수 있어(그 사이 매칭됐거나
  // 나갔거나), 매번 claimAiFallback으로 "지금도 유효한지" 다시 확인받는 게 핵심(matchmaker.ts의
  // claim 패턴 설명 참고).
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

  // [INTV:ARCH] 대체 AI 상대는 아무 NPC나 고르지 않고, 대기 중인 플레이어의 레이팅과 가장 가까운
  // NPC를 골라 대전 밸런스를 맞춘다(matchmaker.ts의 사람 매칭과 동일한 "레이팅 근접" 원칙을 AI
  // 매칭에도 적용).
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
    // [INTV:ARCH] 토너먼트 대진 참가도 큐 매칭과 같은 "먼저 온 사람이 기다리고, 상대가 오면 방을
    // 만든다" 랑데부 패턴을 쓴다 — 다만 상대가 임의의 아무나가 아니라 이 matchId에 배정된 두 명 중
    // 한쪽이어야 한다는 점이 다르다(matchmaker 큐 대신 tournamentWaiters라는 별도의, matchId로
    // 스코프된 대기열을 쓰는 이유).
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

  // [INTV:ARCH] gracefulShutdown.ts가 트리거하는 종료 절차의 게임 허브 쪽 담당: 더는 새 매치를 받지
  // 않도록 막고(대기열도 즉시 비운다), 이미 진행 중인 방들은 스스로 끝날 때까지 기다린다. timeoutMs
  // 안에 모든 방이 끝나면 drained:true로 resolve, 그렇지 않으면 강제로 drained:false로 마무리한다
  // (끝까지 붙잡고 있지는 않는다 — 배포 파이프라인이 무한정 대기하지 않도록 상한을 둔 정상 종료).
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
      this.clearFinalizationRetryTimer(room);
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
    // [INTV:PERF] 방마다 0 또는 1의 슬롯을 번갈아 배정한다 — tick()에서 스냅샷을 매 틱이 아니라
    // 한 틱씩 걸러 보내는데, 모든 방이 똑같이 "짝수 틱에만" 보내면 그 틱에 한꺼번에 브로드캐스트가
    // 몰려 순간 부하가 튄다. 슬롯을 방마다 엇갈리게 둬서 방들의 전송 부하가 시간축으로 고르게
    // 퍼지게 한다(로드 스무딩) — 동시 접속 방이 많을수록 효과가 커진다.
    const snapshotDeliverySlot = this.nextSnapshotDeliverySlot;
    this.nextSnapshotDeliverySlot =
      (this.nextSnapshotDeliverySlot + 1) % SNAPSHOT_DELIVERY_DIVISOR;
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
      finalizationRetryTimer: null,
      session,
      reconnectTimer: null,
      disconnectedUsers: {},
      guest: isGuest(left.user),
      snapshotDeliverySlot,
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
    for (const side of ["left", "right"] as const) {
      room.snapshot.state.paddles[side].dy = 0;
      room.simulation.paddles[side].direction = 0;
    }
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

  // [INTV:ARCH] SharedRoomScheduler가 이 방의 차례마다 호출하는 콜백 — 물리를 한 틱 전진시키고
  // (AI가 붙어있으면 오른쪽 방향은 AI가 결정), 네트워크 전송용 스냅샷과 동기화한다.
  // - [FLOW] 1. 좌/우 입력 방향 확정(우측은 AI 또는 클라이언트 입력) -> 2. PongSimulation.step으로
  //   물리 한 틱 전진 -> 3. syncSnapshot으로 네트워크 표현 갱신 -> 4. 짝수/홀수 슬롯에 맞으면
  //   브로드캐스트 -> 5. 시뮬레이션이 끝났으면 finishRoom 트리거
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
    // [INTV:PERF] 물리는 매 틱 계산하지만, 스냅샷은 한 틱 걸러(SNAPSHOT_DELIVERY_DIVISOR=2) 한
    // 번만 클라이언트로 내보낸다 — 클라이언트는 두 스냅샷 사이를 보간해서 부드럽게 그리므로,
    // 대역폭을 절반으로 줄이면서도 체감 프레임은 크게 떨어지지 않는다(snapshotDeliverySlot으로
    // 방마다 어느 틱에 보낼지를 엇갈리게 함 — 위 createRoom의 슬롯 배정과 연결됨).
    if (
      (room.simulation.tick + room.snapshotDeliverySlot) % SNAPSHOT_DELIVERY_DIVISOR === 0
    ) {
      this.broadcastSnapshot(room);
    }

    if (room.simulation.phase === "finished" && room.simulation.winnerSide) {
      this.finishRoom(room, room.simulation.winnerSide).catch(() => undefined);
    }
  }

  // [INTV:EDGE] 방이 끝나는 경로는 두 가지다(시뮬레이션이 점수로 자연스럽게 끝나는 경우, 또는
  // 재접속 유예 시간이 지나 몰수패로 끝나는 경우) — 거의 동시에 두 경로가 겹쳐 호출될 수 있으므로,
  // 이미 진행 중인 종료 처리가 있으면 새로 또 시작하지 않고 그 Promise를 그대로 돌려줘서
  // finalizeRoom이 중복 실행되지 않게 한다.
  // - [TRAP] room.finishing 캐시 없이 매번 finalizeRoom을 새로 호출하면, DB에 결과가 두 번 쓰이려
  //   시도하는 레이스가 생긴다 — repo.finalizeMatch의 resultKey 멱등성이 최종 방어선이긴 하지만,
  //   애플리케이션 레벨에서 애초에 중복 호출 자체를 막는 게 더 안전하고 저렴하다(멱등성은 마지막
  //   보험이지 첫 번째 방어선으로 기대면 안 된다).
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
    // [INTV:ARCH] 게스트가 낀 매치는 DB에 아무것도 남기지 않는다(packages/db의 discriminatedUnion에서
    // 본 persisted:false 변형) — 대신 결과를 잠깐(GUEST_RESULT_RETENTION_MS) 메모리에만 기억해뒀다가,
    // 결과가 나가기 직전에 하필 연결이 끊겨 못 받은 게스트가 재접속하면 sendRecentGuestResult로
    // 뒤늦게라도 보여준다 — 게스트는 계정이 없으니 DB에 영구 기록할 대상 자체가 없고, 이 메모리
    // 캐시가 "결과를 놓치지 않게 하는" 최선의 보상책이다.
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
          created: null,
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
    // [INTV:EDGE] 등록된 유저의 매치는 DB에 반드시 기록돼야 하므로, 실패하면(일시적 DB 장애 등)
    // 포기하지 않고 재시도한다. repo.finalizeMatch가 resultKey(`room:${room.id}:finished`)로
    // 멱등성을 보장해주는 덕분에(packages/db/src/index.ts 참고) 같은 결과를 여러 번 재시도해도
    // 중복 매치가 생기지 않는다 — 그래서 안심하고 반복 재시도할 수 있다. 이 무한 재시도 루프가
    // "안전"한 건 전적으로 저 멱등성 키 덕분이다 — 멱등성이 없었다면 이 루프는 중복 기록을 낳는
    // 버그였을 것.
    let finalized: Awaited<ReturnType<MatchResultRepository["finalizeMatch"]>>;
    let retryAttempt = 0;
    while (true) {
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
        break;
      } catch {
        retryAttempt += 1;
        this.observer.matchFinalized?.({
          outcome: "failure",
          persistence: "database",
          created: null,
          roomId: room.id,
          matchId: null,
          userIds: roomUserIds(room)
        });
        if (!await this.waitForFinalizationRetry(room, retryAttempt)) return;
      }
    }
    try {
      this.observer.matchFinalized?.({
        outcome: "success",
        persistence: "database",
        created: finalized.created,
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

  // [INTV:EDGE] 지수 백오프: 재시도할 때마다 대기 시간을 2배씩(250ms, 500ms, 1000ms, ...) 늘리되
  // 5초를 넘기지 않는다 — DB 장애가 잠깐이면 금방 재시도로 회복되고, 장애가 길어지면 너무 자주
  // 두드려 부하를 더 얹지 않도록 한다. 그 사이 방이 사라졌으면(서버 종료 등으로 abandonRoom/close가
  // 불렸으면) false를 돌려줘 재시도 루프를 끝낸다 — 이 체크가 없으면 이미 사라진 방을 대상으로
  // 재시도가 영원히 도는 좀비 타이머가 된다.
  // - [TRAP] 2 ** (attempt - 1) 계산에서 attempt가 커질수록(장애가 길어질수록) 지수가 계속
  //   커지는데, Math.min(..., 10)으로 지수 자체에 상한을 걸어두지 않으면 아주 드물게 매우 큰
  //   지연이 계산될 수 있다 — 결과는 FINALIZATION_RETRY_MAX_DELAY_MS로 다시 한번 클램프되지만,
  //   지수 계산 단계에서부터 상한을 두는 이중 방어.
  private waitForFinalizationRetry(room: Room, attempt: number): Promise<boolean> {
    if (this.rooms.get(room.id) !== room) return Promise.resolve(false);
    this.clearFinalizationRetryTimer(room);
    const delayMs = Math.min(
      FINALIZATION_RETRY_BASE_DELAY_MS * 2 ** Math.min(Math.max(0, attempt - 1), 10),
      FINALIZATION_RETRY_MAX_DELAY_MS
    );
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (room.finalizationRetryTimer === timer) room.finalizationRetryTimer = null;
        resolve(this.rooms.get(room.id) === room);
      }, delayMs);
      timer.unref?.();
      room.finalizationRetryTimer = timer;
    });
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
    this.clearFinalizationRetryTimer(room);
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

  // [INTV:ARCH] 모든 서버 → 클라이언트 전송이 결국 이 메서드를 거친다 — v:1을 여기서 한 번만 붙인다
  // (VersionlessServerEvent 타입 설명 참고). game.snapshot 이벤트만 특별 취급: 일반 send처럼
  // 그때그때 내보내지 않고 LatestSnapshotBuffer(최신 것만 남기는 큐)에 맡겨서, 밀린 스냅샷이
  // 쌓이지 않고 항상 최신 상태만 전달되게 한다 — 그 외 이벤트(채팅, 상태 전이 등)는 유실되면 안
  // 되므로 일반 send 경로를 그대로 쓴다.
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

// [INTV:ARCH] "user is GuestSessionUser": 타입 가드 함수 — 이 함수가 true를 반환하면 TypeScript가
// 그 뒤 코드에서 user의 타입을 ConnectedUser(SessionUser | GuestSessionUser 유니온)에서
// GuestSessionUser로 좁혀준다(런타임 체크 하나로 컴파일 타임 타입 좁히기까지 얻는 패턴).
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

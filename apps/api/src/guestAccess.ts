import {
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import type { SessionUser } from "@pong-pong/shared";
import { createRawWsTicket, hashWsTicket, WS_TICKET_TTL_SECONDS } from "./wsTicket.js";

// [INTV:TRADE_OFF] 이 클래스는 회원가입 없는 "게스트" 플레이를 지원한다. packages/db의 세션
// (sessions 테이블 + 토큰)과 달리 게스트 세션은 DB에 아무것도 남기지 않는다 — 사용자 정보 전체를
// 쿠키 안에 담아 서버 비밀키로 서명해서 내려주고, 다음 요청에서 그 서명을 검증하는 것만으로 "이
// 쿠키는 우리가 발급한 게 맞다"를 확인하는 무상태(stateless) 세션 방식이다(JWT와 같은 원리를 직접
// 구현). DB 조회 없이 검증되는 대신, 발급된 세션을 서버가 강제로 무효화할 방법이 없다는 게
// 등록 계정 세션 대비 트레이드오프 — 그만큼 쿠키를 들고 있는 클라이언트를 신뢰하는 대신, 아래
// 곳곳에서 남용을 막는 속도 제한/한도를 둔다.
export const GUEST_SESSION_TTL_SECONDS = 2 * 60 * 60;
export const DEFAULT_GUEST_CREATION_LIMIT_PER_MINUTE = 10;
export const DEFAULT_GUEST_CONNECTIONS_PER_IP = 4;
export const DEFAULT_GUEST_CONNECTION_LIMIT = 200;
export const DEFAULT_GUEST_TICKET_LIMIT = 400;
export const DEFAULT_GUEST_TRACKED_IP_LIMIT = 10_000;
export const DEFAULT_GUEST_TICKETS_PER_IP = 4;
export const DEFAULT_GUEST_TICKET_ISSUE_LIMIT_PER_MINUTE = 30;

const CREATION_WINDOW_MS = 60_000;

export type GuestSessionUser = SessionUser & {
  sessionKind: "guest";
};

type GuestPayload = {
  v: 1;
  user: GuestSessionUser;
  ip: string;
  expiresAtMs: number;
};

type GuestAccessOptions = {
  secret: string;
  clock?: () => number;
  creationLimitPerMinute?: number;
  connectionsPerIp?: number;
  connectionLimit?: number;
  ticketLimit?: number;
  trackedIpLimit?: number;
  ticketsPerIp?: number;
  ticketIssueLimitPerMinute?: number;
};

type ConnectionLease = {
  release(): void;
};

export class GuestAccessError extends Error {
  constructor(
    readonly code:
      | "guest_creation_rate_limited"
      | "guest_creation_capacity_reached"
      | "guest_ticket_limit_reached"
      | "guest_ticket_ip_limit_reached"
      | "guest_ticket_rate_limited",
    message: string
  ) {
    super(message);
    this.name = "GuestAccessError";
  }
}

export class GuestAccess {
  private readonly clock: () => number;
  private readonly creationLimitPerMinute: number;
  private readonly connectionsPerIp: number;
  private readonly connectionLimit: number;
  private readonly ticketLimit: number;
  private readonly trackedIpLimit: number;
  private readonly ticketsPerIp: number;
  private readonly ticketIssueLimitPerMinute: number;
  private readonly creationsByIp = new Map<string, RollingWindow>();
  private readonly ticketIssuesByIp = new Map<string, RollingWindow>();
  private readonly tickets = new Map<string, {
    user: GuestSessionUser;
    ip: string;
    expiresAtMs: number;
    cleanupTimer: NodeJS.Timeout;
  }>();
  private readonly ticketHashByGuest = new Map<string, string>();
  private readonly connections = new Map<string, { ip: string; leaseId: string }>();

  constructor(private readonly options: GuestAccessOptions) {
    if (Buffer.byteLength(options.secret, "utf8") < 32) {
      throw new Error("Guest session secret must be at least 32 bytes");
    }
    this.clock = options.clock ?? Date.now;
    this.creationLimitPerMinute = options.creationLimitPerMinute ?? DEFAULT_GUEST_CREATION_LIMIT_PER_MINUTE;
    this.connectionsPerIp = options.connectionsPerIp ?? DEFAULT_GUEST_CONNECTIONS_PER_IP;
    this.connectionLimit = options.connectionLimit ?? DEFAULT_GUEST_CONNECTION_LIMIT;
    this.ticketLimit = options.ticketLimit ?? DEFAULT_GUEST_TICKET_LIMIT;
    this.trackedIpLimit = options.trackedIpLimit ?? DEFAULT_GUEST_TRACKED_IP_LIMIT;
    this.ticketsPerIp = options.ticketsPerIp ?? DEFAULT_GUEST_TICKETS_PER_IP;
    this.ticketIssueLimitPerMinute = options.ticketIssueLimitPerMinute
      ?? DEFAULT_GUEST_TICKET_ISSUE_LIMIT_PER_MINUTE;
  }

  get activeConnectionCount(): number {
    return this.connections.size;
  }

  get activeTicketCount(): number {
    return this.tickets.size;
  }

  get trackedCreationIpCount(): number {
    return this.creationsByIp.size;
  }

  createSession(ip: string): {
    user: GuestSessionUser;
    cookieValue: string;
    expiresInSeconds: number;
  } {
    this.recordCreation(ip);
    const handleSuffix = randomBytes(6).toString("hex");
    const user: GuestSessionUser = {
      id: randomUUID(),
      handle: `guest-${handleSuffix}`,
      displayName: `게스트 ${randomInt(1_000, 10_000)}`,
      avatarKey: "default",
      role: "user",
      status: "active",
      rating: 1_200,
      wins: 0,
      losses: 0,
      online: true,
      isNpc: false,
      email: null,
      sessionKind: "guest"
    };
    const payload: GuestPayload = {
      v: 1,
      user,
      ip,
      expiresAtMs: this.clock() + (GUEST_SESSION_TTL_SECONDS * 1_000)
    };
    // [INTV:ARCH] 페이로드를 JSON → base64url로 인코딩한 뒤, 그 인코딩된 문자열 자체에 서명을
    // 이어붙인 "본문.서명" 형태의 쿠키 값을 만든다(JWT의 header.payload.signature 구조를 단순화한
    // 것). 암호화가 아니라 서명이므로 클라이언트가 내용을 읽을 수는 있지만(그래서 비밀번호 같은
    // 값은 담지 않는다) 서명 없이는 내용을 조작해도 통과되지 않는다 — 기밀성이 아니라 무결성만
    // 보장하는 설계라는 점이 핵심.
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    return {
      user,
      cookieValue: `${encoded}.${this.sign(encoded)}`,
      expiresInSeconds: GUEST_SESSION_TTL_SECONDS
    };
  }

  authenticate(cookieValue: string | undefined, expectedIp?: string): GuestSessionUser | null {
    if (!cookieValue) return null;
    const separator = cookieValue.lastIndexOf(".");
    if (separator <= 0) return null;
    const encoded = cookieValue.slice(0, separator);
    const signature = cookieValue.slice(separator + 1);
    // [INTV:EDGE] secureEqual로 비교 — 여기서 만든 올바른 서명과 클라이언트가 제시한 서명을 비교할
    // 때, 문자열을 그냥 ===로 비교하면 안 되는 이유는 아래 secureEqual 주석(타이밍 공격) 참고.
    if (!secureEqual(signature, this.sign(encoded))) return null;

    try {
      const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as GuestPayload;
      if (
        payload.v !== 1
        || payload.user?.sessionKind !== "guest"
        || payload.user.role !== "user"
        || payload.user.status !== "active"
        || !Number.isFinite(payload.expiresAtMs)
        || this.clock() >= payload.expiresAtMs
        || (expectedIp !== undefined && payload.ip !== expectedIp)
      ) {
        return null;
      }
      return payload.user;
    } catch {
      // [INTV:EDGE] JSON.parse 실패 등 페이로드가 깨진 경우도 "인증 실패"로 조용히 처리한다 —
      // 원인을 노출하지 않는다(에러 메시지에 파싱 실패 세부사항을 담아 응답하면 공격자에게 내부
      // 구조에 대한 정보를 흘려주는 꼴이 된다).
      return null;
    }
  }

  issueWsTicket(user: GuestSessionUser, ip: string): string {
    this.pruneExpiredTickets();
    this.recordTicketIssue(ip);
    // [INTV:EDGE] 같은 게스트가 이전에 발급받은 미사용 티켓이 있으면 새로 발급하면서 그걸 무효화한다
    // — 한 게스트가 여러 WS 접속 시도를 동시에 진행하며 티켓을 계속 쌓아두는 걸 막고, "가장 최근
    // 티켓 하나만 유효"하게 유지한다(오래된 티켓이 나중에 재사용되는 경로를 원천 차단).
    const previousHash = this.ticketHashByGuest.get(user.id);
    if (previousHash) {
      this.deleteTicket(previousHash);
    }
    const pendingForIp = [...this.tickets.values()].filter((ticket) => ticket.ip === ip).length;
    if (pendingForIp >= this.ticketsPerIp) {
      throw new GuestAccessError(
        "guest_ticket_ip_limit_reached",
        "이 네트워크의 게스트 연결 요청이 많습니다. 잠시 후 다시 시도해주세요."
      );
    }
    if (this.tickets.size >= this.ticketLimit) {
      throw new GuestAccessError(
        "guest_ticket_limit_reached",
        "게스트 연결 요청이 많습니다. 잠시 후 다시 시도해주세요."
      );
    }
    const ticket = createRawWsTicket();
    const ticketHash = hashWsTicket(ticket);
    const expiresAtMs = this.clock() + (WS_TICKET_TTL_SECONDS * 1_000);
    const cleanupTimer = setTimeout(() => this.deleteTicket(ticketHash), WS_TICKET_TTL_SECONDS * 1_000);
    // [INTV:EDGE] unref(): 이 타이머가 아직 남아있다는 이유만으로 Node 프로세스가 종료를 미루지
    // 않게 한다 — 만료 정리용 백그라운드 타이머일 뿐이므로, graceful shutdown이 이 타이머를 기다릴
    // 필요는 없다는 표시(unref 없이 두면 활성 만료 타이머가 있는 한 프로세스가 못 죽는 문제가
    // 생긴다).
    cleanupTimer.unref();
    this.tickets.set(ticketHash, {
      user,
      ip,
      expiresAtMs,
      cleanupTimer
    });
    this.ticketHashByGuest.set(user.id, ticketHash);
    return ticket;
  }

  consumeWsTicket(ticketHash: string): GuestSessionUser | null {
    const stored = this.tickets.get(ticketHash);
    if (stored) clearTimeout(stored.cleanupTimer);
    this.tickets.delete(ticketHash);
    if (stored && this.ticketHashByGuest.get(stored.user.id) === ticketHash) {
      this.ticketHashByGuest.delete(stored.user.id);
    }
    if (!stored || this.clock() >= stored.expiresAtMs) return null;
    return stored.user;
  }

  // [INTV:EDGE] 게스트별로 "지금 몇 개의 WS 연결을 쓰고 있는지"를 대여(lease) 개념으로 관리한다 —
  // 빌려간 쪽이 release()를 불러야 자리가 반납된다. IP당 동시 접속 수와 전체 게스트 접속 수 양쪽에
  // 상한을 둬서, 익명 사용자가 무제한으로 소켓을 열어 서버 리소스를 고갈시키는 것을 막는다(DoS
  // 방어).
  acquireConnection(ip: string, guestId: string): ConnectionLease | null {
    const current = this.connections.get(guestId);
    const leaseId = randomUUID();
    if (current) {
      if (current.ip !== ip) {
        const connectionsForIp = [...this.connections.values()]
          .filter((connection) => connection.ip === ip).length;
        if (connectionsForIp >= this.connectionsPerIp) return null;
      }
      this.connections.set(guestId, { ip, leaseId });
      return this.lease(guestId, leaseId);
    }

    const connectionsForIp = [...this.connections.values()].filter((connection) => connection.ip === ip).length;
    if (connectionsForIp >= this.connectionsPerIp || this.connections.size >= this.connectionLimit) {
      return null;
    }
    this.connections.set(guestId, { ip, leaseId });
    return this.lease(guestId, leaseId);
  }

  private recordCreation(ip: string): void {
    this.recordWindowEvent({
      store: this.creationsByIp,
      key: ip,
      limit: this.creationLimitPerMinute,
      capacityCode: "guest_creation_capacity_reached",
      rateCode: "guest_creation_rate_limited",
      capacityMessage: "게스트 생성 요청을 추적할 수 있는 네트워크 수를 초과했습니다.",
      rateMessage: "게스트 생성 요청이 너무 많습니다. 잠시 후 다시 시도해주세요."
    });
  }

  private recordTicketIssue(ip: string): void {
    this.recordWindowEvent({
      store: this.ticketIssuesByIp,
      key: ip,
      limit: this.ticketIssueLimitPerMinute,
      capacityCode: "guest_ticket_rate_limited",
      rateCode: "guest_ticket_rate_limited",
      capacityMessage: "게스트 연결 요청이 많습니다. 잠시 후 다시 시도해주세요.",
      rateMessage: "게스트 연결 요청이 너무 잦습니다. 잠시 후 다시 시도해주세요."
    });
  }

  private lease(guestId: string, leaseId: string): ConnectionLease {
    return {
      release: () => {
        // [INTV:TRAP] leaseId를 다시 확인하는 이유: release가 늦게 불렸는데 그 사이 같은 guestId로
        // 새 연결이 이미 자리를 차지했다면(leaseId가 다름), 그 새 연결의 자리를 실수로 반납해버리면
        // 안 되기 때문 — guestId만으로 delete하면, 낡은 release 호출이 새 연결의 자리를 지워버리는
        // "레이스로 인한 잘못된 해제" 버그가 생긴다.
        if (this.connections.get(guestId)?.leaseId === leaseId) this.connections.delete(guestId);
      }
    };
  }

  private pruneExpiredTickets(): void {
    const nowMs = this.clock();
    for (const [ticketHash, ticket] of this.tickets) {
      if (nowMs < ticket.expiresAtMs) continue;
      clearTimeout(ticket.cleanupTimer);
      this.tickets.delete(ticketHash);
      if (this.ticketHashByGuest.get(ticket.user.id) === ticketHash) {
        this.ticketHashByGuest.delete(ticket.user.id);
      }
    }
  }

  // [INTV:TRADE_OFF] "롤링 윈도우" 속도 제한: 최근 CREATION_WINDOW_MS(1분) 안에 발생한 타임스탬프
  // 개수를 세어, limit을 넘으면 거부한다. 고정된 분 단위 구간(예: 매 정각 리셋)이 아니라 "지금으로부터
  // 1분 전까지"를 계속 미끄러뜨려 보므로, 구간 경계에서 순간적으로 두 배의 요청이 몰리는 고정 윈도우
  // 방식의 허점을 피한다(inputGate.ts의 토큰 버킷과는 다른 알고리즘이지만 같은 목표 — 여긴 타임스탬프
  // 배열을 직접 들고 비교하는 방식이라 메모리 사용량이 요청 빈도에 비례하고, 토큰 버킷은 숫자 하나만
  // 들면 되어 더 가볍다는 차이가 있다). creationsByIp와 ticketIssuesByIp 양쪽에서 이 로직을 재사용
  // 하기 위해 공통 함수로 뽑아뒀다.
  private recordWindowEvent(options: {
    store: Map<string, RollingWindow>;
    key: string;
    limit: number;
    capacityCode: GuestAccessError["code"];
    rateCode: GuestAccessError["code"];
    capacityMessage: string;
    rateMessage: string;
  }): void {
    const nowMs = this.clock();
    this.pruneWindows(options.store, nowMs);
    const existing = options.store.get(options.key);
    const recent = (existing?.timestamps ?? []).filter((createdAt) => createdAt > nowMs - CREATION_WINDOW_MS);
    // [INTV:EDGE] store.size(추적 중인 IP 개수) 자체에도 상한을 둔다 — 서로 다른 IP를 무수히
    // 바꿔가며 요청하면 이 Map이 끝없이 커져 메모리를 잡아먹을 수 있으므로("IP 스푸핑을 통한 메모리
    // 고갈" 공격), "처음 보는 IP인데 이미 추적 한도에 도달했다"면 거부한다 — 속도 제한 메커니즘
    // 자체가 메모리 DoS의 통로가 되지 않도록 한 이중 방어.
    if (!existing && options.store.size >= this.trackedIpLimit) {
      throw new GuestAccessError(options.capacityCode, options.capacityMessage);
    }
    if (recent.length >= options.limit) {
      throw new GuestAccessError(options.rateCode, options.rateMessage);
    }
    if (existing) clearTimeout(existing.cleanupTimer);
    recent.push(nowMs);
    const expiresAtMs = nowMs + CREATION_WINDOW_MS;
    const cleanupTimer = setTimeout(() => {
      const current = options.store.get(options.key);
      if (current?.expiresAtMs === expiresAtMs) options.store.delete(options.key);
    }, CREATION_WINDOW_MS);
    cleanupTimer.unref();
    options.store.set(options.key, { timestamps: recent, expiresAtMs, cleanupTimer });
  }

  private pruneWindows(store: Map<string, RollingWindow>, nowMs: number): void {
    for (const [key, window] of store) {
      if (nowMs < window.expiresAtMs) continue;
      clearTimeout(window.cleanupTimer);
      store.delete(key);
    }
  }

  private deleteTicket(ticketHash: string): void {
    const ticket = this.tickets.get(ticketHash);
    if (!ticket) return;
    this.tickets.delete(ticketHash);
    if (this.ticketHashByGuest.get(ticket.user.id) === ticketHash) {
      this.ticketHashByGuest.delete(ticket.user.id);
    }
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.options.secret).update(payload, "utf8").digest("base64url");
  }
}

type RollingWindow = {
  timestamps: number[];
  expiresAtMs: number;
  cleanupTimer: NodeJS.Timeout;
};

// [INTV:EDGE] timingSafeEqual: 바이트를 비교할 때 "몇 번째 바이트에서 처음 달랐는지"에 따라 비교
// 시간이 미묘하게 달라지지 않도록 항상 같은 시간이 걸리게 비교하는 함수. 일반 문자열 비교(===)는
// 다르면 그 즉시 멈추므로, 공격자가 응답 시간을 아주 정밀하게 측정해 서명을 한 바이트씩 추측해나가는
// "타이밍 공격"이 이론적으로 가능하다 — 서명 검증처럼 보안이 걸린 비교에는 항상 이런 상수 시간
// 비교를 쓴다.
// - [TRAP] 길이가 다르면 먼저 그 자체로 false 처리한다(timingSafeEqual은 길이가 다른 버퍼를 아예
//   거부하고 예외를 던지기 때문에 그 전에 걸러야 한다) — 이 길이 체크 자체는 상수 시간이 아니지만,
//   길이 정보는 애초에 비밀이 아니므로(서명은 고정 길이) 노출돼도 문제가 없다.
function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.byteLength === rightBuffer.byteLength && timingSafeEqual(leftBuffer, rightBuffer);
}

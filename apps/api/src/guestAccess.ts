import {
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import type { SessionUser } from "@pong-pong/shared";
import { createRawWsTicket, hashWsTicket, WS_TICKET_TTL_SECONDS } from "./wsTicket.js";

export const GUEST_SESSION_TTL_SECONDS = 2 * 60 * 60;
export const DEFAULT_GUEST_CREATION_LIMIT_PER_MINUTE = 10;
export const DEFAULT_GUEST_CONNECTIONS_PER_IP = 4;
export const DEFAULT_GUEST_CONNECTION_LIMIT = 200;
export const DEFAULT_GUEST_TICKET_LIMIT = 400;

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
};

type ConnectionLease = {
  release(): void;
};

export class GuestAccessError extends Error {
  constructor(
    readonly code: "guest_creation_rate_limited" | "guest_ticket_limit_reached",
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
  private readonly creationsByIp = new Map<string, number[]>();
  private readonly tickets = new Map<string, {
    user: GuestSessionUser;
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
  }

  get activeConnectionCount(): number {
    return this.connections.size;
  }

  get activeTicketCount(): number {
    this.pruneExpiredTickets();
    return this.tickets.size;
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
      return null;
    }
  }

  issueWsTicket(user: GuestSessionUser): string {
    this.pruneExpiredTickets();
    const previousHash = this.ticketHashByGuest.get(user.id);
    if (previousHash) {
      const previous = this.tickets.get(previousHash);
      if (previous) clearTimeout(previous.cleanupTimer);
      this.tickets.delete(previousHash);
      this.ticketHashByGuest.delete(user.id);
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
    cleanupTimer.unref();
    this.tickets.set(ticketHash, {
      user,
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
    const cutoff = this.clock() - CREATION_WINDOW_MS;
    const recent = (this.creationsByIp.get(ip) ?? []).filter((createdAt) => createdAt > cutoff);
    if (recent.length >= this.creationLimitPerMinute) {
      throw new GuestAccessError("guest_creation_rate_limited", "게스트 생성 요청이 너무 많습니다. 잠시 후 다시 시도해주세요.");
    }
    recent.push(this.clock());
    this.creationsByIp.set(ip, recent);
  }

  private lease(guestId: string, leaseId: string): ConnectionLease {
    return {
      release: () => {
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

function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.byteLength === rightBuffer.byteLength && timingSafeEqual(leftBuffer, rightBuffer);
}

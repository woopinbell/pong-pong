import {
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import type { SessionUser } from "@pong-pong/shared";

export const GUEST_SESSION_TTL_SECONDS = 2 * 60 * 60;

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
};

export class GuestAccess {
  private readonly clock: () => number;

  constructor(private readonly options: GuestAccessOptions) {
    if (Buffer.byteLength(options.secret, "utf8") < 32) {
      throw new Error("Guest session secret must be at least 32 bytes");
    }
    this.clock = options.clock ?? Date.now;
  }

  createSession(ip: string): {
    user: GuestSessionUser;
    cookieValue: string;
    expiresInSeconds: number;
  } {
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

  private sign(payload: string): string {
    return createHmac("sha256", this.options.secret).update(payload, "utf8").digest("base64url");
  }
}

function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.byteLength === rightBuffer.byteLength && timingSafeEqual(leftBuffer, rightBuffer);
}

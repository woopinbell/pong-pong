import { afterEach, describe, expect, it, vi } from "vitest";
import { hashWsTicket } from "./wsTicket.js";
import {
  DEFAULT_GUEST_CONNECTION_LIMIT,
  DEFAULT_GUEST_CONNECTIONS_PER_IP,
  DEFAULT_GUEST_CREATION_LIMIT_PER_MINUTE,
  GUEST_SESSION_TTL_SECONDS,
  GuestAccess,
  GuestAccessError
} from "./guestAccess.js";

describe("GuestAccess", () => {
  afterEach(() => vi.useRealTimers());

  it("authenticates an HMAC-signed session for two hours and rejects tampering", () => {
    let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
    const access = createAccess({ clock: () => nowMs });
    const created = access.createSession("203.0.113.10");

    expect(created.expiresInSeconds).toBe(GUEST_SESSION_TTL_SECONDS);
    expect(created.user).toMatchObject({
      handle: expect.stringMatching(/^guest-[a-f0-9]{12}$/),
      displayName: expect.stringMatching(/^게스트 [0-9]{4}$/),
      sessionKind: "guest",
      role: "user",
      rating: 1_200
    });
    expect(access.authenticate(created.cookieValue)).toEqual(created.user);

    const replacement = created.cookieValue.endsWith("a") ? "b" : "a";
    const tampered = `${created.cookieValue.slice(0, -1)}${replacement}`;
    expect(access.authenticate(tampered)).toBeNull();

    nowMs += GUEST_SESSION_TTL_SECONDS * 1_000;
    expect(access.authenticate(created.cookieValue)).toBeNull();
  });

  it("allows ten creations per IP in a rolling minute", () => {
    let nowMs = 1_000_000;
    const access = createAccess({ clock: () => nowMs });

    for (let count = 0; count < DEFAULT_GUEST_CREATION_LIMIT_PER_MINUTE; count += 1) {
      expect(access.createSession("203.0.113.20").user.sessionKind).toBe("guest");
    }
    expect(() => access.createSession("203.0.113.20")).toThrowError(
      expect.objectContaining<Partial<GuestAccessError>>({ code: "guest_creation_rate_limited" })
    );

    nowMs += 60_000;
    expect(access.createSession("203.0.113.20").user.sessionKind).toBe("guest");
  });

  it("removes expired creation windows for inactive IP addresses", () => {
    let nowMs = 1_500_000;
    const access = createAccess({ clock: () => nowMs });
    access.createSession("203.0.113.21");
    access.createSession("203.0.113.22");
    expect(access.trackedCreationIpCount).toBe(2);

    nowMs += 60_000;
    access.createSession("203.0.113.23");
    expect(access.trackedCreationIpCount).toBe(1);
  });

  it("cleans inactive IP windows on time and bounds the tracked IP store", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const access = createAccess({ trackedIpLimit: 2 });
    access.createSession("203.0.113.24");
    access.createSession("203.0.113.25");
    expect(() => access.createSession("203.0.113.26")).toThrowError(
      expect.objectContaining<Partial<GuestAccessError>>({ code: "guest_creation_capacity_reached" })
    );

    await vi.advanceTimersByTimeAsync(60_000);
    expect(access.trackedCreationIpCount).toBe(0);
    expect(access.createSession("203.0.113.26").user.sessionKind).toBe("guest");
  });

  it("stores only a one-time hash for 30-second websocket tickets", () => {
    let nowMs = 2_000_000;
    const access = createAccess({ clock: () => nowMs });
    const guest = access.createSession("203.0.113.30").user;
    const ticket = access.issueWsTicket(guest, "203.0.113.30");

    expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(access.consumeWsTicket(hashWsTicket(ticket))).toEqual(guest);
    expect(access.consumeWsTicket(hashWsTicket(ticket))).toBeNull();

    const expired = access.issueWsTicket(guest, "203.0.113.30");
    nowMs += 30_000;
    expect(access.consumeWsTicket(hashWsTicket(expired))).toBeNull();
  });

  it("keeps one outstanding ticket per guest and bounds the process ticket store", () => {
    let nowMs = 3_000_000;
    const access = createAccess({ clock: () => nowMs, ticketLimit: 2 });
    const firstGuest = access.createSession("203.0.113.31").user;
    const secondGuest = access.createSession("203.0.113.32").user;
    const thirdGuest = access.createSession("203.0.113.33").user;

    const replaced = access.issueWsTicket(firstGuest, "203.0.113.31");
    const replacement = access.issueWsTicket(firstGuest, "203.0.113.31");
    expect(access.activeTicketCount).toBe(1);
    expect(access.consumeWsTicket(hashWsTicket(replaced))).toBeNull();

    access.issueWsTicket(firstGuest, "203.0.113.31");
    access.issueWsTicket(secondGuest, "203.0.113.32");
    expect(access.activeTicketCount).toBe(2);
    expect(() => access.issueWsTicket(thirdGuest, "203.0.113.33")).toThrowError(
      expect.objectContaining<Partial<GuestAccessError>>({ code: "guest_ticket_limit_reached" })
    );

    nowMs += 30_000;
    expect(access.issueWsTicket(thirdGuest, "203.0.113.33")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(access.activeTicketCount).toBe(1);
    expect(access.consumeWsTicket(hashWsTicket(replacement))).toBeNull();
  });

  it("cleans tickets on time and limits pending tickets and issuance per IP", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const pending = createAccess({ ticketsPerIp: 1 });
    const first = pending.createSession("198.51.100.31").user;
    const second = pending.createSession("198.51.100.31").user;
    pending.issueWsTicket(first, "198.51.100.31");
    expect(() => pending.issueWsTicket(second, "198.51.100.31")).toThrowError(
      expect.objectContaining<Partial<GuestAccessError>>({ code: "guest_ticket_ip_limit_reached" })
    );

    await vi.advanceTimersByTimeAsync(30_000);
    expect(pending.activeTicketCount).toBe(0);
    expect(pending.issueWsTicket(second, "198.51.100.31")).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const rate = createAccess({ ticketIssueLimitPerMinute: 2 });
    const guest = rate.createSession("198.51.100.32").user;
    rate.issueWsTicket(guest, "198.51.100.32");
    rate.issueWsTicket(guest, "198.51.100.32");
    expect(() => rate.issueWsTicket(guest, "198.51.100.32")).toThrowError(
      expect.objectContaining<Partial<GuestAccessError>>({ code: "guest_ticket_rate_limited" })
    );
  });

  it("limits guest sockets per IP and across the process", () => {
    expect(DEFAULT_GUEST_CONNECTIONS_PER_IP).toBe(4);
    expect(DEFAULT_GUEST_CONNECTION_LIMIT).toBe(200);

    const access = createAccess({ connectionsPerIp: 1, connectionLimit: 2 });
    const first = access.createSession("198.51.100.1").user;
    const second = access.createSession("198.51.100.2").user;
    const third = access.createSession("198.51.100.3").user;
    const sameIp = access.createSession("198.51.100.1").user;

    const firstLease = access.acquireConnection("198.51.100.1", first.id);
    expect(firstLease).not.toBeNull();
    expect(access.acquireConnection("198.51.100.1", sameIp.id)).toBeNull();
    const secondLease = access.acquireConnection("198.51.100.2", second.id);
    expect(secondLease).not.toBeNull();
    expect(access.acquireConnection("198.51.100.3", third.id)).toBeNull();

    firstLease?.release();
    const thirdLease = access.acquireConnection("198.51.100.3", third.id);
    expect(thirdLease).not.toBeNull();
    secondLease?.release();
    thirdLease?.release();
    expect(access.activeConnectionCount).toBe(0);
  });

  it("moves an existing guest lease without counting a replacement twice", () => {
    const access = createAccess({ connectionsPerIp: 1, connectionLimit: 1 });
    const guest = access.createSession("192.0.2.10").user;
    const first = access.acquireConnection("192.0.2.10", guest.id);
    const replacement = access.acquireConnection("192.0.2.10", guest.id);

    expect(first).not.toBeNull();
    expect(replacement).not.toBeNull();
    expect(access.activeConnectionCount).toBe(1);
    first?.release();
    expect(access.activeConnectionCount).toBe(1);
    replacement?.release();
    expect(access.activeConnectionCount).toBe(0);
  });

  it("does not move a replacement connection into an IP that is already full", () => {
    const access = createAccess({ connectionsPerIp: 1, connectionLimit: 3 });
    const first = access.createSession("192.0.2.20").user;
    const second = access.createSession("192.0.2.21").user;
    const firstLease = access.acquireConnection("192.0.2.20", first.id);
    const secondLease = access.acquireConnection("192.0.2.21", second.id);

    expect(firstLease).not.toBeNull();
    expect(secondLease).not.toBeNull();
    expect(access.acquireConnection("192.0.2.20", second.id)).toBeNull();
    expect(access.activeConnectionCount).toBe(2);

    firstLease?.release();
    expect(access.acquireConnection("192.0.2.20", second.id)).not.toBeNull();
    secondLease?.release();
  });
});

function createAccess(overrides: Partial<ConstructorParameters<typeof GuestAccess>[0]> = {}): GuestAccess {
  return new GuestAccess({
    secret: "guest-test-secret-that-is-long-enough",
    ...overrides
  });
}

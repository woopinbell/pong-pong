import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyRequest } from "fastify";
import type { AppRepository } from "@pong-pong/db";
import * as http from "@pong-pong/shared";
import type { SessionUser } from "@pong-pong/shared";
import { WebSocket, type RawData } from "ws";
import { GameHub, type DrainResult } from "./gameHub.js";
import {
  ApiHttpError,
  forbidden,
  installHttpErrorBoundary,
  notFound,
  parseInput,
  parseOutput,
  suspended,
  unauthorized
} from "./httpBoundary.js";
import {
  GUEST_SESSION_TTL_SECONDS,
  GuestAccess,
  GuestAccessError,
  type GuestSessionUser
} from "./guestAccess.js";
import { createLoggerOptions } from "./requestLogging.js";
import { readAppMode } from "./env.js";
import { createRawWsTicket, hashWsTicket, WS_TICKET_TTL_SECONDS } from "./wsTicket.js";
import { ApiMetrics, instrumentRepository } from "./observability.js";

const WS_POLICY_VIOLATION = 1008;
const WS_MESSAGE_TOO_BIG = 1009;
const PRE_AUTH_MESSAGE_MAX_BYTES = 8 * 1024;
const PRE_AUTH_MESSAGE_MAX_COUNT = 16;
const PRE_AUTH_BUFFER_MAX_BYTES = 32 * 1024;

export type AppMode = "development" | "test" | "production" | "demo";

export interface BuildAppOptions {
  repo: AppRepository;
  webOrigin: string;
  appMode?: AppMode;
  guestAccess?: GuestAccess;
  sessionSecret?: string;
  trustProxy?: boolean;
}

declare module "fastify" {
  interface FastifyInstance {
    beginDrain(timeoutMs?: number): Promise<DrainResult>;
  }
}

export function buildApp({
  repo: sourceRepo,
  webOrigin,
  appMode = readAppMode(),
  guestAccess,
  sessionSecret = process.env.SESSION_SECRET ?? "dev-session-secret",
  trustProxy = false
}: BuildAppOptions) {
  const app = Fastify({
    logger: createLoggerOptions(process.env.LOG_LEVEL ?? "info"),
    trustProxy
  });
  let readGameStats = () => ({ onlinePlayers: 0, queuedPlayers: 0, activeRooms: 0 });
  const metrics = new ApiMetrics(() => readGameStats());
  const repo = instrumentRepository(sourceRepo, metrics);
  const hub = new GameHub(repo, {
    roomCreated: (context) => {
      app.log.info(context, "game room created");
    },
    reconnect: (context) => {
      metrics.recordReconnect(context.outcome);
      app.log.info(context, "game connection recovery recorded");
    },
    matchFinalized: (context) => {
      metrics.recordFinalization(context.persistence, context.outcome);
      const level = context.outcome === "success" ? "info" : "warn";
      app.log[level](context, "match finalization recorded");
    },
    snapshotDelivered: (delayMs) => {
      metrics.observeSnapshotDelivery(delayMs);
    },
    snapshotDropped: (reason) => {
      metrics.recordSnapshotDrop(reason);
    }
  });
  readGameStats = () => hub.liveStats();
  let draining = false;
  const guests = appMode === "demo" ? guestAccess ?? new GuestAccess({ secret: sessionSecret }) : null;
  const getCurrentUser = async (request: FastifyRequest) => {
    const user = await currentUser(repo, request, guests, appMode === "demo");
    if (user) request.log.debug({ userId: user.id }, "request authenticated");
    return user;
  };

  app.decorate("beginDrain", async (timeoutMs = 60_000) => {
    draining = true;
    return hub.beginDrain(timeoutMs);
  });
  app.addHook("onResponse", (request, reply, done) => {
    metrics.observeRequest(
      request.method,
      request.routeOptions.url ?? "unmatched",
      reply.statusCode,
      reply.elapsedTime
    );
    done();
  });
  app.addHook("onClose", async () => {
    hub.close();
    metrics.close();
  });

  installHttpErrorBoundary(app);
  app.register(cors, {
    origin: [webOrigin, "http://localhost:3000", "http://localhost:8080"],
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["content-type", "x-request-id"]
  });
  app.register(cookie);
  app.register(async (realtime) => {
    await realtime.register(websocket);
    realtime.get("/ws", { websocket: true }, (socket, request) => {
      const pendingPayloads: string[] = [];
      let pendingBytes = 0;
      let authenticationClosed = false;
      const closeAuthentication = (code: number, reason: string) => {
        if (authenticationClosed) return;
        authenticationClosed = true;
        socket.off("message", bufferPayload);
        socket.close(code, reason);
      };
      const bufferPayload = (payload: RawData) => {
        if (authenticationClosed) return;
        const buffer = rawDataToBuffer(payload);
        if (buffer.byteLength > PRE_AUTH_MESSAGE_MAX_BYTES) {
          closeAuthentication(WS_MESSAGE_TOO_BIG, "pre-auth payload too large");
          return;
        }
        if (
          pendingPayloads.length >= PRE_AUTH_MESSAGE_MAX_COUNT
          || pendingBytes + buffer.byteLength > PRE_AUTH_BUFFER_MAX_BYTES
        ) {
          closeAuthentication(WS_MESSAGE_TOO_BIG, "pre-auth buffer limit exceeded");
          return;
        }
        pendingBytes += buffer.byteLength;
        pendingPayloads.push(buffer.toString("utf8"));
      };
      socket.on("message", bufferPayload);

      const query = request.query as Record<string, unknown>;
      if (query?.v !== "1") {
        closeAuthentication(WS_POLICY_VIOLATION, "unsupported websocket version");
        return;
      }
      const parsedQuery = http.wsHandshakeQuerySchema.safeParse(query);
      if (!parsedQuery.success) {
        closeAuthentication(WS_POLICY_VIOLATION, "invalid websocket ticket");
        return;
      }

      const ticketHash = hashWsTicket(parsedQuery.data.ticket);
      const guestUser = guests?.consumeWsTicket(ticketHash) ?? null;
      const authenticated = guestUser
        ? Promise.resolve(guestUser)
        : appMode === "demo"
          ? Promise.resolve(null)
          : repo.consumeWsTicket(ticketHash);
      authenticated
        .then((user) => {
          if (!user) {
            closeAuthentication(WS_POLICY_VIOLATION, "invalid websocket ticket");
            return;
          }
          if (authenticationClosed || socket.readyState !== WebSocket.OPEN) {
            return;
          }
          const lease = isGuestSession(user) ? guests?.acquireConnection(request.ip, user.id) : null;
          if (isGuestSession(user) && !lease) {
            closeAuthentication(WS_POLICY_VIOLATION, "guest connection limit exceeded");
            return;
          }
          if (lease) socket.once("close", () => lease.release());
          socket.off("message", bufferPayload);
          request.log.info({ userId: user.id }, "websocket authenticated");
          hub.connect(socket as WebSocket, request.raw, user, pendingPayloads, String(request.id));
        })
        .catch(() => closeAuthentication(1011, "websocket authentication failed"));
    });
  });

  app.get("/health", async () => parseOutput(http.healthResponseSchema, {
    ok: true,
    service: "pong-pong-api"
  }));

  app.get("/health/live", async () => parseOutput(http.liveHealthResponseSchema, {
    status: "ok",
    service: "pong-pong-api"
  }));

  app.get("/health/ready", async (request, reply) => {
    const startedAt = performance.now();
    try {
      const repository = await repo.checkReadiness();
      const ready = !draining
        && repository.database === "up"
        && (repository.migrations === "current" || repository.migrations === "not_applicable");
      const body = parseOutput(http.readyHealthResponseSchema, {
        status: ready ? "ready" : "not_ready",
        service: "pong-pong-api",
        checks: {
          lifecycle: draining ? "draining" : "accepting",
          database: repository.database,
          migrations: repository.migrations
        }
      });
      metrics.observeReadiness(body.status, performance.now() - startedAt);
      return reply.code(ready ? 200 : 503).send(body);
    } catch (error) {
      request.log.warn({ errorName: error instanceof Error ? error.name : "UnknownError" }, "readiness check failed");
      const body = parseOutput(http.readyHealthResponseSchema, {
        status: "not_ready",
        service: "pong-pong-api",
        checks: {
          lifecycle: draining ? "draining" : "accepting",
          database: "down",
          migrations: "unknown"
        }
      });
      metrics.observeReadiness("not_ready", performance.now() - startedAt);
      return reply.code(503).send(body);
    }
  });

  app.get("/metrics", async (_request, reply) => {
    reply.header("content-type", metrics.contentType);
    return reply.send(await metrics.scrape());
  });

  if (appMode === "development" || appMode === "test") {
    app.post("/auth/dev-login", async (request, reply) => {
      const body = parseInput(http.devLoginBodySchema, request.body);
      const user = await repo.upsertDevUser(body);
      const token = await repo.createSession(user.id);
      reply.setCookie("pp_session", token, {
        path: "/",
        sameSite: "lax",
        httpOnly: true,
        secure: useSecureCookies(appMode),
        maxAge: 60 * 60 * 24 * 14
      });
      return parseOutput(http.userResponseSchema, { user });
    });
  }

  if (appMode === "demo" && guests) {
    app.post("/auth/guest", async (request, reply) => {
      parseInput(http.emptyParamsSchema, request.body ?? {});
      try {
        const session = guests.createSession(request.ip);
        reply.setCookie("pp_guest", session.cookieValue, {
          path: "/",
          sameSite: "lax",
          httpOnly: true,
          secure: true,
          maxAge: GUEST_SESSION_TTL_SECONDS
        });
        return parseOutput(http.guestAuthResponseSchema, {
          user: session.user,
          guest: true,
          expiresInSeconds: session.expiresInSeconds
        });
      } catch (error) {
        if (error instanceof GuestAccessError) {
          throw new ApiHttpError(429, error.code, error.message);
        }
        throw error;
      }
    });
  }

  app.post("/auth/logout", async (request, reply) => {
    if (!isGuestSession(await getCurrentUser(request))) {
      await repo.deleteSession(readSessionToken(request));
    }
    reply.clearCookie("pp_session", { path: "/" });
    reply.clearCookie("pp_guest", { path: "/" });
    return parseOutput(http.okResponseSchema, { ok: true });
  });

  app.post("/auth/ws-ticket", async (request) => {
    parseInput(http.emptyParamsSchema, request.body ?? {});
    const user = await getCurrentUser(request);
    if (!user) unauthorized();
    if (!isActive(user)) suspended();

    let ticket: string;
    try {
      ticket = isGuestSession(user) && guests
        ? guests.issueWsTicket(user, request.ip)
        : createRawWsTicket();
    } catch (error) {
      if (error instanceof GuestAccessError) {
        throw new ApiHttpError(429, error.code, error.message);
      }
      throw error;
    }
    if (!isGuestSession(user)) {
      await repo.createWsTicket({
        userId: user.id,
        ticketHash: hashWsTicket(ticket),
        ttlSeconds: WS_TICKET_TTL_SECONDS
      });
    }
    return parseOutput(http.wsTicketResponseSchema, {
      ticket,
      expiresInSeconds: WS_TICKET_TTL_SECONDS,
      protocolVersion: 1
    });
  });

  app.get("/me", async (request) => {
    const user = await getCurrentUser(request);
    if (!user) unauthorized();
    return parseOutput(http.userResponseSchema, { user });
  });

  app.get("/auth/me", async (request) => {
    const user = await getCurrentUser(request);
    if (!user) unauthorized();
    return parseOutput(http.userResponseSchema, { user });
  });

  app.get("/users/:id", async (request) => {
    if (appMode === "demo") notFound("데모 모드에서는 제공하지 않는 기능입니다.");
    const { id } = parseInput(http.idParamsSchema, request.params);
    const user = await repo.getUserById(id);
    if (!user) notFound("사용자를 찾을 수 없습니다.");
    return parseOutput(http.publicUserResponseSchema, { user });
  });

  app.get("/lobby", async (request) => {
    const user = await getCurrentUser(request);
    const guest = isGuestSession(user);
    return parseOutput(http.lobbyResponseSchema, {
      me: user,
      onlinePlayers: hub.onlinePlayers(),
      recentMatches: appMode === "demo" || guest ? [] : await repo.listRecentMatches(user?.id),
      chat: appMode === "demo" || guest ? [] : await repo.listLobbyChat(),
      stats: hub.liveStats()
    });
  });

  app.post("/chat/lobby", async (request) => {
    const user = await getCurrentUser(request);
    if (!user) unauthorized();
    requireRegistered(user);
    if (!isActive(user)) suspended();
    const body = parseInput(http.chatBodySchema, request.body);
    return parseOutput(http.chatResponseSchema, {
      message: await repo.createChatMessage({
        scope: "lobby",
        roomId: null,
        senderId: user.id,
        body: body.body
      })
    });
  });

  app.get("/leaderboard", async () => {
    if (appMode === "demo") notFound("데모 모드에서는 제공하지 않는 기능입니다.");
    return parseOutput(http.leaderboardResponseSchema, { entries: await repo.listLeaderboard() });
  });

  app.get("/dashboard", async (request) => {
    const user = await getCurrentUser(request);
    if (!user) unauthorized();
    requireRegistered(user);
    return parseOutput(http.dashboardSummarySchema, await repo.getDashboard(user.id));
  });

  app.get("/profile/:handle", async (request) => {
    if (appMode === "demo") notFound("데모 모드에서는 제공하지 않는 기능입니다.");
    const { handle } = parseInput(http.handleParamsSchema, request.params);
    const user = await repo.getUserByHandle(handle);
    if (!user) notFound("프로필을 찾을 수 없습니다.");
    return parseOutput(http.profileResponseSchema, {
      user,
      recentMatches: await repo.listRecentMatches(user.id)
    });
  });

  app.get("/profile/me", async (request) => {
    const user = await getCurrentUser(request);
    if (!user) unauthorized();
    requireRegistered(user);
    return parseOutput(http.ownProfileResponseSchema, { profile: user });
  });

  app.patch("/profile/me", async (request) => {
    const user = await getCurrentUser(request);
    if (!user) unauthorized();
    requireRegistered(user);
    const body = parseInput(http.profileUpdateBodySchema, request.body);
    return parseOutput(http.ownProfileResponseSchema, {
      profile: await repo.updateProfile(user.id, body)
    });
  });

  app.get("/friends", async (request) => {
    const user = await getCurrentUser(request);
    if (!user) unauthorized();
    requireRegistered(user);
    return parseOutput(http.friendsResponseSchema, { friends: await repo.listFriends(user.id) });
  });

  const requestFriend = async (request: FastifyRequest) => {
    const user = await getCurrentUser(request);
    if (!user) unauthorized();
    requireRegistered(user);
    if (!isActive(user)) suspended();
    const body = parseInput(http.friendRequestBodySchema, request.body);
    return parseOutput(http.friendResponseSchema, {
      friend: await repo.requestFriend(user.id, body.handle)
    });
  };

  app.post("/friends/request", requestFriend);
  app.post("/friends", requestFriend);

  app.post("/friends/:id/accept", async (request) => {
    const user = await getCurrentUser(request);
    if (!user) unauthorized();
    requireRegistered(user);
    const { id } = parseInput(http.idParamsSchema, request.params);
    return parseOutput(http.friendResponseSchema, { friend: await repo.acceptFriend(user.id, id) });
  });

  app.get("/tournaments", async () => {
    if (appMode === "demo") notFound("데모 모드에서는 제공하지 않는 기능입니다.");
    return parseOutput(http.tournamentsResponseSchema, { tournaments: await repo.listTournaments() });
  });

  app.post("/tournaments", async (request) => {
    const user = await getCurrentUser(request);
    if (!user) unauthorized();
    requireRegistered(user);
    if (!isActive(user)) suspended();
    const body = parseInput(http.tournamentCreateBodySchema, request.body);
    return parseOutput(http.tournamentResponseSchema, {
      tournament: await repo.createTournament({ name: body.name, createdBy: user.id })
    });
  });

  app.post("/tournaments/:id/join", async (request) => {
    const user = await getCurrentUser(request);
    if (!user) unauthorized();
    requireRegistered(user);
    if (!isActive(user)) suspended();
    const { id } = parseInput(http.idParamsSchema, request.params);
    return parseOutput(http.tournamentResponseSchema, { tournament: await repo.joinTournament(id, user.id) });
  });

  if (appMode !== "demo") {
    app.get("/admin/users", async (request) => {
      const user = await requireAdmin(repo, request);
      return parseOutput(http.adminUsersResponseSchema, { users: await repo.listAdminUsers() });
    });

    app.get("/admin/actions", async (request) => {
      await requireAdmin(repo, request);
      return parseOutput(http.adminActionsResponseSchema, { actions: await repo.listAdminActions() });
    });

    app.post("/admin/users/:id/ban", async (request) => {
      const user = await requireAdmin(repo, request);
      const { id } = parseInput(http.idParamsSchema, request.params);
      const body = parseInput(http.adminBanBodySchema, request.body ?? {});
      return parseOutput(http.publicUserResponseSchema, {
        user: await repo.setUserBan(user.id, id, body.banned ?? true, body.reason ?? "manual review")
      });
    });

    app.patch("/admin/users/:id/status", async (request) => {
      const user = await requireAdmin(repo, request);
      const { id } = parseInput(http.idParamsSchema, request.params);
      const body = parseInput(http.adminStatusBodySchema, request.body);
      return parseOutput(http.publicUserResponseSchema, {
        user: await repo.setUserBan(user.id, id, body.status === "banned", body.reason ?? "manual review")
      });
    });
  }

  return app;
}

function readSessionToken(request: FastifyRequest): string | undefined {
  return request.cookies?.pp_session;
}

async function currentUser(
  repo: AppRepository,
  request: FastifyRequest,
  guests: GuestAccess | null = null,
  guestOnly = false
): Promise<SessionUser | GuestSessionUser | null> {
  const guest = guests?.authenticate(request.cookies?.pp_guest, request.ip) ?? null;
  if (guest || guestOnly) return guest;
  return repo.getSessionUser(readSessionToken(request));
}

async function requireAdmin(repo: AppRepository, request: FastifyRequest): Promise<SessionUser> {
  const user = await currentUser(repo, request);
  if (!user) unauthorized();
  if (user.role !== "admin") forbidden();
  return user;
}

function isActive(user: SessionUser): boolean {
  return user.status === "active";
}

function isGuestSession(user: SessionUser | GuestSessionUser | null): user is GuestSessionUser {
  return Boolean(user && "sessionKind" in user && user.sessionKind === "guest");
}

function requireRegistered(user: SessionUser | GuestSessionUser): void {
  if (isGuestSession(user)) {
    throw new ApiHttpError(403, "guest_feature_forbidden", "게스트 계정에서는 사용할 수 없는 기능입니다.");
  }
}

function useSecureCookies(mode: AppMode): boolean {
  return mode === "production" || mode === "demo";
}

function rawDataToBuffer(payload: RawData): Buffer {
  if (Array.isArray(payload)) return Buffer.concat(payload);
  if (payload instanceof ArrayBuffer) return Buffer.from(payload);
  return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
}

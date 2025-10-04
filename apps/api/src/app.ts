import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyRequest } from "fastify";
import type { AppRepository } from "@pong-pong/db";
import * as http from "@pong-pong/shared";
import type { SessionUser } from "@pong-pong/shared";
import { WebSocket, type RawData } from "ws";
import { GameHub } from "./gameHub";
import {
  forbidden,
  installHttpErrorBoundary,
  notFound,
  parseInput,
  parseOutput,
  suspended,
  unauthorized
} from "./httpBoundary";
import { createRawWsTicket, hashWsTicket, WS_TICKET_TTL_SECONDS } from "./wsTicket";

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
}

export function buildApp({ repo, webOrigin, appMode = readAppMode() }: BuildAppOptions) {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  const hub = new GameHub(repo);

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

      repo.consumeWsTicket(hashWsTicket(parsedQuery.data.ticket))
        .then((user) => {
          if (!user) {
            closeAuthentication(WS_POLICY_VIOLATION, "invalid websocket ticket");
            return;
          }
          if (authenticationClosed || socket.readyState !== WebSocket.OPEN) {
            return;
          }
          socket.off("message", bufferPayload);
          hub.connect(socket as WebSocket, request.raw, user, pendingPayloads);
        })
        .catch(() => closeAuthentication(1011, "websocket authentication failed"));
    });
  });

  app.get("/health", async () => parseOutput(http.healthResponseSchema, {
    ok: true,
    service: "pong-pong-api"
  }));

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

  app.post("/auth/logout", async (request, reply) => {
    await repo.deleteSession(readSessionToken(request));
    reply.clearCookie("pp_session", { path: "/" });
    return parseOutput(http.okResponseSchema, { ok: true });
  });

  app.post("/auth/ws-ticket", async (request) => {
    parseInput(http.emptyParamsSchema, request.body ?? {});
    const user = await currentUser(repo, request);
    if (!user) unauthorized();
    if (!isActive(user)) suspended();

    const ticket = createRawWsTicket();
    await repo.createWsTicket({
      userId: user.id,
      ticketHash: hashWsTicket(ticket),
      ttlSeconds: WS_TICKET_TTL_SECONDS
    });
    return parseOutput(http.wsTicketResponseSchema, {
      ticket,
      expiresInSeconds: WS_TICKET_TTL_SECONDS,
      protocolVersion: 1
    });
  });

  app.get("/me", async (request) => {
    const user = await currentUser(repo, request);
    if (!user) unauthorized();
    return parseOutput(http.userResponseSchema, { user });
  });

  app.get("/auth/me", async (request) => {
    const user = await currentUser(repo, request);
    if (!user) unauthorized();
    return parseOutput(http.userResponseSchema, { user });
  });

  app.get("/users/:id", async (request) => {
    const { id } = parseInput(http.idParamsSchema, request.params);
    const user = await repo.getUserById(id);
    if (!user) notFound("사용자를 찾을 수 없습니다.");
    return parseOutput(http.publicUserResponseSchema, { user });
  });

  app.get("/lobby", async (request) => {
    const user = await currentUser(repo, request);
    return parseOutput(http.lobbyResponseSchema, {
      me: user,
      onlinePlayers: hub.onlinePlayers(),
      recentMatches: await repo.listRecentMatches(user?.id),
      chat: await repo.listLobbyChat(),
      stats: hub.liveStats()
    });
  });

  app.post("/chat/lobby", async (request) => {
    const user = await currentUser(repo, request);
    if (!user) unauthorized();
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

  app.get("/leaderboard", async () => parseOutput(http.leaderboardResponseSchema, {
    entries: await repo.listLeaderboard()
  }));

  app.get("/dashboard", async (request) => {
    const user = await currentUser(repo, request);
    if (!user) unauthorized();
    return parseOutput(http.dashboardSummarySchema, await repo.getDashboard(user.id));
  });

  app.get("/profile/:handle", async (request) => {
    const { handle } = parseInput(http.handleParamsSchema, request.params);
    const user = await repo.getUserByHandle(handle);
    if (!user) notFound("프로필을 찾을 수 없습니다.");
    return parseOutput(http.profileResponseSchema, {
      user,
      recentMatches: await repo.listRecentMatches(user.id)
    });
  });

  app.get("/profile/me", async (request) => {
    const user = await currentUser(repo, request);
    if (!user) unauthorized();
    return parseOutput(http.ownProfileResponseSchema, { profile: user });
  });

  app.patch("/profile/me", async (request) => {
    const user = await currentUser(repo, request);
    if (!user) unauthorized();
    const body = parseInput(http.profileUpdateBodySchema, request.body);
    return parseOutput(http.ownProfileResponseSchema, {
      profile: await repo.updateProfile(user.id, body)
    });
  });

  app.get("/friends", async (request) => {
    const user = await currentUser(repo, request);
    if (!user) unauthorized();
    return parseOutput(http.friendsResponseSchema, { friends: await repo.listFriends(user.id) });
  });

  const requestFriend = async (request: FastifyRequest) => {
    const user = await currentUser(repo, request);
    if (!user) unauthorized();
    if (!isActive(user)) suspended();
    const body = parseInput(http.friendRequestBodySchema, request.body);
    return parseOutput(http.friendResponseSchema, {
      friend: await repo.requestFriend(user.id, body.handle)
    });
  };

  app.post("/friends/request", requestFriend);
  app.post("/friends", requestFriend);

  app.post("/friends/:id/accept", async (request) => {
    const user = await currentUser(repo, request);
    if (!user) unauthorized();
    const { id } = parseInput(http.idParamsSchema, request.params);
    return parseOutput(http.friendResponseSchema, { friend: await repo.acceptFriend(user.id, id) });
  });

  app.get("/tournaments", async () => parseOutput(http.tournamentsResponseSchema, {
    tournaments: await repo.listTournaments()
  }));

  app.post("/tournaments", async (request) => {
    const user = await currentUser(repo, request);
    if (!user) unauthorized();
    if (!isActive(user)) suspended();
    const body = parseInput(http.tournamentCreateBodySchema, request.body);
    return parseOutput(http.tournamentResponseSchema, {
      tournament: await repo.createTournament({ name: body.name, createdBy: user.id })
    });
  });

  app.post("/tournaments/:id/join", async (request) => {
    const user = await currentUser(repo, request);
    if (!user) unauthorized();
    if (!isActive(user)) suspended();
    const { id } = parseInput(http.idParamsSchema, request.params);
    return parseOutput(http.tournamentResponseSchema, { tournament: await repo.joinTournament(id, user.id) });
  });

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

  return app;
}

function readSessionToken(request: FastifyRequest): string | undefined {
  return request.cookies?.pp_session;
}

async function currentUser(repo: AppRepository, request: FastifyRequest): Promise<SessionUser | null> {
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

function readAppMode(input = process.env): AppMode {
  if (input.APP_MODE === "demo") return "demo";
  if (input.NODE_ENV === "production") return "production";
  if (input.NODE_ENV === "test") return "test";
  return "development";
}

function useSecureCookies(mode: AppMode): boolean {
  return mode === "production" || mode === "demo";
}

function rawDataToBuffer(payload: RawData): Buffer {
  if (Array.isArray(payload)) return Buffer.concat(payload);
  if (payload instanceof ArrayBuffer) return Buffer.from(payload);
  return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
}

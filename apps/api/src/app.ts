import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import type { AppRepository } from "@pong-pong/db";
import type { SessionUser } from "@pong-pong/shared";
import type { WebSocket } from "ws";
import { GameHub } from "./gameHub";

export interface BuildAppOptions {
  repo: AppRepository;
  webOrigin: string;
}

export function buildApp({ repo, webOrigin }: BuildAppOptions) {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  const hub = new GameHub(repo);

  app.register(cors, {
    origin: [webOrigin, "http://localhost:3000", "http://localhost:8080"],
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["content-type", "authorization"]
  });
  app.register(cookie);
  app.register(async (realtime) => {
    await realtime.register(websocket);
    realtime.get("/ws", { websocket: true }, (socket, request) => {
      const pendingPayloads: string[] = [];
      const bufferPayload = (payload: Buffer) => pendingPayloads.push(payload.toString());
      socket.on("message", bufferPayload);
      currentUser(repo, request)
        .then((user) => {
          if (!user) {
            socket.close(1008, "unauthorized");
            return;
          }
          if (user.status !== "active") {
            socket.close(1008, "account suspended");
            return;
          }
          socket.off("message", bufferPayload);
          hub.connect(socket as WebSocket, request.raw, user, pendingPayloads);
        })
        .catch(() => socket.close(1011, "authentication failed"));
    });
  });

  app.get("/health", async () => ({ ok: true, service: "pong-pong-api" }));

  app.post("/auth/dev-login", async (request, reply) => {
    const body = request.body as { handle?: string; displayName?: string; email?: string };
    const user = await repo.upsertDevUser({
      handle: body.handle ?? "player",
      displayName: body.displayName ?? body.handle ?? "플레이어",
      email: body.email
    });
    const token = await repo.createSession(user.id);
    reply.setCookie("pp_session", token, {
      path: "/",
      sameSite: "lax",
      httpOnly: true,
      maxAge: 60 * 60 * 24 * 14
    });
    return { user, token };
  });

  app.post("/auth/logout", async (_request, reply) => {
    reply.clearCookie("pp_session", { path: "/" });
    return { ok: true };
  });

  app.get("/me", async (request, reply) => {
    const user = await currentUser(repo, request);
    if (!user) return unauthorized(reply);
    return { user };
  });

  app.get("/auth/me", async (request, reply) => {
    const user = await currentUser(repo, request);
    if (!user) return unauthorized(reply);
    return { user };
  });

  app.get("/users/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = await repo.getUserById(id);
    if (!user) return reply.code(404).send({ message: "not_found" });
    return { user };
  });

  app.get("/lobby", async (request) => {
    const user = await currentUser(repo, request);
    return {
      me: user,
      onlinePlayers: await repo.listOnlineUsers(),
      recentMatches: await repo.listRecentMatches(user?.id),
      chat: await repo.listLobbyChat(),
      stats: hub.liveStats()
    };
  });

  app.post("/chat/lobby", async (request, reply) => {
    const user = await currentUser(repo, request);
    if (!user) return unauthorized(reply);
    if (!isActive(user)) return suspended(reply);
    const body = (request.body ?? {}) as { body?: string };
    const messageBody = body.body?.trim() ?? "";
    if (!messageBody) return reply.code(400).send({ message: "메시지를 입력해주세요." });
    if (messageBody.length > 240) return reply.code(400).send({ message: "메시지는 240자 이내로 입력해주세요." });
    return {
      message: await repo.createChatMessage({
        scope: "lobby",
        roomId: null,
        senderId: user.id,
        body: messageBody
      })
    };
  });

  app.get("/leaderboard", async () => ({ entries: await repo.listLeaderboard() }));

  app.get("/dashboard", async (request, reply) => {
    const user = await currentUser(repo, request);
    if (!user) return unauthorized(reply);
    return await repo.getDashboard(user.id);
  });

  app.get("/profile/:handle", async (request, reply) => {
    const { handle } = request.params as { handle: string };
    const user = await repo.getUserByHandle(handle);
    if (!user) return reply.code(404).send({ message: "프로필을 찾을 수 없습니다." });
    return {
      user,
      recentMatches: await repo.listRecentMatches(user.id)
    };
  });

  app.get("/profile/me", async (request, reply) => {
    const user = await currentUser(repo, request);
    if (!user) return unauthorized(reply);
    return { profile: user };
  });

  app.patch("/profile/me", async (request, reply) => {
    const user = await currentUser(repo, request);
    if (!user) return unauthorized(reply);
    const body = request.body as { displayName?: string; avatarKey?: string };
    return {
      profile: await repo.updateProfile(user.id, {
        displayName: body.displayName,
        avatarKey: body.avatarKey
      })
    };
  });

  app.get("/friends", async (request, reply) => {
    const user = await currentUser(repo, request);
    if (!user) return unauthorized(reply);
    return { friends: await repo.listFriends(user.id) };
  });

  app.post("/friends/request", async (request, reply) => {
    const user = await currentUser(repo, request);
    if (!user) return unauthorized(reply);
    if (!isActive(user)) return suspended(reply);
    const body = request.body as { handle?: string };
    return { friend: await repo.requestFriend(user.id, body.handle ?? "") };
  });

  app.post("/friends", async (request, reply) => {
    const user = await currentUser(repo, request);
    if (!user) return unauthorized(reply);
    if (!isActive(user)) return suspended(reply);
    const body = request.body as { handle?: string };
    return { friend: await repo.requestFriend(user.id, body.handle ?? "") };
  });

  app.post("/friends/:id/accept", async (request, reply) => {
    const user = await currentUser(repo, request);
    if (!user) return unauthorized(reply);
    const { id } = request.params as { id: string };
    return { friend: await repo.acceptFriend(user.id, id) };
  });

  app.get("/tournaments", async () => ({ tournaments: await repo.listTournaments() }));

  app.post("/tournaments", async (request, reply) => {
    const user = await currentUser(repo, request);
    if (!user) return unauthorized(reply);
    if (!isActive(user)) return suspended(reply);
    const body = request.body as { name?: string };
    return { tournament: await repo.createTournament({ name: body.name ?? "퐁퐁 주간 컵", createdBy: user.id }) };
  });

  app.post("/tournaments/:id/join", async (request, reply) => {
    const user = await currentUser(repo, request);
    if (!user) return unauthorized(reply);
    if (!isActive(user)) return suspended(reply);
    const { id } = request.params as { id: string };
    return { tournament: await repo.joinTournament(id, user.id) };
  });

  app.get("/admin/users", async (request, reply) => {
    const user = await currentUser(repo, request);
    if (!user) return unauthorized(reply);
    if (user.role !== "admin") return reply.code(403).send({ message: "운영자 권한이 필요합니다." });
    return { users: await repo.listAdminUsers() };
  });

  app.get("/admin/actions", async (request, reply) => {
    const user = await currentUser(repo, request);
    if (!user) return unauthorized(reply);
    if (user.role !== "admin") return reply.code(403).send({ message: "운영자 권한이 필요합니다." });
    return { actions: await repo.listAdminActions() };
  });

  app.post("/admin/users/:id/ban", async (request, reply) => {
    const user = await currentUser(repo, request);
    if (!user) return unauthorized(reply);
    if (user.role !== "admin") return reply.code(403).send({ message: "운영자 권한이 필요합니다." });
    const { id } = request.params as { id: string };
    const body = request.body as { banned?: boolean; reason?: string };
    return { user: await repo.setUserBan(user.id, id, body.banned ?? true, body.reason ?? "manual review") };
  });

  app.patch("/admin/users/:id/status", async (request, reply) => {
    const user = await currentUser(repo, request);
    if (!user) return unauthorized(reply);
    if (user.role !== "admin") return reply.code(403).send({ message: "운영자 권한이 필요합니다." });
    const { id } = request.params as { id: string };
    const body = request.body as { status?: "active" | "banned"; reason?: string };
    return { user: await repo.setUserBan(user.id, id, body.status === "banned", body.reason ?? "manual review") };
  });

  return app;
}

async function currentUser(repo: AppRepository, request: FastifyRequest): Promise<SessionUser | null> {
  const cookieToken = request.cookies?.pp_session;
  const header = request.headers.authorization?.replace(/^Bearer\s+/i, "");
  const queryToken = (request.query as { session?: string } | undefined)?.session;
  const rawQueryToken = new URL(request.raw.url ?? "/", "http://localhost").searchParams.get("session") ?? undefined;
  return repo.getSessionUser(cookieToken ?? header ?? queryToken ?? rawQueryToken);
}

function unauthorized(reply: FastifyReply) {
  return reply.code(401).send({ message: "로그인이 필요합니다." });
}

function suspended(reply: FastifyReply) {
  return reply.code(403).send({ message: "정지된 계정은 이 작업을 수행할 수 없습니다." });
}

function isActive(user: SessionUser): boolean {
  return user.status === "active";
}

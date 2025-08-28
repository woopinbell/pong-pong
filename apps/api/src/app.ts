import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import type { AppRepository } from "@pong-pong/db";
import type { SessionUser } from "@pong-pong/shared";

export interface BuildAppOptions {
  repo: AppRepository;
  webOrigin: string;
}

export function buildApp({ repo, webOrigin }: BuildAppOptions) {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  app.register(cors, {
    origin: [webOrigin, "http://localhost:3000", "http://localhost:8080"],
    credentials: true
  });
  app.register(cookie);
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
      chat: await repo.listLobbyChat()
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
    return { user, recentMatches: await repo.listRecentMatches(user.id) };
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
    return { profile: await repo.updateProfile(user.id, body) };
  });

  app.get("/friends", async (request, reply) => {
    const user = await currentUser(repo, request);
    if (!user) return unauthorized(reply);
    return { friends: await repo.listFriends(user.id) };
  });

  app.post("/friends/request", async (request, reply) => {
    const user = await currentUser(repo, request);
    if (!user) return unauthorized(reply);
    const body = request.body as { handle?: string };
    return { friend: await repo.requestFriend(user.id, body.handle ?? "") };
  });

  app.post("/friends", async (request, reply) => {
    const user = await currentUser(repo, request);
    if (!user) return unauthorized(reply);
    const body = request.body as { handle?: string };
    return { friend: await repo.requestFriend(user.id, body.handle ?? "") };
  });

  app.post("/friends/:id/accept", async (request, reply) => {
    const user = await currentUser(repo, request);
    if (!user) return unauthorized(reply);
    const { id } = request.params as { id: string };
    return { friend: await repo.acceptFriend(user.id, id) };
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

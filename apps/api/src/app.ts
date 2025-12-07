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
  parseHttpRequest,
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

// [INTV:TRAP] TS 모듈 보강(declaration merging): Fastify 라이브러리가 정의한 FastifyInstance
// 타입에 이 프로젝트가 런타임에 app.decorate()로 추가한 beginDrain 메서드를 타입 레벨에서도
// 알려준다 — 이 선언이 없으면 아래 app.decorate("beginDrain", ...)로 실제로 붙인 메서드를 다른
// 파일(index.ts)에서 app.beginDrain(...)으로 쓸 때 TypeScript가 "그런 메서드 없음" 오류를 낸다.
// app.decorate는 런타임 동작이고 declare module은 컴파일 타임 타입 정보라, 이 둘을 항상 짝으로
// 맞춰야 한다는 게 재구현 시 놓치기 쉬운 지점.
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
      metrics.recordFinalization(context.persistence, context.outcome, context.created);
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

  // [INTV:ARCH] app.decorate: Fastify 인스턴스 자체에 커스텀 속성/메서드를 추가하는 API(위 모듈
  // 보강 선언과 짝을 이룬다).
  app.decorate("beginDrain", async (timeoutMs = 60_000) => {
    draining = true;
    return hub.beginDrain(timeoutMs);
  });
  // [INTV:ARCH] onResponse 훅: 모든 라우트가 응답을 보낸 직후 공통으로 실행된다 — 라우트 핸들러마다
  // 일일이 지표를 남기는 코드를 넣는 대신, 여기 한 곳에서 모든 HTTP 요청의 처리 시간/상태코드를
  // 자동으로 관측한다(observability.ts의 Proxy 기반 리포지토리 계측과 같은 "공통 관심사를 한 곳에
  // 모으는" 접근 — Express의 미들웨어, Spring의 인터셉터와 같은 위치의 개념을 Fastify의 훅으로
  // 구현한 것).
  app.addHook("onResponse", (request, reply, done) => {
    metrics.observeRequest(
      request.method,
      request.routeOptions.url ?? "unmatched",
      reply.statusCode,
      reply.elapsedTime
    );
    done();
  });
  // [INTV:ARCH] onClose 훅: app.close()가 호출될 때(정상 종료 절차 중) 실행된다 — 게임 허브와
  // 지표 레지스트리 등 애플리케이션이 들고 있던 자원을 정리한다(index.ts의 graceful shutdown 콜백이
  // app.close()를 부르는 순간 이 훅들이 연쇄 실행된다).
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
  // [INTV:ARCH] cors/cookie: Fastify 공식 플러그인 — app.register()로 등록하면 그 기능(CORS 헤더
  // 처리, 쿠키 파싱)이 이 앱 전역에 적용된다.
  app.register(cookie);
  // [INTV:ARCH] 별도의 async 함수를 app.register()에 넘기는 것은 Fastify의 "캡슐화" 단위를 만드는
  // 방법이다 — 그 함수 안에서만 적용되는 플러그인/설정(여기서는 @fastify/websocket과 maxPayload
  // 옵션)을 앱 전역이 아니라 /ws 라우트로 국한시키기 위해 이렇게 감쌌다(다른 REST 라우트들이
  // 실수로 WS 전용 설정의 영향을 받지 않도록 스코프를 분리).
  app.register(async (realtime) => {
    // { websocket: true }: @fastify/websocket이 제공하는 라우트 옵션 — 이 GET 요청을 일반 HTTP 응답 대신
    // WS 업그레이드로 처리하고, 콜백에 ws 라이브러리의 실제 소켓 객체를 넘겨준다.
    await realtime.register(websocket, { options: { maxPayload: PRE_AUTH_MESSAGE_MAX_BYTES } });
    realtime.get("/ws", { websocket: true }, (socket, request) => {
      // [INTV:EDGE] 티켓 검증(아래 authenticated.then(...))은 비동기라 그 사이에도 클라이언트가
      // 메시지를 보낼 수 있다. 인증이 끝나기 전 도착한 메시지는 즉시 처리하지 않고 여기서 개수·바이트
      // 상한을 걸어 버퍼에만 쌓아뒀다가, 인증에 성공하면 hub.connect()에 pendingPayloads로 통째로
      // 넘겨 재생한다(ws-ticket.test.ts의 "pre-authentication" 테스트들이 검증하는 게 바로 이
      // 로직) — 상한이 없으면 인증조차 안 된 연결이 무제한으로 메시지를 보내 서버 메모리를 고갈시킬
      // 수 있다(guestAccess.ts의 연결/티켓 한도와 같은 계열의 방어).
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
        // [INTV:EDGE] 메시지 하나가 너무 크거나(개별 상한), 누적된 메시지 개수/바이트 총합이
        // 상한을 넘으면 그 자리에서 인증을 실패 처리하고 끊는다 — 인증도 안 된 소켓이 서버 메모리를
        // 무한정 채우는 걸 막기 위함(개별 메시지 크기 상한과 누적 총량 상한을 모두 두는 이중 방어 —
        // 크기가 작은 메시지를 아주 많이 보내는 공격은 개별 상한만으로는 못 막는다).
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
      // [INTV:ARCH] 티켓 검증은 두 경로로 나뉜다: 게스트 티켓은 GuestAccess(프로세스 메모리에만
      // 있는, DB에 안 남는 상태)에서 확인하고, 그게 아니면(데모 모드가 아닌 한) DB에 저장된 진짜
      // 티켓을 repo.consumeWsTicket으로 확인한다 — 데모 모드는 애초에 등록 계정 로그인을 지원하지
      // 않으므로 그 경로 자체를 시도하지 않는다(불필요한 DB 조회를 건너뛰는 최적화이자, 데모 모드의
      // 의도된 기능 제약을 코드로도 강제).
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
          // [INTV:EDGE] 게스트에게만 별도의 접속 수 한도(guestAccess.ts의 acquireConnection)를
          // 추가로 건다 — 등록 계정은 GameHub 자체가 "계정당 활성 연결 1개"를 보장하지만, 게스트는
          // 계정 생성 자체가 무제한이라 IP/프로세스 단위의 별도 상한이 더 필요하다(계정 생성 비용이
          // 없는 인증 방식일수록 다른 축의 제한이 더 중요해진다는 일반 원칙).
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

  app.get("/health", async (request) => {
    parseHttpRequest(http.jsonHttpRequestContracts.health, request);
    return parseOutput(http.healthResponseSchema, {
      ok: true,
      service: "pong-pong-api"
    });
  });

  app.get("/health/live", async (request) => {
    parseHttpRequest(http.jsonHttpRequestContracts.healthLive, request);
    return parseOutput(http.liveHealthResponseSchema, {
      status: "ok",
      service: "pong-pong-api"
    });
  });

  app.get("/health/ready", async (request, reply) => {
    parseHttpRequest(http.jsonHttpRequestContracts.healthReady, request);
    const startedAt = performance.now();
    try {
      const repository = await repo.checkReadiness();
      // [INTV:ARCH] http.ts의 readyHealthResponseSchema에서 설명한 "준비 완료" 판정을 여기서
      // 실제로 계산한다: 드레인 중이 아니고, DB가 살아있고, 마이그레이션이 최신이거나(current)
      // 애초에 마이그레이션 개념이 없는 메모리 저장소(not_applicable)여야 한다 — liveness(살아있나)
      // 와 readiness(트래픽을 받아도 되나)를 별도 엔드포인트로 분리한 것도 이 판정 때문: draining
      // 중에는 프로세스는 살아있지만(live) 새 요청은 받으면 안 되므로(not ready) 로드밸런서가
      // 트래픽을 끊어야 한다.
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

  // [INTV:EDGE] 앱 실행 모드(development/test/production/demo)에 따라 아예 등록되지 않는 라우트들이
  // 있다 — 예를 들어 dev-login은 비밀번호 없이 handle만으로 로그인되는 "개발용 우회 로그인"이라
  // 운영/데모 환경에는 절대 노출되면 안 된다. 이 아래 여러 if(appMode === ...) 블록들이 전부 같은
  // 이유의 모드별 기능 게이팅이다 — 런타임 조건(로그인 여부 등)이 아니라 "빌드/배포 시점에 결정된
  // 모드"에 따라 라우트 자체를 등록하지 않는 방식이라, 데모/운영 환경에서는 그 핸들러 코드가
  // 존재조차 하지 않는다(런타임에 접근 거부하는 것보다 더 강한 보장).
  if (appMode === "development" || appMode === "test") {
    app.post("/auth/dev-login", async (request, reply) => {
      const { body } = parseHttpRequest(http.jsonHttpRequestContracts.devLogin, request);
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
      parseHttpRequest(http.jsonHttpRequestContracts.guestLogin, request);
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
    parseHttpRequest(http.jsonHttpRequestContracts.logout, request);
    if (!isGuestSession(await getCurrentUser(request))) {
      await repo.deleteSession(readSessionToken(request));
    }
    reply.clearCookie("pp_session", { path: "/" });
    reply.clearCookie("pp_guest", { path: "/" });
    return parseOutput(http.okResponseSchema, { ok: true });
  });

  app.post("/auth/ws-ticket", async (request) => {
    parseHttpRequest(http.jsonHttpRequestContracts.wsTicket, request);
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
    parseHttpRequest(http.jsonHttpRequestContracts.me, request);
    const user = await getCurrentUser(request);
    if (!user) unauthorized();
    return parseOutput(http.userResponseSchema, { user });
  });

  app.get("/auth/me", async (request) => {
    parseHttpRequest(http.jsonHttpRequestContracts.authMe, request);
    const user = await getCurrentUser(request);
    if (!user) unauthorized();
    return parseOutput(http.userResponseSchema, { user });
  });

  app.get("/users/:id", async (request) => {
    const { params: { id } } = parseHttpRequest(http.jsonHttpRequestContracts.userById, request);
    if (appMode === "demo") notFound("데모 모드에서는 제공하지 않는 기능입니다.");
    const user = await repo.getUserById(id);
    if (!user) notFound("사용자를 찾을 수 없습니다.");
    return parseOutput(http.publicUserResponseSchema, { user });
  });

  app.get("/lobby", async (request) => {
    parseHttpRequest(http.jsonHttpRequestContracts.lobby, request);
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
    const { body } = parseHttpRequest(http.jsonHttpRequestContracts.lobbyChat, request);
    const user = await getCurrentUser(request);
    if (!user) unauthorized();
    requireRegistered(user);
    if (!isActive(user)) suspended();
    return parseOutput(http.chatResponseSchema, {
      message: await repo.createChatMessage({
        scope: "lobby",
        roomId: null,
        senderId: user.id,
        body: body.body
      })
    });
  });

  app.get("/leaderboard", async (request) => {
    parseHttpRequest(http.jsonHttpRequestContracts.leaderboard, request);
    if (appMode === "demo") notFound("데모 모드에서는 제공하지 않는 기능입니다.");
    return parseOutput(http.leaderboardResponseSchema, { entries: await repo.listLeaderboard() });
  });

  app.get("/dashboard", async (request) => {
    parseHttpRequest(http.jsonHttpRequestContracts.dashboard, request);
    const user = await getCurrentUser(request);
    if (!user) unauthorized();
    requireRegistered(user);
    return parseOutput(http.dashboardSummarySchema, await repo.getDashboard(user.id));
  });

  app.get("/profile/:handle", async (request) => {
    const { params: { handle } } = parseHttpRequest(
      http.jsonHttpRequestContracts.profileByHandle,
      request
    );
    if (appMode === "demo") notFound("데모 모드에서는 제공하지 않는 기능입니다.");
    const user = await repo.getUserByHandle(handle);
    if (!user) notFound("프로필을 찾을 수 없습니다.");
    return parseOutput(http.profileResponseSchema, {
      user,
      recentMatches: await repo.listRecentMatches(user.id)
    });
  });

  app.get("/profile/me", async (request) => {
    parseHttpRequest(http.jsonHttpRequestContracts.ownProfile, request);
    const user = await getCurrentUser(request);
    if (!user) unauthorized();
    requireRegistered(user);
    return parseOutput(http.ownProfileResponseSchema, { profile: user });
  });

  app.patch("/profile/me", async (request) => {
    const { body } = parseHttpRequest(http.jsonHttpRequestContracts.updateOwnProfile, request);
    const user = await getCurrentUser(request);
    if (!user) unauthorized();
    requireRegistered(user);
    return parseOutput(http.ownProfileResponseSchema, {
      profile: await repo.updateProfile(user.id, body)
    });
  });

  app.get("/friends", async (request) => {
    parseHttpRequest(http.jsonHttpRequestContracts.friends, request);
    const user = await getCurrentUser(request);
    if (!user) unauthorized();
    requireRegistered(user);
    return parseOutput(http.friendsResponseSchema, { friends: await repo.listFriends(user.id) });
  });

  const requestFriend = async (request: FastifyRequest) => {
    const { body } = parseHttpRequest(http.jsonHttpRequestContracts.requestFriend, request);
    const user = await getCurrentUser(request);
    if (!user) unauthorized();
    requireRegistered(user);
    if (!isActive(user)) suspended();
    return parseOutput(http.friendResponseSchema, {
      friend: await repo.requestFriend(user.id, body.handle)
    });
  };

  app.post("/friends/request", requestFriend);
  app.post("/friends", requestFriend);

  app.post("/friends/:id/accept", async (request) => {
    const { params: { id } } = parseHttpRequest(
      http.jsonHttpRequestContracts.acceptFriend,
      request
    );
    const user = await getCurrentUser(request);
    if (!user) unauthorized();
    requireRegistered(user);
    return parseOutput(http.friendResponseSchema, { friend: await repo.acceptFriend(user.id, id) });
  });

  app.get("/tournaments", async (request) => {
    parseHttpRequest(http.jsonHttpRequestContracts.tournaments, request);
    if (appMode === "demo") notFound("데모 모드에서는 제공하지 않는 기능입니다.");
    return parseOutput(http.tournamentsResponseSchema, { tournaments: await repo.listTournaments() });
  });

  app.post("/tournaments", async (request) => {
    const { body } = parseHttpRequest(http.jsonHttpRequestContracts.createTournament, request);
    const user = await getCurrentUser(request);
    if (!user) unauthorized();
    requireRegistered(user);
    if (!isActive(user)) suspended();
    return parseOutput(http.tournamentResponseSchema, {
      tournament: await repo.createTournament({ name: body.name, createdBy: user.id })
    });
  });

  app.post("/tournaments/:id/join", async (request) => {
    const { params: { id } } = parseHttpRequest(
      http.jsonHttpRequestContracts.joinTournament,
      request
    );
    const user = await getCurrentUser(request);
    if (!user) unauthorized();
    requireRegistered(user);
    if (!isActive(user)) suspended();
    return parseOutput(http.tournamentResponseSchema, { tournament: await repo.joinTournament(id, user.id) });
  });

  if (appMode !== "demo") {
    app.get("/admin/users", async (request) => {
      parseHttpRequest(http.jsonHttpRequestContracts.adminUsers, request);
      const user = await requireAdmin(repo, request);
      return parseOutput(http.adminUsersResponseSchema, { users: await repo.listAdminUsers() });
    });

    app.get("/admin/actions", async (request) => {
      parseHttpRequest(http.jsonHttpRequestContracts.adminActions, request);
      await requireAdmin(repo, request);
      return parseOutput(http.adminActionsResponseSchema, { actions: await repo.listAdminActions() });
    });

    app.post("/admin/users/:id/ban", async (request) => {
      const {
        params: { id },
        body
      } = parseHttpRequest(http.jsonHttpRequestContracts.adminBan, request);
      const user = await requireAdmin(repo, request);
      const banned = body.banned ?? true;
      const target = await repo.setUserBan(user.id, id, banned, body.reason ?? "manual review");
      if (banned) hub.revokeUser(id);
      return parseOutput(http.publicUserResponseSchema, {
        user: target
      });
    });

    app.patch("/admin/users/:id/status", async (request) => {
      const {
        params: { id },
        body
      } = parseHttpRequest(http.jsonHttpRequestContracts.adminStatus, request);
      const user = await requireAdmin(repo, request);
      const banned = body.status === "banned";
      const target = await repo.setUserBan(user.id, id, banned, body.reason ?? "manual review");
      if (banned) hub.revokeUser(id);
      return parseOutput(http.publicUserResponseSchema, {
        user: target
      });
    });
  }

  return app;
}

function readSessionToken(request: FastifyRequest): string | undefined {
  return request.cookies?.pp_session;
}

// [INTV:PERF] guestOnly는 데모 모드에서 true로 넘어온다 — 데모 배포는 실제 등록 계정 로그인을
// 지원하지 않으므로, 게스트 쿠키가 없더라도 굳이 DB 세션 쪽을 조회하지 않고 바로 null(비로그인)로
// 처리한다(모든 요청마다 불필요한 DB 왕복을 피하는 최적화이자, 위의 라우트 게이팅과 같은 맥락의
// 모드별 동작 분리).
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
  if (!isActive(user)) suspended();
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

// [INTV:EDGE] 로컬 개발/테스트는 보통 HTTPS 없이 http://localhost로 돌리므로, Secure 쿠키 속성을
// 강제하면 브라우저가 쿠키를 아예 저장하지 않아 로그인이 깨진다 — 그래서 실제 배포 환경
// (production/demo)에서만 켠다(auth-user-crud 프로젝트의 REFRESH_COOKIE_OPTIONS와 동일한 판단).
function useSecureCookies(mode: AppMode): boolean {
  return mode === "production" || mode === "demo";
}

// [INTV:TRAP] ws 라이브러리가 메시지 콜백에 넘기는 RawData는 상황(프레임 조각화 여부 등)에 따라
// Buffer, Buffer 배열, 또는 ArrayBuffer로 모양이 다를 수 있다 — 이후 코드가 항상 하나의 Buffer만
// 다루면 되도록 여기서 통일한다. 이 정규화 없이 payload를 곧바로 문자열로 취급하면, 배열/ArrayBuffer
// 형태로 온 메시지에서 예기치 않은 타입 에러나 잘못된 디코딩이 발생한다.
function rawDataToBuffer(payload: RawData): Buffer {
  if (Array.isArray(payload)) return Buffer.concat(payload);
  if (payload instanceof ArrayBuffer) return Buffer.from(payload);
  return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
}

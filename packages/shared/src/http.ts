import { z } from "zod";

// [INTV:ARCH] 이 파일은 REST API의 요청/응답 계약(contract)을 정의한다 — 프론트/백엔드가 같은
// zod 스키마를 import해서 "서버가 실제로 보내는 값"과 "클라이언트가 기대하는 값"이 어긋나지 않도록
// 한다(ws.ts가 WS 프로토콜의 단일 진실 공급원이듯, 이 파일은 REST 계약의 단일 진실 공급원).
export const userRoleSchema = z.enum(["user", "admin"]);
export const userStatusSchema = z.enum(["active", "banned"]);
export const friendshipStatusSchema = z.enum(["pending", "accepted"]);
export const tournamentStatusSchema = z.enum(["open", "running", "finished"]);
export const matchModeSchema = z.enum(["queue", "ai", "tournament"]);

export type UserRole = z.infer<typeof userRoleSchema>;
export type UserStatus = z.infer<typeof userStatusSchema>;
export type FriendshipStatus = z.infer<typeof friendshipStatusSchema>;
export type TournamentStatus = z.infer<typeof tournamentStatusSchema>;
export type MatchMode = z.infer<typeof matchModeSchema>;

// [INTV:TRADE_OFF] 아래의 "응답" 쪽 스키마들은 .strict()를 쓰지 않는다 — 서버가 보내는 값의 모양을
// 서버 스스로 통제하므로 여분의 필드가 섞여도 치명적이지 않기 때문. 반대로 파일 하단의 "요청 바디"
// 스키마들은 대부분 .strict()를 쓴다 — 클라이언트가 보낸 값에 예상 못한 필드가 있으면 실수/오용일
// 가능성이 크므로 그 자리에서 거부하기 위함. game.ts는 응답 스키마에도 일관되게 .strict()를
// 쓰는데(WS 스냅샷은 대역폭이 민감해 여분 필드 자체가 낭비), 이 파일(REST)은 응답에서 엄격도를
// 낮춘 것 — 같은 프로젝트 안에서도 프로토콜 성격에 따라 트레이드오프 판단이 다르게 적용된 사례.
export const publicUserSchema = z.object({
  id: z.string().uuid(),
  handle: z.string().min(1),
  displayName: z.string().min(1),
  avatarKey: z.string(),
  role: userRoleSchema,
  status: userStatusSchema,
  rating: z.number().int(),
  wins: z.number().int().nonnegative(),
  losses: z.number().int().nonnegative(),
  online: z.boolean(),
  isNpc: z.boolean()
});

// [INTV:EDGE] .extend(): 기존 스키마 필드에 새 필드를 얹어 별도 스키마를 만드는 zod API. 로그인한
// 본인에게만 노출되는 email 필드를 publicUserSchema 위에 추가한 것 — "남에게 보이는 정보"와 "본인만
// 보는 정보"를 타입으로 구분한다(app.ts의 onlinePlayers()가 email을 명시적으로 구조분해 제외하는
// 것도 이 두 스키마를 뒤섞지 않기 위한 안전장치).
export const sessionUserSchema = publicUserSchema.extend({
  email: z.string().email().nullable()
});

export type PublicUser = z.infer<typeof publicUserSchema>;
export type SessionUser = z.infer<typeof sessionUserSchema>;

export const matchSummarySchema = z.object({
  id: z.string().uuid(),
  mode: matchModeSchema,
  opponentHandle: z.string().min(1),
  result: z.enum(["win", "loss"]),
  scoreLeft: z.number().int().nonnegative(),
  scoreRight: z.number().int().nonnegative(),
  ratingDelta: z.number().int(),
  endedAt: z.string().datetime()
});

export type MatchSummary = z.infer<typeof matchSummarySchema>;

export const dashboardSummarySchema = z.object({
  me: sessionUserSchema,
  recentMatches: z.array(matchSummarySchema),
  winRate: z.number().min(0).max(100),
  bestStreak: z.number().int().nonnegative()
});

export type DashboardSummary = z.infer<typeof dashboardSummarySchema>;

export const leaderboardEntrySchema = z.object({
  rank: z.number().int().positive(),
  user: publicUserSchema,
  winRate: z.number().min(0).max(100)
});

export type LeaderboardEntry = z.infer<typeof leaderboardEntrySchema>;

export const friendSummarySchema = z.object({
  id: z.string().uuid(),
  user: publicUserSchema,
  status: friendshipStatusSchema
});

export type FriendSummary = z.infer<typeof friendSummarySchema>;

export const chatMessageSchema = z.object({
  id: z.string().uuid(),
  scope: z.enum(["lobby", "match"]),
  roomId: z.string().uuid().nullable(),
  sender: publicUserSchema,
  body: z.string().min(1).max(240),
  createdAt: z.string().datetime()
});

export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const lobbyStatsSchema = z.object({
  onlinePlayers: z.number().int().nonnegative(),
  playingPlayers: z.number().int().nonnegative(),
  queuedPlayers: z.number().int().nonnegative(),
  activeRooms: z.number().int().nonnegative(),
  averageWaitSeconds: z.number().nonnegative().nullable()
});

export type LobbyStats = z.infer<typeof lobbyStatsSchema>;

export const lobbyResponseSchema = z.object({
  me: sessionUserSchema.nullable(),
  onlinePlayers: z.array(publicUserSchema),
  recentMatches: z.array(matchSummarySchema),
  chat: z.array(chatMessageSchema),
  stats: lobbyStatsSchema
});

export type LobbyResponse = z.infer<typeof lobbyResponseSchema>;

export const tournamentMatchSummarySchema = z.object({
  id: z.string().uuid(),
  tournamentId: z.string().uuid(),
  round: z.enum(["semifinal", "final"]),
  slot: z.number().int().nonnegative(),
  status: z.enum(["pending", "ready", "running", "finished"]),
  left: publicUserSchema.nullable(),
  right: publicUserSchema.nullable(),
  winner: publicUserSchema.nullable(),
  scoreLeft: z.number().int().nonnegative().nullable(),
  scoreRight: z.number().int().nonnegative().nullable(),
  roomId: z.string().uuid().nullable(),
  matchId: z.string().uuid().nullable()
});

export type TournamentMatchSummary = z.infer<typeof tournamentMatchSummarySchema>;

export const tournamentSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  status: tournamentStatusSchema,
  createdBy: publicUserSchema,
  playerCount: z.number().int().nonnegative(),
  capacity: z.number().int().positive(),
  winner: publicUserSchema.nullable(),
  entries: z.array(publicUserSchema),
  matches: z.array(tournamentMatchSummarySchema)
});

export type TournamentSummary = z.infer<typeof tournamentSummarySchema>;

export const adminActionSummarySchema = z.object({
  id: z.string().uuid(),
  actor: publicUserSchema.nullable(),
  target: publicUserSchema.nullable(),
  action: z.enum(["ban", "unban"]),
  reason: z.string(),
  createdAt: z.string().datetime()
});

export type AdminActionSummary = z.infer<typeof adminActionSummarySchema>;

// API 에러 응답의 공통 형태. fieldErrors는 필드별 유효성 검증 실패 메시지 목록 —
// z.record(z.array(z.string()))는 "키는 임의의 문자열, 값은 문자열 배열"인 딕셔너리 모양의 스키마.
export const apiErrorBodySchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    requestId: z.string().min(1),
    fieldErrors: z.record(z.array(z.string())).optional()
  })
});

export type ApiErrorBody = z.infer<typeof apiErrorBodySchema>;

export const emptyParamsSchema = z.object({}).strict();
export const idParamsSchema = z.object({ id: z.string().uuid() }).strict();
export const handleParamsSchema = z.object({ handle: z.string().min(1).max(64) }).strict();

export const devLoginBodySchema = z.object({
  handle: z.string().trim().min(2).max(24).regex(/^[a-z0-9][a-z0-9-]*$/),
  displayName: z.string().trim().min(1).max(40),
  email: z.string().trim().email().optional()
}).strict();

export const chatBodySchema = z.object({ body: z.string().trim().min(1).max(240) }).strict();
// .refine(): 필드 하나만으로는 표현할 수 없는 "필드 간" 규칙을 검증하는 zod API — 아래에서는
// "displayName과 avatarKey 둘 다 없는 빈 수정 요청"을 막는 데 쓰였다.
export const profileUpdateBodySchema = z.object({
  displayName: z.string().trim().min(1).max(40).optional(),
  avatarKey: z.string().trim().min(1).max(120).optional()
}).strict().refine((body) => body.displayName !== undefined || body.avatarKey !== undefined, {
  message: "변경할 프로필 값을 입력해주세요."
});
export const friendRequestBodySchema = z.object({ handle: z.string().trim().min(1).max(64) }).strict();
export const tournamentCreateBodySchema = z.object({ name: z.string().trim().min(1).max(80) }).strict();
export const adminBanBodySchema = z.object({
  banned: z.boolean().optional(),
  reason: z.string().trim().min(1).max(240).optional()
}).strict();
export const adminStatusBodySchema = z.object({
  status: userStatusSchema,
  reason: z.string().trim().min(1).max(240).optional()
}).strict();

// [INTV:ARCH] 제네릭 함수: Params/Query/Body 세 zod 스키마 타입을 그대로 보존한 채 하나의 객체로
// 묶어준다. "extends z.ZodTypeAny"는 "아무 zod 스키마 타입이나 허용"이라는 제약. 이렇게 묶어두면
// 이 계약을 사용하는 라우트 핸들러 쪽(httpBoundary.ts의 parseHttpRequest)에서 params/query/body
// 각각의 구체적인 타입을 그대로 추론받을 수 있다(묶지 않고 따로 넘기면 타입 정보가 흩어짐 — 제네릭
// 함수로 감싸는 이유가 런타임 동작이 아니라 순수하게 타입 추론을 보존하기 위함이라는 점이 포인트).
function defineHttpRequestContract<
  Params extends z.ZodTypeAny,
  Query extends z.ZodTypeAny,
  Body extends z.ZodTypeAny
>(params: Params, query: Query, body: Body) {
  return { params, query, body } as const;
}

const emptyHttpRequestContract = defineHttpRequestContract(
  emptyParamsSchema,
  emptyParamsSchema,
  emptyParamsSchema
);
const idHttpRequestContract = defineHttpRequestContract(
  idParamsSchema,
  emptyParamsSchema,
  emptyParamsSchema
);

// [INTV:ARCH] 라우트 이름 → (params, query, body) 검증 계약의 매핑. API 서버와 이 매핑을 공유해서
// "이 엔드포인트는 어떤 입력을 받는가"를 한 곳(이 객체)에서만 정의하고, 서버의 런타임 검증과
// 클라이언트의 타입 추론이 모두 같은 정의를 참조하게 만든 아키텍처 — 엔드포인트 추가 시 여기 한
// 줄만 늘리면 된다(app.ts의 모든 라우트가 이 객체의 항목 하나를 parseHttpRequest에 넘기는 것으로
// 시작한다).
export const jsonHttpRequestContracts = {
  health: emptyHttpRequestContract,
  healthLive: emptyHttpRequestContract,
  healthReady: emptyHttpRequestContract,
  devLogin: defineHttpRequestContract(emptyParamsSchema, emptyParamsSchema, devLoginBodySchema),
  guestLogin: emptyHttpRequestContract,
  logout: emptyHttpRequestContract,
  wsTicket: emptyHttpRequestContract,
  me: emptyHttpRequestContract,
  authMe: emptyHttpRequestContract,
  userById: idHttpRequestContract,
  lobby: emptyHttpRequestContract,
  lobbyChat: defineHttpRequestContract(emptyParamsSchema, emptyParamsSchema, chatBodySchema),
  leaderboard: emptyHttpRequestContract,
  dashboard: emptyHttpRequestContract,
  profileByHandle: defineHttpRequestContract(
    handleParamsSchema,
    emptyParamsSchema,
    emptyParamsSchema
  ),
  ownProfile: emptyHttpRequestContract,
  updateOwnProfile: defineHttpRequestContract(
    emptyParamsSchema,
    emptyParamsSchema,
    profileUpdateBodySchema
  ),
  friends: emptyHttpRequestContract,
  requestFriend: defineHttpRequestContract(
    emptyParamsSchema,
    emptyParamsSchema,
    friendRequestBodySchema
  ),
  acceptFriend: idHttpRequestContract,
  tournaments: emptyHttpRequestContract,
  createTournament: defineHttpRequestContract(
    emptyParamsSchema,
    emptyParamsSchema,
    tournamentCreateBodySchema
  ),
  joinTournament: idHttpRequestContract,
  adminUsers: emptyHttpRequestContract,
  adminActions: emptyHttpRequestContract,
  adminBan: defineHttpRequestContract(idParamsSchema, emptyParamsSchema, adminBanBodySchema),
  adminStatus: defineHttpRequestContract(idParamsSchema, emptyParamsSchema, adminStatusBodySchema)
} as const;

// [INTV:ARCH] WS 접속은 HTTP 핸드셰이크 시 Authorization 헤더를 자유롭게 실어보내기 까다로워서
// (브라우저 WebSocket API가 커스텀 헤더 설정을 지원하지 않음), 대신 이 짧은 수명(30초, wsTicket.ts의
// WS_TICKET_TTL_SECONDS)의 "티켓" 문자열을 쿼리스트링(?ticket=...)으로 전달하는 방식을 쓴다 —
// 별도의 REST 엔드포인트(wsTicket)로 미리 발급받은 뒤 WS 연결 시 제시하는 흐름. 티켓이 수명 없이
// 재사용 가능했다면 URL/로그에 노출되는 값이 영구 자격증명이 되어버려 위험하므로, 반드시 짧고
// 1회용(consumeWsTicket)이어야 한다. v는 프로토콜 버전 고정값.
export const wsTicketSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const wsHandshakeQuerySchema = z.object({
  ticket: wsTicketSchema,
  v: z.literal("1")
}).strict();

export const okResponseSchema = z.object({ ok: z.literal(true) });
export const healthResponseSchema = z.object({ ok: z.literal(true), service: z.literal("pong-pong-api") });
// [INTV:ARCH] liveness(살아있는지)와 readiness(트래픽을 받을 준비가 됐는지)를 분리한 헬스체크
// 응답 — 컨테이너 오케스트레이터(K8s 등)가 "재시작해야 하는 상태"와 "잠시 트래픽만 빼야 하는 상태"를
// 구분해 판단할 수 있게 한다(app.ts의 /health/ready 핸들러가 draining 상태를 여기 반영).
export const liveHealthResponseSchema = z.object({
  status: z.literal("ok"),
  service: z.literal("pong-pong-api")
});
export const readyHealthResponseSchema = z.object({
  status: z.enum(["ready", "not_ready"]),
  service: z.literal("pong-pong-api"),
  checks: z.object({
    // lifecycle: 서버가 새 요청을 받는 중인지, 종료를 앞두고 기존 연결만 마무리하는 중(draining)인지.
    lifecycle: z.enum(["accepting", "draining"]),
    database: z.enum(["up", "down"]),
    // migrations: DB 스키마 마이그레이션이 최신인지, 아직 적용 안 된 게 있는지(pending), 배포 버전과 어긋났는지(diverged) 등.
    migrations: z.enum(["current", "pending", "diverged", "not_applicable", "unknown"])
  }).strict()
}).strict();
export const userResponseSchema = z.object({ user: sessionUserSchema });
export const guestAuthResponseSchema = z.object({
  user: sessionUserSchema,
  guest: z.literal(true),
  expiresInSeconds: z.literal(7_200)
});
export const publicUserResponseSchema = z.object({ user: publicUserSchema });
export const profileResponseSchema = z.object({ user: publicUserSchema, recentMatches: z.array(matchSummarySchema) });
export const ownProfileResponseSchema = z.object({ profile: sessionUserSchema });
export const friendsResponseSchema = z.object({ friends: z.array(friendSummarySchema) });
export const friendResponseSchema = z.object({ friend: friendSummarySchema });
export const chatResponseSchema = z.object({ message: chatMessageSchema });
export const leaderboardResponseSchema = z.object({ entries: z.array(leaderboardEntrySchema) });
export const tournamentsResponseSchema = z.object({ tournaments: z.array(tournamentSummarySchema) });
export const tournamentResponseSchema = z.object({ tournament: tournamentSummarySchema });
export const adminUsersResponseSchema = z.object({ users: z.array(publicUserSchema) });
export const adminActionsResponseSchema = z.object({ actions: z.array(adminActionSummarySchema) });
export const wsTicketResponseSchema = z.object({
  ticket: wsTicketSchema,
  expiresInSeconds: z.literal(30),
  protocolVersion: z.literal(1)
});

export type DevLoginBody = z.infer<typeof devLoginBodySchema>;
export type ProfileUpdateBody = z.infer<typeof profileUpdateBodySchema>;
export type WsTicketResponse = z.infer<typeof wsTicketResponseSchema>;
export type GuestAuthResponse = z.infer<typeof guestAuthResponseSchema>;

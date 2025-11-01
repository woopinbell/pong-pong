import { z } from "zod";

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

export const wsTicketSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const wsHandshakeQuerySchema = z.object({
  ticket: wsTicketSchema,
  v: z.literal("1")
}).strict();

export const okResponseSchema = z.object({ ok: z.literal(true) });
export const healthResponseSchema = z.object({ ok: z.literal(true), service: z.literal("pong-pong-api") });
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

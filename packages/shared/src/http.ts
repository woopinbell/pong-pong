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

export interface FriendSummary {
  id: string;
  user: PublicUser;
  status: FriendshipStatus;
}

export interface ChatMessage {
  id: string;
  scope: "lobby" | "match";
  roomId: string | null;
  sender: PublicUser;
  body: string;
  createdAt: string;
}

export interface LobbyStats {
  onlinePlayers: number;
  playingPlayers: number;
  queuedPlayers: number;
  activeRooms: number;
  averageWaitSeconds: number | null;
}

export interface LobbyResponse {
  me: SessionUser | null;
  onlinePlayers: PublicUser[];
  recentMatches: MatchSummary[];
  chat: ChatMessage[];
  stats: LobbyStats;
}

export interface TournamentSummary {
  id: string;
  name: string;
  status: TournamentStatus;
  createdBy: PublicUser;
  playerCount: number;
  capacity: number;
  winner: PublicUser | null;
  entries: PublicUser[];
  matches: TournamentMatchSummary[];
}

export interface TournamentMatchSummary {
  id: string;
  tournamentId: string;
  round: "semifinal" | "final";
  slot: number;
  status: "pending" | "ready" | "running" | "finished";
  left: PublicUser | null;
  right: PublicUser | null;
  winner: PublicUser | null;
  scoreLeft: number | null;
  scoreRight: number | null;
  roomId: string | null;
  matchId: string | null;
}

export interface AdminActionSummary {
  id: string;
  actor: PublicUser | null;
  target: PublicUser | null;
  action: "ban" | "unban";
  reason: string;
  createdAt: string;
}

export type UserRole = "user" | "admin";
export type UserStatus = "active" | "banned";
export type FriendshipStatus = "pending" | "accepted";
export type TournamentStatus = "open" | "running" | "finished";
export type MatchMode = "queue" | "ai" | "tournament";

export interface PublicUser {
  id: string;
  handle: string;
  displayName: string;
  avatarKey: string;
  role: UserRole;
  status: UserStatus;
  rating: number;
  wins: number;
  losses: number;
  online: boolean;
}

export interface SessionUser extends PublicUser {
  email: string | null;
}

export interface MatchSummary {
  id: string;
  mode: MatchMode;
  opponentHandle: string;
  result: "win" | "loss";
  scoreLeft: number;
  scoreRight: number;
  ratingDelta: number;
  endedAt: string;
}

export interface DashboardSummary {
  me: SessionUser;
  recentMatches: MatchSummary[];
  winRate: number;
  bestStreak: number;
}

export interface LeaderboardEntry {
  rank: number;
  user: PublicUser;
  winRate: number;
}

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

export interface TournamentSummary {
  id: string;
  name: string;
  status: TournamentStatus;
  createdBy: PublicUser;
  playerCount: number;
  capacity: number;
  winner: PublicUser | null;
  entries: PublicUser[];
}

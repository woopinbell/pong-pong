import type {
  FriendshipStatus,
  MatchMode,
  TournamentStatus,
  UserRole,
  UserStatus
} from "@pong-pong/shared";
import type { Generated, Selectable } from "kysely";

export type TournamentRound = "semifinal" | "final";
export type TournamentMatchStatus = "pending" | "ready" | "running" | "finished";
export type ChatScope = "lobby" | "match";
export type AdminAction = "ban" | "unban";

export interface UserTable {
  id: Generated<string>;
  email: string | null;
  handle: string;
  display_name: string;
  avatar_key: Generated<string>;
  role: Generated<UserRole>;
  status: Generated<UserStatus>;
  rating: Generated<number>;
  wins: Generated<number>;
  losses: Generated<number>;
  is_npc: Generated<boolean>;
  created_at: Generated<Date>;
  banned_at: Date | null;
}

export interface SessionTable {
  token: string;
  user_id: string;
  expires_at: Date;
  created_at: Generated<Date>;
}

export interface FriendshipTable {
  id: Generated<string>;
  requester_id: string;
  addressee_id: string;
  status: FriendshipStatus;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface MatchTable {
  id: Generated<string>;
  result_key: string;
  mode: MatchMode;
  winner_id: string | null;
  loser_id: string | null;
  score_left: number;
  score_right: number;
  rating_delta: Generated<number>;
  started_at: Generated<Date>;
  ended_at: Generated<Date>;
}

export interface ChatMessageTable {
  id: Generated<string>;
  scope: ChatScope;
  room_id: string | null;
  sender_id: string;
  body: string;
  created_at: Generated<Date>;
}

export interface TournamentTable {
  id: Generated<string>;
  name: string;
  status: Generated<TournamentStatus>;
  created_by: string;
  winner_id: string | null;
  capacity: Generated<number>;
  created_at: Generated<Date>;
}

export interface TournamentEntryTable {
  id: Generated<string>;
  tournament_id: string;
  user_id: string;
  seed: number;
  created_at: Generated<Date>;
}

export interface TournamentMatchTable {
  id: Generated<string>;
  tournament_id: string;
  round: TournamentRound;
  slot: number;
  status: Generated<TournamentMatchStatus>;
  left_user_id: string | null;
  right_user_id: string | null;
  winner_id: string | null;
  room_id: string | null;
  match_id: string | null;
  score_left: number | null;
  score_right: number | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface AdminActionTable {
  id: Generated<string>;
  actor_id: string | null;
  target_user_id: string | null;
  action: AdminAction;
  reason: string;
  created_at: Generated<Date>;
}

export interface WsTicketTable {
  ticket_hash: string;
  user_id: string;
  expires_at: Date;
  created_at: Generated<Date>;
}

export interface RatingHistoryTable {
  id: Generated<string>;
  match_id: string;
  user_id: string;
  rating_before: number;
  rating_after: number;
  delta: number;
  created_at: Generated<Date>;
}

export interface Database {
  users: UserTable;
  sessions: SessionTable;
  friendships: FriendshipTable;
  matches: MatchTable;
  chat_messages: ChatMessageTable;
  tournaments: TournamentTable;
  tournament_entries: TournamentEntryTable;
  tournament_matches: TournamentMatchTable;
  admin_actions: AdminActionTable;
  ws_tickets: WsTicketTable;
  rating_history: RatingHistoryTable;
}

export type UserRow = Selectable<UserTable>;
export type UserProjectionRow = Pick<
  UserRow,
  | "id"
  | "email"
  | "handle"
  | "display_name"
  | "avatar_key"
  | "role"
  | "status"
  | "rating"
  | "wins"
  | "losses"
  | "is_npc"
>;
export type MatchRow = Selectable<MatchTable>;
export type ChatMessageRow = Selectable<ChatMessageTable>;
export type TournamentRow = Selectable<TournamentTable>;
export type TournamentMatchRow = Selectable<TournamentMatchTable>;
export type AdminActionRow = Selectable<AdminActionTable>;

export interface MatchWithHandlesRow extends MatchRow {
  winner_handle: string | null;
  loser_handle: string | null;
}

export interface FriendshipWithUserRow extends UserRow {
  friendship_id: string;
  friendship_status: FriendshipStatus;
}

export interface ChatMessageWithSenderRow extends ChatMessageRow {
  user_id: string;
  email: string | null;
  handle: string;
  display_name: string;
  avatar_key: string;
  role: UserRole;
  status: UserStatus;
  rating: number;
  wins: number;
  losses: number;
  is_npc: boolean;
}

export interface TournamentWithCreatorRow extends TournamentRow {
  creator_id: string;
  email: string | null;
  handle: string;
  display_name: string;
  avatar_key: string;
  role: UserRole;
  user_status: UserStatus;
  rating: number;
  wins: number;
  losses: number;
  is_npc: boolean;
}

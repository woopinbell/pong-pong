import type { Generated, Selectable } from "kysely";
import type { UserRole, UserStatus } from "@pong-pong/shared";

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
  created_at: Generated<Date>;
  banned_at: Date | null;
}

export interface SessionTable {
  token: string;
  user_id: string;
  expires_at: Date;
  created_at: Generated<Date>;
}

export interface MatchTable {
  id: Generated<string>;
  mode: import("@pong-pong/shared").MatchMode;
  winner_id: string | null;
  loser_id: string | null;
  score_left: number;
  score_right: number;
  rating_delta: Generated<number>;
  started_at: Generated<Date>;
  ended_at: Generated<Date>;
}

export interface FriendshipTable {
  id: Generated<string>;
  requester_id: string;
  addressee_id: string;
  status: import("@pong-pong/shared").FriendshipStatus;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface Database {
  users: UserTable;
  sessions: SessionTable;
  matches: MatchTable;
  friendships: FriendshipTable;
}

export type UserRow = Selectable<UserTable>;
export type MemoryUserRow = Omit<UserRow, "created_at" | "banned_at">;
export type MatchRow = Selectable<MatchTable>;

export interface MatchWithHandlesRow extends MatchRow {
  winner_handle: string | null;
  loser_handle: string | null;
}

export interface FriendshipWithUserRow extends UserRow {
  friendship_id: string;
  friendship_status: import("@pong-pong/shared").FriendshipStatus;
}
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
>;

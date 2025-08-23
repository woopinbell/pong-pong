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

export interface Database {
  users: UserTable;
  sessions: SessionTable;
}

export type UserRow = Selectable<UserTable>;
export type MemoryUserRow = Omit<UserRow, "created_at" | "banned_at">;
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

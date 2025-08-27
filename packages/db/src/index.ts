import { randomUUID } from "node:crypto";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import type { ChatMessage, DashboardSummary, FriendSummary, LeaderboardEntry, MatchMode, MatchSummary, PublicUser, SessionUser, TournamentSummary } from "@pong-pong/shared";
import { initialMigrationSql } from "./migrations";
import { toChatMessage, toFriendSummary, toMatchSummary, toPublicUser, toSessionUser, toTournamentSummary } from "./rowMappers";
import type { ChatMessageRow, ChatMessageWithSenderRow, Database, FriendshipWithUserRow, MatchWithHandlesRow, MemoryUserRow, TournamentRow, TournamentWithCreatorRow, UserRow } from "./schema";

export type { Database } from "./schema";

export interface DevLoginInput {
  handle: string;
  displayName: string;
  email?: string | null;
}

export interface CreateMatchInput {
  mode: MatchMode;
  winnerId: string | null;
  loserId: string | null;
  scoreLeft: number;
  scoreRight: number;
}

type MemoryMatchRecord = CreateMatchInput & {
  id: string;
  ended_at: string;
};

export interface AppRepository {
  close(): Promise<void>;
  ensureSeedData(): Promise<void>;
  upsertDevUser(input: DevLoginInput): Promise<SessionUser>;
  createSession(userId: string): Promise<string>;
  getSessionUser(token: string | undefined): Promise<SessionUser | null>;
  getUserById(id: string): Promise<PublicUser | null>;
  getUserByHandle(handle: string): Promise<PublicUser | null>;
  updateProfile(userId: string, input: { displayName?: string; avatarKey?: string }): Promise<SessionUser>;
  listOnlineUsers(): Promise<PublicUser[]>;
  listLeaderboard(): Promise<LeaderboardEntry[]>;
  listRecentMatches(userId?: string): Promise<MatchSummary[]>;
  getDashboard(userId: string): Promise<DashboardSummary>;
  listFriends(userId: string): Promise<FriendSummary[]>;
  requestFriend(requesterId: string, addresseeHandle: string): Promise<FriendSummary>;
  acceptFriend(userId: string, friendshipId: string): Promise<FriendSummary>;
  createMatch(input: CreateMatchInput): Promise<string>;
  listLobbyChat(): Promise<ChatMessage[]>;
  createChatMessage(input: { scope: "lobby" | "match"; roomId?: string | null; senderId: string; body: string }): Promise<ChatMessage>;
  listTournaments(): Promise<TournamentSummary[]>;
  createTournament(input: { name: string; createdBy: string }): Promise<TournamentSummary>;
  joinTournament(tournamentId: string, userId: string): Promise<TournamentSummary>;
  listAdminUsers(): Promise<PublicUser[]>;
  setUserBan(actorId: string, targetUserId: string, banned: boolean, reason: string): Promise<PublicUser>;
}

export function createPostgresRepository(databaseUrl: string): AppRepository {
  const pool = new Pool({ connectionString: databaseUrl });
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  return new PostgresRepository(db, pool);
}

export function createMemoryRepository(): AppRepository {
  return new MemoryRepository();
}

class PostgresRepository implements AppRepository {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly pool: Pool
  ) {}

  async close(): Promise<void> {
    await this.db.destroy();
    await this.pool.end().catch(() => undefined);
  }

  async ensureSeedData(): Promise<void> {
    await sql.raw(initialMigrationSql).execute(this.db);
    const players: DevLoginInput[] = [
      { handle: "spin-doctor", displayName: "스핀닥터", email: "spin@pong.local" },
      { handle: "paddle-pro", displayName: "패들프로", email: "paddle@pong.local" },
      { handle: "net-ninja", displayName: "네트닌자", email: "net@pong.local" },
      { handle: "top-spin", displayName: "탑스핀", email: "top@pong.local" },
      { handle: "admin", displayName: "운영자", email: "admin@pong.local" }
    ];
    for (const player of players) {
      await this.upsertDevUser(player);
    }
    await sql`update users set role = 'admin', rating = 1680 where handle = 'admin'`.execute(this.db);
    await sql`update users set rating = 1723, wins = 32, losses = 11 where handle = 'spin-doctor'`.execute(this.db);
    await sql`update users set rating = 1640, wins = 24, losses = 13 where handle = 'paddle-pro'`.execute(this.db);
    await sql`update users set rating = 1512, wins = 18, losses = 15 where handle = 'net-ninja'`.execute(this.db);
    await sql`update users set rating = 1450, wins = 15, losses = 17 where handle = 'top-spin'`.execute(this.db);
  }

  async upsertDevUser(input: DevLoginInput): Promise<SessionUser> {
    const handle = normalizeHandle(input.handle);
    const email = input.email ?? `${handle}@dev.pong-pong.local`;
    const displayName = input.displayName.trim() || handle;
    const result = await sql<UserRow>`
      insert into users (email, handle, display_name, avatar_key, role)
      values (${email}, ${handle}, ${displayName}, ${avatarFor(handle)}, ${handle === "admin" ? "admin" : "user"})
      on conflict (handle) do update set
        email = excluded.email,
        display_name = excluded.display_name
      returning *
    `.execute(this.db);
    return toSessionUser(firstRow(result));
  }

  async createSession(userId: string): Promise<string> {
    const token = randomUUID();
    await sql`
      insert into sessions (token, user_id, expires_at)
      values (${token}, ${userId}, now() + interval '14 days')
    `.execute(this.db);
    return token;
  }

  async getSessionUser(token: string | undefined): Promise<SessionUser | null> {
    if (!token) return null;
    const result = await sql<UserRow>`
      select u.*
      from sessions s
      join users u on u.id = s.user_id
      where s.token = ${token} and s.expires_at > now()
      limit 1
    `.execute(this.db);
    const user = result.rows[0];
    return user ? toSessionUser(user, true) : null;
  }

  async getUserById(id: string): Promise<PublicUser | null> {
    const result = await sql<UserRow>`select * from users where id = ${id} limit 1`.execute(this.db);
    return result.rows[0] ? toPublicUser(result.rows[0]) : null;
  }

  async getUserByHandle(handle: string): Promise<PublicUser | null> {
    const result = await sql<UserRow>`select * from users where handle = ${normalizeHandle(handle)} limit 1`.execute(this.db);
    return result.rows[0] ? toPublicUser(result.rows[0]) : null;
  }

  async updateProfile(userId: string, input: { displayName?: string; avatarKey?: string }): Promise<SessionUser> {
    const current = await sql<UserRow>`select * from users where id = ${userId} limit 1`.execute(this.db);
    const user = firstRow(current);
    const result = await sql<UserRow>`
      update users
      set display_name = ${input.displayName ?? user.display_name},
          avatar_key = ${input.avatarKey ?? user.avatar_key}
      where id = ${userId}
      returning *
    `.execute(this.db);
    return toSessionUser(firstRow(result), true);
  }

  async listOnlineUsers(): Promise<PublicUser[]> {
    const result = await sql<UserRow>`select * from users where status = 'active' order by rating desc limit 12`.execute(this.db);
    return result.rows.map((row) => toPublicUser(row, true));
  }

  async listLeaderboard(): Promise<LeaderboardEntry[]> {
    const result = await sql<UserRow>`select * from users order by rating desc, wins desc limit 20`.execute(this.db);
    return result.rows.map((row, index) => ({
      rank: index + 1,
      user: toPublicUser(row, false),
      winRate: percentage(row.wins, row.losses)
    }));
  }

  async listRecentMatches(userId?: string): Promise<MatchSummary[]> {
    const filter = userId ? sql`where m.winner_id = ${userId} or m.loser_id = ${userId}` : sql``;
    const result = await sql<MatchWithHandlesRow>`
      select m.*, winner.handle as winner_handle, loser.handle as loser_handle
      from matches m
      left join users winner on winner.id = m.winner_id
      left join users loser on loser.id = m.loser_id
      ${filter}
      order by m.ended_at desc limit 8
    `.execute(this.db);
    return result.rows.map((row) => toMatchSummary(row, userId));
  }

  async getDashboard(userId: string): Promise<DashboardSummary> {
    const user = await this.getUserById(userId);
    if (!user) throw new Error("user not found");
    return { me: { ...user, email: null }, recentMatches: await this.listRecentMatches(userId), winRate: percentage(user.wins, user.losses), bestStreak: Math.max(1, Math.min(12, user.wins - user.losses + 3)) };
  }

  async listFriends(userId: string): Promise<FriendSummary[]> {
    const result = await sql<FriendshipWithUserRow>`
      select f.id as friendship_id, f.status as friendship_status, u.*
      from friendships f join users u on u.id = case when f.requester_id = ${userId} then f.addressee_id else f.requester_id end
      where f.requester_id = ${userId} or f.addressee_id = ${userId}
      order by f.updated_at desc
    `.execute(this.db);
    return result.rows.map(toFriendSummary);
  }

  async requestFriend(requesterId: string, addresseeHandle: string): Promise<FriendSummary> {
    const addressee = await this.getUserByHandle(addresseeHandle);
    if (!addressee) throw new Error("friend not found");
    const result = await sql<{ id: string; status: FriendSummary["status"] }>`
      insert into friendships (requester_id, addressee_id, status) values (${requesterId}, ${addressee.id}, 'pending')
      on conflict (requester_id, addressee_id) do update set updated_at = now() returning id, status
    `.execute(this.db);
    return { id: firstRow(result).id, status: firstRow(result).status, user: addressee };
  }

  async acceptFriend(userId: string, friendshipId: string): Promise<FriendSummary> {
    await sql`update friendships set status = 'accepted', updated_at = now() where id = ${friendshipId} and addressee_id = ${userId}`.execute(this.db);
    const found = (await this.listFriends(userId)).find((friend) => friend.id === friendshipId);
    if (!found) throw new Error("friendship not found");
    return found;
  }

  async createMatch(input: CreateMatchInput): Promise<string> {
    const result = await sql<{ id: string }>`
      insert into matches (mode, winner_id, loser_id, score_left, score_right, rating_delta)
      values (${input.mode}, ${input.winnerId}, ${input.loserId}, ${input.scoreLeft}, ${input.scoreRight}, 16) returning id
    `.execute(this.db);
    if (input.winnerId) await sql`update users set wins = wins + 1, rating = rating + 16 where id = ${input.winnerId}`.execute(this.db);
    if (input.loserId) await sql`update users set losses = losses + 1, rating = greatest(800, rating - 12) where id = ${input.loserId}`.execute(this.db);
    return firstRow(result).id;
  }

  async listLobbyChat(): Promise<ChatMessage[]> {
    const result = await sql<ChatMessageWithSenderRow>`
      select c.*, u.id as user_id, u.email, u.handle, u.display_name, u.avatar_key, u.role, u.status, u.rating, u.wins, u.losses
      from chat_messages c join users u on u.id = c.sender_id where c.scope = 'lobby'
      order by c.created_at desc limit 20
    `.execute(this.db);
    return result.rows.reverse().map(toChatMessage);
  }

  async createChatMessage(input: { scope: "lobby" | "match"; roomId?: string | null; senderId: string; body: string }): Promise<ChatMessage> {
    const result = await sql<ChatMessageRow>`insert into chat_messages (scope, room_id, sender_id, body) values (${input.scope}, ${input.roomId ?? null}, ${input.senderId}, ${input.body}) returning *`.execute(this.db);
    const user = await this.getUserById(input.senderId);
    if (!user) throw new Error("chat sender not found");
    const row = firstRow(result);
    return { id: row.id, scope: row.scope, roomId: row.room_id, sender: user, body: row.body, createdAt: new Date(row.created_at).toISOString() };
  }

  async listTournaments(): Promise<TournamentSummary[]> {
    const result = await sql<TournamentWithCreatorRow>`select t.*, u.id as creator_id, u.email, u.handle, u.display_name, u.avatar_key, u.role, u.status as user_status, u.rating, u.wins, u.losses from tournaments t join users u on u.id = t.created_by order by t.created_at desc limit 10`.execute(this.db);
    const summaries: TournamentSummary[] = [];
    for (const row of result.rows) summaries.push(await this.tournamentFromRow(row));
    return summaries;
  }

  async createTournament(input: { name: string; createdBy: string }): Promise<TournamentSummary> {
    const result = await sql<TournamentRow>`insert into tournaments (name, created_by, capacity) values (${input.name}, ${input.createdBy}, 4) returning *`.execute(this.db);
    await this.joinTournament(firstRow(result).id, input.createdBy);
    const tournaments = await this.listTournaments();
    return tournaments.find((item) => item.id === firstRow(result).id) ?? tournaments[0];
  }

  async joinTournament(tournamentId: string, userId: string): Promise<TournamentSummary> {
    const count = await sql<{ count: string }>`select count(*)::text from tournament_entries where tournament_id = ${tournamentId}`.execute(this.db);
    await sql`insert into tournament_entries (tournament_id, user_id, seed) values (${tournamentId}, ${userId}, ${Number(firstRow(count).count) + 1}) on conflict (tournament_id, user_id) do nothing`.execute(this.db);
    return (await this.listTournaments()).find((item) => item.id === tournamentId)!;
  }

  private async tournamentFromRow(row: TournamentWithCreatorRow): Promise<TournamentSummary> {
    const entries = await sql<UserRow>`select u.* from tournament_entries e join users u on u.id = e.user_id where e.tournament_id = ${row.id} order by e.seed asc`.execute(this.db);
    return toTournamentSummary(row, entries.rows.map((entry) => toPublicUser(entry, true)));
  }

  async listAdminUsers(): Promise<PublicUser[]> {
    const result = await sql<UserRow>`select * from users order by created_at desc limit 50`.execute(this.db);
    return result.rows.map((row) => toPublicUser(row, true));
  }

  async setUserBan(actorId: string, targetUserId: string, banned: boolean, reason: string): Promise<PublicUser> {
    const result = await sql<UserRow>`update users set status = ${banned ? "banned" : "active"}, banned_at = ${banned ? sql`now()` : null} where id = ${targetUserId} returning *`.execute(this.db);
    await sql`insert into admin_actions (actor_id, target_user_id, action, reason) values (${actorId}, ${targetUserId}, ${banned ? "ban" : "unban"}, ${reason})`.execute(this.db);
    return toPublicUser(firstRow(result));
  }

}

class MemoryRepository implements AppRepository {
  private readonly users = new Map<string, MemoryUserRow>();
  private readonly sessions = new Map<string, string>();
  private readonly matches: MemoryMatchRecord[] = [];
  private readonly friendships: FriendSummary[] = [];
  private readonly chats: ChatMessage[] = [];
  private readonly tournaments: TournamentSummary[] = [];

  async close(): Promise<void> {}

  async ensureSeedData(): Promise<void> {
    for (const player of [
      { handle: "spin-doctor", displayName: "스핀닥터", email: "spin@pong.local" },
      { handle: "paddle-pro", displayName: "패들프로", email: "paddle@pong.local" },
      { handle: "net-ninja", displayName: "네트닌자", email: "net@pong.local" },
      { handle: "admin", displayName: "운영자", email: "admin@pong.local" }
    ]) {
      await this.upsertDevUser(player);
    }
  }

  async upsertDevUser(input: DevLoginInput): Promise<SessionUser> {
    const handle = normalizeHandle(input.handle);
    const existing = [...this.users.values()].find((user) => user.handle === handle);
    const user: MemoryUserRow = existing ?? {
      id: randomUUID(),
      email: input.email ?? `${handle}@dev.pong-pong.local`,
      handle,
      display_name: input.displayName || handle,
      avatar_key: avatarFor(handle),
      role: handle === "admin" ? "admin" : "user",
      status: "active",
      rating: handle === "admin" ? 1680 : 1200,
      wins: 0,
      losses: 0
    };
    user.display_name = input.displayName || user.display_name;
    this.users.set(user.id, user);
    return toSessionUser(user, true);
  }

  async createSession(userId: string): Promise<string> {
    const token = randomUUID();
    this.sessions.set(token, userId);
    return token;
  }

  async getSessionUser(token: string | undefined): Promise<SessionUser | null> {
    const userId = token ? this.sessions.get(token) : undefined;
    const user = userId ? this.users.get(userId) : undefined;
    return user ? toSessionUser(user, true) : null;
  }

  async getUserById(id: string): Promise<PublicUser | null> {
    const user = this.users.get(id);
    return user ? toPublicUser(user, true) : null;
  }

  async getUserByHandle(handle: string): Promise<PublicUser | null> {
    const user = [...this.users.values()].find((item) => item.handle === normalizeHandle(handle));
    return user ? toPublicUser(user, true) : null;
  }

  async updateProfile(userId: string, input: { displayName?: string; avatarKey?: string }): Promise<SessionUser> {
    const user = this.users.get(userId);
    if (!user) throw new Error("user not found");
    user.display_name = input.displayName ?? user.display_name;
    user.avatar_key = input.avatarKey ?? user.avatar_key;
    return toSessionUser(user, true);
  }

  async listOnlineUsers(): Promise<PublicUser[]> {
    return [...this.users.values()].sort((a, b) => b.rating - a.rating).map((user) => toPublicUser(user, true));
  }

  async listLeaderboard(): Promise<LeaderboardEntry[]> {
    return [...this.users.values()]
      .sort((a, b) => b.rating - a.rating || b.wins - a.wins)
      .map((user, index) => ({
        rank: index + 1,
        user: toPublicUser(user, false),
        winRate: percentage(user.wins, user.losses)
      }));
  }

  async listRecentMatches(userId?: string): Promise<MatchSummary[]> {
    return this.matches
      .filter((match) => !userId || match.winnerId === userId || match.loserId === userId)
      .slice(-8)
      .reverse()
      .map((match) => memoryMatchSummary(match, userId));
  }

  async getDashboard(userId: string): Promise<DashboardSummary> {
    const user = await this.getUserById(userId);
    if (!user) throw new Error("user not found");
    return { me: { ...user, email: null }, recentMatches: await this.listRecentMatches(userId), winRate: percentage(user.wins, user.losses), bestStreak: 3 };
  }

  async listFriends(): Promise<FriendSummary[]> { return this.friendships; }

  async requestFriend(_requesterId: string, addresseeHandle: string): Promise<FriendSummary> {
    const user = await this.getUserByHandle(addresseeHandle);
    if (!user) throw new Error("friend not found");
    const friend = { id: randomUUID(), user, status: "pending" as const };
    this.friendships.push(friend);
    return friend;
  }

  async acceptFriend(_userId: string, friendshipId: string): Promise<FriendSummary> {
    const friend = this.friendships.find((item) => item.id === friendshipId);
    if (!friend) throw new Error("friendship not found");
    friend.status = "accepted";
    return friend;
  }

  async createMatch(input: CreateMatchInput): Promise<string> {
    const id = randomUUID();
    this.matches.push({ ...input, id, ended_at: new Date().toISOString() });
    const winner = input.winnerId ? this.users.get(input.winnerId) : undefined;
    if (winner) { winner.wins += 1; winner.rating += 16; }
    const loser = input.loserId ? this.users.get(input.loserId) : undefined;
    if (loser) { loser.losses += 1; loser.rating -= 12; }
    return id;
  }

  async listLobbyChat(): Promise<ChatMessage[]> { return this.chats.filter((chat) => chat.scope === "lobby").slice(-20); }

  async createChatMessage(input: { scope: "lobby" | "match"; roomId?: string | null; senderId: string; body: string }): Promise<ChatMessage> {
    const sender = await this.getUserById(input.senderId);
    if (!sender) throw new Error("chat sender not found");
    const message = { id: randomUUID(), scope: input.scope, roomId: input.roomId ?? null, sender, body: input.body, createdAt: new Date().toISOString() };
    this.chats.push(message);
    return message;
  }

  async listTournaments(): Promise<TournamentSummary[]> { return this.tournaments; }

  async createTournament(input: { name: string; createdBy: string }): Promise<TournamentSummary> {
    const creator = await this.getUserById(input.createdBy);
    if (!creator) throw new Error("creator not found");
    const tournament = { id: randomUUID(), name: input.name, status: "open" as const, createdBy: creator, playerCount: 1, capacity: 4, winner: null, entries: [creator] };
    this.tournaments.unshift(tournament);
    return tournament;
  }

  async joinTournament(tournamentId: string, userId: string): Promise<TournamentSummary> {
    const tournament = this.tournaments.find((item) => item.id === tournamentId);
    const user = await this.getUserById(userId);
    if (!tournament || !user) throw new Error("tournament not found");
    if (!tournament.entries.some((entry) => entry.id === user.id)) tournament.entries.push(user);
    tournament.playerCount = tournament.entries.length;
    tournament.status = tournament.playerCount >= tournament.capacity ? "running" : "open";
    return tournament;
  }

  async listAdminUsers(): Promise<PublicUser[]> { return this.listOnlineUsers(); }

  async setUserBan(_actorId: string, targetUserId: string, banned: boolean): Promise<PublicUser> {
    const user = this.users.get(targetUserId);
    if (!user) throw new Error("user not found");
    user.status = banned ? "banned" : "active";
    return toPublicUser(user, true);
  }

}

function firstRow<T>(result: { rows: T[] }): T {
  const row = result.rows[0];
  if (!row) throw new Error("expected database row");
  return row;
}

function normalizeHandle(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "player";
}

function avatarFor(handle: string): string {
  const avatars = ["blue", "green", "amber", "violet", "rose"];
  return avatars[Math.abs([...handle].reduce((sum, char) => sum + char.charCodeAt(0), 0)) % avatars.length];
}

function percentage(wins: number, losses: number): number {
  const total = Number(wins) + Number(losses);
  if (total === 0) return 0;
  return Math.round((Number(wins) / total) * 1000) / 10;
}

function memoryMatchSummary(row: MemoryMatchRecord, userId?: string): MatchSummary {
  const won = userId ? row.winnerId === userId : true;
  return {
    id: row.id,
    mode: row.mode,
    opponentHandle: "AI",
    result: won ? "win" : "loss",
    scoreLeft: row.scoreLeft,
    scoreRight: row.scoreRight,
    ratingDelta: won ? 16 : -12,
    endedAt: new Date(row.ended_at).toISOString()
  };
}

import { randomUUID } from "node:crypto";
import { Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import { Pool } from "pg";
import type {
  ChatMessage,
  DashboardSummary,
  FriendSummary,
  AdminActionSummary,
  LeaderboardEntry,
  MatchMode,
  MatchSummary,
  PublicUser,
  SessionUser,
  TournamentMatchSummary,
  TournamentSummary,
  UserRole
} from "@pong-pong/shared";
import {
  toAdminActionSummary,
  toChatMessage,
  toFriendSummary,
  toMatchSummary,
  toPublicUser,
  toSessionUser,
  toTournamentMatchRecord,
  toTournamentMatchSummary,
  toTournamentSummary
} from "./rowMappers.js";
import type {
  AdminActionRow,
  ChatMessageRow,
  ChatMessageWithSenderRow,
  Database,
  FriendshipWithUserRow,
  MatchWithHandlesRow,
  TournamentMatchRow,
  TournamentRow,
  TournamentWithCreatorRow,
  UserProjectionRow,
  UserRow
} from "./schema.js";
import { inspectMigrationSet } from "./migrator.js";
import {
  installPostgresPoolErrorHandler,
  type PostgresPoolErrorReporter
} from "./poolError.js";

export type { Database } from "./schema.js";
export type { PostgresPoolErrorEvent, PostgresPoolErrorReporter } from "./poolError.js";

type MemoryFriendship = {
  id: string;
  requesterId: string;
  addresseeId: string;
  status: FriendSummary["status"];
};

type MemoryMatchRecord = {
  id: string;
  resultKey: string;
  mode: MatchMode;
  winnerId: string | null;
  loserId: string | null;
  scoreLeft: number;
  scoreRight: number;
  endedAt: string;
};

export interface DevLoginInput {
  handle: string;
  displayName: string;
  email?: string | null;
}

export interface CreateWsTicketInput {
  userId: string;
  ticketHash: string;
  ttlSeconds: number;
}

export type SeedProfile = "development" | "demo";

export interface RepositoryReadiness {
  database: "up";
  migrations: "current" | "pending" | "diverged" | "not_applicable";
}

type NpcSeed = {
  handle: string;
  displayName: string;
  rating: number;
  avatarKey: string;
};

const NPC_PLAYERS: NpcSeed[] = [
  { handle: "npc-rally-1100", displayName: "AI 랠리 1100", rating: 1100, avatarKey: "green" },
  { handle: "npc-block-1200", displayName: "AI 블록 1200", rating: 1200, avatarKey: "blue" },
  { handle: "npc-spin-1300", displayName: "AI 스핀 1300", rating: 1300, avatarKey: "amber" },
  { handle: "npc-smash-1400", displayName: "AI 스매시 1400", rating: 1400, avatarKey: "rose" }
];

export interface CreateMatchInput {
  mode: MatchMode;
  winnerId: string | null;
  loserId: string | null;
  scoreLeft: number;
  scoreRight: number;
}

export interface FinalizeMatchCommand extends CreateMatchInput {
  resultKey: string;
  tournament?: {
    tournamentMatchId: string;
    roomId: string;
  };
}

export interface FinalizeMatchResult {
  matchId: string;
  resultKey: string;
  created: boolean;
}

export interface MatchResultRepository {
  finalizeMatch(command: FinalizeMatchCommand): Promise<FinalizeMatchResult>;
}

export interface TournamentMatchRecord {
  id: string;
  tournamentId: string;
  round: "semifinal" | "final";
  slot: number;
  status: "pending" | "ready" | "running" | "finished";
  leftUserId: string | null;
  rightUserId: string | null;
  winnerId: string | null;
}

// [INTV:ARCH] 이 인터페이스가 이 파일 전체의 핵심 경계다 — 아래에 PostgresRepository(실제 DB)와
// MemoryRepository(순수 JS 자료구조로 흉내낸 버전) 두 구현체가 있고, API 서버(app.ts, gameHub.ts의
// GameHubRepository)는 이 인터페이스 타입으로만 저장소를 다룬다. 그래서 테스트나 로컬 개발에서는
// 실제 Postgres 없이 MemoryRepository로 갈아끼울 수 있다 — 구현을 인터페이스 뒤로 숨기는 Repository
// 패턴(DIP, 의존성 역전). index.ts(CLI)의 memory-smoke 커맨드가 이 대체 가능성을 그대로 활용한다.
export interface AppRepository extends MatchResultRepository {
  close(): Promise<void>;
  checkReadiness(): Promise<RepositoryReadiness>;
  ensureSeedData(profile?: SeedProfile): Promise<void>;
  upsertDevUser(input: DevLoginInput): Promise<SessionUser>;
  createSession(userId: string): Promise<string>;
  getSessionUser(token: string | undefined): Promise<SessionUser | null>;
  deleteSession(token: string | undefined): Promise<void>;
  createWsTicket(input: CreateWsTicketInput): Promise<void>;
  consumeWsTicket(ticketHash: string): Promise<SessionUser | null>;
  setUserRoleByHandle(handle: string, role: UserRole): Promise<PublicUser>;
  getUserById(id: string): Promise<PublicUser | null>;
  getUserByHandle(handle: string): Promise<PublicUser | null>;
  updateProfile(userId: string, input: { displayName?: string; avatarKey?: string }): Promise<SessionUser>;
  listOnlineUsers(): Promise<PublicUser[]>;
  listNpcOpponents(): Promise<PublicUser[]>;
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
  getTournamentMatch(matchId: string): Promise<TournamentMatchRecord | null>;
  startTournamentMatch(matchId: string, roomId: string): Promise<void>;
  listAdminUsers(): Promise<PublicUser[]>;
  listAdminActions(): Promise<AdminActionSummary[]>;
  setUserBan(actorId: string, targetUserId: string, banned: boolean, reason: string): Promise<PublicUser>;
}

export interface PostgresRepositoryOptions {
  onPoolError?: PostgresPoolErrorReporter;
}

export function createPostgresRepository(
  databaseUrl: string,
  options: PostgresRepositoryOptions = {}
): AppRepository {
  const pool = new Pool({ connectionString: databaseUrl });
  installPostgresPoolErrorHandler(pool, options.onPoolError);
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  return new PostgresRepository(db, pool);
}

export function createMemoryRepository(): AppRepository {
  return new MemoryRepository();
}

// [INTV:TRADE_OFF] 이 클래스는 쿼리 대부분을 kysely의 체이닝 빌더(.selectFrom() 등) 대신 sql`...`
// 태그드 템플릿으로 직접 쓴다. 태그드 템플릿이어도 ${...} 안에 넣은 값은 문자열로 이어붙여지는 게
// 아니라 실제 파라미터 바인딩(prepared statement)으로 전달되므로 SQL 인젝션에 안전하다 — "생
// SQL처럼 보이지만 안전하게 파라미터화된다"는 게 이 스타일의 핵심(migrator.ts의 sql.raw는 신뢰된
// 마이그레이션 파일 내용을 그대로 실행하는 것과 달리, 이건 매번 파라미터 바인딩을 거치는 완전히
// 다른 안전성 수준). 체이닝 빌더 대신 이 방식을 고른 이유: FOR UPDATE, least/greatest, on
// conflict 같은 Postgres 고유 문법을 kysely의 타입 안전한 빌더 API로 표현하기보다, 원본 SQL의
// 의도를 그대로 유지하는 게 이 프로젝트(동시성/트랜잭션이 핵심 검증 대상)에서 더 명확하다는 판단.
class PostgresRepository implements AppRepository {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly pool: Pool
  ) {}

  async close(): Promise<void> {
    await this.db.destroy();
    await this.pool.end().catch(() => undefined);
  }

  async checkReadiness(): Promise<RepositoryReadiness> {
    await sql<{ ok: number }>`select 1 as ok`.execute(this.db);
    const migrationSet = await inspectMigrationSet(this.db);
    return {
      database: "up",
      migrations: migrationSet.status
    };
  }

  async ensureSeedData(profile: SeedProfile = "development"): Promise<void> {
    if (profile === "development") {
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
    }
    for (const npc of NPC_PLAYERS) {
      await this.upsertNpc(npc);
    }
    if (profile === "development") {
      await sql`update users set role = 'admin', rating = 1680 where handle = 'admin'`.execute(this.db);
      await sql`update users set rating = 1723, wins = 32, losses = 11 where handle = 'spin-doctor'`.execute(this.db);
      await sql`update users set rating = 1640, wins = 24, losses = 13 where handle = 'paddle-pro'`.execute(this.db);
      await sql`update users set rating = 1512, wins = 18, losses = 15 where handle = 'net-ninja'`.execute(this.db);
      await sql`update users set rating = 1450, wins = 15, losses = 17 where handle = 'top-spin'`.execute(this.db);
    }
  }

  async upsertDevUser(input: DevLoginInput): Promise<SessionUser> {
    const handle = normalizeHandle(input.handle);
    const email = input.email ?? `${handle}@dev.pong-pong.local`;
    const displayName = input.displayName.trim() || handle;
    // [INTV:EDGE] "insert ... on conflict (handle) do update set ..."는 Postgres의 upsert 문법 —
    // handle이 이미 있으면 insert 대신 지정한 update를 수행한다. excluded는 "이번에 insert하려
    // 했던 값들"을 가리키는 특수 참조. "returning *"으로 결과 로우를 그 자리에서 바로 받아, 이후
    // 별도 SELECT 없이 반환값을 만들 수 있다 — "먼저 조회해서 있으면 update, 없으면 insert"처럼
    // 두 단계로 짜면 그 사이에 다른 트랜잭션이 끼어드는 race window가 생기는데, upsert는 원자적이라
    // 그 문제가 아예 없다.
    const result = await sql<UserRow>`
      insert into users (email, handle, display_name, avatar_key, role, is_npc)
      values (${email}, ${handle}, ${displayName}, ${avatarFor(handle)}, 'user', false)
      on conflict (handle) do update set
        email = excluded.email,
        display_name = excluded.display_name,
        role = 'user',
        is_npc = false
      returning *
    `.execute(this.db);
    return toSessionUser(firstRow(result));
  }

  private async upsertNpc(input: NpcSeed): Promise<void> {
    await sql`
      insert into users (email, handle, display_name, avatar_key, role, status, rating, wins, losses, is_npc)
      values (null, ${input.handle}, ${input.displayName}, ${input.avatarKey}, 'user', 'active', ${input.rating}, 0, 0, true)
      on conflict (handle) do update set
        display_name = excluded.display_name,
        avatar_key = excluded.avatar_key,
        status = 'active',
        rating = excluded.rating,
        is_npc = true
    `.execute(this.db);
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

  async deleteSession(token: string | undefined): Promise<void> {
    if (!token) return;
    await sql`delete from sessions where token = ${token}`.execute(this.db);
  }

  async createWsTicket(input: CreateWsTicketInput): Promise<void> {
    assertWsTicketHash(input.ticketHash);
    assertTicketTtl(input.ttlSeconds);
    await sql`
      insert into ws_tickets (ticket_hash, user_id, expires_at)
      values (
        ${input.ticketHash},
        ${input.userId},
        now() + (${input.ttlSeconds} * interval '1 second')
      )
    `.execute(this.db);
  }

  async consumeWsTicket(ticketHash: string): Promise<SessionUser | null> {
    assertWsTicketHash(ticketHash);
    const result = await sql<UserRow>`
      with consumed as (
        delete from ws_tickets
        where ticket_hash = ${ticketHash}
        returning user_id, expires_at
      )
      select u.*
      from consumed c
      join users u on u.id = c.user_id
      where c.expires_at > now() and u.status = 'active'
      limit 1
    `.execute(this.db);
    return result.rows[0] ? toSessionUser(result.rows[0], true) : null;
  }

  async setUserRoleByHandle(handle: string, role: UserRole): Promise<PublicUser> {
    const result = await sql<UserRow>`
      update users
      set role = ${role}
      where handle = ${normalizeHandle(handle)} and is_npc = false
      returning *
    `.execute(this.db);
    if (!result.rows[0]) throw new Error("user not found");
    return toPublicUser(result.rows[0]);
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

  async listNpcOpponents(): Promise<PublicUser[]> {
    const result = await sql<UserRow>`select * from users where status = 'active' and is_npc = true order by rating asc`.execute(this.db);
    return result.rows.map((row) => toPublicUser(row, false));
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
    const result = userId
      ? await sql<MatchWithHandlesRow>`
        select m.*, winner.handle as winner_handle, loser.handle as loser_handle
        from matches m
        left join users winner on winner.id = m.winner_id
        left join users loser on loser.id = m.loser_id
        where m.winner_id = ${userId} or m.loser_id = ${userId}
        order by m.ended_at desc
        limit 8
      `.execute(this.db)
      : await sql<MatchWithHandlesRow>`
        select m.*, winner.handle as winner_handle, loser.handle as loser_handle
        from matches m
        left join users winner on winner.id = m.winner_id
        left join users loser on loser.id = m.loser_id
        order by m.ended_at desc
        limit 8
      `.execute(this.db);
    return result.rows.map((row) => toMatchSummary(row, userId));
  }

  async getDashboard(userId: string): Promise<DashboardSummary> {
    const user = await this.getUserById(userId);
    if (!user) throw new Error("user not found");
    const recentMatches = await this.listRecentMatches(userId);
    return {
      me: { ...user, email: null },
      recentMatches,
      winRate: percentage(user.wins, user.losses),
      bestStreak: bestWinningStreak(recentMatches)
    };
  }

  async listFriends(userId: string): Promise<FriendSummary[]> {
    const result = await sql<FriendshipWithUserRow>`
      select f.id as friendship_id, f.status as friendship_status, u.*
      from friendships f
      join users u on u.id = case when f.requester_id = ${userId} then f.addressee_id else f.requester_id end
      where f.requester_id = ${userId} or f.addressee_id = ${userId}
      order by f.updated_at desc
    `.execute(this.db);
    return result.rows.map(toFriendSummary);
  }

  async requestFriend(requesterId: string, addresseeHandle: string): Promise<FriendSummary> {
    const addressee = await this.getUserByHandle(addresseeHandle);
    if (!addressee) throw new Error("friend not found");
    if (requesterId === addressee.id) throw new Error("cannot friend yourself");
    // [INTV:EDGE] least(a,b)/greatest(a,b): 두 값 중 작은/큰 쪽을 돌려주는 Postgres 함수. A가 B에게
    // 요청하든 B가 A에게 요청하든 (least, greatest) 쌍은 항상 같은 값이 되므로, 이 식에 걸린 고유
    // 제약이 "A-B 친구 관계는 누가 먼저 신청했든 하나만 존재"를 강제한다. requester_id/addressee_id
    // 컬럼 자체에 그냥 UNIQUE를 걸면 (A,B)와 (B,A)가 서로 다른 로우로 취급돼 같은 관계가 중복
    // 생성될 수 있는데, least/greatest로 "방향 무관 정규화"를 해두면 그 문제가 애초에 성립하지
    // 않는다. 그래서 아래 conflict 처리에서 "상대가 이미 나에게 신청해둔 상태였다면 새 요청을
    // 중복 생성하는 대신 그 자리에서 수락 처리"하는 분기가 가능해진다.
    const result = await sql<{ id: string; status: FriendSummary["status"] }>`
      insert into friendships (requester_id, addressee_id, status)
      values (${requesterId}, ${addressee.id}, 'pending')
      on conflict (
        (least(requester_id, addressee_id)),
        (greatest(requester_id, addressee_id))
      ) do update set
        status = case
          when friendships.status = 'pending'
            and friendships.requester_id = excluded.addressee_id
            and friendships.addressee_id = excluded.requester_id
          then 'accepted'
          else friendships.status
        end,
        updated_at = case
          when friendships.status = 'pending'
            and friendships.requester_id = excluded.addressee_id
            and friendships.addressee_id = excluded.requester_id
          then now()
          else friendships.updated_at
        end
      returning id, status
    `.execute(this.db);
    const friendship = firstRow(result);
    return { id: friendship.id, status: friendship.status, user: addressee };
  }

  async acceptFriend(userId: string, friendshipId: string): Promise<FriendSummary> {
    const result = await sql<{ id: string; status: FriendSummary["status"]; requester_id: string }>`
      update friendships
      set status = 'accepted', updated_at = now()
      where id = ${friendshipId} and addressee_id = ${userId}
      returning id, status, requester_id
    `.execute(this.db);
    const friendship = firstRow(result);
    const requester = await this.getUserById(friendship.requester_id);
    if (!requester) throw new Error("friend not found");
    return { id: friendship.id, status: friendship.status, user: requester };
  }

  async createMatch(input: CreateMatchInput): Promise<string> {
    const result = await this.finalizeMatch({
      ...input,
      resultKey: `legacy:${randomUUID()}`
    });
    return result.matchId;
  }

  async finalizeMatch(command: FinalizeMatchCommand): Promise<FinalizeMatchResult> {
    assertFinalizeMatchCommand(command);

    // [INTV:ARCH] db.transaction().execute(async (transaction) => {...}): kysely의 트랜잭션 API.
    // 콜백 안에서 쿼리를 실행할 때 this.db 대신 인자로 받은 transaction을 넘겨야 같은 트랜잭션
    // 안에서 실행된다(commerce-transaction 프로젝트의 Prisma $transaction(tx => ...) 콜백 패턴과
    // 동일한 원리 — 트랜잭션 객체를 명시적으로 계속 전달해야 하는 방식). 콜백이 예외를 던지면
    // 자동으로 rollback되고, 정상적으로 반환하면 commit된다 — 레이팅 반영/매치 기록/토너먼트 갱신을
    // 한 덩어리로 묶는 이유는 중간에 실패했을 때 "매치는 기록됐는데 레이팅은 안 바뀜" 같은 어중간한
    // 상태를 남기지 않기 위해서다.
    // - [FLOW] 1. resultKey UNIQUE 제약으로 멱등 삽입 시도 -> 2. 이미 존재하면(created:false) 기존
    //   매치 id만 조회해 반환, 트랜잭션의 나머지(레이팅 갱신)는 건너뜀 -> 3. 새로 삽입됐으면 참가자
    //   id를 정렬 -> 4. 정렬된 순서로 각 유저 로우에 FOR UPDATE 락 -> 5. 레이팅 계산·갱신 -> 6.
    //   커밋 시 전체가 원자적으로 반영
    return this.db.transaction().execute(async (transaction) => {
      // [INTV:EDGE] resultKey에 unique 제약이 걸려 있어 "on conflict (result_key) do nothing"이
      // 중복 삽입을 막는다. 같은 경기 종료 이벤트가 네트워크 재시도 등으로 두 번 들어와도, 두 번째
      // 호출은 새로 만들지 않고 기존 매치 id를 그대로 돌려준다(created: false) — 멱등성을 DB
      // 제약으로 보장하는 방식(애플리케이션 레벨의 "먼저 조회해서 있으면 스킵" 방식은 조회와 삽입
      // 사이에 race window가 남지만, UNIQUE 제약 + on conflict는 그 window 자체가 없다).
      const inserted = await sql<{ id: string }>`
        insert into matches (
          result_key,
          mode,
          winner_id,
          loser_id,
          score_left,
          score_right,
          rating_delta
        )
        values (
          ${command.resultKey},
          ${command.mode},
          ${command.winnerId},
          ${command.loserId},
          ${command.scoreLeft},
          ${command.scoreRight},
          16
        )
        on conflict (result_key) do nothing
        returning id
      `.execute(transaction);

      if (!inserted.rows[0]) {
        const existing = await sql<{ id: string }>`
          select id
          from matches
          where result_key = ${command.resultKey}
          limit 1
        `.execute(transaction);
        return {
          matchId: firstRow(existing).id,
          resultKey: command.resultKey,
          created: false
        };
      }

      const matchId = inserted.rows[0].id;
      const ratings = new Map<string, number>();
      // [INTV:EDGE] 승자/패자 id에서 중복을 제거하고 정렬한다. 정렬하는 이유는 아래 for update로
      // 여러 로우를 잠글 때, 동시에 실행되는 다른 트랜잭션도 항상 "같은 순서로" 잠그도록 강제하기
      // 위해서다 — 두 트랜잭션이 같은 두 유저 로우를 서로 반대 순서로 잠그려 하면(예: 트랜잭션1이
      // A→B, 트랜잭션2가 B→A 순서로 락을 시도) 각자 상대가 쥔 락을 기다리며 영원히 대기하는
      // 교착상태(deadlock)가 생길 수 있는데, 모든 트랜잭션이 항상 같은 정렬 순서로 락을 걸면 이
      // 순환 대기 자체가 구조적으로 불가능해진다 — 전형적인 "락 순서 고정(lock ordering)"에 의한
      // 데드락 방지 기법.
      const participantIds = [command.winnerId, command.loserId]
        .filter((id): id is string => id !== null)
        .filter((id, index, values) => values.indexOf(id) === index)
        .sort();

      for (const userId of participantIds) {
        // [INTV:EDGE] "for update": 이 SELECT가 읽은 로우에 배타적 잠금을 건다 — 이 트랜잭션이
        // commit/rollback될 때까지 다른 트랜잭션은 같은 로우를 for update로 읽을 수 없다(대기하게
        // 된다). 두 매치가 동시에 끝나서 같은 유저의 레이팅을 동시에 갱신하려 할 때, "먼저 읽은
        // 값 기준으로 계산 → 나중에 덮어쓰기"로 한쪽 변경이 유실되는 경쟁 상태(lost update)를 막기
        // 위한 비관적 잠금이다 — commerce-transaction 프로젝트의 SELECT ... FOR UPDATE 재고 잠금과
        // 정확히 같은 문제/해법.
        const locked = await sql<{ id: string; rating: number }>`
          select id, rating
          from users
          where id = ${userId}
          for update
        `.execute(transaction);
        const user = firstRow(locked);
        ratings.set(user.id, Number(user.rating));
      }

      if (command.winnerId) {
        const ratingBefore = requireRating(ratings, command.winnerId);
        const ratingAfter = ratingBefore + 16;
        await sql`
          update users
          set wins = wins + 1, rating = ${ratingAfter}
          where id = ${command.winnerId}
        `.execute(transaction);
        await sql`
          insert into rating_history (
            match_id,
            user_id,
            rating_before,
            rating_after,
            delta
          )
          values (
            ${matchId},
            ${command.winnerId},
            ${ratingBefore},
            ${ratingAfter},
            ${ratingAfter - ratingBefore}
          )
        `.execute(transaction);
      }

      if (command.loserId) {
        const ratingBefore = requireRating(ratings, command.loserId);
        const ratingAfter = Math.max(800, ratingBefore - 12);
        await sql`
          update users
          set losses = losses + 1, rating = ${ratingAfter}
          where id = ${command.loserId}
        `.execute(transaction);
        await sql`
          insert into rating_history (
            match_id,
            user_id,
            rating_before,
            rating_after,
            delta
          )
          values (
            ${matchId},
            ${command.loserId},
            ${ratingBefore},
            ${ratingAfter},
            ${ratingAfter - ratingBefore}
          )
        `.execute(transaction);
      }

      if (command.tournament) {
        const tournamentMatch = await sql<{
          id: string;
          tournament_id: string;
          round: "semifinal" | "final";
          match_id: string | null;
          left_user_id: string | null;
          right_user_id: string | null;
        }>`
          select id, tournament_id, round, match_id, left_user_id, right_user_id
          from tournament_matches
          where id = ${command.tournament.tournamentMatchId}
          for update
        `.execute(transaction);
        const tournamentMatchRow = tournamentMatch.rows[0];
        if (!tournamentMatchRow) {
          throw new Error("tournament match not found");
        }

        await sql`
          select id
          from tournaments
          where id = ${tournamentMatchRow.tournament_id}
          for update
        `.execute(transaction);

        if (tournamentMatchRow.match_id) {
          throw new Error("tournament match already finalized");
        }
        const tournamentParticipants = [
          tournamentMatchRow.left_user_id,
          tournamentMatchRow.right_user_id
        ].filter((id): id is string => id !== null);
        if (command.winnerId && !tournamentParticipants.includes(command.winnerId)) {
          throw new Error("winner is not in tournament match");
        }
        if (command.loserId && !tournamentParticipants.includes(command.loserId)) {
          throw new Error("loser is not in tournament match");
        }

        const linked = await sql<{ id: string }>`
          update tournament_matches
          set status = 'finished',
              room_id = ${command.tournament.roomId},
              match_id = ${matchId},
              winner_id = ${command.winnerId},
              score_left = ${command.scoreLeft},
              score_right = ${command.scoreRight},
              updated_at = now()
          where id = ${command.tournament.tournamentMatchId}
            and match_id is null
          returning id
        `.execute(transaction);
        firstRow(linked);

        if (tournamentMatchRow.round === "semifinal") {
          const semifinals = await sql<{ winner_id: string; slot: number }>`
            select winner_id, slot
            from tournament_matches
            where tournament_id = ${tournamentMatchRow.tournament_id}
              and round = 'semifinal'
              and status = 'finished'
              and winner_id is not null
            order by slot asc
          `.execute(transaction);
          // [INTV:ARCH] 4강(semifinal) 두 경기가 모두 끝나 승자가 둘 다 정해지면, 그 둘을 맞붙이는
          // 결승(final) 매치를 자동으로 만든다 — 단일 토너먼트 대진표 진행을 사람이 개입하지 않고
          // 이어가는 도메인 로직. 이 생성 자체도 같은 트랜잭션(finalizeMatch) 안에서 일어나므로,
          // "4강 결과는 기록됐는데 결승 매치는 안 만들어짐" 같은 중간 상태가 생기지 않는다.
          if (semifinals.rows.length === 2) {
            await sql`
              insert into tournament_matches (
                tournament_id,
                round,
                slot,
                left_user_id,
                right_user_id,
                status
              )
              values (
                ${tournamentMatchRow.tournament_id},
                'final',
                1,
                ${semifinals.rows[0].winner_id},
                ${semifinals.rows[1].winner_id},
                'ready'
              )
              on conflict (tournament_id, round, slot) do nothing
            `.execute(transaction);
          }
        } else {
          await sql`
            update tournaments
            set status = 'finished', winner_id = ${command.winnerId}
            where id = ${tournamentMatchRow.tournament_id}
          `.execute(transaction);
        }
      }

      return {
        matchId,
        resultKey: command.resultKey,
        created: true
      };
    });
  }

  async listLobbyChat(): Promise<ChatMessage[]> {
    const result = await sql<ChatMessageWithSenderRow>`
      select c.*, u.id as user_id, u.email, u.handle, u.display_name, u.avatar_key, u.role, u.status, u.rating, u.wins, u.losses, u.is_npc
      from chat_messages c
      join users u on u.id = c.sender_id
      where c.scope = 'lobby'
      order by c.created_at desc
      limit 20
    `.execute(this.db);
    return result.rows.reverse().map(toChatMessage);
  }

  async createChatMessage(input: { scope: "lobby" | "match"; roomId?: string | null; senderId: string; body: string }): Promise<ChatMessage> {
    assertChatRoom(input);
    const result = await sql<ChatMessageRow>`
      insert into chat_messages (scope, room_id, sender_id, body)
      values (${input.scope}, ${input.roomId ?? null}, ${input.senderId}, ${input.body})
      returning *
    `.execute(this.db);
    const user = await this.getUserById(input.senderId);
    if (!user) throw new Error("chat sender not found");
    const row = firstRow(result);
    return {
      id: row.id,
      scope: row.scope,
      roomId: row.room_id,
      sender: user,
      body: row.body,
      createdAt: new Date(row.created_at).toISOString()
    };
  }

  async listTournaments(): Promise<TournamentSummary[]> {
    const result = await sql<TournamentWithCreatorRow>`
      select t.*, u.id as creator_id, u.email, u.handle, u.display_name, u.avatar_key, u.role, u.status as user_status, u.rating, u.wins, u.losses, u.is_npc
      from tournaments t
      join users u on u.id = t.created_by
      order by t.created_at desc
      limit 10
    `.execute(this.db);
    const summaries: TournamentSummary[] = [];
    for (const row of result.rows) {
      summaries.push(await this.tournamentFromRow(row));
    }
    return summaries;
  }

  async createTournament(input: { name: string; createdBy: string }): Promise<TournamentSummary> {
    const result = await sql<TournamentRow>`
      insert into tournaments (name, created_by, capacity)
      values (${input.name}, ${input.createdBy}, 4)
      returning *
    `.execute(this.db);
    await this.joinTournament(firstRow(result).id, input.createdBy);
    const tournaments = await this.listTournaments();
    return tournaments.find((item) => item.id === firstRow(result).id) ?? tournaments[0];
  }

  async joinTournament(tournamentId: string, userId: string): Promise<TournamentSummary> {
    await this.db.transaction().execute(async (transaction) => {
      const tournament = await sql<{ capacity: number }>`
        select capacity
        from tournaments
        where id = ${tournamentId}
        for update
      `.execute(transaction);
      const tournamentRow = firstRow(tournament);
      const existing = await sql<{ id: string }>`
        select id
        from tournament_entries
        where tournament_id = ${tournamentId} and user_id = ${userId}
        limit 1
      `.execute(transaction);
      if (existing.rows[0]) return;

      const entryState = await sql<{ count: number; next_seed: number }>`
        select
          count(*)::integer as count,
          (coalesce(max(seed), 0) + 1)::integer as next_seed
        from tournament_entries
        where tournament_id = ${tournamentId}
      `.execute(transaction);
      const state = firstRow(entryState);
      if (Number(state.count) >= Number(tournamentRow.capacity)) {
        throw new Error("tournament full");
      }

      await sql`
        insert into tournament_entries (tournament_id, user_id, seed)
        values (${tournamentId}, ${userId}, ${state.next_seed})
      `.execute(transaction);
      const playerCount = Number(state.count) + 1;
      if (playerCount >= Number(tournamentRow.capacity)) {
        await sql`
          update tournaments
          set status = 'running'
          where id = ${tournamentId}
        `.execute(transaction);
        await this.ensureTournamentBracket(tournamentId, transaction);
      }
    });
    const tournaments = await this.listTournaments();
    const found = tournaments.find((item) => item.id === tournamentId);
    if (!found) throw new Error("tournament not found");
    return found;
  }

  async getTournamentMatch(matchId: string): Promise<TournamentMatchRecord | null> {
    const result = await sql<TournamentMatchRow>`select * from tournament_matches where id = ${matchId} limit 1`.execute(this.db);
    return result.rows[0] ? toTournamentMatchRecord(result.rows[0]) : null;
  }

  async startTournamentMatch(matchId: string, roomId: string): Promise<void> {
    const updated = await sql<{ id: string }>`
      update tournament_matches
      set status = 'running', room_id = ${roomId}, updated_at = now()
      where id = ${matchId} and status in ('ready', 'running')
      returning id
    `.execute(this.db);
    if (updated.rows.length !== 1) throw new Error("tournament match not found");
  }

  async listAdminUsers(): Promise<PublicUser[]> {
    const result = await sql<UserRow>`select * from users order by created_at desc limit 50`.execute(this.db);
    return result.rows.map((row) => toPublicUser(row, true));
  }

  async listAdminActions(): Promise<AdminActionSummary[]> {
    const result = await sql<AdminActionRow>`
      select *
      from admin_actions
      order by created_at desc
      limit 30
    `.execute(this.db);
    return Promise.all(result.rows.map(async (row) => toAdminActionSummary(row, {
      actor: row.actor_id ? await this.getUserById(row.actor_id) : null,
      target: row.target_user_id ? await this.getUserById(row.target_user_id) : null
    })));
  }

  async setUserBan(actorId: string, targetUserId: string, banned: boolean, reason: string): Promise<PublicUser> {
    return this.db.transaction().execute(async (transaction) => {
      const result = await sql<UserRow>`
        update users
        set status = ${banned ? "banned" : "active"}, banned_at = ${banned ? sql`now()` : null}
        where id = ${targetUserId}
        returning *
      `.execute(transaction);
      await sql`
        insert into admin_actions (actor_id, target_user_id, action, reason)
        values (${actorId}, ${targetUserId}, ${banned ? "ban" : "unban"}, ${reason})
      `.execute(transaction);
      return toPublicUser(firstRow(result));
    });
  }

  private async tournamentFromRow(row: TournamentWithCreatorRow): Promise<TournamentSummary> {
    const entries = await sql<UserRow>`
      select u.*
      from tournament_entries e
      join users u on u.id = e.user_id
      where e.tournament_id = ${row.id}
      order by e.seed asc
    `.execute(this.db);
    const matches = await sql<TournamentMatchRow>`
      select *
      from tournament_matches
      where tournament_id = ${row.id}
      order by case when round = 'semifinal' then 1 else 2 end, slot asc
    `.execute(this.db);
    return toTournamentSummary(row, {
      entries: entries.rows.map((entry) => toPublicUser(entry, true)),
      matches: await Promise.all(matches.rows.map((match) => this.tournamentMatchFromRow(match))),
      winner: row.winner_id ? await this.getUserById(row.winner_id) : null
    });
  }

  private async ensureTournamentBracket(
    tournamentId: string,
    executor: Kysely<Database> | Transaction<Database> = this.db
  ): Promise<void> {
    const entries = await sql<{ user_id: string; seed: number }>`
      select user_id, seed
      from tournament_entries
      where tournament_id = ${tournamentId}
      order by seed asc
    `.execute(executor);
    if (entries.rows.length < 4) return;
    // [INTV:ARCH] 참가 순서(seed) 1번과 4번, 2번과 3번을 맞붙인다 — 먼저 들어온(강하다고 가정하는)
    // 참가자들이 결승 전에 서로 만나지 않도록 배치하는 전형적인 토너먼트 시딩 방식(1 vs 4, 2 vs 3
    // 이 표준 4강 시딩 — 1번과 2번이 결승까지 살아남으면 최종전에서야 만난다).
    await sql`
      insert into tournament_matches (tournament_id, round, slot, left_user_id, right_user_id, status)
      values
        (${tournamentId}, 'semifinal', 1, ${entries.rows[0].user_id}, ${entries.rows[3].user_id}, 'ready'),
        (${tournamentId}, 'semifinal', 2, ${entries.rows[1].user_id}, ${entries.rows[2].user_id}, 'ready')
      on conflict (tournament_id, round, slot) do nothing
    `.execute(executor);
  }

  private async tournamentMatchFromRow(row: TournamentMatchRow): Promise<TournamentMatchSummary> {
    return toTournamentMatchSummary(row, {
      left: row.left_user_id ? await this.getUserById(row.left_user_id) : null,
      right: row.right_user_id ? await this.getUserById(row.right_user_id) : null,
      winner: row.winner_id ? await this.getUserById(row.winner_id) : null
    });
  }
}

// [INTV:TRADE_OFF] PostgresRepository와 같은 AppRepository 계약을 Map/배열 같은 순수 JS
// 자료구조로 구현한 버전 — 실제 Postgres 없이도 동일한 동작(멱등성, 잠금 대신 동기 실행이라 경쟁
// 상태 자체가 없음, 브래킷 시딩 규칙 등)을 흉내 내어 테스트/로컬 개발에서 빠르게 쓸 수 있게 한다.
// Node는 싱글 스레드라 async 함수라도 await 없는 동기 구간은 중간에 끼어들 수 없으므로, 여기선
// FOR UPDATE 같은 명시적 락 없이도 "한 메서드 호출이 끝날 때까지는 다른 호출이 끼어들지 않는다"는
// 성질만으로 경쟁 상태가 자연히 없다 — DB 버전이 명시적 락으로 보장하는 것과 같은 결과를 런타임
// 특성으로 공짜로 얻는 셈(다만 이 트릭은 단일 프로세스에서만 성립 — 여러 인스턴스로 스케일 아웃하면
// 깨진다는 게 이 메모리 구현이 프로덕션에 쓰일 수 없는 근본 이유). 아래 각 메서드는 위
// PostgresRepository의 같은 이름 메서드와 "같은 규칙"을 지키는 게 목적이라, 이미 설명한 도메인
// 로직(레이팅 계산, 브래킷 시딩 등)은 반복 설명하지 않는다.
class MemoryRepository implements AppRepository {
  private readonly users = new Map<string, UserProjectionRow>();
  private readonly sessions = new Map<string, string>();
  private readonly wsTickets = new Map<string, { userId: string; expiresAt: number }>();
  private readonly matches: MemoryMatchRecord[] = [];
  private readonly chats: ChatMessage[] = [];
  private readonly friendships: MemoryFriendship[] = [];
  private readonly tournaments: TournamentSummary[] = [];
  private readonly adminActions: AdminActionSummary[] = [];

  async close(): Promise<void> {}

  async checkReadiness(): Promise<RepositoryReadiness> {
    return { database: "up", migrations: "not_applicable" };
  }

  async ensureSeedData(profile: SeedProfile = "development"): Promise<void> {
    if (profile === "development") {
      for (const player of [
        { handle: "spin-doctor", displayName: "스핀닥터", email: "spin@pong.local" },
        { handle: "paddle-pro", displayName: "패들프로", email: "paddle@pong.local" },
        { handle: "net-ninja", displayName: "네트닌자", email: "net@pong.local" },
        { handle: "admin", displayName: "운영자", email: "admin@pong.local" }
      ]) {
        await this.upsertDevUser(player);
      }
      const admin = [...this.users.values()].find((user) => user.handle === "admin");
      if (admin) {
        admin.role = "admin";
        admin.rating = 1680;
      }
    }
    for (const npc of NPC_PLAYERS) {
      const existing = [...this.users.values()].find((user) => user.handle === npc.handle);
      const user: UserProjectionRow = existing ?? {
        id: randomUUID(),
        email: null,
        handle: npc.handle,
        display_name: npc.displayName,
        avatar_key: npc.avatarKey,
        role: "user",
        status: "active",
        rating: npc.rating,
        wins: 0,
        losses: 0,
        is_npc: true
      };
      user.display_name = npc.displayName;
      user.avatar_key = npc.avatarKey;
      user.rating = npc.rating;
      user.status = "active";
      user.is_npc = true;
      this.users.set(user.id, user);
    }
  }

  async upsertDevUser(input: DevLoginInput): Promise<SessionUser> {
    const handle = normalizeHandle(input.handle);
    const existing = [...this.users.values()].find((user) => user.handle === handle);
    const user: UserProjectionRow = existing ?? {
      id: randomUUID(),
      email: input.email ?? `${handle}@dev.pong-pong.local`,
      handle,
      display_name: input.displayName || handle,
      avatar_key: avatarFor(handle),
      role: "user",
      status: "active",
      rating: 1200,
      wins: 0,
      losses: 0,
      is_npc: false
    };
    user.display_name = input.displayName || user.display_name;
    user.email = input.email ?? user.email;
    user.role = "user";
    user.is_npc = false;
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

  async deleteSession(token: string | undefined): Promise<void> {
    if (token) this.sessions.delete(token);
  }

  async createWsTicket(input: CreateWsTicketInput): Promise<void> {
    assertWsTicketHash(input.ticketHash);
    assertTicketTtl(input.ttlSeconds);
    this.wsTickets.set(input.ticketHash, {
      userId: input.userId,
      expiresAt: Date.now() + input.ttlSeconds * 1_000
    });
  }

  async consumeWsTicket(ticketHash: string): Promise<SessionUser | null> {
    assertWsTicketHash(ticketHash);
    const ticket = this.wsTickets.get(ticketHash);
    if (!ticket) return null;
    this.wsTickets.delete(ticketHash);
    const user = this.users.get(ticket.userId);
    if (!user || ticket.expiresAt <= Date.now() || user.status !== "active") return null;
    return toSessionUser(user, true);
  }

  async setUserRoleByHandle(handle: string, role: UserRole): Promise<PublicUser> {
    const user = [...this.users.values()].find((item) => item.handle === normalizeHandle(handle) && !item.is_npc);
    if (!user) throw new Error("user not found");
    user.role = role;
    return toPublicUser(user, true);
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

  async listNpcOpponents(): Promise<PublicUser[]> {
    return [...this.users.values()]
      .filter((user) => user.is_npc && user.status === "active")
      .sort((a, b) => a.rating - b.rating)
      .map((user) => toPublicUser(user, false));
  }

  async listLeaderboard(): Promise<LeaderboardEntry[]> {
    return [...this.users.values()]
      .sort((a, b) => b.rating - a.rating || b.wins - a.wins)
      .map((user, index) => ({ rank: index + 1, user: toPublicUser(user, false), winRate: percentage(user.wins, user.losses) }));
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
    const recentMatches = await this.listRecentMatches(userId);
    return {
      me: { ...user, email: null },
      recentMatches,
      winRate: percentage(user.wins, user.losses),
      bestStreak: bestWinningStreak(recentMatches)
    };
  }

  async listFriends(userId: string): Promise<FriendSummary[]> {
    return this.friendships
      .filter((friendship) => friendship.requesterId === userId || friendship.addresseeId === userId)
      .map((friendship) => {
        const otherUserId = friendship.requesterId === userId
          ? friendship.addresseeId
          : friendship.requesterId;
        const otherUser = this.users.get(otherUserId);
        if (!otherUser) throw new Error("friend not found");
        return {
          id: friendship.id,
          status: friendship.status,
          user: toPublicUser(otherUser, true)
        };
      });
  }

  async requestFriend(requesterId: string, addresseeHandle: string): Promise<FriendSummary> {
    const user = await this.getUserByHandle(addresseeHandle);
    if (!user) throw new Error("friend not found");
    if (requesterId === user.id) throw new Error("cannot friend yourself");
    const existing = this.friendships.find((friendship) =>
      (friendship.requesterId === requesterId && friendship.addresseeId === user.id)
      || (friendship.requesterId === user.id && friendship.addresseeId === requesterId)
    );
    if (existing) {
      const isReversePending = existing.status === "pending"
        && existing.requesterId === user.id
        && existing.addresseeId === requesterId;
      if (isReversePending) existing.status = "accepted";
      return { id: existing.id, status: existing.status, user };
    }
    const friendship: MemoryFriendship = {
      id: randomUUID(),
      requesterId,
      addresseeId: user.id,
      status: "pending"
    };
    this.friendships.push(friendship);
    return { id: friendship.id, status: friendship.status, user };
  }

  async acceptFriend(userId: string, friendshipId: string): Promise<FriendSummary> {
    const friend = this.friendships.find((item) => item.id === friendshipId);
    if (!friend || friend.addresseeId !== userId) throw new Error("friendship not found");
    friend.status = "accepted";
    const requester = this.users.get(friend.requesterId);
    if (!requester) throw new Error("friend not found");
    return { id: friend.id, status: friend.status, user: toPublicUser(requester, true) };
  }

  async createMatch(input: CreateMatchInput): Promise<string> {
    const result = await this.finalizeMatch({
      ...input,
      resultKey: `legacy:${randomUUID()}`
    });
    return result.matchId;
  }

  async finalizeMatch(command: FinalizeMatchCommand): Promise<FinalizeMatchResult> {
    assertFinalizeMatchCommand(command);

    const existing = this.matches.find((match) => match.resultKey === command.resultKey);
    if (existing) {
      return {
        matchId: existing.id,
        resultKey: command.resultKey,
        created: false
      };
    }

    const winner = command.winnerId ? this.users.get(command.winnerId) : undefined;
    const loser = command.loserId ? this.users.get(command.loserId) : undefined;
    if (command.winnerId && !winner) throw new Error("winner not found");
    if (command.loserId && !loser) throw new Error("loser not found");

    const tournament = command.tournament
      ? this.findTournamentMatch(command.tournament.tournamentMatchId)
      : null;
    if (command.tournament && !tournament) {
      throw new Error("tournament match not found");
    }
    if (tournament?.match.matchId) {
      throw new Error("tournament match already finalized");
    }
    if (tournament) {
      const tournamentParticipants = [
        tournament.match.left?.id,
        tournament.match.right?.id
      ].filter((id): id is string => id !== undefined);
      if (command.winnerId && !tournamentParticipants.includes(command.winnerId)) {
        throw new Error("winner is not in tournament match");
      }
      if (command.loserId && !tournamentParticipants.includes(command.loserId)) {
        throw new Error("loser is not in tournament match");
      }
    }

    const matchId = randomUUID();
    this.matches.push({
      id: matchId,
      resultKey: command.resultKey,
      mode: command.mode,
      winnerId: command.winnerId,
      loserId: command.loserId,
      scoreLeft: command.scoreLeft,
      scoreRight: command.scoreRight,
      endedAt: new Date().toISOString()
    });

    if (winner) {
      winner.wins += 1;
      winner.rating += 16;
    }
    if (loser) {
      loser.losses += 1;
      loser.rating = Math.max(800, loser.rating - 12);
    }

    if (command.tournament && tournament) {
      tournament.match.status = "finished";
      tournament.match.roomId = command.tournament.roomId;
      tournament.match.matchId = matchId;
      tournament.match.winner = winner ? toPublicUser(winner, true) : null;
      tournament.match.scoreLeft = command.scoreLeft;
      tournament.match.scoreRight = command.scoreRight;
      if (tournament.match.round === "semifinal") {
        this.ensureMemoryFinal(tournament.tournament);
      } else {
        tournament.tournament.status = "finished";
        tournament.tournament.winner = winner ? toPublicUser(winner, true) : null;
      }
    }

    return {
      matchId,
      resultKey: command.resultKey,
      created: true
    };
  }

  async listLobbyChat(): Promise<ChatMessage[]> {
    return this.chats.filter((chat) => chat.scope === "lobby").slice(-20);
  }

  async createChatMessage(input: { scope: "lobby" | "match"; roomId?: string | null; senderId: string; body: string }): Promise<ChatMessage> {
    assertChatRoom(input);
    const sender = await this.getUserById(input.senderId);
    if (!sender) throw new Error("chat sender not found");
    const message: ChatMessage = {
      id: randomUUID(),
      scope: input.scope,
      roomId: input.roomId ?? null,
      sender,
      body: input.body,
      createdAt: new Date().toISOString()
    };
    this.chats.push(message);
    return message;
  }

  async listTournaments(): Promise<TournamentSummary[]> {
    return this.tournaments;
  }

  async createTournament(input: { name: string; createdBy: string }): Promise<TournamentSummary> {
    const creator = await this.getUserById(input.createdBy);
    if (!creator) throw new Error("creator not found");
    const tournament: TournamentSummary = {
      id: randomUUID(),
      name: input.name,
      status: "open",
      createdBy: creator,
      playerCount: 1,
      capacity: 4,
      winner: null,
      entries: [creator],
      matches: []
    };
    this.tournaments.unshift(tournament);
    return tournament;
  }

  async joinTournament(tournamentId: string, userId: string): Promise<TournamentSummary> {
    const tournament = this.tournaments.find((item) => item.id === tournamentId);
    const rawUser = this.users.get(userId);
    if (!tournament || !rawUser) throw new Error("tournament not found");
    const user = toPublicUser(rawUser, true);
    const alreadyJoined = tournament.entries.some((entry) => entry.id === user.id);
    if (!alreadyJoined && tournament.entries.length >= tournament.capacity) {
      throw new Error("tournament full");
    }
    if (!alreadyJoined) {
      tournament.entries.push(user);
    }
    tournament.playerCount = tournament.entries.length;
    tournament.status = tournament.playerCount >= tournament.capacity ? "running" : "open";
    this.ensureMemoryBracket(tournament);
    return tournament;
  }

  async getTournamentMatch(matchId: string): Promise<TournamentMatchRecord | null> {
    const match = this.findTournamentMatch(matchId)?.match;
    if (!match) return null;
    return {
      id: match.id,
      tournamentId: match.tournamentId,
      round: match.round,
      slot: match.slot,
      status: match.status,
      leftUserId: match.left?.id ?? null,
      rightUserId: match.right?.id ?? null,
      winnerId: match.winner?.id ?? null
    };
  }

  async startTournamentMatch(matchId: string, roomId: string): Promise<void> {
    const found = this.findTournamentMatch(matchId);
    if (!found) throw new Error("tournament match not found");
    found.match.status = "running";
    found.match.roomId = roomId;
  }

  async listAdminUsers(): Promise<PublicUser[]> {
    return this.listOnlineUsers();
  }

  async listAdminActions(): Promise<AdminActionSummary[]> {
    return this.adminActions;
  }

  async setUserBan(actorId: string, targetUserId: string, banned: boolean, reason: string): Promise<PublicUser> {
    const user = this.users.get(targetUserId);
    if (!user) throw new Error("user not found");
    user.status = banned ? "banned" : "active";
    const actor = await this.getUserById(actorId);
    const target = toPublicUser(user, true);
    this.adminActions.unshift({
      id: randomUUID(),
      actor,
      target,
      action: banned ? "ban" : "unban",
      reason,
      createdAt: new Date().toISOString()
    });
    return target;
  }

  private ensureMemoryBracket(tournament: TournamentSummary): void {
    if (tournament.entries.length < tournament.capacity || tournament.matches.some((match) => match.round === "semifinal")) return;
    tournament.matches.push(
      memoryTournamentMatch(tournament.id, "semifinal", 1, tournament.entries[0], tournament.entries[3]),
      memoryTournamentMatch(tournament.id, "semifinal", 2, tournament.entries[1], tournament.entries[2])
    );
  }

  private ensureMemoryFinal(tournament: TournamentSummary): void {
    if (tournament.matches.some((match) => match.round === "final")) return;
    const semis = tournament.matches.filter((match) => match.round === "semifinal" && match.status === "finished" && match.winner).sort((a, b) => a.slot - b.slot);
    if (semis.length < 2) return;
    tournament.matches.push(memoryTournamentMatch(tournament.id, "final", 1, semis[0].winner, semis[1].winner));
  }

  private findTournamentMatch(matchId: string): { tournament: TournamentSummary; match: TournamentMatchSummary } | null {
    for (const tournament of this.tournaments) {
      const match = tournament.matches.find((item) => item.id === matchId);
      if (match) return { tournament, match };
    }
    return null;
  }
}

// [INTV:TRAP] kysely 쿼리 결과({ rows: T[] })에서 첫 로우를 꺼내되, 없으면 조용히 undefined를
// 다루게 두지 않고 즉시 예외를 던진다 — "이 시점엔 반드시 로우가 있어야 한다"는 가정을 코드 곳곳에서
// 매번 if로 확인하지 않아도 되게 해준다. result.rows[0]을 그대로 쓰고 non-null assertion(!)만
// 붙이는 재구현은, 실제로 로우가 없는 예외 상황(버그·경합)에서 undefined에 필드 접근을 시도해
// "undefined의 속성을 읽을 수 없음" 같은 훨씬 불친절한 에러로 이어진다 — 이 헬퍼가 실패 지점을
// 더 이르고 명확하게 만든다.
function firstRow<T>(result: { rows: T[] }): T {
  const row = result.rows[0];
  if (!row) throw new Error("expected database row");
  return row;
}

// [INTV:EDGE] 사용자가 입력한 handle을 URL/멘션 등에 쓰기 안전한 slug 형태(소문자, 영숫자와 -만)로
// 정규화한다(profile/:handle 라우트 파라미터로 그대로 쓰이므로, 특수문자를 걸러내지 않으면 경로
// 인젝션/이스케이핑 문제의 소지가 된다).
function normalizeHandle(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "player";
}

// [INTV:EDGE] WS 티켓은 클라이언트에 원문 그대로 내려주지만 DB에는 그 해시(SHA-256, 64자 16진수)만
// 저장한다 — 비밀번호를 평문 대신 해시로 저장하는 것과 같은 이유로, DB가 유출돼도 원문 티켓(=그
// 자체로 들고 있으면 인증에 쓸 수 있는 값) 자체는 복원할 수 없게 하기 위함(wsTicket.ts의
// hashWsTicket이 저장 전 변환을 담당, 여기 assertWsTicketHash는 "이미 해시된 형태가 맞는지"만
// 재검증). 이 함수는 "해시처럼 생긴 값만 받는다"는 형식 검증만 한다.
function assertWsTicketHash(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error("invalid websocket ticket hash");
  }
}

function assertTicketTtl(value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("invalid websocket ticket ttl");
  }
}

function assertChatRoom(input: { scope: "lobby" | "match"; roomId?: string | null }): void {
  if (input.scope === "lobby") {
    if (input.roomId !== undefined && input.roomId !== null) {
      throw new Error("lobby chat must not identify a room");
    }
    return;
  }
  if (!input.roomId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.roomId)) {
    throw new Error("match chat requires a UUID room");
  }
}

function assertFinalizeMatchCommand(command: FinalizeMatchCommand): void {
  if (!command.resultKey.trim() || command.resultKey.length > 200) {
    throw new Error("invalid match result key");
  }
  if (command.winnerId && command.winnerId === command.loserId) {
    throw new Error("match participants must be different");
  }
  if (!Number.isInteger(command.scoreLeft) || command.scoreLeft < 0) {
    throw new Error("invalid left score");
  }
  if (!Number.isInteger(command.scoreRight) || command.scoreRight < 0) {
    throw new Error("invalid right score");
  }
  if (command.tournament) {
    if (command.mode !== "tournament") {
      throw new Error("tournament link requires tournament mode");
    }
    if (!command.tournament.tournamentMatchId || !command.tournament.roomId.trim()) {
      throw new Error("invalid tournament match link");
    }
  }
}

function requireRating(ratings: Map<string, number>, userId: string): number {
  const rating = ratings.get(userId);
  if (rating === undefined) throw new Error("match participant not found");
  return rating;
}

// [INTV:ARCH] handle 문자들의 문자코드 합을 팔레트 길이로 나눈 나머지로 아바타를 고른다 — 별도로
// 저장/난수 생성을 하지 않아도 "같은 handle은 항상 같은 아바타 색"이 되도록 결정론적으로 매핑하는
// 트릭(pongAi.ts의 hashSeed와 같은 "결정론적 해시로 저장 없이 일관된 값을 얻는다"는 아이디어의
// 훨씬 단순한 변형 — 해시 강도가 중요하지 않은 용도라 문자코드 합만으로 충분).
function avatarFor(handle: string): string {
  const avatars = ["blue", "green", "amber", "violet", "rose"];
  return avatars[Math.abs([...handle].reduce((sum, char) => sum + char.charCodeAt(0), 0)) % avatars.length];
}

function percentage(wins: number, losses: number): number {
  const total = Number(wins) + Number(losses);
  if (total === 0) return 0;
  return Math.round((Number(wins) / total) * 1000) / 10;
}

function bestWinningStreak(matches: MatchSummary[]): number {
  let best = 0;
  let current = 0;
  for (const match of [...matches].reverse()) {
    if (match.result === "win") {
      current += 1;
      best = Math.max(best, current);
    } else {
      current = 0;
    }
  }
  return best;
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
    endedAt: row.endedAt
  };
}

function memoryTournamentMatch(tournamentId: string, round: "semifinal" | "final", slot: number, left: PublicUser | null, right: PublicUser | null): TournamentMatchSummary {
  return {
    id: randomUUID(),
    tournamentId,
    round,
    slot,
    status: "ready",
    left,
    right,
    winner: null,
    scoreLeft: null,
    scoreRight: null,
    roomId: null,
    matchId: null
  };
}

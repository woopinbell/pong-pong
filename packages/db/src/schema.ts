import type {
  FriendshipStatus,
  MatchMode,
  TournamentStatus,
  UserRole,
  UserStatus
} from "@pong-pong/shared";
import type { Generated, Selectable } from "kysely";

// [INTV:ARCH] 이 파일은 kysely(SQL 쿼리 빌더)에게 DB 테이블의 컬럼 구조를 알려주는 타입 정의
// 모음이다. 여기의 인터페이스는 실제 실행되는 SQL을 만들지 않는다 — kysely가 쿼리를 만들 때
// 컬럼명/타입을 컴파일 타임에 검사하도록 "설계도" 역할만 한다(Prisma의 schema.prisma가 코드 생성을
// 트리거하는 것과 달리, kysely는 순수 타입 정의만으로 타입 안전한 쿼리 빌더를 얻는 방식 — 코드
// 생성 단계가 없다는 게 차이). 컬럼명이 snake_case인 것도 실제 Postgres 테이블 컬럼명을 그대로
// 따른 것(API가 쓰는 camelCase DTO로의 변환은 rowMappers.ts에서 담당).
export type TournamentRound = "semifinal" | "final";
export type TournamentMatchStatus = "pending" | "ready" | "running" | "finished";
export type ChatScope = "lobby" | "match";
export type AdminAction = "ban" | "unban";

// [INTV:ARCH] Generated<T>: kysely의 유틸리티 타입 — "이 컬럼은 DB가 기본값/시퀀스로 채워주므로
// INSERT 시 생략 가능하지만, SELECT로 읽어올 때는 항상 T 타입으로 존재한다"는 뜻. 예: id는 DB의
// gen_random_uuid() 같은 기본값으로 채워지므로 insert할 때 안 넘겨도 되지만, 읽어올 땐 항상
// string이다 — 이 마킹이 없으면 INSERT 시 필수 필드로 취급돼 매번 값을 명시해야 하거나, 반대로
// SELECT 결과가 optional 취급되는 타입 불일치가 생긴다.
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

// [INTV:ARCH] kysely 인스턴스를 만들 때 `Kysely<Database>` 형태로 넘기는 최상위 타입 — 테이블
// 이름(문자열 키)과 그 테이블의 컬럼 타입을 매핑해서, `.selectFrom("users")` 같은 호출에서 테이블명
// 오타나 존재하지 않는 컬럼 참조를 컴파일 타임에 잡아낼 수 있게 한다(migrator.ts의 SQL 마이그레이션
// 파일 자체는 타입 체크되지 않으므로, 이 Database 타입과 실제 마이그레이션 SQL이 어긋나지 않게
// 유지하는 건 개발자의 책임 — 자동으로 동기화되지 않는다는 점이 재구현 시 놓치기 쉬운 한계).
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

// [INTV:ARCH] Selectable<T>: Generated<X>로 감싼 컬럼을 실제 X 타입으로 풀어주는 kysely 유틸리티
// 타입. "SELECT로 읽어왔을 때 실제로 받게 되는 로우의 모양"을 나타낸다(INSERT용 Insertable<T>와는
// 다른 타입 — 같은 테이블 정의에서 읽기/쓰기 각각에 맞는 파생 타입을 뽑아 쓰는 kysely의 패턴).
export type UserRow = Selectable<UserTable>;
// [INTV:ARCH] Pick<T, "a" | "b" | ...>: TypeScript 유틸리티 타입 — T의 필드 중 나열한 것만 남긴
// 부분 타입을 만든다. UserRow 전체가 아니라 API 응답 매핑에 필요한 필드만 요구하도록 좁혀서, 이
// 타입을 받는 함수가 "세션 토큰 등 민감하거나 무관한 컬럼까지 몰라도 되게" 의존을 최소화한 것
// (poolError.ts의 Pick<Pool, "on">과 같은 최소 인터페이스 원칙을 타입 레벨에서 적용).
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

// [INTV:ARCH] 아래의 "...WithXxxRow" 타입들은 단일 테이블이 아니라 JOIN 쿼리 결과의 모양을
// 나타낸다 — 예를 들어 MatchWithHandlesRow는 matches 테이블 컬럼에 users 테이블을 조인해서 얻은
// 승자/패자의 handle까지 포함한다(rowMappers.ts의 toMatchSummary가 이 확장된 로우를 받는다 —
// JOIN 쿼리 결과의 모양을 별도 타입으로 명시해두면, 어떤 쿼리가 어떤 추가 컬럼을 전제하는지
// 코드에서 바로 드러난다).
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

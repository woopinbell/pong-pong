import type {
  AdminActionSummary,
  ChatMessage,
  FriendSummary,
  MatchSummary,
  PublicUser,
  SessionUser,
  TournamentMatchSummary,
  TournamentSummary
} from "@pong-pong/shared";
import type {
  AdminActionRow,
  ChatMessageWithSenderRow,
  FriendshipWithUserRow,
  MatchWithHandlesRow,
  TournamentMatchRow,
  TournamentWithCreatorRow,
  UserProjectionRow
} from "./schema.js";

// [INTV:ARCH] 이 파일 전체의 역할: schema.ts가 정의한 "DB 로우 모양(snake_case, DB 고유 타입)"을
// @pong-pong/shared가 정의한 "API가 실제로 내려주는 DTO 모양(camelCase, zod로 검증된 형태)"으로
// 변환한다. DB 스키마와 공개 API 응답 스키마를 분리해두고 이 매핑 함수들만 그 경계를 넘나들게
// 하면, 컬럼 이름이나 저장 방식이 바뀌어도 API 응답 계약은 이 파일 안에서만 손보면 된다(DB 마이그레이션이
// 곧바로 API 파괴적 변경으로 이어지지 않도록 막는 경계층).
export interface TournamentMatchRecordView {
  id: string;
  tournamentId: string;
  round: TournamentMatchRow["round"];
  slot: number;
  status: TournamentMatchRow["status"];
  leftUserId: string | null;
  rightUserId: string | null;
  winnerId: string | null;
}

export function toPublicUser(row: UserProjectionRow, online = false): PublicUser {
  return {
    id: row.id,
    handle: row.handle,
    displayName: row.display_name,
    avatarKey: row.avatar_key,
    role: row.role,
    status: row.status,
    // [INTV:TRAP] Number(...)/Boolean(...): pg 드라이버가 일부 숫자·불리언 계열 컬럼을 자바스크립트
    // 에서 정밀도가 안전하지 않을 수 있는 타입(예: BIGINT는 문자열, count(*) 결과도 문자열)으로
    // 반환하는 경우가 있어, 응답에 문자열이 그대로 새어나가지 않도록 명시적으로 형변환한다 — 이
    // 변환을 빼먹으면 publicUserSchema의 z.number() 검증이 런타임에 실패하거나, JSON 응답에 숫자
    // 대신 따옴표 붙은 문자열이 나가는 계약 위반이 생긴다.
    rating: Number(row.rating),
    wins: Number(row.wins),
    losses: Number(row.losses),
    online,
    isNpc: Boolean(row.is_npc)
  };
}

export function toSessionUser(row: UserProjectionRow, online = false): SessionUser {
  return { ...toPublicUser(row, online), email: row.email };
}

export function toMatchSummary(row: MatchWithHandlesRow, userId?: string): MatchSummary {
  // [INTV:TRAP] userId를 안 넘기면(예: userId 관점이 없는 조회) 편의상 "이겼다" 쪽 관점으로
  // 취급한다 — 승자 기준으로 opponentHandle/ratingDelta를 채우기 위한 기본값일 뿐, 실제 로그인한
  // 사용자의 승패를 판정하는 로직이 아니다. userId를 안 넘기는 호출부가 이 기본값의 의미를 오해하면
  // (예: "userId 없이도 이 유저의 실제 승패를 알 수 있다"고 착각) 잘못된 결과를 그대로 쓰게 된다.
  const won = userId ? row.winner_id === userId : true;
  return {
    id: row.id,
    mode: row.mode,
    // [INTV:EDGE] AI 상대는 users 테이블에 로우가 없을 수 있어 handle이 비어 있다 — 그 경우
    // "AI"라는 고정 라벨로 대신한다.
    opponentHandle: won ? row.loser_handle ?? "AI" : row.winner_handle ?? "AI",
    result: won ? "win" : "loss",
    scoreLeft: Number(row.score_left),
    scoreRight: Number(row.score_right),
    // [INTV:TRADE_OFF] rating_delta는 승자 기준으로만 DB에 저장되어 있다. 패자의 레이팅 하락폭은
    // 별도 컬럼 없이 고정값(-12)으로 계산한다 — 승/패 레이팅 변동폭을 비대칭 고정값으로 둔 설계
    // 판단(진짜 Elo 시스템처럼 양쪽 레이팅 차이에 비례한 변동을 계산하는 대신, 단순 고정값으로
    // 이 프로젝트 스코프에 맞게 단순화).
    ratingDelta: won ? Number(row.rating_delta) : -12,
    endedAt: row.ended_at.toISOString()
  };
}

export function toFriendSummary(row: FriendshipWithUserRow): FriendSummary {
  return {
    id: row.friendship_id,
    status: row.friendship_status,
    user: toPublicUser(row, true)
  };
}

// [INTV:ARCH] JOIN으로 가져온 "채팅 메시지 + 보낸 사람 정보"가 한 로우에 평평하게 섞여 있는
// 형태(ChatMessageWithSenderRow)를, toPublicUser가 기대하는 UserProjectionRow 모양으로 다시
// 조립해서 넘긴다 — 매퍼 함수를 재사용하기 위한 어댑팅(같은 변환 로직을 이 파일 여러 곳에서
// 복붙하는 대신, JOIN 결과를 표준 형태로 재구성해 기존 매퍼에 위임).
export function toChatMessage(row: ChatMessageWithSenderRow): ChatMessage {
  return {
    id: row.id,
    scope: row.scope,
    roomId: row.room_id,
    sender: toPublicUser({
      id: row.user_id,
      email: row.email,
      handle: row.handle,
      display_name: row.display_name,
      avatar_key: row.avatar_key,
      role: row.role,
      status: row.status,
      rating: row.rating,
      wins: row.wins,
      losses: row.losses,
      is_npc: row.is_npc
    }),
    body: row.body,
    createdAt: row.created_at.toISOString()
  };
}

export function toTournamentMatchRecord(row: TournamentMatchRow): TournamentMatchRecordView {
  return {
    id: row.id,
    tournamentId: row.tournament_id,
    round: row.round,
    slot: Number(row.slot),
    status: row.status,
    leftUserId: row.left_user_id,
    rightUserId: row.right_user_id,
    winnerId: row.winner_id
  };
}

// [INTV:TRADE_OFF] 토너먼트 대진표의 양 선수/우승자는 이 함수 호출 전에 별도로 조회되어 PublicUser로
// 전달된다 — 한 로우에 JOIN으로 다 끌어오는 대신 호출부에서 필요한 관련 엔티티를 준비해 넘기는
// 방식(두 번째 인자 users)을 택한 것. 왼쪽/오른쪽/우승자가 전부 null일 수 있는 선택적 관계라, 3중
// LEFT JOIN으로 한 번에 끌어오면 쿼리가 복잡해지고 재사용성이 떨어진다는 판단(N+1을 감수하고
// 별도 조회로 단순함을 얻는 트레이드오프).
export function toTournamentMatchSummary(
  row: TournamentMatchRow,
  users: { left: PublicUser | null; right: PublicUser | null; winner: PublicUser | null }
): TournamentMatchSummary {
  return {
    id: row.id,
    tournamentId: row.tournament_id,
    round: row.round,
    slot: Number(row.slot),
    status: row.status,
    left: users.left,
    right: users.right,
    winner: users.winner,
    scoreLeft: row.score_left == null ? null : Number(row.score_left),
    scoreRight: row.score_right == null ? null : Number(row.score_right),
    roomId: row.room_id,
    matchId: row.match_id
  };
}

export function toTournamentSummary(
  row: TournamentWithCreatorRow,
  related: {
    entries: PublicUser[];
    matches: TournamentMatchSummary[];
    winner: PublicUser | null;
  }
): TournamentSummary {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    createdBy: toPublicUser({
      id: row.creator_id,
      email: row.email,
      handle: row.handle,
      display_name: row.display_name,
      avatar_key: row.avatar_key,
      role: row.role,
      status: row.user_status,
      rating: row.rating,
      wins: row.wins,
      losses: row.losses,
      is_npc: row.is_npc
    }),
    playerCount: related.entries.length,
    capacity: Number(row.capacity),
    winner: related.winner,
    entries: related.entries,
    matches: related.matches
  };
}

export function toAdminActionSummary(
  row: AdminActionRow,
  users: { actor: PublicUser | null; target: PublicUser | null }
): AdminActionSummary {
  return {
    id: row.id,
    actor: users.actor,
    target: users.target,
    action: row.action,
    reason: row.reason,
    createdAt: row.created_at.toISOString()
  };
}

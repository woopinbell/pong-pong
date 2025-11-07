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
  const won = userId ? row.winner_id === userId : true;
  return {
    id: row.id,
    mode: row.mode,
    opponentHandle: won ? row.loser_handle ?? "AI" : row.winner_handle ?? "AI",
    result: won ? "win" : "loss",
    scoreLeft: Number(row.score_left),
    scoreRight: Number(row.score_right),
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

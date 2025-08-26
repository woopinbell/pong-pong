import type { ChatMessage, FriendSummary, MatchSummary, PublicUser, SessionUser, TournamentSummary } from "@pong-pong/shared";
import type { ChatMessageWithSenderRow, FriendshipWithUserRow, MatchWithHandlesRow, TournamentWithCreatorRow, UserProjectionRow } from "./schema";

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
    online
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
  return { id: row.friendship_id, status: row.friendship_status, user: toPublicUser(row, true) };
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
      losses: row.losses
    }),
    body: row.body,
    createdAt: row.created_at.toISOString()
  };
}

export function toTournamentSummary(row: TournamentWithCreatorRow, entries: PublicUser[]): TournamentSummary {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    createdBy: toPublicUser({ ...row, id: row.creator_id, status: row.user_status }),
    playerCount: entries.length,
    capacity: Number(row.capacity),
    winner: null,
    entries
  };
}

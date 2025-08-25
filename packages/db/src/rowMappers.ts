import type { MatchSummary, PublicUser, SessionUser } from "@pong-pong/shared";
import type { MatchWithHandlesRow, UserProjectionRow } from "./schema";

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

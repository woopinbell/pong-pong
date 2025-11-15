export type MatchmakingKind = "registered" | "guest";

export interface MatchmakingPlayer {
  userId: string;
  rating: number;
  kind: MatchmakingKind;
}

export interface MatchmakingPair {
  left: MatchmakingPlayer;
  right: MatchmakingPlayer;
  ratingDifference: number;
}

export type MatchmakerJoinResult =
  | { type: "queued"; queuedAtMs: number; aiFallbackAtMs: number }
  | { type: "matched"; match: MatchmakingPair }
  | { type: "duplicate"; status: MatchmakerPlayerStatus };

export type AiFallbackResult =
  | { type: "waiting"; remainingMs: number }
  | { type: "ready"; player: MatchmakingPlayer; waitedMs: number }
  | { type: "unavailable" };

export type MatchmakerPlayerStatus = "queued" | "matched";

export interface MatchmakerOptions {
  clock: () => number;
  maxRatingDifference: number;
}

interface QueueEntry {
  player: MatchmakingPlayer;
  queuedAtMs: number;
}

export const MATCHMAKER_AI_FALLBACK_MS = 6_000;

function validatePlayer(player: MatchmakingPlayer): void {
  if (player.userId.trim().length === 0) {
    throw new TypeError("userId must not be empty");
  }
  if (!Number.isSafeInteger(player.rating)) {
    throw new TypeError("rating must be a safe integer");
  }
  if (player.kind !== "registered" && player.kind !== "guest") {
    throw new TypeError("kind must be registered or guest");
  }
}

function copyPlayer(player: MatchmakingPlayer): MatchmakingPlayer {
  return { userId: player.userId, rating: player.rating, kind: player.kind };
}

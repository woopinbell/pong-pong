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

export class Matchmaker {
  private readonly queue: QueueEntry[] = [];
  private readonly playerStatuses = new Map<string, MatchmakerPlayerStatus>();
  private readonly clock: () => number;
  private readonly maxRatingDifference: number;

  constructor(options: MatchmakerOptions) {
    if (!Number.isFinite(options.maxRatingDifference) || options.maxRatingDifference < 0) {
      throw new RangeError("maxRatingDifference must be a non-negative finite number");
    }
    this.clock = options.clock;
    this.maxRatingDifference = options.maxRatingDifference;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  enqueue(player: MatchmakingPlayer): MatchmakerJoinResult {
    validatePlayer(player);
    const existingStatus = this.playerStatuses.get(player.userId);
    if (existingStatus) {
      return { type: "duplicate", status: existingStatus };
    }

    const entrant = copyPlayer(player);
    const opponentIndex = this.findClosestOpponent(entrant);
    if (opponentIndex >= 0) {
      const [opponent] = this.queue.splice(opponentIndex, 1);
      this.playerStatuses.set(opponent.player.userId, "matched");
      this.playerStatuses.set(entrant.userId, "matched");
      return {
        type: "matched",
        match: {
          left: copyPlayer(opponent.player),
          right: copyPlayer(entrant),
          ratingDifference: Math.abs(opponent.player.rating - entrant.rating)
        }
      };
    }

    const queuedAtMs = this.now();
    this.queue.push({ player: entrant, queuedAtMs });
    this.playerStatuses.set(entrant.userId, "queued");
    return {
      type: "queued",
      queuedAtMs,
      aiFallbackAtMs: queuedAtMs + MATCHMAKER_AI_FALLBACK_MS
    };
  }

  claimAiFallback(userId: string): AiFallbackResult {
    if (this.playerStatuses.get(userId) !== "queued") {
      return { type: "unavailable" };
    }

    const entryIndex = this.queue.findIndex((entry) => entry.player.userId === userId);
    if (entryIndex < 0) {
      this.playerStatuses.delete(userId);
      return { type: "unavailable" };
    }

    const entry = this.queue[entryIndex];
    const waitedMs = Math.max(0, this.now() - entry.queuedAtMs);
    if (waitedMs < MATCHMAKER_AI_FALLBACK_MS) {
      return { type: "waiting", remainingMs: MATCHMAKER_AI_FALLBACK_MS - waitedMs };
    }

    this.queue.splice(entryIndex, 1);
    this.playerStatuses.set(userId, "matched");
    return {
      type: "ready",
      player: copyPlayer(entry.player),
      waitedMs
    };
  }

  leaveQueue(userId: string): boolean {
    if (this.playerStatuses.get(userId) !== "queued") return false;
    const entryIndex = this.queue.findIndex((entry) => entry.player.userId === userId);
    if (entryIndex >= 0) this.queue.splice(entryIndex, 1);
    this.playerStatuses.delete(userId);
    return entryIndex >= 0;
  }

  release(userId: string): boolean {
    const status = this.playerStatuses.get(userId);
    if (!status) return false;
    if (status === "queued") {
      const entryIndex = this.queue.findIndex((entry) => entry.player.userId === userId);
      if (entryIndex >= 0) this.queue.splice(entryIndex, 1);
    }
    this.playerStatuses.delete(userId);
    return true;
  }

  queuedPlayers(): MatchmakingPlayer[] {
    return this.queue.map((entry) => copyPlayer(entry.player));
  }

  private findClosestOpponent(entrant: MatchmakingPlayer): number {
    let closestIndex = -1;
    let closestDifference = Number.POSITIVE_INFINITY;

    for (let index = 0; index < this.queue.length; index += 1) {
      const candidate = this.queue[index].player;
      if (candidate.kind !== entrant.kind) continue;
      const difference = Math.abs(candidate.rating - entrant.rating);
      if (difference > this.maxRatingDifference || difference >= closestDifference) continue;
      closestIndex = index;
      closestDifference = difference;
    }

    return closestIndex;
  }

  private now(): number {
    const nowMs = this.clock();
    if (!Number.isFinite(nowMs)) {
      throw new RangeError("clock must return a finite timestamp");
    }
    return nowMs;
  }
}

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

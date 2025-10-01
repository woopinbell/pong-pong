import type { PlayerSide } from "@pong-pong/shared";

export type RoomSessionState =
  | "waiting"
  | "playing"
  | "paused"
  | "reconnecting"
  | "finished";

export interface ReconnectExpiry {
  forfeitingSide: PlayerSide | null;
  winnerSide: PlayerSide | null;
}

const RECONNECT_WINDOW_MS = 15_000;

export class RoomSession {
  private currentState: RoomSessionState = "waiting";
  private resumeState: Exclude<RoomSessionState, "reconnecting" | "finished"> = "waiting";
  private readonly ready = new Set<PlayerSide>();
  private readonly disconnected = new Set<PlayerSide>();
  private reconnectDeadlineMs: number | null = null;

  get state(): RoomSessionState {
    return this.currentState;
  }

  get reconnectDeadline(): number | null {
    return this.reconnectDeadlineMs;
  }

  markReady(side: PlayerSide): RoomSessionState {
    if (this.currentState !== "waiting") return this.currentState;
    this.ready.add(side);
    if (this.ready.size === 2) this.currentState = "playing";
    return this.currentState;
  }

  pause(): RoomSessionState {
    if (this.currentState === "playing") this.currentState = "paused";
    return this.currentState;
  }

  resume(): RoomSessionState {
    if (this.currentState === "paused") this.currentState = "playing";
    return this.currentState;
  }

  disconnect(side: PlayerSide, nowMs: number): RoomSessionState {
    if (this.currentState === "finished") return this.currentState;
    if (this.currentState !== "reconnecting") {
      this.resumeState = this.currentState;
    }
    this.disconnected.add(side);
    this.reconnectDeadlineMs = nowMs + RECONNECT_WINDOW_MS;
    this.currentState = "reconnecting";
    return this.currentState;
  }

  reconnect(side: PlayerSide, nowMs: number): boolean {
    if (
      this.currentState !== "reconnecting" ||
      this.reconnectDeadlineMs === null ||
      nowMs > this.reconnectDeadlineMs ||
      !this.disconnected.has(side)
    ) {
      return false;
    }

    this.disconnected.delete(side);
    if (this.disconnected.size === 0) {
      this.currentState = this.resumeState;
      this.reconnectDeadlineMs = null;
    }
    return true;
  }

  expireReconnect(nowMs: number): ReconnectExpiry | null {
    if (
      this.currentState !== "reconnecting" ||
      this.reconnectDeadlineMs === null ||
      nowMs < this.reconnectDeadlineMs
    ) {
      return null;
    }

    const [firstDisconnected] = this.disconnected;
    const bothDisconnected = this.disconnected.size !== 1;
    const forfeitingSide = bothDisconnected ? null : firstDisconnected ?? null;
    this.finish();
    return {
      forfeitingSide,
      winnerSide: forfeitingSide ? opposite(forfeitingSide) : null
    };
  }

  finish(): RoomSessionState {
    this.currentState = "finished";
    this.disconnected.clear();
    this.reconnectDeadlineMs = null;
    return this.currentState;
  }
}

function opposite(side: PlayerSide): PlayerSide {
  return side === "left" ? "right" : "left";
}

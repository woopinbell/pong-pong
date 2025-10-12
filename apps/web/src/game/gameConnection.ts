import type { GameSnapshot } from "@pong-pong/shared";

export type GameConnectionStatus =
  | "idle"
  | "connecting"
  | "matching"
  | "waitingReady"
  | "playing"
  | "paused"
  | "reconnecting"
  | "finished"
  | "failed";

export type GameConnectionState = {
  status: GameConnectionStatus;
  roomId: string | null;
  opponent: string | null;
  snapshot: GameSnapshot | null;
  lastSnapshotSequence: number;
  notice: string;
  messages: string[];
};

export const initialGameConnectionState: GameConnectionState = {
  status: "idle",
  roomId: null,
  opponent: null,
  snapshot: null,
  lastSnapshotSequence: -1,
  notice: "대기 중",
  messages: []
};

export type GameConnectionAction =
  | { type: "connectStarted" }
  | { type: "socketOpened"; notice: string }
  | { type: "matched"; roomId: string; opponent: string }
  | { type: "snapshotReceived"; snapshot: GameSnapshot }
  | { type: "gameFinished"; result: { leftScore: number; rightScore: number } }
  | { type: "chatReceived"; message: string }
  | { type: "readySent" }
  | { type: "socketClosed" }
  | { type: "failed"; notice?: string };

export function gameConnectionReducer(
  state: GameConnectionState,
  _action: GameConnectionAction
): GameConnectionState {
  return state;
}

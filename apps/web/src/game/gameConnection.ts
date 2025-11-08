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
  | { type: "socketReopened" }
  | { type: "matched"; roomId: string; opponent: string }
  | { type: "snapshotReceived"; snapshot: GameSnapshot }
  | { type: "gameFinished"; result: { leftScore: number; rightScore: number } }
  | { type: "chatReceived"; message: string }
  | { type: "readySent" }
  | { type: "socketClosed" }
  | { type: "failed"; notice?: string };

export function gameConnectionReducer(
  state: GameConnectionState,
  action: GameConnectionAction
): GameConnectionState {
  switch (action.type) {
    case "connectStarted":
      return {
        ...initialGameConnectionState,
        status: "connecting",
        notice: "실시간 연결 준비 중"
      };
    case "socketOpened":
      return { ...state, status: "matching", notice: action.notice };
    case "socketReopened":
      return { ...state, status: "reconnecting", notice: "경기 상태 복구 중" };
    case "matched":
      return {
        ...state,
        status: "waitingReady",
        roomId: action.roomId,
        opponent: action.opponent,
        notice: `${action.opponent} 상대와 연결됨`
      };
    case "snapshotReceived": {
      if (action.snapshot.sequence <= state.lastSnapshotSequence) return state;
      const status = statusForSnapshot(action.snapshot);
      return {
        ...state,
        status,
        roomId: action.snapshot.roomId,
        snapshot: action.snapshot,
        lastSnapshotSequence: action.snapshot.sequence,
        notice: noticeForStatus(status)
      };
    }
    case "gameFinished":
      return {
        ...state,
        status: "finished",
        roomId: null,
        snapshot: state.snapshot
          ? { ...state.snapshot, state: { ...state.snapshot.state, phase: "finished" } }
          : null,
        notice: `경기 종료: ${action.result.leftScore} - ${action.result.rightScore}`
      };
    case "chatReceived":
      return { ...state, messages: [...state.messages.slice(-5), action.message] };
    case "readySent":
      return { ...state, notice: "준비 완료" };
    case "socketClosed":
      return state.roomId
        ? { ...state, status: "reconnecting", notice: "재연결 대기 중" }
        : { ...state, status: "failed", notice: "연결 종료" };
    case "failed":
      return { ...state, status: "failed", notice: action.notice ?? "연결을 확인해 주세요." };
  }
}

export function canStartNewMatch(state: GameConnectionState): boolean {
  return state.roomId === null && ["idle", "finished", "failed"].includes(state.status);
}

function statusForSnapshot(snapshot: GameSnapshot): GameConnectionStatus {
  switch (snapshot.state.phase) {
    case "playing":
      return "playing";
    case "paused":
      return "paused";
    case "finished":
      return "finished";
    case "waiting":
    case "countdown":
      return "waitingReady";
  }
}

function noticeForStatus(status: GameConnectionStatus): string {
  switch (status) {
    case "playing":
      return "경기 진행 중";
    case "paused":
      return "일시정지 중";
    case "finished":
      return "경기 종료";
    case "waitingReady":
      return "준비 대기 중";
    default:
      return "실시간 연결 중";
  }
}

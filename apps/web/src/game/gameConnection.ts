import type { GameSnapshot } from "@pong-pong/shared";

// [INTV:ARCH] 서버 쪽 GamePhase(waiting/countdown/playing/paused/finished)보다 더 세분화된,
// 클라이언트 UI 전용 상태 — "아직 서버에 연결도 안 한 상태(idle)", "연결/재접속 중" 같은 서버는
// 모르는 화면 단계까지 포함한다(서버 상태를 그대로 UI 상태로 재사용하지 않고 별도 타입으로 둔 것 —
// 두 개념이 우연히 일치하더라도, 클라이언트에만 필요한 상태가 늘어날 때 서버 프로토콜을 건드릴
// 필요가 없다).
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

// [INTV:ARCH] React의 useReducer가 기대하는 "액션" 타입 — 각 변형은 type 필드로 구분되는 태그드
// 유니온(zod의 discriminatedUnion과 같은 발상을, 여기서는 런타임 검증이 필요 없는 내부 상태라
// zod 없이 TypeScript 유니온만으로 구현한 것)이다. 아래 gameConnectionReducer의 switch가 이 모든
// type을 다루는지 TS가 정적으로 검사해준다(exhaustiveness check — 새 액션 타입을 추가했는데 switch
// 분기를 안 만들면, switch에 default가 없고 반환 타입이 있는 이 구조에서는 컴파일 에러가 난다).
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

// [INTV:ARCH] 리듀서: (이전 상태, 액션) → 새 상태를 돌려주는 순수 함수 — React의 useReducer가 이
// 함수로 상태 전이를 관리한다(useState 여러 개 대신, 서로 얽힌 필드가 많은 이 "경기 연결 상태"
// 전체를 한 군데서 일관되게 바꾼다 — status/roomId/snapshot이 useState 여러 개로 흩어져 있었다면,
// 소켓 이벤트 하나가 여러 필드를 동시에 갱신할 때 "일부만 갱신된 중간 상태"로 렌더링될 위험이 있다).
// pongSimulation.ts의 step()과 마찬가지로 순수 함수이므로, 같은 (state, action) 입력에 항상 같은
// 결과가 나오는 게 테스트를 쉽게 만든다(소켓/타이머 없이 이 함수만 단위 테스트 가능).
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
      // [INTV:EDGE] sequence는 서버(gameHub.ts의 broadcastSnapshot)가 보낼 때마다 증가시키는 값 —
      // 네트워크 재전송 등으로 이미 반영한 것보다 오래되거나 같은 스냅샷이 다시 오면 무시해서, 화면이
      // 과거 상태로 되돌아가는 걸 막는다(WS는 TCP 위에서 순서를 보장하지만, 재연결 직후 이전 연결의
      // 마지막 스냅샷과 새 연결의 첫 스냅샷이 뒤섞여 도착하는 경우까지 이 체크가 방어한다).
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

// [INTV:ARCH] 서버의 단순한 GamePhase를 이 화면 전용 GameConnectionStatus로 옮겨 담는다 —
// waiting/countdown 둘 다 "아직 시작 전"이라는 같은 UI 상태(waitingReady)로 합쳐서 보여준다(서버
// 상태 공간이 UI 상태 공간보다 더 세분화될 수 있다는 걸 보여주는 다대일 매핑 — 반대로 idle/connecting
// 같은 UI 전용 상태는 서버 쪽에 대응값이 아예 없다).
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

import type { PlayerSide } from "@pong-pong/shared";

// [INTV:ARCH] 방 하나의 생애주기를 나타내는 명시적 상태 기계: waiting(양쪽 준비 대기) →
// playing(진행 중) ↔ paused(일시정지), 그리고 누군가 접속이 끊기면 언제든 reconnecting(재접속
// 유예)으로 빠졌다가 복귀하거나, 결국 finished로 끝난다. 상태를 boolean 플래그 여러 개(isPlaying,
// isPaused, isReconnecting...)로 흩어 관리하지 않고 하나의 열거형 상태로 모은 이유는, 플래그
// 조합으로는 표현 불가능한 상태(예: paused이면서 동시에 reconnecting)가 애초에 타입 레벨에서
// 성립하지 않게 하기 위함.
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

// 접속이 끊긴 플레이어가 몰수패 처리되기 전 재접속할 수 있는 유예 시간 — 짧은 네트워크 끊김과 진짜 이탈을
// 구분해주기 위한 값.
const RECONNECT_WINDOW_MS = 15_000;

export class RoomSession {
  private currentState: RoomSessionState = "waiting";
  // [INTV:TRAP] Exclude<RoomSessionState, "reconnecting" | "finished">: RoomSessionState에서 두
  // 값을 뺀 나머지("waiting" | "playing" | "paused")로 타입을 좁힌다 — resumeState는 "재접속이
  // 끝나면 되돌아갈 상태"를 저장하는 용도라, 애초에 reconnecting이나 finished로 되돌아가는 일은
  // 있어선 안 되므로 그 자체를 타입으로 차단한다. 재구현 시 이 필드 타입을 그냥 RoomSessionState로
  // 잡으면, "reconnecting에서 reconnecting으로 되돌아가는" 논리적으로 말이 안 되는 상태 전이를
  // 컴파일러가 못 잡아준다.
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
    // [INTV:TRAP] 이미 reconnecting 상태(다른 쪽이 먼저 끊겼던 상황)라면 resumeState를 덮어쓰지
    // 않는다 — "재접속하면 돌아갈 상태"는 최초로 끊기기 직전의 상태여야 하므로, 두 번째 플레이어까지
    // 끊겼다고 해서 그 값을 갱신하면 안 된다(갱신하면 resumeState가 "reconnecting"으로 오염되는
    // 것과 사실상 같은 문제가 생긴다).
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

    // Set을 배열 구조분해로 받아 "그 안의 값 하나"를 꺼낸다(정확히 한 명만 끊겼을 때만 의미 있는 값이 된다).
    const [firstDisconnected] = this.disconnected;
    // [INTV:EDGE] disconnected.size가 1이 아니면(0이거나 2, 즉 아무도 안 끊겼거나 양쪽 다 끊긴 경우)
    // "몰수패시킬 명확한 한쪽"이 없다는 뜻이라 forfeitingSide를 null로 둔다 — 몰수패는 "정확히
    // 한쪽만" 유예 시간 안에 못 돌아왔을 때만 성립한다. 양쪽 다 안 돌아온 경우까지 무승부로 두지
    // 않으면(임의로 한쪽을 승자로 정하면), 실제로는 둘 다 끊긴 세션을 한쪽의 "승리"로 잘못 기록하는
    // Edge Case가 생긴다.
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

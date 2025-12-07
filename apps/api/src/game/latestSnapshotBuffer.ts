export const SOFT_BUFFERED_AMOUNT_BYTES = 256 * 1_024;
export const HARD_BUFFERED_AMOUNT_BYTES = 1_024 * 1_024;
export const MAX_CONGESTION_MS = 5_000;
const RETRY_INTERVAL_MS = 50;
const SOCKET_OPEN = 1;

// [INTV:ARCH] WS 소켓의 readyState/bufferedAmount는 브라우저·Node의 WebSocket API가 공통으로
// 제공하는 값이다. bufferedAmount는 send()로 넘겼지만 아직 실제 네트워크로 다 내보내지 못하고
// OS/라이브러리 버퍼에 쌓여있는 바이트 수 — 클라이언트가 느리거나(가정용 회선 등) 받는 속도가
// 서버가 보내는 속도를 못 따라가면 이 값이 커진다. 이 값을 관찰해 배압을 감지하는 게 이 클래스
// 전체 설계의 기반.
export type SnapshotSocket = {
  readyState: number;
  bufferedAmount: number;
  send: (payload: string, callback: (error?: Error) => void) => void;
  terminate: () => void;
};

type SnapshotBufferOptions = {
  now?: () => number;
  onDelivered?: (delayMs: number) => void;
  onDropped?: (reason: SnapshotDropReason) => void;
};

export type SnapshotDropReason = "replaced" | "connection_closed" | "congestion";

type PendingSnapshot = {
  payload: string;
  enqueuedAtMs: number;
};

// [INTV:ARCH] "최신값만 유지하는" 버퍼: 게임 스냅샷은 초당 TICK_RATE번 새로 나오는 값이라, 아직
// 못 보낸 이전 스냅샷이 있는 상태에서 새 스냅샷이 들어오면 이전 것은 이미 낡은 정보다 — 그래서
// 큐에 쌓지 않고 항상 "가장 최근 것 하나"로 덮어쓴다(enqueue에서 pendingSnapshot이 있으면
// onDropped("replaced")로 버려짐을 알리고 교체). 보통의 메시지 큐(모든 메시지를 순서대로 다
// 보내는, 예를 들어 채팅)와는 다른, 최신 상태만 의미 있는 실시간 스트리밍(게임 스냅샷, 커서 위치
// 등)에 맞춘 설계다 — 모든 메시지를 다 보내려는 큐였다면 클라이언트가 느릴 때 지연이 계속 누적되는
// "밀린 과거를 재생하는" 문제가 생긴다.
// - [FLOW] 1. enqueue: 대기 중인 이전 스냅샷 있으면 replaced로 드롭, 새 값으로 교체 -> 2. drain
//   호출 -> 3. drain: 소켓 상태/혼잡도 체크 -> 4. 문제 없으면 전송, 문제 있으면 재시도 예약 또는
//   연결 종료
export class LatestSnapshotBuffer {
  private readonly now: () => number;
  private readonly onDelivered: (delayMs: number) => void;
  private readonly onDropped: (reason: SnapshotDropReason) => void;
  private pendingSnapshot: PendingSnapshot | null = null;
  private congestionStartedAtMs: number | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(private readonly socket: SnapshotSocket, options: SnapshotBufferOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    this.onDelivered = options.onDelivered ?? (() => undefined);
    this.onDropped = options.onDropped ?? (() => undefined);
  }

  enqueue(payload: string): void {
    if (this.closed) return;
    if (this.pendingSnapshot) this.onDropped("replaced");
    this.pendingSnapshot = { payload, enqueuedAtMs: this.now() };
    this.drain();
  }

  close(reason: SnapshotDropReason = "connection_closed"): void {
    this.closed = true;
    if (this.pendingSnapshot) this.onDropped(reason);
    this.pendingSnapshot = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private drain(): void {
    if (this.closed) return;
    if (this.socket.readyState !== SOCKET_OPEN) {
      this.close();
      return;
    }

    const nowMs = this.now();
    // [INTV:EDGE] HARD 임계값을 이미 넘었다면 재시도할 것도 없이 바로 연결을 끊는다 — 이 정도로
    // 밀렸으면 클라이언트가 따라오지 못하고 있다는 뜻이라 계속 스냅샷을 만들어 보내봐야 의미가
    // 없다(오히려 서버 메모리/네트워크 버퍼만 계속 잡아먹는다 — 느린 클라이언트 하나가 서버 자원을
    // 무한정 소모하지 못하게 막는 배압(backpressure) 방어).
    if (this.socket.bufferedAmount >= HARD_BUFFERED_AMOUNT_BYTES) {
      this.terminate("congestion");
      return;
    }

    if (this.socket.bufferedAmount > SOFT_BUFFERED_AMOUNT_BYTES) {
      // [INTV:TRAP] ??=: congestionStartedAtMs가 아직 null일 때만 지금 시각을 대입한다("혼잡이
      // 시작된 시점"을 최초 한 번만 기록) — 이미 값이 있으면 건드리지 않아, 혼잡이 계속될수록 그
      // 지속 시간이 정확히 누적된다. 재구현 시 매번 nowMs로 덮어쓰면 "혼잡 시작 시점"이 매 drain
      // 호출마다 갱신돼 nowMs - congestionStartedAtMs가 항상 0에 가까운 값이 되어 타임아웃 자체가
      // 성립하지 않는다.
      this.congestionStartedAtMs ??= nowMs;
      if (nowMs - this.congestionStartedAtMs >= MAX_CONGESTION_MS) {
        this.terminate("congestion");
        return;
      }
      // [INTV:EDGE] SOFT는 넘었지만 아직 HARD는 아니고, 혼잡 지속시간도 한도 안이면 당장 끊지 않고
      // 잠시 후 다시 시도한다 — 일시적인 네트워크 버벅임을 곧바로 연결 종료로 이어지게 하지 않기
      // 위한 유예(SOFT/HARD 이중 임계값 + 지속시간, 3중 방어로 오탐/과잉 반응을 줄인다).
      this.armRetry();
      return;
    }

    this.congestionStartedAtMs = null;
    const snapshot = this.pendingSnapshot;
    if (snapshot === null) return;
    this.pendingSnapshot = null;
    try {
      // [INTV:PERF] send의 두 번째 인자(콜백)는 이 프레임이 실제로 전송(또는 실패)됐을 때 호출된다
      // — 그 시점과 enqueue된 시점의 차이를 재서 onDelivered로 "스냅샷이 큐에 들어와서 실제로
      // 나가기까지 걸린 지연"을 관측치로 남긴다(observability.ts에서 이 지연을 지표로 수집 —
      // 클라이언트 체감 지연을 서버 쪽에서 근사 측정하는 방법).
      this.socket.send(snapshot.payload, (error) => {
        if (error) {
          this.onDropped("connection_closed");
          this.terminate("connection_closed");
          return;
        }
        this.onDelivered(Math.max(0, this.now() - snapshot.enqueuedAtMs));
      });
    } catch {
      this.onDropped("connection_closed");
      this.terminate("connection_closed");
      return;
    }
  }

  private armRetry(): void {
    if (this.retryTimer || this.closed) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.drain();
    }, RETRY_INTERVAL_MS);
  }

  private terminate(reason: SnapshotDropReason): void {
    if (this.closed) return;
    this.close(reason);
    this.socket.terminate();
  }
}

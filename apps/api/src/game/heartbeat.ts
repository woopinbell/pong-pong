export const HEARTBEAT_PING_INTERVAL_MS = 15_000;
export const HEARTBEAT_TIMEOUT_MS = 45_000;

type HeartbeatTarget = {
  ping: () => void;
  terminate: () => void;
};

// [INTV:EDGE] WS 연결은 TCP 위에 있지만, 클라이언트의 네트워크가 갑자기 끊기거나(와이파이가 끊기는
// 등) 노트북 절전 모드에 들어가는 경우 "정상적으로 close 프레임을 못 받고도" 소켓이 계속 열려 있는
// 것처럼 보일 수 있다(TCP half-open 상태) — TCP 자체의 keepalive는 기본적으로 꺼져 있거나 간격이
// 너무 길어(수 시간) 게임처럼 빠른 감지가 필요한 용도엔 못 쓴다. 그래서 애플리케이션 레벨에서 서버가
// 주기적으로 ping을 보내고, 일정 시간 안에 응답(ack)이 없으면 그 연결을 죽은 것으로 간주해 강제로
// 끊는다 — WS 연결의 전형적인 하트비트(생존 확인) 패턴.
// - [FLOW] 1. start()에서 armTimeout(첫 타임아웃 예약) + ping 주기 타이머 시작 -> 2. 매 ping마다
//   전송(실패 시 즉시 terminate) -> 3. 클라이언트 응답이 오면 acknowledge()가 타임아웃을 리셋 ->
//   4. HEARTBEAT_TIMEOUT_MS 동안 acknowledge가 한 번도 안 오면 타임아웃 콜백이 terminate 실행
export class ConnectionHeartbeat {
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly target: HeartbeatTarget) {}

  start(): void {
    if (this.pingTimer || this.timeoutTimer) return;
    this.armTimeout();
    this.pingTimer = setInterval(() => {
      try {
        this.target.ping();
      } catch {
        this.terminate();
      }
    }, HEARTBEAT_PING_INTERVAL_MS);
  }

  // [INTV:EDGE] acknowledge(): 클라이언트로부터 어떤 형태로든 응답(pong 등)이 왔을 때 호출된다 —
  // "아직 살아있다"는 뜻이므로 타임아웃 타이머를 처음부터 다시 시작한다. HEARTBEAT_TIMEOUT_MS(45초)
  // 동안 이게 한 번도 안 불리면 연결이 끊긴 것으로 보고 정리한다. ping 주기(15초)보다 타임아웃
  // (45초)이 3배 가까이 긴 것은 ping 한두 번을 놓쳐도(네트워크 순간 버벅임) 바로 끊지 않고 여유를
  // 두기 위함이다 — 너무 타이트하면 정상 연결도 오탐으로 끊기고, 너무 느슨하면 죽은 연결을 오래
  // 붙들고 있어 자원을 낭비한다.
  acknowledge(): void {
    if (!this.pingTimer && !this.timeoutTimer) return;
    this.armTimeout();
  }

  stop(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    this.pingTimer = null;
    this.timeoutTimer = null;
  }

  private armTimeout(): void {
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    this.timeoutTimer = setTimeout(() => this.terminate(), HEARTBEAT_TIMEOUT_MS);
  }

  private terminate(): void {
    this.stop();
    this.target.terminate();
  }
}

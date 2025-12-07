import type { EventEmitter } from "node:events";

type ShutdownSignal = "SIGTERM" | "SIGINT";
// [INTV:ARCH] Pick<EventEmitter, "on" | "off">: 실제로 필요한 on/off 두 메서드만 요구하는 최소
// 인터페이스 — 테스트에서 진짜 process 객체 대신 이 둘만 흉내 낸 가짜 이벤트 소스를 넘길 수 있게
// 한다(poolError.ts의 Pick<Pool, "on">, gameHub.ts의 GameHubRepository와 같은 이유 — 이 프로젝트
// 전반에서 반복되는 "필요한 만큼만 요구하는 최소 인터페이스" 패턴).
type SignalSource = Pick<EventEmitter, "on" | "off">;

// [INTV:ARCH] SIGTERM/SIGINT: 프로세스를 "정상 종료해달라"는 유닉스 신호. SIGTERM은 보통 컨테이너
// 오케스트레이터가 재배포/스케일다운 시 보내고, SIGINT는 터미널에서 Ctrl+C를 눌렀을 때 온다. 이걸
// 무시하면 강제 종료(SIGKILL)까지 이어져 진행 중이던 게임/커넥션이 그대로 끊기므로, 신호를 받으면
// shutdown 콜백(gameHub.beginDrain 등 연결 정리)을 실행할 기회를 준다 — SIGKILL은 프로세스가 가로챌
// 수조차 없어서, 정상 종료 로직은 반드시 SIGTERM 안에서 끝내야 한다.
export function installGracefulShutdown(
  signals: SignalSource,
  shutdown: (signal: ShutdownSignal) => Promise<void>,
  onError: (error: unknown) => void
): () => void {
  // [INTV:TRAP] started: SIGTERM과 SIGINT가 동시에 오거나 같은 신호가 중복으로 와도 종료 절차를
  // 한 번만 시작하게 막는 가드 — 이게 없으면 shutdown 콜백(DB 연결 종료, 방 정리 등)이 중복
  // 실행되어 이미 닫힌 자원을 다시 닫으려다 예외가 나거나, drain 타이머가 여러 개 겹쳐 도는 문제가
  // 생긴다.
  let started = false;
  const start = (signal: ShutdownSignal) => {
    if (started) return;
    started = true;
    // [INTV:TRAP] void: 이 Promise를 의도적으로 기다리지 않고 던져둔다는 표시(신호 핸들러 자체는
    // async일 수 없으므로 여기서 await할 방법이 없다). 그냥 두면 실패 시 처리되지 않은 rejection이
    // 될 수 있어 .catch(onError)로 반드시 받아준다 — 이 catch를 빼먹으면 unhandledRejection으로
    // 프로세스가 예기치 않게 종료되거나 경고가 새어나간다.
    void shutdown(signal).catch(onError);
  };
  const onSigterm = () => start("SIGTERM");
  const onSigint = () => start("SIGINT");

  signals.on("SIGTERM", onSigterm);
  signals.on("SIGINT", onSigint);

  // [INTV:ARCH] 호출자가 이 등록을 되돌릴 수 있도록, 리스너를 해제하는 함수를 반환한다(테스트에서
  // process의 실제 리스너가 테스트마다 쌓이지 않게 정리할 때 특히 유용 — 안 그러면 테스트를 거듭할수록
  // "MaxListenersExceededWarning"이 뜨거나, 이전 테스트의 리스너가 다음 테스트의 신호까지 처리해버린다).
  return () => {
    signals.off("SIGTERM", onSigterm);
    signals.off("SIGINT", onSigint);
  };
}

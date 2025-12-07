import { FixedStepScheduler } from "./fixedStepScheduler.js";

type SharedRoomSchedulerOptions = {
  now?: () => number;
};

// [INTV:PERF] 게임 방(room)마다 각자 FixedStepScheduler(타이머)를 하나씩 두면, 동시에 진행 중인
// 매치 수만큼 setInterval 타이머가 늘어난다 — 타이머마다 이벤트 루프에 별도 콜백을 등록하는 오버헤드가
// 쌓이고, GC 압력도 늘어난다. 이 클래스는 그 대신 프로세스 전체에서 타이머 하나만 돌리고, 그 한 번의
// 틱마다 등록된 모든 방의 step 함수를 순서대로 실행한다(멀티플렉싱). 방이 하나도 없으면 타이머 자체를
// 멈춰서(stop) 불필요한 낭비를 없앤다.
// - [FLOW] 1. register(roomId, step)로 방 등록 + 스케줄러가 안 돌고 있으면 start() -> 2. 매 틱마다
//   stepRooms()가 등록된 모든 step을 순회 실행 -> 3. unregister로 방 제거, 마지막 방이 빠지면 stop()
export class SharedRoomScheduler {
  private readonly roomSteps = new Map<string, () => void>();
  private readonly scheduler: FixedStepScheduler;

  constructor(options: SharedRoomSchedulerOptions = {}) {
    this.scheduler = new FixedStepScheduler(() => this.stepRooms(), {
      now: options.now,
      timestepMs: 50,
      maxTicksPerLoop: 5,
      maxAccumulatedMs: 250
    });
  }

  get activeRooms(): number {
    return this.roomSteps.size;
  }

  register(roomId: string, step: () => void): void {
    this.roomSteps.set(roomId, step);
    this.scheduler.start();
  }

  unregister(roomId: string): void {
    this.roomSteps.delete(roomId);
    if (this.roomSteps.size === 0) this.scheduler.stop();
  }

  stop(): void {
    this.roomSteps.clear();
    this.scheduler.stop();
  }

  private stepRooms(): void {
    // [INTV:TRAP] Map을 직접 순회하는 대신 [...values()]로 배열 스냅샷을 떠서 돈다 — 만약 어떤
    // 방의 step()이 실행되는 도중 그 방이 끝나서 스스로 unregister되면(이 Map에서 항목이 지워지면),
    // 순회 중인 컬렉션을 직접 for...of로 돌 경우 "반복 중 컬렉션 변경"으로 다음 항목을 건너뛰거나
    // 순회 자체가 예측 불가능해질 수 있다 — 스냅샷 복사가 이 문제를 원천 차단한다.
    for (const step of [...this.roomSteps.values()]) step();
  }
}

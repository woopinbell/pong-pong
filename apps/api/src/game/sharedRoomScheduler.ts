import { FixedStepScheduler } from "./fixedStepScheduler.js";

type SharedRoomSchedulerOptions = {
  now?: () => number;
};

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
    for (const step of [...this.roomSteps.values()]) step();
  }
}

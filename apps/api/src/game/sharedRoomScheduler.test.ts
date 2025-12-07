import { afterEach, describe, expect, it, vi } from "vitest";
import { SharedRoomScheduler } from "./sharedRoomScheduler";

describe("SharedRoomScheduler", () => {
  afterEach(() => vi.useRealTimers());

  it("drives every active room from one fixed-step timer", () => {
    vi.useFakeTimers();
    let nowMs = 0;
    const firstStep = vi.fn();
    const secondStep = vi.fn();
    const scheduler = new SharedRoomScheduler({ now: () => nowMs });

    scheduler.register("room-1", firstStep);
    scheduler.register("room-2", secondStep);

    expect(scheduler.activeRooms).toBe(2);
    // vi.getTimerCount(): 가짜 타이머 환경에서 현재 대기 중인 타이머 개수를 알려준다 — 방이 두 개 등록됐어도
    // 타이머는 SharedRoomScheduler가 공유하는 단 하나뿐이라는 걸 직접 확인한다.
    expect(vi.getTimerCount()).toBe(1);

    nowMs = 50;
    vi.advanceTimersByTime(50);
    expect(firstStep).toHaveBeenCalledTimes(1);
    expect(secondStep).toHaveBeenCalledTimes(1);

    scheduler.unregister("room-1");
    nowMs = 100;
    vi.advanceTimersByTime(50);
    expect(firstStep).toHaveBeenCalledTimes(1);
    expect(secondStep).toHaveBeenCalledTimes(2);

    scheduler.unregister("room-2");
    expect(scheduler.activeRooms).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps later rooms running when a room unregisters during a tick", () => {
    vi.useFakeTimers();
    let nowMs = 0;
    const scheduler = new SharedRoomScheduler({ now: () => nowMs });
    const secondStep = vi.fn();

    scheduler.register("room-1", () => scheduler.unregister("room-1"));
    scheduler.register("room-2", secondStep);
    nowMs = 50;
    vi.advanceTimersByTime(50);

    // toHaveBeenCalledOnce(): toHaveBeenCalledTimes(1)의 축약형.
    expect(secondStep).toHaveBeenCalledOnce();
    expect(scheduler.activeRooms).toBe(1);
    scheduler.stop();
  });
});

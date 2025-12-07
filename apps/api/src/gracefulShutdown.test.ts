import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { installGracefulShutdown } from "./gracefulShutdown";

describe("graceful shutdown signals", () => {
  it("starts one shutdown for repeated SIGTERM and SIGINT signals", async () => {
    const signals = new EventEmitter();
    let finishShutdown: (() => void) | undefined;
    // shutdown이 즉시 끝나지 않고 "누군가 완료시켜줄 때까지" 멈춰 있는 상황을 재현하기 위해, resolve 함수를
    // 바깥 변수(finishShutdown)에 빼돌려둔다 — 테스트 코드가 원하는 타이밍에 나중에 직접 finishShutdown()을 불러
    // 이 프로미스를 완료시킬 수 있다.
    const shutdown = vi.fn(() => new Promise<void>((resolve) => {
      finishShutdown = resolve;
    }));
    const onError = vi.fn();
    const dispose = installGracefulShutdown(signals, shutdown, onError);

    signals.emit("SIGTERM", "SIGTERM");
    signals.emit("SIGINT", "SIGINT");
    signals.emit("SIGTERM", "SIGTERM");

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledWith("SIGTERM");
    finishShutdown?.();
    // await Promise.resolve(): 아무 값도 필요 없는, 마이크로태스크 큐가 한 바퀴 돌 때까지만 기다리는 관용구 —
    // 방금 finishShutdown()으로 끝낸 프로미스의 .catch(onError) 체인이 실제로 실행될 시간을 벌어준다.
    await Promise.resolve();
    expect(onError).not.toHaveBeenCalled();
    dispose();
  });

  it("reports shutdown failures without starting another run", async () => {
    const signals = new EventEmitter();
    const error = new Error("close failed");
    // mockRejectedValue(error): 이 모의 함수를 호출하면 항상 error로 reject되는 프로미스를 반환하도록 만드는
    // vitest 축약 API — new Promise((_, reject) => reject(error))를 매번 쓰는 대신 한 줄로 표현한다.
    const shutdown = vi.fn().mockRejectedValue(error);
    const onError = vi.fn();
    const dispose = installGracefulShutdown(signals, shutdown, onError);

    signals.emit("SIGTERM", "SIGTERM");
    await Promise.resolve();
    await Promise.resolve();

    expect(onError).toHaveBeenCalledWith(error);
    signals.emit("SIGINT", "SIGINT");
    expect(shutdown).toHaveBeenCalledTimes(1);
    dispose();
  });
});

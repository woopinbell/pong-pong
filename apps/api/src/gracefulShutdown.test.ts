import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { installGracefulShutdown } from "./gracefulShutdown";

describe("graceful shutdown signals", () => {
  it("starts one shutdown for repeated SIGTERM and SIGINT signals", async () => {
    const signals = new EventEmitter();
    let finishShutdown: (() => void) | undefined;
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
    await Promise.resolve();
    expect(onError).not.toHaveBeenCalled();
    dispose();
  });

  it("reports shutdown failures without starting another run", async () => {
    const signals = new EventEmitter();
    const error = new Error("close failed");
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

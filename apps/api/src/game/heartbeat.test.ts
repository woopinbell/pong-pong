import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionHeartbeat } from "./heartbeat";

describe("ConnectionHeartbeat", () => {
  afterEach(() => vi.useRealTimers());

  it("pings every fifteen seconds and terminates after 45 seconds without pong", () => {
    vi.useFakeTimers();
    const ping = vi.fn();
    const terminate = vi.fn();
    const heartbeat = new ConnectionHeartbeat({ ping, terminate });

    heartbeat.start();
    vi.advanceTimersByTime(30_000);
    expect(ping).toHaveBeenCalledTimes(2);
    expect(terminate).not.toHaveBeenCalled();

    vi.advanceTimersByTime(15_000);
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(ping).toHaveBeenCalledTimes(2);
  });

  it("moves the timeout deadline when a pong arrives", () => {
    vi.useFakeTimers();
    const ping = vi.fn();
    const terminate = vi.fn();
    const heartbeat = new ConnectionHeartbeat({ ping, terminate });

    heartbeat.start();
    vi.advanceTimersByTime(44_000);
    heartbeat.acknowledge();
    vi.advanceTimersByTime(44_999);
    expect(terminate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(terminate).toHaveBeenCalledTimes(1);
  });
});

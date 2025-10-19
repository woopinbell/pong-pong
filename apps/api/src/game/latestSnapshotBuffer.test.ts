import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HARD_BUFFERED_AMOUNT_BYTES,
  LatestSnapshotBuffer,
  SOFT_BUFFERED_AMOUNT_BYTES,
  type SnapshotSocket
} from "./latestSnapshotBuffer";

describe("LatestSnapshotBuffer", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps only the newest snapshot while a send is in flight", () => {
    const socket = fakeSocket();
    const buffer = new LatestSnapshotBuffer(socket);

    buffer.enqueue("snapshot-1");
    buffer.enqueue("snapshot-2");
    buffer.enqueue("snapshot-3");

    expect(socket.sent).toEqual(["snapshot-1"]);
    socket.completeSend();
    expect(socket.sent).toEqual(["snapshot-1", "snapshot-3"]);
    socket.completeSend();
    buffer.close();
  });

  it("replaces congested snapshots and sends the latest after pressure clears", () => {
    vi.useFakeTimers();
    const socket = fakeSocket();
    socket.bufferedAmount = SOFT_BUFFERED_AMOUNT_BYTES + 1;
    const buffer = new LatestSnapshotBuffer(socket);

    buffer.enqueue("snapshot-1");
    buffer.enqueue("snapshot-2");
    expect(socket.sent).toEqual([]);

    socket.bufferedAmount = 0;
    vi.advanceTimersByTime(50);
    expect(socket.sent).toEqual(["snapshot-2"]);
  });

  it("terminates immediately at one MiB of buffered data", () => {
    const socket = fakeSocket();
    socket.bufferedAmount = HARD_BUFFERED_AMOUNT_BYTES;
    const buffer = new LatestSnapshotBuffer(socket);

    buffer.enqueue("snapshot");

    expect(socket.terminate).toHaveBeenCalledTimes(1);
    expect(socket.sent).toEqual([]);
  });

  it("terminates after five seconds above the soft limit", () => {
    vi.useFakeTimers();
    let nowMs = 0;
    const socket = fakeSocket();
    socket.bufferedAmount = SOFT_BUFFERED_AMOUNT_BYTES + 1;
    const buffer = new LatestSnapshotBuffer(socket, { now: () => nowMs });

    buffer.enqueue("snapshot");
    nowMs = 4_999;
    vi.advanceTimersByTime(4_999);
    expect(socket.terminate).not.toHaveBeenCalled();

    nowMs = 5_000;
    vi.advanceTimersByTime(1);
    expect(socket.terminate).toHaveBeenCalledTimes(1);
  });
});

type FakeSnapshotSocket = SnapshotSocket & {
  sent: string[];
  completeSend: (error?: Error) => void;
  terminate: ReturnType<typeof vi.fn>;
};

function fakeSocket(): FakeSnapshotSocket {
  let completion: ((error?: Error) => void) | null = null;
  return {
    readyState: 1,
    bufferedAmount: 0,
    sent: [],
    send(payload, callback) {
      this.sent.push(payload);
      completion = callback;
    },
    completeSend(error) {
      const callback = completion;
      completion = null;
      callback?.(error);
    },
    terminate: vi.fn()
  };
}

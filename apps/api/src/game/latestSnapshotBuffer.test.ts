import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HARD_BUFFERED_AMOUNT_BYTES,
  LatestSnapshotBuffer,
  SOFT_BUFFERED_AMOUNT_BYTES,
  type SnapshotSocket
} from "./latestSnapshotBuffer";

describe("LatestSnapshotBuffer", () => {
  afterEach(() => vi.useRealTimers());

  it("does not treat delayed send callbacks as socket congestion", () => {
    const onDropped = vi.fn();
    const socket = fakeSocket();
    const buffer = new LatestSnapshotBuffer(socket, { onDropped });

    buffer.enqueue("snapshot-1");
    buffer.enqueue("snapshot-2");
    buffer.enqueue("snapshot-3");

    expect(socket.sent).toEqual(["snapshot-1", "snapshot-2", "snapshot-3"]);
    expect(onDropped).not.toHaveBeenCalled();
    socket.completeSend();
    socket.completeSend();
    socket.completeSend();
    buffer.close();
  });

  it("replaces congested snapshots and sends the latest after pressure clears", () => {
    vi.useFakeTimers();
    const socket = fakeSocket();
    const buffer = new LatestSnapshotBuffer(socket);

    buffer.enqueue("snapshot-1");
    socket.bufferedAmount = SOFT_BUFFERED_AMOUNT_BYTES + 1;
    buffer.enqueue("snapshot-2");
    buffer.enqueue("snapshot-3");
    expect(socket.sent).toEqual(["snapshot-1"]);

    socket.bufferedAmount = 0;
    vi.advanceTimersByTime(50);
    expect(socket.sent).toEqual(["snapshot-1", "snapshot-3"]);
  });

  it("reports replacement drops and delivery delay without connection identifiers", () => {
    vi.useFakeTimers();
    let nowMs = 100;
    const onDropped = vi.fn();
    const onDelivered = vi.fn();
    const socket = fakeSocket();
    socket.bufferedAmount = SOFT_BUFFERED_AMOUNT_BYTES + 1;
    const buffer = new LatestSnapshotBuffer(socket, {
      now: () => nowMs,
      onDropped,
      onDelivered
    });

    buffer.enqueue("snapshot-1");
    nowMs = 125;
    buffer.enqueue("snapshot-2");
    expect(onDropped).toHaveBeenCalledWith("replaced");

    socket.bufferedAmount = 0;
    nowMs = 175;
    vi.advanceTimersByTime(50);
    socket.completeSend();

    expect(onDelivered).toHaveBeenCalledWith(50);
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

// 진짜 소켓 대신, send()가 호출될 때마다 콜백을 completions 큐에 쌓아두기만 하고 즉시 실행하지 않는 가짜
// 구현이다 — 테스트가 completeSend()를 직접 호출하기 전까지는 "아직 네트워크로 실제 전송이 끝나지 않은" 상태를
// 원하는 타이밍에 재현할 수 있다(위 ws-ticket.test.ts의 deferred와 같은 목적, 다른 형태).
function fakeSocket(): FakeSnapshotSocket {
  const completions: Array<(error?: Error) => void> = [];
  return {
    readyState: 1,
    bufferedAmount: 0,
    sent: [],
    send(payload, callback) {
      this.sent.push(payload);
      completions.push(callback);
    },
    completeSend(error) {
      const callback = completions.shift();
      callback?.(error);
    },
    terminate: vi.fn()
  };
}

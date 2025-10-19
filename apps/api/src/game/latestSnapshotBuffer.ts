export const SOFT_BUFFERED_AMOUNT_BYTES = 256 * 1_024;
export const HARD_BUFFERED_AMOUNT_BYTES = 1_024 * 1_024;
export const MAX_CONGESTION_MS = 5_000;
const RETRY_INTERVAL_MS = 50;
const SOCKET_OPEN = 1;

export type SnapshotSocket = {
  readyState: number;
  bufferedAmount: number;
  send: (payload: string, callback: (error?: Error) => void) => void;
  terminate: () => void;
};

type SnapshotBufferOptions = {
  now?: () => number;
};

export class LatestSnapshotBuffer {
  private readonly now: () => number;
  private pendingSnapshot: string | null = null;
  private sending = false;
  private congestionStartedAtMs: number | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(private readonly socket: SnapshotSocket, options: SnapshotBufferOptions = {}) {
    this.now = options.now ?? (() => performance.now());
  }

  enqueue(payload: string): void {
    if (this.closed) return;
    this.pendingSnapshot = payload;
    this.drain();
  }

  close(): void {
    this.closed = true;
    this.pendingSnapshot = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private drain(): void {
    if (this.closed) return;
    if (this.socket.readyState !== SOCKET_OPEN) {
      this.close();
      return;
    }

    const nowMs = this.now();
    if (this.socket.bufferedAmount >= HARD_BUFFERED_AMOUNT_BYTES) {
      this.terminate();
      return;
    }

    if (this.socket.bufferedAmount > SOFT_BUFFERED_AMOUNT_BYTES) {
      this.congestionStartedAtMs ??= nowMs;
      if (nowMs - this.congestionStartedAtMs >= MAX_CONGESTION_MS) {
        this.terminate();
        return;
      }
      this.armRetry();
      return;
    }

    this.congestionStartedAtMs = null;
    if (this.sending) {
      this.armRetry();
      return;
    }

    const payload = this.pendingSnapshot;
    if (payload === null) return;
    this.pendingSnapshot = null;
    this.sending = true;
    try {
      this.socket.send(payload, (error) => {
        this.sending = false;
        if (error) {
          this.terminate();
          return;
        }
        this.drain();
      });
    } catch {
      this.sending = false;
      this.terminate();
      return;
    }
    if (this.sending || this.pendingSnapshot !== null) this.armRetry();
  }

  private armRetry(): void {
    if (this.retryTimer || this.closed) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.drain();
    }, RETRY_INTERVAL_MS);
  }

  private terminate(): void {
    if (this.closed) return;
    this.close();
    this.socket.terminate();
  }
}

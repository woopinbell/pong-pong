export const HEARTBEAT_PING_INTERVAL_MS = 15_000;
export const HEARTBEAT_TIMEOUT_MS = 45_000;

type HeartbeatTarget = {
  ping: () => void;
  terminate: () => void;
};

export class ConnectionHeartbeat {
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly target: HeartbeatTarget) {}

  start(): void {
    if (this.pingTimer || this.timeoutTimer) return;
    this.armTimeout();
    this.pingTimer = setInterval(() => {
      try {
        this.target.ping();
      } catch {
        this.terminate();
      }
    }, HEARTBEAT_PING_INTERVAL_MS);
  }

  acknowledge(): void {
    if (!this.pingTimer && !this.timeoutTimer) return;
    this.armTimeout();
  }

  stop(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    this.pingTimer = null;
    this.timeoutTimer = null;
  }

  private armTimeout(): void {
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    this.timeoutTimer = setTimeout(() => this.terminate(), HEARTBEAT_TIMEOUT_MS);
  }

  private terminate(): void {
    this.stop();
    this.target.terminate();
  }
}

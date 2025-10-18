export const DEFAULT_INPUT_RATE_PER_SECOND = 30;
export const DEFAULT_INPUT_BURST_CAPACITY = 8;

export type InputGateDecision = "accepted" | "stale" | "rate_limited";

export type InputGateCommand = {
  userId: string;
  roomId: string;
  inputSeq: number;
  nowMs: number;
};

type TokenBucket = {
  tokens: number;
  lastRefillMs: number;
};

export class InputGate {
  private readonly ratePerMillisecond: number;
  private readonly burstCapacity: number;
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly lastSequences = new Map<string, number>();

  constructor(options: { ratePerSecond?: number; burstCapacity?: number } = {}) {
    const ratePerSecond = options.ratePerSecond ?? DEFAULT_INPUT_RATE_PER_SECOND;
    const burstCapacity = options.burstCapacity ?? DEFAULT_INPUT_BURST_CAPACITY;
    if (!Number.isFinite(ratePerSecond) || ratePerSecond <= 0) {
      throw new RangeError("ratePerSecond must be positive");
    }
    if (!Number.isInteger(burstCapacity) || burstCapacity <= 0) {
      throw new RangeError("burstCapacity must be a positive integer");
    }
    this.ratePerMillisecond = ratePerSecond / 1_000;
    this.burstCapacity = burstCapacity;
  }

  check(command: InputGateCommand): InputGateDecision {
    const sequenceKey = `${command.userId}\u0000${command.roomId}`;
    const previousSequence = this.lastSequences.get(sequenceKey);
    if (previousSequence !== undefined && command.inputSeq <= previousSequence) {
      return "stale";
    }

    const bucket = this.refill(command.userId, command.nowMs);
    if (bucket.tokens < 1) {
      return "rate_limited";
    }

    bucket.tokens -= 1;
    this.lastSequences.set(sequenceKey, command.inputSeq);
    return "accepted";
  }

  releaseUser(userId: string): void {
    this.buckets.delete(userId);
    const prefix = `${userId}\u0000`;
    for (const key of this.lastSequences.keys()) {
      if (key.startsWith(prefix)) this.lastSequences.delete(key);
    }
  }

  private refill(userId: string, nowMs: number): TokenBucket {
    const existing = this.buckets.get(userId);
    if (!existing) {
      const bucket = { tokens: this.burstCapacity, lastRefillMs: nowMs };
      this.buckets.set(userId, bucket);
      return bucket;
    }

    if (nowMs > existing.lastRefillMs) {
      const elapsedMs = nowMs - existing.lastRefillMs;
      existing.tokens = Math.min(
        this.burstCapacity,
        existing.tokens + (elapsedMs * this.ratePerMillisecond)
      );
      existing.lastRefillMs = nowMs;
    }
    return existing;
  }
}

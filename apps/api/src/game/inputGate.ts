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

// [INTV:TRADE_OFF] "토큰 버킷" 속도 제한 알고리즘: 사용자마다 최대 burstCapacity개의 토큰이 담긴
// 양동이가 있고, 시간이 지나면서 ratePerSecond 속도로 토큰이 조금씩 다시 채워진다. 입력 하나를
// 처리할 때마다 토큰을 하나 소비하고, 토큰이 없으면 거부한다 — guestAccess.ts의 "롤링 윈도우"와
// 달리 순간적인 몰아치기(버스트)는 burstCapacity만큼 허용하면서도, 평균적으로는 ratePerSecond를
// 넘지 못하게 부드럽게 제한한다(게임 입력처럼 짧은 순간 여러 키를 누르는 게 정상적인 상황에 더
// 적합한 방식 — 고정 윈도우 카운터였다면 윈도우 경계에서 순간적으로 2배 버스트가 허용되는 문제가
// 있지만, 토큰 버킷은 그런 경계 효과가 없다).
// - [FLOW] 1. 시퀀스 번호로 낡은 입력 우선 거부 -> 2. refill로 경과 시간만큼 토큰 보충 -> 3. 토큰
//   1개 이상이면 소비하고 accepted, 없으면 rate_limited
// - [TRAP] 토큰을 "매 tick마다 setInterval로 채우는" 방식으로 재구현하면, 유저가 실제로 아무 요청도
//   안 보내는 동안에도 모든 유저에 대해 타이머가 계속 돌아 불필요한 CPU를 쓴다 — 이 구현처럼
//   "요청이 올 때마다 경과 시간을 계산해 그만큼만 보충"하는 지연 계산(lazy refill) 방식이 훨씬 낫다.
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
    // [INTV:TRAP] \u0000(널 문자)로 userId와 roomId를 이어붙여 하나의 Map 키로 쓴다 — 일반적인
    // userId/roomId에는 나타나지 않을 문자를 구분자로 써서, 예를 들어 userId="a", roomId="b:c"와
    // userId="a:b", roomId="c" 같은 서로 다른 조합이 우연히 같은 합성 키로 충돌하는 걸 막는다
    // (콜론 등 흔한 구분자를 쓰면 이런 충돌이 실제로 가능하다).
    const sequenceKey = `${command.userId}\u0000${command.roomId}`;
    const previousSequence = this.lastSequences.get(sequenceKey);
    // [INTV:EDGE] inputSeq는 클라이언트가 보내는 증가 카운터(ws.ts의 game.input 이벤트 참고) —
    // 네트워크 재전송/순서 뒤바뀜으로 과거 입력이 뒤늦게 도착하면, 이미 본 것보다 작거나 같은
    // 시퀀스는 "낡은(stale)" 입력으로 버린다. 최신성만 확인할 뿐 속도 제한과는 무관하므로 별도
    // 분기로 먼저 처리한다(토큰을 먼저 소비한 뒤 stale 판정을 했다면, 낡은 입력에도 토큰이
    // 낭비돼 정상 입력이 부당하게 rate_limited될 수 있다).
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
      // 마지막 충전 이후 흐른 시간(ms) × 초당 충전 속도만큼 토큰을 더해준다 — burstCapacity를
      // 넘지는 않는다(양동이 용량 상한).
      existing.tokens = Math.min(
        this.burstCapacity,
        existing.tokens + (elapsedMs * this.ratePerMillisecond)
      );
      existing.lastRefillMs = nowMs;
    }
    return existing;
  }
}

export type MatchmakingKind = "registered" | "guest";

export interface MatchmakingPlayer {
  userId: string;
  rating: number;
  kind: MatchmakingKind;
}

export interface MatchmakingPair {
  left: MatchmakingPlayer;
  right: MatchmakingPlayer;
  ratingDifference: number;
}

export type MatchmakerJoinResult =
  | { type: "queued"; queuedAtMs: number; aiFallbackAtMs: number }
  | { type: "matched"; match: MatchmakingPair }
  | { type: "duplicate"; status: MatchmakerPlayerStatus };

export type AiFallbackResult =
  | { type: "waiting"; remainingMs: number }
  | { type: "ready"; player: MatchmakingPlayer; waitedMs: number }
  | { type: "unavailable" };

export type MatchmakerPlayerStatus = "queued" | "matched";

export interface MatchmakerOptions {
  clock: () => number;
  maxRatingDifference: number;
}

interface QueueEntry {
  player: MatchmakingPlayer;
  queuedAtMs: number;
}

// 대기열에 사람 상대가 없을 때 AI로 대체 배정하기까지 기다리는 시간 — gameHub.ts가 이 값을 기준으로
// 타이머를 걸고, 만료되면 claimAiFallback()을 불러 실제로 AI 매칭으로 전환한다.
export const MATCHMAKER_AI_FALLBACK_MS = 6_000;

// [INTV:ARCH] gameHub.ts가 소켓/방 관리를 맡는 것과 별개로, "누구를 누구와 짝지을지"만 순수하게
// 담당하는 매치메이킹 엔진 — 소켓이나 DB를 전혀 모른 채 레이팅 숫자와 유저 id만 다룬다(단일 책임
// 분리). 그래서 gameHub.ts 없이도 이 클래스 하나만으로 매칭 알고리즘을 통째로 테스트할 수 있다
// (matchmaker.test.ts) — 네트워킹 코드를 mock하지 않고도 순수 로직만 빠르게 검증 가능.
// - [FLOW] 1. enqueue: 중복 참가 체크 -> 2. 대기열에서 조건(같은 kind, rating 차 이내, 최소 차)에
//   맞는 상대 탐색 -> 3. 있으면 즉시 매칭해 반환 -> 4. 없으면 큐에 넣고 "queued" 반환
export class Matchmaker {
  private readonly queue: QueueEntry[] = [];
  // playerStatuses: 유저별로 "지금 대기열에 있는지(queued)" 또는 "이미 짝지어졌는지(matched)"를 추적한다.
  // 이 맵이 있어야 같은 유저가 큐에 중복으로 들어오는 것도, 이미 매칭된 유저가 또 매칭되는 것도 막을 수 있다.
  private readonly playerStatuses = new Map<string, MatchmakerPlayerStatus>();
  private readonly clock: () => number;
  private readonly maxRatingDifference: number;

  constructor(options: MatchmakerOptions) {
    if (!Number.isFinite(options.maxRatingDifference) || options.maxRatingDifference < 0) {
      throw new RangeError("maxRatingDifference must be a non-negative finite number");
    }
    this.clock = options.clock;
    this.maxRatingDifference = options.maxRatingDifference;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  enqueue(player: MatchmakingPlayer): MatchmakerJoinResult {
    validatePlayer(player);
    const existingStatus = this.playerStatuses.get(player.userId);
    if (existingStatus) {
      return { type: "duplicate", status: existingStatus };
    }

    const entrant = copyPlayer(player);
    const opponentIndex = this.findClosestOpponent(entrant);
    if (opponentIndex >= 0) {
      const [opponent] = this.queue.splice(opponentIndex, 1);
      this.playerStatuses.set(opponent.player.userId, "matched");
      this.playerStatuses.set(entrant.userId, "matched");
      return {
        type: "matched",
        match: {
          left: copyPlayer(opponent.player),
          right: copyPlayer(entrant),
          ratingDifference: Math.abs(opponent.player.rating - entrant.rating)
        }
      };
    }

    const queuedAtMs = this.now();
    this.queue.push({ player: entrant, queuedAtMs });
    this.playerStatuses.set(entrant.userId, "queued");
    return {
      type: "queued",
      queuedAtMs,
      aiFallbackAtMs: queuedAtMs + MATCHMAKER_AI_FALLBACK_MS
    };
  }

  // [INTV:EDGE] gameHub.ts가 AI 대체 타이머를 걸어두고, 그 타이머가 만료됐을 때 "정말 지금 AI로
  // 넘겨도 되는지"를 여기에 다시 확인받는(claim) 방식이다 — 매치메이커 스스로 콜백을 쏘지 않고
  // 항상 호출자가 다시 물어보게 한 이유는, 그 사이(타이머가 걸려 있는 동안) 다른 사람이 큐에
  // 들어와서 먼저 매칭이 됐을 수도 있기 때문이다("스스로 상태를 밀어붙이는" 능동적 콜백 대신,
  // 상태를 다시 확인받는 수동적 claim 패턴이 타이밍 경합을 근본적으로 없앤다).
  // "waiting"이면(타이머가 아주 살짝 일찍 울렸거나 하는 경우) 남은 시간을 알려줘 다시 타이머를
  // 걸게 하고, "ready"면 그 자리에서 큐에서 빼고 "matched" 상태로 확정한다(같은 유저가 동시에
  // 두 번 AI 매칭되는 걸 방지).
  claimAiFallback(userId: string): AiFallbackResult {
    if (this.playerStatuses.get(userId) !== "queued") {
      return { type: "unavailable" };
    }

    const entryIndex = this.queue.findIndex((entry) => entry.player.userId === userId);
    if (entryIndex < 0) {
      this.playerStatuses.delete(userId);
      return { type: "unavailable" };
    }

    const entry = this.queue[entryIndex];
    const waitedMs = Math.max(0, this.now() - entry.queuedAtMs);
    if (waitedMs < MATCHMAKER_AI_FALLBACK_MS) {
      return { type: "waiting", remainingMs: MATCHMAKER_AI_FALLBACK_MS - waitedMs };
    }

    this.queue.splice(entryIndex, 1);
    this.playerStatuses.set(userId, "matched");
    return {
      type: "ready",
      player: copyPlayer(entry.player),
      waitedMs
    };
  }

  leaveQueue(userId: string): boolean {
    if (this.playerStatuses.get(userId) !== "queued") return false;
    const entryIndex = this.queue.findIndex((entry) => entry.player.userId === userId);
    if (entryIndex >= 0) this.queue.splice(entryIndex, 1);
    this.playerStatuses.delete(userId);
    return entryIndex >= 0;
  }

  // [INTV:EDGE] leaveQueue()는 "지금 대기열에 있는" 상태에서만 의미가 있지만, release()는 상태와
  // 무관하게 그 유저의 매치메이커 상태를 통째로 지운다 — 예를 들어 매칭까지는 됐는데(matched) 그
  // 직후 방 생성이 실패한 경우처럼, "matched" 상태를 도로 풀어줘서 그 유저가 다시 큐에 참가할 수
  // 있게 해야 할 때 gameHub.ts가 이걸 쓴다. leaveQueue만 있었다면 matched 상태의 유저를 롤백할
  // 방법이 없어 영구히 "매칭됐지만 아무 방에도 없는" 유령 상태에 갇혔을 것.
  release(userId: string): boolean {
    const status = this.playerStatuses.get(userId);
    if (!status) return false;
    if (status === "queued") {
      const entryIndex = this.queue.findIndex((entry) => entry.player.userId === userId);
      if (entryIndex >= 0) this.queue.splice(entryIndex, 1);
    }
    this.playerStatuses.delete(userId);
    return true;
  }

  queuedPlayers(): MatchmakingPlayer[] {
    return this.queue.map((entry) => copyPlayer(entry.player));
  }

  // [INTV:TRADE_OFF] 매칭 규칙의 핵심: 같은 kind(등록 계정끼리만, 게스트끼리만 — 절대 섞이지
  // 않는다)인 대기자 중에서 maxRatingDifference 이내이면서 레이팅 차이가 가장 작은 상대를 고른다.
  // 대기열이 커도 선형 탐색(O(n))으로 충분한 규모라고 보고, 레이팅으로 정렬된 트리/인덱스 같은
  // 구조 없이 단순하게 구현했다 — 동시 대기 인원이 수천 단위를 넘어가면 이 트레이드오프는 재검토
  // 대상이 된다.
  private findClosestOpponent(entrant: MatchmakingPlayer): number {
    let closestIndex = -1;
    let closestDifference = Number.POSITIVE_INFINITY;

    for (let index = 0; index < this.queue.length; index += 1) {
      const candidate = this.queue[index].player;
      if (candidate.kind !== entrant.kind) continue;
      const difference = Math.abs(candidate.rating - entrant.rating);
      if (difference > this.maxRatingDifference || difference >= closestDifference) continue;
      closestIndex = index;
      closestDifference = difference;
    }

    return closestIndex;
  }

  private now(): number {
    const nowMs = this.clock();
    if (!Number.isFinite(nowMs)) {
      throw new RangeError("clock must return a finite timestamp");
    }
    return nowMs;
  }
}

function validatePlayer(player: MatchmakingPlayer): void {
  if (player.userId.trim().length === 0) {
    throw new TypeError("userId must not be empty");
  }
  if (!Number.isSafeInteger(player.rating)) {
    throw new TypeError("rating must be a safe integer");
  }
  if (player.kind !== "registered" && player.kind !== "guest") {
    throw new TypeError("kind must be registered or guest");
  }
}

// [INTV:TRAP] 매치메이커 안팎으로 플레이어 객체가 오갈 때마다 얕은 복사본을 만든다 — 호출자가
// 반환받은 객체를 나중에 수정해도 매치메이커 내부 큐가 영향을 받지 않고, 반대로 매치메이커 내부
// 값도 외부에서 실수로 바뀌지 않도록 막는(캡슐화) 방어적 복사. 이 복사를 빼먹고 참조를 그대로
// 큐에 넣으면, 호출자가 우연히 같은 객체를 재사용/변경했을 때 대기열 안의 값이 조용히 오염된다.
function copyPlayer(player: MatchmakingPlayer): MatchmakingPlayer {
  return { userId: player.userId, rating: player.rating, kind: player.kind };
}

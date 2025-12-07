import { BALL_RADIUS, GAME_HEIGHT, GAME_WIDTH, PADDLE_HEIGHT } from "@pong-pong/shared";
import type { PaddleDirection, PongSimulationState } from "./pongSimulation.js";

interface AiProfile {
  reactionTicks: number;
  predictionNoise: number;
  mistakeBasisPoints: number;
  deadZone: number;
}

export interface PongAiSnapshot {
  randomState: number;
  targetY: number;
  nextReactionTick: number;
}

// [INTV:ARCH] xorshift32 알고리즘으로 구현한 의사난수 생성기. Math.random() 대신 이걸 쓰는
// 이유는 "시드(seed)"가 같으면 항상 같은 난수열이 나온다는 점 — AI의 움직임이 매번 달라지는 진짜
// 무작위가 아니라, 같은 seed로 리플레이하면 같은 판단을 재현할 수 있어야 하기 때문(재생/디버깅/
// 서버 재시작 시 상태 복원에 필요, pongSimulation.step의 결정론성과 같은 이유).
export class SeededIntegerPrng {
  private state: number;

  constructor(seed: number | string) {
    // [INTV:TRAP] >>> 0: 부호 없는 오른쪽 시프트를 0만큼 해서 실질적으로 값을 32비트 부호 없는
    // 정수로 강제 변환하는 JS 관용구 — number를 그냥 쓰면 배정밀도 부동소수점이라 비트 연산 결과가
    // 32비트 정수 범위를 벗어나거나 음수로 해석될 수 있는데, xorshift는 부호 없는 32비트 정수 연산을
    // 전제로 하므로 이 정규화가 빠지면 알고리즘이 깨진다.
    const normalized = typeof seed === "number" ? seed >>> 0 : hashSeed(seed);
    this.state = normalized === 0 ? 0x6d2b79f5 : normalized;
  }

  nextUint32(): number {
    // [INTV:ARCH] xor/shift를 세 번 섞는 것이 xorshift 알고리즘의 핵심 연산 — 적은 연산으로도
    // 통계적으로 꽤 괜찮은 분포의 난수를 빠르게 만들어낸다(암호학적으로 안전한 난수는 아니고, 게임
    // AI 용도로 충분한 수준 — crypto.randomBytes 같은 CSPRNG는 시드 재현성을 포기해야 해서 여기
    // 목적엔 맞지 않는다).
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state;
  }

  nextInt(maxExclusive: number): number {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0) {
      throw new RangeError("maxExclusive must be a positive safe integer");
    }
    return this.nextUint32() % maxExclusive;
  }

  // [INTV:ARCH] 현재 내부 상태값을 그대로 꺼낸다 — 이 값만 있으면 나중에 같은 지점부터 난수열을
  // 이어갈 수 있다(아래 PongAi.snapshot()이 AI 전체 상태를 저장/복원할 때 이 값을 함께 담는다).
  snapshot(): number {
    return this.state;
  }
}

export class PongAi {
  private readonly random: SeededIntegerPrng;
  private readonly profile: AiProfile;
  private targetY = GAME_HEIGHT / 2;
  private nextReactionTick = 0;

  constructor(seed: number | string, rating: number) {
    this.random = new SeededIntegerPrng(seed);
    this.profile = profileFor(rating);
  }

  nextDirection(state: Readonly<PongSimulationState>): PaddleDirection {
    if (state.phase !== "playing") return 0;

    // [INTV:ARCH] 매 틱마다 목표 지점을 다시 계산하지 않고, profile.reactionTicks만큼 틱이 지날
    // 때마다만 새로 판단한다 — 사람의 반응 속도 지연을 흉내 내는 장치. 그 사이에는 직전에 정한
    // targetY를 향해서만 움직인다(레이팅이 낮을수록 reactionTicks가 커서 반응이 굼뜨게 보인다).
    if (state.tick >= this.nextReactionTick) {
      // 공이 AI 쪽(오른쪽)으로 오고 있을 때만 예측하고, 반대로 가고 있으면(상대에게 가는 중) 아직 예측할
      // 근거가 없으니 일단 화면 중앙으로 자리를 잡아둔다.
      const targetBase = state.ball.velocity.x > 0
        ? predictedBallY(state)
        : GAME_HEIGHT / 2;
      const noise = this.random.nextInt(this.profile.predictionNoise * 2 + 1) - this.profile.predictionNoise;
      // [INTV:ARCH] mistakeBasisPoints: "1만분율" 단위(금융에서 쓰는 bp 표기를 빌려온 것 — 10,000
      // 중 몇을 차지하는지)로 "이번엔 크게 실수할" 확률을 표현한다. 예: 800이면 8%.
      const makesMistake = this.random.nextInt(10_000) < this.profile.mistakeBasisPoints;
      const mistakeOffset = makesMistake ? this.random.nextInt(221) - 110 : 0;
      this.targetY = clamp(
        targetBase + noise + mistakeOffset,
        16 + PADDLE_HEIGHT / 2,
        GAME_HEIGHT - 16 - PADDLE_HEIGHT / 2
      );
      this.nextReactionTick = state.tick + this.profile.reactionTicks;
    }

    // [INTV:TRAP] deadZone: 목표 지점과 패들 중심이 이 오차 범위 안이면 "이미 도착했다"고 보고
    // 정지한다 — 없으면 목표에 딱 맞추려다 매 틱마다 방향이 뒤집히며 좌우(상하)로 미세하게 떨리는
    // 움직임(jitter)이 생긴다. pongSimulation.ts의 approaching 체크와 비슷하게, "정확히 0으로
    // 수렴"을 기대하는 이산 시뮬레이션에서 반복적으로 마주치는 종류의 함정.
    const center = state.paddles.right.y + PADDLE_HEIGHT / 2;
    if (this.targetY > center + this.profile.deadZone) return 1;
    if (this.targetY < center - this.profile.deadZone) return -1;
    return 0;
  }

  // [INTV:ARCH] AI의 내부 상태(난수 생성기 상태 포함) 전체를 스냅샷으로 꺼낸다 — 재접속/서버 재시작
  // 등으로 AI 인스턴스를 새로 만들어야 할 때, 이 값으로 이전과 이어지는 판단을 재현하기 위함
  // (randomState 없이 targetY/nextReactionTick만 복원하면, 복원 이후의 난수열이 처음부터 다시
  // 시작돼 결정론이 깨진다).
  snapshot(): PongAiSnapshot {
    return {
      randomState: this.random.snapshot(),
      targetY: this.targetY,
      nextReactionTick: this.nextReactionTick
    };
  }
}

// [INTV:ARCH] 레이팅 구간별로 AI의 "실력"을 다르게 부여한다 — 반응 지연이 짧고, 예측 오차(노이즈)가
// 작고, 실수 확률이 낮고, 데드존이 좁을수록 더 정교하게 움직이는 강한 AI가 된다. 네 필드 모두
// "숫자가 클수록 못하는 방향"으로 통일해둔 이유가 여기 있다(reactionTicks/predictionNoise/
// mistakeBasisPoints/deadZone은 전부 "클수록 더 서투름"을 뜻함) — 값의 방향이 필드마다 뒤섞여
// 있었다면 이 함수의 네 분기가 훨씬 읽기 어려웠을 것.
function profileFor(rating: number): AiProfile {
  if (rating >= 1400) {
    return { reactionTicks: 3, predictionNoise: 20, mistakeBasisPoints: 400, deadZone: 10 };
  }
  if (rating >= 1300) {
    return { reactionTicks: 4, predictionNoise: 34, mistakeBasisPoints: 800, deadZone: 14 };
  }
  if (rating >= 1200) {
    return { reactionTicks: 6, predictionNoise: 54, mistakeBasisPoints: 1_200, deadZone: 18 };
  }
  return { reactionTicks: 8, predictionNoise: 78, mistakeBasisPoints: 1_800, deadZone: 24 };
}

// [INTV:ARCH] pongSimulation.ts의 reflectVerticalWall이 "한 틱씩" 물리를 진행하며 벽에 부딪힐
// 때마다 반사시키는 것과 달리, 여기서는 공이 AI 쪽 벽까지 도달하는 데 걸리는 시간을 한 번에
// 계산(직선 이동 가정)한 뒤, 그 사이 위/아래 벽에 몇 번이고 튕겼을지를 while 루프로 한꺼번에
// 접어 넣어(같은 "거울에 반사" 방식) 최종 y좌표를 예측한다 — 패들 반사는 고려하지 않는, 순전히
// 벽 반사만 반영한 단순 탄도 예측(매 틱 시뮬레이션을 반복하는 대신 닫힌 형태로 한 번에 계산해
// AI 판단 비용을 줄인다).
function predictedBallY(state: Readonly<PongSimulationState>): number {
  if (state.ball.velocity.x <= 0) return state.ball.position.y;
  const distance = GAME_WIDTH - 32 - state.ball.position.x;
  const ticks = distance / Math.max(1, state.ball.velocity.x);
  let y = state.ball.position.y + state.ball.velocity.y * ticks;
  const min = BALL_RADIUS;
  const max = GAME_HEIGHT - BALL_RADIUS;
  while (y < min || y > max) {
    if (y < min) y = min + (min - y);
    if (y > max) y = max - (y - max);
  }
  return y;
}

// FNV-1a 해시 알고리즘 — 문자열(예: 방 id)을 숫자 시드로 바꾸는 데 쓰는, 빠르고 잘 알려진 비암호학적 해시.
// 0x811c9dc5(오프셋 베이시스)와 0x01000193(소수)은 FNV-1a 표준에 정해진 상수값이다. Math.imul은 자바스크립트의
// 일반 곱셈이 부동소수점이라 큰 정수를 곱하면 정밀도가 깨지는 것을 피하기 위한, 32비트 정수 전용 곱셈 내장 함수.
function hashSeed(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

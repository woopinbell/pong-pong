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

export class SeededIntegerPrng {
  private state: number;

  constructor(seed: number | string) {
    const normalized = typeof seed === "number" ? seed >>> 0 : hashSeed(seed);
    this.state = normalized === 0 ? 0x6d2b79f5 : normalized;
  }

  nextUint32(): number {
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

    if (state.tick >= this.nextReactionTick) {
      const targetBase = state.ball.velocity.x > 0
        ? predictedBallY(state)
        : GAME_HEIGHT / 2;
      const noise = this.random.nextInt(this.profile.predictionNoise * 2 + 1) - this.profile.predictionNoise;
      const makesMistake = this.random.nextInt(10_000) < this.profile.mistakeBasisPoints;
      const mistakeOffset = makesMistake ? this.random.nextInt(221) - 110 : 0;
      this.targetY = clamp(
        targetBase + noise + mistakeOffset,
        16 + PADDLE_HEIGHT / 2,
        GAME_HEIGHT - 16 - PADDLE_HEIGHT / 2
      );
      this.nextReactionTick = state.tick + this.profile.reactionTicks;
    }

    const center = state.paddles.right.y + PADDLE_HEIGHT / 2;
    if (this.targetY > center + this.profile.deadZone) return 1;
    if (this.targetY < center - this.profile.deadZone) return -1;
    return 0;
  }

  snapshot(): PongAiSnapshot {
    return {
      randomState: this.random.snapshot(),
      targetY: this.targetY,
      nextReactionTick: this.nextReactionTick
    };
  }
}

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

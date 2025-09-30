import { BALL_RADIUS, GAME_HEIGHT, GAME_WIDTH, PADDLE_HEIGHT } from "@pong-pong/shared";
import type { PaddleDirection, PongSimulationState } from "./pongSimulation";

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

function hashSeed(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

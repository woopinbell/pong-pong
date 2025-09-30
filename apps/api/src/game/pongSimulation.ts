import {
  BALL_RADIUS,
  GAME_HEIGHT,
  GAME_WIDTH,
  PADDLE_HEIGHT,
  TICK_RATE,
  type BallState,
  type PlayerSide
} from "@pong-pong/shared";

export type PaddleDirection = -1 | 0 | 1;

export interface SimulationPaddleState {
  y: number;
  direction: PaddleDirection;
}

export interface PongSimulationState {
  tick: number;
  phase: "playing" | "finished";
  leftScore: number;
  rightScore: number;
  paddles: Record<PlayerSide, SimulationPaddleState>;
  ball: BallState;
  winnerSide: PlayerSide | null;
}

export interface PongSimulationInputs {
  left: PaddleDirection;
  right: PaddleDirection;
}

const INITIAL_BALL_VELOCITY = { x: 10, y: 5 } as const;
const FIXED_TIMESTEP_MS = 1000 / TICK_RATE;
const PADDLE_SPEED_PER_TICK = 13;
const ARENA_PADDING = 16;

export class PongSimulation {
  static initialState(): PongSimulationState {
    return {
      tick: 0,
      phase: "playing",
      leftScore: 0,
      rightScore: 0,
      paddles: {
        left: { y: GAME_HEIGHT / 2 - PADDLE_HEIGHT / 2, direction: 0 },
        right: { y: GAME_HEIGHT / 2 - PADDLE_HEIGHT / 2, direction: 0 }
      },
      ball: {
        position: { x: GAME_WIDTH / 2, y: GAME_HEIGHT / 2 },
        velocity: { ...INITIAL_BALL_VELOCITY }
      },
      winnerSide: null
    };
  }

  static step(
    state: Readonly<PongSimulationState>,
    inputs: Readonly<PongSimulationInputs>,
    deltaMs: number
  ): PongSimulationState {
    if (!Number.isFinite(deltaMs) || deltaMs <= 0) {
      throw new RangeError("deltaMs must be a positive finite number");
    }
    if (state.phase === "finished") return cloneState(state);

    const next = cloneState(state);
    const timestepScale = deltaMs / FIXED_TIMESTEP_MS;
    next.tick += 1;
    movePaddle(next, "left", inputs.left, timestepScale);
    movePaddle(next, "right", inputs.right, timestepScale);
    next.ball.position.x += next.ball.velocity.x * timestepScale;
    next.ball.position.y += next.ball.velocity.y * timestepScale;
    reflectVerticalWall(next.ball);
    return next;
  }
}

function cloneState(state: Readonly<PongSimulationState>): PongSimulationState {
  return {
    tick: state.tick,
    phase: state.phase,
    leftScore: state.leftScore,
    rightScore: state.rightScore,
    paddles: {
      left: { ...state.paddles.left },
      right: { ...state.paddles.right }
    },
    ball: {
      position: { ...state.ball.position },
      velocity: { ...state.ball.velocity }
    },
    winnerSide: state.winnerSide
  };
}

function movePaddle(
  state: PongSimulationState,
  side: PlayerSide,
  direction: PaddleDirection,
  timestepScale: number
): void {
  const paddle = state.paddles[side];
  paddle.direction = direction;
  paddle.y = clamp(
    paddle.y + direction * PADDLE_SPEED_PER_TICK * timestepScale,
    ARENA_PADDING,
    GAME_HEIGHT - PADDLE_HEIGHT - ARENA_PADDING
  );
}

function reflectVerticalWall(ball: BallState): void {
  const min = BALL_RADIUS;
  const max = GAME_HEIGHT - BALL_RADIUS;
  if (ball.position.y < min) {
    ball.position.y = min + (min - ball.position.y);
    ball.velocity.y = Math.abs(ball.velocity.y);
  } else if (ball.position.y > max) {
    ball.position.y = max - (ball.position.y - max);
    ball.velocity.y = -Math.abs(ball.velocity.y);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

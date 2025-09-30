import {
  BALL_RADIUS,
  GAME_HEIGHT,
  GAME_WIDTH,
  PADDLE_HEIGHT,
  PADDLE_WIDTH,
  TICK_RATE,
  WINNING_SCORE,
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

const FIXED_TIMESTEP_MS = 1000 / TICK_RATE;
const INITIAL_BALL_VELOCITY = { x: 10, y: 5 } as const;
const PADDLE_SPEED_PER_TICK = 13;
const BALL_ACCELERATION_PER_TICK = 0.015;
const MAX_BALL_SPEED = 18;
const MAX_MATCH_TICKS = TICK_RATE * 45;
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
    collidePaddle(next, "left", 32);
    collidePaddle(next, "right", GAME_WIDTH - 32);

    if (next.ball.position.x < 0) {
      next.rightScore += 1;
      resetBall(next, -1);
    } else if (next.ball.position.x > GAME_WIDTH) {
      next.leftScore += 1;
      resetBall(next, 1);
    }

    accelerateBall(next, timestepScale);
    if (
      next.leftScore >= WINNING_SCORE ||
      next.rightScore >= WINNING_SCORE ||
      next.tick >= MAX_MATCH_TICKS
    ) {
      next.phase = "finished";
      next.winnerSide = next.leftScore >= next.rightScore ? "left" : "right";
      next.paddles.left.direction = 0;
      next.paddles.right.direction = 0;
    }

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

function collidePaddle(state: PongSimulationState, side: PlayerSide, x: number): void {
  const paddle = state.paddles[side];
  const ball = state.ball;
  const withinY = ball.position.y >= paddle.y && ball.position.y <= paddle.y + PADDLE_HEIGHT;
  const halfPaddle = PADDLE_WIDTH / 2;
  const withinX = side === "left"
    ? ball.position.x - BALL_RADIUS <= x + halfPaddle
    : ball.position.x + BALL_RADIUS >= x - halfPaddle;
  const approaching = Math.sign(ball.velocity.x) === (side === "left" ? -1 : 1);
  if (!withinX || !withinY || !approaching) return;

  ball.velocity.x *= -1.04;
  const offset = (ball.position.y - (paddle.y + PADDLE_HEIGHT / 2)) / (PADDLE_HEIGHT / 2);
  ball.velocity.y = offset * 7;
}

function resetBall(state: PongSimulationState, xDirection: 1 | -1): void {
  state.ball.position = { x: GAME_WIDTH / 2, y: GAME_HEIGHT / 2 };
  const elapsedBoost = Math.min(1.35, 1 + state.tick / (TICK_RATE * 90));
  state.ball.velocity = {
    x: INITIAL_BALL_VELOCITY.x * elapsedBoost * xDirection,
    y: INITIAL_BALL_VELOCITY.y * elapsedBoost * (state.tick % 2 === 0 ? 1 : -1)
  };
}

function accelerateBall(state: PongSimulationState, timestepScale: number): void {
  const velocity = state.ball.velocity;
  const currentSpeed = Math.hypot(velocity.x, velocity.y);
  if (currentSpeed <= 0 || currentSpeed >= MAX_BALL_SPEED) return;

  const elapsedMinimum = Math.min(
    MAX_BALL_SPEED,
    Math.hypot(INITIAL_BALL_VELOCITY.x, INITIAL_BALL_VELOCITY.y) +
      state.tick * BALL_ACCELERATION_PER_TICK
  );
  const nextSpeed = Math.min(
    MAX_BALL_SPEED,
    Math.max(currentSpeed + BALL_ACCELERATION_PER_TICK * timestepScale, elapsedMinimum)
  );
  const scale = nextSpeed / currentSpeed;
  velocity.x *= scale;
  velocity.y *= scale;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

import {
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

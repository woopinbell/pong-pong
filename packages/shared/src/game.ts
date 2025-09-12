export const GAME_WIDTH = 960;
export const GAME_HEIGHT = 540;
export const PADDLE_WIDTH = 18;
export const PADDLE_HEIGHT = 112;
export const BALL_RADIUS = 10;
export const WINNING_SCORE = 3;
export const TICK_RATE = 20;

export type PlayerSide = "left" | "right";
export type GamePhase = "waiting" | "countdown" | "playing" | "paused" | "finished";

export interface Vec2 {
  x: number;
  y: number;
}

export interface PaddleState {
  y: number;
  dy: -1 | 0 | 1;
}

export interface BallState {
  position: Vec2;
  velocity: Vec2;
}

export interface PlayerSlot {
  id: string;
  handle: string;
  displayName: string;
  side: PlayerSide;
  ready: boolean;
  ai: boolean;
}

export interface GameSnapshot {
  roomId: string;
  phase: GamePhase;
  tick: number;
  leftScore: number;
  rightScore: number;
  paddles: Record<PlayerSide, PaddleState>;
  ball: BallState;
  players: PlayerSlot[];
  serverTime: string;
}

export interface GameFinished {
  roomId: string;
  matchId: string;
  winnerSide: PlayerSide;
  leftScore: number;
  rightScore: number;
  ratingDelta: number;
}

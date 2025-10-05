import { z } from "zod";

export const GAME_WIDTH = 960;
export const GAME_HEIGHT = 540;
export const PADDLE_WIDTH = 18;
export const PADDLE_HEIGHT = 112;
export const BALL_RADIUS = 10;
export const WINNING_SCORE = 3;
export const TICK_RATE = 20;

export const playerSideSchema = z.enum(["left", "right"]);
export const gamePhaseSchema = z.enum(["waiting", "countdown", "playing", "paused", "finished"]);

export const vec2Schema = z.object({
  x: z.number().finite(),
  y: z.number().finite()
}).strict();

export const paddleStateSchema = z.object({
  y: z.number().finite(),
  dy: z.union([z.literal(-1), z.literal(0), z.literal(1)])
}).strict();

export const ballStateSchema = z.object({
  position: vec2Schema,
  velocity: vec2Schema
}).strict();

export const playerSlotSchema = z.object({
  id: z.string().min(1),
  handle: z.string().min(1),
  displayName: z.string().min(1),
  side: playerSideSchema,
  ready: z.boolean(),
  ai: z.boolean()
}).strict();

export const gameStateSchema = z.object({
  phase: gamePhaseSchema,
  leftScore: z.number().int().nonnegative(),
  rightScore: z.number().int().nonnegative(),
  paddles: z.object({
    left: paddleStateSchema,
    right: paddleStateSchema
  }).strict(),
  ball: ballStateSchema,
  players: z.array(playerSlotSchema)
}).strict();

export const gameSnapshotSchema = z.object({
  roomId: z.string().min(1),
  tick: z.number().int().nonnegative(),
  sequence: z.number().int().nonnegative(),
  serverTimeMs: z.number().int().nonnegative(),
  state: gameStateSchema
}).strict();

const persistedGameFinishedSchema = z.object({
  roomId: z.string().min(1),
  matchId: z.string().min(1),
  persisted: z.literal(true),
  winnerSide: playerSideSchema,
  leftScore: z.number().int().nonnegative(),
  rightScore: z.number().int().nonnegative(),
  ratingDelta: z.number().finite()
}).strict();

const transientGameFinishedSchema = persistedGameFinishedSchema.extend({
  matchId: z.null(),
  persisted: z.literal(false),
  ratingDelta: z.literal(0)
}).strict();

export const gameFinishedSchema = z.discriminatedUnion("persisted", [
  persistedGameFinishedSchema,
  transientGameFinishedSchema
]);

export type PlayerSide = z.infer<typeof playerSideSchema>;
export type GamePhase = z.infer<typeof gamePhaseSchema>;
export type Vec2 = z.infer<typeof vec2Schema>;
export type PaddleState = z.infer<typeof paddleStateSchema>;
export type BallState = z.infer<typeof ballStateSchema>;
export type PlayerSlot = z.infer<typeof playerSlotSchema>;
export type GameState = z.infer<typeof gameStateSchema>;
export type GameSnapshot = z.infer<typeof gameSnapshotSchema>;
export type GameFinished = z.infer<typeof gameFinishedSchema>;

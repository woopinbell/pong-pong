import { z } from "zod";
import { chatMessageSchema } from "./http";
import { gameFinishedSchema, gameSnapshotSchema, playerSideSchema } from "./game";

const version = { v: z.literal(1) } as const;
const roomIdSchema = z.string().min(1);

export const clientEventSchema = z.discriminatedUnion("type", [
  z.object({
    ...version,
    type: z.literal("queue.join"),
    mode: z.enum(["queue", "ai"]).default("queue")
  }).strict(),
  z.object({ ...version, type: z.literal("queue.leave") }).strict(),
  z.object({ ...version, type: z.literal("tournament.join"), matchId: z.string().min(1) }).strict(),
  z.object({ ...version, type: z.literal("game.ready"), roomId: roomIdSchema }).strict(),
  z.object({ ...version, type: z.literal("game.pause"), roomId: roomIdSchema }).strict(),
  z.object({ ...version, type: z.literal("game.resume"), roomId: roomIdSchema }).strict(),
  z.object({
    ...version,
    type: z.literal("game.input"),
    roomId: roomIdSchema,
    inputSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    direction: z.union([z.literal(-1), z.literal(0), z.literal(1)])
  }).strict(),
  z.object({
    ...version,
    type: z.literal("chat.send"),
    scope: z.enum(["lobby", "match"]),
    roomId: z.string().nullable().optional(),
    body: z.string().trim().min(1).max(240)
  }).strict()
]);

export const wsErrorCodeSchema = z.enum([
  "invalid_event",
  "rate_limited",
  "forbidden",
  "not_found",
  "internal_error"
]);

export const serverEventSchema = z.discriminatedUnion("type", [
  z.object({
    ...version,
    type: z.literal("queue.matched"),
    roomId: roomIdSchema,
    side: playerSideSchema,
    opponent: z.string().min(1)
  }).strict(),
  z.object({ ...version, type: z.literal("game.snapshot"), snapshot: gameSnapshotSchema }).strict(),
  z.object({ ...version, type: z.literal("game.finished"), result: gameFinishedSchema }).strict(),
  z.object({ ...version, type: z.literal("chat.message"), message: chatMessageSchema }).strict(),
  z.object({
    ...version,
    type: z.literal("presence.changed"),
    online: z.number().int().nonnegative(),
    playing: z.number().int().nonnegative()
  }).strict(),
  z.object({
    ...version,
    type: z.literal("error"),
    code: wsErrorCodeSchema,
    message: z.string().min(1)
  }).strict()
]);

export type ClientEvent = z.infer<typeof clientEventSchema>;
export type WsErrorCode = z.infer<typeof wsErrorCodeSchema>;
export type ServerEvent = z.infer<typeof serverEventSchema>;

export function parseClientEvent(payload: string): ClientEvent {
  return clientEventSchema.parse(JSON.parse(payload));
}

export function parseServerEvent(payload: string): ServerEvent {
  return serverEventSchema.parse(JSON.parse(payload));
}

export function encodeServerEvent(event: ServerEvent): string {
  return JSON.stringify(serverEventSchema.parse(event));
}

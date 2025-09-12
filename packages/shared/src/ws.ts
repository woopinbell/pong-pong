import { z } from "zod";
import type { ChatMessage } from "./http";
import type { GameFinished, GameSnapshot, PlayerSide } from "./game";

export const clientEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("queue.join"),
    mode: z.enum(["queue", "ai"]).default("queue")
  }),
  z.object({ type: z.literal("queue.leave") }),
  z.object({ type: z.literal("game.ready"), roomId: z.string() }),
  z.object({ type: z.literal("game.pause"), roomId: z.string() }),
  z.object({ type: z.literal("game.resume"), roomId: z.string() }),
  z.object({
    type: z.literal("game.input"),
    roomId: z.string(),
    direction: z.union([z.literal(-1), z.literal(0), z.literal(1)])
  }),
  z.object({
    type: z.literal("chat.send"),
    scope: z.enum(["lobby", "match"]),
    roomId: z.string().nullable().optional(),
    body: z.string().trim().min(1).max(240)
  })
]);

export type ClientEvent = z.infer<typeof clientEventSchema>;

export type ServerEvent =
  | {
      type: "queue.matched";
      roomId: string;
      side: PlayerSide;
      opponent: string;
    }
  | {
      type: "game.snapshot";
      snapshot: GameSnapshot;
    }
  | {
      type: "game.finished";
      result: GameFinished;
    }
  | {
      type: "chat.message";
      message: ChatMessage;
    }
  | {
      type: "presence.changed";
      online: number;
      playing: number;
    }
  | {
      type: "error";
      message: string;
    };

export function parseClientEvent(payload: string): ClientEvent {
  return clientEventSchema.parse(JSON.parse(payload));
}

export function encodeServerEvent(event: ServerEvent): string {
  return JSON.stringify(event);
}

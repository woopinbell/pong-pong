import { createHash, randomBytes } from "node:crypto";

export const WS_TICKET_TTL_SECONDS = 30;

export function createRawWsTicket(): string {
  return randomBytes(32).toString("base64url");
}

export function hashWsTicket(ticket: string): string {
  return createHash("sha256").update(ticket, "utf8").digest("hex");
}

import type { ChatMessage } from "@pong-pong/shared";

export function isChatForActiveRoom(
  message: ChatMessage,
  activeRoomId: string | null
): boolean {
  return activeRoomId !== null
    && message.scope === "match"
    && message.roomId === activeRoomId;
}

import type { ChatMessage } from "@pong-pong/shared";

// [INTV:EDGE] 지금 보고 있는 경기방(activeRoomId)에 해당하는 매치 채팅(scope: "match")만 걸러낸다
// — gameHub.ts의 broadcastRoom은 그 방의 클라이언트에게만 보내지만, 재접속/방 전환 중 타이밍에
// 따라 다른 방의 메시지가 늦게 도착할 가능성까지 클라이언트 쪽에서 한 번 더 걸러 방어한다.
export function isChatForActiveRoom(
  message: ChatMessage,
  activeRoomId: string | null
): boolean {
  return activeRoomId !== null
    && message.scope === "match"
    && message.roomId === activeRoomId;
}

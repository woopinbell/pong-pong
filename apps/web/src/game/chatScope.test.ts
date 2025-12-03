import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@pong-pong/shared";
import { isChatForActiveRoom } from "./chatScope";

const activeRoomId = "11111111-1111-4111-8111-111111111111";
const otherRoomId = "22222222-2222-4222-8222-222222222222";

describe("isChatForActiveRoom", () => {
  it("accepts only match messages for the current room", () => {
    expect(isChatForActiveRoom(message("match", activeRoomId), activeRoomId)).toBe(true);
    expect(isChatForActiveRoom(message("match", otherRoomId), activeRoomId)).toBe(false);
    expect(isChatForActiveRoom(message("lobby", null), activeRoomId)).toBe(false);
    expect(isChatForActiveRoom(message("match", activeRoomId), null)).toBe(false);
  });
});

function message(scope: ChatMessage["scope"], roomId: string | null): ChatMessage {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    scope,
    roomId,
    sender: {
      id: "44444444-4444-4444-8444-444444444444",
      handle: "sender",
      displayName: "Sender",
      avatarKey: "default",
      role: "user",
      status: "active",
      rating: 1_200,
      wins: 0,
      losses: 0,
      online: true,
      isNpc: false
    },
    body: "hello",
    createdAt: "2026-08-13T00:00:00.000Z"
  };
}

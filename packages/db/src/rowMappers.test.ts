import { describe, expect, it } from "vitest";
import {
  toAdminActionSummary,
  toChatMessage,
  toFriendSummary,
  toMatchSummary,
  toPublicUser,
  toTournamentMatchRecord,
  toTournamentMatchSummary,
  toTournamentSummary
} from "./rowMappers";
import type {
  AdminActionRow,
  ChatMessageWithSenderRow,
  FriendshipWithUserRow,
  MatchWithHandlesRow,
  TournamentMatchRow,
  TournamentWithCreatorRow,
  UserRow
} from "./schema";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "00000000-0000-4000-8000-000000000002";
const MATCH_ID = "00000000-0000-4000-8000-000000000003";
const TOURNAMENT_ID = "00000000-0000-4000-8000-000000000004";
const CREATED_AT = new Date("2026-07-23T01:02:03.000Z");

const userRow: UserRow = {
  id: USER_ID,
  email: "player@example.com",
  handle: "typed-player",
  display_name: "타입 선수",
  avatar_key: "blue",
  role: "user",
  status: "active",
  rating: 1342,
  wins: 12,
  losses: 7,
  is_npc: false,
  created_at: CREATED_AT,
  banned_at: null
};

describe("database row mappers", () => {
  it("maps a database user row without leaking column names", () => {
    expect(toPublicUser(userRow, true)).toEqual({
      id: USER_ID,
      handle: "typed-player",
      displayName: "타입 선수",
      avatarKey: "blue",
      role: "user",
      status: "active",
      rating: 1342,
      wins: 12,
      losses: 7,
      online: true,
      isNpc: false
    });
  });

  it("maps joined match, friendship, and chat rows", () => {
    const match: MatchWithHandlesRow = {
      id: MATCH_ID,
      result_key: "room:typed:finished",
      mode: "queue",
      winner_id: OTHER_USER_ID,
      loser_id: USER_ID,
      score_left: 3,
      score_right: 1,
      rating_delta: 16,
      started_at: CREATED_AT,
      ended_at: CREATED_AT,
      winner_handle: "winner",
      loser_handle: "typed-player"
    };
    const friendship: FriendshipWithUserRow = {
      ...userRow,
      friendship_id: "00000000-0000-4000-8000-000000000005",
      friendship_status: "accepted"
    };
    const chat: ChatMessageWithSenderRow = {
      id: "00000000-0000-4000-8000-000000000006",
      scope: "lobby",
      room_id: null,
      sender_id: USER_ID,
      body: "타입이 확인된 메시지",
      created_at: CREATED_AT,
      user_id: USER_ID,
      email: userRow.email,
      handle: userRow.handle,
      display_name: userRow.display_name,
      avatar_key: userRow.avatar_key,
      role: userRow.role,
      status: userRow.status,
      rating: userRow.rating,
      wins: userRow.wins,
      losses: userRow.losses,
      is_npc: userRow.is_npc
    };

    expect(toMatchSummary(match, USER_ID)).toMatchObject({
      id: MATCH_ID,
      opponentHandle: "winner",
      result: "loss",
      ratingDelta: -12,
      endedAt: CREATED_AT.toISOString()
    });
    expect(toFriendSummary(friendship)).toMatchObject({
      id: friendship.friendship_id,
      status: "accepted",
      user: { id: USER_ID, online: true }
    });
    expect(toChatMessage(chat)).toMatchObject({
      id: chat.id,
      sender: { id: USER_ID },
      body: chat.body,
      createdAt: CREATED_AT.toISOString()
    });
  });

  it("maps tournament and admin rows with their related users", () => {
    const match: TournamentMatchRow = {
      id: MATCH_ID,
      tournament_id: TOURNAMENT_ID,
      round: "semifinal",
      slot: 1,
      status: "ready",
      left_user_id: USER_ID,
      right_user_id: OTHER_USER_ID,
      winner_id: null,
      room_id: null,
      match_id: null,
      score_left: null,
      score_right: null,
      created_at: CREATED_AT,
      updated_at: CREATED_AT
    };
    const creator: TournamentWithCreatorRow = {
      id: TOURNAMENT_ID,
      name: "타입 컵",
      status: "running",
      created_by: USER_ID,
      winner_id: null,
      capacity: 4,
      created_at: CREATED_AT,
      creator_id: USER_ID,
      email: userRow.email,
      handle: userRow.handle,
      display_name: userRow.display_name,
      avatar_key: userRow.avatar_key,
      role: userRow.role,
      user_status: userRow.status,
      rating: userRow.rating,
      wins: userRow.wins,
      losses: userRow.losses,
      is_npc: userRow.is_npc
    };
    const publicUser = toPublicUser(userRow);
    const matchSummary = toTournamentMatchSummary(match, {
      left: publicUser,
      right: null,
      winner: null
    });
    const adminAction: AdminActionRow = {
      id: "00000000-0000-4000-8000-000000000007",
      actor_id: USER_ID,
      target_user_id: OTHER_USER_ID,
      action: "ban",
      reason: "운영 정책 위반",
      created_at: CREATED_AT
    };

    expect(toTournamentMatchRecord(match)).toEqual({
      id: MATCH_ID,
      tournamentId: TOURNAMENT_ID,
      round: "semifinal",
      slot: 1,
      status: "ready",
      leftUserId: USER_ID,
      rightUserId: OTHER_USER_ID,
      winnerId: null
    });
    expect(toTournamentSummary(creator, {
      entries: [publicUser],
      matches: [matchSummary],
      winner: null
    })).toMatchObject({
      id: TOURNAMENT_ID,
      name: "타입 컵",
      createdBy: { id: USER_ID },
      playerCount: 1,
      capacity: 4
    });
    expect(toAdminActionSummary(adminAction, {
      actor: publicUser,
      target: null
    })).toMatchObject({
      action: "ban",
      actor: { id: USER_ID },
      target: null,
      createdAt: CREATED_AT.toISOString()
    });
  });
});

import { describe, expect, it } from "vitest";
import {
  apiErrorBodySchema,
  chatBodySchema,
  devLoginBodySchema,
  guestAuthResponseSchema,
  idParamsSchema,
  profileUpdateBodySchema,
  sessionUserSchema,
  wsHandshakeQuerySchema,
  wsTicketResponseSchema
} from "./http";

const user = {
  id: "018f4af4-3223-7a17-a0c1-2f4f2404d8ef",
  handle: "spin-doctor",
  displayName: "스핀닥터",
  avatarKey: "avatar-blue",
  role: "user",
  status: "active",
  rating: 1_200,
  wins: 0,
  losses: 0,
  online: false,
  isNpc: false,
  email: null
};

describe("HTTP contracts", () => {
  it("accepts the public session user shape", () => {
    expect(sessionUserSchema.parse(user)).toEqual(user);
  });

  it("rejects unknown login fields and invalid handles", () => {
    expect(() => devLoginBodySchema.parse({
      handle: "Admin User",
      displayName: "관리자",
      role: "admin"
    })).toThrow();
  });

  it("normalizes text input at the shared boundary", () => {
    expect(devLoginBodySchema.parse({ handle: "tester", displayName: "  테스터  " })).toEqual({
      handle: "tester",
      displayName: "테스터"
    });
    expect(chatBodySchema.parse({ body: "  안녕하세요  " })).toEqual({ body: "안녕하세요" });
  });

  it("requires UUID route identifiers", () => {
    expect(idParamsSchema.safeParse({ id: "not-an-id" }).success).toBe(false);
  });

  it("requires at least one profile change", () => {
    expect(profileUpdateBodySchema.safeParse({}).success).toBe(false);
    expect(profileUpdateBodySchema.parse({ displayName: "새 이름" })).toEqual({ displayName: "새 이름" });
  });

  it("keeps the API error envelope stable", () => {
    const body = {
      error: {
        code: "validation_error",
        message: "입력값을 확인해주세요.",
        requestId: "req-42",
        fieldErrors: { displayName: ["값을 입력해주세요."] }
      }
    };

    expect(apiErrorBodySchema.parse(body)).toEqual(body);
  });

  it("keeps websocket tickets short-lived and versioned", () => {
    const response = {
      ticket: "a".repeat(43),
      expiresInSeconds: 30,
      protocolVersion: 1
    } as const;

    expect(wsTicketResponseSchema.parse(response)).toEqual(response);
    expect(wsTicketResponseSchema.safeParse({ ...response, protocolVersion: 2 }).success).toBe(false);
  });

  it("keeps the guest session lifetime explicit", () => {
    const response = {
      user: { ...user, handle: "guest-018f4af4", displayName: "게스트 7050", online: true },
      guest: true,
      expiresInSeconds: 7_200
    } as const;

    expect(guestAuthResponseSchema.parse(response)).toEqual(response);
    expect(guestAuthResponseSchema.safeParse({ ...response, expiresInSeconds: 3_600 }).success).toBe(false);
  });

  it("accepts only a one-time ticket and protocol v1 in websocket query parameters", () => {
    const query = { ticket: "a".repeat(43), v: "1" } as const;

    expect(wsHandshakeQuerySchema.parse(query)).toEqual(query);
    expect(wsHandshakeQuerySchema.safeParse({ ...query, v: "2" }).success).toBe(false);
    expect(wsHandshakeQuerySchema.safeParse({ ...query, session: "long-session" }).success).toBe(false);
    expect(wsHandshakeQuerySchema.safeParse({ v: "1" }).success).toBe(false);
  });
});

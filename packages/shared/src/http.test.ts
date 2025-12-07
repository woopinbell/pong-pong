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

// describe/it/expect: vitest(테스트 러너)의 기본 3요소 — describe는 관련 테스트를 묶는 그룹, it은 개별 테스트 케이스,
// expect(...)는 단언(assertion). 여기서는 http.ts의 zod 스키마들이 실제로 의도한 대로 값을 걸러내는지 검증한다.
describe("HTTP contracts", () => {
  it("accepts the public session user shape", () => {
    expect(sessionUserSchema.parse(user)).toEqual(user);
  });

  it("rejects unknown login fields and invalid handles", () => {
    // .parse()는 검증 실패 시 예외를 던지므로, "실패해야 정상인" 케이스는 이렇게 화살표 함수로 감싸서
    // toThrow()로 예외 발생 자체를 단언한다.
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
    // .safeParse()는 .parse()와 달리 예외를 던지지 않고 { success, data | error } 형태의 결과 객체를 돌려준다 —
    // "실패가 예상되는 입력을 확인만 하고 싶을 때" throw/catch 없이 success 플래그만 보면 된다.
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
    // as const: 이 객체 리터럴의 각 필드를 string/number가 아니라 그 리터럴 값 자체의 타입으로 고정한다.
    // 아래에서 protocolVersion을 2로 바꾼 변형을 만들어 스키마가 거부하는지 보려면, 원본이 리터럴 타입이어야
    // "2"가 아니라 원래의 1이라는 리터럴과 대비가 명확해진다 (없어도 동작은 하지만 타입 의도를 분명히 하는 관용구).
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

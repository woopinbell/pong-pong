import { z } from "zod";
import { chatMessageSchema } from "./http.js";
import { gameFinishedSchema, gameSnapshotSchema, playerSideSchema } from "./game.js";

// [INTV:ARCH] WS 프로토콜 메시지에 항상 끼워 넣는 버전 태그. 스프레드(...version)로 각 메시지
// 스키마에 합쳐 넣어서 클라이언트/서버 버전이 어긋나면(v가 다르면) 파싱 단계에서 바로 걸러지게
// 한다 — 프로토콜에 호환되지 않는 변경이 생겼을 때, 잘못 해석된 필드로 조용히 오동작하는 대신
// 명시적인 파싱 실패로 드러나게 하는 버전 게이트(app.ts의 WS 핸드셰이크에서 query.v !== "1" 체크와
// 짝을 이룸).
const version = { v: z.literal(1) } as const;
const roomIdSchema = z.string().min(1);
const chatBodySchema = z.string().trim().min(1).max(240);

// [INTV:ARCH] z.discriminatedUnion("type", [...]): "type" 필드의 리터럴 값으로 어떤 메시지
// 모양인지 구분하는 태그드 유니온. WS로 오가는 메시지들은 하나의 소켓으로 여러 종류의 이벤트를
// 실어 나르기 때문에, 이런 "type 필드를 보고 분기"하는 방식이 사실상 이 프로토콜의 골격이다 —
// 아래 client/server 이벤트 스키마 전부 같은 패턴을 쓴다. gameHub.ts의 receive()에서
// event.type별 if 체인이 바로 이 판별 유니온을 소비하는 코드.
const gameplayClientEventSchema = z.discriminatedUnion("type", [
  z.object({
    ...version,
    type: z.literal("queue.join"),
    // .default(): 필드가 생략되면 이 값으로 채워 넣는다. mode를 안 보내면 일반 매칭 큐로 간주.
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
    // [INTV:EDGE] inputSeq: 이 입력이 몇 번째로 보낸 입력인지 나타내는 증가 카운터. 네트워크
    // 지연으로 입력이 순서가 뒤바뀌거나 중복 도착해도 서버가 최신 입력만 반영하도록 구분하는 용도
    // (서버 쪽 소비는 apps/api/src/game/inputGate.ts의 stale 판정 참고).
    inputSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    direction: z.union([z.literal(-1), z.literal(0), z.literal(1)])
  }).strict(),
]);

// [INTV:ARCH] 같은 type("chat.send")을 가진 메시지를 scope 필드로 한 번 더 나눈 것 — 로비
// 채팅(scope: "lobby")은 방이 없고, 매치 채팅(scope: "match")만 roomId가 필요하기 때문에
// discriminant를 "scope"로 잡아 두 모양을 분리했다(type 하나로는 두 모양의 필드 차이를 표현할 수
// 없어서, 같은 계층에서 두 단계로 판별 유니온을 중첩한 것).
const chatClientEventSchema = z.discriminatedUnion("scope", [
  z.object({
    ...version,
    type: z.literal("chat.send"),
    scope: z.literal("lobby"),
    body: chatBodySchema
  }).strict(),
  z.object({
    ...version,
    type: z.literal("chat.send"),
    scope: z.literal("match"),
    roomId: z.string().uuid(),
    body: chatBodySchema
  }).strict()
]);

// [INTV:TRAP] z.union (discriminatedUnion이 아니라 일반 union): 두 union을 하나로 합쳐야 하는데,
// 두 union이 서로 다른 필드("type" vs "scope")로 판별되기 때문에 discriminatedUnion 하나로는
// 합칠 수 없어 일반 union을 썼다 — discriminatedUnion에 판별자가 다른 스키마들을 억지로 넣으려
// 하면 zod가 타입/런타임 에러를 낸다. 판별 기준이 통일되지 않은 유니온을 합칠 땐 일반 union으로
// 물러나야 한다는 걸 놓치기 쉽다(성능은 discriminatedUnion보다 떨어지지만 — 판별자로 바로 분기 못
// 하고 각 스키마를 순서대로 다 시도해야 함 — 여기선 옵션 수가 적어 무시할 만한 차이).
export const clientEventSchema = z.union([
  gameplayClientEventSchema,
  chatClientEventSchema
]);

export const wsErrorCodeSchema = z.enum([
  "invalid_event",
  "rate_limited",
  "forbidden",
  "not_found",
  "server_draining",
  "internal_error"
]);

// [INTV:ARCH] 서버 → 클라이언트로 나가는 이벤트도 동일한 discriminatedUnion("type") 패턴.
// gameHub.ts의 VersionlessServerEvent 조건부 타입이 이 스키마의 v 필드를 벗겨내는 대응 코드.
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

// [INTV:ARCH] 소켓에서 들어온 원문 텍스트를 신뢰 가능한 타입으로 바꾸는 단일 관문(parse는 검증
// 실패 시 예외를 던진다). 이 함수를 거치지 않은 원시 JSON은 이후 로직에서 취급하지 않는다는 게
// 이 프로토콜 계층의 규칙 — gameHub.ts의 receive()가 이 함수를 try/catch로 감싸 파싱 실패를
// invalid_event 에러로 변환한다.
export function parseClientEvent(payload: string): ClientEvent {
  return clientEventSchema.parse(JSON.parse(payload));
}

export function parseServerEvent(payload: string): ServerEvent {
  return serverEventSchema.parse(JSON.parse(payload));
}

// [INTV:EDGE] 내보낼 때도 굳이 다시 .parse()로 검증하는 이유: 서버 코드가 실수로 스키마에 안 맞는
// 이벤트 객체를 조립해도 여기서 즉시 예외가 나서 걸러지도록 하기 위함(잘못된 페이로드가 그대로
// 네트워크로 나가는 걸 막는 방어적 장치 — httpBoundary.ts의 parseOutput과 동일한 "출력도 검증한다"
// 원칙을 WS 계층에도 적용).
export function encodeServerEvent(event: ServerEvent): string {
  return JSON.stringify(serverEventSchema.parse(event));
}

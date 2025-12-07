// [INTV:ARCH] FastifyRequest/FastifyReply: Fastify(이 서버가 쓰는 Node HTTP 프레임워크)의 요청/응답
// 객체 타입 — Express의 req/res에 대응한다. 이 파일은 "Fastify 라우트 핸들러"와 "@pong-pong/shared의
// zod 계약" 사이를 이어주는 경계 계층이다: 들어온 요청을 계약에 맞춰 검증하고, 나가는 응답 형식을
// 통일한다 — 프론트/백엔드가 @pong-pong/shared의 같은 zod 스키마를 공유하는 덕분에, 계약이 바뀌면
// 양쪽에서 타입 에러로 즉시 드러난다(단일 진실 공급원).
import type { FastifyReply, FastifyRequest } from "fastify";
import { apiErrorBodySchema, type ApiErrorBody } from "@pong-pong/shared";
import type { ZodType } from "zod";

// [INTV:ARCH] statusCode/code를 들고 다니는 커스텀 에러 클래스. 라우트 핸들러 안에서
// `throw new ApiHttpError(404, ...)`처럼 던지면, 아래 installHttpErrorBoundary의 에러 핸들러가
// 이 타입인지 확인해 적절한 HTTP 상태로 응답한다 — 핸들러 코드 자체는 reply.code()/reply.send()를
// 직접 호출할 필요 없이 그냥 던지기만 하면 되므로, 에러 응답 형식(코드/메시지/requestId)이 한
// 곳(installHttpErrorBoundary)에서만 결정된다.
export class ApiHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly fieldErrors?: Record<string, string[]>
  ) {
    super(message);
    this.name = "ApiHttpError";
  }
}

// [INTV:ARCH] 들어온 값(요청의 params/query/body 등)을 주어진 zod 스키마로 검증한다. 실패하면
// zod의 이슈 목록을 "필드 경로 → 메시지 배열" 형태로 재구성해서 ApiHttpError(400)로 던진다 —
// 클라이언트가 어떤 필드가 왜 잘못됐는지 바로 알 수 있는 형태로 통일하는 것(zod의 원본 에러 형태를
// 그대로 노출하지 않고, API 계약에 정의된 고정 에러 형태로 변환).
export function parseInput<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;

  const fieldErrors: Record<string, string[]> = {};
  for (const issue of result.error.issues) {
    const field = issue.path.join(".") || "request";
    (fieldErrors[field] ??= []).push(issue.message);
  }
  throw new ApiHttpError(
    400,
    "validation_error",
    "입력값을 확인해주세요.",
    Object.keys(fieldErrors).length > 0 ? fieldErrors : undefined
  );
}

// [INTV:ARCH] http.ts(shared)의 jsonHttpRequestContracts 항목 하나(params/query/body 세 스키마)를
// 받아, 실제 Fastify request에서 세 부분을 한 번에 검증해 꺼내준다 — 라우트 핸들러들이 매번 개별
// 검증을 반복하지 않게 하는 진입점.
export function parseHttpRequest<Params, Query, Body>(
  contract: {
    params: ZodType<Params>;
    query: ZodType<Query>;
    body: ZodType<Body>;
  },
  request: FastifyRequest
): { params: Params; query: Query; body: Body } {
  return {
    params: parseInput(contract.params, request.params ?? {}),
    query: parseInput(contract.query, request.query ?? {}),
    body: parseInput(contract.body, request.body ?? {})
  };
}

// [INTV:EDGE] 서버가 "내보내려는" 응답도 그 응답 스키마로 다시 검증한다 — 서버 로직에 버그가 있어
// 계약과 다른 모양을 내려보내려 하면, 클라이언트로 잘못된 응답이 나가기 전에 여기서 예외로 걸러낸다
// (방어적 이중 검증 — 보통은 입력만 검증하고 출력은 신뢰하지만, @pong-pong/shared의 zod 스키마가
// 프론트/백엔드 공용 계약이라 서버 쪽 실수도 같은 엄격도로 잡아내려는 설계).
export function parseOutput<T>(schema: ZodType<T>, output: unknown): T {
  const result = schema.safeParse(output);
  if (result.success) return result.data;

  throw new Error("HTTP response contract validation failed", { cause: result.error });
}

export function sendApiError(
  reply: FastifyReply,
  request: FastifyRequest,
  statusCode: number,
  code: string,
  message: string,
  fieldErrors?: Record<string, string[]>
): FastifyReply {
  const body: ApiErrorBody = {
    error: {
      code,
      message,
      requestId: String(request.id),
      ...(fieldErrors ? { fieldErrors } : {})
    }
  };

  return reply.code(statusCode).send(apiErrorBodySchema.parse(body));
}

// [INTV:ARCH] Fastify 애플리케이션 인스턴스에 "이런 경로가 없을 때"와 "핸들러 실행 중 예외가 났을
// 때"의 공통 처리를 등록한다 — gameHub.ts의 receive()가 WS 메시지 처리 실패를 중앙에서 한 곳에서
// 잡아주는 것과 같은 역할을 HTTP 쪽에서 담당.
export function installHttpErrorBoundary(app: import("fastify").FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    sendApiError(reply, request, 404, "not_found", "요청한 경로를 찾을 수 없습니다.");
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiHttpError) {
      sendApiError(reply, request, error.statusCode, error.code, error.message, error.fieldErrors);
      return;
    }

    // [INTV:EDGE] request.log: Fastify가 기본 내장한 로거(pino) 인스턴스 — 예상 못한 에러
    // (ApiHttpError가 아닌 것)는 클라이언트에겐 뭉뚱그린 500 메시지만 보여주고, 실제 원인은 서버
    // 로그에만 남긴다(스택 트레이스나 내부 에러 메시지를 클라이언트에 그대로 노출하면 시스템 내부
    // 구조에 대한 정보를 공격자에게 흘려주는 셈이 된다).
    request.log.error({ err: error }, "request failed");
    sendApiError(reply, request, 500, "internal_error", "요청을 처리하지 못했습니다.");
  });
}

// [INTV:TRAP] 아래 네 함수는 전부 반환 타입이 never다 — 호출하면 항상 예외를 던지고 정상적으로
// 리턴하지 않는다는 뜻으로, 라우트 핸들러 안에서 `if (!user) unauthorized();`처럼 짧게 가드절을
// 쓸 수 있게 해주는 헬퍼들이다. never 반환 타입을 명시하지 않으면, TypeScript는 이 호출 이후의
// 코드가 "user가 확실히 존재한다"고 좁혀주지 않아 그 아래에서 user를 쓸 때마다 불필요한 null
// 체크나 타입 단언이 필요해진다.
export function unauthorized(): never {
  throw new ApiHttpError(401, "authentication_required", "로그인이 필요합니다.");
}

export function suspended(): never {
  throw new ApiHttpError(403, "account_suspended", "정지된 계정은 이 작업을 수행할 수 없습니다.");
}

export function forbidden(): never {
  throw new ApiHttpError(403, "admin_required", "운영자 권한이 필요합니다.");
}

export function notFound(message: string): never {
  throw new ApiHttpError(404, "not_found", message);
}

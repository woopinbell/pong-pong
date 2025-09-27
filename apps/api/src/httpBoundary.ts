import type { FastifyReply, FastifyRequest } from "fastify";
import { apiErrorBodySchema, type ApiErrorBody } from "@pong-pong/shared";
import type { ZodType } from "zod";

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
    "validation_failed",
    "입력값을 확인해주세요.",
    Object.keys(fieldErrors).length > 0 ? fieldErrors : undefined
  );
}

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

export function installHttpErrorBoundary(app: import("fastify").FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    sendApiError(reply, request, 404, "not_found", "요청한 경로를 찾을 수 없습니다.");
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiHttpError) {
      sendApiError(reply, request, error.statusCode, error.code, error.message, error.fieldErrors);
      return;
    }

    request.log.error({ err: error }, "request failed");
    sendApiError(reply, request, 500, "internal_error", "요청을 처리하지 못했습니다.");
  });
}

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

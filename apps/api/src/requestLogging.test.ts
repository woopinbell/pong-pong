import { describe, expect, it } from "vitest";
import { createLoggerOptions, serializeRequestForLog } from "./requestLogging";

describe("request log redaction", () => {
  it("keeps the request path while removing the entire query string", () => {
    const serialized = serializeRequestForLog({
      method: "GET",
      url: "/ws?ticket=raw-ticket&v=1",
      host: "api.example.test",
      ip: "127.0.0.1",
      socket: { remotePort: 41000 }
    });

    expect(serialized).toEqual({
      method: "GET",
      url: "/ws",
      host: "api.example.test",
      remoteAddress: "127.0.0.1",
      remotePort: 41000
    });
    expect(JSON.stringify(serialized)).not.toContain("raw-ticket");
  });

  it("registers defensive redaction for authentication and ticket fields", () => {
    const options = createLoggerOptions("info");

    expect(options.redact.paths).toEqual(expect.arrayContaining([
      "req.headers.cookie",
      "req.headers.authorization",
      "request.headers.cookie",
      "request.headers.authorization",
      "req.query",
      "request.query",
      "query",
      "ticket",
      "*.ticket"
    ]));
    expect(options.redact.censor).toBe("[Redacted]");
  });

  it("redacts nested credentials while leaving correlation identifiers available", () => {
    const options = createLoggerOptions("info");

    expect(options.redact.paths).toEqual(expect.arrayContaining([
      "*.cookie",
      "*.authorization",
      "*.sessionToken",
      "*.ticket",
      "*.query"
    ]));
    // not.toEqual(expect.arrayContaining([...])): "이 값들을 포함하지 않는다"는 뜻 — requestId/userId처럼
    // 로그 상관관계 추적에 필요한 필드는 절대 redact 대상이 아니어야 한다는 걸 못박아두는 회귀 테스트.
    expect(options.redact.paths).not.toEqual(expect.arrayContaining([
      "requestId",
      "userId",
      "roomId",
      "matchId"
    ]));
  });
});

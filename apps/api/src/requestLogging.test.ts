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
    expect(options.redact.paths).not.toEqual(expect.arrayContaining([
      "requestId",
      "userId",
      "roomId",
      "matchId"
    ]));
  });
});

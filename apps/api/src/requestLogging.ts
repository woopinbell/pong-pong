type RequestForLog = {
  method: string;
  url: string;
  host: string;
  ip: string;
  socket: { remotePort?: number };
};

const REDACTED = "[Redacted]";

const REDACT_PATHS = [
  "req.headers.cookie",
  "req.headers.authorization",
  "request.headers.cookie",
  "request.headers.authorization",
  "req.query",
  "request.query",
  "query",
  "ticket",
  "*.ticket"
] as const;

export function createLoggerOptions(level: string) {
  return {
    level,
    redact: {
      paths: [...REDACT_PATHS],
      censor: REDACTED
    },
    serializers: {
      req: serializeRequestForLog
    }
  };
}

export function serializeRequestForLog(request: RequestForLog) {
  return {
    method: request.method,
    url: request.url.split("?", 1)[0] || "/",
    host: request.host,
    remoteAddress: request.ip,
    remotePort: request.socket.remotePort
  };
}

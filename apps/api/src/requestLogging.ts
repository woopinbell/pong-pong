type RequestForLog = {
  method: string;
  url: string;
  host: string;
  ip: string;
  socket: { remotePort?: number };
};

const REDACTED = "[Redacted]";

// [INTV:EDGE] Fastify의 기본 로거는 pino다. pino의 redact 옵션은 로그로 찍힐 객체에서 지정한
// 경로의 값을 실제로 지우고 censor 문자열로 바꿔치기해준다("*.cookie"처럼 와일드카드로 깊이 상관없이
// 매칭 가능) — 로그를 남기다가 세션 쿠키, Authorization 헤더, WS 티켓 같은 자격증명이 그대로 로그
// 파일에 새는 사고를 막기 위한 설정이다(로그 수집 시스템은 흔히 애플리케이션보다 접근 권한이
// 느슨해서, 여기서 새는 자격증명이 실제 침해 사고로 이어지는 경우가 드물지 않다).
const REDACT_PATHS = [
  "req.headers.cookie",
  "req.headers.authorization",
  "request.headers.cookie",
  "request.headers.authorization",
  "req.query",
  "request.query",
  "query",
  "ticket",
  "*.cookie",
  "*.authorization",
  "*.sessionToken",
  "*.query",
  "*.ticket"
] as const;

export function createLoggerOptions(level: string) {
  return {
    level,
    redact: {
      paths: [...REDACT_PATHS],
      censor: REDACTED
    },
    // [INTV:EDGE] serializers.req: pino가 로그 객체 안의 req 필드를 실제로 찍기 전에 거치는 변환
    // 함수 — Fastify의 요청 객체를 통째로 직렬화하면 너무 크고 민감한 정보도 섞이므로, 필요한
    // 필드만 골라 남긴다(redact가 "블랙리스트"로 특정 경로를 지우는 방식이라면, 이 커스텀
    // serializer는 "화이트리스트"로 남길 필드를 직접 고르는 방식 — 이중 방어).
    serializers: {
      req: serializeRequestForLog
    }
  };
}

export function serializeRequestForLog(request: RequestForLog) {
  return {
    method: request.method,
    // [INTV:EDGE] URL의 쿼리스트링(? 뒤)을 잘라낸다 — WS 티켓 등 민감한 값이 쿼리 파라미터로
    // 실려오는 경우가 있어(wsHandshakeQuerySchema 참고) 위의 redact 설정과 별개로 URL 자체에서도
    // 아예 빼버리는 이중 방어(redact 경로 설정에 오타가 나거나 빠진 경로가 있어도 이 잘라내기가
    // 최후의 보루가 된다).
    url: request.url.split("?", 1)[0] || "/",
    host: request.host,
    remoteAddress: request.ip,
    remotePort: request.socket.remotePort
  };
}

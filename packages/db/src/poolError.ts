import type { Pool } from "pg";

export interface PostgresPoolErrorEvent {
  kind: "idle_client_error";
  errorName: string;
  errorCode: string | null;
}

export type PostgresPoolErrorReporter = (event: PostgresPoolErrorEvent) => void;

const FALLBACK_EVENT: PostgresPoolErrorEvent = {
  kind: "idle_client_error",
  errorName: "UnknownError",
  errorCode: null
};

// [INTV:EDGE] pg의 Pool은 Node EventEmitter다. 풀에서 "쉬고 있는(idle)" 커넥션이 네트워크 문제
// 등으로 끊어지면 풀이 "error" 이벤트를 쏜다 — 이걸 아무도 리스닝하지 않으면 Node는 처리되지 않은
// EventEmitter 에러를 예외로 던져 프로세스 전체가 죽는다(unhandled 'error' event는 EventEmitter의
// 특별 규칙: 리스너가 없으면 던져진 에러가 그대로 throw된다). 이 함수는 그 "error" 이벤트를 항상
// 리스닝해서, DB 커넥션 하나가 잠깐 끊긴 것 때문에 API 서버 전체가 다운되는 사고를 막는다.
export function installPostgresPoolErrorHandler(
  // [INTV:ARCH] Pick<Pool, "on">: 진짜 pg Pool 전체가 아니라 on 메서드만 있으면 되도록 타입을
  // 최소화했다 — 테스트에서 실제 Pool을 만들지 않고 on 메서드만 흉내 낸 가짜 객체를 넘길 수 있게
  // 하기 위함(이 코드베이스 전반에 반복되는 최소 인터페이스 패턴 — gameHub.ts의 GameHubRepository,
  // gracefulShutdown.ts의 SignalSource 참고).
  pool: Pick<Pool, "on">,
  onPoolError?: PostgresPoolErrorReporter
): void {
  pool.on("error", (error) => {
    let event = FALLBACK_EVENT;
    try {
      event = toSafePoolErrorEvent(error);
    } catch {
      // [INTV:EDGE] 잘못된 형태의 에러 객체(toSafePoolErrorEvent가 못 다루는 모양)라도 이 pool의
      // EventEmitter 경계를 벗어나 예외로 새어나가서는 안 된다 — 여기서 잡지 않으면 "idle client
      // 에러 처리 로직 자체의 버그"가 다시 처리되지 않은 EventEmitter 에러가 되어 프로세스를 죽인다.
    }

    try {
      onPoolError?.(event);
    } catch {
      // [INTV:EDGE] 리포팅(로깅/메트릭 콜백)은 best-effort다 — 콜백 자체가 실패해도 "idle client
      // 하나 끊긴 것"이 프로세스 크래시로 번지면 안 된다는 이 함수 전체의 목적과 같은 원칙.
    }
  });
}

function toSafePoolErrorEvent(error: Error): PostgresPoolErrorEvent {
  const errorName = safeLabel(error.name, "UnknownError");
  const errorCode = safeLabel(readErrorCode(error), null);
  return {
    kind: "idle_client_error",
    errorName,
    errorCode
  };
}

function readErrorCode(error: Error): unknown {
  // [INTV:TRAP] "code" in error: Error 타입 자체에는 code 필드가 없지만, pg 드라이버가 던지는
  // 실제 에러 객체엔 Postgres 에러 코드가 code 속성으로 실려 있는 경우가 많다 — 있으면 읽고,
  // 없으면 undefined. error.code로 바로 접근하면 TypeScript가 Error 타입에 그 프로퍼티가 없다고
  // 컴파일 에러를 내므로, in 연산자로 존재를 먼저 확인해 타입을 좁히는 게 재구현 시 놓치기 쉬운
  // 포인트.
  return "code" in error ? error.code : undefined;
}

// [INTV:EDGE] 제네릭 <T extends string | null>: fallback으로 넘긴 타입(string 또는 null)을 그대로
// 반환 타입에 반영한다. 에러 객체는 드라이버/버전에 따라 모양이 들쭉날쭉할 수 있으므로, 값이 "짧은
// 영숫자 문자열"이라는 안전한 형태가 아니면 신뢰하지 않고 fallback으로 대체한다 — 로그/메트릭에
// 예상 밖의 값(긴 문자열, 객체, 심지어 악의적으로 조작된 로그 인젝션 페이로드 등)이 새는 것을 방지.
function safeLabel<T extends string | null>(value: unknown, fallback: T): string | T {
  if (typeof value !== "string" || !/^[A-Za-z0-9_]{1,64}$/.test(value)) {
    return fallback;
  }
  return value;
}

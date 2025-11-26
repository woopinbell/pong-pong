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

export function installPostgresPoolErrorHandler(
  pool: Pick<Pool, "on">,
  onPoolError?: PostgresPoolErrorReporter
): void {
  pool.on("error", (error) => {
    let event = FALLBACK_EVENT;
    try {
      event = toSafePoolErrorEvent(error);
    } catch {
      // A malformed error object must not escape the pool's EventEmitter boundary.
    }

    try {
      onPoolError?.(event);
    } catch {
      // Reporting is best-effort and must not turn an idle client failure into a process crash.
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
  return "code" in error ? error.code : undefined;
}

function safeLabel<T extends string | null>(value: unknown, fallback: T): string | T {
  if (typeof value !== "string" || !/^[A-Za-z0-9_]{1,64}$/.test(value)) {
    return fallback;
  }
  return value;
}

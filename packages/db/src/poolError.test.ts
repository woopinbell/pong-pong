import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { installPostgresPoolErrorHandler } from "./poolError";

describe("PostgreSQL pool error handling", () => {
  it("observes idle client errors without exposing connection details", async () => {
    const pool = new Pool();
    // vi.fn(): vitest의 모의(mock) 함수 생성 API. 호출 여부/인자를 기록만 하고 실제 로직은 없는 대역 함수 —
    // "reporter 콜백이 어떤 값으로 호출됐는지"를 나중에 toHaveBeenCalledWith로 검증하기 위해 쓴다.
    const onPoolError = vi.fn();
    installPostgresPoolErrorHandler(pool, onPoolError);
    // Object.assign으로 일반 Error에 code/connectionString을 덧붙여, pg가 실제로 던지는 에러의 모양(표준 Error엔
    // 없는 추가 필드가 실려 있는 형태)을 흉내 낸다. connectionString에는 일부러 비밀번호("secret")를 넣어서
    // 아래에서 "이 값이 리포터로 새어나가지 않는지"를 검증한다.
    const error = Object.assign(
      new Error("Connection terminated unexpectedly at postgresql://user:secret@database:5432/app"),
      {
        code: "57P01",
        connectionString: "postgresql://user:secret@database:5432/app"
      }
    );

    // pool.listenerCount / pool.emit: pg의 Pool은 Node EventEmitter이므로, 실제 네트워크 장애를 재현하는 대신
    // "error" 이벤트를 직접 발생시켜서 핸들러가 등록돼 있는지·어떻게 반응하는지를 테스트한다.
    expect(pool.listenerCount("error")).toBe(1);
    expect(() => pool.emit("error", error)).not.toThrow();
    expect(onPoolError).toHaveBeenCalledWith({
      kind: "idle_client_error",
      errorName: "Error",
      errorCode: "57P01"
    });
    // 리포터에 전달된 값에 커넥션 문자열(비밀번호 포함)이나 원본 에러 메시지가 그대로 섞여 있지 않은지 확인 —
    // poolError.ts의 safeLabel이 "영숫자만 통과"시키는 필터가 실제로 민감정보를 걸러내는지 보는 회귀 테스트.
    expect(JSON.stringify(onPoolError.mock.calls)).not.toContain("secret");
    expect(JSON.stringify(onPoolError.mock.calls)).not.toContain("Connection terminated");

    await pool.end();
  });

  it("keeps the pool error boundary safe when no reporter is configured", async () => {
    const pool = new Pool();
    installPostgresPoolErrorHandler(pool);

    expect(() => pool.emit("error", new Error("Connection terminated unexpectedly"))).not.toThrow();

    await pool.end();
  });

  it("does not let a reporter failure become an uncaught pool error", async () => {
    const pool = new Pool();
    installPostgresPoolErrorHandler(pool, () => {
      throw new Error("reporter failed");
    });

    expect(() => pool.emit("error", new Error("Connection terminated unexpectedly"))).not.toThrow();

    await pool.end();
  });
});

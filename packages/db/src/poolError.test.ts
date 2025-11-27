import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { installPostgresPoolErrorHandler } from "./poolError";

describe("PostgreSQL pool error handling", () => {
  it("observes idle client errors without exposing connection details", async () => {
    const pool = new Pool();
    const onPoolError = vi.fn();
    installPostgresPoolErrorHandler(pool, onPoolError);
    const error = Object.assign(
      new Error("Connection terminated unexpectedly at postgresql://user:secret@database:5432/app"),
      {
        code: "57P01",
        connectionString: "postgresql://user:secret@database:5432/app"
      }
    );

    expect(pool.listenerCount("error")).toBe(1);
    expect(() => pool.emit("error", error)).not.toThrow();
    expect(onPoolError).toHaveBeenCalledWith({
      kind: "idle_client_error",
      errorName: "Error",
      errorCode: "57P01"
    });
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

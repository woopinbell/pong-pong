import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryRepository } from "@pong-pong/db";
import { buildApp } from "./app";

describe("health and metrics routes", () => {
  const closeTasks: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(closeTasks.splice(0).reverse().map((close) => close()));
  });

  it("keeps the legacy health response while exposing separate liveness and readiness checks", async () => {
    const { app } = await setup();

    const legacy = await app.inject({ method: "GET", url: "/health" });
    const live = await app.inject({ method: "GET", url: "/health/live" });
    const ready = await app.inject({ method: "GET", url: "/health/ready" });

    expect(legacy.statusCode).toBe(200);
    expect(legacy.json()).toEqual({ ok: true, service: "pong-pong-api" });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ status: "ok", service: "pong-pong-api" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({
      status: "ready",
      service: "pong-pong-api",
      checks: {
        lifecycle: "accepting",
        database: "up",
        migrations: "not_applicable"
      }
    });
  });

  it("returns 503 without exposing a database error when readiness cannot be proven", async () => {
    const repository = createMemoryRepository();
    vi.spyOn(repository, "checkReadiness").mockRejectedValue(
      new Error("password authentication failed for postgresql://pong:secret@db/pong")
    );
    const { app } = await setup(repository);

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: "not_ready",
      service: "pong-pong-api",
      checks: {
        lifecycle: "accepting",
        database: "down",
        migrations: "unknown"
      }
    });
    expect(response.body).not.toContain("secret");
    expect(response.body).not.toContain("postgresql");
  });

  it("drops readiness as soon as draining starts", async () => {
    const { app } = await setup();

    const drain = app.beginDrain(60_000);
    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: "not_ready",
      checks: { lifecycle: "draining" }
    });
    await expect(drain).resolves.toMatchObject({ drained: true, activeRooms: 0 });
  });

  it("publishes Prometheus metrics with bounded labels", async () => {
    const { app } = await setup();
    await app.inject({ method: "GET", url: "/health/live" });

    const response = await app.inject({ method: "GET", url: "/metrics" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.body).toContain("pong_pong_api_http_request_duration_seconds");
    expect(response.body).toContain("pong_pong_api_connections");
    expect(response.body).toContain("pong_pong_api_rooms");
    expect(response.body).toMatch(/route="\/health\/live"/);
    expect(response.body).not.toContain("requestId");
    expect(response.body).not.toContain("userId");
    expect(response.body).not.toContain("roomId");
    expect(response.body).not.toContain("matchId");
  });

  async function setup(repository = createMemoryRepository()) {
    const app = buildApp({
      repo: repository,
      webOrigin: "http://localhost:3000",
      appMode: "test"
    });
    await app.ready();
    closeTasks.push(async () => {
      await app.close();
      await repository.close();
    });
    return { app, repository };
  }
});

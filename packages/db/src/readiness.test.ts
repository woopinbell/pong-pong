import { describe, expect, it } from "vitest";
import { createMemoryRepository } from "./index";
import { compareMigrationSets } from "./migrator";

describe("database readiness", () => {
  it("treats memory storage as ready without pretending migrations ran", async () => {
    const repository = createMemoryRepository();

    // expect(promise).resolves.toEqual(...): 프로미스가 성공적으로 resolve될 때까지 기다린 뒤 그 값에 대해
    // 단언한다 — `expect(await promise).toEqual(...)`를 줄인 형태로 볼 수 있다.
    await expect(repository.checkReadiness()).resolves.toEqual({
      database: "up",
      migrations: "not_applicable"
    });
  });

  it("requires the applied migration set to match the bundled migration set", () => {
    expect(compareMigrationSets(
      ["001_initial", "002_ws_tickets"],
      ["001_initial", "002_ws_tickets"]
    )).toEqual({ status: "current", missing: [], unexpected: [] });

    expect(compareMigrationSets(
      ["001_initial", "002_ws_tickets"],
      ["001_initial"]
    )).toEqual({ status: "pending", missing: ["002_ws_tickets"], unexpected: [] });

    expect(compareMigrationSets(
      ["001_initial"],
      ["001_initial", "999_unknown"]
    )).toEqual({ status: "diverged", missing: [], unexpected: ["999_unknown"] });
  });
});

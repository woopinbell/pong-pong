import { describe, expect, it } from "vitest";
import { createMemoryRepository } from "./index";
import { compareMigrationSets } from "./migrator";

describe("database readiness", () => {
  it("treats memory storage as ready without pretending migrations ran", async () => {
    const repository = createMemoryRepository();

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

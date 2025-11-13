import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("API startup", () => {
  it("does not seed either persistent or in-memory storage", () => {
    const source = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");

    expect(source).not.toMatch(/\.ensureSeedData\s*\(/);
  });
});

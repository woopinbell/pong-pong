import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const workflow = readFileSync(resolve(import.meta.dirname, "../.github/workflows/ci.yml"), "utf8");

test("CI pins the repository toolchain in every job", () => {
  const nodeVersions = [...workflow.matchAll(/node-version:\s*([^\s]+)/g)]
    .map((match) => match[1]);
  assert.ok(nodeVersions.length > 0);
  assert.deepEqual([...new Set(nodeVersions)], ["24.18.0"]);
  assert.match(workflow, /version: 10\.32\.1/);
  assert.match(workflow, /pnpm install --frozen-lockfile/);
});

test("CI separates unit, PostgreSQL integration, process smoke, and browser E2E", () => {
  for (const command of [
    "pnpm unit",
    "pnpm postgres-integration",
    "pnpm smoke:http",
    "pnpm smoke:ws",
    "pnpm e2e"
  ]) {
    assert.match(workflow, new RegExp(command.replace(":", "\\:")));
  }
  assert.match(workflow, /services:\s*\n\s+postgres:/);
  assert.match(workflow, /pnpm --filter @pong-pong\/db migrate/);
  assert.match(workflow, /pnpm --filter @pong-pong\/db seed:dev/);
});

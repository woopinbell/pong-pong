import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "..");
const workflowPath = resolve(
  root,
  ".github/workflows/ci.yml",
);
const workflow = parse(readFileSync(workflowPath, "utf8"));
const nodeVersion = readFileSync(resolve(root, ".node-version"), "utf8").trim();
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const pnpmVersion = packageJson.packageManager.split("@").at(-1);
const jobs = workflow.jobs;
const steps = Object.values(jobs).flatMap((job) => job.steps ?? []);
const runCommands = steps.flatMap((step) =>
  typeof step.run === "string" ? [step.run] : [],
);

test("CI targets only the main branch", () => {
  assert.equal(workflow.name, "CI");
  assert.deepEqual(Object.keys(workflow.on).sort(), ["pull_request", "push"]);
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.deepEqual(workflow.on.pull_request.branches, ["main"]);
  assert.equal(workflow.on.workflow_dispatch, undefined);
  assert.equal(workflow.on.pull_request_target, undefined);
  assert.equal(workflow.on.push["paths-ignore"], undefined);
  assert.equal(workflow.on.pull_request["paths-ignore"], undefined);
});

test("CI uses read-only permissions and a single in-flight run per ref", () => {
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(workflow.concurrency["cancel-in-progress"], true);
  assert.match(workflow.concurrency.group, /github\.workflow/);
  assert.match(workflow.concurrency.group, /github\.ref/);

  for (const step of steps.filter((candidate) =>
    candidate.uses?.startsWith("actions/checkout@"),
  )) {
    assert.equal(step.with?.["persist-credentials"], false);
  }
});

test("CI pins the repository Node and pnpm toolchains", () => {
  const nodeSteps = steps.filter((step) =>
    step.uses?.startsWith("actions/setup-node@"),
  );
  const pnpmSteps = steps.filter((step) =>
    step.uses?.startsWith("pnpm/action-setup@"),
  );
  assert.equal(nodeSteps.length, 4);
  assert.equal(pnpmSteps.length, 4);
  for (const step of nodeSteps) {
    assert.equal(step.with?.["node-version-file"], ".node-version");
    assert.equal(step.with?.["cache-dependency-path"], "pnpm-lock.yaml");
  }
  for (const step of pnpmSteps) {
    assert.equal(String(step.with?.version), pnpmVersion);
  }
  assert.equal(nodeVersion, packageJson.engines.node);
  assert.equal(runCommands.filter((command) => command === "make install").length, 4);
});

test("CI separates functional, database, process, browser, and Compose gates", () => {
  assert.deepEqual(Object.keys(jobs).sort(), [
    "guest-demo-browser",
    "postgres-integration",
    "process-and-browser",
    "production-compose",
    "verify",
  ]);
  assert.equal(jobs["process-and-browser"].services.postgres.image, "postgres:16-alpine");
  assert.match(runCommands.join("\n"), /make check/);
  assert.match(runCommands.join("\n"), /make postgres-integration/);
  assert.match(runCommands.join("\n"), /make smoke/);
  assert.match(runCommands.join("\n"), /make e2e\n?/);
  assert.match(runCommands.join("\n"), /make e2e-guest-demo/);
  assert.doesNotMatch(runCommands.join("\n"), /documentation|README|devlog/i);
});

test("CI uploads process logs on failure", () => {
  for (const jobSteps of [
    jobs["process-and-browser"].steps,
    jobs["guest-demo-browser"].steps,
  ]) {
    assert.ok(
      jobSteps.some(
        (step) =>
          step.if === "failure()" &&
          step.uses?.startsWith("actions/upload-artifact@"),
      ),
    );
  }
  assert.equal(jobs["process-and-browser"].env.API_BASE_URL, "http://localhost:4000");
  assert.equal(jobs["guest-demo-browser"].env.APP_MODE, "demo");
});

test("CI starts and removes the production Compose stack", () => {
  const composeCommands = jobs["production-compose"].steps
    .flatMap((step) => (typeof step.run === "string" ? [step.run] : []))
    .join("\n");
  assert.match(composeCommands, /docker compose up --build --wait --wait-timeout 600/);
  assert.match(composeCommands, /\/api\/health\/ready/);
  assert.match(composeCommands, /\/api\/metrics/);
  assert.match(composeCommands, /docker compose down --volumes --remove-orphans/);
  assert.equal(jobs["production-compose"]["timeout-minutes"], 30);
});

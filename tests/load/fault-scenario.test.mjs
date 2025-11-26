import assert from "node:assert/strict";
import test from "node:test";
import {
  createFaultScenarioConfig,
  formatFaultReport,
  runFaultScenario
} from "./fault-scenario.mjs";

const apiReadinessUrl = "http://127.0.0.1:14000/health/ready";
const edgeReadinessUrl = "http://127.0.0.1:18080/api/health/ready";

test("fault scenario defaults to loopback targets and a 300ms database delay", () => {
  assert.deepEqual(createFaultScenarioConfig({}), {
    toxiproxyApiUrl: "http://127.0.0.1:8474",
    apiReadinessUrl,
    edgeReadinessUrl,
    databaseLatencyMs: 300,
    edgeLatencyMs: 150,
    requestTimeoutMs: 5_000,
    recoveryTimeoutMs: 15_000,
    pollIntervalMs: 250,
    includeEdge: true
  });

  assert.equal(
    createFaultScenarioConfig({ FAULT_INCLUDE_EDGE: "0" }).includeEdge,
    false
  );
});

test("fault scenario refuses to alter a non-loopback target", () => {
  for (const environment of [
    { TOXIPROXY_API_URL: "http://toxiproxy.example.com:8474" },
    { FAULT_API_READINESS_URL: "https://api.example.com/health/ready" },
    { FAULT_EDGE_READINESS_URL: "http://192.0.2.10/api/health/ready" }
  ]) {
    assert.throws(
      () => createFaultScenarioConfig(environment),
      /loopback/
    );
  }
});

test("fault scenario records database and edge failure recovery as JSON", async () => {
  const commands = [];
  const sleeps = [];
  const probeResults = new Map([
    [apiReadinessUrl, [
      ready(200, 9),
      ready(200, 318),
      ready(200, 4),
      notReady(503, 6),
      notReady(503, 5),
      ready(200, 8)
    ]],
    [edgeReadinessUrl, [
      ready(200, 165),
      { status: null, durationMs: 3, error: "socket reset" },
      ready(200, 7)
    ]]
  ]);

  const report = await runFaultScenario(createFaultScenarioConfig({}), {
    applyToxiproxyCommand: async (command, args = []) => {
      commands.push([command, args]);
    },
    probeReadiness: async (url) => {
      const result = probeResults.get(url)?.shift();
      assert.ok(result, `unexpected readiness probe: ${url}`);
      return result;
    },
    sleep: async (durationMs) => {
      sleeps.push(durationMs);
    },
    now: sequence(
      "2026-07-23T03:00:00.000Z",
      "2026-07-23T03:00:03.000Z"
    )
  });

  assert.deepEqual(commands, [
    ["reset", []],
    ["db-latency", ["300", "0"]],
    ["db-down", []],
    ["db-up", []],
    ["edge-latency", ["150", "0"]],
    ["edge-reset", ["0"]],
    ["edge-up", []],
    ["reset", []]
  ]);
  assert.deepEqual(sleeps, [250, 250]);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.startedAt, "2026-07-23T03:00:00.000Z");
  assert.equal(report.finishedAt, "2026-07-23T03:00:03.000Z");
  assert.equal(report.passed, true);
  assert.deepEqual(report.targets, {
    toxiproxyApiUrl: "http://127.0.0.1:8474",
    apiReadinessUrl,
    edgeReadinessUrl
  });
  assert.deepEqual(
    report.steps.map(({ name, passed }) => [name, passed]),
    [
      ["baseline", true],
      ["database_latency", true],
      ["database_down", true],
      ["database_recovery", true],
      ["edge_latency", true],
      ["edge_reset", true],
      ["edge_recovery", true]
    ]
  );
  assert.equal(report.steps.find(({ name }) => name === "database_latency").durationMs, 318);
  assert.equal(
    report.steps.find(({ name }) => name === "database_down").body.checks.database,
    "down"
  );
  assert.equal(report.steps.find(({ name }) => name === "edge_reset").error, "socket reset");

  assert.deepEqual(JSON.parse(formatFaultReport(report)), report);
});

test("fault scenario resets every proxy when a command fails", async () => {
  const commands = [];

  await assert.rejects(
    runFaultScenario(createFaultScenarioConfig({ FAULT_INCLUDE_EDGE: "0" }), {
      applyToxiproxyCommand: async (command, args = []) => {
        commands.push([command, args]);
        if (command === "db-down") throw new Error("control unavailable");
      },
      probeReadiness: async () => ready(200, 5),
      sleep: async () => {},
      now: () => "2026-07-23T03:00:00.000Z"
    }),
    /control unavailable/
  );

  assert.deepEqual(commands, [
    ["reset", []],
    ["db-latency", ["300", "0"]],
    ["db-down", []],
    ["reset", []]
  ]);
});

function ready(status, durationMs) {
  return {
    status,
    durationMs,
    body: {
      status: "ready",
      service: "pong-pong-api",
      checks: {
        lifecycle: "accepting",
        database: "up",
        migrations: "current"
      }
    }
  };
}

function notReady(status, durationMs) {
  return {
    status,
    durationMs,
    body: {
      status: "not_ready",
      service: "pong-pong-api",
      checks: {
        lifecycle: "accepting",
        database: "down",
        migrations: "unknown"
      }
    }
  };
}

function sequence(...values) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

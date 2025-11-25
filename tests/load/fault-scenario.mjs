import { pathToFileURL } from "node:url";
import { runCommand } from "./toxiproxy-control.mjs";

const DEFAULT_TOXIPROXY_API_URL = "http://127.0.0.1:8474";
const DEFAULT_API_READINESS_URL = "http://127.0.0.1:14000/health/ready";
const DEFAULT_EDGE_READINESS_URL = "http://127.0.0.1:18080/api/health/ready";

export function createFaultScenarioConfig(environment = {}) {
  const config = {
    toxiproxyApiUrl: loopbackUrl(
      "TOXIPROXY_API_URL",
      environment.TOXIPROXY_API_URL || DEFAULT_TOXIPROXY_API_URL
    ),
    apiReadinessUrl: loopbackUrl(
      "FAULT_API_READINESS_URL",
      environment.FAULT_API_READINESS_URL || DEFAULT_API_READINESS_URL
    ),
    edgeReadinessUrl: loopbackUrl(
      "FAULT_EDGE_READINESS_URL",
      environment.FAULT_EDGE_READINESS_URL || DEFAULT_EDGE_READINESS_URL
    ),
    databaseLatencyMs: positiveInteger(
      "FAULT_DATABASE_LATENCY_MS",
      environment.FAULT_DATABASE_LATENCY_MS,
      300
    ),
    edgeLatencyMs: positiveInteger(
      "FAULT_EDGE_LATENCY_MS",
      environment.FAULT_EDGE_LATENCY_MS,
      150
    ),
    requestTimeoutMs: positiveInteger(
      "FAULT_REQUEST_TIMEOUT_MS",
      environment.FAULT_REQUEST_TIMEOUT_MS,
      5_000
    ),
    recoveryTimeoutMs: positiveInteger(
      "FAULT_RECOVERY_TIMEOUT_MS",
      environment.FAULT_RECOVERY_TIMEOUT_MS,
      15_000
    ),
    pollIntervalMs: positiveInteger(
      "FAULT_POLL_INTERVAL_MS",
      environment.FAULT_POLL_INTERVAL_MS,
      250
    ),
    includeEdge: booleanFlag("FAULT_INCLUDE_EDGE", environment.FAULT_INCLUDE_EDGE, true)
  };

  if (config.pollIntervalMs > config.recoveryTimeoutMs) {
    throw new RangeError("FAULT_POLL_INTERVAL_MS must not exceed FAULT_RECOVERY_TIMEOUT_MS");
  }
  return config;
}

export async function runFaultScenario(config, overrides = {}) {
  const dependencies = {
    applyToxiproxyCommand: overrides.applyToxiproxyCommand
      ?? ((command, args = []) => runCommand(command, args, {
        TOXIPROXY_API_URL: config.toxiproxyApiUrl
      })),
    probeReadiness: overrides.probeReadiness ?? probeReadiness,
    sleep: overrides.sleep ?? delay,
    now: overrides.now ?? (() => new Date().toISOString())
  };
  const report = {
    schemaVersion: 1,
    startedAt: dependencies.now(),
    finishedAt: null,
    passed: false,
    targets: {
      toxiproxyApiUrl: config.toxiproxyApiUrl,
      apiReadinessUrl: config.apiReadinessUrl,
      edgeReadinessUrl: config.edgeReadinessUrl
    },
    settings: {
      databaseLatencyMs: config.databaseLatencyMs,
      edgeLatencyMs: config.edgeLatencyMs,
      requestTimeoutMs: config.requestTimeoutMs,
      recoveryTimeoutMs: config.recoveryTimeoutMs,
      pollIntervalMs: config.pollIntervalMs,
      includeEdge: config.includeEdge
    },
    steps: []
  };

  let scenarioError;
  try {
    await dependencies.applyToxiproxyCommand("reset", []);
    report.steps.push(await observeStep({
      name: "baseline",
      url: config.apiReadinessUrl,
      expected: isReady,
      config,
      dependencies
    }));

    await dependencies.applyToxiproxyCommand(
      "db-latency",
      [String(config.databaseLatencyMs), "0"]
    );
    report.steps.push(await observeStep({
      name: "database_latency",
      url: config.apiReadinessUrl,
      expected: isReady,
      config,
      dependencies
    }));

    await dependencies.applyToxiproxyCommand("db-down", []);
    report.steps.push(await observeStep({
      name: "database_down",
      url: config.apiReadinessUrl,
      expected: isDatabaseDown,
      config,
      dependencies
    }));

    await dependencies.applyToxiproxyCommand("db-up", []);
    report.steps.push(await observeStep({
      name: "database_recovery",
      url: config.apiReadinessUrl,
      expected: isReady,
      config,
      dependencies
    }));

    if (config.includeEdge) {
      await dependencies.applyToxiproxyCommand(
        "edge-latency",
        [String(config.edgeLatencyMs), "0"]
      );
      report.steps.push(await observeStep({
        name: "edge_latency",
        url: config.edgeReadinessUrl,
        expected: isReady,
        config,
        dependencies
      }));

      await dependencies.applyToxiproxyCommand("edge-reset", ["0"]);
      report.steps.push(await observeStep({
        name: "edge_reset",
        url: config.edgeReadinessUrl,
        expected: (observation) => (
          observation.status === null
          || (observation.status >= 500 && observation.status <= 599)
        ),
        config,
        dependencies
      }));

      await dependencies.applyToxiproxyCommand("edge-up", []);
      report.steps.push(await observeStep({
        name: "edge_recovery",
        url: config.edgeReadinessUrl,
        expected: isReady,
        config,
        dependencies
      }));
    }
  } catch (error) {
    scenarioError = error;
  }

  try {
    await dependencies.applyToxiproxyCommand("reset", []);
  } catch (cleanupError) {
    if (!scenarioError) {
      scenarioError = cleanupError;
    } else if (scenarioError instanceof Error) {
      scenarioError.cause = cleanupError;
    }
  }

  if (scenarioError) throw scenarioError;
  report.finishedAt = dependencies.now();
  report.passed = report.steps.every((step) => step.passed);
  return report;
}

export function formatFaultReport(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}

async function observeStep({ name, url, expected, config, dependencies }) {
  const deadline = Date.now() + config.recoveryTimeoutMs;
  let lastObservation;

  do {
    lastObservation = await dependencies.probeReadiness(url, {
      timeoutMs: config.requestTimeoutMs
    });
    if (expected(lastObservation)) {
      return {
        name,
        passed: true,
        ...lastObservation
      };
    }
    if (Date.now() >= deadline) break;
    await dependencies.sleep(config.pollIntervalMs);
  } while (Date.now() < deadline);

  throw new Error(
    `${name} did not reach the expected state: ${summarizeObservation(lastObservation)}`
  );
}

async function probeReadiness(url, { timeoutMs }) {
  const startedAt = performance.now();
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return {
      status: response.status,
      durationMs: elapsedMilliseconds(startedAt),
      body
    };
  } catch (error) {
    return {
      status: null,
      durationMs: elapsedMilliseconds(startedAt),
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function isReady(observation) {
  return (
    observation.status === 200
    && observation.body?.status === "ready"
    && observation.body?.checks?.database === "up"
  );
}

function isDatabaseDown(observation) {
  return (
    observation.status === 503
    && observation.body?.status === "not_ready"
    && observation.body?.checks?.database === "down"
  );
}

function summarizeObservation(observation) {
  if (!observation) return "no response";
  if (observation.status === null) return observation.error || "network failure";
  return `HTTP ${observation.status} in ${observation.durationMs}ms`;
}

function elapsedMilliseconds(startedAt) {
  return Math.round(Math.max(0, performance.now() - startedAt));
}

function loopbackUrl(name, rawValue) {
  let parsed;
  try {
    parsed = new URL(rawValue);
  } catch {
    throw new RangeError(`${name} must be a valid loopback URL`);
  }
  const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
  if (parsed.protocol !== "http:" || !loopbackHosts.has(parsed.hostname)) {
    throw new RangeError(`${name} must use an HTTP loopback URL`);
  }
  return parsed.href.replace(/\/$/, "");
}

function positiveInteger(name, rawValue, fallback) {
  const value = rawValue === undefined || rawValue === "" ? fallback : Number(rawValue);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

function booleanFlag(name, rawValue, fallback) {
  if (rawValue === undefined || rawValue === "") return fallback;
  if (rawValue === "1") return true;
  if (rawValue === "0") return false;
  throw new RangeError(`${name} must be 0 or 1`);
}

function delay(durationMs) {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  runFromCommandLine();
}

async function runFromCommandLine() {
  try {
    const report = await runFaultScenario(createFaultScenarioConfig(process.env));
    process.stdout.write(formatFaultReport(report));
  } catch (error) {
    process.stdout.write(formatFaultReport({
      schemaVersion: 1,
      passed: false,
      error: {
        message: error instanceof Error ? error.message : String(error)
      }
    }));
    process.exitCode = 1;
  }
}

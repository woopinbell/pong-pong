import { pathToFileURL } from "node:url";
import { runCommand } from "./toxiproxy-control.mjs";

// [INTV:ARCH] 이 파일은 toxiproxy-control.mjs로 실제 장애를 순서대로 주입/해제하면서, 그때마다
// /health/ready가 "올바른 상태"를 정확히 보고하는지 끝까지 확인하는 시나리오 오케스트레이터다 —
// app.ts의 /health/ready 핸들러가 DB up/down에 따라 status를 바꾸는 로직을, 실제로 DB를 끊어보면서
// 검증하는 셈이다(코드 리뷰로는 "이 로직이 맞아 보인다"까지만 확인할 수 있고, 이 시나리오가 실제
// 장애 상황에서의 동작을 실측으로 증명한다).
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

// [INTV:ARCH] overrides로 실제 네트워크 호출(applyToxiproxyCommand/probeReadiness) 대신 가짜 함수를
// 주입할 수 있게 설계했다 — 의존성 주입(DI) 패턴. 이 덕분에 fault-scenario.test.mjs는 진짜 Toxiproxy나
// 서버 없이도 "이 오케스트레이션 로직 자체"(단계 순서, 실패 시 정리 동작 등)를 단위 테스트할 수 있다.
// 실제 실행(아래 runFromCommandLine)에서는 override 없이 기본 구현이 쓰인다 — GameHub 생성자가
// repo를 인자로 받는 것과 같은 이유(테스트를 위한 대체 가능성).
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
    // [INTV:FLOW] 시나리오 진행 순서: 정상 상태 확인 → DB 지연 주입(그래도 ready여야 함) → DB 완전
    // 다운(not_ready + database: down으로 정확히 보고해야 함) → DB 복구(다시 ready) → (옵션) 같은
    // 흐름을 edge(Caddy) 계층에도 반복. 각 단계는 "장애를 걸고 → 기대하는 상태가 될 때까지 확인"하는
    // observeStep으로 이뤄진다 — "지연은 견뎌야 하지만 완전 다운은 정확히 not_ready로 보고해야 한다"는
    // 서로 다른 기대치를 단계별로 구분해서 검증하는 게 이 시나리오의 핵심.
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

      // [INTV:EDGE] reset_peer 장애는 연결 자체를 끊어버리므로, 응답을 아예 못 받거나(status: null,
      // 네트워크 에러) 5xx 상태 중 하나면 "예상대로 망가진 것"으로 본다 — 정상적인 에러 응답 형식을
      // 기대하지 않는다(연결이 물리적으로 끊긴 상황에서는 서버가 JSON 에러 바디를 보낼 기회조차
      // 없으므로, isReady/isDatabaseDown처럼 body 형식까지 검증하면 이 단계는 항상 실패한다).
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

  // [INTV:EDGE] 시나리오 중간에 실패했더라도, Toxiproxy에 걸어둔 장애를 반드시 원상복구한다 — 여기서
  // 안 지우면 이 실행이 실패로 끝나도 다음 테스트/실행에 장애가 계속 남아 있게 된다(공유 인프라에
  // 걸어둔 상태를 정리하지 않으면, 이 스크립트를 실행한 적 없는 다음 사람의 테스트까지 영문 모르게
  // 실패한다 — testReset.ts의 rollback 실패 처리와 같은 "정리 실패가 원인을 가리면 안 된다" 원칙).
  // 정리 자체가 또 실패하면, 원래 있었던 에러를 덮어쓰지 않고 Error.cause로 엮어서 둘 다 흔적이
  // 남게 한다.
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

// [INTV:EDGE] 기대하는 상태(expected)가 될 때까지 recoveryTimeoutMs 안에서 짧은 간격으로 재확인한다
// — 장애를 걸거나 풀어도 그 효과가 서버에 반영되기까지 약간의 시차가 있을 수 있어서다(connection
// pool이 이미 열어둔 커넥션이 있으면 즉시 반영 안 될 수 있음). 끝내 도달하지 못하면 마지막으로
// 관찰한 상태를 담아 에러를 던진다 — waitForApi/waitForFinalizationRetry와 같은 계열의 "기대 상태가
// 될 때까지 폴링" 패턴.
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
    // [INTV:TRAP] AbortSignal.timeout(ms): "이 시간이 지나면 자동으로 abort 신호를 보내는"
    // AbortSignal을 만들어주는 표준 API 축약형 — AbortController를 직접 만들고 setTimeout으로
    // abort()를 예약하는 과정을 한 줄로 줄인다. 이 축약형을 모르고 재구현하면 AbortController +
    // setTimeout + cleanup(clearTimeout)까지 직접 관리해야 하는 보일러플레이트가 늘어난다.
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

// [INTV:EDGE] 이 스크립트가 다룰 URL은 반드시 localhost/127.0.0.1 같은 루프백 주소여야 한다는 걸
// 강제한다 — 장애 주입 도구가 실수로 원격/운영 서버를 가리키면 실제로 그 서비스를 끊어버리는 사고가
// 될 수 있어, 그런 설정 자체를 아예 거부한다(testReset.ts의 화이트리스트 안전장치와 같은 원칙 —
// 파괴적이거나 위험한 작업일수록 "허용된 형태인지"를 앞단에서 강제로 검증).
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

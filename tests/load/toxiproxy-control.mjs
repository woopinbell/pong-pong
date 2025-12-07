import { pathToFileURL } from "node:url";

// [INTV:ARCH] Toxiproxy: 실제 서비스 사이(여기서는 API↔Postgres, 그리고 외부↔Caddy)에 끼워 넣어
// 일부러 장애를 재현하는 프록시 도구("카오스 엔지니어링") — 지연, 접속 끊김 같은 걸 인위적으로
// 만들어서 그런 상황에서도 시스템(재연결 로직, 재시도 로직 등)이 실제로 버티는지 부하 테스트 중에
// 확인한다. 코드 리뷰나 단위 테스트로는 "재시도 로직이 있다"까지만 확인할 수 있지만, 실제로 DB가
// 250ms씩 느려지거나 연결이 리셋되는 상황에서 그 로직이 진짜로 동작하는지는 이렇게 장애를 실제로
// 주입해봐야 안다. 이 파일은 그 Toxiproxy를 조종하는 작은 CLI/라이브러리다.
const DEFAULT_API_URL = "http://127.0.0.1:8474";
const COMMANDS = new Set([
  "plan",
  "ensure",
  "reset",
  "db-latency",
  "db-down",
  "db-up",
  "edge-latency",
  "edge-reset",
  "edge-down",
  "edge-up"
]);

// [INTV:ARCH] 장애를 주입할 지점(프록시) 두 곳 — postgres는 DB 앞, edge는 (Caddy를 거치는) 외부
// 트래픽 앞. 이 프로젝트가 이미 다룬 poolError.ts(DB 커넥션 장애)와 GameSocketClient.ts(재연결)가
// 각각 어느 계층의 장애에 대응하는 코드인지가 이 두 프록시 이름과 대응된다 — db-* 커맨드는
// installPostgresPoolErrorHandler의 방어를, edge-* 커맨드는 GameSocketClient의 재연결 로직을
// 실제로 시험한다.
export function buildProxyDefinitions(environment = {}) {
  return [
    {
      name: "postgres",
      listen: environment.TOXIPROXY_POSTGRES_LISTEN || "0.0.0.0:15432",
      upstream: environment.TOXIPROXY_POSTGRES_UPSTREAM || "db:5432",
      enabled: true
    },
    {
      name: "edge",
      listen: environment.TOXIPROXY_EDGE_LISTEN || "0.0.0.0:18080",
      upstream: environment.TOXIPROXY_EDGE_UPSTREAM || "caddy:8080",
      enabled: true
    }
  ];
}

// [INTV:ARCH] "toxic": Toxiproxy 용어로 프록시를 지나는 트래픽에 적용하는 장애 하나. type:
// "latency"는 인위적 지연(jitter로 매번 무작위 편차를 더함 — 항상 정확히 같은 지연이면 비현실적인
// 조건이 된다), type: "reset_peer"는 마치 상대가 갑자기 연결을 뚝 끊은 것처럼 TCP 연결을 강제로
// 리셋한다(heartbeat.ts가 방어하려는 "정상적으로 close 프레임을 못 받는" 상황을 정확히 재현). toxicity:
// 1은 "지나가는 트래픽 100%에 적용"이라는 뜻(Toxiproxy는 확률적으로 일부에만 적용하는 것도 지원한다).
// stream: "downstream"은 이 장애가 "서버 → 클라이언트" 방향 트래픽에 적용된다는 뜻.
export function toxicForCommand(command, args = []) {
  if (command === "db-latency" || command === "edge-latency") {
    const latency = positiveInteger(args[0] ?? "250");
    const jitter = nonnegativeInteger(args[1] ?? "25");
    const proxy = command.startsWith("db-") ? "postgres" : "edge";
    return {
      proxy,
      toxic: {
        name: command,
        type: "latency",
        stream: "downstream",
        toxicity: 1,
        attributes: { latency, jitter }
      }
    };
  }
  if (command === "edge-reset") {
    return {
      proxy: "edge",
      toxic: {
        name: command,
        type: "reset_peer",
        stream: "downstream",
        toxicity: 1,
        attributes: { timeout: nonnegativeInteger(args[0] ?? "0") }
      }
    };
  }
  throw new RangeError(`command does not define a toxic: ${command}`);
}

// [INTV:ARCH] 커맨드 디스패처: plan(실제로 Toxiproxy를 건드리지 않고 계획만 미리보기), ensure(프록시
// 정의를 멱등하게 생성/갱신), reset(모든 장애를 제거하고 정상 상태로), *-down/*-up(프록시를 완전히
// 꺼서 "그 서비스가 통째로 다운된" 상황을 재현/복구), 그 외에는 위 toxicForCommand로 만든 구체적인
// 장애 하나를 적용한다 — plan이 별도로 있는 이유: 실제로 장애를 주입하기 전에 "무엇을 할 것인지"를
// 사람이 먼저 확인할 수 있는 dry-run 경로(운영 환경에서 장애 주입 도구 자체가 실수로 잘못 실행되는
// 것을 막는 안전장치).
export async function runCommand(command, args = [], environment = process.env) {
  if (!COMMANDS.has(command)) throw new RangeError(`unknown command: ${command}`);
  const apiUrl = (environment.TOXIPROXY_API_URL || DEFAULT_API_URL).replace(/\/$/, "");
  const proxies = buildProxyDefinitions(environment);
  if (command === "plan") return { apiUrl, proxies };

  await waitForApi(apiUrl);
  await ensureProxies(apiUrl, proxies);
  if (command === "ensure") return { apiUrl, proxies };
  if (command === "reset") {
    for (const proxy of proxies) {
      await removeAllToxics(apiUrl, proxy.name);
      await setEnabled(apiUrl, proxy.name, true);
    }
    return { reset: proxies.map((proxy) => proxy.name) };
  }
  if (command.endsWith("-down")) {
    const proxy = command.startsWith("db-") ? "postgres" : "edge";
    await setEnabled(apiUrl, proxy, false);
    return { proxy, enabled: false };
  }
  if (command.endsWith("-up")) {
    const proxy = command.startsWith("db-") ? "postgres" : "edge";
    await removeAllToxics(apiUrl, proxy);
    await setEnabled(apiUrl, proxy, true);
    return { proxy, enabled: true };
  }

  const planned = toxicForCommand(command, args);
  await removeAllToxics(apiUrl, planned.proxy);
  await requestJson(apiUrl, `/proxies/${planned.proxy}/toxics`, {
    method: "POST",
    body: planned.toxic
  });
  return planned;
}

// [INTV:EDGE] Toxiproxy 자체가 막 떠서 아직 API가 응답하지 않는 초기 구간을 감안해, 준비될 때까지
// 짧은 간격으로 재시도한다(app.ts의 /health/ready가 "서버가 준비됐는지"를 폴링당하는 쪽이라면, 여기는
// 반대로 이 스크립트가 Toxiproxy를 상대로 같은 패턴의 폴링을 거는 쪽).
async function waitForApi(apiUrl) {
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await requestJson(apiUrl, "/version");
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  throw lastError ?? new Error("Toxiproxy API did not become ready");
}

// [INTV:EDGE] 이미 있는 프록시면 갱신(POST가 upsert 역할), 없으면 새로 만든다 — 여러 번 실행해도
// 같은 결과가 되는 멱등한 설정 함수(commerce-transaction의 upsert 패턴을 인프라 설정 도구에도
// 적용한 것 — CI에서 이 스크립트를 여러 번 돌려도 안전하다).
async function ensureProxies(apiUrl, definitions) {
  const existing = await requestJson(apiUrl, "/proxies");
  for (const definition of definitions) {
    if (existing[definition.name]) {
      await requestJson(apiUrl, `/proxies/${definition.name}`, {
        method: "POST",
        body: definition
      });
    } else {
      await requestJson(apiUrl, "/proxies", { method: "POST", body: definition });
    }
  }
}

async function removeAllToxics(apiUrl, proxy) {
  const toxics = await requestJson(apiUrl, `/proxies/${proxy}/toxics`);
  for (const toxic of toxics) await removeToxic(apiUrl, proxy, toxic.name);
}

async function removeToxic(apiUrl, proxy, name) {
  await requestJson(apiUrl, `/proxies/${proxy}/toxics/${name}`, {
    method: "DELETE",
    allowNotFound: true
  });
}

async function setEnabled(apiUrl, proxy, enabled) {
  const current = await requestJson(apiUrl, `/proxies/${proxy}`);
  await requestJson(apiUrl, `/proxies/${proxy}`, {
    method: "POST",
    body: {
      name: current.name,
      listen: current.listen,
      upstream: current.upstream,
      enabled
    }
  });
}

async function requestJson(apiUrl, path, options = {}) {
  const response = await fetch(`${apiUrl}${path}`, {
    method: options.method ?? "GET",
    headers: options.body ? { "content-type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (options.allowNotFound && response.status === 404) return null;
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`${options.method ?? "GET"} ${path} failed (${response.status}): ${detail}`);
  }
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function positiveInteger(rawValue) {
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError("value must be a positive integer");
  return value;
}

function nonnegativeInteger(rawValue) {
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("value must be a nonnegative integer");
  return value;
}

// [INTV:TRAP] "이 모듈이 다른 파일에 import된 게 아니라 node tests/load/toxiproxy-control.mjs처럼
// 직접 실행됐는지"를 판별하는 관용구 — import.meta.url(이 모듈 자신의 URL)과 실제로 node에 넘겨진
// 실행 파일 경로가 같은지 비교한다(다른 언어의 `if __name__ == "__main__"`과 같은 목적). 이 체크
// 없이 최상위에서 바로 process.argv를 읽고 CLI처럼 동작하면, 다른 스크립트가 이 파일의 함수들을
// import만 해도(runCommand 등을 재사용하려고) 원치 않는 CLI 실행 부수효과가 함께 딸려온다. 직접
// 실행된 경우에만 아래에서 커맨드라인 인자를 읽어 CLI처럼 동작한다.
const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  const [command = "plan", ...args] = process.argv.slice(2);
  runCommand(command, args)
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}

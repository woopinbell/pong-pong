import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

// 이 파일은 vitest가 아니라 Node가 기본 내장한 테스트 러너(node:test)와 단언 라이브러리(node:assert/strict)를
// 쓴다 — describe/it/expect 대신 test(이름, 함수)와 assert.equal/assert.match 같은 API로 같은 역할을 한다.
// 검증 대상도 애플리케이션 코드가 아니라 docker-compose.yml/Dockerfile/Caddyfile 같은 배포 설정 파일들이라,
// 프로젝트 의존성 없이 가볍게 돌 수 있는 node:test를 선택한 것으로 보인다.
const root = resolve(import.meta.dirname, "..");
const nodeVersion = read(".node-version").trim();

test("production compose exposes only Caddy and runs migration once", () => {
  // "docker compose config --format json": docker-compose.yml에 환경변수 치환·병합까지 다 반영한
  // "최종적으로 실제 적용될" 설정을 JSON으로 뽑아준다 — YAML 텍스트를 정규식으로 grep하는 대신, 구조화된
  // 데이터로 정확히 검증할 수 있다.
  const result = spawnSync("docker", ["compose", "config", "--format", "json"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      POSTGRES_PASSWORD: "compose-contract-password",
      SESSION_SECRET: "compose-contract-session-secret-32-bytes"
    }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const config = JSON.parse(result.stdout);
  const services = config.services;
  assert.deepEqual(Object.keys(services).sort(), ["api", "caddy", "db", "migrate", "web"]);
  // 포트를 외부로 여는 서비스가 caddy 하나뿐이어야 한다 — api/db/web은 Docker 내부 네트워크에서만 서로
  // 통신하고, 외부 요청은 전부 리버스 프록시(Caddy)를 거치도록 강제하는 배포 구조를 코드로 못박아둔 것.
  assert.deepEqual(Object.entries(services)
    .filter(([, service]) => Array.isArray(service.ports) && service.ports.length > 0)
    .map(([name]) => name), ["caddy"]);
  // migrate 서비스는 packages/db/src/cli.ts의 "migrate" 커맨드를 한 번 실행하고 끝나는 1회성 컨테이너다
  // (restart: "no" — 실패해도 재시작하지 않는다). api는 depends_on 조건으로 "migrate가 성공적으로 끝난
  // 뒤에만" 시작하도록 강제된다 — 마이그레이션이 덜 된 스키마에 API가 먼저 붙는 사고를 원천 차단.
  assert.deepEqual(services.migrate.command, ["node", "packages/db/dist/cli.js", "migrate"]);
  assert.equal(services.migrate.restart, "no");
  assert.equal(services.api.depends_on.migrate.condition, "service_completed_successfully");
  // stop_grace_period: 컨테이너가 SIGTERM을 받고도 스스로 안 끝나면 Docker가 강제 종료(SIGKILL)하기까지
  // 기다려주는 최대 시간 — apps/api/src/index.ts의 graceful shutdown이 최대 60초까지 드레인을 기다리므로,
  // 그보다 짧으면 드레인이 채 끝나기 전에 강제로 죽어버릴 수 있다. 그 계약을 여기서 최소 60초로 못박는다.
  assert.ok(parseDurationSeconds(services.api.stop_grace_period) >= 60);

  // bind mount(호스트 파일시스템 경로를 컨테이너에 그대로 연결)는 로컬 개발에는 편하지만, 운영 이미지는
  // 호스트의 특정 파일 존재에 의존하지 않는 "자기 완결적" 상태여야 한다 — 그래서 프로덕션 compose에는
  // bind 타입 볼륨이 하나도 없어야 한다.
  for (const [name, service] of Object.entries(services)) {
    for (const volume of service.volumes ?? []) {
      assert.notEqual(volume.type, "bind", `${name} must not use a source bind mount`);
    }
  }
});

test("production images pin Node and run application processes as non-root", () => {
  for (const fileName of ["apps/api/Dockerfile", "apps/web/Dockerfile"]) {
    const source = read(fileName);
    assert.match(source, new RegExp(`FROM node:${escapeRegExp(nodeVersion)}-bookworm-slim`));
    // USER node: 컨테이너 안에서 애플리케이션 프로세스를 root가 아니라 전용 저권한 계정으로 실행한다 —
    // 컨테이너가 뚫려도 root 권한까지 넘겨주지 않기 위한 기본적인 보안 강화.
    assert.match(source, /^USER node$/m);
    // 컨테이너 시작 커맨드가 pnpm/npm을 통해 실행되면 안 된다 — 그건 devDependencies까지 필요한 "개발
    // 모드" 실행 방식이고, 운영 이미지는 이미 빌드된 산출물(node dist/index.js 등)을 node로 직접 실행해야 한다.
    assert.doesNotMatch(source, /^CMD .*\b(?:pnpm|npm)\b/m);
  }
});

test("compose requires secrets and keeps metrics behind the internal API network", () => {
  const compose = read("docker-compose.yml");
  const caddy = read("Caddyfile");

  // "${VAR:?message}"는 셸/Compose의 변수 치환 문법 중 하나로, VAR가 비어있으면 그냥 빈 문자열로 넘어가는
  // 대신 즉시 에러를 내며 실행을 중단시킨다 — SESSION_SECRET 같은 값이 실수로 빈 채 배포되는 걸 막는다.
  assert.match(compose, /POSTGRES_PASSWORD: \$\{POSTGRES_PASSWORD:\?/);
  assert.match(compose, /SESSION_SECRET: \$\{SESSION_SECRET:\?/);
  assert.match(compose, /\/health\/ready/);
  // Caddy 설정 언어(Caddyfile)에서 @internalMetrics는 "이 조건에 맞는 요청"을 가리키는 이름 붙은 매처이고,
  // 그 아래 respond ... 404는 그 매처에 걸린 요청(외부에서 들어온 /api/metrics)을 404로 막아버린다 —
  // observability.ts의 Prometheus 스크레이프 엔드포인트가 인터넷에 그대로 노출되지 않게 하는 설정.
  assert.match(caddy, /@internalMetrics path \/api\/metrics/);
  assert.match(caddy, /respond @internalMetrics 404/);
});

function read(fileName) {
  return readFileSync(resolve(root, fileName), "utf8");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseDurationSeconds(value) {
  assert.equal(typeof value, "string");
  const match = /^(?:(\d+)m)?(?:(\d+)s)?$/.exec(value);
  assert.ok(match, `unsupported duration: ${value}`);
  return Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0);
}

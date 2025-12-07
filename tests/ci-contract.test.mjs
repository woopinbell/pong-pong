import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { parse } from "yaml";

// GitHub Actions 워크플로 YAML(.github/workflows/ci.yml)을 파싱해서, "CI 설정 자체가 지켜야 할 규칙들"을
// 코드로 강제하는 테스트 — 워크플로 파일을 누가 고칠 때 보안/일관성 규칙을 실수로 깨뜨리면 이 테스트가 잡아낸다.
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
  // workflow_dispatch(수동 실행)나 pull_request_target(포크에서 온 PR도 베이스 저장소의 시크릿을 그대로
  // 쓸 수 있게 되는, 잘 알려진 GitHub Actions 보안 함정) 같은 트리거는 의도적으로 허용하지 않는다 — CI가
  // 항상 예상한 이벤트(push/PR to main)로만 도는지를 강제한다.
  assert.equal(workflow.on.workflow_dispatch, undefined);
  assert.equal(workflow.on.pull_request_target, undefined);
  assert.equal(workflow.on.push["paths-ignore"], undefined);
  assert.equal(workflow.on.pull_request["paths-ignore"], undefined);
});

test("CI uses read-only permissions and a single in-flight run per ref", () => {
  // permissions: { contents: "read" }는 이 워크플로의 GITHUB_TOKEN이 저장소에 쓰기 권한 없이 읽기만
  // 하도록 최소 권한 원칙을 적용한 것.
  assert.deepEqual(workflow.permissions, { contents: "read" });
  // concurrency + cancel-in-progress: 같은 브랜치/PR에 커밋이 연달아 올라오면, 아직 끝나지 않은 이전 CI
  // 실행을 취소하고 최신 커밋 것만 돈다 — CI 실행 시간/비용을 아끼는 설정.
  assert.equal(workflow.concurrency["cancel-in-progress"], true);
  assert.match(workflow.concurrency.group, /github\.workflow/);
  assert.match(workflow.concurrency.group, /github\.ref/);

  for (const step of steps.filter((candidate) =>
    candidate.uses?.startsWith("actions/checkout@"),
  )) {
    // persist-credentials: false — 체크아웃한 로컬 git 설정에 GITHUB_TOKEN 인증정보를 남겨두지 않는다 —
    // 이후 스텝에서 실행되는(잠재적으로 신뢰할 수 없는) 스크립트가 그 토큰으로 저장소에 뭔가 push하는
    // 사고를 방지하는 방어적 설정.
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
  // node-version-file: ".node-version" — 버전을 워크플로 YAML에 직접 하드코딩하지 않고 저장소의
  // .node-version 파일 하나를 유일한 기준(single source of truth)으로 삼는다.
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
  // 이 다섯 개 job은 이 프로젝트가 지금까지 본 테스트 계층들과 그대로 대응한다: verify(단위 테스트),
  // postgres-integration(testcontainers 기반 실제 Postgres 테스트), process-and-browser(smoke +
  // Playwright e2e), guest-demo-browser(데모 모드 전용 e2e), production-compose(docker-production.test.mjs가
  // 검증하는 운영 Compose 스택을 실제로 띄워보는 단계).
  assert.deepEqual(Object.keys(jobs).sort(), [
    "guest-demo-browser",
    "postgres-integration",
    "process-and-browser",
    "production-compose",
    "verify",
  ]);
  // services.postgres: GitHub Actions의 "서비스 컨테이너" 기능 — docker-compose 없이도 잡 러너 옆에
  // Postgres 컨테이너를 하나 붙여서 그 잡의 테스트들이 실제 DB에 붙을 수 있게 해준다.
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
    // if: "failure()"는 이 스텝 이전에 잡 안에서 실패가 있었을 때만 실행되는 조건부 스텝 — 여기서는 실패
    // 시에만 로그를 아티팩트로 업로드해서, 실패한 CI 실행을 나중에 다운로드해 원인을 조사할 수 있게 한다.
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
  // --wait --wait-timeout 600: 컨테이너를 그냥 띄우기만 하고 바로 다음 명령으로 넘어가는 게 아니라,
  // 각 서비스의 헬스체크가 전부 통과할 때까지(최대 600초) 기다렸다가 명령을 끝낸다 — 그래야 이어지는
  // /api/health/ready 확인이 "아직 뜨는 중"인 서버를 잘못 실패로 판정하지 않는다.
  assert.match(composeCommands, /docker compose up --build --wait --wait-timeout 600/);
  assert.match(composeCommands, /\/api\/health\/ready/);
  assert.match(composeCommands, /\/api\/metrics/);
  assert.match(composeCommands, /docker compose down --volumes --remove-orphans/);
  assert.equal(jobs["production-compose"]["timeout-minutes"], 30);
});

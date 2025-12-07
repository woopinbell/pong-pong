import {
  createMemoryRepository,
  createPostgresRepository,
  type PostgresPoolErrorEvent
} from "@pong-pong/db";
import { buildApp } from "./app.js";
import { readEnv } from "./env.js";
import { installGracefulShutdown } from "./gracefulShutdown.js";

// [INTV:ARCH] 이 파일이 API 서버 프로세스의 실제 진입점이다. cli.ts와 마찬가지로 "type": "module"
// (ESM) 덕분에 최상위에서 바로 await를 쓸 수 있다(맨 아래 app.listen 참고, top-level await).
const env = readEnv();
// [INTV:EDGE] createPostgresRepository는 pool의 "error" 이벤트가 생기면 onPoolError 콜백을
// 부르는데, 이 시점엔 아직 app(과 그 로거)이 만들어지기 전이다. 그래서 처음엔 이벤트를 배열에
// 쌓아두기만 하는 함수로 시작했다가, app이 준비되면(아래) 진짜 로깅하는 함수로 reportPoolError
// 자체를 바꿔치기하고, 그동안 쌓인 이벤트를 한꺼번에 흘려보낸다 — "로거가 생기기 전의 이벤트를
// 잃어버리지 않는" 버퍼링 패턴(gameHub.ts의 pendingPayloads와 같은 원리 — "아직 준비 안 된 대상에게
// 갈 이벤트를 버리지 않고 나중으로 미룬다"는 패턴이 이 코드베이스에서 반복됨).
const earlyPoolErrors: PostgresPoolErrorEvent[] = [];
let reportPoolError = (event: PostgresPoolErrorEvent) => {
  earlyPoolErrors.push(event);
};
const repo = env.databaseUrl
  ? createPostgresRepository(env.databaseUrl, {
      onPoolError: (event) => {
        reportPoolError(event);
      }
    })
  : createMemoryRepository();

const app = buildApp({
  repo,
  webOrigin: env.webOrigin,
  appMode: env.appMode,
  sessionSecret: env.sessionSecret,
  trustProxy: env.trustProxy
});
reportPoolError = (event) => {
  app.log.error(event, "PostgreSQL idle client connection failed");
};
for (const event of earlyPoolErrors.splice(0)) {
  reportPoolError(event);
}
app.addHook("onClose", async () => {
  await repo.close();
});

// [INTV:ARCH] gracefulShutdown.ts가 SIGTERM/SIGINT를 받으면 이 콜백이 실행된다: 먼저 GameHub에
// 드레인을 지시해 진행 중인 매치가 끝나기를(최대 60초) 기다린 뒤, Fastify 앱을 닫는다(app.close()가
// onClose 훅들을 연쇄 실행시켜 repo.close()와 disposeShutdownSignals()까지 이어진다) — "새 요청은
// 안 받고, 하던 일은 마저 끝내고 종료"하는 순서를 여기서 명시적으로 짠 것.
// - [FLOW] 1. SIGTERM 수신 -> 2. beginDrain(60s)로 새 매치 차단 + 기존 방 종료 대기 -> 3. drain
//   결과 로깅 -> 4. app.close()로 onClose 훅 체인 실행(repo.close, 신호 리스너 해제) -> 5. (실패
//   시) exitCode=1 설정 후 강제로 app.close 시도
const disposeShutdownSignals = installGracefulShutdown(
  process,
  async (signal) => {
    app.log.info({ signal }, "graceful shutdown started");
    const result = await app.beginDrain(60_000);
    app.log.info(result, "game room drain finished");
    await app.close();
  },
  (error) => {
    app.log.error({ errorName: error instanceof Error ? error.name : "UnknownError" }, "graceful shutdown failed");
    process.exitCode = 1;
    void app.close().catch(() => undefined);
  }
);
app.addHook("onClose", async () => {
  disposeShutdownSignals();
});

try {
  // [INTV:TRAP] host: "0.0.0.0"은 "이 머신의 모든 네트워크 인터페이스에서 접속을 받는다"는 뜻 —
  // 127.0.0.1(로컬호스트)만 바인딩하면 같은 머신 밖에서는(예: 컨테이너 밖의 다른 컨테이너나
  // 로드밸런서에서는) 접속할 수 없다. 컨테이너 환경에서 기본값(대개 127.0.0.1)만 믿고 host를 생략하면
  // "로컬에선 되는데 배포하면 연결이 안 되는" 흔한 함정에 빠진다.
  await app.listen({ port: env.port, host: "0.0.0.0" });
} catch (error) {
  // [INTV:EDGE] 포트가 이미 사용 중인 경우 등 리슨 자체가 실패하면, 로그를 남기고 DB 커넥션을
  // 정리한 뒤 0이 아닌 코드로 종료한다 — 프로세스를 감시하는 쪽(systemd, Docker, k8s 등)이 "시작에
  // 실패했다"는 걸 알 수 있게 한다(exit code 0으로 끝나면 오케스트레이터가 "정상 종료"로 오판해
  // 재시작을 안 시도할 수 있다).
  app.log.error(error);
  await repo.close();
  process.exit(1);
}

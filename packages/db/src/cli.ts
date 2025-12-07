import { createMemoryRepository, createPostgresRepository } from "./index.js";
import { migrateDatabase } from "./migrator.js";
import { resetTestDatabase } from "./testReset.js";

// [INTV:TRAP] process.argv: Node가 실행될 때 넘어온 인자 배열. [0]은 node 실행 파일 경로, [1]은
// 이 스크립트 경로이므로 실제 사용자가 넘긴 첫 인자는 인덱스 2부터 시작한다(예: `tsx src/cli.ts
// migrate` → argv[2] === "migrate"). argv[0]부터 세는 실수가 흔한 함정.
const command = process.argv[2];

// [INTV:ARCH] 이 파일은 함수 본문이 아니라 모듈 최상위에 직접 await가 있다(top-level await) —
// package.json에 "type": "module"로 ESM으로 실행되기 때문에 async 래퍼 함수 없이도 최상위에서
// await를 쓸 수 있다(index.ts의 서버 부트스트랩도 같은 top-level await 패턴). package.json의
// 여러 CLI 스크립트(migrate, seed:dev 등)가 모두 이 한 파일을 커맨드 인자만 바꿔 실행한다.
if (command === "memory-smoke") {
  const memory = createMemoryRepository();
  await memory.ensureSeedData();
  await memory.close();
  console.log("ok");
} else if (command === "reset:test") {
  const target = await resetTestDatabase();
  console.log(`test schema reset: ${target.schema}`);
} else {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for database CLI commands");
  }

  if (command === "migrate") {
    await migrateDatabase(databaseUrl);
    console.log("migrated");
  } else {
    const repo = createPostgresRepository(databaseUrl);

    try {
      if (command === "seed:dev" || command === "seed:demo") {
        await repo.ensureSeedData(command === "seed:dev" ? "development" : "demo");
        console.log(command === "seed:dev" ? "development seed complete" : "demo seed complete");
      } else if (command === "user:set-role") {
        const handle = process.argv[3];
        const role = process.argv[4];
        if (!handle || (role !== "user" && role !== "admin")) {
          throw new Error("Usage: pnpm --filter @pong-pong/db user:set-role -- <handle> <user|admin>");
        }
        const user = await repo.setUserRoleByHandle(handle, role);
        console.log(`${user.handle} role set to ${user.role}`);
      } else {
        throw new Error("Usage: pnpm --filter @pong-pong/db migrate|seed:dev|seed:demo|reset:test|user:set-role|memory-smoke");
      }
    } finally {
      // [INTV:EDGE] DB 커넥션을 쓰는 명령이었다면 성공/실패와 무관하게 반드시 닫아, CLI 프로세스가
      // 열린 커넥션 때문에 종료되지 않고 걸려 있는 상황을 막는다(try/finally라 명령이 예외를 던지고
      // 끝나도 close는 항상 실행된다).
      await repo.close();
    }
  }
}

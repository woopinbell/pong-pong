import { Pool } from "pg";
import { migrateDatabase } from "./migrator.js";

// [INTV:EDGE] 이 파일은 테스트 실행 전 "테스트 전용 스키마를 통째로 지우고 새로 만드는" 위험한
// 작업을 한다. 아래 두 정규식은 그 대상이 실수로 운영 DB나 다른 목적의 스키마가 되지 않도록 하는
// 안전장치(allowlist) — 이름이 이 패턴에 맞지 않으면 아예 실행을 거부한다. drop schema ... cascade는
// 되돌릴 수 없는 파괴적 작업이라 "그럴듯해 보이는" 이름을 블랙리스트로 거르는 대신, 정해진 규칙에
// 정확히 맞는 이름만 통과시키는 화이트리스트 방식을 쓴다 — 파괴적 작업일수록 허용 목록이 차단
// 목록보다 안전하다는 일반 원칙(예상 못한 이름 패턴이 새로 나타나도 기본값이 "거부"이기 때문).
const ISOLATED_TEST_SCHEMA = /^test_[a-f0-9]{32}$/;
const DEDICATED_TEST_DATABASE = /^(?:test(?:_[a-z0-9][a-z0-9_-]*)?|[a-z0-9][a-z0-9_-]*_test)$/;

export interface TestResetTarget {
  databaseUrl: string;
  databaseName: string;
  schema: string;
}

export function resolveTestResetTarget(env: NodeJS.ProcessEnv): TestResetTarget {
  if (env.NODE_ENV !== "test") {
    throw new Error("reset:test requires NODE_ENV=test");
  }
  const databaseUrl = env.TEST_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("TEST_DATABASE_URL is required for reset:test");
  }

  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return unsafeTarget();
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    return unsafeTarget();
  }

  let databaseName: string;
  try {
    databaseName = decodeURIComponent(url.pathname.slice(1));
  } catch {
    return unsafeTarget();
  }
  if (!databaseName || databaseName.includes("/")) {
    return unsafeTarget();
  }

  // [INTV:ARCH] Postgres 연결 문자열의 "options" 쿼리 파라미터는 libpq 커넥션 옵션을 실어보내는
  // 통로다. `-c search_path=<스키마명>`은 "이 커넥션에서 기본으로 바라볼 스키마"를 지정하는 문법 —
  // 병렬로 도는 테스트 워커들이 같은 DB 안에서도 서로 다른 스키마(test_<32자리 16진수 해시>)를
  // 써서 데이터가 섞이지 않게 격리하는 방식이다(별도 DB를 워커마다 만드는 대신 스키마로 격리하면
  // 생성/삭제 비용이 훨씬 가볍다).
  const optionValues = url.searchParams.getAll("options");
  if (optionValues.length > 1) {
    return unsafeTarget();
  }
  let schema = "public";
  if (optionValues.length === 1) {
    const match = /^-c search_path=(test_[a-f0-9]{32})$/.exec(optionValues[0]);
    if (!match) return unsafeTarget();
    schema = match[1];
  }

  // [INTV:EDGE] 스키마 격리 없이(public 스키마) 리셋하는 경우엔 최소한 "DB 이름 자체가 테스트
  // 전용임을 알 수 있는 이름"이어야 한다 — 스키마 이름으로 안전을 보장 못 하는 경로이니, 그 대신
  // DB 이름 자체에 안전장치를 옮겨 건 것(둘 중 하나는 반드시 "테스트 전용"임을 증명해야 진행).
  if (schema === "public" && !DEDICATED_TEST_DATABASE.test(databaseName)) {
    return unsafeTarget();
  }
  if (schema !== "public" && !ISOLATED_TEST_SCHEMA.test(schema)) {
    return unsafeTarget();
  }

  return { databaseUrl, databaseName, schema };
}

export async function resetTestDatabase(
  env: NodeJS.ProcessEnv = process.env
): Promise<TestResetTarget> {
  const target = resolveTestResetTarget(env);
  const controlUrl = new URL(target.databaseUrl);
  // [INTV:TRAP] 스키마를 drop/create하는 DDL 자체는 search_path를 강제로 그 스키마로 고정한
  // 커넥션이 아니라 일반 커넥션으로 실행해야 하므로("아직 존재하지 않는 스키마를 기본 경로로 잡은
  // 채" 접속하면 문제가 될 수 있다), options 파라미터를 제거한 "control" 접속 문자열을 따로 만든다.
  // 실제 대상 스키마는 아래 DDL에서 이름을 직접 지정해 지정한다 — 원래 접속 문자열을 그대로 재사용
  // 하면, drop 직후 같은 커넥션이 이미 지워버린 스키마를 search_path로 물고 있어 다음 create 문이
  // 꼬일 수 있는 함정.
  controlUrl.searchParams.delete("options");
  const pool = new Pool({ connectionString: controlUrl.toString() });
  const quotedSchema = `"${target.schema}"`;

  try {
    const client = await pool.connect();
    try {
      // [INTV:EDGE] Postgres는 DDL(스키마 생성/삭제 등)도 트랜잭션 안에서 묶을 수 있다(다수의
      // 다른 DB는 지원하지 않는 특징 — MySQL 등은 DDL이 암묵적 커밋을 유발해 트랜잭션에 못 묶인다) —
      // drop과 create 사이에 실패해도 begin/commit으로 감싸 둔 덕분에 "스키마가 지워졌는데 새로
      // 만들어지진 않은" 어중간한 상태로 남지 않는다.
      await client.query("begin");
      await client.query(`drop schema if exists ${quotedSchema} cascade`);
      await client.query(`create schema ${quotedSchema}`);
      await client.query("commit");
    } catch (error) {
      // [INTV:EDGE] rollback 자체가 실패할 수도 있다(커넥션이 이미 끊겼다거나) — 그 경우에도 원래
      // 에러가 묻히지 않도록 rollback 실패는 조용히 무시하고 원래 error를 그대로 던진다(정리 작업의
      // 실패가 원래 실패의 진짜 원인을 가려서는 안 된다는 원칙).
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }

  // 스키마를 비워냈으니 그 위에 마이그레이션을 다시 적용해 테스트가 기대하는 테이블 구조를 만든다.
  await migrateDatabase(target.databaseUrl);
  return target;
}

// [INTV:TRAP] 반환 타입 never: 이 함수는 정상적으로 값을 반환하는 경우가 없고 항상 예외를 던진다는
// 것을 타입 시스템에 알린다(httpBoundary.ts의 unauthorized()/notFound() 등과 같은 패턴) — 덕분에
// 호출부에서 `return unsafeTarget()`처럼 써도, 실제로는 아무것도 반환하지 않지만 "이 분기는 여기서
// 함수가 끝난다"는 게 타입 체크에 반영된다.
function unsafeTarget(): never {
  throw new Error("Unsafe test reset target");
}

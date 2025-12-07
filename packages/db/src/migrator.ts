import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { basename, extname, join } from "node:path";
import {
  Kysely,
  Migrator,
  PostgresDialect,
  sql,
  type Migration,
  type MigrationProvider
} from "kysely";
import { Pool } from "pg";
import type { Database } from "./schema.js";

// [INTV:TRAP] import.meta.url: ESM(Node의 "type": "module" 방식)에서 CommonJS의 __dirname 대신
// 쓰는, 현재 파일의 file:// URL. fileURLToPath로 일반 파일시스템 경로로 바꾼다. 후보가 두 개인
// 이유: 개발 중(tsx로 src/를 직접 실행할 때)엔 이 파일과 같은 위치의 ./migrations를, 빌드 후
// (dist/에서 실행할 때, package.json의 build 스크립트가 migrations 폴더를 dist/ 밑에 복사해둔다)엔
// ../migrations를 찾아야 하기 때문 — 두 실행 방식을 모두 지원하기 위한 폴백. 경로 하나만 하드코딩
// 하면 개발 환경에서는 되다가 빌드된 배포 환경에서만 "마이그레이션 파일을 못 찾음" 에러로 깨지는
// 흔한 함정.
const migrationDirectoryCandidates = [
  fileURLToPath(new URL("./migrations", import.meta.url)),
  fileURLToPath(new URL("../migrations", import.meta.url))
];

// [INTV:ARCH] kysely의 MigrationProvider: "마이그레이션 목록을 어떻게 구해올지"를 커스터마이즈하는
// 확장 지점. kysely 기본 제공 FileMigrationProvider는 .ts/.js 마이그레이션 파일을 기대하지만, 이
// 프로젝트는 순수 .sql 파일로 마이그레이션을 관리하므로 직접 구현했다 — 각 .sql 파일을 읽어 "up
// 함수가 그 SQL을 그대로 실행하는" Migration으로 감싼다(라이브러리의 확장 지점을 활용해 프로젝트
// 고유의 마이그레이션 포맷을 유지하면서도 kysely의 Migrator 인프라 — 적용 이력 추적, 롤백 등 —
// 는 그대로 재사용).
class SqlMigrationProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    const { directory, filenames } = await findMigrationFiles();
    const migrationFilenames = filenames
      .filter((filename) => extname(filename) === ".sql")
      .sort();
    const migrations = await Promise.all(
      migrationFilenames.map(async (filename) => {
        const statement = await readFile(join(directory, filename), "utf8");
        return [
          basename(filename, ".sql"),
          {
            // [INTV:EDGE] sql.raw(...): kysely가 값을 이스케이프/파라미터화하지 않고 SQL 문자열을
            // 그대로 실행하게 하는 API. 마이그레이션 파일 내용은 신뢰된 소스(레포에 커밋된 파일)
            // 이므로 그대로 실행해도 안전하다는 전제 — 사용자 입력을 sql.raw에 넣으면 SQL 인젝션이
            // 되므로, 이 전제(신뢰된 소스만)가 깨지는 순간 위험해진다.
            up: async (db) => {
              await sql.raw(statement).execute(db);
            }
            // [INTV:TRAP] satisfies Migration: 이 객체 리터럴이 Migration 타입 요건(최소 up 함수)을
            // 만족하는지만 검사하고, 타입 자체를 Migration으로 넓히지는 않는다 — `as Migration`으로
            // 썼다면 타입이 강제로 Migration으로 좁아져 이후 코드에서 이 객체의 실제 리터럴 타입
            // 정보(예: 추가 필드)를 잃어버렸을 것. satisfies는 타입 체크만 하고 추론된 타입은
            // 그대로 보존한다는 게 as와의 핵심 차이.
          } satisfies Migration
        ] as const;
      })
    );

    return Object.fromEntries(migrations);
  }
}

async function findMigrationFiles(): Promise<{ directory: string; filenames: string[] }> {
  let lastError: unknown;
  // 후보 경로를 순서대로 시도하다 처음 성공하는 것을 쓴다 — 개발/빌드 두 실행 환경을 하나의 코드로 지원하기 위한 반복.
  for (const directory of migrationDirectoryCandidates) {
    try {
      return { directory, filenames: await readdir(directory) };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error("Bundled database migrations were not found", { cause: lastError });
}

export interface MigrationSetComparison {
  status: "current" | "pending" | "diverged";
  missing: string[];
  unexpected: string[];
}

// [INTV:ARCH] "코드에 정의된 마이그레이션 목록"과 "DB에 실제 적용된 마이그레이션 목록"을 비교하는
// 순수 함수(http.ts의 readyHealthResponseSchema의 migrations 필드가 이 결과를 그대로 반영).
// pending: 코드엔 있는데 DB엔 아직 적용 안 된 것이 있음(정상적인 배포 대기 상태).
// diverged: DB에 코드가 모르는 마이그레이션이 적용돼 있음(배포 순서가 꼬였거나 수동으로 건드렸을
// 가능성) — 헬스체크에서 이 상태가 보이면 즉시 조사해야 할 위험 신호.
export function compareMigrationSets(
  expectedNames: string[],
  appliedNames: string[]
): MigrationSetComparison {
  const expected = new Set(expectedNames);
  const applied = new Set(appliedNames);
  const missing = expectedNames.filter((name) => !applied.has(name));
  const unexpected = appliedNames.filter((name) => !expected.has(name));
  return {
    status: unexpected.length > 0 ? "diverged" : missing.length > 0 ? "pending" : "current",
    missing,
    unexpected
  };
}

export async function inspectMigrationSet(
  db: Kysely<Database>
): Promise<MigrationSetComparison> {
  const expectedNames = Object.keys(await new SqlMigrationProvider().getMigrations()).sort();
  let appliedNames: string[];
  try {
    // [INTV:ARCH] kysely_migration: kysely의 Migrator가 "어떤 마이그레이션을 이미 적용했는지"
    // 스스로 기록해두는 내부 테이블. 여기선 그 부기 테이블을 직접 조회해서 현재 적용 상태를 읽는다
    // (헬스체크 등에서 실제 마이그레이션을 실행하지 않고 상태만 확인하고 싶을 때 쓰는 용도 — 읽기
    // 전용 조회와 실제 migrateToLatest() 실행을 분리해, 헬스체크 호출이 실수로 마이그레이션을
    // 트리거하지 않도록 한다).
    const applied = await sql<{ name: string }>`
      select name from kysely_migration order by name
    `.execute(db);
    appliedNames = applied.rows.map((row) => row.name);
  } catch (error) {
    // 아직 한 번도 마이그레이션을 실행한 적 없는 새 DB라면 이 테이블 자체가 없다 — 그 경우를 "적용된 것 없음"으로 취급.
    if (!isUndefinedTableError(error)) throw error;
    appliedNames = [];
  }
  return compareMigrationSets(expectedNames, appliedNames);
}

export async function migrateDatabase(databaseUrl: string, targetMigration?: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });

  try {
    const migrator = new Migrator({
      db,
      provider: new SqlMigrationProvider()
    });
    // [INTV:ARCH] migrateTo(이름)은 특정 마이그레이션까지만(롤백 포함) 적용, migrateToLatest()는
    // 아직 안 적용된 것을 전부 순서대로 적용.
    const { error, results } = targetMigration
      ? await migrator.migrateTo(targetMigration)
      : await migrator.migrateToLatest();

    if (error) {
      // results는 시도한 각 마이그레이션의 실행 결과 배열 — 그중 실패한 것을 찾아 에러 메시지에 이름을 덧붙인다.
      const failedMigration = results?.find((result) => result.status === "Error");
      const suffix = failedMigration ? ` (${failedMigration.migrationName})` : "";
      throw new Error(`Database migration failed${suffix}`, { cause: error });
    }
  } finally {
    // 성공하든 실패하든 커넥션 풀을 반드시 닫아 프로세스가 열린 소켓 때문에 종료되지 않도록 한다.
    await db.destroy();
  }
}

// [INTV:EDGE] Postgres 에러 코드 42P01은 "undefined_table"(존재하지 않는 테이블 조회) —
// kysely_migration 테이블이 아직 없는, 즉 마이그레이션을 한 번도 실행하지 않은 DB임을 식별하는 데
// 쓴다(poolError.ts처럼 여기서도 "code" in error로 타입을 좁혀 접근).
function isUndefinedTableError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "42P01";
}

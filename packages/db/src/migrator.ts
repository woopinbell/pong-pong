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

const migrationDirectoryCandidates = [
  fileURLToPath(new URL("./migrations", import.meta.url)),
  fileURLToPath(new URL("../migrations", import.meta.url))
];

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
            up: async (db) => {
              await sql.raw(statement).execute(db);
            }
          } satisfies Migration
        ] as const;
      })
    );

    return Object.fromEntries(migrations);
  }
}

async function findMigrationFiles(): Promise<{ directory: string; filenames: string[] }> {
  let lastError: unknown;
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
    const applied = await sql<{ name: string }>`
      select name from kysely_migration order by name
    `.execute(db);
    appliedNames = applied.rows.map((row) => row.name);
  } catch (error) {
    if (!isUndefinedTableError(error)) throw error;
    appliedNames = [];
  }
  return compareMigrationSets(expectedNames, appliedNames);
}

export async function migrateDatabase(databaseUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });

  try {
    const migrator = new Migrator({
      db,
      provider: new SqlMigrationProvider()
    });
    const { error, results } = await migrator.migrateToLatest();

    if (error) {
      const failedMigration = results?.find((result) => result.status === "Error");
      const suffix = failedMigration ? ` (${failedMigration.migrationName})` : "";
      throw new Error(`Database migration failed${suffix}`, { cause: error });
    }
  } finally {
    await db.destroy();
  }
}

function isUndefinedTableError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "42P01";
}

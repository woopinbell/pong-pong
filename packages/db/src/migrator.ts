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

const migrationsDirectory = fileURLToPath(
  new URL("../migrations", import.meta.url)
);

class SqlMigrationProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    const filenames = (await readdir(migrationsDirectory))
      .filter((filename) => extname(filename) === ".sql")
      .sort();
    const migrations = await Promise.all(
      filenames.map(async (filename) => {
        const statement = await readFile(join(migrationsDirectory, filename), "utf8");
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

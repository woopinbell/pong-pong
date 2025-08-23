import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { initialMigrationSql } from "./migrations";
import type { Database } from "./schema";

export type { Database } from "./schema";

export interface AppRepository {
  close(): Promise<void>;
  ensureSeedData(): Promise<void>;
}

export function createPostgresRepository(databaseUrl: string): AppRepository {
  const pool = new Pool({ connectionString: databaseUrl });
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  return new PostgresRepository(db, pool);
}

export function createMemoryRepository(): AppRepository {
  return new MemoryRepository();
}

class PostgresRepository implements AppRepository {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly pool: Pool
  ) {}

  async close(): Promise<void> {
    await this.db.destroy();
    await this.pool.end().catch(() => undefined);
  }

  async ensureSeedData(): Promise<void> {
    await sql.raw(initialMigrationSql).execute(this.db);
  }
}

class MemoryRepository implements AppRepository {
  async close(): Promise<void> {}

  async ensureSeedData(): Promise<void> {}
}

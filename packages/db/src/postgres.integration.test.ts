import { randomUUID } from "node:crypto";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createPostgresRepository, type AppRepository } from "./index";
import { migrateDatabase } from "./migrator";

const POSTGRES_IMAGE = "postgres:16-alpine";
const TEST_DATABASE = "pong_pong_test";
const TEST_USERNAME = "pong";
const TEST_PASSWORD = "pong";

type StartedPostgres = Awaited<ReturnType<PostgreSqlContainer["start"]>>;

interface IsolatedDatabaseContext {
  schema: string;
  databaseUrl: string;
  openPool(): Pool;
  openRepository(): AppRepository;
}

let container: StartedPostgres | undefined;
let adminPool: Pool | undefined;

beforeAll(async () => {
  container = await startPostgresContainer();
  adminPool = new Pool({
    connectionString: container.getConnectionUri(),
    connectionTimeoutMillis: 5_000,
    max: 2
  });
  await adminPool.query("select 1");
});

afterAll(async () => {
  try {
    await adminPool?.end();
  } finally {
    await container?.stop({ timeout: 10_000 });
  }
});

describe("PostgreSQL integration", () => {
  it("migrates an empty schema and leaves a repeated migration unchanged", async () => {
    await withIsolatedDatabase(async ({ databaseUrl, openPool, schema }) => {
      const pool = openPool();
      const before = await pool.query<{ users: string | null }>(
        "select to_regclass('users')::text as users"
      );
      expect(before.rows[0]?.users).toBeNull();

      await migrateDatabase(databaseUrl);

      const firstTables = await tableNames(pool, schema);
      expect(firstTables).toEqual(expect.arrayContaining([
        "admin_actions",
        "chat_messages",
        "friendships",
        "matches",
        "sessions",
        "tournament_entries",
        "tournament_matches",
        "tournaments",
        "users"
      ]));
      const firstMigrations = await appliedMigrations(pool);
      expect(firstMigrations).toEqual(["001_initial"]);

      await migrateDatabase(databaseUrl);

      expect(await tableNames(pool, schema)).toEqual(firstTables);
      expect(await appliedMigrations(pool)).toEqual(firstMigrations);
    }, { migrate: false });
  });

  it("keeps the demo seed limited to NPC accounts", async () => {
    await withIsolatedDatabase(async ({ openPool, openRepository }) => {
      const repository = openRepository();
      await repository.ensureSeedData("demo");
      await repository.ensureSeedData("demo");

      const users = await openPool().query<{
        handle: string;
        is_npc: boolean;
        role: string;
      }>("select handle, is_npc, role from users order by handle");

      expect(users.rows).toHaveLength(4);
      expect(users.rows.every((user) => user.is_npc)).toBe(true);
      expect(users.rows.every((user) => user.role === "user")).toBe(true);
      expect(users.rows.some((user) => user.handle === "admin")).toBe(false);
    });
  });

  it("keeps development users and administrator data out of the demo seed", async () => {
    await withIsolatedDatabase(async ({ openPool, openRepository }) => {
      const repository = openRepository();
      await repository.ensureSeedData("development");
      await repository.ensureSeedData("development");

      const users = await openPool().query<{
        handle: string;
        is_npc: boolean;
        role: string;
      }>("select handle, is_npc, role from users order by handle");
      const players = users.rows.filter((user) => !user.is_npc);

      expect(users.rows).toHaveLength(9);
      expect(players.map((user) => user.handle)).toEqual([
        "admin",
        "net-ninja",
        "paddle-pro",
        "spin-doctor",
        "top-spin"
      ]);
      expect(players.find((user) => user.handle === "admin")?.role).toBe("admin");
    });
  });

  it("uses a fresh schema for each isolated database", async () => {
    let firstSchema = "";

    await withIsolatedDatabase(async ({ openRepository, schema }) => {
      firstSchema = schema;
      await openRepository().upsertDevUser({
        handle: "schema-owner",
        displayName: "Schema Owner"
      });
    });

    await withIsolatedDatabase(async ({ openRepository, schema }) => {
      expect(schema).not.toBe(firstSchema);
      await expect(openRepository().getUserByHandle("schema-owner")).resolves.toBeNull();
    });

    expect(await schemaExists(firstSchema)).toBe(false);
  });

  it("drops the schema and closes tracked connections when a test callback fails", async () => {
    let failedSchema = "";
    let backendPid = 0;

    await expect(withIsolatedDatabase(async ({ openPool, schema }) => {
      failedSchema = schema;
      const pool = openPool();
      const backend = await pool.query<{ pid: number }>("select pg_backend_pid() as pid");
      backendPid = backend.rows[0]?.pid ?? 0;
      throw new Error("intentional integration failure");
    })).rejects.toThrow("intentional integration failure");

    expect(await schemaExists(failedSchema)).toBe(false);
    const activeConnection = await requireAdminPool().query<{ active: boolean }>(
      "select exists(select 1 from pg_stat_activity where pid = $1) as active",
      [backendPid]
    );
    expect(activeConnection.rows[0]?.active).toBe(false);
  });

  it("stops a temporary container when its callback fails", async () => {
    let stoppedConnectionUri = "";

    await expect(withTemporaryPostgres(async (temporaryContainer) => {
      stoppedConnectionUri = temporaryContainer.getConnectionUri();
      const mappedPort = Number(new URL(stoppedConnectionUri).port);
      expect(mappedPort).toBe(temporaryContainer.getPort());
      expect(mappedPort).toBeGreaterThan(0);

      const pool = new Pool({
        connectionString: stoppedConnectionUri,
        connectionTimeoutMillis: 2_000,
        max: 1
      });
      try {
        await pool.query("select 1");
      } finally {
        await pool.end();
      }
      throw new Error("intentional container failure");
    })).rejects.toThrow("intentional container failure");

    const stoppedPool = new Pool({
      connectionString: stoppedConnectionUri,
      connectionTimeoutMillis: 1_000,
      max: 1
    });
    try {
      await expect(stoppedPool.query("select 1")).rejects.toThrow();
    } finally {
      await stoppedPool.end();
    }
  });
});

async function startPostgresContainer(): Promise<StartedPostgres> {
  return new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase(TEST_DATABASE)
    .withUsername(TEST_USERNAME)
    .withPassword(TEST_PASSWORD)
    .start();
}

async function withTemporaryPostgres<T>(
  callback: (temporaryContainer: StartedPostgres) => Promise<T>
): Promise<T> {
  const temporaryContainer = await startPostgresContainer();
  try {
    return await callback(temporaryContainer);
  } finally {
    await temporaryContainer.stop({ timeout: 10_000 });
  }
}

async function withIsolatedDatabase<T>(
  callback: (context: IsolatedDatabaseContext) => Promise<T>,
  options: { migrate?: boolean } = {}
): Promise<T> {
  const activeContainer = requireContainer();
  const pool = requireAdminPool();
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  const quotedSchema = quoteSchema(schema);
  const databaseUrl = withSearchPath(activeContainer.getConnectionUri(), schema);
  const cleanupTasks: Array<() => Promise<void>> = [];
  let callbackError: unknown;

  await pool.query(`create schema ${quotedSchema}`);

  const context: IsolatedDatabaseContext = {
    schema,
    databaseUrl,
    openPool() {
      const isolatedPool = new Pool({
        connectionString: databaseUrl,
        connectionTimeoutMillis: 5_000,
        max: 2
      });
      cleanupTasks.push(() => isolatedPool.end());
      return isolatedPool;
    },
    openRepository() {
      const repository = createPostgresRepository(databaseUrl);
      cleanupTasks.push(() => repository.close());
      return repository;
    }
  };

  try {
    if (options.migrate !== false) {
      await migrateDatabase(databaseUrl);
    }
    return await callback(context);
  } catch (error) {
    callbackError = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    for (const cleanup of cleanupTasks.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await pool.query(`drop schema if exists ${quotedSchema} cascade`);
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (callbackError === undefined && cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "Failed to clean up isolated PostgreSQL test resources");
    }
  }
}

async function tableNames(pool: Pool, schema: string): Promise<string[]> {
  const result = await pool.query<{ tablename: string }>(
    "select tablename from pg_tables where schemaname = $1 order by tablename",
    [schema]
  );
  return result.rows.map((row) => row.tablename);
}

async function appliedMigrations(pool: Pool): Promise<string[]> {
  const result = await pool.query<{ name: string }>(
    "select name from kysely_migration order by name"
  );
  return result.rows.map((row) => row.name);
}

async function schemaExists(schema: string): Promise<boolean> {
  const result = await requireAdminPool().query<{ exists: boolean }>(
    "select exists(select 1 from pg_namespace where nspname = $1) as exists",
    [schema]
  );
  return result.rows[0]?.exists ?? false;
}

function withSearchPath(databaseUrl: string, schema: string): string {
  quoteSchema(schema);
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-c search_path=${schema}`);
  return url.toString();
}

function quoteSchema(schema: string): string {
  if (!/^test_[a-f0-9]{32}$/.test(schema)) {
    throw new Error(`Unsafe test schema name: ${schema}`);
  }
  return `"${schema}"`;
}

function requireContainer(): StartedPostgres {
  if (!container) {
    throw new Error("PostgreSQL test container is not running");
  }
  return container;
}

function requireAdminPool(): Pool {
  if (!adminPool) {
    throw new Error("PostgreSQL admin pool is not connected");
  }
  return adminPool;
}

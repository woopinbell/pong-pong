import { randomUUID } from "node:crypto";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import type { PublicUser, SessionUser } from "@pong-pong/shared";
import { initialMigrationSql } from "./migrations";
import { toPublicUser, toSessionUser } from "./rowMappers";
import type { Database, MemoryUserRow, UserRow } from "./schema";

export type { Database } from "./schema";

export interface DevLoginInput {
  handle: string;
  displayName: string;
  email?: string | null;
}

export interface AppRepository {
  close(): Promise<void>;
  ensureSeedData(): Promise<void>;
  upsertDevUser(input: DevLoginInput): Promise<SessionUser>;
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
    const players: DevLoginInput[] = [
      { handle: "spin-doctor", displayName: "스핀닥터", email: "spin@pong.local" },
      { handle: "paddle-pro", displayName: "패들프로", email: "paddle@pong.local" },
      { handle: "net-ninja", displayName: "네트닌자", email: "net@pong.local" },
      { handle: "top-spin", displayName: "탑스핀", email: "top@pong.local" },
      { handle: "admin", displayName: "운영자", email: "admin@pong.local" }
    ];
    for (const player of players) {
      await this.upsertDevUser(player);
    }
    await sql`update users set role = 'admin', rating = 1680 where handle = 'admin'`.execute(this.db);
    await sql`update users set rating = 1723, wins = 32, losses = 11 where handle = 'spin-doctor'`.execute(this.db);
    await sql`update users set rating = 1640, wins = 24, losses = 13 where handle = 'paddle-pro'`.execute(this.db);
    await sql`update users set rating = 1512, wins = 18, losses = 15 where handle = 'net-ninja'`.execute(this.db);
    await sql`update users set rating = 1450, wins = 15, losses = 17 where handle = 'top-spin'`.execute(this.db);
  }

  async upsertDevUser(input: DevLoginInput): Promise<SessionUser> {
    const handle = normalizeHandle(input.handle);
    const email = input.email ?? `${handle}@dev.pong-pong.local`;
    const displayName = input.displayName.trim() || handle;
    const result = await sql<UserRow>`
      insert into users (email, handle, display_name, avatar_key, role)
      values (${email}, ${handle}, ${displayName}, ${avatarFor(handle)}, ${handle === "admin" ? "admin" : "user"})
      on conflict (handle) do update set
        email = excluded.email,
        display_name = excluded.display_name
      returning *
    `.execute(this.db);
    return toSessionUser(firstRow(result));
  }

}

class MemoryRepository implements AppRepository {
  private readonly users = new Map<string, MemoryUserRow>();

  async close(): Promise<void> {}

  async ensureSeedData(): Promise<void> {
    for (const player of [
      { handle: "spin-doctor", displayName: "스핀닥터", email: "spin@pong.local" },
      { handle: "paddle-pro", displayName: "패들프로", email: "paddle@pong.local" },
      { handle: "net-ninja", displayName: "네트닌자", email: "net@pong.local" },
      { handle: "admin", displayName: "운영자", email: "admin@pong.local" }
    ]) {
      await this.upsertDevUser(player);
    }
  }

  async upsertDevUser(input: DevLoginInput): Promise<SessionUser> {
    const handle = normalizeHandle(input.handle);
    const existing = [...this.users.values()].find((user) => user.handle === handle);
    const user: MemoryUserRow = existing ?? {
      id: randomUUID(),
      email: input.email ?? `${handle}@dev.pong-pong.local`,
      handle,
      display_name: input.displayName || handle,
      avatar_key: avatarFor(handle),
      role: handle === "admin" ? "admin" : "user",
      status: "active",
      rating: handle === "admin" ? 1680 : 1200,
      wins: 0,
      losses: 0
    };
    user.display_name = input.displayName || user.display_name;
    this.users.set(user.id, user);
    return toSessionUser(user, true);
  }

}

function firstRow<T>(result: { rows: T[] }): T {
  const row = result.rows[0];
  if (!row) throw new Error("expected database row");
  return row;
}

function normalizeHandle(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "player";
}

function avatarFor(handle: string): string {
  const avatars = ["blue", "green", "amber", "violet", "rose"];
  return avatars[Math.abs([...handle].reduce((sum, char) => sum + char.charCodeAt(0), 0)) % avatars.length];
}

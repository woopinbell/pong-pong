import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createPostgresRepository, type AppRepository } from "./index";
import { migrateDatabase } from "./migrator";
import { resetTestDatabase } from "./testReset";

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
  it("reports pending migrations before migrate and current migrations afterward", async () => {
    await withIsolatedDatabase(async ({ databaseUrl, openRepository }) => {
      const repository = openRepository();

      await expect(repository.checkReadiness()).resolves.toEqual({
        database: "up",
        migrations: "pending"
      });

      await migrateDatabase(databaseUrl);

      await expect(repository.checkReadiness()).resolves.toEqual({
        database: "up",
        migrations: "current"
      });
    }, { migrate: false });
  });

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
        "rating_history",
        "sessions",
        "tournament_entries",
        "tournament_matches",
        "tournaments",
        "users",
        "ws_tickets"
      ]));
      const firstMigrations = await appliedMigrations(pool);
      expect(firstMigrations).toEqual([
        "001_initial",
        "002_ws_tickets",
        "003_match_finalization",
        "004_friendship_tournament_invariants",
        "005_expire_legacy_sessions"
      ]);

      await migrateDatabase(databaseUrl);

      expect(await tableNames(pool, schema)).toEqual(firstTables);
      expect(await appliedMigrations(pool)).toEqual(firstMigrations);
    }, { migrate: false });
  });

  it("expires legacy sessions without changing users or match history", async () => {
    await withIsolatedDatabase(async ({ databaseUrl, openPool, openRepository }) => {
      await migrateDatabase(databaseUrl, "004_friendship_tournament_invariants");

      const repository = openRepository();
      const pool = openPool();
      const winner = await repository.upsertDevUser({
        handle: "auth-migration-winner",
        displayName: "Auth Migration Winner"
      });
      const loser = await repository.upsertDevUser({
        handle: "auth-migration-loser",
        displayName: "Auth Migration Loser"
      });
      const sessionToken = await repository.createSession(winner.id);
      await repository.finalizeMatch({
        resultKey: "room:auth-migration:finished",
        mode: "queue",
        winnerId: winner.id,
        loserId: loser.id,
        scoreLeft: 3,
        scoreRight: 1
      });
      const before = await authMigrationSnapshot(pool);
      await expect(repository.getSessionUser(sessionToken)).resolves.toMatchObject({ id: winner.id });

      await migrateDatabase(databaseUrl);

      await expect(repository.getSessionUser(sessionToken)).resolves.toBeNull();
      expect(await authMigrationSnapshot(pool)).toEqual(before);
      await expect(pool.query<{ count: number }>(
        "select count(*)::integer as count from sessions"
      )).resolves.toMatchObject({ rows: [{ count: 0 }] });
      expect(await appliedMigrations(pool)).toContain("005_expire_legacy_sessions");
    }, { migrate: false });
  });

  it("resets only the selected isolated schema and reapplies migrations", async () => {
    const siblingSchema = `test_${randomUUID().replaceAll("-", "")}`;
    const pool = requireAdminPool();
    await pool.query(`create schema ${quoteSchema(siblingSchema)}`);
    await pool.query(`create table ${quoteSchema(siblingSchema)}.reset_guard_marker (id integer primary key)`);

    try {
      await withIsolatedDatabase(async ({ databaseUrl, openPool, openRepository }) => {
        const repository = openRepository();
        const isolatedPool = openPool();
        await repository.upsertDevUser({
          handle: "reset-test-user",
          displayName: "Reset Test User"
        });

        await resetTestDatabase({ NODE_ENV: "test", TEST_DATABASE_URL: databaseUrl });

        await expect(isolatedPool.query<{ count: number }>(
          "select count(*)::integer as count from users"
        )).resolves.toMatchObject({ rows: [{ count: 0 }] });
        await expect(repository.checkReadiness()).resolves.toEqual({
          database: "up",
          migrations: "current"
        });
        const sibling = await pool.query<{ exists: boolean }>(
          "select exists(select 1 from pg_tables where schemaname = $1 and tablename = 'reset_guard_marker') as exists",
          [siblingSchema]
        );
        expect(sibling.rows[0]?.exists).toBe(true);
      });
    } finally {
      await pool.query(`drop schema if exists ${quoteSchema(siblingSchema)} cascade`);
    }
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

  it("grants administrator access only through an explicit role assignment", async () => {
    await withIsolatedDatabase(async ({ openRepository }) => {
      const repository = openRepository();
      await repository.ensureSeedData("development");

      const loginUser = await repository.upsertDevUser({
        handle: "admin",
        displayName: "일반 사용자"
      });
      expect(loginUser.role).toBe("user");

      const promoted = await repository.setUserRoleByHandle("admin", "admin");
      expect(promoted.role).toBe("admin");
    });
  });

  it("rolls back a ban when its audit record cannot be written", async () => {
    await withIsolatedDatabase(async ({ openPool, openRepository }) => {
      const repository = openRepository();
      const pool = openPool();
      const actor = await repository.upsertDevUser({
        handle: "ban-transaction-actor",
        displayName: "Ban Transaction Actor"
      });
      const target = await repository.upsertDevUser({
        handle: "ban-transaction-target",
        displayName: "Ban Transaction Target"
      });
      await pool.query(`
        alter table admin_actions
        add constraint admin_actions_reject_test_reason
        check (reason <> 'force audit failure')
      `);

      await expect(repository.setUserBan(
        actor.id,
        target.id,
        true,
        "force audit failure"
      )).rejects.toMatchObject({ constraint: "admin_actions_reject_test_reason" });

      const storedUser = await pool.query<{ status: string; banned_at: Date | null }>(
        "select status, banned_at from users where id = $1",
        [target.id]
      );
      expect(storedUser.rows).toEqual([{ status: "active", banned_at: null }]);
      await expect(pool.query<{ count: number }>(
        "select count(*)::integer as count from admin_actions"
      )).resolves.toMatchObject({ rows: [{ count: 0 }] });
    });
  });

  it("stores only ticket hashes and consumes a ticket atomically once", async () => {
    await withIsolatedDatabase(async ({ openPool, openRepository }) => {
      const repository = openRepository();
      const pool = openPool();
      const user = await repository.upsertDevUser({
        handle: "ws-ticket-user",
        displayName: "WS Ticket User"
      });
      const rawTicket = randomBytes(32).toString("base64url");
      const ticketHash = createHash("sha256").update(rawTicket, "utf8").digest("hex");

      await repository.createWsTicket({
        userId: user.id,
        ticketHash,
        ttlSeconds: 30
      });

      const columns = await pool.query<{ column_name: string }>(
        "select column_name from information_schema.columns where table_schema = current_schema() and table_name = 'ws_tickets' order by column_name"
      );
      expect(columns.rows.map((row) => row.column_name)).toEqual([
        "created_at",
        "expires_at",
        "ticket_hash",
        "user_id"
      ]);
      const stored = await pool.query<{ ticket_hash: string; ttl_seconds: number }>(
        "select ticket_hash, extract(epoch from expires_at - created_at)::integer as ttl_seconds from ws_tickets"
      );
      expect(stored.rows).toEqual([{ ticket_hash: ticketHash, ttl_seconds: 30 }]);
      expect(JSON.stringify(stored.rows)).not.toContain(rawTicket);

      const attempts = await Promise.all(
        Array.from({ length: 20 }, () => repository.consumeWsTicket(ticketHash))
      );
      const successful = attempts.filter((result) => result !== null);
      expect(successful).toHaveLength(1);
      expect(successful[0]?.id).toBe(user.id);
      await expect(repository.consumeWsTicket(ticketHash)).resolves.toBeNull();

      const remaining = await pool.query<{ count: number }>(
        "select count(*)::integer as count from ws_tickets"
      );
      expect(remaining.rows[0]?.count).toBe(0);
    });
  });

  it("applies a match result and rating changes once across 20 concurrent calls", async () => {
    await withIsolatedDatabase(async ({ openPool, openRepository }) => {
      const repository = openRepository();
      const pool = openPool();
      const winner = await repository.upsertDevUser({
        handle: "finalize-winner",
        displayName: "Finalize Winner"
      });
      const loser = await repository.upsertDevUser({
        handle: "finalize-loser",
        displayName: "Finalize Loser"
      });
      const command = {
        resultKey: "room:postgres-finalize:finished",
        mode: "queue" as const,
        winnerId: winner.id,
        loserId: loser.id,
        scoreLeft: 3,
        scoreRight: 1
      };

      const results = await Promise.all(
        Array.from({ length: 20 }, () => repository.finalizeMatch(command))
      );

      expect(new Set(results.map((result) => result.matchId)).size).toBe(1);
      expect(results.filter((result) => result.created)).toHaveLength(1);

      const matches = await pool.query<{
        id: string;
        result_key: string;
      }>("select id, result_key from matches");
      expect(matches.rows).toEqual([{
        id: results[0].matchId,
        result_key: command.resultKey
      }]);

      const users = await pool.query<{
        handle: string;
        rating: number;
        wins: number;
        losses: number;
      }>(
        "select handle, rating, wins, losses from users where id = any($1::uuid[]) order by handle",
        [[winner.id, loser.id]]
      );
      expect(users.rows).toEqual([
        { handle: "finalize-loser", rating: loser.rating - 12, wins: 0, losses: 1 },
        { handle: "finalize-winner", rating: winner.rating + 16, wins: 1, losses: 0 }
      ]);

      const history = await pool.query<{
        handle: string;
        rating_before: number;
        rating_after: number;
        delta: number;
      }>(`
        select u.handle, h.rating_before, h.rating_after, h.delta
        from rating_history h
        join users u on u.id = h.user_id
        order by u.handle
      `);
      expect(history.rows).toEqual([
        {
          handle: "finalize-loser",
          rating_before: loser.rating,
          rating_after: loser.rating - 12,
          delta: -12
        },
        {
          handle: "finalize-winner",
          rating_before: winner.rating,
          rating_after: winner.rating + 16,
          delta: 16
        }
      ]);
    });
  });

  it("rolls back the result and ratings when tournament linking fails", async () => {
    await withIsolatedDatabase(async ({ openPool, openRepository }) => {
      const repository = openRepository();
      const pool = openPool();
      const winner = await repository.upsertDevUser({
        handle: "rollback-winner",
        displayName: "Rollback Winner"
      });
      const loser = await repository.upsertDevUser({
        handle: "rollback-loser",
        displayName: "Rollback Loser"
      });
      const resultKey = "room:rollback-finalize:finished";

      await expect(repository.finalizeMatch({
        resultKey,
        mode: "tournament",
        winnerId: winner.id,
        loserId: loser.id,
        scoreLeft: 3,
        scoreRight: 0,
        tournament: {
          tournamentMatchId: randomUUID(),
          roomId: "rollback-finalize"
        }
      })).rejects.toThrow("tournament match not found");

      const counts = await pool.query<{
        matches: number;
        history: number;
      }>(`
        select
          (select count(*)::integer from matches where result_key = $1) as matches,
          (select count(*)::integer from rating_history) as history
      `, [resultKey]);
      expect(counts.rows[0]).toEqual({ matches: 0, history: 0 });

      const users = await pool.query<{
        handle: string;
        rating: number;
        wins: number;
        losses: number;
      }>(
        "select handle, rating, wins, losses from users where id = any($1::uuid[]) order by handle",
        [[winner.id, loser.id]]
      );
      expect(users.rows).toEqual([
        { handle: "rollback-loser", rating: loser.rating, wins: 0, losses: 0 },
        { handle: "rollback-winner", rating: winner.rating, wins: 0, losses: 0 }
      ]);
    });
  });

  it("rejects a tournament start when no match row is updated", async () => {
    await withIsolatedDatabase(async ({ openRepository }) => {
      const repository = openRepository();

      await expect(repository.startTournamentMatch(
        randomUUID(),
        "missing-tournament-room"
      )).rejects.toThrow("tournament match not found");
    });
  });

  it("links concurrent semifinals and creates exactly one final", async () => {
    await withIsolatedDatabase(async ({ openPool, openRepository }) => {
      const repository = openRepository();
      const pool = openPool();
      const players = await Promise.all(
        ["pg-semi-one", "pg-semi-two", "pg-semi-three", "pg-semi-four"].map((handle, index) =>
          repository.upsertDevUser({ handle, displayName: `Postgres Player ${index + 1}` })
        )
      );
      const tournament = await repository.createTournament({
        name: "Postgres Concurrent Cup",
        createdBy: players[0].id
      });
      await repository.joinTournament(tournament.id, players[1].id);
      await repository.joinTournament(tournament.id, players[2].id);
      const ready = await repository.joinTournament(tournament.id, players[3].id);
      const [semiA, semiB] = ready.matches.filter((match) => match.round === "semifinal");

      const [resultA, resultB] = await Promise.all([
        repository.finalizeMatch({
          resultKey: "room:postgres-semi-a:finished",
          mode: "tournament",
          winnerId: semiA.left?.id ?? null,
          loserId: semiA.right?.id ?? null,
          scoreLeft: 3,
          scoreRight: 1,
          tournament: { tournamentMatchId: semiA.id, roomId: "postgres-semi-a" }
        }),
        repository.finalizeMatch({
          resultKey: "room:postgres-semi-b:finished",
          mode: "tournament",
          winnerId: semiB.left?.id ?? null,
          loserId: semiB.right?.id ?? null,
          scoreLeft: 3,
          scoreRight: 2,
          tournament: { tournamentMatchId: semiB.id, roomId: "postgres-semi-b" }
        })
      ]);

      const tournamentMatches = await pool.query<{
        round: string;
        slot: number;
        status: string;
        left_user_id: string | null;
        right_user_id: string | null;
        match_id: string | null;
      }>(`
        select round, slot, status, left_user_id, right_user_id, match_id
        from tournament_matches
        where tournament_id = $1
        order by case when round = 'semifinal' then 1 else 2 end, slot
      `, [tournament.id]);
      const semifinals = tournamentMatches.rows.filter((match) => match.round === "semifinal");
      const finals = tournamentMatches.rows.filter((match) => match.round === "final");

      expect(semifinals.map((match) => match.match_id).sort()).toEqual(
        [resultA.matchId, resultB.matchId].sort()
      );
      expect(semifinals.every((match) => match.status === "finished")).toBe(true);
      expect(finals).toEqual([expect.objectContaining({
        round: "final",
        slot: 1,
        status: "ready",
        left_user_id: semiA.left?.id,
        right_user_id: semiB.left?.id,
        match_id: null
      })]);

      const counts = await pool.query<{
        matches: number;
        history: number;
        finals: number;
      }>(`
        select
          (select count(*)::integer from matches) as matches,
          (select count(*)::integer from rating_history) as history,
          (select count(*)::integer from tournament_matches where tournament_id = $1 and round = 'final') as finals
      `, [tournament.id]);
      expect(counts.rows[0]).toEqual({ matches: 2, history: 4, finals: 1 });
    });
  });

  it("enforces one friendship across both request directions", async () => {
    await withIsolatedDatabase(async ({ openPool, openRepository }) => {
      const repository = openRepository();
      const pool = openPool();
      const firstUser = await repository.upsertDevUser({
        handle: "pg-friend-first",
        displayName: "Postgres Friend One"
      });
      const secondUser = await repository.upsertDevUser({
        handle: "pg-friend-second",
        displayName: "Postgres Friend Two"
      });

      await expect(repository.requestFriend(firstUser.id, firstUser.handle)).rejects.toThrow("cannot friend yourself");

      const firstRequest = await repository.requestFriend(firstUser.id, secondUser.handle);
      const repeatedRequest = await repository.requestFriend(firstUser.id, secondUser.handle);
      const reverseRequest = await repository.requestFriend(secondUser.id, firstUser.handle);

      expect(firstRequest.status).toBe("pending");
      expect(repeatedRequest).toEqual(firstRequest);
      expect(reverseRequest).toEqual(expect.objectContaining({
        id: firstRequest.id,
        status: "accepted",
        user: expect.objectContaining({ id: firstUser.id })
      }));
      await expect(repository.listFriends(firstUser.id)).resolves.toEqual([
        expect.objectContaining({ id: firstRequest.id, status: "accepted", user: expect.objectContaining({ id: secondUser.id }) })
      ]);
      await expect(repository.listFriends(secondUser.id)).resolves.toEqual([
        expect.objectContaining({ id: firstRequest.id, status: "accepted", user: expect.objectContaining({ id: firstUser.id }) })
      ]);

      const stored = await pool.query<{
        requester_id: string;
        addressee_id: string;
        status: string;
      }>("select requester_id, addressee_id, status from friendships");
      expect(stored.rows).toEqual([{
        requester_id: firstUser.id,
        addressee_id: secondUser.id,
        status: "accepted"
      }]);

      await expect(pool.query(
        "insert into friendships (requester_id, addressee_id, status) values ($1, $1, 'pending')",
        [firstUser.id]
      )).rejects.toMatchObject({ constraint: "friendships_distinct_users_check" });
    });
  });

  it("admits exactly one of ten concurrent requests into the final tournament slot", async () => {
    await withIsolatedDatabase(async ({ openPool, openRepository }) => {
      const repository = openRepository();
      const pool = openPool();
      const creator = await repository.upsertDevUser({
        handle: "pg-capacity-owner",
        displayName: "Postgres Capacity Owner"
      });
      const earlyEntries = await Promise.all(
        ["pg-capacity-two", "pg-capacity-three"].map((handle) =>
          repository.upsertDevUser({ handle, displayName: handle })
        )
      );
      const candidates = await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          repository.upsertDevUser({
            handle: `pg-capacity-candidate-${index}`,
            displayName: `Postgres Candidate ${index}`
          })
        )
      );
      const tournament = await repository.createTournament({
        name: "Postgres Final Slot",
        createdBy: creator.id
      });
      await repository.joinTournament(tournament.id, earlyEntries[0].id);
      await repository.joinTournament(tournament.id, earlyEntries[1].id);

      const attempts = await Promise.allSettled(
        candidates.map((candidate) => repository.joinTournament(tournament.id, candidate.id))
      );
      const accepted = attempts.filter((attempt) => attempt.status === "fulfilled");
      const rejected = attempts.filter((attempt) => attempt.status === "rejected");

      expect(accepted).toHaveLength(1);
      expect(rejected).toHaveLength(9);
      expect(rejected.every((attempt) => String(attempt.reason).includes("tournament full"))).toBe(true);

      const entries = await pool.query<{ user_id: string; seed: number }>(
        "select user_id, seed from tournament_entries where tournament_id = $1 order by seed",
        [tournament.id]
      );
      const matches = await pool.query<{ round: string; slot: number }>(
        "select round, slot from tournament_matches where tournament_id = $1 order by round, slot",
        [tournament.id]
      );
      expect(entries.rows).toHaveLength(4);
      expect(entries.rows.map((entry) => entry.seed)).toEqual([1, 2, 3, 4]);
      expect(new Set(entries.rows.map((entry) => entry.user_id)).size).toBe(4);
      expect(matches.rows).toEqual([
        { round: "semifinal", slot: 1 },
        { round: "semifinal", slot: 2 }
      ]);

      const acceptedUserId = entries.rows.find((entry) => candidates.some((candidate) => candidate.id === entry.user_id))?.user_id;
      await expect(repository.joinTournament(tournament.id, acceptedUserId ?? "")).resolves.toMatchObject({
        playerCount: 4
      });
      const unchanged = await pool.query<{ entries: number; matches: number }>(`
        select
          (select count(*)::integer from tournament_entries where tournament_id = $1) as entries,
          (select count(*)::integer from tournament_matches where tournament_id = $1) as matches
      `, [tournament.id]);
      expect(unchanged.rows[0]).toEqual({ entries: 4, matches: 2 });
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

async function authMigrationSnapshot(pool: Pool) {
  const [users, matches, ratingHistory] = await Promise.all([
    pool.query("select id, handle, rating, wins, losses from users order by handle"),
    pool.query("select id, result_key, winner_id, loser_id, score_left, score_right from matches order by id"),
    pool.query("select match_id, user_id, rating_before, rating_after, delta from rating_history order by user_id")
  ]);
  return {
    users: users.rows,
    matches: matches.rows,
    ratingHistory: ratingHistory.rows
  };
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

import { createMemoryRepository, createPostgresRepository } from "./index.js";
import { migrateDatabase } from "./migrator.js";
import { resetTestDatabase } from "./testReset.js";

const command = process.argv[2];

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
      await repo.close();
    }
  }
}

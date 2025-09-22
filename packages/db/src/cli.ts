import { createMemoryRepository, createPostgresRepository } from "./index";
import { migrateDatabase } from "./migrator";

const command = process.argv[2];

if (command === "memory-smoke") {
  const memory = createMemoryRepository();
  await memory.ensureSeedData();
  await memory.close();
  console.log("ok");
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
      } else {
        throw new Error("Usage: pnpm --filter @pong-pong/db migrate|seed:dev|seed:demo|memory-smoke");
      }
    } finally {
      await repo.close();
    }
  }
}

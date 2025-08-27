import { createMemoryRepository, createPostgresRepository } from "./index";

const command = process.argv[2];
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for database CLI commands");
}

const repo = createPostgresRepository(databaseUrl);

try {
  if (command === "migrate" || command === "seed") {
    await repo.ensureSeedData();
    console.log(command === "migrate" ? "migrated" : "seeded");
  } else if (command === "memory-smoke") {
    const memory = createMemoryRepository();
    await memory.ensureSeedData();
    await memory.close();
    console.log("ok");
  } else {
    throw new Error("Usage: pnpm --filter @pong-pong/db migrate|seed");
  }
} finally {
  await repo.close();
}

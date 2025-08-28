import { createMemoryRepository, createPostgresRepository } from "@pong-pong/db";
import { buildApp } from "./app";
import { readEnv } from "./env";

const env = readEnv();
const repo = env.databaseUrl ? createPostgresRepository(env.databaseUrl) : createMemoryRepository();
await repo.ensureSeedData();

const app = buildApp({ repo, webOrigin: env.webOrigin });
app.addHook("onClose", async () => {
  await repo.close();
});

try {
  await app.listen({ port: env.port, host: "0.0.0.0" });
} catch (error) {
  app.log.error(error);
  await repo.close();
  process.exit(1);
}

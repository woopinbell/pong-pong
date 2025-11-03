import { createMemoryRepository, createPostgresRepository } from "@pong-pong/db";
import { buildApp } from "./app.js";
import { readEnv } from "./env.js";

const env = readEnv();
const repo = env.databaseUrl ? createPostgresRepository(env.databaseUrl) : createMemoryRepository();
if (!env.databaseUrl) {
  await repo.ensureSeedData();
}

const app = buildApp({
  repo,
  webOrigin: env.webOrigin,
  appMode: env.appMode,
  sessionSecret: env.sessionSecret,
  trustProxy: env.trustProxy
});
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

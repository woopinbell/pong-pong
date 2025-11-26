import {
  createMemoryRepository,
  createPostgresRepository,
  type PostgresPoolErrorEvent
} from "@pong-pong/db";
import { buildApp } from "./app.js";
import { readEnv } from "./env.js";
import { installGracefulShutdown } from "./gracefulShutdown.js";

const env = readEnv();
const earlyPoolErrors: PostgresPoolErrorEvent[] = [];
let reportPoolError = (event: PostgresPoolErrorEvent) => {
  earlyPoolErrors.push(event);
};
const repo = env.databaseUrl
  ? createPostgresRepository(env.databaseUrl, {
      onPoolError: (event) => {
        reportPoolError(event);
      }
    })
  : createMemoryRepository();

const app = buildApp({
  repo,
  webOrigin: env.webOrigin,
  appMode: env.appMode,
  sessionSecret: env.sessionSecret,
  trustProxy: env.trustProxy
});
reportPoolError = (event) => {
  app.log.error(event, "PostgreSQL idle client connection failed");
};
for (const event of earlyPoolErrors.splice(0)) {
  reportPoolError(event);
}
app.addHook("onClose", async () => {
  await repo.close();
});

const disposeShutdownSignals = installGracefulShutdown(
  process,
  async (signal) => {
    app.log.info({ signal }, "graceful shutdown started");
    const result = await app.beginDrain(60_000);
    app.log.info(result, "game room drain finished");
    await app.close();
  },
  (error) => {
    app.log.error({ errorName: error instanceof Error ? error.name : "UnknownError" }, "graceful shutdown failed");
    process.exitCode = 1;
    void app.close().catch(() => undefined);
  }
);
app.addHook("onClose", async () => {
  disposeShutdownSignals();
});

try {
  await app.listen({ port: env.port, host: "0.0.0.0" });
} catch (error) {
  app.log.error(error);
  await repo.close();
  process.exit(1);
}

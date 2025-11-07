import { existsSync } from "node:fs";
import { resolve } from "node:path";

const requiredArtifacts = [
  "packages/shared/dist/index.js",
  "packages/shared/dist/index.d.ts",
  "packages/db/dist/index.js",
  "packages/db/dist/index.d.ts",
  "packages/db/dist/migrator.js",
  "packages/db/dist/cli.js",
  "packages/db/dist/migrations/001_initial.sql",
  "packages/db/dist/migrations/004_friendship_tournament_invariants.sql",
  "apps/api/dist/index.js",
  "apps/api/dist/app.js",
  "apps/api/dist/gameHub.js",
  "apps/web/.next/standalone/apps/web/server.js"
];

const missing = requiredArtifacts.filter((artifact) => !existsSync(resolve(artifact)));

if (missing.length > 0) {
  throw new Error(`Build output is incomplete:\n${missing.map((artifact) => `- ${artifact}`).join("\n")}`);
}

console.log(`verified ${requiredArtifacts.length} build artifacts`);

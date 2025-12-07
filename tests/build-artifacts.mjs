import { existsSync } from "node:fs";
import { resolve } from "node:path";

// pnpm build(모노레포 전체 빌드)를 실행한 직후, 실제로 배포에 필요한 산출물이 전부 만들어졌는지 파일
// 존재 여부만으로 빠르게 확인하는 스크립트 — 코드 내용을 검사하지는 않고, "이 경로에 파일이 있는가"만
// 본다. Docker 이미지 빌드처럼 무거운 다음 단계로 넘어가기 전에 값싸게 먼저 걸러내는 용도.
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

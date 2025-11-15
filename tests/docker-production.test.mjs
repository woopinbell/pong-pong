import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname, "..");

test("production compose exposes only Caddy and runs migration once", () => {
  const result = spawnSync("docker", ["compose", "config", "--format", "json"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      POSTGRES_PASSWORD: "compose-contract-password",
      SESSION_SECRET: "compose-contract-session-secret-32-bytes"
    }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const config = JSON.parse(result.stdout);
  const services = config.services;
  assert.deepEqual(Object.keys(services).sort(), ["api", "caddy", "db", "migrate", "web"]);
  assert.deepEqual(Object.entries(services)
    .filter(([, service]) => Array.isArray(service.ports) && service.ports.length > 0)
    .map(([name]) => name), ["caddy"]);
  assert.deepEqual(services.migrate.command, ["node", "packages/db/dist/cli.js", "migrate"]);
  assert.equal(services.migrate.restart, "no");
  assert.equal(services.api.depends_on.migrate.condition, "service_completed_successfully");

  for (const [name, service] of Object.entries(services)) {
    for (const volume of service.volumes ?? []) {
      assert.notEqual(volume.type, "bind", `${name} must not use a source bind mount`);
    }
  }
});

test("production images pin Node and run application processes as non-root", () => {
  for (const fileName of ["apps/api/Dockerfile", "apps/web/Dockerfile"]) {
    const source = read(fileName);
    assert.match(source, /FROM node:24\.18\.0-bookworm-slim/);
    assert.match(source, /^USER node$/m);
    assert.doesNotMatch(source, /^CMD .*\b(?:pnpm|npm)\b/m);
  }
});

test("compose requires secrets and keeps metrics behind the internal API network", () => {
  const compose = read("docker-compose.yml");
  const caddy = read("Caddyfile");

  assert.match(compose, /POSTGRES_PASSWORD: \$\{POSTGRES_PASSWORD:\?/);
  assert.match(compose, /SESSION_SECRET: \$\{SESSION_SECRET:\?/);
  assert.match(compose, /\/health\/ready/);
  assert.match(caddy, /@internalMetrics path \/api\/metrics/);
  assert.match(caddy, /respond @internalMetrics 404/);
});

function read(fileName) {
  return readFileSync(resolve(root, fileName), "utf8");
}

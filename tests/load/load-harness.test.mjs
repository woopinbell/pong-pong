import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createLoadProfile } from "./load-profile.mjs";
import { buildProxyDefinitions, toxicForCommand } from "./toxiproxy-control.mjs";

test("default profile attempts 500 connections and observes 50 rooms", () => {
  const profile = createLoadProfile({});

  assert.equal(profile.connections, 500);
  assert.equal(profile.rooms, 50);
  assert.equal(profile.playerConnections, 100);
  assert.equal(profile.minimumSuccessfulConnections, 495);
  assert.deepEqual(profile.options.scenarios.pong, {
    executor: "per-vu-iterations",
    vus: 500,
    iterations: 1,
    maxDuration: "4m"
  });
  assert.deepEqual(profile.options.thresholds.connection_success, ["rate>=0.99"]);
  assert.deepEqual(profile.options.thresholds.reconnect_success, ["rate>=0.99"]);
  assert.deepEqual(profile.options.thresholds.snapshot_delay_ms, ["p(95)<=150", "p(99)<=250"]);
  assert.deepEqual(profile.options.thresholds.event_loop_lag_p95_ms, ["p(95)<=50"]);
  assert.deepEqual(profile.options.thresholds.normal_snapshot_drop_rate, ["rate<0.01"]);
  assert.deepEqual(profile.options.thresholds.finalize_failures, ["count==0"]);
  assert.deepEqual(profile.options.thresholds.finalize_duplicates, ["count==0"]);
  assert.deepEqual(profile.options.thresholds.finalize_results, ["count>=50"]);
  assert.deepEqual(profile.options.thresholds.online_connections, ["max>=495"]);
  assert.deepEqual(profile.options.thresholds.active_rooms, ["max>=50"]);
});

test("extended profile makes 1,000 connections an explicit environment choice", () => {
  const extended = createLoadProfile({ EXTENDED_LOAD: "1" });
  const explicit = createLoadProfile({ CONNECTIONS: "1000", ROOMS: "50" });

  assert.equal(extended.connections, 1000);
  assert.equal(extended.minimumSuccessfulConnections, 990);
  assert.equal(extended.options.scenarios.pong.vus, 1000);
  assert.equal(explicit.connections, 1000);
  assert.throws(
    () => createLoadProfile({ CONNECTIONS: "99", ROOMS: "50" }),
    /at least twice the room count/
  );
});

test("k6 scenario records every required service-level indicator", async () => {
  const source = await readFile(new URL("./pong-load.js", import.meta.url), "utf8");

  for (const metric of [
    "connection_success",
    "reconnect_success",
    "snapshot_delay_ms",
    "event_loop_lag_p95_ms",
    "normal_snapshot_drop_rate",
    "finalize_results",
    "finalize_failures",
    "finalize_duplicates",
    "online_connections",
    "active_rooms"
  ]) {
    assert.match(source, new RegExp(`new (?:Rate|Trend|Counter)\\(\"${metric}\"\\)`));
  }
  assert.match(source, /POST.*auth\/dev-login/s);
  assert.match(source, /auth\/ws-ticket/);
  assert.match(source, /type: "queue\.join"/);
  assert.match(source, /type: "game\.ready"/);
  assert.match(source, /inputSeq/);
  assert.match(source, /serverTimeMs/);
  assert.match(source, /METRICS_BASE_URL/);
  assert.match(source, /pong_pong_api_event_loop_lag_p95_seconds/);
});

test("Toxiproxy plan separates PostgreSQL and edge failure paths", () => {
  assert.deepEqual(buildProxyDefinitions({}), [
    { name: "postgres", listen: "0.0.0.0:15432", upstream: "db:5432", enabled: true },
    { name: "edge", listen: "0.0.0.0:18080", upstream: "caddy:8080", enabled: true }
  ]);
  assert.deepEqual(toxicForCommand("db-latency", ["300", "50"]), {
    proxy: "postgres",
    toxic: {
      name: "db-latency",
      type: "latency",
      stream: "downstream",
      toxicity: 1,
      attributes: { latency: 300, jitter: 50 }
    }
  });
  assert.deepEqual(toxicForCommand("edge-reset", ["750"]), {
    proxy: "edge",
    toxic: {
      name: "edge-reset",
      type: "reset_peer",
      stream: "downstream",
      toxicity: 1,
      attributes: { timeout: 750 }
    }
  });
  assert.throws(() => toxicForCommand("db-latency", ["bad"]), /positive integer/);
});

test("load overlay routes API database traffic and the public edge through Toxiproxy", async () => {
  const compose = await readFile(new URL("../../docker-compose.load.yml", import.meta.url), "utf8");

  assert.match(compose, /ghcr\.io\/shopify\/toxiproxy:2\.12\.0/);
  assert.match(compose, /DATABASE_URL: postgres:\/\/pong:.*@toxiproxy:15432\/pong_pong/);
  assert.match(compose, /\$\{POSTGRES_PASSWORD:\?/);
  assert.doesNotMatch(compose, /\$\{POSTGRES_PASSWORD:-/);
  assert.match(compose, /127\.0\.0\.1:\$\{TOXIPROXY_EDGE_PORT:-18080\}:18080/);
  assert.match(compose, /127\.0\.0\.1:\$\{API_METRICS_PORT:-14000\}:4000/);
  assert.match(compose, /toxiproxy-bootstrap:/);
  assert.match(compose, /service_completed_successfully/);
});

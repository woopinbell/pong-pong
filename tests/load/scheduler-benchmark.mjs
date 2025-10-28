import { cpus, freemem, platform, release, totalmem } from "node:os";
import { performance } from "node:perf_hooks";

const TIMESTEP_MS = 50;
const ROOM_COUNTS = [1, 20, 50, 100];
const REPEATS = Number(process.env.BENCHMARK_REPEATS ?? 3);
const DURATION_MS = Number(process.env.BENCHMARK_DURATION_MS ?? 1_500);
const WARMUP_MS = 250;

const measurements = [];
for (const roomCount of ROOM_COUNTS) {
  for (const strategy of ["room", "shared"]) {
    const runs = [];
    for (let repeat = 0; repeat < REPEATS; repeat += 1) {
      runs.push(await measure(strategy, roomCount));
    }
    measurements.push({
      strategy,
      roomCount,
      sampleCount: runs.reduce((sum, run) => sum + run.sampleCount, 0),
      p95LagMs: round(median(runs.map((run) => run.p95LagMs))),
      p99LagMs: round(median(runs.map((run) => run.p99LagMs)))
    });
  }
}

const room50 = measurements.find((item) => item.strategy === "room" && item.roomCount === 50);
const shared50 = measurements.find((item) => item.strategy === "shared" && item.roomCount === 50);
if (!room50 || !shared50) throw new Error("50-room comparison is missing");
const thresholdMs = room50.p95LagMs * 1.05;
const selectedStrategy = shared50.p95LagMs <= thresholdMs ? "shared" : "room";

console.log(JSON.stringify({
  recordedAt: new Date().toISOString(),
  runtime: {
    node: process.version,
    platform: `${platform()} ${release()}`,
    cpu: cpus()[0]?.model ?? "unknown",
    cpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    freeMemoryBytesAtStart: freemem()
  },
  settings: {
    timestepMs: TIMESTEP_MS,
    durationMs: DURATION_MS,
    warmupMs: WARMUP_MS,
    repeats: REPEATS,
    roomCounts: ROOM_COUNTS
  },
  measurements,
  decision: {
    selectedStrategy,
    room50P95LagMs: room50.p95LagMs,
    shared50P95LagMs: shared50.p95LagMs,
    maximumSharedP95LagMs: round(thresholdMs)
  }
}, null, 2));

async function measure(strategy, roomCount) {
  const samples = [];
  const startedAt = performance.now();
  const collectAfter = startedAt + WARMUP_MS;
  const timers = [];

  if (strategy === "shared") {
    let expectedAt = startedAt + TIMESTEP_MS;
    timers.push(setInterval(() => {
      for (let room = 0; room < roomCount; room += 1) {
        const now = performance.now();
        if (now >= collectAfter) samples.push(Math.max(0, now - expectedAt));
        simulateRoomStep(room);
      }
      expectedAt += TIMESTEP_MS;
    }, TIMESTEP_MS));
  } else {
    for (let room = 0; room < roomCount; room += 1) {
      let expectedAt = startedAt + TIMESTEP_MS;
      timers.push(setInterval(() => {
        const now = performance.now();
        if (now >= collectAfter) samples.push(Math.max(0, now - expectedAt));
        simulateRoomStep(room);
        expectedAt += TIMESTEP_MS;
      }, TIMESTEP_MS));
    }
  }

  await new Promise((resolve) => setTimeout(resolve, DURATION_MS));
  for (const timer of timers) clearInterval(timer);
  samples.sort((left, right) => left - right);
  return {
    sampleCount: samples.length,
    p95LagMs: percentile(samples, 0.95),
    p99LagMs: percentile(samples, 0.99)
  };
}

function simulateRoomStep(room) {
  let value = room + 1;
  for (let index = 0; index < 180; index += 1) {
    value = Math.sin(value + index) * Math.cos(value - index);
  }
  return value;
}

function percentile(values, ratio) {
  if (values.length === 0) return 0;
  return values[Math.min(values.length - 1, Math.ceil(values.length * ratio) - 1)];
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function round(value) {
  return Number(value.toFixed(3));
}

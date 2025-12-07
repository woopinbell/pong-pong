import { cpus, freemem, platform, release, totalmem } from "node:os";
import { performance } from "node:perf_hooks";

// [INTV:PERF] 이 스크립트는 apps/api/src/game/sharedRoomScheduler.ts가 "왜 방마다 타이머를 하나씩
// 두지 않고 타이머 하나를 공유하는 방식을 택했는지"에 대한 실측 근거를 만드는 벤치마크다 — 두
// 전략("room": 방마다 개별 setInterval, "shared": 타이머 하나가 모든 방을 순회)을 같은 조건에서
// 돌려 틱 지연(스케줄링 지터)을 재고, 결과에 따라 어느 전략이 나은지 자동으로 판정까지 내려 JSON으로
// 출력한다. sharedRoomScheduler.ts 코드 안의 [INTV:PERF] 주석이 "타이머 개수를 줄이면 좋다"는
// 주장이라면, 이 스크립트는 그 주장을 실제 수치로 검증하는 짝이다 — 인터뷰에서 "왜 이 설계를
// 선택했나"에 "이론상 그럴 것 같아서"가 아니라 "실측 벤치마크로 확인했다"고 답할 수 있는 근거.
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

// [INTV:PERF] 방 50개 기준으로 두 전략을 비교한다: "shared" 방식의 p95 지연이 "room" 방식보다 5%
// 넘게 나쁘지 않으면(타이머 개수를 훨씬 줄이는) shared를 택하고, 그렇지 않으면 room을 택한다 —
// 실측치를 기준으로 한 자동 의사결정. "완전히 같아야 한다"가 아니라 "5% 이내면 허용"한 이유는,
// shared 방식이 지연에서 약간 손해 보더라도 타이머 개수 절감(자원 효율)의 이득이 그 정도 손실은
// 상쇄한다고 보는 트레이드오프 판단 — 임계값 자체가 "타이머 절약과 지연 사이 어느 정도까지 맞바꿀
// 것인가"라는 설계 결정을 코드로 표현한 것.
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

// [INTV:PERF] 한 전략 × 방 개수 조합을 실제로 DURATION_MS만큼 돌려서, 매 틱이 "원래 예정된
// 시각(expectedAt)"보다 실제로 얼마나 늦게 실행됐는지(지연/지터)를 샘플로 모은다 — WARMUP_MS 동안의
// 초기 샘플은 버려서(JIT 컴파일 워밍업, 초기 GC 등으로 인한 초반 노이즈) 결과를 왜곡하지 않게 한다
// (벤치마크에서 흔히 필요한 워밍업 구간 배제 기법).
async function measure(strategy, roomCount) {
  const samples = [];
  const startedAt = performance.now();
  const collectAfter = startedAt + WARMUP_MS;
  const timers = [];

  if (strategy === "shared") {
    // [INTV:PERF] "shared": 타이머 하나가 매 틱마다 모든 방을 for 루프로 순회한다 —
    // SharedRoomScheduler.ts가 실제로 쓰는 방식.
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
    // [INTV:PERF] "room": 방마다 각자 자신만의 setInterval을 갖는다 — 방이 많아질수록 이벤트 루프에
    // 동시에 걸린 타이머 개수 자체가 늘어나는 방식(SharedRoomScheduler 도입 전 소박한 대안 구현).
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

// [INTV:PERF] 실제 PongSimulation.step()의 물리 계산 대신, 그와 비슷한 정도의 CPU 부담을 주기
// 위한 무의미한 연산(아무 의미 없는 sin/cos 반복)이다 — 여러 방의 콜백이 싱글 스레드 이벤트 루프를
// 두고 실제로 경합하는 상황을 흉내 내는 게 목적이라, 계산 결과 자체는 버려진다. 빈 함수로 벤치마크를
// 돌리면 "타이머 자체의 오버헤드"만 재는 셈이라, 실제 워크로드(물리 계산)가 있을 때의 경합 상황을
// 반영하지 못한 비현실적인 결과가 나온다.
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

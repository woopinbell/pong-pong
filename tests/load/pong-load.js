// [INTV:ARCH] 이 파일은 Node가 아니라 k6(부하 테스트 도구)가 자체 JS 런타임으로 실행하는 스크립트다
// — "k6/..."로 시작하는 모듈들은 k6가 내장 제공하는 API로, npm 패키지가 아니다. __ENV는 Node의
// process.env에 대응하는 k6의 전역 환경변수 객체.
import exec from "k6/execution";
import http from "k6/http";
import ws from "k6/ws";
import { check, fail } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";
import { createLoadProfile } from "./load-profile.mjs";

const profile = createLoadProfile(__ENV);
const apiBaseUrl = (__ENV.API_BASE_URL || "http://127.0.0.1:4000").replace(/\/$/, "");
const metricsBaseUrl = (__ENV.METRICS_BASE_URL || "http://127.0.0.1:14000").replace(/\/$/, "");
const websocketUrl = __ENV.WS_URL || "ws://127.0.0.1:4000/ws";

// [INTV:ARCH] k6/metrics의 커스텀 지표: Rate는 참/거짓 결과의 비율(성공률 등), Trend는 숫자 분포
// (지연시간처럼 평균/백분위수를 보고 싶은 값), Counter는 단순 누적 카운트를 기록한다. 이 지표
// 이름들이 load-profile.mjs의 thresholds에서 합격 기준을 매기는 대상과 정확히 대응한다 — 지표를
// 여기서 만들기만 하고 threshold가 없으면 수치는 쌓이지만 "합격/불합격" 판정에는 반영되지 않는다.
const connectionSuccess = new Rate("connection_success");
const reconnectSuccess = new Rate("reconnect_success");
const snapshotDelay = new Trend("snapshot_delay_ms");
const eventLoopLagP95 = new Trend("event_loop_lag_p95_ms");
const normalSnapshotDropRate = new Rate("normal_snapshot_drop_rate");
const finalizeResults = new Counter("finalize_results");
const finalizeFailures = new Counter("finalize_failures");
const finalizeDuplicates = new Counter("finalize_duplicates");
const onlineConnections = new Trend("online_connections");
const activeRooms = new Trend("active_rooms");

// k6는 이 "options" 이름으로 export된 객체를 읽어 이 실행 전체(가상 유저 수, 시나리오, 합격 기준)를
// 구성한다 — load-profile.mjs가 계산한 설정이 실제로 k6에 적용되는 지점.
export const options = profile.options;

// [INTV:ARCH] setup(): 모든 가상 유저(VU)가 시작되기 전에 딱 한 번 실행된다 — 여기서는 서버가
// 준비됐는지 먼저 확인해서(app.ts의 /health/ready), 애초에 서버가 안 떠 있는데 수백 명이 몰려들어
// 의미 없는 실패를 쏟아내는 상황을 막는다.
export function setup() {
  const response = http.get(`${apiBaseUrl}${__ENV.READY_PATH || "/health/ready"}`, {
    tags: { operation: "readiness" }
  });
  if (response.status !== 200) {
    fail(`API readiness failed with ${response.status}`);
  }
}

// [INTV:ARCH] teardown(): 모든 VU가 끝난 뒤 딱 한 번 실행된다 — 서버의 Prometheus /metrics를
// 직접 긁어와서, 클라이언트 쪽에서 관찰한 지표(snapshotDelay 등)와 서버 자체가 관찰한 지표(이벤트
// 루프 지연, 매치 파이널라이즈 횟수)를 같은 k6 리포트 안에 합쳐 넣는다 — 클라이언트 관점과 서버
// 관점을 한 보고서로 잇는 다리 역할(observability.ts가 노출하는 지표를 부하테스트 리포트 안으로
// 끌어오는 것 — "클라이언트가 느끼는 지연"과 "서버 내부의 실제 병목"을 같은 시점 기준으로 함께
// 봐야 원인을 정확히 짚을 수 있다).
export function teardown() {
  const response = http.get(`${metricsBaseUrl}/metrics`, {
    responseType: "text",
    tags: { operation: "metrics" }
  });
  if (response.status !== 200 || typeof response.body !== "string") {
    fail(`API metrics failed with ${response.status}`);
  }
  const eventLoopLagSeconds = readPrometheusSample(
    response.body,
    "pong_pong_api_event_loop_lag_p95_seconds"
  );
  if (eventLoopLagSeconds === null || eventLoopLagSeconds < 0) {
    fail("API event-loop p95 metric is missing or invalid");
  }
  eventLoopLagP95.add(eventLoopLagSeconds * 1_000);

  finalizeResults.add(readPrometheusSample(
    response.body,
    "pong_pong_api_match_finalizations_total",
    { persistence: "database", outcome: "success" }
  ) ?? 0);
  finalizeFailures.add(readPrometheusSample(
    response.body,
    "pong_pong_api_match_finalizations_total",
    { persistence: "database", outcome: "failure" }
  ) ?? 0);
  finalizeDuplicates.add(readPrometheusSample(
    response.body,
    "pong_pong_api_match_finalization_duplicates_total"
  ) ?? 0);
}

// [INTV:ARCH] export default function: k6가 각 가상 유저(VU)마다 반복 실행하는 실제 시나리오 본문
// — 로그인하고, WS 티켓을 받고, 접속해서 매칭·플레이까지 해본다. vuId가 playerConnections 이내인
// VU만 "실제 플레이어" 역할을 하고(대기열 참가, 재접속 시도까지), 나머지는 접속만 유지하며 순수하게
// "동시 접속자 수"의 부하만 더하는 관전자 역할이다 — 실제 서비스에서 로비를 구경만 하는 유저와
// 실제로 매칭에 들어가는 유저의 비율이 다르므로, 이 구분이 더 현실적인 부하 프로파일을 만든다.
export default function () {
  const vuId = exec.vu.idInTest;
  const player = vuId <= profile.playerConnections;
  const reconnectDelayMs = player ? reconnectDelayFor(vuId) : 0;
  const finishedMatchIds = new Set();
  const finishedRoomIds = new Set();
  finalizeFailures.add(0);
  finalizeDuplicates.add(0);

  if (!login(vuId)) {
    connectionSuccess.add(false);
    return;
  }

  const initialTicket = issueTicket();
  if (!initialTicket) {
    connectionSuccess.add(false);
    return;
  }

  let initial;
  try {
    initial = connectSession({
      ticket: initialTicket,
      phase: "initial",
      player,
      reconnectDelayMs,
      expectedRoomId: null,
      finishedMatchIds,
      finishedRoomIds
    });
  } catch {
    connectionSuccess.add(false);
    return;
  }
  connectionSuccess.add(initial.connected);

  if (!player) return;
  if (!initial.connected || !initial.roomId) {
    reconnectSuccess.add(false);
    return;
  }

  // [INTV:EDGE] 플레이어 역할의 VU는 일부러 한 번 끊었다가(connectSession 안에서 reconnectDelayMs
  // 뒤 소켓을 닫음) 새 티켓으로 다시 접속해본다 — GameSocketClient.ts/gameHub.ts의 재연결 경로를,
  // 실제 동시 부하가 걸린 상황에서 진짜 k6 가상 유저로 검증하는 부분(단위 테스트는 재연결 로직을
  // 개별적으로 검증하지만, 수백 개 연결이 동시에 끊기고 재연결하는 상황에서의 서버 부하/타이밍은
  // 이런 규모의 부하테스트로만 드러난다).
  const reconnectTicket = issueTicket();
  if (!reconnectTicket) {
    reconnectSuccess.add(false);
    return;
  }

  let reconnected;
  try {
    reconnected = connectSession({
      ticket: reconnectTicket,
      phase: "reconnect",
      player: true,
      reconnectDelayMs: 0,
      expectedRoomId: initial.roomId,
      finishedMatchIds,
      finishedRoomIds
    });
  } catch {
    reconnectSuccess.add(false);
    return;
  }
  reconnectSuccess.add(reconnected.connected && reconnected.recovered);
}

function login(vuId) {
  const response = http.request(
    "POST",
    `${apiBaseUrl}/auth/dev-login`,
    JSON.stringify({
      handle: `load-user-${vuId}`,
      displayName: `부하 테스트 ${vuId}`
    }),
    {
      headers: { "content-type": "application/json" },
      tags: { operation: "dev-login" }
    }
  );
  return check(response, { "development login succeeds": (value) => value.status === 200 });
}

function issueTicket() {
  const response = http.request("POST", `${apiBaseUrl}/auth/ws-ticket`, null, {
    responseType: "text",
    tags: { operation: "ws-ticket" }
  });
  if (response.status !== 200 || !response.body) return null;
  try {
    const body = JSON.parse(response.body);
    return body.protocolVersion === 1 && typeof body.ticket === "string" ? body.ticket : null;
  } catch {
    return null;
  }
}

// [INTV:ARCH] 한 번의 WS 접속을 열고, 그 위에서 오가는 프로토콜 이벤트(ws.ts에서 정의한 것과 같은
// 이벤트들)에 맞춰 실제 클라이언트처럼 반응하는 상태 기계 — 매칭 대기, 준비, 입력 전송, 스냅샷
// 지연/드롭 측정, 매치 종료 확인까지 한 접속의 생애주기를 전부 다룬다(GameSocketClient.ts/
// useGameConnection.ts가 브라우저에서 하는 역할을 k6 런타임 안에서 최소한으로 재현한 것).
function connectSession({
  ticket,
  phase,
  player,
  reconnectDelayMs,
  expectedRoomId,
  finishedMatchIds,
  finishedRoomIds
}) {
  const result = {
    connected: false,
    recovered: expectedRoomId === null,
    roomId: expectedRoomId,
    side: null
  };
  let queueJoined = false;
  let inputSeq = 0;
  let lastSequence = null;
  let reconnectCloseArmed = false;

  const response = ws.connect(
    `${websocketUrl}?ticket=${encodeURIComponent(ticket)}&v=1`,
    { tags: { phase, player: String(player) } },
    (socket) => {
      socket.on("open", () => {
        result.connected = true;
      });
      socket.on("message", (payload) => {
        let event;
        try {
          event = JSON.parse(payload);
        } catch {
          return;
        }
        if (event.v !== 1) return;

        if (event.type === "presence.changed") {
          onlineConnections.add(event.online);
          activeRooms.add(event.playing / 2);
          // [INTV:EDGE] 목표 동시 접속자 수(minimumSuccessfulConnections)에 도달하기 전에는
          // 대기열에 참가하지 않는다 — 접속이 다 몰리기도 전에 매칭이 끝나버리면 "동시에 수백 명이
          // 매칭을 시도하는" 상황을 제대로 재현하지 못하기 때문(테스트 스크립트 자체가 검증하려는
          // 조건 — matchmaker.ts의 findClosestOpponent 부하 — 을 실제로 만들어내지 못하는 무의미한
          // 부하테스트가 되는 걸 막는 동기화 지점).
          if (
            phase === "initial"
            && player
            && !queueJoined
            && event.online >= profile.minimumSuccessfulConnections
          ) {
            queueJoined = true;
            socket.send(JSON.stringify({ v: 1, type: "queue.join", mode: "queue" }));
          }
          return;
        }

        if (event.type === "queue.matched") {
          result.roomId = event.roomId;
          result.side = event.side;
          if (expectedRoomId !== null && event.roomId === expectedRoomId) result.recovered = true;
          socket.send(JSON.stringify({ v: 1, type: "game.ready", roomId: event.roomId }));
          // [INTV:EDGE] 사람이 좌우로 계속 패들을 움직이는 것을 흉내 내기 위해, 0.1초마다 방향을
          // -1/1/0으로 순환시키며 game.input을 보낸다(k6 소켓 API 자체의 setInterval) — 100ms마다
          // 보내는 이 빈도가 inputGate.ts의 토큰 버킷 속도 제한(기본 초당 30개)을 실제로 건드리는지도
          // 함께 검증하는 셈이다.
          socket.setInterval(() => {
            inputSeq += 1;
            const direction = inputSeq % 30 < 10 ? -1 : inputSeq % 30 < 20 ? 1 : 0;
            socket.send(JSON.stringify({
              v: 1,
              type: "game.input",
              roomId: event.roomId,
              inputSeq,
              direction
            }));
          }, 100);
          return;
        }

        if (event.type === "game.snapshot") {
          const snapshot = event.snapshot;
          if (expectedRoomId !== null && snapshot.roomId === expectedRoomId) result.recovered = true;
          // [INTV:EDGE] 실제로 플레이 중인 상태가 되면, reconnectDelayMs 뒤에 소켓을 스스로 끊도록
          // 1회성 타이머를 건다 — 위 default 함수에서 이어서 재접속을 시도하는 게 바로 이 끊김을
          // 전제로 한다(reconnectCloseArmed 플래그로 이 예약이 중복으로 걸리지 않게 한 번만 실행).
          if (
            !reconnectCloseArmed
            && phase === "initial"
            && player
            && snapshot.state.phase === "playing"
          ) {
            reconnectCloseArmed = true;
            socket.setTimeout(() => socket.close(), reconnectDelayMs);
          }
          // [INTV:EDGE] snapshot.serverTimeMs(서버가 이 스냅샷을 보낸 시각)와 지금 이 클라이언트
          // 시각의 차이로 "체감 지연"을 근사한다(클라이언트/서버 시계가 어긋나 있으면 오차가 생길
          // 수 있다는 한계는 있음 — LatestSnapshotBuffer의 onDelivered 콜백이 재는 "서버 큐 안에서의
          // 지연"과는 다른, "네트워크를 포함한 전체 체감 지연"을 관측).
          snapshotDelay.add(Math.max(0, Date.now() - snapshot.serverTimeMs));
          // [INTV:EDGE] sequence가 이전에 본 값보다 몇 만큼 더 뛰었는지로 "중간에 놓친 스냅샷
          // 개수"를 추정해 드롭률에 반영한다(LatestSnapshotBuffer가 congestion 상황에서 스냅샷을
          // "replaced"로 버리는 게 실제로 얼마나 자주 일어나는지를, 클라이언트가 받은 sequence의
          // 빈틈으로 역산하는 셈).
          if (lastSequence !== null && snapshot.sequence > lastSequence) {
            const missed = snapshot.sequence - lastSequence - 1;
            for (let index = 0; index < missed; index += 1) normalSnapshotDropRate.add(true);
            normalSnapshotDropRate.add(false);
          } else if (lastSequence === null) {
            normalSnapshotDropRate.add(false);
          }
          if (lastSequence === null || snapshot.sequence > lastSequence) {
            lastSequence = snapshot.sequence;
          }
          return;
        }

        // [INTV:EDGE] game.finished는 방의 두 플레이어 모두에게 오므로, 한쪽(side === "left")에서만
        // 세어 중복 집계를 막는다. matchId/roomId가 없거나 persisted가 아니면 finalizeFailures로,
        // 이미 본 matchId/roomId가 다시 오면(멱등성이 깨졌다는 뜻) finalizeDuplicates로 센다 —
        // gameHub.ts의 finalizeRoom + finalizeMatch의 resultKey UNIQUE 제약이 부하 상황에서도 정확히
        // 한 번만, 제대로 결과를 저장하는지를 이 테스트가 실측으로 검증하는 부분(finalizeDuplicates가
        // 0이 아니면 멱등성 방어가 실제로는 깨졌다는 신호).
        if (event.type === "game.finished" && result.side === "left") {
          const matchId = event.result?.matchId;
          const roomId = event.result?.roomId;
          if (
            event.result?.persisted !== true
            || typeof matchId !== "string"
            || matchId.length === 0
            || typeof roomId !== "string"
            || roomId !== result.roomId
          ) {
            finalizeFailures.add(1);
          } else if (finishedMatchIds.has(matchId) || finishedRoomIds.has(roomId)) {
            finalizeDuplicates.add(1);
          } else {
            finishedMatchIds.add(matchId);
            finishedRoomIds.add(roomId);
          }
        }
      });
      socket.setTimeout(
        () => socket.close(),
        phase === "initial" ? profile.initialHoldMs : profile.reconnectedHoldMs
      );
    }
  );

  result.connected = result.connected && response?.status === 101;
  return result;
}

// [INTV:EDGE] load-profile.mjs의 playerReconnectStaggerMs를 실제로 각 VU에 분산 적용한다 — VU
// 순번을 플레이어 수로 나눈 나머지 비율만큼 재접속 지연을 늘려서, 수백 명이 정확히 같은 순간에
// 재접속을 시도하는 비현실적인 스파이크를 피한다(실제 서비스 장애 시나리오에서도 모든 클라이언트가
// 정확히 동시에 재접속을 시도하는 경우는 드물다 — 이 분산이 없으면 부하테스트가 실제보다 더 가혹한,
// 비현실적인 순간 부하를 만들어 결과를 왜곡한다).
function reconnectDelayFor(vuId) {
  if (profile.playerReconnectStaggerMs === 0) return profile.playerReconnectDelayMs;
  const playerIndex = (vuId - 1) % profile.playerConnections;
  const staggerMs = Math.floor(
    playerIndex * profile.playerReconnectStaggerMs / profile.playerConnections
  );
  return profile.playerReconnectDelayMs + staggerMs;
}

// [INTV:ARCH] k6에는 Prometheus 클라이언트가 내장돼 있지 않아서, /metrics 응답 텍스트
// (observability.ts가 prom-client의 registry.metrics()로 만드는 "지표명{라벨=값,...} 수치" 형식)를
// 직접 한 줄씩 정규식으로 파싱하는 미니 파서를 손으로 구현했다 — 원하는 지표 이름과 라벨 조합이
// 맞는 줄을 찾아 그 수치만 뽑아낸다(Prometheus 텍스트 노출 형식 자체가 사람이 읽을 수 있는 평문이라
// 정규식 파싱이 실용적으로 충분하다).
function readPrometheusSample(body, metricName, expectedLabels = {}) {
  for (const line of body.split("\n")) {
    if (!line.startsWith(metricName)) continue;
    const sample = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+([0-9.eE+-]+)$/);
    if (!sample || sample[1] !== metricName) continue;

    const labels = {};
    for (const label of (sample[2] ?? "").matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="([^"]*)"/g)) {
      labels[label[1]] = label[2];
    }
    if (Object.entries(expectedLabels).some(([name, value]) => labels[name] !== value)) continue;

    const value = Number(sample[3]);
    return Number.isFinite(value) ? value : null;
  }
  return null;
}

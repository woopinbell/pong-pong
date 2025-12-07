// [INTV:ARCH] k6(부하 테스트 도구, pong-load.js가 실제 k6 스크립트다)에 넘길 시나리오 설정을
// 환경변수로부터 계산해 만드는 곳 — "동시에 몇 명이 접속하는지", "얼마나 오래 버티는지", "무엇을
// 성공/실패 기준으로 삼는지"를 전부 이 함수 하나가 정의한다(pong-load.js 본문에서 시나리오 로직과
// 설정 계산을 분리해, 같은 스크립트를 다른 규모의 프로파일로 재사용할 수 있게 한다).
const DEFAULT_CONNECTIONS = 500;
const EXTENDED_CONNECTIONS = 1_000;
const DEFAULT_ROOMS = 50;

export function createLoadProfile(environment = {}) {
  // [INTV:ARCH] EXTENDED_LOAD=1이면 더 무거운(1000명) 프로파일을 쓴다 — 평소 PR마다 도는 가벼운
  // 부하 테스트와, 필요할 때만 돌리는 더 강한 부하 테스트를 환경변수 하나로 전환할 수 있게 한 것
  // (매 PR마다 무거운 부하테스트를 돌리면 CI 시간이 길어지므로, 기본은 가볍게 하고 필요시에만
  // 확장하는 트레이드오프).
  const extended = environment.EXTENDED_LOAD === "1";
  const connections = positiveInteger(
    "CONNECTIONS",
    environment.CONNECTIONS,
    extended ? EXTENDED_CONNECTIONS : DEFAULT_CONNECTIONS
  );
  const rooms = positiveInteger("ROOMS", environment.ROOMS, DEFAULT_ROOMS);
  // [INTV:EDGE] 방 하나에 플레이어가 정확히 2명 필요하므로, 접속자 수는 최소 방 개수의 2배는 돼야
  // 모든 방을 채울 수 있다 — 이 검증 없이 잘못된 조합(예: CONNECTIONS=10, ROOMS=50)으로 실행하면,
  // 방이 다 안 채워진 채로 테스트가 끝나 finalize_results 같은 threshold가 애매하게 실패하는
  // 원인을 찾기 어려운 상황이 된다. 설정 단계에서 조기에 막는 게 더 명확한 실패 메시지를 준다.
  if (connections < rooms * 2) {
    throw new RangeError("CONNECTIONS must be at least twice the room count");
  }

  // [INTV:EDGE] 실제 네트워크 환경에서는 극히 일부 접속이 우연히 실패할 수 있다는 걸 감안해,
  // 100%가 아니라 99% 이상 성공하면 통과로 본다(너무 엄격한 기준은 테스트 인프라 자체의 노이즈로
  // 매번 깨지는 불안정한 CI를 만든다).
  const minimumSuccessfulConnections = Math.ceil(connections * 0.99);
  const playerConnections = rooms * 2;
  const initialHoldMs = positiveInteger("INITIAL_HOLD_MS", environment.INITIAL_HOLD_MS, 90_000);
  const playerReconnectDelayMs = positiveInteger(
    "PLAYER_RECONNECT_DELAY_MS",
    environment.PLAYER_RECONNECT_DELAY_MS,
    2_000
  );
  // [INTV:EDGE] 실제 플레이어 역할을 맡은 가상 유저들은 재접속 테스트를 위해 일부러 한 번 끊었다가
  // 다시 붙는데, 그걸 전부 한 타이밍에 하면(동시에 수백 명이 재접속) 현실적이지 않은 순간적 부하
  // 스파이크가 생긴다 — stagger(분산 지연)로 재접속 시점을 흩뿌려서 실제 트래픽 패턴에 더 가깝게
  // 만든다(pong-load.js의 reconnectDelayFor가 이 값을 실제로 각 VU에 분산 적용하는 곳).
  const playerReconnectStaggerMs = nonNegativeInteger(
    "PLAYER_RECONNECT_STAGGER_MS",
    environment.PLAYER_RECONNECT_STAGGER_MS,
    5_000
  );
  const reconnectedHoldMs = positiveInteger(
    "RECONNECTED_HOLD_MS",
    environment.RECONNECTED_HOLD_MS,
    60_000
  );
  const maxDuration = environment.MAX_DURATION || "4m";

  return {
    connections,
    rooms,
    playerConnections,
    minimumSuccessfulConnections,
    initialHoldMs,
    playerReconnectDelayMs,
    playerReconnectStaggerMs,
    reconnectedHoldMs,
    options: {
      discardResponseBodies: true,
      // [INTV:ARCH] k6 시나리오 정의: executor "per-vu-iterations"는 "가상 유저(vus)를 지정한
      // 수만큼 동시에 띄우고, 각자 스크립트를 정확히 iterations번(여기선 1번) 실행"하는 방식 —
      // 즉 connections명의 가상 플레이어가 동시에 접속해서 시나리오를 한 번씩 수행한다(commerce-
      // transaction의 load-test/concurrency.js도 같은 executor를 쓰는데, 거기는 "재고 1개를 두고
      // 동시에 경합"이 목적이라 iterations도 1이었던 것과 같은 패턴 — "정확히 한 번씩, 동시에"가
      // 필요한 동시성 테스트의 공통 형태).
      scenarios: {
        pong: {
          executor: "per-vu-iterations",
          vus: connections,
          iterations: 1,
          maxDuration
        }
      },
      // [INTV:ARCH] thresholds: 이 부하 테스트의 합격 기준(SLO)을 k6 문법으로 표현한 것 —
      // snapshot_delay_ms/event_loop_lag_p95_ms는 observability.ts가 실제로 관측하는 지표와 같은
      // 이름이고, finalize_failures/finalize_duplicates==0은 gameHub.ts의 매치 종료 처리가 실제
      // 동시 부하 아래서도 실패하거나 중복 처리되지 않는지를 검증한다 — 단위/통합 테스트에서
      // 개별적으로 확인한 보장들을, 실제 규모의 동시 부하 아래서도 여전히 성립하는지 이 부하
      // 테스트가 다시 한번 확인하는 셈이다("로직이 옳다"와 "부하 아래서도 옳다"는 서로 다른 검증
      // 층위라는, commerce-transaction 프로젝트에서도 반복된 원칙).
      thresholds: {
        connection_success: ["rate>=0.99"],
        reconnect_success: ["rate>=0.99"],
        snapshot_delay_ms: ["p(95)<=150", "p(99)<=250"],
        event_loop_lag_p95_ms: ["p(95)<=50"],
        normal_snapshot_drop_rate: ["rate<0.01"],
        finalize_results: [`count>=${rooms}`],
        finalize_failures: ["count==0"],
        finalize_duplicates: ["count==0"],
        online_connections: [`max>=${minimumSuccessfulConnections}`],
        active_rooms: [`max>=${rooms}`]
      },
      summaryTrendStats: ["avg", "min", "med", "max", "p(90)", "p(95)", "p(99)"]
    }
  };
}

function positiveInteger(name, rawValue, fallback) {
  const value = rawValue === undefined || rawValue === "" ? fallback : Number(rawValue);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(name, rawValue, fallback) {
  const value = rawValue === undefined || rawValue === "" ? fallback : Number(rawValue);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
  return value;
}

// [INTV:ARCH] prom-client: Prometheus(모니터링 시스템)가 스크레이핑해가는 형식으로 지표를 쌓아주는
// 라이브러리. Counter는 계속 증가만 하는 값(총 요청 수 등), Gauge는 오르내릴 수 있는 현재값(현재
// 접속자 수 등), Histogram은 값의 분포를 버킷으로 나눠 기록해 나중에 백분위수(p95 등)를 계산할 수
// 있게 한다. Registry는 이 지표들을 한데 모아 /metrics 엔드포인트로 내보낼 때 쓰는 컨테이너.
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics
} from "prom-client";
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import type { AppRepository } from "@pong-pong/db";

interface LiveGameStats {
  onlinePlayers: number;
  queuedPlayers: number;
  activeRooms: number;
}

// [INTV:PERF] Prometheus에서 라벨(labelNames)에 쓰는 값의 종류가 너무 다양해지면(예: 임의 문자열)
// 시계열 수가 폭발해 저장소 부하가 커진다("카디널리티 폭발"이라 부르는 흔한 함정 — 라벨 값 조합마다
// 별도의 시계열이 생기기 때문). AppRepository가 가진 메서드 이름만 라벨 값으로 허용하고, 목록에
// 없는 이름은 아래 observeDatabaseOperation에서 "other"로 뭉뚱그린다 — 화이트리스트 방식이라 새
// 메서드가 추가돼도 이 집합에 없으면 자동으로 안전하게 "other"에 묶인다(카디널리티 폭발을 코드
// 레벨에서 구조적으로 막는 방법).
const REPOSITORY_OPERATIONS = new Set([
  "close",
  "checkReadiness",
  "ensureSeedData",
  "upsertDevUser",
  "createSession",
  "getSessionUser",
  "deleteSession",
  "createWsTicket",
  "consumeWsTicket",
  "setUserRoleByHandle",
  "getUserById",
  "getUserByHandle",
  "updateProfile",
  "listOnlineUsers",
  "listNpcOpponents",
  "listLeaderboard",
  "listRecentMatches",
  "getDashboard",
  "listFriends",
  "requestFriend",
  "acceptFriend",
  "createMatch",
  "finalizeMatch",
  "listLobbyChat",
  "createChatMessage",
  "listTournaments",
  "createTournament",
  "joinTournament",
  "getTournamentMatch",
  "startTournamentMatch",
  "listAdminUsers",
  "listAdminActions",
  "setUserBan"
]);

export class ApiMetrics {
  private readonly registry = new Registry();
  private readonly eventLoopDelay: IntervalHistogram;
  private readonly eventLoopLagP95: Gauge;
  private readonly requestDuration = new Histogram({
    name: "pong_pong_api_http_request_duration_seconds",
    help: "HTTP request duration in seconds",
    // [INTV:TRAP] as const: labelNames 배열을 딱 이 리터럴 값들의 튜플 타입으로 고정한다 —
    // prom-client가 이 타입을 보고 .observe()에 넘기는 라벨 객체가 정확히 이 이름들만 갖도록
    // 컴파일 타임에 검사해준다. as const를 빼먹으면 타입이 string[]로 넓어져, 오타가 난 라벨
    // 이름도 컴파일 타임에 잡히지 않고 런타임에야 발견된다.
    labelNames: ["method", "route", "status_code"] as const,
    // [INTV:PERF] buckets: 히스토그램이 값을 나눠 담을 경계선(초 단위)들. 이 경계 안에서 몇 개의
    // 관측치가 들어왔는지 세어 Prometheus 쪽에서 나중에 p50/p95 같은 백분위수를 근사 계산할 수
    // 있게 한다 — 값을 전부 저장하는 대신 구간별 개수만 저장하므로 메모리 효율적이다(정확한
    // 백분위수 대신 근사치를 얻는 대가로 O(요청 수) 대신 O(버킷 수) 메모리만 쓴다).
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry]
  });
  private readonly readinessDuration = new Histogram({
    name: "pong_pong_api_readiness_check_duration_seconds",
    help: "Repository readiness check duration in seconds",
    labelNames: ["result"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [this.registry]
  });
  private readonly databaseOperationDuration = new Histogram({
    name: "pong_pong_api_database_operation_duration_seconds",
    help: "Repository operation duration in seconds",
    labelNames: ["operation", "outcome"] as const,
    buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry]
  });
  private readonly snapshotDeliveryDelay = new Histogram({
    name: "pong_pong_api_snapshot_delivery_delay_seconds",
    help: "Time from snapshot enqueue to websocket send completion",
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.15, 0.25, 0.5, 1],
    registers: [this.registry]
  });
  private readonly snapshotDrops = new Counter({
    name: "pong_pong_api_snapshot_drops_total",
    help: "Snapshots discarded before successful delivery",
    labelNames: ["reason"] as const,
    registers: [this.registry]
  });
  private readonly connections = new Gauge({
    name: "pong_pong_api_connections",
    help: "Current websocket connection count",
    registers: [this.registry]
  });
  private readonly queuedPlayers = new Gauge({
    name: "pong_pong_api_queued_players",
    help: "Current matchmaking queue size",
    registers: [this.registry]
  });
  private readonly rooms = new Gauge({
    name: "pong_pong_api_rooms",
    help: "Current game room count",
    registers: [this.registry]
  });
  private readonly matchFinalizations = new Counter({
    name: "pong_pong_api_match_finalizations_total",
    help: "Completed match finalization attempts",
    labelNames: ["persistence", "outcome"] as const,
    registers: [this.registry]
  });
  private readonly matchFinalizationDuplicates = new Counter({
    name: "pong_pong_api_match_finalization_duplicates_total",
    help: "Match finalizations that returned an existing persisted result",
    registers: [this.registry]
  });
  private readonly reconnects = new Counter({
    name: "pong_pong_api_reconnects_total",
    help: "Websocket room reconnection outcomes",
    labelNames: ["outcome"] as const,
    registers: [this.registry]
  });

  constructor(private readonly readGameStats: () => LiveGameStats) {
    // [INTV:PERF] monitorEventLoopDelay: Node가 내장 제공하는, "이벤트 루프가 한 바퀴 도는 데
    // 실제로 걸린 시간"을 표본 수집하는 API. 이 값이 커지면(이벤트 루프 지연/렉) 동기 작업이
    // 이벤트 루프를 오래 막고 있다는 신호이고, 실시간으로 게임 스냅샷을 내보내야 하는 이 서버에서는
    // 곧바로 체감 렉으로 이어지므로 핵심 헬스 지표로 삼는다 — Node는 싱글 스레드라, CPU 집약적인
    // 동기 코드 한 줄이 그 순간 모든 방의 tick()/send()를 지연시킨다는 걸 관측치로 드러내는 지표.
    this.eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
    this.eventLoopLagP95 = new Gauge({
      name: "pong_pong_api_event_loop_lag_p95_seconds",
      help: "95th percentile of recorded event loop delay in seconds",
      registers: [this.registry],
      // [INTV:PERF] collect: 값을 미리 set()해두는 대신, Prometheus가 이 지표를 실제로 긁어갈
      // 때(scrape 시점)마다 호출되는 콜백 — 그 순간까지 쌓인 이벤트 루프 지연 표본들의 95번째
      // 백분위수를 계산해 반영한다(지연 계산: scrape 요청이 없으면 이 계산 자체가 일어나지 않아,
      // 매 틱마다 미리 계산해두는 것보다 낭비가 없다).
      collect: () => {
        const delayNanoseconds = this.eventLoopDelay.percentile(95);
        this.eventLoopLagP95.set(
          Number.isFinite(delayNanoseconds) ? delayNanoseconds / 1_000_000_000 : 0
        );
      }
    });
    this.eventLoopDelay.enable();
    // [INTV:ARCH] collectDefaultMetrics: prom-client가 기본 제공하는, Node 프로세스 자체의
    // 지표(메모리 사용량, GC, 핸들 개수 등)를 자동으로 이 registry에 등록해준다 — 애플리케이션
    // 고유 지표(요청 지연, 방 수 등) 외에 런타임 상태도 함께 노출해, "애플리케이션은 정상인데
    // 프로세스가 죽어가는" 상황(메모리 누수 등)까지 같은 대시보드에서 잡아낼 수 있다.
    collectDefaultMetrics({
      register: this.registry,
      prefix: "pong_pong_api_",
      eventLoopMonitoringPrecision: 20
    });
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  observeRequest(method: string, route: string, statusCode: number, durationMs: number): void {
    this.requestDuration.observe({
      method,
      route,
      status_code: String(statusCode)
    }, Math.max(0, durationMs) / 1_000);
  }

  observeReadiness(result: "ready" | "not_ready", durationMs: number): void {
    this.readinessDuration.observe({ result }, Math.max(0, durationMs) / 1_000);
  }

  observeDatabaseOperation(operation: string, outcome: "success" | "failure", durationMs: number): void {
    this.databaseOperationDuration.observe({
      operation: REPOSITORY_OPERATIONS.has(operation) ? operation : "other",
      outcome
    }, Math.max(0, durationMs) / 1_000);
  }

  observeSnapshotDelivery(delayMs: number): void {
    this.snapshotDeliveryDelay.observe(Math.max(0, delayMs) / 1_000);
  }

  recordSnapshotDrop(reason: "replaced" | "connection_closed" | "congestion"): void {
    this.snapshotDrops.inc({ reason });
  }

  recordFinalization(
    persistence: "database" | "memory",
    outcome: "success" | "failure",
    created: boolean | null
  ): void {
    this.matchFinalizations.inc({ persistence, outcome });
    if (persistence === "database" && outcome === "success" && created === false) {
      this.matchFinalizationDuplicates.inc();
    }
  }

  recordReconnect(outcome: "success" | "expired"): void {
    this.reconnects.inc({ outcome });
  }

  async scrape(): Promise<string> {
    const stats = this.readGameStats();
    this.connections.set(stats.onlinePlayers);
    this.queuedPlayers.set(stats.queuedPlayers);
    this.rooms.set(stats.activeRooms);
    // [INTV:ARCH] registry.metrics(): 등록된 모든 지표를 Prometheus 텍스트 노출 형식(사람이 읽을
    // 수 있는 평문) 문자열로 직렬화한다 — /metrics HTTP 응답 본문으로 그대로 내보내는 값.
    return this.registry.metrics();
  }

  close(): void {
    this.eventLoopDelay.disable();
    this.registry.clear();
  }
}

// [INTV:ARCH] AppRepository의 ~30개 메서드 하나하나에 "시간 재고 성공/실패 기록하기"를 수동으로
// 감싸는 대신, JS의 Proxy로 프로퍼티 접근 자체를 가로챈다 — 어떤 메서드가 호출되든(함수 프로퍼티라면)
// 자동으로 타이밍/결과를 관측한다. 새 리포지토리 메서드가 추가돼도 이 파일을 고칠 필요가 없다는 게
// 수동 래핑 대비 이 방식을 쓴 이유(AOP의 "관심사 분리" — 계측 로직이 비즈니스 로직 코드를 전혀
// 건드리지 않고 바깥에서 덧씌워진다, Spring의 @Transactional 프록시와 같은 원리를 언어 레벨
// Proxy로 직접 구현한 셈).
// - [FLOW] 1. Proxy의 get 트랩이 프로퍼티 접근을 가로챔 -> 2. 함수가 아니면 그대로 반환 -> 3.
//   함수면 원본을 감싼 새 함수를 반환 -> 4. 호출 시 시작 시각 기록 -> 5. 원본 호출(동기 예외는
//   즉시 catch) -> 6. 반환값을 Promise.resolve로 통일해 성공/실패를 동일한 방식으로 관측
export function instrumentRepository(
  repository: AppRepository,
  metrics: ApiMetrics
): AppRepository {
  return new Proxy(repository, {
    get(target, property) {
      // [INTV:TRAP] Reflect.get/Reflect.apply: Proxy 트랩 안에서 원본 객체의 프로퍼티를 읽거나
      // 메서드를 호출할 때 쓰는 "정석" 방법 — target[property]나 value(...args)로 직접 접근하는
      // 것과 결과는 비슷하지만, this 바인딩 등 미묘한 차이를 원본 동작 그대로 보존해준다. 재구현
      // 시 value.call(target, ...args) 같은 방식도 대부분 동작하지만, Reflect API는 Proxy 트랩의
      // 인자 형태와 정확히 대응하도록 설계돼 있어 이런 종류의 코드에서 관용적으로 권장된다.
      const value = Reflect.get(target, property, target);
      if (typeof property !== "string" || typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const startedAt = performance.now();
        let result: unknown;
        try {
          result = Reflect.apply(value as (...methodArgs: unknown[]) => unknown, target, args);
        } catch (error) {
          metrics.observeDatabaseOperation(property, "failure", performance.now() - startedAt);
          throw error;
        }
        // [INTV:TRAP] 메서드가 반환한 값을 Promise.resolve로 감싸서 then을 건다 — 이미 Promise였다면
        // 그대로, 혹시라도 동기 값을 반환하는 메서드였다면 그것도 동일한 방식으로 성공/실패를 관측할
        // 수 있게 통일한 것. 이 감싸기 없이 result가 Promise인지 매번 typeof/instanceof로 분기하면
        // 코드가 두 배로 복잡해지고, AppRepository 인터페이스가 미래에 동기 메서드를 추가해도 이
        // 코드가 안전하게 대응한다.
        return Promise.resolve(result).then(
          (resolved) => {
            metrics.observeDatabaseOperation(property, "success", performance.now() - startedAt);
            return resolved;
          },
          (error) => {
            metrics.observeDatabaseOperation(property, "failure", performance.now() - startedAt);
            throw error;
          }
        );
      };
    }
  }) as AppRepository;
}

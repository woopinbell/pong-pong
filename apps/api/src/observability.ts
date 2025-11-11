import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics
} from "prom-client";
import type { AppRepository } from "@pong-pong/db";

interface LiveGameStats {
  onlinePlayers: number;
  queuedPlayers: number;
  activeRooms: number;
}

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
  "completeTournamentMatch",
  "listAdminUsers",
  "listAdminActions",
  "setUserBan"
]);

export class ApiMetrics {
  private readonly registry = new Registry();
  private readonly requestDuration = new Histogram({
    name: "pong_pong_api_http_request_duration_seconds",
    help: "HTTP request duration in seconds",
    labelNames: ["method", "route", "status_code"] as const,
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
  private readonly reconnects = new Counter({
    name: "pong_pong_api_reconnects_total",
    help: "Websocket room reconnection outcomes",
    labelNames: ["outcome"] as const,
    registers: [this.registry]
  });

  constructor(private readonly readGameStats: () => LiveGameStats) {
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

  recordFinalization(persistence: "database" | "memory", outcome: "success" | "failure"): void {
    this.matchFinalizations.inc({ persistence, outcome });
  }

  recordReconnect(outcome: "success" | "expired"): void {
    this.reconnects.inc({ outcome });
  }

  async scrape(): Promise<string> {
    const stats = this.readGameStats();
    this.connections.set(stats.onlinePlayers);
    this.queuedPlayers.set(stats.queuedPlayers);
    this.rooms.set(stats.activeRooms);
    return this.registry.metrics();
  }

  close(): void {
    this.registry.clear();
  }
}

export function instrumentRepository(
  repository: AppRepository,
  metrics: ApiMetrics
): AppRepository {
  return new Proxy(repository, {
    get(target, property) {
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

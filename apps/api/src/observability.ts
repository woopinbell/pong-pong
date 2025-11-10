import {
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics
} from "prom-client";

interface LiveGameStats {
  onlinePlayers: number;
  queuedPlayers: number;
  activeRooms: number;
}

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

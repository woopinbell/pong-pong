import {
  Gauge,
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

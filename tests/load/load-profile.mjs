const DEFAULT_CONNECTIONS = 500;
const EXTENDED_CONNECTIONS = 1_000;
const DEFAULT_ROOMS = 50;

export function createLoadProfile(environment = {}) {
  const extended = environment.EXTENDED_LOAD === "1";
  const connections = positiveInteger(
    "CONNECTIONS",
    environment.CONNECTIONS,
    extended ? EXTENDED_CONNECTIONS : DEFAULT_CONNECTIONS
  );
  const rooms = positiveInteger("ROOMS", environment.ROOMS, DEFAULT_ROOMS);
  if (connections < rooms * 2) {
    throw new RangeError("CONNECTIONS must be at least twice the room count");
  }

  const minimumSuccessfulConnections = Math.ceil(connections * 0.99);
  const playerConnections = rooms * 2;
  const initialHoldMs = positiveInteger("INITIAL_HOLD_MS", environment.INITIAL_HOLD_MS, 90_000);
  const playerReconnectDelayMs = positiveInteger(
    "PLAYER_RECONNECT_DELAY_MS",
    environment.PLAYER_RECONNECT_DELAY_MS,
    10_000
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
    reconnectedHoldMs,
    options: {
      discardResponseBodies: true,
      scenarios: {
        pong: {
          executor: "per-vu-iterations",
          vus: connections,
          iterations: 1,
          maxDuration
        }
      },
      thresholds: {
        connection_success: ["rate>=0.99"],
        reconnect_success: ["rate>=0.99"],
        snapshot_delay_ms: ["p(95)<=150", "p(99)<=250"],
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

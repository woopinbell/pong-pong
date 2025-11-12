import exec from "k6/execution";
import http from "k6/http";
import ws from "k6/ws";
import { check, fail } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";
import { createLoadProfile } from "./load-profile.mjs";

const profile = createLoadProfile(__ENV);
const apiBaseUrl = (__ENV.API_BASE_URL || "http://127.0.0.1:4000").replace(/\/$/, "");
const websocketUrl = __ENV.WS_URL || "ws://127.0.0.1:4000/ws";

const connectionSuccess = new Rate("connection_success");
const reconnectSuccess = new Rate("reconnect_success");
const snapshotDelay = new Trend("snapshot_delay_ms");
const normalSnapshotDropRate = new Rate("normal_snapshot_drop_rate");
const finalizeResults = new Counter("finalize_results");
const finalizeFailures = new Counter("finalize_failures");
const finalizeDuplicates = new Counter("finalize_duplicates");
const onlineConnections = new Trend("online_connections");
const activeRooms = new Trend("active_rooms");

export const options = profile.options;

export function setup() {
  const response = http.get(`${apiBaseUrl}${__ENV.READY_PATH || "/health/ready"}`, {
    tags: { operation: "readiness" }
  });
  if (response.status !== 200) {
    fail(`API readiness failed with ${response.status}`);
  }
}

export default function () {
  const vuId = exec.vu.idInTest;
  const player = vuId <= profile.playerConnections;
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

function connectSession({ ticket, phase, player, expectedRoomId, finishedMatchIds, finishedRoomIds }) {
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
          if (!reconnectCloseArmed && phase === "initial") {
            reconnectCloseArmed = true;
            socket.setTimeout(() => socket.close(), profile.playerReconnectDelayMs);
          }
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
          snapshotDelay.add(Math.max(0, Date.now() - snapshot.serverTimeMs));
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
            finalizeResults.add(1);
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

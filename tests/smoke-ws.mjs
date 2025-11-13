const baseUrl = process.env.API_BASE_URL ?? "http://localhost:4000";
const wsUrl = process.env.WS_URL ?? "ws://localhost:4000/ws";

const left = await login("left-smoke", "왼쪽");
const right = await login("right-smoke", "오른쪽");

const leftSocket = connect(await issueTicket(left.cookie));
const rightSocket = connect(await issueTicket(right.cookie));
const events = [];

leftSocket.addEventListener("message", (event) => events.push({ side: "left", event: parseEvent(event.data) }));
rightSocket.addEventListener("message", (event) => events.push({ side: "right", event: parseEvent(event.data) }));

try {
  await opened(leftSocket);
  await opened(rightSocket);
  await waitFor(async () => {
    const lobby = await fetchJson(`${baseUrl}/lobby`);
    const onlineHandles = lobby.onlinePlayers.map((player) => player.handle);
    return onlineHandles.includes("left-smoke") && onlineHandles.includes("right-smoke") ? lobby : null;
  });

  send(leftSocket, { type: "chat.send", scope: "lobby", roomId: null, body: "로비 실시간 확인" });
  await waitFor(() => events.find((item) => item.event.type === "chat.message" && item.event.message.scope === "lobby"));

  send(leftSocket, { type: "queue.join", mode: "queue" });
  send(rightSocket, { type: "queue.join", mode: "queue" });

  const leftMatched = await waitFor(() => events.find((item) => item.side === "left" && item.event.type === "queue.matched"));
  const rightMatched = await waitFor(() => events.find((item) => item.side === "right" && item.event.type === "queue.matched"));
  const roomId = leftMatched.event.roomId === rightMatched.event.roomId ? leftMatched.event.roomId : null;
  if (!roomId) throw new Error("matched sockets joined different rooms");

  send(leftSocket, { type: "game.ready", roomId });
  send(rightSocket, { type: "game.ready", roomId });
  const firstPlaying = await waitFor(() => events.find((item) =>
    item.event.type === "game.snapshot" && item.event.snapshot.state.phase === "playing"
  ));
  const initialSpeed = speedOf(firstPlaying.event.snapshot.state.ball.velocity);
  if (initialSpeed < 11) throw new Error(`ball starts too slowly: ${initialSpeed}`);
  const accelerated = await waitFor(() => events.find((item) =>
    item.event.type === "game.snapshot"
      && item.event.snapshot.state.phase === "playing"
      && item.event.snapshot.tick >= firstPlaying.event.snapshot.tick + 20
  ));
  const acceleratedSpeed = speedOf(accelerated.event.snapshot.state.ball.velocity);
  if (acceleratedSpeed <= initialSpeed) throw new Error(`ball did not accelerate: ${initialSpeed} -> ${acceleratedSpeed}`);

  send(leftSocket, { type: "game.pause", roomId });
  await waitFor(() => events.find((item) =>
    item.event.type === "game.snapshot" && item.event.snapshot.state.phase === "paused"
  ));
  send(leftSocket, { type: "game.resume", roomId });
  await waitFor(() => events.filter((item) =>
    item.event.type === "game.snapshot" && item.event.snapshot.state.phase === "playing"
  ).length >= 2);

  send(leftSocket, { type: "chat.send", scope: "match", roomId, body: "준비됐습니다." });
  await waitFor(() => events.find((item) => item.event.type === "chat.message"));
} finally {
  leftSocket.close();
  rightSocket.close();
}

const solo = await login("solo-smoke", "혼자큐");
const soloSocket = connect(await issueTicket(solo.cookie));
const soloEvents = [];
soloSocket.addEventListener("message", (event) => soloEvents.push(parseEvent(event.data)));

try {
  await opened(soloSocket);
  send(soloSocket, { type: "queue.join", mode: "ai" });
  const matched = await waitFor(() =>
    soloEvents.find((event) => event.type === "queue.matched"));
  send(soloSocket, { type: "game.ready", roomId: matched.roomId });
  const aiSnapshot = await waitFor(() => soloEvents.find((event) =>
    event.type === "game.snapshot"
      && event.snapshot.state.players.some((player) => player.ai)
  ));
  const aiPlayer = aiSnapshot.snapshot.state.players.find((player) => player.ai);
  if (!aiPlayer) throw new Error("ai snapshot missing ai player");
} finally {
  soloSocket.close();
}

console.log("websocket smoke ok");

async function login(handle, displayName) {
  const response = await fetch(`${baseUrl}/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle, displayName })
  });
  if (!response.ok) throw new Error(`login failed: ${response.status}`);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("login did not set a session cookie");
  const body = await response.json();
  if ("token" in body) throw new Error("login exposed a JSON session token");
  return { cookie, user: body.user };
}

async function issueTicket(cookie) {
  const response = await fetch(`${baseUrl}/auth/ws-ticket`, {
    method: "POST",
    headers: { cookie }
  });
  if (!response.ok) throw new Error(`ticket request failed: ${response.status}`);
  const body = await response.json();
  if (body.protocolVersion !== 1) throw new Error(`unsupported ticket protocol: ${body.protocolVersion}`);
  return body.ticket;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`request failed: ${response.status}`);
  return response.json();
}

function connect(ticket) {
  return new WebSocket(`${wsUrl}?ticket=${encodeURIComponent(ticket)}&v=1`);
}

function send(socket, event) {
  socket.send(JSON.stringify({ v: 1, ...event }));
}

function parseEvent(payload) {
  const event = JSON.parse(payload);
  if (event.v !== 1) throw new Error(`received unversioned websocket event: ${payload}`);
  return event;
}

function opened(socket) {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
}

async function waitFor(predicate, timeout = 10_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeout) {
    const value = await predicate();
    if (value) return value;
    await delay(50);
  }
  throw new Error("timed out");
}

function speedOf(velocity) {
  return Math.hypot(velocity.x, velocity.y);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

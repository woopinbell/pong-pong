const baseUrl = process.env.API_BASE_URL ?? "http://localhost:4000";
const wsUrl = process.env.WS_URL ?? "ws://localhost:4000/ws";

const left = await login("left-smoke", "왼쪽");
const right = await login("right-smoke", "오른쪽");

const leftSocket = connect(left.token);
const rightSocket = connect(right.token);
const events = [];

leftSocket.addEventListener("message", (event) => events.push({ side: "left", event: JSON.parse(event.data) }));
rightSocket.addEventListener("message", (event) => events.push({ side: "right", event: JSON.parse(event.data) }));

try {
  await opened(leftSocket);
  await opened(rightSocket);
  await waitFor(async () => {
    const lobby = await fetchJson(`${baseUrl}/lobby`);
    const onlineHandles = lobby.onlinePlayers.map((player) => player.handle);
    return onlineHandles.includes("left-smoke") && onlineHandles.includes("right-smoke") ? lobby : null;
  });

  leftSocket.send(JSON.stringify({ type: "chat.send", scope: "lobby", roomId: null, body: "로비 실시간 확인" }));
  await waitFor(() => events.find((item) => item.event.type === "chat.message" && item.event.message.scope === "lobby"));

  leftSocket.send(JSON.stringify({ type: "queue.join", mode: "queue" }));
  rightSocket.send(JSON.stringify({ type: "queue.join", mode: "queue" }));

  const leftMatched = await waitFor(() => events.find((item) => item.side === "left" && item.event.type === "queue.matched"));
  const rightMatched = await waitFor(() => events.find((item) => item.side === "right" && item.event.type === "queue.matched"));
  const roomId = leftMatched.event.roomId === rightMatched.event.roomId ? leftMatched.event.roomId : null;
  if (!roomId) throw new Error("matched sockets joined different rooms");

  leftSocket.send(JSON.stringify({ type: "game.ready", roomId }));
  rightSocket.send(JSON.stringify({ type: "game.ready", roomId }));
  const firstPlaying = await waitFor(() => events.find((item) => item.event.type === "game.snapshot" && item.event.snapshot.phase === "playing"));
  const initialSpeed = speedOf(firstPlaying.event.snapshot.ball.velocity);
  if (initialSpeed < 11) throw new Error(`ball starts too slowly: ${initialSpeed}`);
  const accelerated = await waitFor(() =>
    events.find((item) => item.event.type === "game.snapshot" && item.event.snapshot.phase === "playing" && item.event.snapshot.tick >= firstPlaying.event.snapshot.tick + 20)
  );
  const acceleratedSpeed = speedOf(accelerated.event.snapshot.ball.velocity);
  if (acceleratedSpeed <= initialSpeed) throw new Error(`ball did not accelerate: ${initialSpeed} -> ${acceleratedSpeed}`);

  leftSocket.send(JSON.stringify({ type: "game.pause", roomId }));
  await waitFor(() => events.find((item) => item.event.type === "game.snapshot" && item.event.snapshot.phase === "paused"));
  leftSocket.send(JSON.stringify({ type: "game.resume", roomId }));
  await waitFor(() => events.filter((item) => item.event.type === "game.snapshot" && item.event.snapshot.phase === "playing").length >= 2);

  leftSocket.send(JSON.stringify({ type: "chat.send", scope: "match", roomId, body: "준비됐습니다." }));
  await waitFor(() => events.find((item) => item.event.type === "chat.message"));

} finally {
  leftSocket.close();
  rightSocket.close();
}

const solo = await login("solo-smoke", "혼자큐");
const soloSocket = connect(solo.token);
const soloEvents = [];
soloSocket.addEventListener("message", (event) => soloEvents.push(JSON.parse(event.data)));

try {
  await opened(soloSocket);
  soloSocket.send(JSON.stringify({ type: "queue.join", mode: "queue" }));
  const matched = await waitFor(() => soloEvents.find((event) => event.type === "queue.matched" && event.opponent.includes("AI")), 8_000);
  soloSocket.send(JSON.stringify({ type: "game.ready", roomId: matched.roomId }));
  const npcSnapshot = await waitFor(() => soloEvents.find((event) => event.type === "game.snapshot" && event.snapshot.players.some((player) => player.ai && player.handle.startsWith("npc-"))));
  const npcPlayer = npcSnapshot.snapshot.players.find((player) => player.ai);
  if (!npcPlayer) throw new Error("npc snapshot missing ai player");
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
  return response.json();
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`request failed: ${response.status}`);
  return response.json();
}

function connect(token) {
  return new WebSocket(`${wsUrl}?session=${token}`);
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

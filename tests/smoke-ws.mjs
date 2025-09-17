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
  await waitFor(() => events.find((item) => item.event.type === "game.snapshot" && item.event.snapshot.phase === "playing"));
  leftSocket.send(JSON.stringify({ type: "game.pause", roomId }));
  await waitFor(() => events.find((item) => item.event.type === "game.snapshot" && item.event.snapshot.phase === "paused"));
  leftSocket.send(JSON.stringify({ type: "game.resume", roomId }));
  await waitFor(() => events.filter((item) => item.event.type === "game.snapshot" && item.event.snapshot.phase === "playing").length >= 2);

  leftSocket.send(JSON.stringify({ type: "chat.send", scope: "match", roomId, body: "준비됐습니다." }));
  await waitFor(() => events.find((item) => item.event.type === "chat.message"));

  console.log("websocket smoke ok");
} finally {
  leftSocket.close();
  rightSocket.close();
}

async function login(handle, displayName) {
  const response = await fetch(`${baseUrl}/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle, displayName })
  });
  if (!response.ok) throw new Error(`login failed: ${response.status}`);
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

function waitFor(predicate) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const value = predicate();
      if (value) {
        clearInterval(timer);
        resolve(value);
      }
      if (Date.now() - startedAt > 10_000) {
        clearInterval(timer);
        reject(new Error("timed out"));
      }
    }, 50);
  });
}

const baseUrl = process.env.API_BASE_URL ?? "http://localhost:4000";
const wsUrl = process.env.WS_URL ?? "ws://localhost:4000/ws";

const left = await login("left-smoke", "왼쪽");
const right = await login("right-smoke", "오른쪽");

const leftSocket = connect(left.token);
const rightSocket = connect(right.token);
const events = [];

leftSocket.addEventListener("message", (event) => events.push(JSON.parse(event.data)));
rightSocket.addEventListener("message", (event) => events.push(JSON.parse(event.data)));

await opened(leftSocket);
await opened(rightSocket);
leftSocket.send(JSON.stringify({ type: "queue.join", mode: "queue" }));
rightSocket.send(JSON.stringify({ type: "queue.join", mode: "queue" }));

const matched = await waitFor(() => events.find((event) => event.type === "queue.matched"));
leftSocket.send(JSON.stringify({ type: "game.ready", roomId: matched.roomId }));
rightSocket.send(JSON.stringify({ type: "game.ready", roomId: matched.roomId }));
leftSocket.send(JSON.stringify({ type: "chat.send", scope: "match", roomId: matched.roomId, body: "준비됐습니다." }));

await waitFor(() => events.find((event) => event.type === "game.snapshot" && event.snapshot.phase === "playing"));
await waitFor(() => events.find((event) => event.type === "chat.message"));

leftSocket.close();
rightSocket.close();
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

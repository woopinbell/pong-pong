const baseUrl = process.env.API_BASE_URL ?? "http://localhost:4000";

const login = await request("/auth/dev-login", {
  method: "POST",
  body: JSON.stringify({ handle: "smoke", displayName: "스모크" })
});

await request("/me", { headers: { authorization: `Bearer ${login.token}` } });
await request("/lobby", { headers: { authorization: `Bearer ${login.token}` } });
await request("/chat/lobby", {
  method: "POST",
  headers: { authorization: `Bearer ${login.token}` },
  body: JSON.stringify({ body: "스모크 로비 채팅" })
});
await request("/leaderboard");
await request("/dashboard", { headers: { authorization: `Bearer ${login.token}` } });

console.log("api smoke ok");

async function request(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init.headers
    }
  });
  if (!response.ok) {
    throw new Error(`${path} failed with ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

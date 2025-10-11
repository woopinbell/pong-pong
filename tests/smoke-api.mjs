const baseUrl = process.env.API_BASE_URL ?? "http://localhost:4000";

const login = await request("/auth/dev-login", {
  method: "POST",
  body: JSON.stringify({ handle: "smoke", displayName: "스모크" })
});
if (!login.cookie) throw new Error("dev login did not set the session cookie");
if ("token" in login.body) throw new Error("dev login exposed a JSON session token");

await request("/me", { cookie: login.cookie });
await request("/lobby", { cookie: login.cookie });
await request("/chat/lobby", {
  method: "POST",
  cookie: login.cookie,
  body: JSON.stringify({ body: "스모크 로비 채팅" })
});
await request("/leaderboard");
await request("/dashboard", { cookie: login.cookie });
await request("/tournaments");
await request("/tournaments", {
  method: "POST",
  cookie: login.cookie,
  body: JSON.stringify({ name: "스모크 컵" })
});

const adminHandle = await request("/auth/dev-login", {
  method: "POST",
  body: JSON.stringify({ handle: "admin", displayName: "운영자" })
});
if (!adminHandle.cookie) throw new Error("admin-handle login did not set a cookie");
await request("/admin/actions", {
  cookie: adminHandle.cookie,
  expectedStatus: 403
});

console.log("api smoke ok");

async function request(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: init.method,
    body: init.body,
    headers: {
      "content-type": "application/json",
      ...(init.cookie ? { cookie: init.cookie } : {})
    }
  });
  const expectedStatus = init.expectedStatus ?? 200;
  if (response.status !== expectedStatus) {
    throw new Error(`${path} returned ${response.status}, expected ${expectedStatus}: ${await response.text()}`);
  }
  const setCookie = response.headers.get("set-cookie");
  return {
    body: await response.json(),
    cookie: setCookie?.split(";", 1)[0]
  };
}

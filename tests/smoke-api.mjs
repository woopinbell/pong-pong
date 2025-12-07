// "스모크 테스트": 단위/통합 테스트(vitest)와 달리, 이 스크립트는 실제로 떠 있는(배포된) API 서버를 상대로
// node로 직접 실행하는 절차형 스크립트다(describe/it 없이 위에서 아래로 순서대로 실행되고, 무언가 예상과
// 다르면 그냥 Error를 던져 프로세스를 비정상 종료시킨다). 배포 직후 "핵심 기능들이 최소한 살아있는지"를
// 빠르게 확인하는 용도 — CI/배포 파이프라인에서 pnpm smoke:http 같은 스크립트로 돌린다.
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

// apps/web/src/lib/api.ts의 apiFetch와 비슷한 역할을 하는, 이 스크립트 전용의 아주 단순한 fetch 래퍼 —
// 프로젝트 빌드 산출물에 의존하지 않고 이 파일 하나만으로 독립적으로 돌 수 있게 직접 구현했다.
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

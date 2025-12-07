import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
  type WebSocketRoute
} from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const demoMode = process.env.E2E_APP_MODE === "demo";

test.describe("게스트 데모 브라우저 흐름", () => {
  // mode: "serial": 이 describe 블록 안의 테스트들을 병렬이 아니라 위에서부터 순서대로 하나씩 실행하도록
  // 강제한다 — 아래 테스트들이 같은 데모 서버 상태(대기열 등)를 공유하며 서로 영향을 줄 수 있어서다.
  test.describe.configure({ mode: "serial" });
  // test.skip(조건, 이유): 조건이 참이면 이 스위트 전체를 건너뛰고, Playwright 리포트에 그 이유를 남긴다 —
  // 이 시나리오는 데모 모드로 띄운 서버가 있을 때만 의미가 있으므로, 일반 실행에서는 스킵된다.
  test.skip(!demoMode, "APP_MODE=demo 서버를 대상으로 별도 실행한다.");

  test("입력 없이 게스트로 진입하고 제한된 메뉴만 보여 준다", async ({ page }) => {
    const displayName = await enterAsGuest(page);

    await expect(page.getByRole("heading", { name: `다시 오신 것을 환영합니다, ${displayName}` })).toBeVisible();
    await expect(page.getByRole("navigation").getByRole("link")).toHaveText(["로비", "경기"]);
    await expect(page.getByRole("link", { name: "관리" })).toHaveCount(0);
    await expect(page.getByText("빠른 매칭으로 다른 게스트를 찾고, 상대가 없으면 인공지능과 바로 경기할 수 있습니다.")).toBeVisible();
  });

  test("서로 다른 두 게스트를 같은 PvP 방에 연결한다", async ({ browser }, testInfo) => {
    // Playwright는 이 프로젝트가 설정한 여러 "프로젝트"(예: 데스크톱 크롬, 모바일 뷰포트 등) 조합마다
    // 같은 테스트를 반복 실행한다. 두 브라우저 컨텍스트를 띄워야 하는(느리고 중복성 낮은) 시나리오는
    // 그중 한 프로젝트에서만 한 번 돌리도록 나머지를 건너뛴다.
    test.skip(testInfo.project.name !== "chromium-desktop", "두 브라우저 흐름은 desktop 프로젝트에서 한 번만 실행한다.");

    const left = await createGuestPage(browser);
    const right = await createGuestPage(browser);
    try {
      const [leftName, rightName] = await Promise.all([
        enterAsGuest(left.page),
        enterAsGuest(right.page)
      ]);

      await Promise.all([
        openPlayPage(left.page),
        openPlayPage(right.page)
      ]);
      await Promise.all([
        left.page.getByRole("button", { name: "매칭 큐 참가" }).click(),
        right.page.getByRole("button", { name: "매칭 큐 참가" }).click()
      ]);

      await expect(left.page.getByText("준비 대기 중")).toBeVisible();
      await expect(right.page.getByText("준비 대기 중")).toBeVisible();
      await expect(left.page.getByText(rightName, { exact: true })).toBeVisible();
      await expect(right.page.getByText(leftName, { exact: true })).toBeVisible();

      await Promise.all([
        left.page.getByRole("button", { name: "준비" }).click(),
        right.page.getByRole("button", { name: "준비" }).click()
      ]);
      await expect(left.page.getByText("경기 진행 중")).toBeVisible();
      await expect(right.page.getByText("경기 진행 중")).toBeVisible();
    } finally {
      await Promise.all([left.context.close(), right.context.close()]);
    }
  });

  test("대기 중인 게스트를 6초 뒤 AI 방으로 옮긴다", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop", "시간 검증은 desktop 프로젝트에서 한 번만 실행한다.");

    await enterAsGuest(page);
    await openPlayPage(page);
    const frames = watchJsonFrames(page);
    await page.getByRole("button", { name: "매칭 큐 참가" }).click();

    await expect(page.getByText("준비 대기 중")).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText("연습 AI", { exact: true })).toBeVisible();

    const joined = frames.find((frame) => frame.direction === "sent" && frame.type === "queue.join");
    const matched = frames.find((frame) => frame.direction === "received" && frame.type === "queue.matched");
    expect(joined).toBeDefined();
    expect(matched).toBeDefined();
    expect(matched!.atMs - joined!.atMs).toBeGreaterThanOrEqual(5_500);
    expect(matched!.atMs - joined!.atMs).toBeLessThan(10_000);

    await page.getByRole("button", { name: "준비" }).click();
    await expect(page.getByText("경기 진행 중")).toBeVisible();
  });

  test("경기 중 WebSocket이 끊겨도 새 ticket으로 복구한다", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop", "재연결 흐름은 desktop 프로젝트에서 한 번만 실행한다.");

    await enterAsGuest(page);
    // page.routeWebSocket: 브라우저가 맺으려는 WS 연결을 Playwright가 가로채, 실제 서버로 이어주는(
    // connectToServer()) "중간 다리"를 테스트 코드가 직접 쥐고 흔들 수 있게 해준다. 아래에서 이 중간 다리의
    // page 쪽(connections[0].page)을 의도적으로 close()시켜, 실제 네트워크 단절을 인위적으로 재현한다 —
    // GameSocketClient.ts의 재연결 로직이 진짜 브라우저 환경에서도 동작하는지 끝까지 확인하기 위함.
    const connections: Array<{ page: WebSocketRoute; server: WebSocketRoute }> = [];
    await page.routeWebSocket(/.*/, async (socket) => {
      if (connections.length > 0) await new Promise((resolve) => setTimeout(resolve, 600));
      connections.push({ page: socket, server: socket.connectToServer() });
    });
    await openPlayPage(page);

    await page.getByRole("button", { name: "인공지능 연습 시작" }).click();
    await expect(page.getByText("준비 대기 중")).toBeVisible();
    await page.getByRole("button", { name: "준비" }).click();
    await expect(page.getByText("경기 진행 중")).toBeVisible();
    expect(connections).toHaveLength(1);

    // close 코드 1012는 WS 표준의 "Service Restart" — 서버가 재시작 등으로 연결을 끊을 때 쓰는 정상적인
    // 코드다. 여기서는 그 상황을 흉내 내어 클라이언트가 실제로 재연결을 시도하는지 관찰한다.
    await connections[0].page.close({ code: 1012, reason: "e2e reconnect" });
    await expect(page.getByText("재연결 대기 중")).toBeVisible({ timeout: 2_000 });
    await expect.poll(() => connections.length, { timeout: 5_000 }).toBe(2);
    await expect(page.getByText("경기 진행 중")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole("button", { name: "일시정지" })).toBeEnabled();
  });
});

async function createGuestPage(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL });
  return { context, page: await context.newPage() };
}

async function enterAsGuest(page: Page): Promise<string> {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "퐁퐁" })).toBeVisible();
  await expect(page.getByLabel("핸들")).toHaveCount(0);
  await page.getByRole("button", { name: "게스트로 시작" }).click();

  const welcome = page.getByRole("heading", { name: /다시 오신 것을 환영합니다, 게스트 [0-9]{4}/ });
  await expect(welcome).toBeVisible();
  const text = await welcome.textContent();
  const displayName = text?.replace("다시 오신 것을 환영합니다, ", "").trim();
  expect(displayName).toMatch(/^게스트 [0-9]{4}$/);
  return displayName!;
}

async function openPlayPage(page: Page): Promise<void> {
  await page.goto("/play");
  await expect(page.getByRole("heading", { name: "경기장" })).toBeVisible();
  await expect(page.getByText("경기 전")).toBeVisible();
}

type JsonFrame = {
  direction: "sent" | "received";
  type: string;
  atMs: number;
};

// page.on("websocket", ...)과 프레임 이벤트(framesent/framereceived)는 Playwright가 제공하는 저수준
// WS 관찰 API — 실제 브라우저가 주고받는 프레임의 도착 시각을 그대로 기록해서, "AI 대체까지 정말 6초 정도
// 걸리는지" 같은 실제 타이밍을 (가짜 타이머가 아니라) 진짜 시간으로 검증하는 데 쓴다.
function watchJsonFrames(page: Page): JsonFrame[] {
  const frames: JsonFrame[] = [];
  page.on("websocket", (socket) => {
    socket.on("framesent", (event) => record("sent", event.payload));
    socket.on("framereceived", (event) => record("received", event.payload));
  });
  return frames;

  function record(direction: JsonFrame["direction"], payload: string | Buffer): void {
    try {
      const value = JSON.parse(payload.toString()) as { type?: unknown };
      if (typeof value.type === "string") frames.push({ direction, type: value.type, atMs: Date.now() });
    } catch {
      // JSON이 아닌 WebSocket 프레임은 이 시나리오의 시간 측정 대상이 아니다.
    }
  }
}

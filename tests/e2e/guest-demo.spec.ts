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
  test.describe.configure({ mode: "serial" });
  test.skip(!demoMode, "APP_MODE=demo 서버를 대상으로 별도 실행한다.");

  test("입력 없이 게스트로 진입하고 제한된 메뉴만 보여 준다", async ({ page }) => {
    const displayName = await enterAsGuest(page);

    await expect(page.getByRole("heading", { name: `다시 오신 것을 환영합니다, ${displayName}` })).toBeVisible();
    await expect(page.getByRole("navigation").getByRole("link")).toHaveText(["로비", "경기"]);
    await expect(page.getByRole("link", { name: "관리" })).toHaveCount(0);
    await expect(page.getByText("빠른 매칭으로 다른 게스트를 찾고, 상대가 없으면 인공지능과 바로 경기할 수 있습니다.")).toBeVisible();
  });

  test("서로 다른 두 게스트를 같은 PvP 방에 연결한다", async ({ browser }, testInfo) => {
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

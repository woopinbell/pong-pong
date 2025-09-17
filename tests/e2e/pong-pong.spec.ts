import { expect, test } from "@playwright/test";

const apiBase = process.env.API_BASE_URL ?? "http://localhost:4000";

async function login(page: import("@playwright/test").Page, handle: string, displayName: string) {
  await page.goto("/");
  await page.getByLabel("핸들").fill(handle);
  await page.getByLabel("표시 이름").fill(displayName);
  await page.getByRole("button", { name: "개발 로그인" }).click();
  await page.getByRole("link", { name: "경기", exact: true }).waitFor();
}

test("한국어 로비에서 로그인하고 주요 화면을 이동한다", async ({ page }) => {
  const lobbyMessage = `로비에서 바로 보냅니다 ${Date.now()} ${Math.random()}`;
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "퐁퐁" })).toBeVisible();
  await page.getByLabel("핸들").fill("tester");
  await page.getByLabel("표시 이름").fill("테스터");
  await page.getByRole("button", { name: "개발 로그인" }).click();

  await expect(page.getByRole("link", { name: "빠른 매칭" })).toBeVisible();
  await expect(page.getByText(/대기 없음|0초/)).toBeVisible();
  await page.getByPlaceholder("로비 메시지 입력").fill(lobbyMessage);
  await page.getByRole("button", { name: "보내기" }).click();
  await expect(page.getByText(lobbyMessage)).toBeVisible();
  await page.getByRole("link", { name: "대시보드" }).click();
  await expect(page.getByRole("heading", { name: "내 대시보드" })).toBeVisible();
  await page.getByRole("link", { name: "순위표" }).click();
  await expect(page.getByRole("heading", { name: "순위표" })).toBeVisible();
  await page.getByRole("link", { name: "토너먼트" }).click();
  await expect(page.getByRole("heading", { name: "토너먼트" })).toBeVisible();
  await page.getByRole("link", { name: "프로필" }).click();
  await expect(page).toHaveURL(/\/profile\/tester$/);
});

test("플레이 화면의 캔버스가 실제 픽셀을 그린다", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("핸들").fill("canvas");
  await page.getByLabel("표시 이름").fill("캔버스");
  await page.getByRole("button", { name: "개발 로그인" }).click();
  await page.getByRole("link", { name: "경기", exact: true }).click();
  await expect(page.getByRole("heading", { name: "경기장" })).toBeVisible();
  await expect(page.getByText("경기 전")).toBeVisible();
  await expect(page.getByText("연습 상대")).toHaveCount(0);
  await expect(page.getByText("아직 매치 채팅이 없습니다.")).toBeVisible();

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const beforeScroll = await page.evaluate(() => window.scrollY);
  await page.keyboard.down("ArrowDown");
  await page.keyboard.up("ArrowDown");
  const afterScroll = await page.evaluate(() => window.scrollY);
  expect(afterScroll).toBe(beforeScroll);

  const hasPaint = await page.locator("canvas").evaluate((canvas) => {
    const ctx = (canvas as HTMLCanvasElement).getContext("2d");
    if (!ctx) return false;
    const data = ctx.getImageData(0, 0, (canvas as HTMLCanvasElement).width, (canvas as HTMLCanvasElement).height).data;
    for (let index = 3; index < data.length; index += 4) {
      if (data[index] !== 0) return true;
    }
    return false;
  });
  expect(hasPaint).toBe(true);
});

test("매치 채팅과 일시정지 제어를 확인한다", async ({ page }) => {
  await login(page, "chat-player", "채팅선수");
  await page.getByRole("link", { name: "경기", exact: true }).click();
  await page.getByRole("button", { name: "인공지능 연습 시작" }).click();
  await expect(page.getByText("준비 대기 중")).toBeVisible();
  await page.getByRole("button", { name: "준비" }).click();
  await expect(page.getByText("경기 진행 중")).toBeVisible();

  await page.getByRole("button", { name: "일시정지" }).click();
  await expect(page.getByText("일시정지 중")).toBeVisible();
  await page.getByRole("button", { name: "다시 시작" }).click();
  await expect(page.getByText("경기 진행 중")).toBeVisible();
  await page.getByPlaceholder("메시지 입력").fill("좋은 랠리였습니다.");
  await page.getByRole("button", { name: "보내기" }).click();
  await expect(page.getByText("채팅선수: 좋은 랠리였습니다.")).toBeVisible();
});

test("프로필 친구 요청과 공유 복사를 확인한다", async ({ page }) => {
  await page.context().grantPermissions(["clipboard-write"]);
  await login(page, "friend-tester", "친구테스터");
  await page.goto("/profile/spin-doctor");
  await expect(page.getByRole("heading", { name: "공개 최근 경기" })).toBeVisible();
  await page.getByRole("button", { name: "친구 추가" }).click();
  await expect(page.getByText(/친구 요청을 보냈습니다/)).toBeVisible();
  await page.getByRole("button", { name: "공유" }).click();
  await expect(page.getByText(/공유 링크를/)).toBeVisible();
});

test("토너먼트 브래킷과 경기 입장 액션을 확인한다", async ({ page, request }) => {
  await login(page, "cup-player", "컵선수");
  const token = await page.evaluate(() => window.localStorage.getItem("pong-pong-token"));
  const name = `E2E 퐁퐁 컵 ${Date.now()}`;
  const created = await request.post(`${apiBase}/tournaments`, {
    headers: { authorization: `Bearer ${token}` },
    data: { name }
  });
  const tournament = (await created.json()).tournament as { id: string };
  for (const handle of ["cup-two", "cup-three", "cup-four"]) {
    const loginResponse = await request.post(`${apiBase}/auth/dev-login`, {
      data: { handle, displayName: handle }
    });
    const playerToken = (await loginResponse.json()).token as string;
    await request.post(`${apiBase}/tournaments/${tournament.id}/join`, {
      headers: { authorization: `Bearer ${playerToken}` }
    });
  }
  await page.getByRole("link", { name: "토너먼트" }).click();
  await page.getByRole("button", { name }).click();
  await expect(page.getByText("준결승")).toBeVisible();
  await expect(page.getByRole("link", { name: "경기 입장" })).toBeVisible();
});

test("관리 화면에서 사용자 상태를 변경한다", async ({ page }) => {
  const reason = `E2E 운영 확인 ${Date.now()} ${Math.random()}`;
  await login(page, "admin", "운영자");
  await page.getByRole("link", { name: "관리" }).click();
  await expect(page.getByText("사용자 목록과 감사 로그를 불러왔습니다.")).toBeVisible();
  await page.getByLabel("조치 사유").fill(reason);
  await page.getByRole("button", { name: /정지|해제/ }).first().click();
  await expect(page.getByText(/상태를|운영자 권한/)).toBeVisible();
  await expect(page.getByText(reason)).toBeVisible();
});

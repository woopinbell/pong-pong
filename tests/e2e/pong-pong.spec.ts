// Playwright: 실제 브라우저(크로미움 등)를 띄워 화면을 클릭/입력하며 검증하는 E2E(End-to-End) 테스트 도구.
// 이전까지의 vitest 테스트들이 함수/모듈 단위였다면, 이 파일은 배포된(또는 로컬 실행 중인) 웹앱 전체를
// 실제 사용자처럼 조작한다.
import { expect, test } from "@playwright/test";

const apiBase = process.env.API_BASE_URL ?? "http://localhost:4000";
const maxDevHandleLength = 24;
const maxIdentitySuffixLength = 12;
const runToken = Date.now().toString(36);

// Playwright는 테스트를 여러 워커(프로세스)로 병렬 실행하고, CI에서는 같은 테스트가 여러 번 반복 실행되기도
// 한다 — 그때마다 다른 handle로 로그인해야 서로 다른 테스트/실행이 같은 계정을 두고 충돌하지 않는다.
// projectToken(모바일/데스크톱 구분)·workerIndex·실행 시각을 섞어 고유하면서도 devLoginBodySchema가
// 허용하는 길이(최대 24자) 안에 들어오는 짧은 handle을 만든다.
function identitySuffix(testInfo: import("@playwright/test").TestInfo): string {
  const projectToken = testInfo.project.name.includes("mobile") ? "m" : "d";
  const workerToken = testInfo.workerIndex.toString(36).slice(-2);
  const suffix = `${projectToken}${workerToken}-${runToken}`;
  if (suffix.length > maxIdentitySuffixLength) {
    throw new Error(`E2E identity suffix exceeds ${maxIdentitySuffixLength} characters`);
  }
  return suffix;
}

function uniqueHandle(prefix: string, testInfo: import("@playwright/test").TestInfo): string {
  const handle = `${prefix}-${identitySuffix(testInfo)}`;
  if (handle.length > maxDevHandleLength) {
    throw new Error(`E2E handle exceeds ${maxDevHandleLength} characters`);
  }
  return handle;
}

// page.getByLabel/getByRole/getByPlaceholder/getByText: Playwright의 "접근성 트리 기반" 로케이터 API —
// CSS 클래스나 DOM 구조가 아니라, 실제 사용자(와 스크린 리더)가 화면을 인식하는 방식(라벨, 역할과 이름,
// 보이는 텍스트)으로 요소를 찾는다. 그래서 이 프로젝트가 label의 htmlFor/버튼 텍스트 같은 걸 신경 써서
// 작성해둔 것이 이 테스트들이 그대로 동작하는 전제가 된다.
async function login(page: import("@playwright/test").Page, handle: string, displayName: string) {
  await page.goto("/");
  await page.getByLabel("핸들").fill(handle);
  await page.getByLabel("표시 이름").fill(displayName);
  await page.getByRole("button", { name: "개발 로그인" }).click();
  await page.getByRole("link", { name: "경기", exact: true }).waitFor();
}

test("한국어 로비에서 로그인하고 주요 화면을 이동한다", async ({ page }, testInfo) => {
  const handle = uniqueHandle("tester", testInfo);
  const lobbyMessage = `로비에서 바로 보냅니다 ${Date.now()} ${Math.random()}`;
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "퐁퐁" })).toBeVisible();
  await page.getByLabel("핸들").fill(handle);
  await page.getByLabel("표시 이름").fill("테스터");
  await page.getByRole("button", { name: "개발 로그인" }).click();

  await expect(page.getByRole("link", { name: "빠른 매칭" })).toBeVisible();
  await expect(page.getByText(/대기 없음|[0-9]+초/)).toBeVisible();
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
  await expect(page).toHaveURL(new RegExp(`/profile/${handle}$`));
});

test("플레이 화면의 캔버스가 실제 픽셀을 그린다", async ({ page }, testInfo) => {
  await page.goto("/");
  await page.getByLabel("핸들").fill(uniqueHandle("canvas", testInfo));
  await page.getByLabel("표시 이름").fill("캔버스");
  await page.getByRole("button", { name: "개발 로그인" }).click();
  await page.getByRole("link", { name: "경기", exact: true }).click();
  await expect(page.getByRole("heading", { name: "경기장" })).toBeVisible();
  await expect(page.getByText("경기 전")).toBeVisible();
  await expect(page.getByText("연습 상대")).toHaveCount(0);
  await expect(page.getByText("아직 매치 채팅이 없습니다.")).toBeVisible();

  // page.evaluate: 넘긴 함수를 Node가 아니라 "브라우저 페이지 안에서" 실행하고 그 결과를 테스트 쪽으로
  // 가져온다. 브라우저 기본 동작은 방향키로 페이지를 스크롤시키는데, play/page.tsx의 키보드 핸들러가
  // event.preventDefault()로 그걸 막고 있어야 한다 — 실제로 ArrowDown을 눌러도 스크롤 위치가 그대로인지
  // 확인해서, 그 preventDefault가 실제 브라우저에서도 동작하는지를 검증한다.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const beforeScroll = await page.evaluate(() => window.scrollY);
  await page.keyboard.down("ArrowDown");
  await page.keyboard.up("ArrowDown");
  const afterScroll = await page.evaluate(() => window.scrollY);
  expect(afterScroll).toBe(beforeScroll);

  // <canvas>는 텍스트나 DOM 구조로 내용을 확인할 수 없으므로, 실제로 그려진 픽셀 데이터를 직접 읽어서
  // "뭔가 그려지긴 했는지"를 검증한다. getImageData는 RGBA 4바이트 단위로 픽셀을 반환하므로, index 3부터
  // 4씩 건너뛰며 알파(불투명도) 값만 훑어 0이 아닌(완전 투명하지 않은) 픽셀이 하나라도 있는지 본다.
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

test("매치 채팅과 일시정지 제어를 확인한다", async ({ page }, testInfo) => {
  await login(page, uniqueHandle("chat", testInfo), "채팅선수");
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

test("프로필 친구 요청과 공유 복사를 확인한다", async ({ page }, testInfo) => {
  // 헤드리스 브라우저는 기본적으로 클립보드 접근을 막는다 — profile 페이지의 navigator.clipboard.writeText
  // 호출이 실제로 성공하려면 테스트가 먼저 이 권한을 명시적으로 허용해줘야 한다.
  await page.context().grantPermissions(["clipboard-write"]);
  await login(page, uniqueHandle("friend", testInfo), "친구테스터");
  await page.goto("/profile/spin-doctor");
  await expect(page.getByRole("heading", { name: "공개 최근 경기" })).toBeVisible();
  await page.getByRole("button", { name: "친구 추가" }).click();
  await expect(page.getByText(/친구 요청을 보냈습니다/)).toBeVisible();
  await page.getByRole("button", { name: "공유" }).click();
  await expect(page.getByText(/공유 링크를/)).toBeVisible();
});

test("토너먼트 브래킷과 경기 입장 액션을 확인한다", async ({ page, playwright }, testInfo) => {
  const suffix = identitySuffix(testInfo);
  await login(page, uniqueHandle("cup-player", testInfo), "컵선수");
  const name = `E2E 퐁퐁 컵 ${suffix}`;
  const created = await page.request.post(`${apiBase}/tournaments`, {
    data: { name }
  });
  expect(created.ok()).toBe(true);
  const tournament = (await created.json()).tournament as { id: string };
  const duplicateJoin = await page.request.post(`${apiBase}/tournaments/${tournament.id}/join`);
  expect(duplicateJoin.ok()).toBe(true);
  // 브라우저 탭을 3개 더 띄우는 대신, playwright.request.newContext()로 각자 독립된 쿠키를 가진 순수 API
  // 요청 컨텍스트를 만들어 나머지 참가자들을 빠르게 채운다 — 이 테스트가 실제로 보고 싶은 건 UI(브래킷
  // 화면)이지 다른 세 참가자의 로그인 과정 자체가 아니므로, 거기엔 굳이 브라우저를 쓰지 않는다.
  for (const handle of ["cup-two", "cup-three", "cup-four"]) {
    const playerRequest = await playwright.request.newContext();
    try {
      const loginResponse = await playerRequest.post(`${apiBase}/auth/dev-login`, {
        data: { handle: uniqueHandle(handle, testInfo), displayName: handle }
      });
      expect(loginResponse.ok()).toBe(true);
      const joinResponse = await playerRequest.post(`${apiBase}/tournaments/${tournament.id}/join`);
      expect(joinResponse.ok()).toBe(true);
    } finally {
      await playerRequest.dispose();
    }
  }
  await page.getByRole("link", { name: "토너먼트" }).click();
  await page.getByRole("button", { name }).click();
  await expect(page.getByText("준결승")).toBeVisible();
  await expect(page.getByRole("link", { name: "경기 입장" })).toBeVisible();
});

test("admin 핸들만으로 운영자 권한을 얻지 못한다", async ({ page }, testInfo) => {
  await login(page, uniqueHandle("admin", testInfo), "운영자");
  await page.getByRole("link", { name: "관리" }).click();
  await expect(page.getByText("운영자 권한이 필요합니다.")).toBeVisible();
  await expect(page.getByRole("button", { name: /정지|해제/ })).toHaveCount(0);
});

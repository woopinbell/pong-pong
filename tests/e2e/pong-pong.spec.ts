import { expect, test } from "@playwright/test";

test("한국어 로비에서 로그인하고 주요 화면을 이동한다", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "퐁퐁" })).toBeVisible();
  await page.getByLabel("핸들").fill("tester");
  await page.getByLabel("표시 이름").fill("테스터");
  await page.getByRole("button", { name: "개발 로그인" }).click();

  await expect(page.getByRole("link", { name: "빠른 매칭" })).toBeVisible();
  await page.getByRole("link", { name: "대시보드" }).click();
  await expect(page.getByRole("heading", { name: "내 대시보드" })).toBeVisible();
  await page.getByRole("link", { name: "순위표" }).click();
  await expect(page.getByRole("heading", { name: "순위표" })).toBeVisible();
  await page.getByRole("link", { name: "토너먼트" }).click();
  await expect(page.getByRole("heading", { name: "토너먼트" })).toBeVisible();
});

test("플레이 화면의 캔버스가 실제 픽셀을 그린다", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("핸들").fill("canvas");
  await page.getByLabel("표시 이름").fill("캔버스");
  await page.getByRole("button", { name: "개발 로그인" }).click();
  await page.getByRole("link", { name: "경기" }).click();
  await expect(page.getByRole("heading", { name: "경기장" })).toBeVisible();

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

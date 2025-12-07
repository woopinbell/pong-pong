import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { chromium, devices } from "@playwright/test";

// 이건 테스트가 아니라, 데모 시나리오를 실제로 재생시켜 스크린샷/영상을 뽑아내는 제작 스크립트다 —
// tests/e2e/guest-demo.spec.ts와 거의 같은 흐름(게스트 입장, PvP 재연결, AI 폴백)을 밟지만, 결과를
// assert로 검증하는 대신 README/소개 페이지 등에 쓸 이미지·영상 자산으로 저장한다. test() 러너의 fixture를
// 쓰지 않고 chromium.launch()로 Playwright의 저수준 브라우저 자동화 API를 직접 다룬다.
const baseURL = process.env.DEMO_BASE_URL ?? "http://localhost:8080";
const rootDir = process.cwd();
// 실행할 때마다 시각을 넣은 폴더명을 만들어, 이전 실행분 위에 그냥 덮어써버리지 않게 한다.
const runLabel = new Date().toISOString().replaceAll(/[:.]/g, "-");
const rawDir = path.join(rootDir, "output", "playwright", `guest-demo-${runLabel}`);
const draftDir = path.join(rootDir, "application-draft", "assets", "guest-demo");

await mkdir(rawDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const rawFiles = [];
try {
  rawFiles.push(await captureGuestEntry(browser));
  rawFiles.push(...await capturePvpReconnect(browser));
  rawFiles.push(...await captureAiFallback(browser));
} finally {
  await browser.close();
}

await verifyFiles(rawFiles);
await mkdir(draftDir, { recursive: true });

// 원본(무압축) 캡처는 용량이 크므로, 실제로 문서/사이트에 쓸 최종 자산은 ffmpeg로 다시 인코딩해 압축한
// 뒤 별도 폴더(draftDir)에 남긴다 — 결과물을 "촬영본"과 "배포본" 두 단계로 분리한 것.
const selectedFiles = [
  await compressPng(rawFiles[0], "guest-entry-desktop.png"),
  await compressPng(rawFiles[1], "guest-pvp-desktop.png"),
  await compressWebm(rawFiles[2], "guest-pvp-reconnect.webm"),
  await compressPng(rawFiles[3], "guest-ai-mobile.png"),
  await compressWebm(rawFiles[4], "guest-ai-fallback-mobile.webm")
];
await verifyFiles(selectedFiles);

process.stdout.write(`${JSON.stringify({ rawDir, rawFiles, draftDir, selectedFiles }, null, 2)}\n`);

async function captureGuestEntry(browser) {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 1440, height: 900 }
  });
  try {
    const page = await context.newPage();
    await enterAsGuest(page);
    await page.getByRole("heading", { name: /다시 오신 것을 환영합니다/ }).waitFor();
    const output = path.join(rawDir, "guest-entry-desktop.png");
    // fullPage: true — 지금 보이는 화면(뷰포트)만이 아니라 스크롤해야 보이는 부분까지 포함해 페이지 전체를 찍는다.
    await page.screenshot({ path: output, fullPage: true });
    return output;
  } finally {
    await context.close();
  }
}

async function capturePvpReconnect(browser) {
  const videoDir = path.join(rawDir, "pvp-video");
  await mkdir(videoDir, { recursive: true });
  // recordVideo 옵션을 준 컨텍스트에서 연 페이지는 자동으로 화면이 .webm으로 녹화된다 — page.video()로
  // 그 녹화 핸들을 얻어뒀다가, 컨텍스트를 닫은 뒤(녹화가 마무리된 뒤) saveAs()로 최종 경로에 저장한다.
  const leftContext = await browser.newContext({
    baseURL,
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } }
  });
  const rightContext = await browser.newContext({ baseURL, viewport: { width: 1280, height: 720 } });
  const leftPage = await leftContext.newPage();
  const rightPage = await rightContext.newPage();
  const leftVideo = leftPage.video();
  assert(leftVideo, "PvP 녹화를 시작하지 못했습니다.");

  let outputVideo;
  try {
    const [leftName, rightName] = await Promise.all([
      enterAsGuest(leftPage),
      enterAsGuest(rightPage)
    ]);

    // guest-demo.spec.ts의 재연결 테스트와 같은 routeWebSocket + close(code 1012) 기법으로, 실제 대국
    // 도중 연결이 끊겼다 복구되는 장면을 그대로 재생시켜 영상으로 남긴다.
    const connections = [];
    await leftPage.routeWebSocket(/.*/, async (socket) => {
      if (connections.length > 0) await new Promise((resolve) => setTimeout(resolve, 600));
      connections.push({ page: socket, server: socket.connectToServer() });
    });
    await Promise.all([openPlayPage(leftPage), openPlayPage(rightPage)]);

    await Promise.all([
      leftPage.getByRole("button", { name: "매칭 큐 참가" }).click(),
      rightPage.getByRole("button", { name: "매칭 큐 참가" }).click()
    ]);
    await Promise.all([
      leftPage.getByText("준비 대기 중").waitFor(),
      rightPage.getByText("준비 대기 중").waitFor()
    ]);
    await Promise.all([
      leftPage.getByText(rightName, { exact: true }).waitFor(),
      rightPage.getByText(leftName, { exact: true }).waitFor()
    ]);
    await Promise.all([
      leftPage.getByRole("button", { name: "준비" }).click(),
      rightPage.getByRole("button", { name: "준비" }).click()
    ]);
    await Promise.all([
      leftPage.getByText("경기 진행 중").waitFor(),
      rightPage.getByText("경기 진행 중").waitFor()
    ]);

    const screenshot = path.join(rawDir, "guest-pvp-desktop.png");
    await leftPage.screenshot({ path: screenshot, fullPage: true });
    assert.equal(connections.length, 1, "PvP 경기 WebSocket을 하나로 특정하지 못했습니다.");
    await connections[0].page.close({ code: 1012, reason: "media reconnect" });
    await leftPage.getByText("재연결 대기 중").waitFor({ timeout: 2_000 });
    await waitFor(() => connections.length === 2, 5_000, "재연결 WebSocket이 만들어지지 않았습니다.");
    await leftPage.getByText("경기 진행 중").waitFor({ timeout: 5_000 });
    await leftPage.waitForTimeout(1_000);
    outputVideo = path.join(rawDir, "guest-pvp-reconnect.webm");
    return [screenshot, outputVideo];
  } finally {
    await Promise.all([leftContext.close(), rightContext.close()]);
    if (outputVideo) await leftVideo.saveAs(outputVideo);
  }
}

async function captureAiFallback(browser) {
  const videoDir = path.join(rawDir, "ai-video");
  await mkdir(videoDir, { recursive: true });
  // devices["Pixel 7"]: Playwright가 미리 만들어둔 실제 기기 프로필(화면 크기, 유저 에이전트, 터치 입력
  // 여부 등)을 그대로 newContext에 펼쳐 넣어, 실제 모바일 브라우저에 가깝게 흉내 낸다.
  const pixel = devices["Pixel 7"];
  const context = await browser.newContext({
    ...pixel,
    baseURL,
    recordVideo: { dir: videoDir, size: { width: 412, height: 915 } }
  });
  const page = await context.newPage();
  const video = page.video();
  assert(video, "AI fallback 녹화를 시작하지 못했습니다.");

  let outputVideo;
  try {
    await enterAsGuest(page);
    await openPlayPage(page);
    const startedAt = Date.now();
    await page.getByRole("button", { name: "매칭 큐 참가" }).click();
    await page.getByText("준비 대기 중").waitFor({ timeout: 12_000 });
    assert(Date.now() - startedAt >= 5_500, "AI fallback이 6초보다 이르게 실행됐습니다.");
    await page.getByText("연습 AI", { exact: true }).waitFor();
    await page.getByRole("button", { name: "준비" }).click();
    await page.getByText("경기 진행 중").waitFor();
    await page.waitForTimeout(1_000);

    const screenshot = path.join(rawDir, "guest-ai-mobile.png");
    await page.screenshot({ path: screenshot, fullPage: true });
    outputVideo = path.join(rawDir, "guest-ai-fallback-mobile.webm");
    return [screenshot, outputVideo];
  } finally {
    await context.close();
    if (outputVideo) await video.saveAs(outputVideo);
  }
}

async function enterAsGuest(page) {
  await page.goto("/");
  await page.getByRole("button", { name: "게스트로 시작" }).click();
  const welcome = page.getByRole("heading", { name: /다시 오신 것을 환영합니다, 게스트 [0-9]{4}/ });
  await welcome.waitFor();
  const text = await welcome.textContent();
  const displayName = text?.replace("다시 오신 것을 환영합니다, ", "").trim();
  assert.match(displayName ?? "", /^게스트 [0-9]{4}$/);
  return displayName;
}

async function openPlayPage(page) {
  await page.goto("/play");
  await page.getByRole("heading", { name: "경기장" }).waitFor();
}

async function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

// 파일이 실제로 존재하고 어느 정도 크기가 있는지(5KB 초과)를 확인한다 — 예를 들어 녹화가 실패해 텅 빈
// 영상 파일만 남는 것처럼, 자산이 "그럴듯하게 만들어졌지만 사실 비어있는" 상황을 미리 걸러낸다.
async function verifyFiles(files) {
  for (const file of files) {
    const details = await stat(file);
    assert(details.isFile(), `${file}이 파일이 아닙니다.`);
    assert(details.size > 5_000, `${file}의 크기가 너무 작습니다.`);
  }
}

async function compressPng(input, filename) {
  const output = path.join(draftDir, filename);
  // -frames:v 1: 첫 프레임(정지 이미지)만 뽑고, -compression_level 9는 PNG의 무손실 압축 강도를 최대로.
  runFfmpeg(["-y", "-i", input, "-frames:v", "1", "-compression_level", "9", output]);
  return output;
}

async function compressWebm(input, filename) {
  const output = path.join(draftDir, filename);
  // -an: 오디오 스트림 제거(어차피 브라우저 캡처엔 소리가 없다). -vf fps=24: 프레임레이트를 낮춰 용량을
  // 줄인다. -c:v libvpx-vp9: VP9 코덱으로 인코딩. -crf 38 -b:v 0: 고정 비트레이트 대신 "화질 목표치(CRF)"
  // 기준으로 인코딩해 필요한 만큼만 비트레이트를 쓰게 한다(숫자가 클수록 화질은 낮아지고 용량은 작아진다).
  // -deadline good -cpu-used 2: 인코딩 속도와 압축 효율 사이의 절충값(더 느리지만 더 잘 압축되는 쪽에 가깝게).
  runFfmpeg([
    "-y",
    "-i",
    input,
    "-an",
    "-vf",
    "fps=24",
    "-c:v",
    "libvpx-vp9",
    "-crf",
    "38",
    "-b:v",
    "0",
    "-deadline",
    "good",
    "-cpu-used",
    "2",
    output
  ]);
  return output;
}

function runFfmpeg(args) {
  const result = spawnSync("ffmpeg", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`ffmpeg 변환 실패:\n${result.stderr}`);
}

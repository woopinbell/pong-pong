import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { chromium, devices } from "@playwright/test";

const baseURL = process.env.DEMO_BASE_URL ?? "http://localhost:8080";
const rootDir = process.cwd();
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
    await page.screenshot({ path: output, fullPage: true });
    return output;
  } finally {
    await context.close();
  }
}

async function capturePvpReconnect(browser) {
  const videoDir = path.join(rawDir, "pvp-video");
  await mkdir(videoDir, { recursive: true });
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

async function verifyFiles(files) {
  for (const file of files) {
    const details = await stat(file);
    assert(details.isFile(), `${file}이 파일이 아닙니다.`);
    assert(details.size > 5_000, `${file}의 크기가 너무 작습니다.`);
  }
}

async function compressPng(input, filename) {
  const output = path.join(draftDir, filename);
  runFfmpeg(["-y", "-i", input, "-frames:v", "1", "-compression_level", "9", output]);
  return output;
}

async function compressWebm(input, filename) {
  const output = path.join(draftDir, filename);
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

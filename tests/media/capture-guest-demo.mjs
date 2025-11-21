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
} finally {
  await browser.close();
}

await verifyFiles(rawFiles);
await mkdir(draftDir, { recursive: true });

const selectedFiles = [
  await compressPng(rawFiles[0], "guest-entry-desktop.png")
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

function runFfmpeg(args) {
  const result = spawnSync("ffmpeg", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`ffmpeg 변환 실패:\n${result.stderr}`);
}

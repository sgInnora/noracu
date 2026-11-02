#!/usr/bin/env node
// demo/record-browser.mjs — 录制 browser 场景 demo GIF（Playwright 原生视频 → ffmpeg → GIF）
// 流程：navigate example.com → snapshot 元素索引 → 高亮 element_index 0 → 点击 → iana.org → 再高亮
// 用法：node demo/record-browser.mjs && open docs/demo-browser.gif

import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_GIF = join(__dirname, "..", "docs", "demo-browser.gif");
const VIDEO_DIR = join(__dirname, "..", ".demo-video");

// 页内遍历 + 高亮 + 可选点击（高亮为演示叠加，非产品功能）（evaluate 内完成——返回值是序列化数据，元素不能跨边界）
const WALK = ({ idx, mode }) => {
  const out = [];
  const walk = (el, depth) => {
    if (depth > 15 || out.length > 300) return;
    let visible = false;
    try {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      visible = r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    } catch { return; }
    if (visible && el.matches('a, button, input, select, textarea, [role="button"], [role="link"], [onclick]')) out.push(el);
    for (const c of el.children) walk(c, depth + 1);
  };
  walk(document.body, 0);
  const el = out[idx];
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const color = mode === "click2" ? "#2563eb" : "#e11d48";
  const box = document.createElement("div");
  box.style.cssText = `position:fixed;left:${r.x - 6}px;top:${r.y - 6}px;width:${r.width + 12}px;height:${r.height + 12}px;border:3px solid ${color};border-radius:6px;z-index:99999;pointer-events:none`;
  const label = document.createElement("div");
  label.textContent = `element_index ${idx}`;
  label.style.cssText = `position:fixed;left:${r.x - 6}px;top:${r.y - 34}px;background:${color};color:#fff;font:600 13px ui-monospace,monospace;padding:3px 8px;border-radius:4px;z-index:100000;pointer-events:none`;
  document.body.append(box, label);
  if (mode === "click") el.click();
  return { tag: el.tagName, text: (el.textContent || "").trim().slice(0, 30) };
};

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1000, height: 640 },
  recordVideo: { dir: VIDEO_DIR, size: { width: 1000, height: 640 } },
});
const page = await context.newPage();

// 1. navigate
await page.goto("https://example.com");
await page.waitForTimeout(800);

// 2. snapshot + 高亮 element_index 0
const snap1 = await page.evaluate(WALK, { idx: 0, mode: "highlight" });
console.log(`snapshot: element_index 0 = ${snap1?.tag} "${snap1?.text}"`);
await page.waitForTimeout(1200);

// 3. 点击 → 导航
console.log("click element_index 0 → navigating");
await page.evaluate(WALK, { idx: 0, mode: "click" });
await page.waitForLoadState("domcontentloaded");
await page.waitForTimeout(1200);

// 4. iana.org 上再高亮（蓝色，展示新页面的 snapshot）
await page.evaluate(WALK, { idx: 0, mode: "click2" });
await page.waitForTimeout(1000);

// 收尾：保存视频 → 转 GIF
const video = page.video();
await context.close();
await browser.close();
const videoFile = await video.path();
console.log("video:", videoFile);

if (existsSync(OUT_GIF)) unlinkSync(OUT_GIF);
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", videoFile,
  "-vf", "fps=12,scale=800:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse",
  OUT_GIF]);
console.log("GIF:", OUT_GIF);

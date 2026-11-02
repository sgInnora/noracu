#!/usr/bin/env node
// noracu MCP — 自研 computer-use / browser-use / device-use 统一控制层
//
// 架构（三层统一 computer-use 控制平面：Mac + Browser + iPhone）：
//   Mac 层:    cliclick（鼠标/键盘合成）+ screencapture（截图）+ JXA System Events（AX 树）
//              —— 经 osascript JXA 读取 AX 树并驱动菜单命令（稳定性优先）
//   Browser 层: Playwright 会话（browser_id/tab_id 模型，18 locator 工具核心子集）
//   iPhone 层: imctl（iPhone Mirroring 驱动：tap/swipe/ocr/open，归一化坐标）
//
// 动作词汇表（observe / act 拆分）：
//   click{target: elem|xy, button, count} / drag{from,to} / scroll{direction,pages}
//   press_key{key} / type_text{text} / paste{text} / select_text / set_value
// 观察词汇表：axState（AX 树）/ screenshot（含 crop）/ axStateAndScreenshot
//
// MCP: stdio JSON-RPC 2.0（initialize / tools/list / tools/call）

// Node 守卫：低于 20 在 import 崩溃前给出可读错误
if (+process.versions.node.split(".")[0] < 20) { process.stderr.write("[noracu] Node >= 20 required\n"); process.exit(1); }

import { spawn, execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// ── 配置（开源友好：环境变量覆盖 + 同级目录解析）──
const __dirname = fileURLToPath(new URL(".", import.meta.url));
// imctl (the iPhone Mirroring driver, Python) ships inside the package at imctl/; NORACU_IMCTL_DIR overrides it (e.g. a dev checkout)
const IMCTL_DIR = process.env.NORACU_IMCTL_DIR || join(__dirname, "..", "imctl");
const CLICLICK = process.env.NORACU_CLICLICK || "/opt/homebrew/bin/cliclick";
if (!existsSync(IMCTL_DIR)) {
  process.stderr.write(`[noracu] warning: imctl not found at ${IMCTL_DIR} — phone_* tools will fail. Set NORACU_IMCTL_DIR.\n`);
}

// ── 工具实现 ──────────────────────────────────────────────

function sh(cmd, args, timeoutMs = 15000) {
  try {
    const out = execFileSync(cmd, args, { timeout: timeoutMs, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    return { ok: true, out: out.trim() };
  } catch (e) {
    // cliclick 缺失时给出可操作的安装指引（而非裸 ENOENT）
    if (e?.code === "ENOENT" && cmd === CLICLICK) return { ok: false, out: "cliclick not found — brew install cliclick (or set NORACU_CLICLICK)" };
    return { ok: false, out: String(e.stderr || e.message).slice(0, 500) };
  }
}

// The iPhone layer runs the bundled imctl (Python) and needs an interpreter that has pyobjc (Quartz, Vision, AppKit).
// Resolution: NORACU_PYTHON if set, else the first candidate that imports Quartz. Probed once, lazily, on the first
// phone_* call, so the Mac and browser layers pay nothing. Apple's /usr/bin/python3 usually lacks pyobjc; Homebrew's
// python3 plus the three pyobjc-framework-* packages is the common working setup.
const PYTHON_CANDIDATES = ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "python3", "/usr/bin/python3"];
const PYOBJC_INSTALL = "python3 -m pip install pyobjc-framework-Quartz pyobjc-framework-Vision pyobjc-framework-AppKit";
let pythonProbe = null; // { path, tried } once resolved; path === null when nothing qualified
function pythonArgv(path) { return path === "python3" ? ["/usr/bin/env", ["python3"]] : [path, []]; }
function resolvePython() {
  if (pythonProbe) return pythonProbe;
  const tried = [];
  for (const cand of (process.env.NORACU_PYTHON ? [process.env.NORACU_PYTHON] : PYTHON_CANDIDATES)) {
    const [cmd, pre] = pythonArgv(cand);
    try {
      execFileSync(cmd, [...pre, "-c", "import Quartz, Vision, AppKit"], { timeout: 20000, stdio: ["ignore", "ignore", "ignore"] });
      pythonProbe = { path: cand, tried };
      return pythonProbe;
    } catch { tried.push(cand); }
  }
  pythonProbe = { path: null, tried };
  return pythonProbe;
}

function imctl(...args) {
  const py = resolvePython();
  if (!py.path) {
    return { ok: false, out: `imctl unavailable: no python3 with pyobjc found (tried ${py.tried.join(", ")}) — run \`${PYOBJC_INSTALL}\` for the python3 you want, or set NORACU_PYTHON=/path/to/python3 (see README)` };
  }
  const [cmd, pre] = pythonArgv(py.path);
  try {
    const out = execFileSync(cmd, [...pre, "-m", "imctl.cli", ...args], {
      timeout: 30000, encoding: "utf8", maxBuffer: 10 * 1024 * 1024,
      cwd: IMCTL_DIR, env: { ...process.env, PYTHONPATH: join(IMCTL_DIR, "src"), PYTHONDONTWRITEBYTECODE: "1" },
    });
    return { ok: true, out: out.trim() };
  } catch (e) {
    const raw = String(e.stderr || e.stdout || e.message);
    // Collapse Python tracebacks / spawn errors into one actionable line so phone_* fail cleanly and tests can skip (graceful degradation).
    if (/No module named|ModuleNotFoundError|ImportError|Traceback \(most recent/.test(raw)) {
      const mod = (raw.match(/No module named '([^']+)'/) || [])[1];
      return { ok: false, out: `imctl unavailable: ${py.path} is missing ${mod ? `the ${mod} module` : "a module"} — run \`${PYOBJC_INSTALL}\` for that python, or set NORACU_PYTHON (see README)` };
    }
    if (/ENOENT|No such file or directory/.test(raw)) {
      return { ok: false, out: `imctl unavailable: cannot run imctl at ${IMCTL_DIR} — the bundled imctl/ directory is missing or NORACU_IMCTL_DIR points to the wrong place (see README)` };
    }
    return { ok: false, out: raw.slice(0, 500) };
  }
}

// ── Mac 层 ──

// 主屏 DPR（backingScaleFactor）读取 — 结果缓存 60s，失败返回 null（截图主路径不依赖它）
let _mainScaleCache = null; // { value, ts }
function mainScreenScale() {
  if (_mainScaleCache && Date.now() - _mainScaleCache.ts < 60000) return _mainScaleCache.value;
  const r = sh("/usr/bin/osascript", ["-l", "JavaScript", "-e", 'ObjC.import("AppKit"); $.NSScreen.mainScreen.backingScaleFactor'], 5000);
  const n = r.ok ? Number(r.out) : NaN;
  const value = Number.isFinite(n) && n > 0 ? n : null;
  _mainScaleCache = { value, ts: Date.now() };
  return value;
}

// 前台 app 名读取（焦点守卫用）— 5s 超时，失败返回 null
function frontmostApp() {
  const r = sh("/usr/bin/osascript", ["-l", "JavaScript", "-e", 'Application("System Events").applicationProcesses.whose({frontmost:true})[0].name()'], 5000);
  return r.ok && r.out ? r.out : null;
}

// 焦点守卫 — 读一次前台 app；传 app 且不匹配时返回 error（发生在合成输入之前，零副作用）。
// 无论是否传 app 都返回 fm，供成功文本标注 (frontmost: <X>)。
function focusGuard(app) {
  const fm = frontmostApp();
  if (app === undefined) return { fm };
  if (fm === null) return { error: "focus_unknown: could not read the frontmost app — no input was sent" };
  if (fm !== app) return { error: `focus_lost: expected "${app}", frontmost is "${fm}" — no input was sent` };
  return { fm };
}

function macScreenshot(args = {}) {
  const file = join(tmpdir(), `noracu-${randomUUID().slice(0, 8)}.png`);
  const cli = ["-x"];
  if (args.region) cli.push("-R", `${args.region.x},${args.region.y},${args.region.w},${args.region.h}`);
  const r = sh("/usr/sbin/screencapture", [...cli, file]);
  if (!r.ok) return { error: r.out };
  const png = readFileSync(file);
  unlinkSync(file);
  // DPR 元数据 — logical_size 单位 = 显示点（mac_click 坐标系）
  //   全屏：像素尺寸读 PNG IHDR（bytes 16-23，big-endian）÷ 主屏 scale
  //   region：-R rect 本身是点坐标 → logical_size 直接取 region 的 w,h（实测 2x 屏 100pt rect 出 200px PNG）
  const scale = mainScreenScale();
  const meta = { scale, screen: "main" };
  if (args.region && [args.region.w, args.region.h].every(Number.isFinite)) {
    meta.logical_size = [args.region.w, args.region.h];
  } else if (scale && png.length >= 24) {
    meta.logical_size = [Math.round(png.readUInt32BE(16) / scale), Math.round(png.readUInt32BE(20) / scale)];
  }
  return { image: png.toString("base64"), mime: "image/png", meta };
}

function macAxState(args = {}) {
  // JXA 读 AX 树（observe 层）：focused app → 元素遍历（role/title/value/frame）
  // 安全：静态脚本 + argv 传参（结构性消除 JXA 注入）；depth 服务端 clamp
  // 实测：depth 6 在菜单重型 app（Finder 304 节点）上需 46-69s，必超 20s 超时；默认降为 3（实测可用）
  const depth = Math.min(Math.max(Number(args.depth) || 3, 1), 10);
  const script = `
    function run(argv) {
      const se = Application("System Events");
      const appName = argv[0] || "";
      const target = appName ? se.processes.byName(appName) : se.applicationProcesses.whose({frontmost: true})[0];
      const out = [];
      const deadline = Date.now() + 8000; // 时间预算 8s（工具超时 20s 内留余量），超时返回部分结果
      function walk(el, d) {
        if (d > ${depth} || out.length > 400 || Date.now() > deadline) return;
        let props;
        try { props = el.properties(); } catch { return; }
        const role = props.role || "?";
        // 实测：菜单栏占 89% 节点/时间且无操作价值（菜单操作走 mac_menu_command）——默认剪枝，85× 提速
        if (role === "AXMenuBar" || role === "AXMenu" || role === "AXMenuItem") return;
        const row = { i: out.length, role: role, title: (props.title || props.name || "").slice(0, 60) };
        try { const v = el.value(); if (typeof v === "string") row.value = v.slice(0, 80); } catch {}
        try { const p = el.position(), s = el.size(); row.frame = [p[0], p[1], s[0], s[1]]; } catch {}
        out.push(row);
        let kids = [];
        try { kids = el.uiElements(); } catch {}
        for (const k of kids.slice(0, 25)) walk(k, d + 1);
      }
      walk(target, 0);
      return JSON.stringify({ app: target.name(), elements: out, truncated: out.length >= 400 || Date.now() > deadline });
    }`;
  // app 刚激活后 System Events 可能 1–3s 看不到窗口（windows()=0 / 窗口暂时掉出 AX 树）——空树时等 350ms 重试一次
  let r;
  for (let attempt = 0; attempt < 2; attempt++) {
    r = sh("/usr/bin/osascript", ["-l", "JavaScript", "-e", script, "--", String(args.app || "")], 20000);
    if (!r.ok) break;
    let n = 2; try { n = (JSON.parse(r.out).elements || []).length; } catch {}
    if (n > 1 || attempt === 1) break;
    sh("/bin/sleep", ["0.35"]); // 阻塞等窗口挂上，仅空树路径付出一次
  }
  if (!r.ok) {
    // 错误分类（原实现把超时/进程不存在都误报为权限问题）
    if (/ETIMEDOUT/i.test(r.out)) return { error: "AX read timed out (tree too large — try lower depth): " + r.out.slice(0, 150) };
    if (/-1728/.test(r.out)) return { error: `AX process not found: ${args.app} (is it running?)` };
    // -1719 = AppleScript privilege violation → Accessibility 权限缺失的可操作指引
    if (/-1719/.test(r.out)) return { error: "Accessibility permission missing for the MCP host app — System Settings → Privacy & Security → Accessibility" };
    return { error: "AX read failed (need Accessibility permission?): " + r.out.slice(0, 200) };
  }
  // 解析结果：空树（仅根）报 ax_empty；仅非空快照填充 element_index 缓存（TTL 30s，click/drag 反查）
  try {
    const parsed = JSON.parse(r.out);
    if (!Array.isArray(parsed.elements) || parsed.elements.length <= 1) {
      return { error: `ax_empty: "${parsed.app}" exposes no windows to Accessibility (not frontmost, minimized, or on another Space) — bring it to the front first` };
    }
    const elements = new Map();
    for (const e of parsed.elements) {
      if (Array.isArray(e.frame) && e.frame.length === 4) elements.set(e.i, e.frame);
    }
    if (elements.size > 0) axCache.set(parsed.app, { snapshot_id: ++snapshotCounter, elements, ts: Date.now() });
  } catch { /* 解析失败不影响返回 */ }
  return { text: r.out };
}

// ── element_index 缓存（TTL 内有效，过期重取；可刷新语义）──
// 设计：观察树先序编号 + 跨快照单调复用（diffing 的前提，暂未实现）。
// noracu 简化：每次 mac_ax_state 全量重建索引（无 diffing），TTL 30s，过期报 element_no_longer_valid。
const axCache = new Map(); // app -> { snapshot_id, elements: Map<i, frame[x,y,w,h]>, ts }
let snapshotCounter = 0;

function resolveElementIndex(idx) {
  const now = Date.now();
  for (const [app, c] of axCache) {
    if (now - c.ts > 30000) { axCache.delete(app); continue; }
    const frame = c.elements.get(idx);
    if (Array.isArray(frame) && frame.length === 4) {
      return { app, snapshot_id: c.snapshot_id, x: Math.round(frame[0] + frame[2] / 2), y: Math.round(frame[1] + frame[3] / 2) };
    }
  }
  return null;
}

// element_no_longer_valid 诊断尾巴 — 缓存里还有哪些 app 的快照（过期条目已被 resolveElementIndex 清理）
function cacheDiag() {
  const apps = [...axCache.keys()];
  return ` (cached apps: ${apps.length ? apps.join(", ") : "none"})`;
}

// element_index 属于某 app 的快照；ax_empty 不覆盖缓存，30s TTL 内若前台已换成别的 app，
// 按旧坐标点击会打错窗口（browser_click 有 TOCTOU，mac 侧原先没有）。点击/拖拽前校验前台 app == 快照 app。
function staleByFrontmost(snapApp) {
  const fm = frontmostApp();
  if (!fm) return `element_no_longer_valid: cannot read the frontmost app to verify this element_index — re-run mac_ax_state`;
  if (snapApp && fm !== snapApp) return `element_no_longer_valid: element_index is from "${snapApp}" but "${fm}" is frontmost now — re-run mac_ax_state`;
  return null;
}

function macClick(args) {
  const { button = "left", count = 1 } = args;
  let { x, y } = args;
  let via = "xy";
  if (args.element_index !== undefined) {
    const r = resolveElementIndex(args.element_index);
    if (!r) return { error: `element_no_longer_valid: element_index ${args.element_index} not in cache (TTL 30s) — re-run mac_ax_state${cacheDiag()}` };
    const stale = staleByFrontmost(r.app);
    if (stale) return { error: stale };
    ({ x, y } = r); via = `element_index@${r.app}#snap${r.snapshot_id}`;
  }
  if (typeof x !== "number" || typeof y !== "number") return { error: "x,y numbers or element_index required" };
  const m = button === "right" ? "rc:" : button === "middle" ? "mc:" : "c:";
  const seq = Array(count).fill(`${m}${x},${y}`).join(" ");
  const r = sh(CLICLICK, seq.split(" "));
  if (!r.ok) return { error: r.out };
  // 点击后报告前台 app —— 点击与键入之间焦点被切走时可直接定位
  const fm = frontmostApp();
  return { text: `clicked ${button} x${count} @ ${x},${y} (${via}) (frontmost after click: ${fm ?? "unknown"})` };
}

function resolvePoint(p) {
  // p: element_index(int) | [x,y]
  if (typeof p === "number" && Number.isInteger(p) && p >= 0) {
    const r = resolveElementIndex(p);
    return r ? [r.x, r.y] : null;
  }
  if (Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)) return p;
  return null;
}

function macDrag(args) {
  let from, to;
  if (args.from_index !== undefined || args.to_index !== undefined) {
    const f = resolveElementIndex(args.from_index);
    const t = resolveElementIndex(args.to_index);
    if (!f || !t) return { error: `element_no_longer_valid: from_index/to_index not in cache (TTL 30s) — re-run mac_ax_state${cacheDiag()}` };
    const stale = staleByFrontmost(f.app);
    if (stale) return { error: stale };
    from = [f.x, f.y]; to = [t.x, t.y];
  } else {
    from = resolvePoint(args.from);
    to = resolvePoint(args.to);
    if (!from || !to) return { error: "from/to: [x,y] or element_index required (index needs fresh mac_ax_state)" };
  }
  const r = sh(CLICLICK, [`dd:${from[0]},${from[1]}`, `dm:${to[0]},${to[1]}`, `du:${to[0]},${to[1]}`]);
  return r.ok ? { text: `dragged ${from} → ${to}` } : { error: r.out };
}

function macScroll(args) {
  const { direction = "down", pages = 1 } = args;
  const lines = Math.min(Math.max(Math.round((Number(pages) || 1) * 10), 1), 500);
  // CGEvent 滚轮（cliclick 无 scroll verb）：Axis1 +上/-下，Axis2 +左/-右。静态脚本 + argv（dy/dx 为服务端 clamp 整数）。
  const dy = direction === "up" ? lines : direction === "down" ? -lines : 0;
  const dx = direction === "left" ? lines : direction === "right" ? -lines : 0;
  // 滚轮事件投递到光标下的窗口，故先把光标 warp 到前台窗口中心，再滚——否则会滚到光标恰好所在的别的窗口。
  const script = `
    ObjC.import('CoreGraphics');
    function run(argv) {
      const dy = parseInt(argv[0], 10) || 0;
      const dx = parseInt(argv[1], 10) || 0;
      try {
        const proc = Application('System Events').applicationProcesses.whose({frontmost: true})[0];
        const win = proc.windows[0];
        const p = win.position(), s = win.size();
        $.CGWarpMouseCursorPosition($.CGPointMake(p[0] + s[0] / 2, p[1] + s[1] / 2));
      } catch (e) {}
      const src = $.CGEventSourceCreate($.kCGEventSourceStateHIDSystemState);
      const ev = $.CGEventCreateScrollWheelEvent(src, $.kCGScrollEventUnitLine, 1, 0);
      $.CGEventSetIntegerValueField(ev, $.kCGScrollWheelEventDeltaAxis1, dy);
      $.CGEventSetIntegerValueField(ev, $.kCGScrollWheelEventDeltaAxis2, dx);
      $.CGEventPost($.kCGHIDEventTap, ev);
      return 'ok';
    }`;
  const r = sh("/usr/bin/osascript", ["-l", "JavaScript", "-e", script, "--", String(dy), String(dx)], 8000);
  return r.ok ? { text: `scrolled ${direction} ${pages} page(s)` } : { error: "scroll failed: " + r.out.slice(0, 200) };
}

// cliclick kp: 只接受特殊键名，修饰键组合必须 kd:<mods> … ku:<mods>（实测修饰键直接拼进 kp: 会报 Invalid key）。
// 把人类键名解析成 cliclick 参数序列："cmd-shift-v" → ["kd:cmd,shift","t:v","ku:cmd,shift"]；"return" → ["kp:return"]；无法识别 → null
// 注：page-up/fwd-delete/arrow-* 等特殊键自身含连字符，故从末尾尝试最长主键匹配，前缀全部必须是修饰键
function cliclickKeyArgs(chord) {
  if (typeof chord !== "string" || !chord) return null;
  const MOD = { cmd: "cmd", command: "cmd", meta: "cmd", opt: "alt", option: "alt", alt: "alt", ctrl: "ctrl", control: "ctrl", shift: "shift", fn: "fn" };
  const KEY = {
    escape: "esc", esc: "esc", return: "return", enter: "return",
    backspace: "delete", delete: "delete", del: "fwd-delete", "fwd-delete": "fwd-delete",
    space: "space", tab: "tab",
    up: "arrow-up", "arrow-up": "arrow-up", down: "arrow-down", "arrow-down": "arrow-down",
    left: "arrow-left", "arrow-left": "arrow-left", right: "arrow-right", "arrow-right": "arrow-right",
    home: "home", end: "end", "page-up": "page-up", "page-down": "page-down",
  };
  const parts = chord.split("-");
  for (let i = 0; i < parts.length; i++) {
    const main = parts.slice(i).join("-");
    const mods = [];
    let modsOk = true;
    for (const p of parts.slice(0, i)) {
      const m = MOD[p.toLowerCase()];
      if (!m) { modsOk = false; break; } // 前缀存在未识别的修饰键段
      if (!mods.includes(m)) mods.push(m);
    }
    if (!modsOk) continue;
    const mLower = main.toLowerCase();
    let kp = KEY[mLower];
    if (!kp && /^f([1-9]|1[0-6])$/.test(mLower)) kp = mLower; // f1..f16 原样
    if (kp) return mods.length ? [`kd:${mods.join(",")}`, `kp:${kp}`, `ku:${mods.join(",")}`] : [`kp:${kp}`];
    // 单个可打印字符：有修饰键 → kd/t/ku（大小写保留：cmd-V = Cmd+Shift+V）；无修饰键 → 直接键入
    if (/^[\x20-\x7e]$/.test(main)) return mods.length ? [`kd:${mods.join(",")}`, `t:${main}`, `ku:${mods.join(",")}`] : [`t:${main}`];
  }
  return null;
}

function macKey(args) {
  const { key } = args;
  if (!key) return { error: "key required (e.g. return, esc, cmd-c, cmd-shift-v, arrow-up)" };
  const g = focusGuard(args.app);
  if (g.error) return g;
  const seq = cliclickKeyArgs(key);
  if (!seq) return { error: `unknown key "${String(key).slice(0, 60)}" — use e.g. return, esc, tab, arrow-up, cmd-c, cmd-shift-v` };
  const r = sh(CLICLICK, seq);
  return r.ok ? { text: `pressed ${key} (frontmost: ${g.fm ?? "unknown"})` } : { error: r.out };
}

function macType(args) {
  const { text } = args;
  if (!text) return { error: "text required" };
  const g = focusGuard(args.app);
  if (g.error) return g;
  const r = sh(CLICLICK, [`t:${text}`]);
  return r.ok ? { text: `typed ${text.length} chars (frontmost: ${g.fm ?? "unknown"})` } : { error: r.out };
}

// pbcopy 需要 stdin，单独实现
function clipboardWrite(text) {
  const r = spawnSync("/usr/bin/pbcopy", { input: text, timeout: 5000 });
  return r.status === 0;
}
// pbpaste 读剪贴板文本；失败（非零退出/spawn 错误）返回 null（mac_paste 保存/还原用）
function clipboardRead() {
  const r = spawnSync("/usr/bin/pbpaste", { timeout: 5000 });
  return r.status === 0 ? (r.stdout ?? "").toString() : null;
}
// 粘贴后还原原剪贴板（文本）——150ms 给目标 app 读取 pasteboard 的窗口期
async function macPasteImpl(args) {
  const { text } = args;
  if (!text) return { error: "text required" };
  const g = focusGuard(args.app);
  if (g.error) return g;
  const old = clipboardRead();
  if (!clipboardWrite(text)) return { error: "pbcopy failed" };
  const r = sh(CLICLICK, ["kd:cmd", "t:v", "ku:cmd"]); // 修饰键组合不能直接拼进 kp:，改 kd/t/ku 序列
  await new Promise(res => setTimeout(res, 150));
  const restored = old !== null && clipboardWrite(old);
  if (!r.ok) return { error: r.out };
  return { text: `pasted ${text.length} chars (clipboard restored: ${restored}) (frontmost: ${g.fm ?? "unknown"})` };
}

function macMenuCommand(args) {
  // AX 菜单栏遍历找命令并 AXPress（本地化安全）
  // 安全：静态脚本 + argv 传参（结构性消除 JXA 注入）
  const { app, command } = args;
  if (!app || !command) return { error: "app + command required" };
  const script = `
    function run(argv) {
      const se = Application("System Events");
      const proc = se.processes.byName(argv[0]);
      const menuBar = proc.menuBars[0];
      const want = argv[1];
      for (const menu of menuBar.menus()) {
        for (const item of menu.menuItems()) {
          try {
            if (item.name() === want) { item.click(); return "executed:" + want; }
          } catch {}
        }
      }
      return "not-found";
    }`;
  const r = sh("/usr/bin/osascript", ["-l", "JavaScript", "-e", script, "--", String(app), String(command)], 15000);
  return { text: r.ok ? r.out : "menu command failed: " + r.out.slice(0, 150) };
}

// ── Browser 层（Playwright）──

const browsers = new Map(); // browser_id → { browser, context, pages: Map<tab_id, page> }

// ── browser element_index（DOM 遍历索引，对齐 Mac 层的缓存+失效协议）──
// aria-ref 内部引擎不可用（Unknown engine），ariaSnapshot 无索引——改用页内 DFS 遍历可交互元素。
// 索引仅对最近一次 browser_snapshot 有效（TTL 30s）；点击时重遍历 + tag/name 校验（Refetchable 语义）。
const browserElCache = new Map(); // browser_id → { elements: [{i,tag,role,name,x,y}], ts }

async function listClickable(page) {
  return page.evaluate(() => {
    const out = [];
    const walk = (el, depth) => {
      if (depth > 15 || out.length > 300) return;
      let visible = false;
      try {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        visible = r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
      } catch { return; }
      if (visible && el.matches('a, button, input, select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="radio"], [role="menuitem"], [role="option"], [role="switch"], [onclick], [tabindex]:not([tabindex="-1"])')) out.push(el);
      for (const c of el.children) walk(c, depth + 1);
    };
    walk(document.body, 0);
    return { elements: out.map((el, i) => {
      const r = el.getBoundingClientRect();
      return { i, tag: el.tagName.toLowerCase(), role: el.getAttribute("role") || "", name: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 50), href: (el.tagName === "A" ? el.getAttribute("href") || "" : "").slice(0, 200), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    }), truncated: out.length >= 300 };
  });
}

async function clickByIndex(page, idx, expect) {
  // 重遍历取元素句柄 → 多重校验（tag+name+位置容差，防同名元素误点）→ 真实点击（CDP 输入事件）+ JS 回退
  const handle = await page.evaluateHandle(({ idx }) => {
    const out = [];
    const walk = (el, depth) => {
      if (depth > 15 || out.length > 300) return;
      let visible = false;
      try {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        visible = r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
      } catch { return; }
      if (visible && el.matches('a, button, input, select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="radio"], [role="menuitem"], [role="option"], [role="switch"], [onclick], [tabindex]:not([tabindex="-1"])')) out.push(el);
      for (const c of el.children) walk(c, depth + 1);
    };
    walk(document.body, 0);
    return out[idx] || null;
  }, { idx });
  const el = handle.asElement();
  if (!el) return { stale: true, reason: "index out of range (DOM changed?)" };
  const info = await el.evaluate(e => {
    const r = e.getBoundingClientRect();
    return { tag: e.tagName.toLowerCase(), name: (e.getAttribute("aria-label") || e.textContent || "").trim().slice(0, 50), href: (e.tagName === "A" ? e.getAttribute("href") || "" : "").slice(0, 200), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });
  if (info.tag !== expect.tag || info.name !== expect.name) return { stale: true, reason: "element changed since snapshot (tag/name mismatch)" };
  if (info.href !== expect.href) return { stale: true, reason: "element href changed since snapshot (TOCTOU guard)" };
  if (Math.abs(info.x - expect.x) > 50 || Math.abs(info.y - expect.y) > 50) return { stale: true, reason: `element moved (${expect.x},${expect.y} → ${info.x},${info.y})` };
  try {
    await el.click({ timeout: 3000 }); // 真实 CDP 输入事件（isTrusted=true，含 actionability 检查）
    return { clicked: true, mode: "real" };
  } catch {
    await el.evaluate(e => e.click()); // 遮挡/超时回退：JS 点击（确定性优先）
    return { clicked: true, mode: "js-fallback" };
  }
}

async function pw() {
  const { chromium } = await import("playwright");
  return chromium;
}

async function browserLaunch(args = {}) {
  // 幂等启动：已有实例则复用（修复 profile 锁冲突——launchPersistentContext 同一 profile 二次启动会撞 Chromium 锁）
  // v2 将改为单 chromium.launch + 每会话独立 context（见 roadmap）
  if (browsers.size > 0) {
    const [existingId, b] = [...browsers.entries()][0];
    return { text: JSON.stringify({ browser_id: existingId, tabs: b.browser.pages().length, headless: b.headless, reused: true }) };
  }
  const chromium = await pw();
  const profileDir = join(homedir(), ".noracu", "browser-profile");
  const launchOpts = { headless: Boolean(args.headless), viewport: { width: 1280, height: 800 } };
  let browser;
  let installed = null;
  try {
    browser = await chromium.launchPersistentContext(profileDir, launchOpts);
  } catch (e) {
    const emsg = String(e?.message || e);
    // 另一个 noracu 实例（Claude Desktop 可能每个 surface 起一个）已占用持久 profile —— 干净报错而非崩溃
    if (/SingletonLock|ProcessSingleton|ProfileInUse|already in use|being used by another|cannot create a temporary|lock(?:file)? held/i.test(emsg)) {
      return { error: "browser profile in use by another noracu instance (Claude Desktop may run one per surface) — close the other browser (browser_close) or launch from only one at a time" };
    }
    // 干净机首次运行：playwright 安装期不下载浏览器二进制——自动安装后重试
    if (!/Executable doesn't exist/i.test(emsg)) throw e;
    if (process.env.NORACU_DISABLE_AUTO_INSTALL === "1") {
      return { error: "Playwright chromium missing and auto-install disabled (NORACU_DISABLE_AUTO_INSTALL=1). Run manually: npx playwright install chromium" };
    }
    const req = createRequire(import.meta.url);
    const cliJs = join(dirname(req.resolve("playwright/package.json")), "cli.js");
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [cliJs, "install", "chromium"], { timeout: 600000, encoding: "utf8" });
    if (r.status !== 0) {
      return { error: "Playwright chromium missing and auto-install failed. Run manually: npx playwright install chromium. Detail: " + String(r.stderr || r.stdout || "").slice(0, 200) };
    }
    installed = ((Date.now() - t0) / 1000).toFixed(0);
    browser = await chromium.launchPersistentContext(profileDir, launchOpts);
  }
  const browserId = `b-${randomUUID().slice(0, 8)}`;
  const page = browser.pages()[0] || await browser.newPage();
  browsers.set(browserId, { browser, headless: Boolean(args.headless), pages: new Map([[page.url(), page]]) });
  return { text: JSON.stringify({ browser_id: browserId, tabs: 1, headless: Boolean(args.headless), ...(installed ? { chromium_installed_sec: installed } : {}) }) };
}

async function getActivePage(browserId) {
  const b = browsers.get(browserId || [...browsers.keys()][0]);
  if (!b) return null;
  const pages = b.browser.pages();
  return pages[pages.length - 1] || null;
}

async function browserNavigate(args) {
  if (!args.url) return { error: "url required" };
  const page = await getActivePage(args.browser_id);
  if (!page) return { error: "no browser — call browser_launch first" };
  await page.goto(args.url, { timeout: 30000, waitUntil: "domcontentloaded" });
  return { text: `navigated: ${page.url()} (title: ${await page.title()})` };
}

async function browserSnapshot(args) {
  // observe 层：ARIA 快照（Playwright 1.58+ —— page.accessibility 已移除）
  // + 可交互元素索引列表（element_index 双模式，对齐 Mac 层）
  const page = await getActivePage(args.browser_id);
  if (!page) return { error: "no browser" };
  const snap = await page.ariaSnapshot();
  let elements = [];
  let truncated = false;
  try {
    const r = await listClickable(page);
    elements = r.elements; truncated = r.truncated;
    browserElCache.set(args.browser_id || [...browsers.keys()][0], { elements, ts: Date.now(), url: page.url() });
  } catch { /* 遍历失败不影响 ARIA 快照 */ }
  const elList = elements.slice(0, 100).map(e => `[${e.i}] ${e.role || e.tag} "${e.name}"${e.href ? ` (${e.href.slice(0, 40)})` : ""} @${e.x},${e.y}`).join("\n") + (truncated ? "\n[truncated at 300 elements — page may be stuffing the index space]" : "");
  return { text: `URL: ${page.url()}\n${snap.slice(0, 10000)}\n\n[clickable elements — browser_click accepts element_index]\n${elList}`.slice(0, 14000) };
}

async function browserScreenshot(args = {}) {
  // 截图契约：format/quality/clip + DPR 归一
  const page = await getActivePage(args.browser_id);
  if (!page) return { error: "no browser" };
  const format = args.format === "jpeg" ? "jpeg" : "png";
  const opts = { type: format, fullPage: Boolean(args.fullPage) };
  if (format === "jpeg" && Number.isFinite(args.quality)) {
    opts.quality = Math.min(Math.max(Math.round(args.quality), 1), 100);
  }
  if (args.clip && [args.clip.x, args.clip.y, args.clip.width, args.clip.height].every(Number.isFinite)) {
    opts.clip = { x: args.clip.x, y: args.clip.y, width: args.clip.width, height: args.clip.height };
    opts.fullPage = false; // clip 与 fullPage 互斥
  }
  const buf = await page.screenshot(opts);
  const dpr = await page.evaluate(() => window.devicePixelRatio).catch(() => 1);
  const vp = page.viewportSize();
  return { image: buf.toString("base64"), mime: format === "jpeg" ? "image/jpeg" : "image/png", meta: { format, dpr, viewport: vp } };
}

async function browserClick(args) {
  const page = await getActivePage(args.browser_id);
  if (!page) return { error: "no browser" };
  if (args.element_index !== undefined) {
    const key = args.browser_id || [...browsers.keys()][0];
    const c = browserElCache.get(key);
    if (!c || Date.now() - c.ts > 30000) return { error: "element_no_longer_valid: no fresh snapshot (TTL 30s) — re-run browser_snapshot" };
    if (c.url !== page.url()) return { error: "element_no_longer_valid: page navigated since snapshot — re-run browser_snapshot" }; // SPA 路由切换后同名元素会通过 tag/name 校验造成跨状态误点
    const want = c.elements[args.element_index];
    if (!want) return { error: `invalid_element_index: ${args.element_index} (snapshot has ${c.elements.length} elements)` };
    const r = await clickByIndex(page, args.element_index, want);
    if (r?.stale) return { error: `element_no_longer_valid: ${r.reason} — re-run browser_snapshot` };
    return { text: `clicked element_index ${args.element_index} (${want.tag} "${want.name}", ${r.mode})` };
  }
  if (args.selector) {
    await page.click(args.selector, { timeout: 10000, button: args.button || "left" });
    return { text: `clicked selector: ${args.selector}` };
  }
  if (Array.isArray(args.xy)) {
    await page.mouse.click(args.xy[0], args.xy[1], { button: args.button || "left" });
    return { text: `clicked @ ${args.xy}` };
  }
  return { error: "selector, xy:[x,y], or element_index required" };
}

async function browserFill(args) {
  const page = await getActivePage(args.browser_id);
  if (!page || !args.selector) return { error: "no browser or selector" };
  await page.fill(args.selector, String(args.value ?? ""), { timeout: 10000 });
  return { text: `filled ${args.selector}` };
}

async function browserPressKey(args) {
  const page = await getActivePage(args.browser_id);
  if (!page || !args.key) return { error: "no browser or key" };
  await page.keyboard.press(args.key);
  return { text: `pressed ${args.key}` };
}

async function browserType(args) {
  const page = await getActivePage(args.browser_id);
  if (!page || !args.text) return { error: "no browser or text" };
  await page.keyboard.type(args.text, { delay: 20 });
  return { text: `typed ${args.text.length} chars` };
}

async function browserScroll(args = {}) {
  const page = await getActivePage(args.browser_id);
  if (!page) return { error: "no browser" };
  const pages = Math.max(1, Number(args.pages) || 1);
  const dir = { up: -1, down: 1 }[args.direction || "down"] || 1;
  await page.mouse.wheel(0, dir * pages * 600);
  return { text: `scrolled ${args.direction || "down"} ${pages} page(s)` };
}

async function browserRead(args = {}) {
  const page = await getActivePage(args.browser_id);
  if (!page) return { error: "no browser" };
  if (args.selector) {
    const t = await page.textContent(args.selector, { timeout: 10000 });
    return { text: String(t).slice(0, 8000) };
  }
  const t = await page.evaluate(() => document.body.innerText);
  return { text: String(t).slice(0, 12000) };
}

async function browserEvaluate(args) {
  // 安全：熔断开关——NORACU_DISABLE_EVAL=1 时禁用任意 JS 执行
  if (process.env.NORACU_DISABLE_EVAL === "1") return { error: "browser_evaluate disabled by NORACU_DISABLE_EVAL=1" };
  const page = await getActivePage(args.browser_id);
  if (!page || !args.js) return { error: "no browser or js" };
  const r = await page.evaluate(args.js);
  const s = JSON.stringify(r);
  return { text: (s === undefined ? "undefined" : s).slice(0, 8000) };
}

async function browserClose(args) {
  const id = args.browser_id || [...browsers.keys()][0];
  const b = browsers.get(id);
  if (!b) return { error: "no such browser" };
  await b.browser.close();
  browsers.delete(id);
  browserElCache.delete(id); // 关闭时清元素缓存（孤儿条目卫生）
  return { text: `closed ${id}` };
}

// ── iPhone 层（imctl）──

function phoneStatus() { return imctl("status"); }
function phoneLaunch() { return imctl("launch"); }
function phoneTap(args) {
  if (typeof args.x !== "number" || typeof args.y !== "number") return { error: "x,y (0-1 normalized) required" };
  return imctl("tap", String(args.x), String(args.y));
}
function phoneLongpress(args) {
  if (typeof args.x !== "number" || typeof args.y !== "number") return { error: "x,y required" };
  return imctl("longpress", String(args.x), String(args.y), String(args.duration || 0.8));
}
function phoneSwipe(args) {
  const { from, to, ms } = args;
  if (!Array.isArray(from) || !Array.isArray(to)) return { error: "from:[x,y], to:[x,y] required" };
  const a = ["swipe", String(from[0]), String(from[1]), String(to[0]), String(to[1])];
  if (ms) a.push("--ms", String(ms));
  return imctl(...a);
}
// 镜像自带菜单 Home Screen ⌘1 / App Switcher ⌘2 可靠且不需前台（AXPress，非贴边手势）。
// 菜单优先；标签不匹配（非英文 macOS）或镜像未连接时回退 imctl 手势，行为向后兼容。
function mirrorMenu(command) {
  const m = macMenuCommand({ app: "iPhone Mirroring", command });
  return typeof m.text === "string" && m.text.startsWith("executed");
}
function phoneHome() {
  if (mirrorMenu("Home Screen")) return { ok: true, out: "home (mirror menu)" };
  return imctl("home");
}
function phoneAppSwitcher() {
  if (mirrorMenu("App Switcher")) return { ok: true, out: "app switcher (mirror menu)" };
  return imctl("app-switcher");
}
function phoneScroll(args = {}) {
  return imctl("scroll", args.direction || "down", String(args.distance || 0.5));
}
function phoneType(args) {
  if (!args.text) return { error: "text required" };
  return imctl("type", args.text);
}
function phoneKey(args) {
  if (!args.key) return { error: "key required (return/delete/up/down/left/right)" };
  return imctl("key", args.key);
}
function phoneOcr() { return imctl("ocr"); }
function phoneFind(args) {
  if (!args.text) return { error: "text required" };
  return imctl("find", args.text);
}
function phoneOpen(args) {
  if (!args.app) return { error: "app required" };
  return imctl("open", args.app);
}
function phoneScreenshot() {
  // Captured by imctl by CGWindow id, so it is the Mirroring window's own pixels even when another window covers it.
  const file = join(tmpdir(), `noracu-phone-${randomUUID().slice(0, 8)}.png`);
  const r = imctl("screenshot", file);
  if (!r.ok) return { error: r.out.slice(0, 300) };
  try {
    const data = readFileSync(file).toString("base64");
    unlinkSync(file);
    return { image: data, mime: "image/png" };
  } catch (e) {
    return { error: "screenshot file missing: " + String(e.message).slice(0, 150) };
  }
}

// ── MCP 工具注册表 ──

const JSON_SCHEMA_TYPES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);

// vLLM GLM-4.7 structural tag 对 properties 的每个值调用 .get("type")。
// 值必须是 schema 对象；"number" / "string?" 这种简写会让请求 500。
function schemaFromArg(spec) {
  if (spec && typeof spec === "object") return spec;
  const raw = String(spec || "string");
  const base = raw.endsWith("?") ? raw.slice(0, -1) : raw;
  return { type: JSON_SCHEMA_TYPES.has(base) ? base : "string" };
}

function inputSchemaFromArgs(args, required) {
  const properties = {};
  for (const [key, spec] of Object.entries(args || {})) properties[key] = schemaFromArg(spec);
  const schema = { type: "object", properties, additionalProperties: true };
  if (Array.isArray(required) && required.length > 0) schema.required = required;
  return schema;
}

const TOOLS = [
  // Mac computer-use
  { name: "mac_screenshot", desc: "Capture the Mac screen as PNG base64, optionally cropped to region {x,y,w,h}. Returns {scale, logical_size, screen:'main'} for the main display; click coordinates are in points (pixels / scale).", args: { region: "object?" }, fn: macScreenshot },
  { name: "mac_ax_state", desc: "Read the foreground app's accessibility tree (element index/role/title/value/frame; indexes feed mac_click/mac_drag for 30s); menu bar pruned by default (use mac_menu_command); optional app name and depth (default 3, clamped 1-10). Returns ax_empty if the app has no AX-visible window (not frontmost / another Space).", args: { app: "string?", depth: "number?" }, fn: macAxState },
  { name: "mac_click", desc: "Click at {x,y} or on a UI element, with optional button (left|right|middle) and count. Use element_index from the latest mac_ax_state (valid 30s); returns element_no_longer_valid when stale.", args: { x: "number?", y: "number?", element_index: "integer?", button: "string?", count: "number?" }, fn: macClick },
  { name: "mac_drag", desc: "Drag from one UI element to another (move windows, sliders, selections). Use from_index/to_index from the latest mac_ax_state (valid 30s); returns element_no_longer_valid when stale.", args: { from_index: "integer", to_index: "integer" }, required: ["from_index", "to_index"], fn: macDrag },
  { name: "mac_scroll", desc: "Scroll the frontmost window up/down/left/right by a number of pages (default 1); moves the pointer over that window first.", args: { direction: "string?", pages: "number?" }, fn: macScroll },
  { name: "mac_key", desc: "Press a key or modifier chord, e.g. 'return', 'esc', 'cmd-c', 'cmd-shift-v', 'arrow-up'. Pass app to refuse input unless that app is frontmost (focus guard).", args: { key: "string", app: "string?" }, fn: macKey },
  { name: "mac_type", desc: "Type text at the current focus without modifier keys. Pass app to refuse input unless that app is frontmost (focus guard). Not IME-safe: with a CJK input method active, keystrokes may be re-segmented — use mac_paste for reliable text entry.", args: { text: "string", app: "string?" }, fn: macType },
  { name: "mac_paste", desc: "Write text to the clipboard and paste it with Cmd+V. Pass app to refuse input unless that app is frontmost (focus guard).", args: { text: "string", app: "string?" }, fn: macPasteImpl },
  { name: "mac_menu_command", desc: "Run an app's menu bar command via accessibility traversal (locale-safe).", args: { app: "string", command: "string" }, fn: macMenuCommand },
  // Browser-use（Playwright）
  { name: "browser_launch", desc: "Launch the browser with a persistent profile (headed by default; pass headless:true for headless).", args: { headless: "boolean?" }, fn: browserLaunch },
  { name: "browser_navigate", desc: "Navigate the current tab to an http(s) URL. file:// is disabled unless NORACU_ALLOW_FILE_URL=1.", args: { url: "string" }, fn: browserNavigate },
  { name: "browser_snapshot", desc: "Return the page's ARIA accessibility snapshot plus a clickable element index list (indexes feed browser_click).", args: { browser_id: "string?" }, fn: browserSnapshot },
  { name: "browser_screenshot", desc: "Screenshot the page with optional fullPage, format png|jpeg, quality (1-100, jpeg) and clip {x,y,width,height}; returns the image plus DPR/viewport metadata.", args: { fullPage: "boolean?", format: "string?", quality: "number?", clip: "object?" }, fn: browserScreenshot },
  { name: "browser_click", desc: "Click a page element, preferring element_index; selector is a fallback, xy pixel coordinates not recommended. Use element_index from the latest browser_snapshot (valid 30s); returns element_no_longer_valid when stale.", args: { element_index: "integer?", selector: "string?", xy: "array?", button: "string?" }, fn: browserClick },
  { name: "browser_fill", desc: "Fill an input field matched by selector; fill replaces the whole value (browser_type appends keystrokes).", args: { selector: "string", value: "string?" }, fn: browserFill },
  { name: "browser_press_key", desc: "Press a key or chord, e.g. 'Enter' or 'Control+A'.", args: { key: "string" }, fn: browserPressKey },
  { name: "browser_type", desc: "Type text via the keyboard into the focused element; type appends keystrokes (browser_fill replaces the whole value).", args: { text: "string" }, fn: browserType },
  { name: "browser_scroll", desc: "Scroll the page up or down by a number of pages.", args: { direction: "string?", pages: "number?" }, fn: browserScroll },
  { name: "browser_read", desc: "Read the page's visible text, optionally scoped to a selector.", args: { selector: "string?" }, fn: browserRead },
  { name: "browser_evaluate", desc: "Evaluate JavaScript in the page and return the result.", args: { js: "string" }, fn: browserEvaluate },
  { name: "browser_close", desc: "Close the browser.", args: {}, fn: browserClose },
  // iPhone device-use（imctl）
  { name: "phone_status", desc: "EXPERIMENTAL. Needs iPhone Mirroring and a python3 with pyobjc. Return the iPhone Mirroring session status as JSON (running, window, onscreen, frontmost, paused).", args: {}, fn: phoneStatus },
  { name: "phone_launch", desc: "EXPERIMENTAL. Needs iPhone Mirroring and a python3 with pyobjc. Ensure iPhone Mirroring is running, brought to the front, and resumed if the connection is paused.", args: {}, fn: phoneLaunch },
  { name: "phone_screenshot", desc: "EXPERIMENTAL. Needs iPhone Mirroring and a python3 with pyobjc. Screenshot the iPhone screen (the Mirroring window, captured by window id so it works even when covered).", args: {}, fn: phoneScreenshot },
  { name: "phone_ocr", desc: "EXPERIMENTAL. Needs iPhone Mirroring and a python3 with pyobjc. OCR the iPhone screen into text with coordinates.", args: {}, fn: phoneOcr },
  { name: "phone_find", desc: "EXPERIMENTAL. Needs iPhone Mirroring and a python3 with pyobjc. Locate text on the iPhone screen.", args: { text: "string" }, fn: phoneFind },
  { name: "phone_tap", desc: "EXPERIMENTAL. Needs iPhone Mirroring and a python3 with pyobjc. Tap at {x, y} in normalized 0-1 coordinates.", args: { x: "number", y: "number" }, fn: phoneTap },
  { name: "phone_longpress", desc: "EXPERIMENTAL. Needs iPhone Mirroring and a python3 with pyobjc. Long-press at {x, y} for an optional duration in seconds.", args: { x: "number", y: "number", duration: "number?" }, fn: phoneLongpress },
  { name: "phone_swipe", desc: "EXPERIMENTAL. Needs iPhone Mirroring and a python3 with pyobjc. Swipe from [x,y] to [x,y] over an optional duration in ms.", args: { from: "array", to: "array", ms: "number?" }, fn: phoneSwipe },
  { name: "phone_home", desc: "EXPERIMENTAL. Go to the iPhone Home Screen via the iPhone Mirroring menu (works without python/pyobjc when the mirror is connected); falls back to an imctl swipe.", args: {}, fn: phoneHome },
  { name: "phone_app_switcher", desc: "EXPERIMENTAL. Open the iPhone App Switcher via the iPhone Mirroring menu (works without python/pyobjc when the mirror is connected); falls back to an imctl gesture.", args: {}, fn: phoneAppSwitcher },
  { name: "phone_scroll", desc: "EXPERIMENTAL. Needs iPhone Mirroring and a python3 with pyobjc. Scroll up or down by a distance.", args: { direction: "string?", distance: "number?" }, fn: phoneScroll },
  { name: "phone_type", desc: "EXPERIMENTAL. Needs iPhone Mirroring and a python3 with pyobjc. Type text via the clipboard (IME-safe).", args: { text: "string" }, fn: phoneType },
  { name: "phone_key", desc: "EXPERIMENTAL. Needs iPhone Mirroring and a python3 with pyobjc. Press a key: return, delete, up, down, left, or right.", args: { key: "string" }, fn: phoneKey },
  { name: "phone_open", desc: "EXPERIMENTAL. Needs iPhone Mirroring and a python3 with pyobjc. Open an app via Spotlight search plus OCR-guided tap.", args: { app: "string" }, fn: phoneOpen },
];

// ── 统一参数校验（全工具入口门禁，返回 null=通过 / string=错误）──
function validateArgs(name, a) {
  const S = (v, max) => typeof v === "string" && v.length > 0 && v.length <= max;
  const N = (v) => typeof v === "number" && Number.isFinite(v);
  const XY = (v) => Array.isArray(v) && v.length === 2 && N(v[0]) && N(v[1]);
  switch (name) {
    case "mac_click":
      if (a.button && !["left", "right", "middle"].includes(a.button)) return "mac_click: button must be left|right|middle";
      if (a.count !== undefined && (!Number.isInteger(a.count) || a.count < 1 || a.count > 5)) return "mac_click: count must be an integer 1-5";
      if (a.element_index !== undefined) {
        if (!Number.isInteger(a.element_index) || a.element_index < 0) return "mac_click: element_index must be non-negative int";
        return null;
      }
      if (!N(a.x) || !N(a.y)) return "mac_click: x,y finite numbers or element_index required";
      return null;
    case "mac_drag": {
      const byIndex = Number.isInteger(a.from_index) && a.from_index >= 0 && Number.isInteger(a.to_index) && a.to_index >= 0;
      const byArray = XY(a.from) && XY(a.to);
      if (!byIndex && !byArray) return "mac_drag: from_index/to_index (non-negative ints) or from/to ([x,y] arrays) required";
      return null;
    }
    case "mac_scroll":
      if (a.direction && !["up", "down", "left", "right"].includes(a.direction)) return "mac_scroll: direction up|down|left|right";
      if (a.pages && (a.pages < 0.1 || a.pages > 10)) return "mac_scroll: pages 0.1-10";
      return null;
    case "mac_key":
      if (a.app !== undefined && !S(a.app, 200)) return "mac_key: app string (max 200) required";
      // 键名校验前置到校验层（CI 可测、无副作用）——非法 chord 在合成输入之前拒绝
      if (a.key !== undefined && !cliclickKeyArgs(a.key)) return `mac_key: unknown key "${String(a.key).slice(0, 60)}" — use e.g. return, esc, tab, arrow-up, cmd-c, cmd-shift-v`;
      return null;
    case "mac_type": case "mac_paste":
      if (!S(a.text, 10000)) return `${name}: text string (1-10000 chars) required`;
      if (a.app !== undefined && !S(a.app, 200)) return `${name}: app string (max 200) required`;
      return null;
    case "mac_ax_state":
      if (a.app && !S(a.app, 200)) return "mac_ax_state: app string too long (max 200)";
      return null;
    case "mac_menu_command":
      if (!S(a.app, 200) || !S(a.command, 200)) return "mac_menu_command: app/command strings (max 200) required";
      return null;
    case "browser_navigate": {
      // file:// 默认拒；NORACU_ALLOW_FILE_URL=1 显式放行
      const schemeOk = process.env.NORACU_ALLOW_FILE_URL === "1" ? /^(https?|file):\/\//.test(a.url) : /^https?:\/\//.test(a.url);
      if (!S(a.url, 20000) || !schemeOk) return "browser_navigate: url must start with http(s):// (file:// requires NORACU_ALLOW_FILE_URL=1)";
      return null;
    }
    case "browser_evaluate":
      if (!S(a.js, 100000)) return "browser_evaluate: js string (max 100000) required";
      return null;
    case "browser_click":
      if (a.element_index !== undefined) {
        if (!Number.isInteger(a.element_index) || a.element_index < 0) return "browser_click: element_index must be non-negative int";
        return null;
      }
      if (a.selector !== undefined && !S(a.selector, 2000)) return "browser_click: selector string (max 2000) required";
      return null;
    case "browser_fill":
      if (!S(a.selector, 2000)) return "browser_fill: selector string (max 2000) required";
      if (a.value !== undefined && !S(String(a.value), 100000)) return "browser_fill: value too long (max 100000)";
      return null;
    case "phone_tap": case "phone_longpress":
      if (!N(a.x) || !N(a.y) || a.x < 0 || a.x > 1 || a.y < 0 || a.y > 1) return `${name}: x,y normalized 0-1 required`;
      return null;
    case "phone_swipe":
      if (!XY(a.from) || !XY(a.to)) return "phone_swipe: from/to [x,y] arrays required";
      return null;
    case "phone_type": case "phone_find":
      if (!S(a.text, 5000)) return `${name}: text string (max 5000) required`;
      return null;
    case "phone_open":
      if (!S(a.app, 200)) return "phone_open: app string (max 200) required";
      return null;
    default: return null;
  }
}

// ── 只读模式（NORACU_READ_ONLY=1）：仅允许观察类工具，默认拒绝新工具（安全默认）──
const READ_ONLY_TOOLS = new Set([
  "mac_screenshot", "mac_ax_state",
  "browser_launch", "browser_navigate", "browser_snapshot", "browser_screenshot", "browser_read", "browser_close",
  "phone_status", "phone_screenshot", "phone_ocr", "phone_find",
]);

// ── MCP stdio 协议 ──

const rl = (await import("node:readline")).createInterface({ input: process.stdin });

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  try {
    if (method === "initialize") {
      send({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "noracu", version: (() => { try { return JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")).version; } catch { return "0.0.0"; } })() } } });
    } else if (method === "notifications/initialized") {
      // no response
    } else if (method === "tools/list") {
      send({ jsonrpc: "2.0", id, result: { tools: TOOLS.map(t => ({
        name: t.name, description: t.desc,
        inputSchema: inputSchemaFromArgs(t.args, t.required),
      })) } });
    } else if (method === "tools/call") {
      const name = params?.name;
      const tool = TOOLS.find(t => t.name === name);
      if (!tool) { send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true } }); return; }
      let r;
      if (process.env.NORACU_READ_ONLY === "1" && !READ_ONLY_TOOLS.has(name)) {
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `ERROR: ${name} blocked by NORACU_READ_ONLY=1 (observation-only mode)` }], isError: true } });
        return;
      }
      const verr = validateArgs(name, params?.arguments || {});
      if (verr) { send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `ERROR: ${verr}` }], isError: true } }); return; }
      try { r = await tool.fn(params?.arguments || {}); }
      catch (e) { r = { error: String(e?.message ?? e).slice(0, 400) }; }
      if (r?.error) {
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `ERROR: ${r.error}` }], isError: true } });
      } else if (r?.ok === false) {
        // imctl 子进程失败（imctl 缺失、Mirroring 窗口无法置前）返回 { ok:false, out }，
        // 此前被当作成功文本下发 —— 统一在此标记为工具错误（一处覆盖所有 phone_* 工具）
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `ERROR: ${r.out}` }], isError: true } });
      } else if (r?.image) {
        const content = [{ type: "image", data: r.image, mimeType: r.mime || "image/png" }];
        if (r.meta) content.push({ type: "text", text: JSON.stringify(r.meta) });
        send({ jsonrpc: "2.0", id, result: { content } });
      } else {
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: typeof r?.text === "string" ? r.text : (r?.out ?? JSON.stringify(r)) }] } });
      }
    } else if (method === "ping") {
      send({ jsonrpc: "2.0", id, result: {} });
    } else if (id !== undefined) {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
    }
  } catch (e) {
    if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32603, message: String(e?.message ?? e) } });
  }
});

process.stderr.write("[noracu] ready — mac/browser/phone layers\n");

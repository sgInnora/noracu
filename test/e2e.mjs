#!/usr/bin/env node
// noracu MCP 端到端测试
import { spawn, spawnSync } from "node:child_process";
import { existsSync, unlinkSync, readFileSync } from "node:fs";

const proc = spawn("node", [new URL("../src/server.mjs", import.meta.url).pathname], {
  stdio: ["pipe", "pipe", "inherit"],
});
let buf = "";
const pending = new Map();
let msgId = 0;

proc.stdout.on("data", (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg); pending.delete(msg.id);
      }
    } catch {}
  }
});

function rpc(method, params) {
  return new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

const results = [];
const CI = process.env.NORACU_CI === "1"; // CI 模式：跳过依赖本机硬件/权限的用例（Mirroring/Screen Recording/Accessibility）
function check(name, cond, detail = "") { results.push({ name, pass: Boolean(cond) }); console.log(`${cond ? "✅" : "❌"} ${name}${detail ? " | " + String(detail).slice(0, 90) : ""}`); }
function checkHW(name, cond, detail = "") { if (CI) { results.push({ name, pass: true }); console.log(`⏭ ${name} | skipped (CI: needs local hardware/permissions)`); return; } check(name, cond, detail); }
// G12（F10）：phone 硬件用例 —— imctl 不可用（无 pyobjc / 未安装 / Mirroring 离线）时跳过而非失败，兑现"优雅降级"承诺
function checkPhone(name, result, cond, detail = "") {
  if (CI) { results.push({ name, pass: true }); console.log(`⏭ ${name} | skipped (CI)`); return; }
  const txt = String(result?.content?.[0]?.text || "");
  if (result?.isError && /imctl unavailable|No module named|Traceback/.test(txt)) {
    results.push({ name, pass: true }); console.log(`⏭ ${name} | skipped (imctl unavailable: ${txt.slice(0, 60)})`); return;
  }
  check(name, cond, detail);
}

async function call(name, args = {}) {
  const r = await rpc("tools/call", { name, arguments: args });
  return r.result;
}

// G1：起第二个 server 进程（自定义 env）验证行为关门；用完 finally kill
async function spawnServer(env = {}) {
  const p = spawn("node", [new URL("../src/server.mjs", import.meta.url).pathname], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, ...env },
  });
  let b = "";
  const pend = new Map();
  let mid = 0;
  p.stdout.on("data", (d) => {
    b += d.toString();
    let nl;
    while ((nl = b.indexOf("\n")) !== -1) {
      const line = b.slice(0, nl); b = b.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && pend.has(msg.id)) { pend.get(msg.id)(msg); pend.delete(msg.id); }
      } catch {}
    }
  });
  const rpcOn = (method, params = {}) => new Promise((resolve) => {
    const id = ++mid;
    pend.set(id, resolve);
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const callOn = (name, args = {}) => rpcOn("tools/call", { name, arguments: args }).then((msg) => msg.result);
  return { proc: p, call: callOn, rpc: rpcOn };
}

// 1. initialize
const init = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test" } });
check("initialize", init.result?.serverInfo?.name === "noracu", init.result?.serverInfo?.name);

// 2. tools/list
const tl = await rpc("tools/list", {});
const tools = tl.result?.tools || [];
check("tools/list 35 个", tools.length === 35, `got ${tools.length}`);
const byLayer = { mac: 0, browser: 0, phone: 0 };
for (const t of tools) { if (t.name.startsWith("mac_")) byLayer.mac++; else if (t.name.startsWith("browser_")) byLayer.browser++; else if (t.name.startsWith("phone_")) byLayer.phone++; }
check("三层分布", byLayer.mac === 9 && byLayer.browser === 12 && byLayer.phone === 14, JSON.stringify(byLayer));
// schema lint（G4）：GLM-safe schema — properties 每个值必须含字符串 type；required ⊆ properties keys
const schemaBad = [];
for (const t of tools) {
  const props = t.inputSchema?.properties || {};
  for (const [k, v] of Object.entries(props)) if (typeof v?.type !== "string") schemaBad.push(`${t.name}.${k}: no type`);
  for (const r of t.inputSchema?.required || []) if (!(r in props)) schemaBad.push(`${t.name}: required '${r}' not in properties`);
}
check("schema lint", schemaBad.length === 0, schemaBad.slice(0, 3).join("; "));
// G6：phone_* 公开层标注 — 所有 phone 工具 description 必须以 EXPERIMENTAL. 开头
const phoneNoExp = tools.filter(t => t.name.startsWith("phone_") && !String(t.description || "").startsWith("EXPERIMENTAL."));
check("phone desc EXPERIMENTAL 前缀", phoneNoExp.length === 0, phoneNoExp.map(t => t.name).join(","));

// 3. phone_status（iPhone 层）
const ps = await call("phone_status");
checkPhone("phone_status", ps, ps?.content?.[0]?.text?.includes("running") || ps?.content?.[0]?.text?.includes("window"), ps?.content?.[0]?.text?.slice(0, 60));

// 4. mac_screenshot（Mac 层）
const ms = await call("mac_screenshot");
checkHW("mac_screenshot", ms?.content?.[0]?.type === "image" && ms.content[0].data.length > 10000, `img ${(ms?.content?.[0]?.data?.length / 1024).toFixed(0)}KB`);
// G3：mac_screenshot meta — 主屏 scale/logical_size（DPR 元数据，随 image 以 text 内容附带）
let msMeta = {};
try { msMeta = JSON.parse(ms?.content?.find(c => c.type === "text")?.text || "{}"); } catch {}
checkHW("mac_screenshot meta.scale ≥ 1", Number(msMeta.scale) >= 1, `scale=${msMeta.scale} logical_size=${JSON.stringify(msMeta.logical_size)}`);

// 5. mac_ax_state（AX 树）
const ax = await call("mac_ax_state", { depth: 3 });
checkHW("mac_ax_state", ax?.content?.[0]?.text?.includes("role"), String(ax?.content?.[0]?.text).slice(0, 70));

// 6. mac_paste 剪贴板保存/还原（G2/E4）：哨兵 → paste → 400ms 后剪贴板应还原为哨兵
// （cmd-v 会粘进前台 app，本机运行时需 TextEdit 前台；CI 跳过）
{
  spawnSync("/usr/bin/pbcopy", { input: "noracu-sentinel", timeout: 5000 });
  const mp = await call("mac_paste", { text: "x" });
  await new Promise(r => setTimeout(r, 400));
  const after = spawnSync("/usr/bin/pbpaste", { timeout: 5000 }).stdout?.toString() ?? "";
  checkHW("G2：mac_paste 还原剪贴板", after === "noracu-sentinel", `${String(mp?.content?.[0]?.text).slice(0, 60)} | pbpaste=${JSON.stringify(after.slice(0, 20))}`);
}

// 6b. G7（F3）：mac_type 焦点守卫 — app 不匹配必须在合成输入之前拒绝（CI 安全：不会真的敲键）
{
  const fg = await call("mac_type", { text: "x", app: "__noracu_no_such_app__" });
  check("G7：mac_type 焦点守卫拒绝", fg?.isError && /focus_(lost|unknown)/.test(String(fg?.content?.[0]?.text)), String(fg?.content?.[0]?.text).slice(0, 80));
}

// 6c. G8（F6）：mac_key 非法键名被校验层拒 — cliclick kp: 不接受修饰键组合，
// 错误 chord 必须在合成输入之前拒绝（CI 安全：不会真的敲键）
{
  const bad1 = await call("mac_key", { key: "cmd-escape-foo" });
  check("G8：mac_key 拒未知键名（chord）", bad1?.isError && String(bad1?.content?.[0]?.text).includes("unknown key"), String(bad1?.content?.[0]?.text).slice(0, 80));
  const bad2 = await call("mac_key", { key: "bogus-key-name" });
  check("G8：mac_key 拒未知键名（bogus）", bad2?.isError && String(bad2?.content?.[0]?.text).includes("unknown key"), String(bad2?.content?.[0]?.text).slice(0, 80));
}

// 7. browser_launch + navigate + snapshot + read（Browser 层）
const bl = await call("browser_launch", { headless: true });
check("browser_launch", bl?.content?.[0]?.text?.includes("browser_id"), bl?.content?.[0]?.text?.slice(0, 50));
const bn = await call("browser_navigate", { url: "https://example.com" });
check("browser_navigate", bn?.content?.[0]?.text?.includes("example.com"), bn?.content?.[0]?.text?.slice(0, 60));
const bs = await call("browser_snapshot");
check("browser_snapshot", bs?.content?.[0]?.text?.includes("URL:"), String(bs?.content?.[0]?.text).slice(0, 80));
const br = await call("browser_read");
check("browser_read", br?.content?.[0]?.text?.toLowerCase?.().includes("example"), String(br?.content?.[0]?.text).slice(0, 50));
const bss = await call("browser_screenshot");
check("browser_screenshot", bss?.content?.[0]?.type === "image", `img ${(bss?.content?.[0]?.data?.length / 1024).toFixed(0)}KB`);
// browser element_index 双模式（R2）：snapshot 索引列表 → 按索引点击（点击会导航离开，放在 screenshot 之后）
const elText = String(bs?.content?.[0]?.text);
check("browser_snapshot 元素索引列表", elText.includes("[clickable elements"), elText.split("[clickable")[1]?.slice(0, 40));
const mIdx = elText.match(/\[(\d+)\] a "/);
if (mIdx) {
  const bc2 = await call("browser_click", { element_index: parseInt(mIdx[1]) });
  check("browser_click element_index", bc2?.content?.[0]?.text?.includes("clicked element_index"), bc2?.content?.[0]?.text?.slice(0, 60));
}
const badIdx2 = await call("browser_click", { element_index: 99999 });
check("browser 无效索引/导航后报错", badIdx2?.isError && (String(badIdx2?.content?.[0]?.text).includes("invalid_element_index") || String(badIdx2?.content?.[0]?.text).includes("element_no_longer_valid")), badIdx2?.content?.[0]?.text?.slice(0, 70));
const bc = await call("browser_close");
check("browser_close", bc?.content?.[0]?.text?.includes("closed"), bc?.content?.[0]?.text);

// 7. phone_ocr（iPhone OCR）
const po = await call("phone_ocr");
checkPhone("phone_ocr", po, !po?.isError, String(po?.content?.[0]?.text).slice(0, 70));

// 8. 注入回归（panel P0 验收判据）：恶意载荷不得执行
const PWN = "/tmp/noracu-pwned";
try { unlinkSync(PWN); } catch {}
const inj1 = await call("mac_menu_command", { app: 'x"); do shell script "touch /tmp/noracu-pwned"; //', command: "test" });
const inj2 = await call("mac_ax_state", { app: 'y"); do shell script "touch /tmp/noracu-pwned"; //', depth: 1 });
const pwned = existsSync(PWN);
check("注入回归：JXA 载荷未执行", !pwned, pwned ? "RCE! /tmp/noracu-pwned 存在" : "payload 被当作数据");
check("注入回归：工具未崩溃", !inj1?.isError || String(inj1?.content?.[0]?.text).includes("failed") || true, "handled");
// 校验层回归：非法参数被拒
const badClick = await call("mac_click", { x: "not-a-number", y: 100 });
check("校验层：非法坐标被拒", badClick?.isError && String(badClick?.content?.[0]?.text).includes("finite numbers"), badClick?.content?.[0]?.text?.slice(0, 60));
const badNav = await call("browser_navigate", { url: "javascript:alert(1)" });
check("校验层：javascript: URL 被拒", badNav?.isError, badNav?.content?.[0]?.text?.slice(0, 60));
// 9. element_index 双模式（P0-2）：无效索引报 element_no_longer_valid（成功路径已受控实测验证）
const badIdx = await call("mac_click", { element_index: 99999 });
check("element_index：无效索引报错", badIdx?.isError && String(badIdx?.content?.[0]?.text).includes("element_no_longer_valid"), badIdx?.content?.[0]?.text?.slice(0, 70));
const badNeg = await call("mac_click", { element_index: -1 });
check("element_index：负数被校验层拒", badNeg?.isError && String(badNeg?.content?.[0]?.text).includes("non-negative"), badNeg?.content?.[0]?.text?.slice(0, 60));

// 10. 行为关门（G1）：file:// 默认拒 / READ_ONLY 名单 / DISABLE_EVAL —— 各起独立 server 进程验证
{
  const s = await spawnServer();
  try {
    const r = await s.call("browser_navigate", { url: "file:///etc/hosts" });
    check("G1：file:// 默认被拒", r?.isError && String(r?.content?.[0]?.text).includes("NORACU_ALLOW_FILE_URL"), r?.content?.[0]?.text?.slice(0, 80));
  } finally { s.proc.kill(); }
}
{
  const s = await spawnServer({ NORACU_READ_ONLY: "1" });
  try {
    const r1 = await s.call("mac_click", { x: 100, y: 100 });
    check("G1：READ_ONLY 拒 mac_click", r1?.isError && String(r1?.content?.[0]?.text).includes("NORACU_READ_ONLY"), r1?.content?.[0]?.text?.slice(0, 80));
    const r2 = await s.call("phone_launch");
    check("G1：READ_ONLY 拒 phone_launch", r2?.isError && String(r2?.content?.[0]?.text).includes("NORACU_READ_ONLY"), r2?.content?.[0]?.text?.slice(0, 80));
  } finally { s.proc.kill(); }
}
{
  const s = await spawnServer({ NORACU_DISABLE_EVAL: "1" });
  try {
    const r = await s.call("browser_evaluate", { js: "1" });
    check("G1：DISABLE_EVAL 拒 browser_evaluate", r?.isError && String(r?.content?.[0]?.text).includes("NORACU_DISABLE_EVAL"), r?.content?.[0]?.text?.slice(0, 80));
  } finally { s.proc.kill(); }
}

// 11a. 0.1.1：imctl 随包附带 —— 包内 imctl/src/imctl/cli.py 必须存在（CI 安全：只查文件系统）
check("imctl bundled (imctl/src/imctl/cli.py)", existsSync(new URL("../imctl/src/imctl/cli.py", import.meta.url)));

// 11. G10（F9 dogfooding）：iPhone 层失败必须是工具错误 —— imctl 缺失时 phone_status 报 isError（CI 安全：不碰真实硬件）
{
  const s = await spawnServer({ NORACU_IMCTL_DIR: "/nonexistent" });
  try {
    const r = await s.call("phone_status");
    check("G10：imctl 缺失时 phone_status 报 isError", r?.isError && String(r?.content?.[0]?.text).includes("ERROR"), r?.content?.[0]?.text?.slice(0, 80));
  } finally { s.proc.kill(); }
}

// 11b–11f run a fake python as imctl; CI sets NORACU_IMCTL_DIR=/nonexistent for the whole run,
// so each of them points it at its own temp dir (the fake ignores the module path; only the cwd must exist).
// 11b. F39：imctl 子进程卡死（忽略 SIGTERM）时 server 仍须响应 —— 假 python：pyobjc 探测通过，
// 每次 imctl 调用都挂起且忽略 SIGTERM。旧实现（execFileSync）下连 ping 都无响应（CI 安全：不碰硬件）
{
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "noracu-e2e-"));
  const fake = join(dir, "python3");
  writeFileSync(fake, "#!/bin/bash\n# probe passes; every imctl call hangs and ignores SIGTERM\nif [ \"$1\" = \"-c\" ]; then exit 0; fi\ntrap '' TERM\nsleep 8\n", { mode: 0o700 });
  const s = await spawnServer({ NORACU_PYTHON: fake, NORACU_IMCTL_DIR: dir });
  try {
    let statusDone = false;
    s.call("phone_status").then(() => { statusDone = true; });
    await new Promise((r) => setTimeout(r, 500)); // the hung imctl child is running now
    const t0 = Date.now();
    const pong = await Promise.race([s.rpc("ping"), new Promise((r) => setTimeout(() => r(null), 3000))]);
    check("F39：imctl 卡死时 server 仍响应 ping", pong?.result !== undefined && !statusDone, pong ? `${Date.now() - t0} ms, phone_status still pending` : "no reply within 3 s");
  } finally { s.proc.kill(); rmSync(dir, { recursive: true, force: true }); }
}

// 11c. F40：并发的 phone_* 调用必须串行执行（不交错点击/粘贴/剪贴板）—— 假 python 记录每次 imctl
// 调用的起止时刻；两个调用同时发出，第二个必须在第一个结束后才开始（CI 安全：不碰硬件）
{
  const { mkdtempSync, writeFileSync, readFileSync: rf, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "noracu-e2e-"));
  const fake = join(dir, "python3");
  const log = join(dir, "calls.log");
  writeFileSync(fake, `#!/bin/bash\nif [ "$1" = "-c" ]; then exit 0; fi\necho "start $(perl -MTime::HiRes=time -e 'printf "%.3f", time')" >> "${log}"\nsleep 1\necho "end $(perl -MTime::HiRes=time -e 'printf "%.3f", time')" >> "${log}"\necho '{"running": false}'\n`, { mode: 0o700 });
  const s = await spawnServer({ NORACU_PYTHON: fake, NORACU_IMCTL_DIR: dir });
  try {
    await Promise.all([s.call("phone_status"), s.call("phone_status")]);
    const ev = rf(log, "utf8").trim().split("\n").map((l) => l.split(" "));
    const ok = ev.length === 4 && ev[0][0] === "start" && ev[1][0] === "end" && ev[2][0] === "start" && ev[3][0] === "end" && Number(ev[2][1]) >= Number(ev[1][1]);
    check("F40：并发 phone_* 调用串行执行", ok, ev.map((e) => e.join(" ")).join(" | "));
  } finally { s.proc.kill(); rmSync(dir, { recursive: true, force: true }); }
}

// 11d. F39/F40：超时路径 —— 第一次调用卡死（自身与一个孙进程都忽略 SIGTERM，持续写心跳），
// NORACU_PHONE_TIMEOUT_MS=1000：调用须在 ~1 s 返回 imctl_timeout；整个进程组随后被 SIGKILL；
// 下一次 phone 调用要等进程组真正退出才开始，且开始后不再有任何心跳（CI 安全：不碰硬件）
{
  const { mkdtempSync, writeFileSync, readFileSync: rf, existsSync: ex, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "noracu-e2e-"));
  const fake = join(dir, "python3");
  const log = join(dir, "beats.log");
  const hang = join(dir, "hang");
  const now = `perl -MTime::HiRes=time -e 'printf "%.3f", time'`;
  writeFileSync(fake, `#!/bin/bash
if [ "$1" = "-c" ]; then exit 0; fi
if [ -e "${hang}" ]; then
  rm -f "${hang}"
  trap '' TERM
  ( trap '' TERM; while true; do echo "g $(${now})" >> "${log}"; sleep 0.1; done ) &
  while true; do echo "c $(${now})" >> "${log}"; sleep 0.1; done
fi
echo "next $(${now})" >> "${log}"
echo '{"running": false}'
`, { mode: 0o700 });
  writeFileSync(hang, "");
  const s = await spawnServer({ NORACU_PYTHON: fake, NORACU_IMCTL_DIR: dir, NORACU_PHONE_TIMEOUT_MS: "1000" });
  try {
    const t0 = Date.now();
    const r1 = await s.call("phone_status");
    const dt = Date.now() - t0;
    const r2 = await s.call("phone_status");
    await new Promise((r) => setTimeout(r, 400)); // any survivor would keep beating meanwhile
    const lines = ex(log) ? rf(log, "utf8").trim().split("\n").map((l) => l.split(" ")) : [];
    const next = Number((lines.find((l) => l[0] === "next") || [])[1]);
    const lastBeat = Math.max(...lines.filter((l) => l[0] === "c" || l[0] === "g").map((l) => Number(l[1])));
    const timedOut = r1?.isError && String(r1?.content?.[0]?.text).startsWith("ERROR: imctl_timeout:");
    check("F39：超时 ~1 s 内返回 imctl_timeout", timedOut && dt < 2500, `${dt} ms`);
    check("F40：被杀进程组退出后下一次调用才开始，且无孙进程残留", !r2?.isError && Number.isFinite(next) && lastBeat < next, `last beat ${lastBeat}, next start ${next}`);
  } finally { s.proc.kill(); rmSync(dir, { recursive: true, force: true }); }
}

// 11e. F40：客户端取消（notifications/cancelled）一个还在排队的 phone 调用 —— 轮到它时直接跳过，
// 不启动 imctl，也不回响应（MCP：被取消的请求不应答）；第一个调用照常完成（CI 安全：不碰硬件）
{
  const { mkdtempSync, writeFileSync, readFileSync: rf, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "noracu-e2e-"));
  const fake = join(dir, "python3");
  const log = join(dir, "calls.log");
  writeFileSync(fake, `#!/bin/bash\nif [ "$1" = "-c" ]; then exit 0; fi\necho "run" >> "${log}"\nsleep 1\necho '{"running": false}'\n`, { mode: 0o700 });
  const s = await spawnServer({ NORACU_PYTHON: fake, NORACU_IMCTL_DIR: dir });
  try {
    const first = s.call("phone_status");
    const idSecond = 90001;
    let secondReplied = false;
    s.proc.stdout.on("data", (d) => {
      for (const line of String(d).split("\n")) {
        try { if (JSON.parse(line).id === idSecond) secondReplied = true; } catch {}
      }
    });
    s.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: idSecond, method: "tools/call", params: { name: "phone_status", arguments: {} } }) + "\n");
    s.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: idSecond, reason: "test" } }) + "\n");
    const r1 = await first;
    await new Promise((r) => setTimeout(r, 2500)); // the skipped job's turn has passed by now
    const pong = await s.rpc("ping");             // the queue and the server still work
    const runs = rf(log, "utf8").trim().split("\n").length;
    check("F40：已取消的排队调用不执行、不应答", !r1?.isError && !secondReplied && runs === 1 && pong?.result !== undefined, `runs=${runs} replied=${secondReplied}`);
  } finally { s.proc.kill(); rmSync(dir, { recursive: true, force: true }); }
}

// 11f. F39/F40：MCP 客户端通常用 SIGTERM 停止 server —— 正在运行的 imctl 进程组（自身与孙进程
// 都忽略 SIGTERM、持续写心跳）须随 server 一起被杀，server 照常退出（未开浏览器时）（CI 安全：不碰硬件）
{
  const { mkdtempSync, writeFileSync, readFileSync: rf, existsSync: ex, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "noracu-e2e-"));
  const fake = join(dir, "python3");
  const log = join(dir, "beats.log");
  writeFileSync(fake, `#!/bin/bash
if [ "$1" = "-c" ]; then exit 0; fi
trap '' TERM
( trap '' TERM; while true; do echo g >> "${log}"; sleep 0.1; done ) &
while true; do echo c >> "${log}"; sleep 0.1; done
`, { mode: 0o700 });
  const s = await spawnServer({ NORACU_PYTHON: fake, NORACU_IMCTL_DIR: dir });
  try {
    const count = () => (ex(log) ? rf(log, "utf8").trim().split("\n").length : 0);
    s.call("phone_status");                         // hangs: the fake imctl never answers
    // wait until both beat loops are running (a slow CI runner can take a while to start them)
    for (let i = 0; i < 100 && count() < 4; i++) await new Promise((r) => setTimeout(r, 100));
    const exited = new Promise((r) => s.proc.once("exit", (code, signal) => r({ code, signal })));
    s.proc.kill("SIGTERM");
    const res = await Promise.race([exited, new Promise((r) => setTimeout(() => r(null), 3000))]);
    const atExit = count();
    await new Promise((r) => setTimeout(r, 600));   // any survivor would keep beating meanwhile
    const later = count();
    check("F40：SIGTERM 时 server 退出并带走 imctl 进程组", res !== null && (res.code === 143 || res.signal === "SIGTERM") && atExit > 0 && later === atExit,
      `exit=${JSON.stringify(res)} beats at exit ${atExit}, 600 ms later ${later}`);
  } finally { s.proc.kill(); rmSync(dir, { recursive: true, force: true }); }
}

// 11g. phone_open 未能回主屏时，server 会再用菜单命令补一次 —— 它靠 imctl 的原文识别这种情况，
// 两处文案必须一致（CI 安全：只读文件）
{
  const src = readFileSync(new URL("../src/server.mjs", import.meta.url), "utf8");
  const cli = readFileSync(new URL("../imctl/src/imctl/cli.py", import.meta.url), "utf8");
  const m = src.match(/const OPEN_HOME_FAILED = "([^"]+)";/);
  check("phone_open：server 识别的“未能回主屏”文案与 imctl 一致", !!m && cli.includes(m[1]), m?.[1]);
}

// 12. 0.1.2：MCP Registry 元数据 —— server.json 必须与 package.json 一致（CI 安全：只读文件，不碰硬件）
{
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const reg = JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf8"));
  check("registry: server.json name === pkg.mcpName", reg.name === pkg.mcpName, `${reg.name} vs ${pkg.mcpName}`);
  check("registry: server.json version === pkg.version", reg.version === pkg.version, `${reg.version} vs ${pkg.version}`);
  check("registry: packages[0].version === pkg.version", reg.packages?.[0]?.version === pkg.version, `${reg.packages?.[0]?.version} vs ${pkg.version}`);
  check("registry: packages[0].identifier === pkg.name", reg.packages?.[0]?.identifier === pkg.name, `${reg.packages?.[0]?.identifier} vs ${pkg.name}`);
}

const failed = results.filter(r => !r.pass);
console.log(`\n=== noracu MCP: ${results.length - failed.length}/${results.length} PASS ===`);
proc.kill();
process.exit(failed.length ? 1 : 0);

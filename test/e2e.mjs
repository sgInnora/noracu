#!/usr/bin/env node
// noracu MCP 端到端测试
import { spawn, spawnSync } from "node:child_process";
import { existsSync, unlinkSync, readFileSync } from "node:fs";
import { mkdtempSync as suiteMkdtemp, writeFileSync as suiteWrite, rmSync as suiteRm } from "node:fs";
import { tmpdir as suiteTmpdir } from "node:os";

// The fakes this suite writes are extensionless CommonJS scripts. A package.json with "type": "module" in a parent of
// the system temp directory (another tool left one in /tmp on 2026-11-14) makes Node load them as ES modules, and every
// fake fails with "require is not defined". All temp files of the suite go under a directory of its own that says
// CommonJS (the servers it starts inherit TMPDIR, so their temp files go there too).
const SUITE_TMP = suiteMkdtemp(`${suiteTmpdir()}/noracu-suite-`.replace(/\/\/+/g, "/"));
suiteWrite(`${SUITE_TMP}/package.json`, '{ "type": "commonjs" }\n');
process.env.TMPDIR = `${SUITE_TMP}/`;
process.on("exit", () => { try { suiteRm(SUITE_TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

// 0.2.7: every server of this suite runs with the person-goes-first guard off (NORACU_USER_IDLE_S=0) unless
// the developer set it: several servers act in turn here, and each would take the others' input for a
// person's. The guard has its own block below, which turns it on for one server.
if (process.env.NORACU_USER_IDLE_S === undefined) process.env.NORACU_USER_IDLE_S = "0";
// 0.3.0: a NORACU_LAYERS left in the developer's shell would narrow every server of this suite; the
// suite sets it itself where it tests it. S1 (next-steps R4): unset now means mac,browser, so every server
// here runs with all three layers unless a block says otherwise; the layers block checks the default.
process.env.NORACU_LAYERS = "mac,browser,iphone";
// S1 (next-steps R3): browser_evaluate is off unless NORACU_ENABLE_EVAL=1. The browser blocks of this suite
// set up and read their pages with it, so every server here runs with it on; one block below checks that
// it is off by default.
process.env.NORACU_ENABLE_EVAL = "1";

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

// A call that gets no answer ends the wait instead of hanging the whole run: after the limit it resolves with an
// error result, so the checks made on it fail, and it is counted — the count is checked at the end of the run.
const CALL_TIMEOUT_MS = Number(process.env.NORACU_E2E_CALL_TIMEOUT_MS) || 120000;
const unanswered = [];
let expectedUnanswered = 0;
const noAnswer = (what, ms) => ({ timedOut: true, error: { code: -32001, message: `e2e: no answer in ${ms} ms` }, result: { isError: true, content: [{ type: "text", text: `E2E_TIMEOUT: ${what} got no answer in ${ms} ms` }] } });
const named = (method, params) => (method === "tools/call" ? `tools/call ${params?.name}` : method);

function rpc(method, params) {
  return new Promise((resolve) => {
    const id = ++msgId;
    const timer = setTimeout(() => { if (pending.delete(id)) { unanswered.push(named(method, params)); resolve(noAnswer(named(method, params), CALL_TIMEOUT_MS)); } }, CALL_TIMEOUT_MS);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

const results = [];
const CI = process.env.NORACU_CI === "1"; // CI 模式：跳过依赖本机硬件/权限的用例（Mirroring/Screen Recording/Accessibility）
function check(name, cond, detail = "") { results.push({ name, pass: Boolean(cond) }); console.log(`${cond ? "✅" : "❌"} ${name}${detail ? " | " + String(detail).slice(0, 90) : ""}`); }
function checkHW(name, cond, detail = "") { if (CI) { results.push({ name, pass: true }); console.log(`⏭ ${name} | skipped (CI: needs local hardware/permissions)`); return; } check(name, cond, detail); }
// G8-1 (0.2.0): in CI mode nothing may touch the desktop — a block that clicks, types, pastes or writes
// the clipboard runs only locally (checkHW alone only skipped the assertion, not the action)
const LOCAL = !CI;
// R31 (0.2.4): a local case this environment cannot run (e.g. a Focus mode holds banners back) is skipped
// with the reason and left out of the count — it is neither a pass nor a failure
function skipEnv(name, why) { console.log(`⏭ ${name} | not run: ${why}`); }
const focusMode = () => {
  try {
    const d = JSON.parse(readFileSync(`${process.env.HOME}/Library/DoNotDisturb/DB/Assertions.json`, "utf8"));
    const recs = d?.data?.[0]?.storeAssertionRecords || [];
    return recs.map((r) => r?.assertionDetails?.assertionDetailsModeIdentifier).find(Boolean) || null;
  } catch { return null; }
};
function skipLocal(...names) { for (const n of names) { results.push({ name: n, pass: true }); console.log(`⏭ ${n} | skipped (CI: acts on the desktop)`); } }
// G12（F10）：phone 硬件用例 —— imctl 不可用（无 pyobjc / 未安装 / Mirroring 离线）时跳过而非失败，兑现"优雅降级"承诺
function checkPhone(name, result, cond, detail = "") {
  if (CI) { results.push({ name, pass: true }); console.log(`⏭ ${name} | skipped (CI)`); return; }
  const txt = String(result?.content?.[0]?.text || "");
  if (result?.isError && /imctl unavailable|No module named/.test(txt)) {
    results.push({ name, pass: true }); console.log(`⏭ ${name} | skipped (imctl unavailable: ${txt.slice(0, 60)})`); return;
  }
  check(name, cond, detail);
}

async function call(name, args = {}) {
  const r = await rpc("tools/call", { name, arguments: args });
  return r.result;
}

// G1：起第二个 server 进程（自定义 env）验证行为关门；用完 finally kill
async function spawnServer(env = {}, serverPath = new URL("../src/server.mjs", import.meta.url).pathname, callTimeoutMs = CALL_TIMEOUT_MS) {
  const p = spawn("node", [serverPath], {
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
  // A call still open when the server goes away is answered with an error, so a test that waits for it fails
  // instead of hanging; one left open on purpose (a cancelled call) is dropped with its server and not counted.
  const open = new Map();   // id → { what, timer, resolve }
  p.on("exit", () => { for (const [id, o] of open) { clearTimeout(o.timer); pend.delete(id); o.resolve(noAnswer(`${o.what} (the server exited)`, 0)); } open.clear(); });
  const rpcOn = (method, params = {}) => new Promise((resolve) => {
    const id = ++mid, what = named(method, params);
    const timer = setTimeout(() => { if (pend.delete(id)) { open.delete(id); unanswered.push(what); resolve(noAnswer(what, callTimeoutMs)); } }, callTimeoutMs);
    open.set(id, { what, timer, resolve });
    pend.set(id, (msg) => { clearTimeout(timer); open.delete(id); resolve(msg); });
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const callOn = (name, args = {}) => rpcOn("tools/call", { name, arguments: args }).then((msg) => msg.result);
  return { proc: p, call: callOn, rpc: rpcOn };
}

// 1. initialize
const init = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test" } });
check("initialize", init.result?.serverInfo?.name === "noracu", init.result?.serverInfo?.name);
check("B4：initialize 带使用说明 instructions", typeof init.result?.instructions === "string" && init.result.instructions.includes("element_index") && init.result.instructions.includes("retry=safe"), String(init.result?.instructions).slice(0, 60));

// the handshake answers in the revision the client asked for when this server speaks it
{
  const ver = async (v) => (await rpc("initialize", { ...(v === undefined ? {} : { protocolVersion: v }), capabilities: {}, clientInfo: { name: "test" } })).result?.protocolVersion;
  const got = [];
  for (const v of ["2024-11-05", "2025-06-18", "2025-11-25", "2025-03-26", "2099-01-01", "1999-01-01", undefined, 20251125]) got.push(await ver(v));
  check("initialize: 2024-11-05, 2025-06-18 and 2025-11-25 are answered as asked; 2025-03-26 (it needs batches) gets 2024-11-05; anything else gets the latest",
    JSON.stringify(got) === JSON.stringify(["2024-11-05", "2025-06-18", "2025-11-25", "2024-11-05", "2025-11-25", "2025-11-25", "2025-11-25", "2025-11-25"]), JSON.stringify(got));
}

// 2. tools/list
const tl = await rpc("tools/list", {});
const tools = tl.result?.tools || [];
const EXPECT_TOOLS = { mac: 20, browser: 13, phone: 14 };
const EXPECT_TOTAL = EXPECT_TOOLS.mac + EXPECT_TOOLS.browser + EXPECT_TOOLS.phone;
// 0.3.0：ios_*（XCUITest backend）有 9 个，定义在同一张表里，但默认后端（mirror）不列出它们；
// NORACU_PHONE_BACKEND=xcuitest 时列出 mac 20 + browser 12 + ios 9 = 41（test/ios-e2e.mjs 覆盖）
const EXPECT_IOS_DEFINED = 9;
check(`tools/list ${EXPECT_TOTAL} 个`, tools.length === EXPECT_TOTAL, `got ${tools.length}`);
check("默认后端（mirror）不列出任何 ios_* 工具", tools.every((t) => !t.name.startsWith("ios_")));
const byLayer = { mac: 0, browser: 0, phone: 0 };
for (const t of tools) { if (t.name.startsWith("mac_")) byLayer.mac++; else if (t.name.startsWith("browser_")) byLayer.browser++; else if (t.name.startsWith("phone_")) byLayer.phone++; }
check("三层分布", byLayer.mac === EXPECT_TOOLS.mac && byLayer.browser === EXPECT_TOOLS.browser && byLayer.phone === EXPECT_TOOLS.phone, JSON.stringify(byLayer));
// 0.2.5 hints（Y5，P2-annotations.md）：47 × 4 全部锁死 —— readOnly / destructive / idempotent / openWorld，1 = true
const EXPECT_HINTS = {
  mac_status: "1010",
  mac_apps: "1010",
  mac_windows: "1011",
  mac_screenshot: "1011",
  mac_ax_state: "1011",
  mac_find: "1011",
  mac_get: "1011",
  mac_wait: "1011",
  mac_clipboard_read: "1010",
  mac_notifications: "0001",
  mac_click: "0001",
  mac_drag: "0001",
  mac_scroll: "0001",
  mac_type: "0001",
  mac_paste: "0001",
  mac_set_value: "0011",
  mac_key: "0101",
  mac_menu_command: "0101",
  mac_app: "0101",
  mac_window: "0101",
  browser_snapshot: "1011",
  browser_screenshot: "1011",
  browser_read: "1011",
  browser_launch: "0001",
  browser_navigate: "0001",
  browser_click: "0001",
  browser_press_key: "0001",
  browser_type: "0001",
  browser_scroll: "0001",
  browser_fill: "0001",
  browser_evaluate: "0101",
  browser_tabs: "0101",
  browser_close: "0010",
  phone_status: "1010",
  phone_screenshot: "1011",
  phone_ocr: "1011",
  phone_find: "1011",
  phone_launch: "0000",
  phone_tap: "0001",
  phone_longpress: "0001",
  phone_swipe: "0001",
  phone_scroll: "0001",
  phone_key: "0001",
  phone_type: "0001",
  phone_home: "0001",
  phone_app_switcher: "0001",
  phone_open: "0001",
};
const HINT_KEYS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];
const hintBad = [];
for (const t of tools) {
  const a = t.annotations || {};
  const got = HINT_KEYS.map((k) => (a[k] === true ? "1" : a[k] === false ? "0" : "?")).join("");
  const extra = Object.keys(a).filter((k) => !HINT_KEYS.includes(k));
  if (got !== EXPECT_HINTS[t.name] || extra.length) hintBad.push(`${t.name}:${got}${extra.length ? "+" + extra.join("+") : ""}`);
}
check("0.2.5 hints：47 个工具的 4 个 annotation 与规格表逐一相同", tools.length === Object.keys(EXPECT_HINTS).length && hintBad.length === 0, hintBad.join(" ") || "47 × 4 ok");
console.log(`   hints got: ${tools.map((t) => `${t.name}=${HINT_KEYS.map((k) => (t.annotations?.[k] === true ? 1 : t.annotations?.[k] === false ? 0 : "?")).join("")}`).join(" ")}`);
// R32 反例抽查：四键齐全（false 也要写出）、按行为标而不是按 READ_ONLY_TOOLS、待测项保持 false
const ann = (n) => tools.find((t) => t.name === n)?.annotations || {};
check("0.2.5 hints：反例抽查（R32）",
  HINT_KEYS.every((k) => typeof ann("mac_status")[k] === "boolean") && ann("mac_status").destructiveHint === false && ann("mac_status").openWorldHint === false
    && ann("mac_clipboard_read").readOnlyHint === true && ann("mac_click").destructiveHint === false && ann("mac_key").destructiveHint === true
    && ["browser_launch", "browser_fill", "phone_home", "phone_launch"].every((n) => ann(n).idempotentHint === false)
    && ann("phone_launch").openWorldHint === false && ann("phone_home").openWorldHint === true,
  JSON.stringify({ mac_status: ann("mac_status"), mac_key: ann("mac_key"), phone_launch: ann("phone_launch") }));
// R32：TOOL_HINTS 缺一个工具名 → server 启动即失败（源码复制到临时目录，删掉 mac_status 那一行）
{
  const { mkdtempSync, cpSync, writeFileSync: wfs } = await import("node:fs");
  const dir = mkdtempSync(`${process.env.TMPDIR || "/tmp/"}noracu-hints-`.replace(/\/\/+/g, "/"));
  cpSync(new URL("../src", import.meta.url), `${dir}/src`, { recursive: true });
  cpSync(new URL("../package.json", import.meta.url), `${dir}/package.json`);
  const f = `${dir}/src/server.mjs`;
  const src = readFileSync(f, "utf8"), cut = src.replace(/^  mac_status: \[1, 0, 1, 0\],\n/m, "");
  wfs(f, cut);
  const r = spawnSync("node", [f], { input: "", encoding: "utf8", timeout: 15000 });
  const line = String(r.stderr || "").split("\n").find((l) => l.startsWith("Error: TOOL_HINTS")) || `status ${r.status}`;
  check("0.2.5 hints：TOOL_HINTS 少一个工具名 → server 启动即失败", cut !== src && r.status !== 0 && /TOOL_HINTS out of sync with TOOLS: missing mac_status/.test(r.stderr), line.trim().slice(0, 90));
}
// 0.3.0 NORACU_LAYERS：只列点名的层；没点名的层的工具不列出、也调不到；使用说明只提列出的工具；
// 层名写错 → server 不启动（拼错不能变成三层全开）。全程只有 initialize / tools/list / 调一个没列出的工具，不碰桌面
{
  const INIT = { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "layers" } };
  const ask = async (layers, probe) => {
    const s = await spawnServer({ NORACU_LAYERS: layers });
    try {
      const ins = String((await s.rpc("initialize", INIT)).result?.instructions);
      const names = ((await s.rpc("tools/list", {})).result?.tools || []).map((t) => t.name);
      const r = await s.call(probe);
      return { ins, names, probe: r?.isError === true ? String(r?.content?.[0]?.text) : "(answered)" };
    } finally { s.proc.kill(); }
  };
  const n = (names, p) => names.filter((k) => k.startsWith(p)).length;
  const ph = await ask("iphone", "mac_status");
  check("NORACU_LAYERS=iphone：只列出 phone_*", ph.names.length === EXPECT_TOOLS.phone && n(ph.names, "phone_") === EXPECT_TOOLS.phone, `got ${ph.names.length}`);
  check("NORACU_LAYERS=iphone：没列出的 mac_status 调不到（unknown tool，并说明 mac 层没开、怎么开）", ph.probe.startsWith("unknown tool: mac_status — the mac layer is off on this server") && ph.probe.includes("NORACU_LAYERS=mac,iphone"), ph.probe.slice(0, 120));
  check("NORACU_LAYERS=iphone：使用说明只提 phone_*，不提 mac_* / browser_* / ios_*", /phone_\*/.test(ph.ins) && /phone_ocr/.test(ph.ins) && ph.ins.includes("retry=safe") && !/mac_|browser_|ios_/.test(ph.ins), ph.ins.slice(0, 80));
  const mb = await ask(" Mac , BROWSER ", "phone_status");
  check("NORACU_LAYERS=\" Mac , BROWSER \"（大小写、空格不计）：mac + browser，phone_status 调不到，说明不提 phone_* / ios_*",
    mb.names.length === EXPECT_TOOLS.mac + EXPECT_TOOLS.browser && n(mb.names, "mac_") === EXPECT_TOOLS.mac && n(mb.names, "browser_") === EXPECT_TOOLS.browser
      && mb.probe.startsWith("unknown tool: phone_status — the iphone layer is off") && /mac_ax_state/.test(mb.ins) && !/phone_|ios_/.test(mb.ins), `got ${mb.names.length} | ${mb.probe.slice(0, 40)}`);
  const br = await ask("browser", "mac_status");
  check("NORACU_LAYERS=browser：只列出 browser_*，说明不提 mac_* / phone_* / ios_*", br.names.length === EXPECT_TOOLS.browser && n(br.names, "browser_") === EXPECT_TOOLS.browser && br.probe.startsWith("unknown tool: mac_status — the mac layer is off") && /browser_snapshot/.test(br.ins) && !/mac_|phone_|ios_/.test(br.ins), `got ${br.names.length}`);
  const iosOff = await ask("  ", "ios_tap");
  check("S1：默认（镜像后端、iPhone 层关）调 ios_tap → 只说 unknown tool，不提示开 iPhone 层（那是另一个后端的工具）", iosOff.probe === "unknown tool: ios_tap", iosOff.probe.slice(0, 120));
  const blank = await ask("  ", "phone_status");
  check("S1：NORACU_LAYERS 没设 / 空白 = 默认 mac,browser —— iPhone 层不列出，调 phone_status 说明怎么打开，使用说明不提 phone_* / ios_*",
    blank.names.length === EXPECT_TOOLS.mac + EXPECT_TOOLS.browser && n(blank.names, "phone_") === 0
      && blank.probe.startsWith("unknown tool: phone_status — the iphone layer is off on this server (NORACU_LAYERS is unset: mac,browser); add iphone, e.g. NORACU_LAYERS=mac,browser,iphone")
      && blank.ins === mb.ins && !/phone_|ios_/.test(blank.ins),
    `got ${blank.names.length} | ${blank.probe.slice(0, 100)}`);
  const all3 = await ask("mac,browser,iphone", "no_such_tool");
  check("S1：NORACU_LAYERS=mac,browser,iphone 列出三层，使用说明与本套件的主 server 相同", all3.names.length === EXPECT_TOTAL && all3.ins === init.result?.instructions && all3.probe === "unknown tool: no_such_tool", `got ${all3.names.length}`);
  const server = new URL("../src/server.mjs", import.meta.url).pathname;
  const bad = ["ipone", "mac,phone", ",", "all"].map((v) => spawnSync("node", [server], { input: "", encoding: "utf8", timeout: 15000, env: { ...process.env, NORACU_LAYERS: v } }));
  check("NORACU_LAYERS 层名写错（ipone / mac,phone / , / all）→ 不启动：exit 2、stderr 说明可用的三个名字、stdout 无输出",
    bad.every((r) => r.status === 2 && /NORACU_LAYERS="[^"]*" is not valid: use a comma-separated list of mac, browser, iphone/.test(r.stderr) && /not starting/.test(r.stderr) && r.stdout === ""),
    bad.map((r) => r.status).join(","));
}
// F23（0.3.0 起看整个 src/）：进程启动后 src/ 里任何一个源文件在磁盘上变了（不只 server.mjs / mac-ax.js），
// 下一个工具结果的第一行提示重启并点名文件；内容改回原样（只有修改时间变）不算；多出一个文件也算。
// 源码复制到临时目录里跑，探针是一个不存在的工具名（unknown tool 也走统一出口），不碰桌面
{
  const { mkdtempSync, cpSync, writeFileSync: wfs, rmSync } = await import("node:fs");
  const dir = mkdtempSync(`${process.env.TMPDIR || "/tmp/"}noracu-stale-`.replace(/\/\/+/g, "/"));
  cpSync(new URL("../src", import.meta.url), `${dir}/src`, { recursive: true });
  cpSync(new URL("../package.json", import.meta.url), `${dir}/package.json`);
  // a stand-in engine (outside src/) so mac_status answers JSON without touching the desktop
  wfs(`${dir}/fake-ax-engine`, `#!/usr/bin/env node\nlet d = ""; process.stdin.on("data", (c) => (d += c)); process.stdin.on("end", () => process.stdout.write(JSON.stringify({ ok: true, accessibility: true })));\n`, { mode: 0o700 });
  const s = await spawnServer({ NORACU_LAYERS: "mac,browser", NORACU_AX_ENGINE: `${dir}/fake-ax-engine` }, `${dir}/src/server.mjs`);
  const probe = async () => String((await s.call("no_such_tool"))?.content?.[0]?.text);
  let clean, changed, back, added, jsonStale = null;
  try {
    clean = await probe();
    const f = `${dir}/src/approval.js`, was = readFileSync(f, "utf8");
    wfs(f, `${was}\n// changed on disk\n`);
    changed = await probe();
    // a result whose first text block is JSON: the note is a block of its own after it (audit S5A-s8-G-2)
    const st = (await s.call("mac_status", {}))?.content || [];
    jsonStale = { n: st.length, first: st[0]?.text, last: st[st.length - 1]?.text };
    wfs(f, was);
    back = await probe();
    wfs(`${dir}/src/extra.js`, "export {};\n");
    added = await probe();
  } finally { s.proc.kill(); rmSync(dir, { recursive: true, force: true }); }
  check("F23：刚启动、磁盘没变 → 没有提示", clean === "unknown tool: no_such_tool", String(clean).slice(0, 80));
  check("F23：src/approval.js 在磁盘上变了 → 结果第一行提示重启并点名这个文件",
    /^noracu: this server process is stale: it loaded \S+ at \S+, but the files on disk are \S+ \(changed: src\/approval\.js\)\. Restart the MCP client to load them\.\nunknown tool: no_such_tool$/.test(changed), String(changed).slice(0, 90));
  check("审计 S5A：第一个 text 块是 JSON 时，重启提示单独放在结尾一个块里，JSON 块原样可解析",
    (() => { try { JSON.parse(jsonStale.first); return jsonStale.n >= 2 && /^noracu: this server process is stale: /.test(jsonStale.last); } catch { return false; } })(),
    JSON.stringify(jsonStale).slice(0, 160));
  check("F23：内容改回原样（只有修改时间变了）→ 不再提示", back === "unknown tool: no_such_tool", String(back).slice(0, 80));
  check("F23：src/ 里多出一个文件 → 同样提示", /\(changed: src\/extra\.js\)\. Restart the MCP client/.test(added), String(added).slice(0, 90));
}
// schema lint（G4 + t10 §4）：GLM-safe schema — properties 每个值必须含字符串 type；每个非 `?` 参数都在 required 中且一致
const schemaBad = [];
const serverSrcForSchema = readFileSync(new URL("../src/server.mjs", import.meta.url), "utf8");
const expectedReqByTool = new Map();
for (const line of serverSrcForSchema.split("\n")) {
  const m = line.match(/^\s*\{\s*name:\s*"([a-z_]+)".*?\bargs:\s*\{([^}]*)\}/);
  if (!m) continue;
  const reqKeys = [];
  for (const am of m[2].matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*"([^"]*)"/g)) {
    if (!am[2].trim().endsWith("?")) reqKeys.push(am[1]);
  }
  expectedReqByTool.set(m[1], reqKeys);
}
if (expectedReqByTool.size !== EXPECT_TOTAL + EXPECT_IOS_DEFINED) schemaBad.push(`parsed ${expectedReqByTool.size}/${EXPECT_TOTAL + EXPECT_IOS_DEFINED} tool arg specs`);
for (const t of tools) {
  const props = t.inputSchema?.properties || {};
  for (const [k, v] of Object.entries(props)) if (typeof v?.type !== "string") schemaBad.push(`${t.name}.${k}: no type`);
  for (const r of t.inputSchema?.required || []) if (!(r in props)) schemaBad.push(`${t.name}: required '${r}' not in properties`);
  const wantReq = expectedReqByTool.get(t.name) || [];
  const gotReq = t.inputSchema?.required || [];
  if (JSON.stringify(gotReq) !== JSON.stringify(wantReq)) schemaBad.push(`${t.name}: required ${JSON.stringify(gotReq)} !== ${JSON.stringify(wantReq)}`);
  if (wantReq.length === 0 && "required" in (t.inputSchema || {})) schemaBad.push(`${t.name}: empty required array present`);
}
check("schema lint (types + derived required arrays)", schemaBad.length === 0, schemaBad.slice(0, 3).join("; "));
// G6：phone_* 公开层标注 — 所有 phone 工具 description 必须以 EXPERIMENTAL. 开头
const phoneNoExp = tools.filter(t => t.name.startsWith("phone_") && !String(t.description || "").startsWith("EXPERIMENTAL."));
check("phone desc EXPERIMENTAL 前缀", phoneNoExp.length === 0, phoneNoExp.map(t => t.name).join(","));

// 3. phone_status（iPhone 层）
const ps = await call("phone_status");
checkPhone("phone_status", ps, ps?.content?.[0]?.text?.includes("running") || ps?.content?.[0]?.text?.includes("window"), ps?.content?.[0]?.text?.slice(0, 60));

// Local runs act on a TextEdit document the test creates (and closes unsaved at the end), so nothing
// lands in whatever app the developer has in front. CI never touches the desktop.
const TE_DOC = "noracu-e2e";
const TE_TEXT = "noracu e2e line";
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
if (!CI) {
  spawnSync("/usr/bin/open", ["-a", "TextEdit"], { timeout: 10000 });
  await sleepMs(1500);
  // a test document left open by an earlier run that stopped early (same name) would make the window lookups
  // below ambiguous: close it, unsaved, first (P17 triage). Only documents named for this suite are touched.
  spawnSync("/usr/bin/osascript", ["-e", `tell application "TextEdit" to close (every document whose name contains "${TE_DOC}") saving no`], { timeout: 10000 });
  spawnSync("/usr/bin/osascript", ["-e", `tell application "TextEdit" to make new document with properties {name:"${TE_DOC}", text:"${TE_TEXT}"}`, "-e", 'tell application "TextEdit" to activate'], { timeout: 10000 });
  await sleepMs(1000);
}
const jsonOf = (r) => { try { return JSON.parse(r?.content?.find((c) => c.type === "text")?.text || "{}"); } catch { return {}; } };
// the test document must exist before anything acts locally; otherwise those tests fail instead of
// acting on whatever app the developer has in front
const TE_READY = () => {
  const r = spawnSync("/usr/bin/osascript", ["-e", `tell application "TextEdit" to (count of (documents whose name contains "${TE_DOC}")) > 0`], { encoding: "utf8", timeout: 10000 });
  const ok = String(r.stdout || "").trim() === "true";
  if (!ok) check("本机：测试文档已创建（否则本机动作用例不运行）", false, "TextEdit test document missing");
  return ok;
};

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
if (LOCAL && TE_READY()) {
  spawnSync("/usr/bin/osascript", ["-e", 'tell application "TextEdit" to activate'], { timeout: 10000 });
  await sleepMs(400);
  // the developer's clipboard (text) is set aside and put back after this check (E2 run 2026-11-07: it was lost)
  const devClip = spawnSync("/usr/bin/pbpaste", { timeout: 5000 }).stdout?.toString() ?? "";
  spawnSync("/usr/bin/pbcopy", { input: "noracu-sentinel", timeout: 5000 });
  const mp = await call("mac_paste", { text: "x", app: "TextEdit" });
  await new Promise(r => setTimeout(r, 400));
  const after = spawnSync("/usr/bin/pbpaste", { timeout: 5000 }).stdout?.toString() ?? "";
  spawnSync("/usr/bin/pbcopy", { input: devClip, timeout: 5000 });
  check("G2：mac_paste 还原剪贴板", after === "noracu-sentinel", `${String(mp?.content?.[0]?.text).slice(0, 60)} | pbpaste=${JSON.stringify(after.slice(0, 20))}`);
} else skipLocal("G2：mac_paste 还原剪贴板");

// 6b. G7（F3）：mac_type 焦点守卫 — app 不匹配必须在合成输入之前拒绝（CI 安全：不会真的敲键）
{
  const fg = await call("mac_type", { text: "x", app: "__noracu_no_such_app__", mechanism: "physical" });
  check("G7：mac_type 焦点守卫拒绝（物理路径）", fg?.isError && /focus_(lost|unknown)/.test(String(fg?.content?.[0]?.text)), String(fg?.content?.[0]?.text).slice(0, 80));
  const fs = await call("mac_type", { text: "x", app: "__noracu_no_such_app__" });
  check("B2：mac_type 语义路径找不到 app 时什么都不发", fs?.isError && /app_not_found/.test(String(fs?.content?.[0]?.text)) && /delivery=not_delivered/.test(String(fs?.content?.[0]?.text)), String(fs?.content?.[0]?.text).slice(0, 90));
}

// 6c. G8（F6）：mac_key 非法键名被校验层拒 — cliclick kp: 不接受修饰键组合，
// 错误 chord 必须在合成输入之前拒绝（CI 安全：不会真的敲键）
{
  const bad1 = await call("mac_key", { key: "cmd-escape-foo" });
  check("G8：mac_key 拒未知键名（chord）", bad1?.isError && String(bad1?.content?.[0]?.text).includes("unknown key"), String(bad1?.content?.[0]?.text).slice(0, 80));
  const bad2 = await call("mac_key", { key: "bogus-key-name" });
  check("G8：mac_key 拒未知键名（bogus）", bad2?.isError && String(bad2?.content?.[0]?.text).includes("unknown key"), String(bad2?.content?.[0]?.text).slice(0, 80));
}

// B1：AX 引擎（src/mac-ax.js）—— CI 安全部分：status / apps / windows 的形状与参数校验
{
  const st = jsonOf(await call("mac_status"));
  check("B1：mac_status 报告权限与显示器", "accessibility" in st && Array.isArray(st.displays), JSON.stringify(st).slice(0, 90));
  const ap = jsonOf(await call("mac_apps", {}));
  check("B1：mac_apps 列出运行中的应用", Array.isArray(ap.apps) && ap.apps.length > 0, `${ap.apps?.length} apps`);
  const wn = jsonOf(await call("mac_windows", {}));
  check("B1：mac_windows 返回 windows 与 displays", Array.isArray(wn.windows) && Array.isArray(wn.displays), `${wn.windows?.length} windows, ${wn.displays?.length} displays`);
  const bf = await call("mac_find", { app: "Finder" });
  check("B1：mac_find 无条件被校验层拒", bf?.isError && String(bf?.content?.[0]?.text).includes("at least one"), String(bf?.content?.[0]?.text).slice(0, 80));
  const bsurf = await call("mac_ax_state", { surface: "nonsense" });
  check("B1：mac_ax_state 非法 surface 被拒", bsurf?.isError && String(bsurf?.content?.[0]?.text).includes("surface must be"), String(bsurf?.content?.[0]?.text).slice(0, 80));
  const bg = await call("mac_get", { element_index: 99999 });
  check("B1：mac_get 无效索引报 element_no_longer_valid", bg?.isError && String(bg?.content?.[0]?.text).includes("element_no_longer_valid"), String(bg?.content?.[0]?.text).slice(0, 80));
}
// B1 本机：在测试自建的 TextEdit 文档上 快照 → 查找 → 读取 → 骨架下钻（CI 跳过）
if (LOCAL && TE_READY()) {
  const st = jsonOf(await call("mac_ax_state", { app: "TextEdit", window: TE_DOC, interactive: true }));
  const area = (st.elements || []).find((e) => e.role === "AXTextArea");
  checkHW("B1：mac_ax_state（AX 引擎）读到 TextEdit 正文", area && String(area.value).includes(TE_TEXT) && st.snapshot_id, `${st.elements?.length} elements, ${st.snapshot_id}`);
  const fd = jsonOf(await call("mac_find", { app: "TextEdit", window: TE_DOC, role: "textarea" }));
  const m = fd.matches?.[0];
  checkHW("B1：mac_find role=textarea 找到正文", m && Number.isInteger(m.i), JSON.stringify(m || fd).slice(0, 90));
  const gt = m ? jsonOf(await call("mac_get", { element_index: m.i })) : {};
  checkHW("B1：mac_get 现读正文值", String(gt.value).includes(TE_TEXT) && gt.settable?.selected_text === true, JSON.stringify(gt).slice(0, 90));
  const sk = jsonOf(await call("mac_ax_state", { app: "TextEdit", window: TE_DOC, skeleton: true, interactive: true, depth: 1 }));
  const cut = (sk.elements || []).find((e) => e.children_count > 0 && Number.isInteger(e.i));
  const dr = cut ? jsonOf(await call("mac_ax_state", { root: cut.i })) : {};
  checkHW("B1：骨架 + root 下钻扩展同一快照", cut && dr.snapshot_id === sk.snapshot_id && (dr.elements || []).length > 0 && dr.elements.every((e) => e.i === undefined || e.i > cut.i), `cut i=${cut?.i} children=${cut?.children_count}, drill ${dr.elements?.length} elements`);
} else skipLocal("B1：mac_ax_state（AX 引擎）读到 TextEdit 正文", "B1：mac_find role=textarea 找到正文", "B1：mac_get 现读正文值", "B1：骨架 + root 下钻扩展同一快照");

// B2：动作 —— CI 安全部分：危险组合键、参数校验（不会真的发键）
{
  for (const key of ["cmd-q", "cmd-shift-delete", "cmd-alt-esc", "ctrl-cmd-q", "alt-cmd-Q", "fn-cmd-q", "cmd-Q", "alt-cmd-q", "cmd-alt-delete"]) {
    const r = await call("mac_key", { key });
    check(`B2：mac_key 拒 ${key}（未传 force）`, r?.isError && String(r?.content?.[0]?.text).includes("policy_denied"), String(r?.content?.[0]?.text).slice(0, 80));
  }
  const mm = await call("mac_menu_command", { app: "TextEdit", command: "Select All", force: "yes" });
  check("B2：mac_menu_command 非法 force 被拒", mm?.isError && String(mm?.content?.[0]?.text).includes("force must be a boolean"), String(mm?.content?.[0]?.text).slice(0, 80));
  const dp = await call("mac_ax_state", { depth: 2.5 });
  check("mac_ax_state: a depth that is not a whole number is refused", dp?.isError && String(dp?.content?.[0]?.text).includes("depth integer 1-40"), String(dp?.content?.[0]?.text).slice(0, 80));
  const rootWith = [];
  for (const extra of [{ app: "Finder" }, { window: 0 }, { window_id: 1 }, { surface: "menubar" }]) rootWith.push(await call("mac_ax_state", { root: 3, ...extra }));
  check("mac_ax_state: root with app, window, window_id or surface is refused before anything is read (they were not looked at)",
    rootWith.every((x) => x?.isError && String(x?.content?.[0]?.text).includes("without app, window, window_id or surface")), rootWith.map((x) => String(x?.content?.[0]?.text).slice(0, 60)).join(" | "));
  const sv = await call("mac_set_value", { element_index: 0 });
  check("B2：mac_set_value 缺 value 被拒", sv?.isError && String(sv?.content?.[0]?.text).includes("value"), String(sv?.content?.[0]?.text).slice(0, 80));
  const mc = await call("mac_click", { element_index: 0, mechanism: "bogus" });
  check("B2：mac_click 非法 mechanism 被拒", mc?.isError && String(mc?.content?.[0]?.text).includes("mechanism"), String(mc?.content?.[0]?.text).slice(0, 80));
}
// B2 本机：在测试文档里 语义输入（中文，不经输入法）→ 幂等勾选 → 弹出菜单选项 → 语义点击 → 物理点击（命中检测）
if (LOCAL && TE_READY()) {
  spawnSync("/usr/bin/osascript", ["-e", 'tell application "TextEdit" to activate'], { timeout: 10000 });
  await sleepMs(500);
  const st = jsonOf(await call("mac_ax_state", { app: "TextEdit", window: TE_DOC, interactive: true }));
  const idx = (pred) => (st.elements || []).find(pred)?.i;
  const ta = idx((e) => e.role === "AXTextArea"), bold = idx((e) => e.title === "bold"), ls = idx((e) => e.title === "line spacing"), center = idx((e) => e.title === "align center");
  const say = (r) => String(r?.content?.[0]?.text);
  // every control must be found in the test document — never fall back to some other index
  check("B2：测试文档里找到正文与格式控件", [ta, bold, ls, center].every(Number.isInteger), JSON.stringify({ ta, bold, ls, center }));
  if ([ta, bold, ls, center].every(Number.isInteger)) {
  // physical first: TextEdit can raise a "duplicate this document" sheet after format changes, and a
  // sheet over the text area makes the hit test refuse the click (correctly) — so click before those
  const c2 = await call("mac_click", { element_index: ta });
  checkHW("B2：mac_click 无语义动作 → 物理点击（命中检测通过）", /via physical click/.test(say(c2)) && !c2?.isError, say(c2).slice(0, 90));
  const t1 = await call("mac_type", { element_index: ta, text: " 你好 noracu zz" });
  const v1 = jsonOf(await call("mac_get", { element_index: ta }));
  checkHW("B2：mac_type 语义输入中文（IME 无关）并验证", /delivery=delivered_verified/.test(say(t1)) && String(v1.value).includes("你好 noracu zz"), say(t1).slice(0, 90));
  const b1 = await call("mac_set_value", { element_index: bold, value: "true" });
  const b2 = await call("mac_set_value", { element_index: bold, value: "true" });
  const b3 = await call("mac_set_value", { element_index: bold, value: "false" });
  checkHW("B2：mac_set_value 勾选幂等（已是 → 不发送）", /delivered_verified/.test(say(b1)) && /not_delivered/.test(say(b2)) && /delivered_verified/.test(say(b3)), `${say(b1).slice(-40)} | ${say(b2).slice(-40)}`);
  const p1 = await call("mac_set_value", { element_index: ls, value: "1.5" });
  const p2 = await call("mac_set_value", { element_index: ls, value: "1.0" });
  checkHW("B2：mac_set_value 选弹出菜单选项", /delivered_verified/.test(say(p1)) && /delivered_verified/.test(say(p2)), say(p1).slice(0, 90));
  const c1 = await call("mac_click", { element_index: center });
  checkHW("B2：mac_click 语义 AXPress 并验证", /via semantic AXPress/.test(say(c1)) && /delivered_verified/.test(say(c1)), say(c1).slice(0, 90));
  }
} else skipLocal("B2：本机动作（物理点击 / 语义输入 / 勾选 / 弹出菜单 / 语义点击）");

// B3：等待 / 应用 / 窗口 / 剪贴板 / 通知 / CDP —— CI 安全部分（不碰桌面）
{
  const say = (r) => String(r?.content?.[0]?.text);
  const w1 = await call("mac_wait", { condition: "app_gone", app: "__noracu_no_such_app__", timeout_ms: 1000 });
  check("B3：mac_wait app_gone 立即满足", !w1?.isError && say(w1).startsWith("app_gone met"), say(w1).slice(0, 80));
  const w2 = await call("mac_wait", { condition: "bogus" });
  check("B3：mac_wait 非法 condition 被拒", w2?.isError && say(w2).includes("condition must be"), say(w2).slice(0, 80));
  const q = await call("mac_app", { action: "quit", app: "Finder" });
  check("B3：mac_app 拒绝退出 Finder（会话进程）", q?.isError && say(q).includes("policy_denied"), say(q).slice(0, 90));
  const cd = await call("mac_app", { action: "launch", app: "Google Chrome", cdp_port: 0 });
  check("B3：mac_app cdp_port 需 NORACU_ALLOW_CDP=1", cd?.isError && say(cd).includes("NORACU_ALLOW_CDP"), say(cd).slice(0, 90));
  const bc = await call("browser_launch", { cdp_port: 9222 });
  check("B3：browser_launch cdp_port 需 NORACU_ALLOW_CDP=1", bc?.isError && say(bc).includes("NORACU_ALLOW_CDP"), say(bc).slice(0, 90));
  const mw = await call("mac_window", { action: "move", x: 1, y: 1 });
  check("B3：mac_window 缺 window_id/app 被拒", mw?.isError && say(mw).includes("window_id"), say(mw).slice(0, 80));
  const nd = await call("mac_notifications", { action: "dismiss", index: 1 });
  check("B3：mac_notifications 按序号操作必须带指纹", nd?.isError && say(nd).includes("expected_app"), say(nd).slice(0, 90));
}
// B3 本机：等待、窗口、窗口截图、剪贴板、通知（CI 跳过）
if (LOCAL && TE_READY()) {
  const say = (r) => String(r?.content?.[0]?.text);
  const ww = await call("mac_wait", { condition: "window", app: "TextEdit", title: TE_DOC, timeout_ms: 5000 });
  const wt = await call("mac_wait", { condition: "text", app: "TextEdit", window: TE_DOC, text: "noracu", timeout_ms: 5000 });
  checkHW("B3：mac_wait window / text 满足", say(ww).startsWith("window met") && say(wt).startsWith("text met"), `${say(ww).slice(0, 40)} | ${say(wt).slice(0, 40)}`);
  const mv = await call("mac_window", { action: "move", app: "TextEdit", window: TE_DOC, x: 240, y: 160 });
  const rs = await call("mac_window", { action: "resize", app: "TextEdit", window: TE_DOC, width: 640, height: 480 });
  checkHW("B3：mac_window move/resize 并验证位置尺寸", /delivered_verified/.test(say(mv)) && say(mv).includes("[240,160,") && say(rs).includes(",640,480]"), `${say(mv).slice(-70)} | ${say(rs).slice(-60)}`);
  const wl = jsonOf(await call("mac_windows", { app: "TextEdit" }));
  const wid = (wl.windows || []).find((w) => w.title === TE_DOC)?.id;
  const shot = wid ? await call("mac_screenshot", { window_id: wid }) : null;
  checkHW("B3：mac_screenshot window_id 截单个窗口", shot?.content?.[0]?.type === "image" && String(shot?.content?.[1]?.text).includes(`window ${wid}`), shot ? String(shot?.content?.[1]?.text).slice(0, 80) : `no window titled ${TE_DOC}: ${JSON.stringify((wl.windows || []).map((w) => [w.id, w.title, w.bounds]))}`);
  // 0.2.5: mac_scroll without element_index — the frontmost app's front window, scrolled at its center only after
  // the top-window check (the TextEdit test document is frontmost here)
  if (LOCAL) {
    const msc = await call("mac_scroll", { direction: "down", pages: 1 });
    console.log(`   mac_scroll (no element_index): ${say(msc)}`);
    checkHW("0.2.5：mac_scroll 不带 element_index → 先查最上层窗口，再在前台 App 前窗中心滚动",
      !msc?.isError && /of "TextEdit"/.test(say(msc)) && /top window: /.test(say(msc)) && /delivery=delivered_unverified/.test(say(msc)), say(msc).slice(0, 160));
  } else skipLocal("0.2.5：mac_scroll 不带 element_index → 先查最上层窗口，再在前台 App 前窗中心滚动");
  if (!CI) {
    const saved = spawnSync("/usr/bin/pbpaste", { timeout: 5000, env: { ...process.env, LANG: "en_US.UTF-8" } }).stdout;
    spawnSync("/usr/bin/pbcopy", { input: "noracu-clip 剪贴板", timeout: 5000, env: { ...process.env, LANG: "en_US.UTF-8" } });
    const cr = jsonOf(await call("mac_clipboard_read", {}));
    spawnSync("/usr/bin/pbcopy", { input: saved ?? "", timeout: 5000, env: { ...process.env, LANG: "en_US.UTF-8" } });
    checkHW("B3：mac_clipboard_read 读文本（含中文）", cr.type === "text" && cr.text === "noracu-clip 剪贴板", JSON.stringify(cr).slice(0, 90));
    spawnSync("/usr/bin/osascript", ["-e", 'display notification "noracu e2e body" with title "noracu-e2e-note"'], { timeout: 10000 });
    await sleepMs(1200);
  } else checkHW("B3：mac_clipboard_read 读文本（含中文）", true);
  const nl = jsonOf(await call("mac_notifications", { text: "noracu e2e body" }));
  const nid = nl.notifications?.[0]?.id;
  const ndm = nid ? await call("mac_notifications", { action: "dismiss", id: nid }) : null;
  const focusOn = CI ? null : focusMode();
  if (focusOn && !nid) skipEnv("B3：mac_notifications 列出并按 id 关闭横幅", `a Focus mode is on (${focusOn}), banners are held back; ${nl.count} listed`);
  else checkHW("B3：mac_notifications 列出并按 id 关闭横幅", nid && /delivered_verified/.test(say(ndm)), `${nl.count} listed; ${say(ndm).slice(0, 70)}`);
} else skipLocal("B3：本机等待 / 窗口 / 截图 / 剪贴板 / 通知");
// B3 本机：CDP 全链路 —— 用 Playwright 自带的 Chrome for Testing（不碰用户自己的应用）
{
  const { readdirSync, existsSync: ex } = await import("node:fs");
  const { homedir } = await import("node:os");
  const base = `${homedir()}/Library/Caches/ms-playwright`;
  let cft = null;
  try {
    for (const d of readdirSync(base).filter((x) => x.startsWith("chromium-")).sort().reverse()) {
      for (const sub of ["chrome-mac-arm64", "chrome-mac"]) { const p = `${base}/${d}/${sub}/Google Chrome for Testing.app`; if (ex(p)) { cft = p; break; } }
      if (cft) break;
    }
  } catch { /* no playwright cache */ }
  if (CI || !cft) {
    checkHW("B3：CDP 全链路（mac_app cdp_port → browser_launch → 断开 → 退出）", true);
    checkHW("t07：CDP 隔离（尾斜杠判重 / 0700 目录 / 禁止复用为普通浏览器 / CSS 缩放截图 / 退出后禁连）", true);
  } else {
    const { statSync } = await import("node:fs");
    const s = await spawnServer({ NORACU_ALLOW_CDP: "1" });
    let port = null;
    try {
      const say = (r) => String(r?.content?.[0]?.text);
      const la = await s.call("mac_app", { action: "launch", app: cft, cdp_port: 0 });
      try { port = JSON.parse(say(la)).cdp?.port; } catch {}
      const dupSlash = port ? await s.call("mac_app", { action: "launch", app: cft + "/", cdp_port: 0 }) : null;
      const modeRoot = statSync(`${homedir()}/.noracu`).mode & 0o777;
      const modeProf = statSync(`${homedir()}/.noracu/cdp-profiles`).mode & 0o777;
      const at = port ? await s.call("browser_launch", { cdp_port: port }) : null;
      const reuseBlocked = port ? await s.call("browser_launch", { headless: true }) : null;
      const nv = port ? await s.call("browser_navigate", { url: "https://example.com" }) : null;
      const cdpShot = port ? await s.call("browser_screenshot") : null;
      const shotMeta = String(cdpShot?.content?.find((c) => c.type === "text")?.text || "");
      const cl = port ? await s.call("browser_close") : null;
      const still = jsonOf(await s.call("mac_apps", { filter: "Chrome for Testing" }));
      const qt = await s.call("mac_app", { action: "quit", app: cft, force: true });
      const deadAttach = port ? await s.call("browser_launch", { cdp_port: port }) : null;
      port = null;
      check("B3：CDP 全链路（mac_app cdp_port → browser_launch → 断开 → 退出）", Boolean(at) && say(at).includes("attached") && say(nv).includes("example.com") && say(cl).includes("keeps running") && (still.apps || []).length > 0 && /delivered_verified/.test(say(qt)),
        `${say(cl).slice(0, 40)} | ${say(qt).slice(0, 60)}`);
      check("t07：CDP 隔离（尾斜杠判重 / 0700 目录 / 禁止复用为普通浏览器 / CSS 缩放截图 / 退出后禁连）",
        dupSlash?.isError && say(dupSlash).includes("cdp_requires_fresh_launch")
          && modeRoot === 0o700 && modeProf === 0o700
          && reuseBlocked?.isError && say(reuseBlocked).includes("cdp_session_active")
          && shotMeta.includes('"scale":"css"')
          && deadAttach?.isError && say(deadAttach).includes("no longer running"),
        `dup=${say(dupSlash).slice(0, 28)} mode=${modeRoot.toString(8)}/${modeProf.toString(8)} reuse=${say(reuseBlocked).slice(0, 28)}`);
    } finally {
      if (port) await s.call("mac_app", { action: "quit", app: cft, force: true }).catch(() => {});
      const exited = new Promise((r) => s.proc.once("exit", r));
      s.proc.kill();
      await Promise.race([exited, sleepMs(3000)]);
    }
  }
}

// B4：mac_menu_command 走 AX 引擎（本机：测试文档里 Edit > Select All；不存在的命令报错）
{
  const say = (r) => String(r?.content?.[0]?.text);
  // menu items are enabled for the app's key window: bring the test document forward first
  if (LOCAL && TE_READY()) {
    spawnSync("/usr/bin/osascript", ["-e", 'tell application "TextEdit" to activate'], { timeout: 10000 }); await sleepMs(600);
    const m1 = await call("mac_menu_command", { app: "TextEdit", command: "Edit > Select All" });
    const m2 = await call("mac_menu_command", { app: "TextEdit", command: "No Such Menu Item 123" });
    check("B4：mac_menu_command 按路径执行 / 不存在时报错", !m1?.isError && say(m1).includes("Select All") && m2?.isError && say(m2).includes("no menu item"), `${say(m1).slice(0, 60)} | ${say(m2).slice(0, 50)}`);
  } else skipLocal("B4：mac_menu_command 按路径执行 / 不存在时报错");
}
// B4 + t10 §3：NORACU_TRACE 只记 { ts, tool, args(shape), ms, error, code }，不记参数值、结果文本或错误消息；0600 + O_NOFOLLOW 拒绝符号链接
{
  const { mkdtempSync, readFileSync: rf, writeFileSync: wf, symlinkSync, statSync: st, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "noracu-e2e-"));
  const file = join(dir, "trace.jsonl");
  const s = await spawnServer({ NORACU_TRACE: file });
  try {
    await s.call("mac_type", { text: "s3cret-token", app: "__noracu_no_such_app__", mechanism: "physical" });
    await s.call("mac_status");
    const raw = rf(file, "utf8");
    const lines = raw.trim().split("\n").map((l) => JSON.parse(l));
    const mode = st(file).mode & 0o777;
    const keysOk = lines.every((l) => JSON.stringify(Object.keys(l)) === JSON.stringify(["ts", "tool", "args", "ms", "error", "code"]) && !("result" in l));
    check("B4/t10：NORACU_TRACE 仅记 code 不记结果与错误文本，权限 0600",
      lines.length === 2 && keysOk && mode === 0o600
        && lines[0].tool === "mac_type" && lines[0].args.text === "string(12)" && lines[0].error === true && lines[0].code === "focus_lost"
        && lines[1].tool === "mac_status" && lines[1].error === false && lines[1].code === null
        && !raw.includes("s3cret-token") && !raw.includes("__noracu_no_such_app__") && !raw.includes("is not running") && !raw.includes("cliclick"),
      `mode=${mode.toString(8)} line0=${JSON.stringify(lines[0]).slice(0, 90)}`);
  } finally { s.proc.kill(); rmSync(dir, { recursive: true, force: true }); }
  const dir2 = mkdtempSync(join(tmpdir(), "noracu-e2e-"));
  const target = join(dir2, "victim.txt");
  const link = join(dir2, "trace-link.jsonl");
  wf(target, "untouched");
  symlinkSync(target, link);
  const s2 = await spawnServer({ NORACU_TRACE: link });
  try {
    const stRes = await s2.call("mac_status");
    check("t10：NORACU_TRACE 使用 O_NOFOLLOW 拒绝符号链接且不影响工具调用", !stRes?.isError && rf(target, "utf8") === "untouched", rf(target, "utf8"));
  } finally { s2.proc.kill(); rmSync(dir2, { recursive: true, force: true }); }
  // a call refused before the tool runs gets its line too: unknown tool, invalid arguments, read-only mode, stop file
  const dir3 = mkdtempSync(join(tmpdir(), "noracu-e2e-"));
  const file3 = join(dir3, "trace.jsonl"), stop3 = join(dir3, "stop");
  wf(stop3, "");
  const s3 = await spawnServer({ NORACU_TRACE: file3, NORACU_READ_ONLY: "1", NORACU_STOP_FILE: stop3 });
  try {
    await s3.call("no_such_tool", { secret: "s3cret-token" });
    await s3.call("mac_ax_state", { depth: 2.5 });
    await s3.call("mac_click", { x: 1, y: 1 });
    await s3.call("browser_navigate", { url: "https://example.com/" });
    let raw3 = "";
    try { raw3 = rf(file3, "utf8"); } catch { /* nothing was written */ }
    const lines = raw3.trim() ? raw3.trim().split("\n").map((l) => JSON.parse(l)) : [];
    check("NORACU_TRACE：工具运行之前就被拒的调用也各记一行（未知工具 / 参数不合法 / 只读模式 / 停止文件），只有代码",
      lines.length === 4 && lines.every((l) => l.error === true && l.ms === 0 && JSON.stringify(Object.keys(l)) === JSON.stringify(["ts", "tool", "args", "ms", "error", "code"]))
        && lines[0].tool === "unknown(12)" && lines[0].code === "unknown_tool" && lines[0].args.secret === "string(12)" && !raw3.includes("no_such_tool")
        && lines[1].tool === "mac_ax_state" && lines[1].code === "invalid_args" && lines[1].args.depth === 2.5
        && lines[2].tool === "mac_click" && lines[2].code === "read_only"
        && lines[3].tool === "browser_navigate" && lines[3].code === "user_stopped" && lines[3].args.url === "string(20)"
        && !raw3.includes("s3cret-token") && !raw3.includes("example.com") && !raw3.includes(stop3),
      JSON.stringify(lines).slice(0, 400));
  } finally { s3.proc.kill(); rmSync(dir3, { recursive: true, force: true }); }
}

// 0.2.7：电脑前的人优先（NORACU_USER_IDLE_S）—— 解析（CI 安全）；本机：有人刚动过键鼠就不发、只读工具不受影响、
// 自己的输入不算人的、物理点击 / 滚动后光标回原处，=0 时全部关闭
{
  const say = (r) => String(r?.content?.[0]?.text);
  const idleOf = async (val) => { const s = await spawnServer({ NORACU_USER_IDLE_S: val }); try { return jsonOf(await s.call("mac_status")).user_idle_s; } finally { s.proc.kill(); } };
  const seen = {};
  for (const v of ["0", "1.5", "60", "", "abc", "-1", "61", "0x2"]) seen[v] = await idleOf(v);
  check("0.2.7：NORACU_USER_IDLE_S — 0 关闭，0 到 60 的数照用，其余（空、非数、负数、超 60）回到 2",
    seen["0"] === 0 && seen["1.5"] === 1.5 && seen["60"] === 60 && ["", "abc", "-1", "61", "0x2"].every((v) => seen[v] === 2), JSON.stringify(seen));
  if (LOCAL && TE_READY()) {
    const cc = process.env.NORACU_CLICLICK || "/opt/homebrew/bin/cliclick";
    const pointerAt = () => String(spawnSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", 'ObjC.import("CoreGraphics"); const p = $.CGEventGetLocation($.CGEventCreate(null)); p.x + "," + p.y'], { encoding: "utf8", timeout: 5000 }).stdout || "").trim().split(",").map(Number);
    const near = (a, b) => a.length === 2 && b.length === 2 && Math.abs(a[0] - b[0]) <= 2 && Math.abs(a[1] - b[1]) <= 2;
    const NOAPP = { key: "return", app: "__noracu_no_such_app__" };
    const YIELD_DOC = "noracu-e2e-yield";  // gets past the guard, then focus_lost: nothing sent either way
    await sleepMs(2300);  // input the other servers of this suite sent is not this server's own: let it age
    const s = await spawnServer({ NORACU_USER_IDLE_S: "2" });
    const s0 = await spawnServer({ NORACU_USER_IDLE_S: "0" });
    try {
      // "the person": zero-distance mouse moves from this test process, for 3.5 s — one move alone is waited out (R3)
      const mover = spawn("/bin/bash", ["-c", `for i in $(seq 1 14); do "${cc}" m:+0,+0; sleep 0.25; done`], { stdio: "ignore" });
      await sleepMs(300);
      const busy = await s.call("mac_key", NOAPP);
      await new Promise((r) => (mover.exitCode !== null ? r() : mover.on("exit", r)));
      const read = await s.call("phone_status");
      const off = await s0.call("mac_key", NOAPP);
      check("0.2.7：刚有人动过键鼠 → 输入工具返回 user_active、什么都不发；只读工具不受影响；=0 时不拦",
        busy?.isError && /^ERROR: user_active: /.test(say(busy)) && /delivery=not_delivered, retry=safe/.test(say(busy))
          && !/user_active/.test(say(read)) && off?.isError && /focus_lost/.test(say(off)),
        `${say(busy).slice(0, 80)} | ${say(read).slice(0, 30)} | ${say(off).slice(0, 40)}`);
      await sleepMs(2300);
      const calm = await s.call("mac_key", NOAPP);
      check("0.2.7：静止 2 s 后同一调用照常执行", calm?.isError && /focus_lost/.test(say(calm)) && !/user_active/.test(say(calm)), say(calm).slice(0, 80));
      // a document of its own: the shared test document may carry a sheet by now (B2's format changes)
      spawnSync("/usr/bin/osascript", ["-e", `tell application "TextEdit" to make new document with properties {name:"${YIELD_DOC}", text:"pointer test"}`, "-e", 'tell application "TextEdit" to activate'], { timeout: 10000 });
      await sleepMs(800);
      const ta = jsonOf(await s.call("mac_find", { app: "TextEdit", window: YIELD_DOC, role: "textarea" })).matches?.[0]?.i;
      const p1 = pointerAt();
      const clk = Number.isInteger(ta) ? await s.call("mac_click", { element_index: ta, mechanism: "physical" }) : null;
      const p2 = pointerAt();
      const next = await s.call("mac_key", NOAPP);
      const scr = Number.isInteger(ta) ? await s.call("mac_scroll", { element_index: ta, direction: "down" }) : null;
      const p3 = pointerAt();
      check("0.2.7：物理点击、滚动之后光标回到原处；紧接着的输入不把自己刚发的事件当成有人在用",
        Number.isInteger(ta) && !clk?.isError && /physical/.test(say(clk)) && near(p1, p2) && near(p1, p3)
          && next?.isError && /focus_lost/.test(say(next)) && !scr?.isError,
        `${say(clk).slice(0, 50)} | pointer ${p1} → ${p2} → ${p3} | ${say(next).slice(0, 30)} | ${say(scr).slice(0, 40)}`);
      const ta0 = jsonOf(await s0.call("mac_find", { app: "TextEdit", window: YIELD_DOC, role: "textarea" })).matches?.[0]?.i;
      // the pointer starts away from where the click lands (P17 triage): when it already sat there, "stays where
      // it clicked" could not be told from "went back". A point on the menu bar — never a screen corner, which
      // can be a hot corner — and it is put back afterwards.
      const q0 = pointerAt();
      spawnSync(cc, ["m:300,12"], { timeout: 5000 });
      await sleepMs(300);
      const q1 = pointerAt();
      const clk0 = Number.isInteger(ta0) ? await s0.call("mac_click", { element_index: ta0, mechanism: "physical" }) : null;
      const q2 = pointerAt();
      check("0.2.7：NORACU_USER_IDLE_S=0 时光标留在点击处", Number.isInteger(ta0) && !clk0?.isError && q2.length === 2 && !near(q1, q2), `pointer ${q1} → ${q2}`);
      // put the developer's pointer back where it was before the =0 click
      if (q0.length === 2) spawnSync(cc, [`m:${Math.round(q0[0])},${Math.round(q0[1])}`], { timeout: 5000 });
    } finally {
      s.proc.kill(); s0.proc.kill();
      spawnSync("/usr/bin/osascript", ["-e", `tell application "TextEdit" to close (every document whose name contains "${YIELD_DOC}") saving no`], { timeout: 10000 });
    }
  } else skipLocal("0.2.7：刚有人动过键鼠 → user_active", "0.2.7：静止 2 s 后照常执行", "0.2.7：光标回到原处", "0.2.7：=0 时光标留在点击处");
}

// B5（0.2.0）：假 AX 引擎（NORACU_AX_ENGINE）—— 不需要 macOS 权限即可检验 server 侧的 Mac 逻辑（CI 安全）
// The fake speaks the engine protocol: one JSON request on stdin, one JSON reply on stdout. Actions echo
// the fingerprint name of the element they were asked to act on, so a test can see which one it was.
const FAKE_AX = `#!/usr/bin/env node
const fs = require("fs");
let d = ""; process.stdin.on("data", (c) => (d += c)); process.stdin.on("end", () => {
  const req = JSON.parse(d); const say = (o) => process.stdout.write(JSON.stringify(o));
  // 0.3.0 gate tests: every op the server asked for, one per line (a refused input must ask for no action op)
  if (process.env.NORACU_TEST_OPS) fs.appendFileSync(process.env.NORACU_TEST_OPS, req.op + "\\n");
  const node = (name, i) => ({ d: 1, role: "AXButton", path: [i], fp: { role: "AXButton", subrole: "", id: "", name }, title: name, frame: [10 * i, 0, 10, 10], interactive: true });
  // "Ghost" is an app whose pid the frontmost op cannot name; "Term" is Terminal (bundle com.apple.Terminal);
  // "Neg" has a pid the bgpost script refuses before it creates any event (bad-pid: nothing posted)
  const base = { ok: true, app: "Fake", bundle_id: "test.fake", pid: req.app === "Front" ? 777 : req.app === "Ghost" ? 31337 : req.app === "Term" ? 555 : req.app === "Neg" ? -7 : req.app === "Plain" ? 556 : req.app === "pid:12" ? 12 : req.app === "Nameless" ? 557 : req.app === "MenuGone" ? 808 : req.app === "BarItem" ? 809 : 4242, surface: "window", complete: true, visited: 2, ms: 1, container: { kind: "window", wid: 1, title: "W", subrole: "", frame: [0, 0, 100, 100], n: 0 } };
  const webAx = req.app === "ChromeNoWeb" ? { web_accessibility: "unsupported" } : req.app === "ChromeWeb" ? { web_accessibility: "exposed" } : req.app === "NoIdApp" ? { window_identity: "unverifiable" } : {};
  if (req.op === "snapshot") return say({ ...base, ...webAx, nodes: [node("One", 0), node("Two", 1)] });
  if (req.op === "find") return say({ ...base, ...webAx, nodes: [node("Three", 0), node("Four", 1)] });
  if (req.op === "act") return say({ ok: true, delivery: "delivered_verified", retry: "unsafe", changed: ["value"], surfaces: [], mechanism: "semantic", action: "AXPress", how: "path", role: "AXButton", title: req.target.fp.name });
  if (req.op === "physical_prep") return req.target.fp.name === "Two" ? say({ ok: false, code: "OCCLUDED", message: "a window of Other is on top", delivery: "not_delivered", retry: "safe" })
    : req.target.fp.name === "Four" ? say({ ok: true, point: [700, 70], hit: "reaches", pid: 4242, wid: 1, before: {} })
    : req.target.pid === -7 ? say({ ok: true, point: [6, 6], hit: "reaches", pid: -7, wid: 1, before: {} })
    : req.target.pid === 777 ? say({ ok: true, point: [50, 50], hit: "reaches", pid: 777, wid: 5, before: {} })
    : req.target.pid === 808 ? say({ ok: true, point: [5, 205], hit: "reaches", pid: 808, wid: null, top_wid: 88, before: {} })
    : req.target.pid === 809 ? say({ ok: true, point: [40, 205], hit: "reaches", pid: 809, wid: null, top_wid: 3, before: {} })
    : say({ ok: true, point: [5, 5], hit: "reaches", pid: req.target.pid ?? 4242, wid: 1, before: {} });
  // "Two" sits where a window of "Other" (wid 6) is on top by the time of the late re-check (410,110)
  if (req.op === "scroll_prep") return say({ ok: true, point: req.target?.fp?.name === "Two" ? [410, 110] : [5, 5], hit: "reaches", pid: 4242, wid: 1, before: {} });
  if (req.op === "observe_after") return say({ ok: true, delivery: "delivered_verified", retry: "unsafe", changed: ["focus"], surfaces: [], ...(req.physical === true ? { note: "physical-flag-seen point=" + JSON.stringify(req.point) + " wid=" + req.wid } : {}) });
  // two running copies of "Twin"; pid:12 is the one that is not in front
  if (req.op === "app_info" && req.app === "pid:12") return say({ ok: true, running: true, name: "Twin", pid: 12, bundle_id: "x.twin", path: "/Applications/Twin.app" });
  if (req.op === "app_ctl" && req.action === "activate" && req.app === "pid:12") return say({ ok: true, sent: true, name: "Twin", pid: 12 });
  if (req.op === "frontmost") {
    // the engine's own shape: { pid, name, bundle } (not bundle_id); a pid is looked up, an unknown one has no app
    const APPS = { 777: { pid: 777, name: "Other", bundle: "x.other" }, 4242: { pid: 4242, name: "Fake", bundle: "test.fake" }, 999: { pid: 999, name: "NotificationCenter", bundle: "com.apple.notificationcenterui" }, 555: { pid: 555, name: "Terminal", bundle: "com.apple.Terminal" }, "-7": { pid: -7, name: "Neg", bundle: "test.neg" }, 556: { pid: 556, name: "Plain" }, 12: { pid: 12, name: "Twin", bundle: "x.twin" }, 557: { pid: 557, bundle: "test.nameless" }, 808: { pid: 808, name: "MenuGone", bundle: "test.menugone" }, 809: { pid: 809, name: "BarItem", bundle: "test.baritem" }, 301: { pid: 301, name: "Finder", bundle: "com.apple.finder" } };
    const t = req.pid !== undefined ? APPS[req.pid] || null : req.app === "Other" ? APPS[777] : req.app === "com.apple.finder" ? APPS[301] : req.app === "NotRunning" ? null : APPS[4242];
    const o = { ok: true, front: APPS[777], target: t, match: Boolean(t && t.pid === 777) };
    // "Twin": two running apps share the name — the engine names no target and hands its refusal along
    if (req.app === "Twin") { o.target = null; o.match = false; o.ambiguous = { code: "AMBIGUOUS_APP", message: "Twin names 2 running apps (pid 11, frontmost; pid 12)", delivery: "not_delivered", retry: "safe", details: { apps: [{ pid: 11, name: "Twin", bundle_id: "x.twin", frontmost: true }, { pid: 12, name: "Twin", bundle_id: "x.twin", frontmost: false }] } }; }
    // at: x >= 500 is under a notification banner, y < 30 is the menu bar, anything else is the frontmost app's window
    // 300,300 is the bare desktop (no window); 410,110 is a second window of "Other" (wid 6) over window 5
    // 5,205: the menu of "MenuGone" (window 88 at the hit test) has closed, its own window 2 is there now; 40,205: the menu bar (the window server's window 3)
    if (req.at) o.top = req.at[0] === 5 && req.at[1] === 205 ? { pid: 808, owner: "MenuGone", layer: 0, wid: 2 } : req.at[0] === 40 && req.at[1] === 205 ? { pid: 1, owner: "Window Server", layer: 24, wid: 3 } : req.at[0] === 300 && req.at[1] === 300 ? null : req.at[0] === 410 && req.at[1] === 110 ? { pid: 777, owner: "Other", layer: 0, wid: 6 } : req.at[0] === 6 && req.at[1] === 6 ? { pid: -7, owner: "Neg", layer: 0, wid: 1 } : req.at[0] === 5 && req.at[1] === 5 ? { pid: 4242, owner: "Fake", layer: 0, wid: 1 } : req.at[0] >= 500 ? { pid: 999, owner: "NotificationCenter", layer: 23, wid: 9 } : req.at[1] < 30 ? { pid: 640, owner: "Window Server", layer: 24, wid: 1 } : { pid: 777, owner: "Other", layer: 0, wid: 5 };
    return say(o);
  }
  // the frontmost app ("Other") has one window whose center (600,200) lies under the banner (x >= 500)
  if (req.op === "windows") return say({ ok: true, windows: [{ id: 5, app: "Other", pid: 777, title: "O", bounds: [400, 100, 400, 200], onscreen: true, layer: 0 }], displays: [] });
  // insert_text into the focused element of the frontmost app ("Other"): the text picks the answer
  if (req.op === "insert_text") {
    const nf = { ok: false, code: "ACTION_NOT_SUPPORTED", delivery: "not_delivered", retry: "safe" };
    if (req.text === "NOFOCUS") return say({ ...nf, message: '"Other" reports no focused element', details: { kind: "no_focus", app: "Other" } });
    if (req.text === "TERM") return say({ ...nf, message: 'the focused element of "Other" (AXTextArea) takes no text through accessibility', details: { kind: "not_text", role: "AXTextArea", textlike: true, app: "Other" } });
    if (req.text === "BUTTON") return say({ ...nf, message: 'the focused element of "Other" (AXButton) takes no text through accessibility and is not a text input — focus a text field first', details: { kind: "not_text", role: "AXButton", textlike: false, app: "Other" } });
    return say({ ok: true, mechanism: "semantic", via: "AXSelectedText", how: "focused", role: "AXTextField", app: req.app || "Other", delivery: "delivered_verified", retry: "unsafe" });
  }
  if (req.op === "key") {
    if (process.env.NORACU_TEST_KEY_REQ) fs.appendFileSync(process.env.NORACU_TEST_KEY_REQ, JSON.stringify(req) + "\\n");
    return say({ ok: true, delivery: "delivered_unverified", retry: "unsafe" });
  }
  if (req.op === "menu") {
    if (process.env.NORACU_TEST_MENU_REQ) fs.appendFileSync(process.env.NORACU_TEST_MENU_REQ, JSON.stringify(req) + "\\n");
    return say(JSON.parse(fs.readFileSync(process.env.NORACU_TEST_MENU_REPLY, "utf8")));
  }
  if (req.op === "set_value" || req.op === "get") { setTimeout(() => {}, 10000); return; }
  say({ ok: false, code: "INVALID_ARGS", message: "fake engine: op " + req.op + " not scripted" });
});
`;
{
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "noracu-e2e-"));
  const fake = join(dir, "fake-ax-engine");
  writeFileSync(fake, FAKE_AX, { mode: 0o700 });
  const clickLog = join(dir, "cliclick.log");
  const fakeClick = join(dir, "cliclick");
  writeFileSync(fakeClick, `#!/bin/bash\necho "$@" >> "${clickLog}"\n`, { mode: 0o700 });
  const imctlLog = join(dir, "imctl.log");
  const fakePy = join(dir, "python3");
  writeFileSync(fakePy, `#!/bin/bash
if [ "$1" = "-c" ]; then exit 0; fi
echo "$@" >> "${imctlLog}"
IN=""
if [ "$5" = "-" ]; then IN="$(cat)"; echo "stdin:$IN" >> "${imctlLog}"; fi
if [ "$3" = "type" ] && [ "$IN" = "X" ]; then echo "typed 1 chars (the screen changed after the paste, but OCR cannot read this text back — check the field; the clipboard still holds the typed text)"; exit 0; fi
if [ "$3" = "type" ] && [ "$IN" = "Y" ]; then echo "typed 1 chars (one character: OCR saw it appear, which is no proof of where it landed — check the field; the clipboard still holds the typed text)"; exit 0; fi
if [ "$3" = "type" ] && [ "$IN" = "LATEtext" ]; then echo "typed 8 chars (the text showed up late, during an extra 3s check after the 2.5s confirmation window — OCR cannot tell whether that is the paste or a line repeating it, such as a search result: check the field before typing again; the clipboard still holds the typed text)"; exit 0; fi
if [ "$3" = "type" ] && [ "$IN" = "Seen here" ]; then echo "typed 9 chars"; exit 0; fi
if [ "$3" = "type" ] && [ "$IN" = "NEWform" ]; then echo "typed 7 chars (sent to the keyboard; the screen was not looked at)"; exit 0; fi
if [ "$3" = "open" ] && [ "$IN" = "NewWay" ]; then echo "started 'NewWay' from the App Library"; exit 0; fi
if [ "$3" = "open" ] && [ "$IN" = "Maps" ]; then echo "opened 'Maps' (label read with confidence 0.90)"; exit 0; fi
if [ "$3" = "type" ] && [ "$IN" = "ok" ]; then echo "typed 2 chars (the screen changed after the paste, but a text of fewer than four characters, spaces and case aside, is never confirmed by OCR — check the field; the clipboard still holds the typed text)"; exit 0; fi
if [ "$3" = "type" ] && [ "$IN" = "STRIPtext" ]; then echo "typed 9 chars (OCR saw the text appear only in the strip at the top of the screen, where a field cannot be told from a notification banner — check the field; the clipboard still holds the typed text)"; exit 0; fi
if [ "$3" = "type" ] && [ "$IN" = "AZERTY" ]; then echo "keyboard_layout: the Mac keyboard layout types \\"q\\" on the key that ⌘A is sent from (key code 0), so iPhone Mirroring would get ⌘Q — nothing was sent; switch the Mac to a QWERTY-style input source (U.S., ABC, Pinyin) and retry" >&2; exit 2; fi
if [ "$3" = "scroll" ]; then echo "scrolled down 0.5"; exit 0; fi
if [ "$3" = "open" ] && [ "$IN" = "NoSuchApp" ]; then echo "app not found: 'NoSuchApp' (Spotlight showed no Top Hit)"; exit 1; fi
if [ "$3" = "tap" ] && [ "$5" = "0.03" ]; then echo "out_of_screen: (0.5,0.03) is on the iPhone Mirroring window's margin, not on the phone screen (x 0.029-0.971, y 0.061-0.987): a click there goes to the window's own controls or nowhere; nothing was sent" >&2; exit 2; fi
if [[ "$*" == *"--expect=CapFail"* ]]; then echo "capture_failed: could not capture the iPhone Mirroring window to check --expect; no image was returned, so nothing was sent" >&2; exit 7; fi
if [ "$3" = "status" ]; then
  printf 'Traceback (most recent call last):\\n  File "cli.py", line 1, in <module>\\nRuntimeError: synthetic boom\\n' >&2
  exit 1
fi
echo "home gesture sent"
`, { mode: 0o700 });
  // the first run of a newly written executable can wait on macOS's code scan for over a second — longer than
  // NORACU_AX_TIMEOUT_MS below — so each fake runs once here, before any timed call (CI flake: ax_timeout on the
  // first mac_ax_state)
  {
    const { execFileSync } = await import("node:child_process");
    try { execFileSync(fake, [], { input: '{"op":"warm"}', timeout: 30000 }); } catch {}
    try { execFileSync(fakeClick, ["warm"], { timeout: 30000 }); writeFileSync(clickLog, ""); } catch {}
  }
  const menuReply = join(dir, "menu-reply.json");
  const menuReqLog = join(dir, "menu-req.jsonl");
  const keyReqLog = join(dir, "key-req.jsonl");
  const s = await spawnServer({
    NORACU_AX_ENGINE: fake, NORACU_CLICLICK: fakeClick, NORACU_AX_TIMEOUT_MS: "1500",
    NORACU_NO_BGPOST: "1",  // 0.3.0: the fake engine's "Other" (pid 777) is a bgpost candidate — keep this section on the cliclick path it asserts
    NORACU_PYTHON: fakePy, NORACU_IMCTL_DIR: dir,
    NORACU_TEST_MENU_REPLY: menuReply, NORACU_TEST_MENU_REQ: menuReqLog, NORACU_TEST_KEY_REQ: keyReqLog,
  });
  const keyReqs = () => { try { return readFileSync(keyReqLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const sent = () => { try { return readFileSync(clickLog, "utf8"); } catch { return ""; } };
  const imctlSent = () => { try { return readFileSync(imctlLog, "utf8"); } catch { return ""; } };
  const menuReqs = () => { try { return readFileSync(menuReqLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  try {
    const say = (r) => String(r?.content?.[0]?.text);
    const a0 = await s.call("mac_ax_state", { app: "Fake" });
    const a = jsonOf(a0);
    const one = a.elements?.find((e) => e.title === "One")?.i;
    const f = jsonOf(await s.call("mac_find", { app: "Fake", role: "button" }));
    const three = f.matches?.find((e) => e.title === "Three")?.i;
    check("B5：索引跨快照唯一（mac_find 不复用旧编号）", Number.isInteger(one) && Number.isInteger(three) && one !== three && a.snapshot_id !== f.snapshot_id, `One=${one} (${a.snapshot_id}) Three=${three} (${f.snapshot_id})${Number.isInteger(one) ? "" : ` | mac_ax_state: ${say(a0).slice(0, 160)}`}`);
    if (!Number.isInteger(one) || !Number.isInteger(three)) throw new Error("fake engine snapshot failed — later B5 calls would run without an element_index");
    const c1 = await s.call("mac_click", { element_index: one });
    check("B5：旧快照的索引在新快照之后仍指向原元素（C1-3）", !c1?.isError && /"One"/.test(say(c1)), say(c1).slice(0, 90));
    const c2 = await s.call("mac_click", { element_index: one, snapshot_id: f.snapshot_id });
    check("B5：snapshot_id 与索引不符 → element_no_longer_valid", c2?.isError && /element_no_longer_valid/.test(say(c2)) && /belongs to snapshot/.test(say(c2)), say(c2).slice(0, 90));
    // physical mac_type: the click goes out, but when another app is in front afterwards no keystroke does
    const two = a.elements?.find((e) => e.title === "Two")?.i;
    const ty = await s.call("mac_type", { element_index: one, text: "s3cret", mechanism: "physical" });
    check("B5：mac_type 物理路径点击后前台不是目标应用 → 不发键（focus_lost）", ty?.isError && /focus_lost/.test(say(ty)) && /c:5,5/.test(sent()) && !/t:s3cret/.test(sent()), `${say(ty).slice(0, 70)} | cliclick: ${JSON.stringify(sent())}`);
    // mac_drag: a covered drop target refuses the whole drag (invariant 6 for both ends)
    const dg = await s.call("mac_drag", { from_index: one, to_index: two });
    check("B5：mac_drag 落点被遮挡 → 整个拖动不发送", dg?.isError && /drop target/.test(say(dg)) && /occluded/.test(say(dg)) && !/dd:/.test(sent()), `${say(dg).slice(0, 80)} | cliclick: ${JSON.stringify(sent())}`);
    // 0.2.1: raw x,y clicks ask the window server whose window is on top at the point before sending
    const rx1 = await s.call("mac_click", { x: 100, y: 100 });
    check("0.2.1：x,y 点击处最上层是前台应用的窗口 → 发送并写明顶层窗口", !rx1?.isError && /top window: "Other"/.test(say(rx1)) && /c:100,100/.test(sent()), `${say(rx1).slice(0, 90)} | cliclick: ${JSON.stringify(sent())}`);
    const rx2 = await s.call("mac_click", { x: 600, y: 100 });
    check("0.2.1：x,y 点击处被别的应用（通知横幅）盖住 → occluded，不发送", rx2?.isError && /^ERROR: occluded: 600,100 is covered by "NotificationCenter" \(window layer 23\), not "Other" \(the frontmost app\)/.test(say(rx2)) && /delivery=not_delivered, retry=safe/.test(say(rx2)) && !/c:600,100/.test(sent()), `${say(rx2).slice(0, 120)} | cliclick: ${JSON.stringify(sent())}`);
    // review R39: mac_scroll's refusal uses scroll wording — it takes no force and no app
    // two ways to name the target at once, or a snapshot_id with nothing it could be checked against
    const twoWays = [
      await s.call("mac_click", { element_index: one, x: 5, y: 5 }),
      await s.call("mac_click", { x: 5, y: 5, snapshot_id: "s1" }),
      await s.call("mac_scroll", { direction: "down", snapshot_id: "s1" }),
      await s.call("mac_type", { text: "x", snapshot_id: "s1" }),
    ];
    check("mac_click with element_index and x,y, and mac_click / mac_scroll / mac_type with a snapshot_id but no element_index: refused, nothing is sent",
      twoWays.every((r) => r?.isError && /delivery=not_delivered, retry=safe/.test(say(r))) && /one of the two/.test(say(twoWays[0])) && [1, 2, 3].every((i) => /snapshot_id goes with element_index/.test(say(twoWays[i]))),
      twoWays.map((r) => say(r).slice(0, 80)).join(" | "));
    // an app name that two running apps share: nothing is sent to either, and the answer lists them
    const twinLog = sent();
    const twin = [await s.call("mac_key", { key: "a", app: "Twin" }), await s.call("mac_type", { text: "hi", app: "Twin" }), await s.call("mac_click", { x: 5, y: 5, app: "Twin" })];
    check("an app name that two running apps share: mac_key, mac_type and mac_click at x,y answer ambiguous_app and send nothing",
      twin.every((r) => r?.isError && /^ERROR: ambiguous_app: Twin names 2 running apps/.test(say(r)) && /delivery=not_delivered, retry=safe/.test(say(r))) && sent() === twinLog,
      twin.map((r) => say(r).slice(0, 90)).join(" | "));
    // …and pid:<n>, which the answer names, works with mac_app activate: that process is brought forward by the
    // engine (open -a would pick whichever copy macOS likes)
    // …but an element_index names its process: with that name, mac_type types into the element when its process is
    // one of the copies, and refuses an element of another app
    const i12 = jsonOf(await s.call("mac_ax_state", { app: "pid:12" })).elements?.find((e) => e.title === "One")?.i;
    const i4242 = jsonOf(await s.call("mac_ax_state", { app: "Fake" })).elements?.find((e) => e.title === "One")?.i;
    const own12 = await s.call("mac_type", { element_index: i12, text: "hi", app: "Twin" });
    const notTwin = await s.call("mac_type", { element_index: i4242, text: "hi", app: "Twin" });
    check("mac_type with element_index and an app name two running copies share: the element's own copy is one of them → typed; an element of another app → focus_lost, nothing sent",
      Number.isInteger(i12) && !own12?.isError && /^typed /.test(say(own12)) && notTwin?.isError && /belongs to another app than "Twin" — nothing was sent/.test(say(notTwin)),
      `${say(own12).slice(0, 110)} | ${say(notTwin).slice(0, 110)}`);
    const actPid = await s.call("mac_app", { action: "activate", app: "pid:12" });
    check("mac_app activate pid:12: that process is brought forward through the engine, not by open -a",
      !actPid?.isError && /^activated "Twin"/.test(say(actPid)), say(actPid).slice(0, 120));
    const sc0 = await s.call("mac_scroll", { direction: "down" });
    check("0.2.6（R39）：mac_scroll 中心被盖住 → occluded，提示只指向 element_index，不出现 force:true / pass app",
      sc0?.isError && /^ERROR: occluded: 600,200 is covered by "NotificationCenter" \(window layer 23\), not "Other" \(the frontmost app\)/.test(say(sc0))
        && /pass element_index to scroll a specific element$/.test(say(sc0)) && !/force:true|pass app:/.test(say(sc0)) && /delivery=not_delivered, retry=safe/.test(say(sc0)),
      say(sc0).slice(0, 200));
    // mac_type with element_index and an app the element does not belong to: refused before anything is written, on
    // the accessibility path too (it was checked only before physical keystrokes)
    const snapFake = await s.call("mac_ax_state", { app: "Fake" });
    const idxFake = (() => { try { return JSON.parse(say(snapFake)).elements[0].i; } catch { return null; } })();
    const tyOther = await s.call("mac_type", { element_index: idxFake, app: "Other", text: "hi" });
    check("mac_type with element_index and an app the element does not belong to: refused on the accessibility path too, nothing written",
      Number.isInteger(idxFake) && tyOther?.isError && /belongs to another app than "Other"/.test(say(tyOther)) && /delivery=not_delivered/.test(say(tyOther)), say(tyOther).slice(0, 160));
    // review 0.2.6 #2: mac_type into the focused element names the app; an app with no focused element
    // gets keystrokes only when app names it; a text view accessibility cannot write still gets them
    const ty1 = await s.call("mac_type", { text: "hello" });
    const ty2 = await s.call("mac_type", { text: "NOFOCUS" });
    const ty3 = await s.call("mac_type", { text: "NOFOCUS", app: "Other" });
    const ty4 = await s.call("mac_type", { text: "TERM" });
    const ty5 = await s.call("mac_type", { text: "BUTTON" });
    check("0.2.6（#2）：mac_type 写焦点元素时写明应用；无焦点元素且未给 app → no_focus 不发键；给 app → 发键并写明；终端类照旧发键；按钮不发键",
      /typed 5 chars into the focused element of "Other" via semantic AXSelectedText — delivery=delivered_verified/.test(say(ty1))
        && ty2?.isError && /^ERROR: no_focus: "Other" \(the frontmost app\) reports no focused element/.test(say(ty2)) && /app:"Other"/.test(say(ty2)) && /delivery=not_delivered, retry=safe/.test(say(ty2))
        && !ty3?.isError && /typed 7 chars into "Other" \(it reports no focused element\) via physical keystrokes/.test(say(ty3))
        && !ty4?.isError && /typed 4 chars into the focused element of "Other" via physical keystrokes/.test(say(ty4))
        && ty5?.isError && /action_not_supported/.test(say(ty5))
        && (sent().match(/t:NOFOCUS/g) || []).length === 1 && /t:TERM/.test(sent()) && !/t:BUTTON/.test(sent()),
      [ty1, ty2, ty3, ty4, ty5].map((r) => say(r).slice(0, 110)).join(" | ") + ` | cliclick: ${JSON.stringify(sent())}`);
    const rx3 = await s.call("mac_click", { x: 600, y: 120, force: true });
    check("0.2.1：force:true 跳过顶层窗口检查并如实标注", !rx3?.isError && /unchecked: force/.test(say(rx3)) && /c:600,120/.test(sent()), `${say(rx3).slice(0, 90)} | cliclick: ${JSON.stringify(sent())}`);
    const rx4 = await s.call("mac_click", { x: 100, y: 10 });
    check("0.2.1：菜单栏（Window Server layer 24）算前台应用的 → 发送", !rx4?.isError && /top window: the menu bar \(Other\)/.test(say(rx4)) && /c:100,10/.test(sent()), `${say(rx4).slice(0, 90)} | cliclick: ${JSON.stringify(sent())}`);
    const rx5 = await s.call("mac_click", { x: 110, y: 100, app: "Fake" });
    check("0.2.1：app 指定的应用不在该点最上层 → occluded，并提示 app:\"Other\"", rx5?.isError && /covered by "Other", not "Fake"/.test(say(rx5)) && /app:"Other"/.test(say(rx5)) && !/c:110,100/.test(sent()), `${say(rx5).slice(0, 120)} | cliclick: ${JSON.stringify(sent())}`);
    const rx6 = await s.call("mac_click", { element_index: one, force: true });
    check("0.2.1：element_index 点击不接受 app / force（参数校验，不发送）", rx6?.isError && /apply to x,y clicks only/.test(say(rx6)), say(rx6).slice(0, 90));
    // 0.2.1: web content refused and absent → a hint the model can act on; exposed anyway → no hint
    const wa1 = jsonOf(await s.call("mac_ax_state", { app: "ChromeNoWeb" }));
    const wa2 = jsonOf(await s.call("mac_ax_state", { app: "ChromeWeb" }));
    const wf1 = jsonOf(await s.call("mac_find", { app: "ChromeNoWeb", role: "button" }));
    check("0.2.1：web_accessibility unsupported → 附 web_accessibility_hint（browser_* / --force-renderer-accessibility）；exposed → 无 hint",
      wa1.web_accessibility === "unsupported" && /browser_\*/.test(wa1.web_accessibility_hint) && /--force-renderer-accessibility/.test(wa1.web_accessibility_hint)
        && wa2.web_accessibility === "exposed" && !("web_accessibility_hint" in wa2)
        && wf1.web_accessibility === "unsupported" && /browser_\*/.test(wf1.web_accessibility_hint) && Array.isArray(wf1.matches),
      JSON.stringify({ wa1: wa1.web_accessibility, wa2: wa2.web_accessibility, wf1: wf1.web_accessibility }));
    // 0.2.2: a physical click tells observe_after it was physical (a vanished target is then not proof);
    // a window without a window id is flagged in the snapshot with a hint
    const pc = await s.call("mac_click", { element_index: one, mechanism: "physical" });
    const ni = jsonOf(await s.call("mac_ax_state", { app: "NoIdApp" }));
    check("0.2.2：物理点击向 observe_after 传 physical（含点击点与窗口 ID）；无窗口 ID 的窗口在快照里标 window_identity 并附提示",
      !pc?.isError && /via physical click/.test(say(pc)) && /physical-flag-seen point=\[5,5\] wid=1/.test(say(pc))
        && ni.window_identity === "unverifiable" && /policy_denied/.test(ni.window_identity_hint || ""),
      `${say(pc).slice(0, 80)} | ${JSON.stringify({ wi: ni.window_identity })}`);
    // 0.2.2: right before the click the window stack is asked again; a window that came on top since the hit
    // test refuses the click (the element "Four" was hit-tested at 700,70, a banner is there by now)
    const four = f.matches?.find((e) => e.title === "Four")?.i;
    const lc = await s.call("mac_click", { element_index: four, mechanism: "physical" });
    check("0.2.2：命中检测之后、点击之前有窗口盖上来 → 点击前复查拒绝（occluded，不发送）",
      lc?.isError && /came on top at 700,70 between the hit test and the input/.test(say(lc)) && /delivery=not_delivered, retry=safe/.test(say(lc)) && !/c:700,70/.test(sent()),
      `${say(lc).slice(0, 120)} | cliclick: ${JSON.stringify(sent()).slice(-60)}`);
    // 0.2.1: named keys go through the engine as HID key events (Chrome's address bar ignored cliclick's Return);
    // 0.2.6: a cmd/ctrl chord on a character goes to the engine as { char } (it finds the key in the current layout);
    // a plain character or a shift-only chord is still typed through cliclick
    const k1 = await s.call("mac_key", { key: "return" });
    const k2 = await s.call("mac_key", { key: "cmd-arrow-up" });
    const k3 = await s.call("mac_key", { key: "cmd-c" });
    const k4 = await s.call("mac_key", { key: "cmd-V" });
    const k5 = await s.call("mac_key", { key: "shift-z" });
    const kr = keyReqs();
    check("0.2.1/0.2.6：mac_key return / cmd-arrow-up 走引擎键码；cmd-c / cmd-V 走引擎 char（按当前布局找键）；shift-z 仍走 cliclick",
      !k1?.isError && /HID key event/.test(say(k1)) && !k2?.isError && !k3?.isError && /HID key event/.test(say(k3)) && !k4?.isError && !k5?.isError
        && kr.length === 4 && kr[0].code === 36 && kr[0].mods.length === 0 && kr[0].fn_key === false
        && kr[1].code === 126 && JSON.stringify(kr[1].mods) === '["cmd"]' && kr[1].fn_key === true && kr[1].numpad === true
        && kr[2].char === "c" && JSON.stringify(kr[2].mods) === '["cmd"]' && kr[2].code === undefined
        && kr[3].char === "V" && JSON.stringify(kr[3].mods) === '["cmd"]'
        && !/kp:return/.test(sent()) && !/t:c|t:V/.test(sent()) && /kd:shift t:z ku:shift/.test(sent()),
      `${say(k1).slice(0, 60)} | engine: ${JSON.stringify(kr)} | cliclick: ${JSON.stringify(sent()).slice(-80)}`);
    // mutating vs read-only engine timeout labels (NORACU_AX_TIMEOUT_MS=1500)
    const sv = await s.call("mac_set_value", { element_index: one, value: "x" });
    check("B5：mac_set_value 超时 → ax_timeout 带 delivery=unknown, retry=unsafe", sv?.isError && /ax_timeout:/.test(say(sv)) && /\(delivery=unknown, retry=unsafe\)/.test(say(sv)), say(sv).slice(0, 100));
    const gt = await s.call("mac_get", { element_index: one });
    check("B5：只读 mac_get 超时 → ax_timeout 不报 retry=unsafe", gt?.isError && /ax_timeout:/.test(say(gt)) && !/retry=unsafe/.test(say(gt)) && !/delivery=/.test(say(gt)), say(gt).slice(0, 100));
    // t06 phone validateArgs: bad x, bad swipe bounds/ms, bad direction, bad key, overlong text — never reach imctl
    const badTap = await s.call("phone_tap", { x: 1.5, y: 0.5 });
    const badSwipe1 = await s.call("phone_swipe", { from: [-0.1, 0.5], to: [0.5, 0.5] });
    const badSwipe2 = await s.call("phone_swipe", { from: [0.5, 0.8], to: [0.5, 0.2], ms: 10 });
    const badScroll = await s.call("phone_scroll", { direction: "diagonal" });
    const badKey = await s.call("phone_key", { key: "cmd-q" });
    const badFind = await s.call("phone_find", { text: "x".repeat(201) });
    const badType = await s.call("phone_type", { text: "x".repeat(2001) });
    check("B5/t06：phone_* 校验层拦截越界坐标 / 非法方向 / 非法键名 / 超长文本，且不启动 imctl",
      [badTap, badSwipe1, badSwipe2, badScroll, badKey, badFind, badType].every((r) => r?.isError) && imctlSent() === "",
      `${say(badTap).slice(0, 40)} | ${say(badKey).slice(0, 40)} | imctl=${JSON.stringify(imctlSent())}`);
    // t06 mirrorMenu: menu_item_disabled / TIMEOUT / delivered_unverified — none may fall back to imctl
    writeFileSync(menuReply, JSON.stringify({ ok: false, code: "ACTION_FAILED", details: { kind: "menu_item_disabled" } }));
    const mhDis = await s.call("phone_home");
    check("B5/t06：mirrorMenu 菜单项禁用 → mirror_not_live 且不回退 imctl",
      mhDis?.isError && /mirror_not_live/.test(say(mhDis)) && menuReqs().at(-1)?.require_enabled === true && imctlSent() === "",
      `${say(mhDis).slice(0, 80)} | imctl=${JSON.stringify(imctlSent())}`);
    writeFileSync(menuReply, JSON.stringify({ ok: false, code: "TIMEOUT", delivery: "unknown" }));
    const mhTo = await s.call("phone_home");
    check("B5/t06：mirrorMenu 超时（delivery=unknown）→ menu_unknown 且不回退 imctl",
      mhTo?.isError && /menu_unknown/.test(say(mhTo)) && /retry=unsafe/.test(say(mhTo)) && imctlSent() === "",
      `${say(mhTo).slice(0, 80)} | imctl=${JSON.stringify(imctlSent())}`);
    writeFileSync(menuReply, JSON.stringify({ ok: true, delivery: "delivered_unverified", path: "View > Home Screen", app: "iPhone Mirroring" }));
    const mhOk = await s.call("phone_home");
    check("B5/t06：mirrorMenu 成功 → 文案声明 screen not verified 且不启动 imctl",
      !mhOk?.isError && /screen not verified/.test(say(mhOk)) && /delivery=delivered_unverified, retry=unsafe/.test(say(mhOk)) && imctlSent() === "",
      `${say(mhOk).slice(0, 90)} | imctl=${JSON.stringify(imctlSent())}`);
    // menu_item_absent (non-English macOS) still falls back to imctl; `--` separates positionals; non-import Traceback → imctl_error
    writeFileSync(menuReply, JSON.stringify({ ok: false, code: "ACTION_FAILED", details: { kind: "menu_item_absent" } }));
    const mhFb = await s.call("phone_home");
    await s.call("phone_find", { text: "--exact" });
    await s.call("phone_open", { app: "-Settings" });
    await s.call("phone_key", { key: "return", expect: "Home" });
    await s.call("phone_key", { key: "return", expect: "--replace" }); // R19: one --expect=… token, never read as an option
    const psBoom = await s.call("phone_status");
    const logAfter = imctlSent();
    // R19: phone_open had already gone Home and searched Spotlight; a capture failure while checking --expect sent nothing
    const nf = await s.call("phone_open", { app: "NoSuchApp" });
    const cf = await s.call("phone_tap", { x: 0.5, y: 0.5, expect: "CapFail" });
    // device run 2026-11-10: a tap aimed at the mirror window's margin is refused by imctl; the line passes through as it is
    const oos = await s.call("phone_tap", { x: 0.5, y: 0.03 });
    check("0.3.0（device run 2026-11-10）：phone_tap 落在镜像窗口边框上 → out_of_screen 原样透传，not_delivered / retry=safe",
      oos?.isError && /^ERROR: out_of_screen: \(0\.5,0\.03\) is on the iPhone Mirroring window's margin/.test(say(oos)) && /delivery=not_delivered, retry=safe/.test(say(oos)),
      say(oos).slice(0, 200));
    // device run 2026-11-06: a paste only the frame diff saw is reported unverified
    const tu = await s.call("phone_type", { text: "X" });
    check("B5/device：phone_type 只有画面变化、OCR 读不回 → delivered_unverified",
      !tu?.isError && /OCR cannot read this text back/.test(say(tu)) && /delivery=delivered_unverified, retry=unsafe/.test(say(tu)), say(tu).slice(-70));
    // 0.2.5: only a sighting in the field confirms phone_type; phone_scroll never claims verified
    const tY = await s.call("phone_type", { text: "Y" });
    const tL = await s.call("phone_type", { text: "LATEtext" });
    const tS = await s.call("phone_type", { text: "Seen here" });
    const sc = await s.call("phone_scroll", { direction: "down" });
    check("0.2.5：phone_type 单字符、迟到（R38：不论看到在哪）→ delivered_unverified；在输入处看到 → delivered_verified；phone_scroll → delivered_unverified",
      /delivery=delivered_unverified/.test(say(tY)) && /showed up late/.test(say(tL)) && /delivery=delivered_unverified/.test(say(tL)) && /delivery=delivered_verified/.test(say(tS)) && /delivery=delivered_unverified/.test(say(sc)),
      [say(tY), say(tL), say(tS), say(sc)].map((t) => t.slice(-40)).join(" | "));
    // a line that comes with exit code 0 and is not the driver's confirmed one is not read as verified
    const tN = await s.call("phone_type", { text: "NEWform" });
    const oN = await s.call("phone_open", { app: "NewWay" });
    const oM = await s.call("phone_open", { app: "Maps" });
    check("phone_type / phone_open: only the driver's own confirmed line is delivered_verified; another line with exit code 0 is delivered_unverified",
      !tN?.isError && /delivery=delivered_unverified, retry=unsafe/.test(say(tN)) && !oN?.isError && /delivery=delivered_unverified, retry=unsafe/.test(say(oN)) && /delivery=delivered_verified/.test(say(oM)),
      [say(tN), say(oN), say(oM)].map((t) => t.slice(-70)).join(" | "));
    const tO = await s.call("phone_type", { text: "ok" });
    const tT = await s.call("phone_type", { text: "STRIPtext" });
    check("0.2.6（#7）：phone_type 太短 / 只在顶部横幅带看到 → 写明原因，delivered_unverified",
      !tO?.isError && /never confirmed by OCR/.test(say(tO)) && /delivery=delivered_unverified, retry=unsafe/.test(say(tO))
        && !tT?.isError && /cannot be told from a notification banner/.test(say(tT)) && /delivery=delivered_unverified, retry=unsafe/.test(say(tT)),
      [say(tO), say(tT)].map((t) => t.slice(-60)).join(" | "));
    const tK = await s.call("phone_type", { text: "AZERTY" });
    check("0.2.6（#5）：phone_type 遇到 Mac 键盘布局不符 → keyboard_layout 原样透传，not_delivered / retry=safe",
      tK?.isError && /^ERROR: keyboard_layout: the Mac keyboard layout types "q"/.test(say(tK)) && /delivery=not_delivered, retry=safe/.test(say(tK)),
      say(tK).slice(0, 200));
    check("B5/R19：phone_open app not found → delivered_unverified；--expect 截图失败 → not_delivered",
      nf?.isError && /app not found/.test(say(nf)) && /delivery=delivered_unverified, retry=safe/.test(say(nf))
        && cf?.isError && /capture_failed/.test(say(cf)) && /delivery=not_delivered, retry=safe/.test(say(cf)),
      `${say(nf).slice(-60)} | ${say(cf).slice(-60)}`);
    // R18: find / open text goes in on stdin ("-" in argv), never in the process list
    check("B5/t06：menu_item_absent 回退 imctl；find/open 文本经 stdin（argv 只有 `-- -`）；key 带 `--`；非导入异常报 imctl_error",
      !mhFb?.isError && /-m imctl\.cli home/.test(logAfter) && /find -- -\n/.test(logAfter) && /stdin:--exact/.test(logAfter) && /open -- -\n/.test(logAfter) && /stdin:-Settings/.test(logAfter) && !/cli (find|open) -- (--exact|-Settings)/.test(logAfter) && /key --expect=Home -- return/.test(logAfter) && /key --expect=--replace -- return/.test(logAfter) && psBoom?.isError && /imctl_error: RuntimeError: synthetic boom/.test(say(psBoom)) && !/imctl unavailable/.test(say(psBoom)),
      `${say(psBoom).slice(0, 60)} | log=${JSON.stringify(logAfter.trim())}`);
    // a name with a line break or another control character is refused before imctl is started
    const ctl = [await s.call("phone_open", { app: "Weather\n" }), await s.call("phone_open", { app: "\rSettings" }), await s.call("phone_open", { app: "Maps\u2028" }), await s.call("phone_open", { app: "Notes\u0085" })];
    // an accented letter, a no-break space and an emoji are part of real names: not refused here
    const named = await s.call("phone_open", { app: "Caf\u00e9\u00a0\ud83d\ude42" });
    check("phone_open：名字里带换行等控制字符在参数校验时就拒，不交给 imctl",
      ctl.length === 4 && ctl.every((r) => r?.isError && /^ERROR: phone_open: app must not contain control characters/.test(say(r)) && /delivery=not_delivered, retry=safe/.test(say(r)))
        && !/control characters/.test(say(named)),
      `${ctl.map((r) => say(r).slice(0, 60)).join(" | ")} | ${say(named).slice(0, 60)}`);
  } finally { s.proc.kill(); rmSync(dir, { recursive: true, force: true }); }
}

// 0.3.0 输入门（review CR1/CR2 + device run 2026-11-09，CI 安全）：
//   stop file 在输入队列入口拦下所有 mac/phone 输入（含不发事件的语义路径）；
//   审批按收到输入的 app 判（元素的 pid / 指定的 app / 点上最上层窗口的 app），不按前台；
//   识别不出 app → 拒发；默认拒绝列表按 bundle id 生效（引擎给的是 bundle，不是 bundle_id）
{
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "noracu-gate-"));
  const fake = join(dir, "fake-ax-engine");
  writeFileSync(fake, FAKE_AX, { mode: 0o700 });
  const clickLog = join(dir, "cliclick.log");
  const fakeClick = join(dir, "cliclick");
  writeFileSync(fakeClick, `#!/bin/bash\necho "$@" >> "${clickLog}"\n`, { mode: 0o700 });
  const imctlLog = join(dir, "imctl.log");
  const fakePy = join(dir, "python3");
  writeFileSync(fakePy, `#!/bin/bash\nif [ "$1" = "-c" ]; then exit 0; fi\necho "$@" >> "${imctlLog}"\necho "tapped"\n`, { mode: 0o700 });
  try { execFileSync(fake, [], { input: '{"op":"warm"}', timeout: 30000 }); } catch {}
  try { execFileSync(fakeClick, ["warm"], { timeout: 30000 }); } catch {}
  const opsLog = join(dir, "ops.log");
  const stopFile = join(dir, "STOP");
  const read = (f) => { try { return readFileSync(f, "utf8"); } catch { return ""; } };
  const clear = () => { for (const f of [opsLog, clickLog, imctlLog]) writeFileSync(f, ""); };
  const say = (r) => String(r?.content?.[0]?.text);
  const ACTION_OPS = /^(act|set_value|insert_text|menu|key|paste|scroll_prep)$/m;
  const env = { NORACU_AX_ENGINE: fake, NORACU_CLICLICK: fakeClick, NORACU_AX_TIMEOUT_MS: "1500", NORACU_PYTHON: fakePy, NORACU_IMCTL_DIR: dir, NORACU_TEST_OPS: opsLog, NORACU_USER_IDLE_S: "0" };
  const s = await spawnServer({ ...env, NORACU_STOP_FILE: stopFile, NORACU_NO_BGPOST: "1" });
  try {
    const idx = async (app) => jsonOf(await s.call("mac_ax_state", { app })).elements?.find((e) => e.title === "One")?.i;
    const one = await idx("Fake");
    writeFileSync(stopFile, "");
    clear();
    const calls = [
      ["mac_click", { element_index: one }],                        // semantic AXPress: sends no event
      ["mac_click", { element_index: one, mechanism: "physical" }],  // physical with bgpost off
      ["mac_set_value", { element_index: one, value: "x" }],
      ["mac_drag", { from_index: one, to_index: one }],
      ["mac_type", { element_index: one, text: "hi" }],
      ["mac_key", { key: "return" }],
      ["mac_scroll", { element_index: one }],
      ["phone_tap", { x: 0.5, y: 0.5 }],
    ];
    const rs = [];
    for (const [n, a] of calls) rs.push([n, await s.call(n, a)]);
    const stopped = rs.every(([, r]) => r?.isError && /^ERROR: user_stopped: /.test(say(r)) && /delivery=not_delivered, retry=safe/.test(say(r)));
    check("0.3.0（CR1/CR2 T1）：stop file 存在时语义点击、物理点击（bgpost 关）、set_value、drag、type、key、scroll、phone_tap 全部 user_stopped；引擎、cliclick、imctl 一次都没被调用",
      Number.isInteger(one) && stopped && read(opsLog) === "" && read(clickLog) === "" && read(imctlLog) === "",
      rs.filter(([, r]) => !/user_stopped/.test(say(r))).map(([n, r]) => `${n}: ${say(r).slice(0, 80)}`).join(" | ") + ` | ops=${JSON.stringify(read(opsLog))} click=${JSON.stringify(read(clickLog))} imctl=${JSON.stringify(read(imctlLog))}`);
    const obs = await s.call("mac_ax_state", { app: "Fake" });
    check("0.3.0（T1）：stop file 不挡观察类工具", !obs?.isError && /snapshot_id/.test(say(obs)), say(obs).slice(0, 80));
    // the browser's input tools stop too; its observation tools do not
    const bs = [];
    for (const [n, a] of [["browser_navigate", { url: "https://example.com" }], ["browser_click", { selector: "a" }], ["browser_type", { text: "x" }], ["browser_tabs", { action: "new" }]]) bs.push([n, await s.call(n, a)]);
    const bList = await s.call("browser_tabs", { action: "list" });
    check("S4A：stop file 存在时 browser 输入工具（navigate/click/type/tabs new）也 user_stopped；browser_tabs list 不受影响",
      bs.every(([, r]) => r?.isError && /^ERROR: user_stopped: /.test(say(r))) && !/user_stopped/.test(say(bList)),
      bs.map(([n, r]) => `${n}: ${say(r).slice(0, 50)}`).join(" | ") + ` | list: ${say(bList).slice(0, 50)}`);
    rmSync(stopFile, { force: true });
    // default deny list, by bundle id: Terminal is in the background (the frontmost app is "Other")
    const tOne = await idx("Term");
    const gOne = await idx("Ghost");
    const pOne = await idx("Plain");
    const qOne = await idx("Nameless");
    clear();
    const nn = await s.call("mac_click", { element_index: qOne });
    check("审计：读不到名字、只有 bundle id 的 app，在按名字写的规则生效时（默认拒绝列表就有）→ input_denied，不发",
      nn?.isError && /^ERROR: input_denied: the name of the app that would receive the input could not be read/.test(say(nn)) && !ACTION_OPS.test(read(opsLog)), say(nn).slice(0, 140));
    clear();
    const nb = await s.call("mac_click", { element_index: pOne });
    check("0.3.0：只有名字、读不到 bundle id 的 app（\"Plain\"）在默认拒绝列表生效时 → input_denied，不发",
      nb?.isError && /^ERROR: input_denied: "Plain" has no readable bundle id/.test(say(nb)) && !ACTION_OPS.test(read(opsLog)), say(nb).slice(0, 120));
    const d1 = await s.call("mac_click", { element_index: tOne });
    const d2 = await s.call("mac_set_value", { element_index: tOne, value: "x" });
    const g1 = await s.call("mac_click", { element_index: gOne });
    const nr = await s.call("mac_menu_command", { app: "NotRunning", command: "File > Close" });
    const ok1 = await s.call("mac_click", { x: 100, y: 100 });
    check("0.3.0（device run 2026-11-09）：默认拒绝列表按 bundle id 生效 —— 后台的 Terminal（com.apple.Terminal）的语义点击、set_value 都 input_denied；识别不出 app → input_denied（fail closed）；没在运行的 app → app_not_found；点在前台 Other 窗口上的 x,y 照常发送",
      d1?.isError && /^ERROR: input_denied: "Terminal" — denied by .*com\.apple\.Terminal/.test(say(d1)) && d2?.isError && /input_denied: "Terminal"/.test(say(d2))
        && g1?.isError && /^ERROR: input_denied: could not identify the app of pid 31337/.test(say(g1)) && /fail closed/.test(say(g1))
        && nr?.isError && /^ERROR: app_not_found: "NotRunning" is not running/.test(say(nr))
        && !ok1?.isError && /c:100,100/.test(read(clickLog)) && !ACTION_OPS.test(read(opsLog)),
      [d1, d2, g1, nr, ok1].map((r) => say(r).slice(0, 90)).join(" | ") + ` | ops=${JSON.stringify(read(opsLog).trim().split("\n").join(","))}`);
  } finally { s.proc.kill(); }
  // an explicit deny list: the target app is judged, not the frontmost one
  const s2 = await spawnServer({ ...env, NORACU_DENY_APPS: "test.fake,com.apple.finder", NORACU_NO_BGPOST: "1" });
  try {
    const one = jsonOf(await s2.call("mac_ax_state", { app: "Fake" })).elements?.find((e) => e.title === "One")?.i;
    clear();
    const rs = [
      await s2.call("mac_set_value", { element_index: one, value: "x" }),
      await s2.call("mac_click", { element_index: one }),
      await s2.call("mac_drag", { from_index: one, to_index: one }),
      await s2.call("mac_menu_command", { app: "Fake", command: "File > Close" }),
      await s2.call("mac_type", { element_index: one, text: "hello" }),
    ];
    const ok1 = await s2.call("mac_click", { x: 100, y: 100 });
    const ok2 = await s2.call("mac_key", { key: "shift-z" });
    const dk = await s2.call("mac_click", { x: 300, y: 300, force: true });
    check("0.3.0：force 点在空桌面上 → 按 Finder 判（这里 Finder 被拒）→ input_denied，不按前台 app 放行",
      dk?.isError && /^ERROR: input_denied: "Finder" — denied by NORACU_DENY_APPS \("com\.apple\.finder"\)/.test(say(dk)) && !/c:300,300/.test(read(clickLog)), say(dk).slice(0, 140));
    check("0.3.0（CR1/CR2 T1）：审批按目标 app 判 —— 前台 Other 允许，后台被拒的 Fake（test.fake）的 set_value、语义点击、drag、菜单命令、type 都 input_denied 且没有动作请求；Other 上的 x,y 点击与按键照常",
      rs.every((r) => r?.isError && /^ERROR: input_denied: "Fake" — denied by NORACU_DENY_APPS \("test\.fake"\)/.test(say(r))) && !ACTION_OPS.test(read(opsLog))
        && !ok1?.isError && !ok2?.isError && /c:100,100/.test(read(clickLog)) && /kd:shift t:z ku:shift/.test(read(clickLog)),
      [...rs, ok1, ok2].map((r) => say(r).slice(0, 80)).join(" | ") + ` | ops=${JSON.stringify(read(opsLog).trim().split("\n").join(","))} click=${JSON.stringify(read(clickLog))}`);
  } finally { s2.proc.kill(); rmSync(dir, { recursive: true, force: true }); }
}

// 0.3.0 screenshot_id（review CR1/CR2 T2，CI 安全）：截图像素 → 窗口原点 + 像素 ÷ 窗口所在屏的 scale；越界 invalid_args；
// 缓存满了只淘汰最旧的。假引擎的窗口 5 属于 Other（pid 777），bounds [400,100,400,200]；假 screencapture 写出 800×400 的 PNG 头
{
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "noracu-shot-"));
  const fake = join(dir, "fake-ax-engine");
  writeFileSync(fake, FAKE_AX, { mode: 0o700 });
  const clickLog = join(dir, "cliclick.log");
  const fakeClick = join(dir, "cliclick");
  writeFileSync(fakeClick, `#!/bin/bash\necho "$@" >> "${clickLog}"\n`, { mode: 0o700 });
  const fakeCap = join(dir, "screencapture");
  writeFileSync(fakeCap, `#!/usr/bin/env node
const b = Buffer.alloc(33); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(b, 0); b.writeUInt32BE(13, 8); b.write("IHDR", 12, "ascii");
b.writeUInt32BE(800, 16); b.writeUInt32BE(400, 20);
require("fs").writeFileSync(process.argv[process.argv.length - 1], b);
`, { mode: 0o700 });
  for (const f of [fake, fakeClick, fakeCap]) { try { execFileSync(f, f === fake ? [] : [join(dir, "warm.png")], { input: '{"op":"warm"}', timeout: 30000 }); } catch {} }
  const read = (f) => { try { return readFileSync(f, "utf8"); } catch { return ""; } };
  const say = (r) => String(r?.content?.[0]?.text);
  const metaOf = (r) => { try { return JSON.parse(r?.content?.find((c) => c.type === "text")?.text || "{}"); } catch { return {}; } };
  const s = await spawnServer({ NORACU_AX_ENGINE: fake, NORACU_CLICLICK: fakeClick, NORACU_SCREENCAPTURE: fakeCap, NORACU_AX_TIMEOUT_MS: "1500", NORACU_USER_IDLE_S: "0", NORACU_NO_BGPOST: "1" });
  try {
    const shots = [];
    for (let i = 0; i < 34; i++) shots.push(metaOf(await s.call("mac_screenshot", { window_id: 5 })));
    const m = shots[shots.length - 1];
    writeFileSync(clickLog, "");
    const c1 = await s.call("mac_click", { screenshot_id: m.screenshot_id, x: 100, y: 100 });
    const c2 = await s.call("mac_click", { screenshot_id: m.screenshot_id, x: 2000, y: 100 });
    const c3 = await s.call("mac_click", { screenshot_id: shots[2].screenshot_id, x: 10, y: 20 });
    const c4 = await s.call("mac_click", { screenshot_id: shots[0].screenshot_id, x: 10, y: 20 });
    const c5 = await s.call("mac_click", { screenshot_id: m.screenshot_id, x: 20, y: 20 });
    const c6 = await s.call("mac_click", { screenshot_id: m.screenshot_id, x: 799, y: 399, force: true });
    check("0.3.0：截图窗口被同一 app 的另一个窗口盖住 → occluded，不发；最右下的像素 799,399 → 落在窗口内 799,299（不四舍五入出界）",
      c5?.isError && /^ERROR: occluded: 410,110 is covered by another window of "Other" \(window 6\), not the screenshot's window 5/.test(say(c5)) && !/c:410,110/.test(read(clickLog))
        && !c6?.isError && /c:799,299/.test(read(clickLog)),
      `${say(c5).slice(0, 130)} | ${say(c6).slice(0, 80)} | click=${JSON.stringify(read(clickLog))}`);
    check("0.3.0（CR1/CR2 T2）：screenshot_id 点击加上窗口原点（像素 100,100 @2x → 点 450,150）；超出截图 → invalid_args 不发；scale 按窗口算；缓存满了只淘汰最旧的（第 3 张仍有效，第 1 张失效）",
      m.scale === 2 && JSON.stringify(m.logical_size) === "[400,200]" && !c1?.isError && /@ 450,150/.test(say(c1)) && /c:450,150/.test(read(clickLog))
        && c2?.isError && /^ERROR: invalid_args: 2000,100 is outside the screenshot \(800×400 pixels\)/.test(say(c2)) && !/c:1400/.test(read(clickLog))
        && !c3?.isError && /c:405,110/.test(read(clickLog)) && c4?.isError && /^ERROR: stale: screenshot_id/.test(say(c4)),
      [JSON.stringify({ scale: m.scale, ls: m.logical_size, id: m.screenshot_id }), say(c1).slice(0, 90), say(c2).slice(0, 90), say(c3).slice(0, 60), say(c4).slice(0, 60), `click=${JSON.stringify(read(clickLog))}`].join(" | "));
    // review CR1/CR2 T4/T5: the new arguments are validated; a drag whose waits exceed 10 s sends nothing
    const one = jsonOf(await s.call("mac_ax_state", { app: "Fake" })).elements?.find((e) => e.title === "One")?.i;
    const four = jsonOf(await s.call("mac_find", { app: "Fake", role: "button" })).matches?.find((e) => e.title === "Four")?.i;
    writeFileSync(clickLog, "");
    const v = [
      await s.call("mac_click", { screenshot_id: 12345, x: 1, y: 1 }),
      await s.call("mac_click", { element_index: one, screenshot_id: m.screenshot_id }),
      await s.call("mac_click", { screenshot_id: m.screenshot_id, x: 1, y: 1, app: "Other" }),
      await s.call("mac_drag", { from_index: one, to_index: four, hold_ms: 2500 }),
      await s.call("mac_drag", { from_index: one, to_index: four, step_ms: 0 }),
      await s.call("mac_drag", { from_index: one, to_index: four, hold_ms: 1.5 }),
    ];
    const long = await s.call("mac_drag", { from_index: one, to_index: four, step_ms: 500 });
    check("0.3.0（CR1/CR2 T4/T5）：screenshot_id 类型、与 element_index / app 同传、hold_ms / step_ms 越界或非整数 → 参数错误；holds + steps 超过 10 s 的拖动 → invalid_args，一个事件都不发",
      /screenshot_id must be the id string/.test(say(v[0])) && /cannot be combined with element_index/.test(say(v[1])) && /leave app out/.test(say(v[2]))
        && /hold_ms must be an integer 0-2000/.test(say(v[3])) && /step_ms must be an integer 1-500/.test(say(v[4])) && /hold_ms must be an integer 0-2000/.test(say(v[5]))
        && v.every((r) => r?.isError && /delivery=not_delivered, retry=safe/.test(say(r)))
        && long?.isError && /^ERROR: invalid_args: this drag would wait 17000 ms \(hold 0 ms \+ 34 steps of 500 ms/.test(say(long)) && read(clickLog) === "",
      [...v, long].map((r) => say(r).slice(0, 70)).join(" | ") + ` | click=${JSON.stringify(read(clickLog))}`);
  } finally { s.proc.kill(); rmSync(dir, { recursive: true, force: true }); }
}

// 0.3.0 bgpost（review CR1/CR2 T3，CI 安全）：只有确定什么都没发出（脚本在建事件前就拒绝：bad-pid）才改走真实指针，
// 结果写明 route；mechanism physical 一律走真实指针（不试 bgpost）。"Neg" 的 pid 是 -7：真 osascript 跑 bgpost 脚本，返回 bad-pid，不发任何事件
{
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "noracu-bg-"));
  const fake = join(dir, "fake-ax-engine");
  writeFileSync(fake, FAKE_AX, { mode: 0o700 });
  const clickLog = join(dir, "cliclick.log");
  const fakeClick = join(dir, "cliclick");
  writeFileSync(fakeClick, `#!/bin/bash\necho "$@" >> "${clickLog}"\n`, { mode: 0o700 });
  for (const f of [fake, fakeClick]) { try { execFileSync(f, [], { input: '{"op":"warm"}', timeout: 30000 }); } catch {} }
  const read = (f) => { try { return readFileSync(f, "utf8"); } catch { return ""; } };
  const say = (r) => String(r?.content?.[0]?.text);
  const env = { ...process.env, NORACU_AX_ENGINE: fake, NORACU_CLICLICK: fakeClick, NORACU_AX_TIMEOUT_MS: "3000", NORACU_USER_IDLE_S: "0" };
  delete env.NORACU_NO_BGPOST;
  const s = await spawnServer({ ...env, NORACU_NO_BGPOST: "" });
  try {
    const one = jsonOf(await s.call("mac_ax_state", { app: "Neg" })).elements?.find((e) => e.title === "One")?.i;
    writeFileSync(clickLog, "");
    const b1 = await s.call("mac_click", { element_index: one, count: 2 });
    const after1 = read(clickLog);
    const b2 = await s.call("mac_click", { element_index: one, count: 2, mechanism: "physical" });
    check("0.3.0（CR1/CR2 T3）：bgpost 确定没发出（bad-pid）→ 改走真实指针，route 写明；mechanism physical 直接走真实指针",
      !b1?.isError && /\(route: cliclick \(bgpost not posted\)\)/.test(say(b1)) && /^dc:6,6$/m.test(after1)
        && !b2?.isError && /\(route: cliclick\)/.test(say(b2)) && !/bgpost not posted/.test(say(b2)),
      `${say(b1).slice(-120)} | ${say(b2).slice(-80)} | click=${JSON.stringify(read(clickLog))}`);
  } finally { s.proc.kill(); rmSync(dir, { recursive: true, force: true }); }
}

// B6（0.2.0 #9）：协议与生命周期 —— 每项各起独立 server（CI 安全）
{
  const raw = (proc) => { let b = ""; const lines = []; proc.stdout.on("data", (d) => { b += d; let nl; while ((nl = b.indexOf("\n")) !== -1) { lines.push(b.slice(0, nl)); b = b.slice(nl + 1); } }); return lines; };
  const waitFor = async (pred, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await sleepMs(50); } return pred(); };
  const exited = (proc) => new Promise((r) => { if (proc.exitCode !== null || proc.signalCode !== null) return r(true); proc.once("exit", () => r(true)); });
  // malformed line → -32700, batch → -32600 (both id null), and the server keeps answering
  {
    const s = await spawnServer();
    const lines = raw(s.proc);
    try {
      s.proc.stdin.write("{not json\n");
      s.proc.stdin.write(JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }]) + "\n");
      const got = await waitFor(() => lines.length >= 2, 5000);
      const msgs = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } });
      const pong = await s.rpc("ping");
      check("B6：坏 JSON → -32700、批量 → -32600（id null），之后照常应答",
        got && msgs[0]?.error?.code === -32700 && msgs[0]?.id === null && msgs[1]?.error?.code === -32600 && pong?.result !== undefined, JSON.stringify(msgs).slice(0, 120));
    } finally { s.proc.kill(); }
  }
  // one message is one line, whatever its text holds: JSON leaves U+2028 and U+2029 as they are inside a string (a
  // reader that ends lines there cut such a call in two and never answered it); a line may come in pieces, cut inside
  // a character, and may end in \r\n
  {
    const s = await spawnServer();
    try {
      const sep = await Promise.race([Promise.all([s.call("no_such_tool", { t: "a\u2028b" }), s.call("no_such_tool", { t: "a\u2029b" })]), sleepMs(4000).then(() => null)]);
      const lines = raw(s.proc);
      const msg = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 9001, method: "tools/call", params: { name: "no_such_tool", arguments: { t: "\u00e9" } } }), "utf8");
      const cut = msg.indexOf(0xc3) + 1;   // between the two bytes of the "é"
      s.proc.stdin.write(msg.subarray(0, cut));
      await sleepMs(150);
      s.proc.stdin.write(Buffer.concat([msg.subarray(cut), Buffer.from("\r\n")]));
      const whole = await waitFor(() => lines.some((l) => l.includes('"id":9001')), 4000);
      const parsed = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } });
      check("协议：参数文本里的 U+2028 / U+2029 不把一条消息切成两行；一行分两段到（断在多字节字符中间）、以 CRLF 结尾都算一条",
        Array.isArray(sep) && sep.every((r) => r?.isError && /^unknown tool: no_such_tool/.test(String(r?.content?.[0]?.text ?? "")))
          && whole && cut > 0 && !parsed.some((m) => m?.error?.code === -32700),
        `${JSON.stringify(sep).slice(0, 120)} | ${JSON.stringify(parsed).slice(0, 120)}`);
    } finally { s.proc.kill(); }
  }
  // the client closes stdin → the server exits by itself (does not linger)
  {
    const s = await spawnServer();
    await s.rpc("ping");
    const t0 = Date.now();
    s.proc.stdin.end();
    const done = await Promise.race([exited(s.proc), sleepMs(5000).then(() => false)]);
    check("B6：客户端关闭 stdin → server 自行退出（≤ 3 s）", done === true && Date.now() - t0 < 4500, `exit=${s.proc.exitCode} after ${Date.now() - t0} ms`);
    if (!done) s.proc.kill("SIGKILL");
  }
  // SIGTERM → exit within the shutdown budget
  {
    const s = await spawnServer();
    await s.rpc("ping");
    const t0 = Date.now();
    s.proc.kill("SIGTERM");
    const done = await Promise.race([exited(s.proc), sleepMs(5000).then(() => false)]);
    check("B6：SIGTERM → 有序退出（≤ 3 s）", done === true && Date.now() - t0 < 4500, `code=${s.proc.exitCode} signal=${s.proc.signalCode} after ${Date.now() - t0} ms`);
    if (!done) s.proc.kill("SIGKILL");
  }
  // SIGTERM with a browser open: the browser is closed (profile unlocked) and the server exits in time
  {
    const { homedir } = await import("node:os");
    const { readlinkSync } = await import("node:fs");
    const lock = new URL(`file://${homedir()}/.noracu/browser-profile/SingletonLock`).pathname;
    // a lock left by a browser that is gone (a crash, another noracu killed) is not this test's: only a lock that
    // was not there before the launch, or now names another process, counts (2026-11-14: a stale lock from 05:20)
    const lockTarget = () => { try { return readlinkSync(lock); } catch { return null; } };
    const before = lockTarget();
    const s = await spawnServer();
    const bl = await s.call("browser_launch", { headless: true });
    const t0 = Date.now();
    s.proc.kill("SIGTERM");
    const done = await Promise.race([exited(s.proc), sleepMs(6000).then(() => false)]);
    const after = lockTarget();
    const locked = after !== null && after !== before;
    check("B6：开着浏览器收到 SIGTERM → 关闭浏览器（profile 解锁）并在 3 s 内退出",
      /browser_id/.test(String(bl?.content?.[0]?.text)) && done === true && Date.now() - t0 < 4000 && !locked, `exit after ${Date.now() - t0} ms, lock=${locked}${before ? ` (a lock was there before: ${before})` : ""}, launch=${String(bl?.content?.[0]?.text).slice(0, 40)}`);
    if (!done) s.proc.kill("SIGKILL");
  }
  // an observation waits for the input queued before it, and ping is answered while that input runs
  {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "noracu-e2e-"));
    const log = join(dir, "order.log");
    const fake = join(dir, "fake-ax-engine");
    writeFileSync(fake, `#!/usr/bin/env node
const fs = require("fs");
let d = ""; process.stdin.on("data", (c) => (d += c)); process.stdin.on("end", () => {
  const req = JSON.parse(d); const say = (o) => process.stdout.write(JSON.stringify(o));
  const node = { d: 1, role: "AXButton", path: [0], fp: { role: "AXButton", subrole: "", id: "", name: "Go" }, title: "Go", frame: [0, 0, 10, 10], interactive: true };
  const base = { ok: true, app: "Fake", bundle_id: "test.fake", pid: 4242, surface: "window", complete: true, visited: 1, ms: 1, container: { kind: "window", wid: 1, title: "W", subrole: "", frame: [0, 0, 100, 100], n: 0 } };
  const note = (x) => fs.appendFileSync(${JSON.stringify(log)}, x + "\\n");
  if (req.op === "snapshot") { note("snapshot"); return say({ ...base, nodes: [node] }); }
  // 0.3.0: every input first asks which app receives it (the approval check)
  if (req.op === "frontmost") return say({ ok: true, front: { pid: 4242, name: "Fake", bundle: "test.fake" }, target: { pid: 4242, name: "Fake", bundle: "test.fake" }, match: true });
  if (req.op === "find") { const quick = req.text === "quick"; setTimeout(() => { note("find"); say({ ...base, nodes: [{ ...node, fp: { ...node.fp, name: "Fast" }, title: "Fast" }] }); }, quick ? 0 : 2500); return; }
  if (req.op === "act") { const fast = req.target.fp.name === "Fast"; setTimeout(() => { note(fast ? "act-fast" : "act"); say({ ok: true, delivery: "delivered_verified", retry: "unsafe", changed: ["value"], surfaces: [], mechanism: "semantic", action: "AXPress", how: "path", role: "AXButton", title: req.target.fp.name }); }, fast ? 0 : 1200); return; }
  say({ ok: false, code: "INVALID_ARGS", message: "fake: " + req.op });
});
`, { mode: 0o700 });
    const s = await spawnServer({ NORACU_AX_ENGINE: fake });
    try {
      const a = jsonOf(await s.call("mac_ax_state", { app: "Fake" }));
      const idx = a.elements?.[0]?.i;
      const order = () => { try { return readFileSync(log, "utf8").trim().split("\n"); } catch { return []; } };
      writeFileSync(log, "");
      const click = s.call("mac_click", { element_index: idx });
      await sleepMs(100);
      const t0 = Date.now();
      const pong = await s.rpc("ping");
      const pingMs = Date.now() - t0;
      const snap = await s.call("mac_ax_state", { app: "Fake" });
      await click;
      check("B6：慢输入进行中 ping 立即应答；随后的观察排在它之后（不读到点击前状态）",
        pong?.result !== undefined && pingMs < 500 && !snap?.isError && order().join(",") === "act,snapshot", `ping ${pingMs} ms, order ${order().join(",")}`);
      // a slow observation does not hold up an input that comes after it
      const fastIdx = jsonOf(await s.call("mac_find", { app: "Fake", text: "quick" })).matches?.[0]?.i;
      writeFileSync(log, "");
      const slowFind = s.call("mac_find", { app: "Fake", text: "slow" });
      await sleepMs(100);
      const c2 = await s.call("mac_click", { element_index: fastIdx });
      await slowFind;
      check("B6：慢观察不阻塞其后的输入（观察不进输入队列）", Number.isInteger(fastIdx) && !c2?.isError && order().join(",") === "act-fast,find", `idx ${fastIdx} order ${order().join(",")} ${String(c2?.content?.[0]?.text).slice(0, 60)}`);
    } finally { s.proc.kill(); rmSync(dir, { recursive: true, force: true }); }
  }
}

// 7. browser_launch + navigate + snapshot + read（Browser 层）
const bl = await call("browser_launch", { headless: true });
check("browser_launch", bl?.content?.[0]?.text?.includes("browser_id"), bl?.content?.[0]?.text?.slice(0, 50));
{
  // pre-review P7: the blank tab browser_launch started with may be the active page — it takes over again when
  // the active tab is closed (a blank tab that a page opened may not; see 7a)
  const T = (r) => String(r?.content?.[0]?.text);
  // pre-review P12: the first tab is not judged from inside — noracu sends it to about:blank itself at launch
  const r0 = await call("browser_read");
  check("the session's first tab, sent to about:blank by noracu at launch, is the blank page the session was opened on: it is read", !r0?.isError, T(r0).slice(0, 80));
  const t0 = JSON.parse(T(await call("browser_tabs"))).tabs;
  const n0 = await call("browser_tabs", { action: "new", url: "https://example.com" });
  const own0 = JSON.parse(T(await call("browser_tabs"))).tabs.find((t) => t.opened_by_browser_tabs);
  const c0 = await call("browser_tabs", { action: "close", tab_id: own0?.tab_id });
  check("browser_tabs: the blank tab the browser started with takes over when the active tab is closed",
    t0.length === 1 && t0[0].url === "about:blank" && !n0?.isError && !c0?.isError && T(c0).includes(`the active page is tab ${t0[0].tab_id} (about:blank)`), T(c0).slice(0, 110));
}
const bn = await call("browser_navigate", { url: "https://example.com" });
check("browser_navigate", bn?.content?.[0]?.text?.includes("example.com") && /HTTP \d+/.test(String(bn?.content?.[0]?.text)) && /delivery=/.test(String(bn?.content?.[0]?.text)), bn?.content?.[0]?.text?.slice(0, 80));
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
  check("browser_click element_index", bc2?.content?.[0]?.text?.includes("clicked element_index") && /delivery=/.test(String(bc2?.content?.[0]?.text)), bc2?.content?.[0]?.text?.slice(0, 80));
}
const badIdx2 = await call("browser_click", { element_index: 99999 });
check("browser 无效索引/导航后报错", badIdx2?.isError && (String(badIdx2?.content?.[0]?.text).includes("invalid_element_index") || String(badIdx2?.content?.[0]?.text).includes("element_no_longer_valid")), badIdx2?.content?.[0]?.text?.slice(0, 70));
// 7a. browser_tabs (0.3.0): list / new / select / close; a tab the page opens is listed, not followed, not closed
{
  const T = (r) => String(r?.content?.[0]?.text);
  const tabs = async () => JSON.parse(T(await call("browser_tabs"))).tabs;
  const waitTab = async (pred) => { for (let i = 0; i < 40; i++) { const t = (await tabs()).find(pred); if (t) return t; await new Promise((r) => setTimeout(r, 250)); } return null; };
  const t1 = await tabs();
  const first = t1[0];
  check("browser_tabs list: one tab, active, not opened by browser_tabs", t1.length === 1 && first.active === true && first.opened_by_browser_tabs === false && /^t\d+$/.test(first.tab_id), JSON.stringify(t1).slice(0, 160));
  const tn = await call("browser_tabs", { action: "new", url: "https://example.com" });
  const t2 = await tabs();
  const mine = t2.find((t) => t.opened_by_browser_tabs);
  check("browser_tabs new: the tab opens, loads the url and is the active page", !tn?.isError && /^opened tab t\d+: https:\/\/example\.com/.test(T(tn)) && T(tn).includes("delivery=delivered_verified") && t2.length === 2 && mine?.active === true && t2.find((t) => t.tab_id === first.tab_id)?.active === false, T(tn).slice(0, 120));
  await call("browser_snapshot");
  const tsel = await call("browser_tabs", { action: "select", tab_id: first.tab_id });
  const stale = await call("browser_click", { element_index: 0 });
  check("browser_tabs select: the first tab is the active page again; an element_index from before no longer applies", !tsel?.isError && T(tsel).includes(`tab ${first.tab_id} is the active page now`) && stale?.isError && T(stale).includes("element_no_longer_valid"), `${T(tsel).slice(0, 70)} | ${T(stale).slice(0, 70)}`);
  await call("browser_evaluate", { js: "window.open('about:blank'); 1" });
  const t3 = await tabs();
  const popup = t3.find((t) => t.tab_id !== first.tab_id && t.tab_id !== mine?.tab_id);
  const notOwned = popup ? await call("browser_tabs", { action: "close", tab_id: popup.tab_id }) : null;
  check("a tab the page opened: listed, not followed, not closed (tab_not_owned)", t3.length === 3 && t3.find((t) => t.active)?.tab_id === first.tab_id && popup?.opened_by_browser_tabs === false && notOwned?.isError === true && T(notOwned).includes("tab_not_owned") && T(notOwned).includes("delivery=not_delivered"), T(notOwned).slice(0, 120));
  const tclose = await call("browser_tabs", { action: "close", tab_id: mine?.tab_id });
  const t4 = await tabs();
  check("browser_tabs close: a tab it opened is closed; the active page stays", !tclose?.isError && T(tclose).includes(`closed tab ${mine?.tab_id}`) && t4.length === 2 && t4.find((t) => t.active)?.tab_id === first.tab_id, T(tclose).slice(0, 120));
  // pre-review P6 — the active tab is the one closed: the first open tab takes its place and the result names it
  await call("browser_tabs", { action: "new" });
  const own2 = (await tabs()).find((t) => t.opened_by_browser_tabs);
  await call("browser_snapshot");
  const cl2 = await call("browser_tabs", { action: "close", tab_id: own2?.tab_id });
  const stale2 = await call("browser_click", { element_index: 0 });
  check("browser_tabs close on the active tab: the first open tab is the active page, the result says so, and an element_index read on the closed tab is refused",
    own2?.active === true && !cl2?.isError && T(cl2).includes(`the active page is tab ${first.tab_id} (`) && (await tabs()).find((t) => t.active)?.tab_id === first.tab_id && stale2?.isError === true && T(stale2).includes("element_no_longer_valid"), `${T(cl2).slice(0, 110)} | ${T(stale2).slice(0, 50)}`);
  // the active page closes itself (a tab the page opened may), then another tab is closed: the active page is
  // the first open tab — never "none" while a tab is open
  // (pre-review P7) a blank tab that the page opened shares that page's origin and can read it: listed, never
  // selected. A web page the page opened can be selected — and, opened by a script, it can close itself
  const selBlank = await call("browser_tabs", { action: "select", tab_id: popup?.tab_id });
  check("browser_tabs select: a blank tab that the page opened is not made the active page (tab_not_selectable)",
    popup?.url === "about:blank" && selBlank?.isError === true && T(selBlank).includes("tab_not_selectable") && T(selBlank).includes("delivery=not_delivered") && (await tabs()).find((t) => t.active)?.tab_id === first.tab_id, T(selBlank).slice(0, 130));
  await call("browser_evaluate", { js: "window.open(location.href); 1" });
  const twin = await waitTab((t) => t.tab_id !== first.tab_id && t.tab_id !== popup?.tab_id && !t.opened_by_browser_tabs && /^https?:/.test(String(t.url)));
  await call("browser_tabs", { action: "new" });
  const own3 = (await tabs()).find((t) => t.opened_by_browser_tabs);
  const selPopup = await call("browser_tabs", { action: "select", tab_id: twin?.tab_id });
  await call("browser_snapshot");
  await call("browser_evaluate", { js: "window.close(); 1" });
  await new Promise((r) => setTimeout(r, 500));
  const cl3 = await call("browser_tabs", { action: "close", tab_id: own3?.tab_id });
  const left = await tabs();
  const stale3 = await call("browser_click", { element_index: 0 });
  check("the active page closed itself and another tab is closed after it: the result names the first open tab as the active page, and an element_index read on the tab that is gone is refused",
    Boolean(twin) && !selPopup?.isError && !cl3?.isError && T(cl3).includes(`the active page is tab ${first.tab_id} (`) && left.length === 2 && !left.some((t) => t.tab_id === twin?.tab_id) && left.find((t) => t.active)?.tab_id === first.tab_id && stale3?.isError === true && T(stale3).includes("element_no_longer_valid"), `${T(cl3).slice(0, 110)} | ${JSON.stringify(left).slice(0, 90)}`);
  // select takes only a tab on an http(s) page or about:blank: a blob: tab the page opened is listed, not read
  await call("browser_evaluate", { js: "window.open(URL.createObjectURL(new Blob(['<title>b</title><p>blob</p>'], { type: 'text/html' }))); 1" });
  const blob = await waitTab((t) => String(t.url).startsWith("blob:"));
  const selBlob = blob ? await call("browser_tabs", { action: "select", tab_id: blob.tab_id }) : null;
  check("browser_tabs select: a tab that shows neither an http(s) page nor about:blank is listed and not made the active page (tab_not_selectable)",
    Boolean(blob) && selBlob?.isError === true && T(selBlob).includes("tab_not_selectable") && T(selBlob).includes("delivery=not_delivered") && (await tabs()).find((t) => t.active)?.tab_id === first.tab_id, T(selBlob).slice(0, 130));
  // list: a page that does not answer has title null — not the empty title of a page that has none
  await call("browser_tabs", { action: "new" });
  const own4 = (await tabs()).find((t) => t.opened_by_browser_tabs);
  await call("browser_evaluate", { js: "setTimeout(() => { for (;;) {} }, 50); 1" });
  await new Promise((r) => setTimeout(r, 400));
  const withHung = await tabs();
  const cl4 = await call("browser_tabs", { action: "close", tab_id: own4?.tab_id });
  check("browser_tabs list: a tab whose page does not answer has title null, the others keep theirs, and it can still be closed",
    withHung.find((t) => t.tab_id === own4?.tab_id)?.title === null && typeof withHung.find((t) => t.tab_id === first.tab_id)?.title === "string" && !cl4?.isError && T(cl4).includes(`closed tab ${own4?.tab_id}`) && T(cl4).includes(`the active page is tab ${first.tab_id} (`), `${JSON.stringify(withHung).slice(0, 150)} | ${T(cl4).slice(0, 80)}`);
  // pre-review P7 — the tab that takes over when the active tab goes is never one select would refuse. With the
  // first tab on a blob: page (beside the blank popup and the blob popup), closing the active tab leaves no
  // active page: the page tools say so and read nothing, and browser_tabs still lists, refuses, and opens a tab
  await call("browser_evaluate", { js: "location.href = URL.createObjectURL(new Blob(['<title>t1b</title><p>FIRST-TAB-BLOB</p>'], { type: 'text/html' })); 1" });
  const firstBlob = await waitTab((t) => t.tab_id === first.tab_id && String(t.url).startsWith("blob:"));
  await call("browser_tabs", { action: "new" });
  const own5 = (await tabs()).find((t) => t.opened_by_browser_tabs);
  const cl5 = await call("browser_tabs", { action: "close", tab_id: own5?.tab_id });
  const read5 = await call("browser_read");
  const snap5 = await call("browser_snapshot");
  const list5 = await tabs();
  const sel5 = await call("browser_tabs", { action: "select", tab_id: first.tab_id });
  check("the active tab is closed and every tab left is one select would refuse: there is no active page — the result says none, browser_read and browser_snapshot return no_active_page and none of the page, the tabs are still listed and still not selectable",
    Boolean(firstBlob) && own5?.active === true && !cl5?.isError && T(cl5).includes("the active page is none") && read5?.isError === true && T(read5).includes("no_active_page") && !T(read5).includes("FIRST-TAB-BLOB")
    && snap5?.isError === true && T(snap5).includes("no_active_page") && list5.length === 3 && list5.every((t) => t.active === false) && sel5?.isError === true && T(sel5).includes("tab_not_selectable"), `${T(cl5).slice(0, 80)} | ${T(read5).slice(0, 80)} | ${JSON.stringify(list5.map((t) => [t.tab_id, String(t.url).slice(0, 12), t.active]))}`);
  const new5 = await call("browser_tabs", { action: "new", url: "https://example.com" });
  const read6 = await call("browser_read");
  check("… and browser_tabs new gives the session an active page again", !new5?.isError && T(new5).includes("it is the active page now") && !read6?.isError && T(read6).toLowerCase().includes("example"), `${T(new5).slice(0, 80)} | ${T(read6).slice(0, 40)}`);
  // pre-review P8 — what a tab must show to become the active page it must show to be read: the active tab takes
  // itself to a blob it made (a page can; a local file or chrome:// it cannot reach — measured). It stays the
  // active page, every page tool but browser_navigate refuses with nothing read and nothing sent (the blob page
  // would leave for another address on any input), and browser_navigate takes the tab back to a page
  await call("browser_snapshot");
  await call("browser_evaluate", { js: "location.href = URL.createObjectURL(new Blob(['<title>quiet</title><p>ACTIVE-TAB-BLOB</p><script>for (const e of [`click`, `keydown`, `wheel`, `mousemove`]) addEventListener(e, () => { location.href = `https://example.com/?GOT-INPUT`; });</script>'], { type: 'text/html' })); 1" });
  const own6 = await waitTab((t) => t.active && String(t.url).startsWith("blob:"));
  const refused = [await call("browser_read"), await call("browser_snapshot"), await call("browser_screenshot"), await call("browser_click", { xy: [20, 20] }), await call("browser_click", { element_index: 0 }), await call("browser_evaluate", { js: "document.body.innerText" }),
    await call("browser_type", { text: "x" }), await call("browser_press_key", { key: "Tab" }), await call("browser_fill", { selector: "input", value: "x" }), await call("browser_scroll", {})];
  const after6 = (await tabs()).find((t) => t.active);
  check("the active tab took itself to a blob: it stays the active page and every page tool but browser_navigate returns active_page_not_allowed — nothing of the page read, nothing sent to it",
    Boolean(own6) && refused.every((r) => r?.isError === true && T(r).startsWith(`ERROR: active_page_not_allowed: the active tab ${own6?.tab_id} shows blob:`) && T(r).endsWith("(delivery=not_delivered, retry=safe)") && !T(r).includes("ACTIVE-TAB-BLOB")) && after6?.tab_id === own6?.tab_id && String(after6?.url).startsWith("blob:") && after6?.title === null && after6?.not_read === true,
    `${T(refused[0]).slice(0, 150)} | ${refused.map((r) => (r?.isError ? "E" : "ok")).join("")} | ${JSON.stringify(after6).slice(0, 100)}`);
  const nav6 = await call("browser_navigate", { url: "https://example.com" });
  const read7 = await call("browser_read");
  check("… and browser_navigate takes that tab to an http(s) page, where the page tools work again", !nav6?.isError && T(nav6).includes("navigated: https://example.com") && !read7?.isError && T(read7).toLowerCase().includes("example"), `${T(nav6).slice(0, 80)} | ${T(read7).slice(0, 40)}`);
  // … the same after a load that fails (a port nothing listens on): Chromium's own page for that is not a page
  // the tools read — the result says a load failed — and browser_navigate still works on the tab
  const deadPort = await new Promise((r) => { import("node:net").then(({ createServer }) => { const sv = createServer(); sv.listen(0, "127.0.0.1", () => { const p = sv.address().port; sv.close(() => r(p)); }); }); });
  const navDead = await call("browser_navigate", { url: `http://127.0.0.1:${deadPort}/` });
  const snapDead = await call("browser_snapshot");   // with no pause: see the check after this one
  // the tab's address turns to chrome-error:// a moment after the navigation is reported as failed (measured:
  // up to ~30 ms, during which the tab is still listed at its old address): wait for it, then read
  const errTab = await waitTab((t) => t.active && String(t.url).startsWith("chrome-error:"));
  const readDead = await call("browser_read");
  const navBack = await call("browser_navigate", { url: "https://example.com" });
  check("a load that failed: browser_navigate says navigate_failed, the page tools return active_page_not_allowed and name a load that failed, and browser_navigate works on the tab again",
    navDead?.isError === true && T(navDead).includes("navigate_failed") && Boolean(errTab) && readDead?.isError === true && T(readDead).startsWith(`ERROR: active_page_not_allowed: the active tab ${own6?.tab_id} shows chrome-error://chromewebdata/ (a load that failed) — `) && T(readDead).endsWith("(delivery=not_delivered, retry=safe)") && !navBack?.isError && T(navBack).includes("navigated: https://example.com"),
    `${T(navDead).slice(0, 70)} | ${T(readDead).slice(0, 110)} | ${T(navBack).slice(0, 40)}`);
  // pre-review P10 — in the moment after the failed load the tab's address still reads as the old one, and a
  // snapshot or a screenshot taken then would be of the page that is arriving (measured: the check at the start
  // of the call passed 60 times out of 60). Each is asked for with no pause, and neither is handed over
  const navDead2 = await call("browser_navigate", { url: `http://127.0.0.1:${deadPort}/` });
  const shotDead = await call("browser_screenshot");
  await waitTab((t) => t.active && String(t.url).startsWith("chrome-error:"));
  const navBack2 = await call("browser_navigate", { url: "https://example.com" });
  check("right after a load that failed, with no pause: browser_snapshot and browser_screenshot are not answered from the page that is arriving",
    snapDead?.isError === true && !T(snapDead).includes("[clickable elements") && navDead2?.isError === true && shotDead?.isError === true && shotDead?.content?.[0]?.type === "text" && !navBack2?.isError && T(navBack2).includes("navigated: https://example.com"),
    `${T(snapDead).slice(0, 120)} | ${T(shotDead).slice(0, 120)}`);
  // pre-review P8 — the active tab closes itself and the very next call is a click by element_index (no
  // browser_tabs call in between): the index is refused, and the tab that took over — the same page, the same
  // element in the same place — is not clicked
  await call("browser_evaluate", { js: "window.open(location.href); 1" });
  const twin2 = await waitTab((t) => t.tab_id !== own6?.tab_id && t.tab_id !== first.tab_id && !t.opened_by_browser_tabs && /^https?:/.test(String(t.url)));
  const sel7 = await call("browser_tabs", { action: "select", tab_id: twin2?.tab_id });
  // the twin's address is set the moment window.open returns, before its page has loaded: snapshot until the link
  // is there (seen twice on 2026-11-14 — a snapshot of the half-loaded twin had no link, and the check failed on that)
  let link7 = null;
  for (let i = 0; i < 20 && !link7; i++) { link7 = T(await call("browser_snapshot")).match(/\[(\d+)\] a "/); if (!link7) await new Promise((r) => setTimeout(r, 250)); }
  await call("browser_evaluate", { js: "window.close(); 1" });
  await new Promise((r) => setTimeout(r, 800));
  const stale7 = await call("browser_click", { element_index: link7 ? parseInt(link7[1]) : 0 });
  await new Promise((r) => setTimeout(r, 500));
  const now7 = await tabs();
  check("the active tab closed itself and the next call is browser_click with an element_index read on it: refused (element_no_longer_valid), and the tab that took over — on the same page — was not clicked",
    Boolean(twin2) && !sel7?.isError && Boolean(link7) && stale7?.isError === true && T(stale7).includes("element_no_longer_valid") && T(stale7).includes("delivery=not_delivered") && !now7.some((t) => t.tab_id === twin2?.tab_id)
    && now7.find((t) => t.active)?.tab_id === own6?.tab_id && /^https:\/\/example\.com\/?$/.test(String(now7.find((t) => t.active)?.url)), `${T(stale7).slice(0, 110)} | ${JSON.stringify(now7.map((t) => [t.tab_id, String(t.url).slice(0, 24), t.active]))}`);
  // pre-review P10 — what a read returns is handed over only if the active page still passes when the read is
  // done: the page goes to a blob it made half a second after a read that waits for a selector has started, and
  // the selector exists only on the blob — the read is answered by the blob page and must not be returned
  await call("browser_evaluate", { js: "setTimeout(() => { location.href = URL.createObjectURL(new Blob(['<title>late</title><p id=late>LATE-BLOB-TEXT</p>'], { type: 'text/html' })); }, 500); 1" });
  const late10 = await call("browser_read", { selector: "#late" });
  const nav10 = await call("browser_navigate", { url: "https://example.com" });
  check("a read that was answered by a page the tools refuse (the tab changed while it waited for a selector) is not handed over: active_page_not_allowed, none of that page's text",
    late10?.isError === true && T(late10).startsWith(`ERROR: active_page_not_allowed: the active tab ${own6?.tab_id} shows blob:`) && T(late10).includes("it changed while the page was being read, and what came back is not handed over") && !T(late10).includes("LATE-BLOB-TEXT") && !nav10?.isError,
    `${T(late10).slice(0, 200)} | ${T(nav10).slice(0, 40)}`);
  // pre-review P11 — the second look also asks where the tab has been, not only what it shows at the end: while a
  // read waits for a selector the page goes to a blob and from there back to an http page that has the element.
  // The tab ends on a page the tools read, and which page answered is not known — the read is not handed over
  await call("browser_evaluate", { js: "document.querySelectorAll('a').forEach((x) => x.remove()); setTimeout(() => { location.href = URL.createObjectURL(new Blob(['<title>via</title><script>setTimeout(() => { location.href = `https://example.com/`; }, 60);</script>'], { type: 'text/html' })); }, 400); 1" });
  const via11 = await call("browser_read", { selector: "a" });
  const back11 = await waitTab((t) => t.active && /^https:\/\/example\.com\/?$/.test(String(t.url)));
  const read11 = await call("browser_read", { selector: "a" });
  check("the tab went through a page the tools refuse and came back while a read waited: the read is not handed over (active_page_not_allowed), and the same read asked again is answered",
    via11?.isError === true && T(via11).startsWith(`ERROR: active_page_not_allowed: the active tab ${own6?.tab_id} went through a page the tools do not read while the page was being read`) && T(via11).endsWith("(delivery=not_delivered, retry=safe)") && !T(via11).includes("Learn more") && Boolean(back11) && !read11?.isError && T(read11).includes("Learn more"),
    `${T(via11).slice(0, 220)} | ${T(read11).slice(0, 30)}`);
  // … and what a script returns or throws, and a read without a selector, are held to the same second look. On a
  // tab still on its first blank page, a fragment put on the address ends its standing without ending the page
  const fresh = async () => { await call("browser_tabs", { action: "new" }); return (await tabs()).find((t) => t.active); };
  const fa = await fresh();
  const ev11 = await call("browser_evaluate", { js: "location.hash = 'x'; 'HASH-RESULT'" });
  const fb = await fresh();
  const th11 = await call("browser_evaluate", { js: "location.hash = 'y'; throw new Error('THROWN-PAYLOAD')" });
  const fc = await fresh();
  await call("browser_evaluate", { js: "Object.defineProperty(document.body, 'innerText', { get() { location.hash = 'z'; return 'GETTER-PAYLOAD'; } }); 1" });
  const rd11 = await call("browser_read");
  const closed11 = [await call("browser_tabs", { action: "close", tab_id: fc?.tab_id }), await call("browser_tabs", { action: "close", tab_id: fb?.tab_id }), await call("browser_tabs", { action: "close", tab_id: fa?.tab_id })];
  check("the page stopped passing while a script ran, while a script threw, and while browser_read read it: none of the three is handed over — not the result, not the thrown text, not the page text",
    [ev11, th11, rd11].every((r) => r?.isError === true && T(r).includes("active_page_not_allowed") && T(r).includes("is not handed over")) && !T(ev11).includes("HASH-RESULT") && T(ev11).includes("while the script ran") && T(ev11).endsWith("(delivery=delivered_unverified, retry=unsafe)")
    && !T(th11).includes("THROWN-PAYLOAD") && T(th11).endsWith("(delivery=unknown, retry=unsafe)") && !T(rd11).includes("GETTER-PAYLOAD") && T(rd11).endsWith("(delivery=not_delivered, retry=safe)") && closed11.every((r) => !r?.isError) && (await tabs()).find((t) => t.active)?.tab_id === own6?.tab_id,
    `${T(ev11).slice(0, 150)} | ${T(th11).slice(0, 150)} | ${T(rd11).slice(0, 150)}`);
  // pre-reviews P12, P13 — a snapshot's tree, element list and address are read one after the other. When the page
  // navigates in between — here it puts a fragment on its address, then calls history.pushState, while its
  // elements are being listed — the parts may be of two pages, and nothing is returned
  await call("browser_evaluate", { js: "(() => { const a = document.querySelector('a'); a.getAttribute = function (n) { const go = window.__go; window.__go = null; if (go) go(); return Element.prototype.getAttribute.call(this, n); }; })(); window.__go = () => { location.hash = 'frag'; }; 1" });
  const frag12 = await call("browser_snapshot");
  await call("browser_evaluate", { js: "window.__go = () => { history.pushState({}, '', '/moved'); }; 1" });
  const moved12 = await call("browser_snapshot");
  const stale12 = await call("browser_click", { element_index: 0 });
  // … and when listing the elements is cut short by a move to another document — Playwright's error for that,
  // thrown here by the page's hook — the snapshot says page_changed, not "elements unavailable" (pre-review P14)
  await call("browser_evaluate", { js: "window.__go = () => { throw new Error('Execution context was destroyed, most likely because of a navigation'); }; 1" });
  const gone14 = await call("browser_snapshot");
  const again12 = await call("browser_snapshot");
  // pre-review P15 — a snapshot whose element list could not be read (here the page's hook throws) says so, and
  // leaves no list from the snapshot before it to click by
  await call("browser_evaluate", { js: "window.__go = () => { throw new Error('WALK-FAILED-15'); }; 1" });
  const walk15 = await call("browser_snapshot");
  const staleWalk15 = await call("browser_click", { element_index: 0 });
  check("browser_snapshot whose element list could not be read: the tree with 'clickable elements unavailable', and an element_index from the snapshot before it is refused (no fresh snapshot)",
    !again12?.isError && /\[0\] /.test(T(again12)) && !walk15?.isError && T(walk15).includes("[clickable elements unavailable: ") && staleWalk15?.isError === true && T(staleWalk15).includes("element_no_longer_valid: no fresh snapshot"),
    `${T(walk15).slice(-150)} | ${T(staleWalk15).slice(0, 80)}`);
  // … a read that waits for a selector is handed over — going on across the page's own move is what "click, then
  // read" relies on — under a first line that says the page navigated and gives both addresses; a read of the
  // whole page is not (here the page calls history.replaceState as its text is read)
  await call("browser_evaluate", { js: "setTimeout(() => { history.pushState({}, '', '/later'); const p = document.createElement('p'); p.id = 'late12'; p.textContent = 'LATE12-TEXT'; document.body.appendChild(p); }, 600); 1" });
  const movedRead12 = await call("browser_read", { selector: "#late12" });
  const plainRead12 = await call("browser_read", { selector: "#late12" });
  await call("browser_evaluate", { js: "setTimeout(() => { history.pushState({}, '', '/mid14'); const p = document.createElement('p'); p.id = 'late14'; p.textContent = 'LATE14-TEXT'; document.body.appendChild(p); history.pushState({}, '', '/end14'); }, 600); 1" });
  const twiceRead14 = await call("browser_read", { selector: "#late14" });
  await call("browser_evaluate", { js: "Object.defineProperty(document.body, 'innerText', { configurable: true, get() { delete document.body.innerText; history.replaceState({}, '', '/later2'); return 'WHOLE13-TEXT'; } }); 1" });
  const whole13 = await call("browser_read");
  const wholeAgain13 = await call("browser_read");
  // pre-review P14 — a read of the whole page that ends in an error because the page navigated says page_changed
  // as well: by the count (the page calls history.replaceState, then throws), and by Playwright's message for a
  // read that a move to another document cut short — thrown here by the page; measured: such a read is rejected
  // before the navigation is reported. An error with no navigation behind it is handed over as it is
  const getter14 = (body) => `Object.defineProperty(document.body, 'innerText', { configurable: true, get() { delete document.body.innerText; ${body} } }); 1`;
  await call("browser_evaluate", { js: getter14("history.replaceState({}, '', '/thrown14'); throw new Error('GETTER-THROWN-14');") });
  const thrownNav14 = await call("browser_read");
  await call("browser_evaluate", { js: getter14("throw new Error('Execution context was destroyed, most likely because of a navigation');") });
  const thrownGone14 = await call("browser_read");
  await call("browser_evaluate", { js: getter14("throw new Error('PLAIN-THROWN-14');") });
  const thrownPlain14 = await call("browser_read");
  check("browser_read of the whole page that ends in an error: page_changed when the page navigated (seen in the count, or told by Playwright's 'execution context was destroyed'), and none of what the page threw; an error with no navigation is handed over",
    thrownNav14?.isError === true && T(thrownNav14) === "ERROR: page_changed: the page navigated while it was being read (it shows https://example.com/thrown14 now), so the read was not finished — call browser_read again (delivery=not_delivered, retry=safe)"
    && thrownGone14?.isError === true && T(thrownGone14) === "ERROR: page_changed: the page navigated while it was being read, so the read was not finished — call browser_read again (delivery=not_delivered, retry=safe)"
    && thrownPlain14?.isError === true && T(thrownPlain14).includes("PLAIN-THROWN-14") && !T(thrownPlain14).includes("page_changed"),
    `${T(thrownNav14).slice(0, 120)} | ${T(thrownGone14).slice(0, 90)} | ${T(thrownPlain14).slice(0, 90)}`);
  // pre-review P15 — a script's result and a screenshot name no page: they are handed over when the page navigated
  // between pages the tools read while they were made, with a note that says so (for the screenshot the page
  // changes its address every 15 ms for a second and a half)
  const ev15 = await call("browser_evaluate", { js: "history.pushState({}, '', '/ev15'); 'EV15-VALUE'" });
  const evPlain15 = await call("browser_evaluate", { js: "'EV15-PLAIN'" });
  // pre-review P16 — the note says so when the page navigated more than once, and a script that threw carries it too
  const evTwice16 = await call("browser_evaluate", { js: "history.pushState({}, '', '/a16'); history.pushState({}, '', '/b16'); 'EV16-VALUE'" });
  const evThrew16 = await call("browser_evaluate", { js: "history.pushState({}, '', '/c16'); throw new Error('BOOM-16')" });
  await call("browser_evaluate", { js: "(() => { const end = Date.now() + 1500; const t = setInterval(() => { if (Date.now() > end) { clearInterval(t); return; } history.replaceState({}, '', '/tick' + (Date.now() % 1000)); }, 15); })(); 1" });
  const shot15 = await call("browser_screenshot");
  await new Promise((r) => setTimeout(r, 1900));
  const shotPlain15 = await call("browser_screenshot");
  const meta15 = (r) => { try { return JSON.parse(String(r?.content?.[1]?.text)); } catch { return null; } };
  check("browser_evaluate and browser_screenshot while the page navigated between pages the tools read: handed over, with a note that says so; no note when nothing happened",
    T(ev15) === "\"EV15-VALUE\"\n[the page navigated while the script ran: it showed https://example.com/thrown14 when the call began and shows https://example.com/ev15 now]\n(delivery=delivered_unverified, retry=unsafe)"
    && T(evPlain15) === "\"EV15-PLAIN\"\n(delivery=delivered_unverified, retry=unsafe)"
    && T(evTwice16) === "\"EV16-VALUE\"\n[the page navigated 2 times while the script ran: it showed https://example.com/ev15 when the call began and shows https://example.com/b16 now, by way of at least one page in between]\n(delivery=delivered_unverified, retry=unsafe)"
    && evThrew16?.isError === true && T(evThrew16).startsWith("ERROR: action_failed: evaluate failed: ") && T(evThrew16).includes("BOOM-16") && T(evThrew16).endsWith(" [the page navigated while the script ran: it showed https://example.com/b16 when the call began and shows https://example.com/c16 now] (delivery=unknown, retry=unsafe)")
    && shot15?.content?.[0]?.type === "image" && /^the page navigated (\d+ times )?while the screenshot was being taken: it showed https:\/\/example\.com\/(c16|tick\d+) when the call began and shows https:\/\/example\.com\/tick\d+ now(, by way of at least one page in between)?; the picture is of one moment in between$/.test(String(meta15(shot15)?.navigated))
    && shotPlain15?.content?.[0]?.type === "image" && meta15(shotPlain15) !== null && !("navigated" in meta15(shotPlain15)),
    `${T(ev15).slice(0, 150)} | ${String(meta15(shot15)?.navigated).slice(0, 170)} | ${JSON.stringify(meta15(shotPlain15)).slice(0, 80)}`);
  const nav12 = await call("browser_navigate", { url: "https://example.com" });
  check("browser_snapshot: the page navigated while the snapshot was taken (a fragment, then history.pushState) — page_changed both times, nothing of the page, no element_index left to click; the next snapshot is answered",
    [[frag12, "https://example.com/#frag"], [moved12, "https://example.com/moved"]].every(([r, url]) => r?.isError === true && T(r).startsWith(`ERROR: page_changed: the page navigated while the snapshot was being taken (it shows ${url} now)`) && T(r).endsWith("(delivery=not_delivered, retry=safe)") && !T(r).includes("Learn more"))
    && stale12?.isError === true && T(stale12).includes("element_no_longer_valid") && !again12?.isError && T(again12).startsWith("URL: https://example.com/moved\n") && !nav12?.isError
    && gone14?.isError === true && T(gone14) === "ERROR: page_changed: the page navigated while the snapshot was being taken, so it was not finished — call browser_snapshot again (delivery=not_delivered, retry=safe)",
    `${T(frag12).slice(0, 110)} | ${T(moved12).slice(0, 110)} | ${T(stale12).slice(0, 60)} | ${T(gone14).slice(0, 110)} | ${T(again12).slice(0, 40)}`);
  check("browser_read: the page navigated while a read waited for a selector — the text is handed over under a line that gives both addresses, and a read during which nothing happened has no such line; a read of the whole page is not returned (page_changed), and is when asked again",
    !movedRead12?.isError && T(movedRead12).startsWith("[the page navigated while this was read: it showed https://example.com/moved when the read began and shows https://example.com/later now — the text may be of either]\n") && T(movedRead12).includes("LATE12-TEXT") && !plainRead12?.isError && T(plainRead12).startsWith("LATE12-TEXT")
    && !twiceRead14?.isError && T(twiceRead14).startsWith("[the page navigated 2 times while this was read: it showed https://example.com/later when the read began and shows https://example.com/end14 now — the text may be of either, or of a page in between]\n") && T(twiceRead14).includes("LATE14-TEXT")
    && whole13?.isError === true && T(whole13).startsWith("ERROR: page_changed: the page navigated while it was being read (it shows https://example.com/later2 now)") && T(whole13).endsWith("(delivery=not_delivered, retry=safe)") && !T(whole13).includes("WHOLE13-TEXT") && !wholeAgain13?.isError && T(wholeAgain13).includes("LATE12-TEXT") && !T(wholeAgain13).startsWith("["),
    `${T(movedRead12).slice(0, 150)} | ${T(plainRead12).slice(0, 30)} | ${T(whole13).slice(0, 120)} | ${T(wholeAgain13).slice(0, 30)}`);
  // pre-review P13 — an element_index is not used after any navigation of the page: a reload leaves the address
  // as it was, and the link in the same place
  const link13 = T(await call("browser_snapshot")).match(/\[(\d+)\] a "/);
  await call("browser_evaluate", { js: "window.__old = 1; location.reload(); 1" });
  let reloaded13 = false;
  for (let i = 0; i < 40 && !reloaded13; i++) {
    reloaded13 = T(await call("browser_evaluate", { js: "window.__old === undefined && document.readyState === 'complete'" })).startsWith("true");
    if (!reloaded13) await new Promise((r) => setTimeout(r, 250));
  }
  const stale13 = await call("browser_click", { element_index: link13 ? parseInt(link13[1]) : 0 });
  await new Promise((r) => setTimeout(r, 400));
  const after13 = (await tabs()).find((t) => t.active);
  check("an element_index read before a reload of the same address is not used after it: element_no_longer_valid (page navigated since snapshot), nothing clicked",
    Boolean(link13) && reloaded13 && stale13?.isError === true && T(stale13).includes("element_no_longer_valid: page navigated since snapshot") && /^https:\/\/example\.com\/?$/.test(String(after13?.url)), `${T(stale13).slice(0, 110)} | ${String(after13?.url).slice(0, 40)}`);
  // pre-review P12 — a refusal that a tool throws reaches the client whole, delivery marker included (the address is
  // shown up to 60 characters), and a read that fails once the page stopped passing is answered with the refusal —
  // not with the error the page threw
  const fd = await fresh();
  const hash12 = await call("browser_evaluate", { js: "location.hash = 'h'.repeat(80); 1" });
  const long12 = await call("browser_read");
  const fe = await fresh();
  await call("browser_evaluate", { js: "Object.defineProperty(document.body, 'innerText', { get() { location.hash = 'q'; throw new Error('GETTER-THROWN'); } }); 1" });
  const thrown12 = await call("browser_read");
  const closed12 = [await call("browser_tabs", { action: "close", tab_id: fe?.tab_id }), await call("browser_tabs", { action: "close", tab_id: fd?.tab_id })];
  check("a refusal that is thrown arrives whole, and a read that fails once the page stopped passing gives the refusal — none of the page's own error",
    hash12?.isError === true && long12?.isError === true && T(long12).startsWith(`ERROR: active_page_not_allowed: the active tab ${fd?.tab_id} shows about:blank#${"h".repeat(48)} — only an http(s) page`) && T(long12).endsWith("(delivery=not_delivered, retry=safe)")
    && thrown12?.isError === true && T(thrown12).startsWith(`ERROR: active_page_not_allowed: the active tab ${fe?.tab_id} shows about:blank#q now — it changed while the page was being read`) && !T(thrown12).includes("GETTER-THROWN") && T(thrown12).endsWith("(delivery=not_delivered, retry=safe)")
    && closed12.every((r) => !r?.isError) && (await tabs()).find((t) => t.active)?.tab_id === own6?.tab_id,
    `${T(long12).slice(0, 130)} | ${T(thrown12).slice(0, 170)}`);
  // pre-review P13 — any navigation that a tab on its first blank page reports ends its standing, also one whose
  // address is about:blank again (measured: history.back() to a blank page a local file had reached is one)
  const ff = await fresh();
  const push13 = await call("browser_evaluate", { js: "history.pushState(null, '', 'about:blank'); 'PUSH-RESULT'" });
  const read13 = await call("browser_read");
  const closed13 = await call("browser_tabs", { action: "close", tab_id: ff?.tab_id });
  check("a tab on its first blank page that reports a navigation to about:blank again is no longer that page: the script's result is not handed over and the tab is not read",
    push13?.isError === true && T(push13).startsWith(`ERROR: active_page_not_allowed: the active tab ${ff?.tab_id} shows about:blank (not the blank page noracu opened the tab on) now — it changed while the script ran`) && !T(push13).includes("PUSH-RESULT")
    && read13?.isError === true && T(read13).startsWith(`ERROR: active_page_not_allowed: the active tab ${ff?.tab_id} shows about:blank (not the blank page noracu opened the tab on) — `) && !closed13?.isError && (await tabs()).find((t) => t.active)?.tab_id === own6?.tab_id,
    `${T(push13).slice(0, 150)} | ${T(read13).slice(0, 110)}`);
  // pre-review P9 — an element_index read before the active tab went to a page the tools refuse is not used once
  // the tab is back, even when only browser_tabs was called in between (the blob page goes back by itself)
  const link9 = T(await call("browser_snapshot")).match(/\[(\d+)\] a "/);
  await call("browser_evaluate", { js: "location.href = URL.createObjectURL(new Blob(['<title>back</title><script>setTimeout(() => history.back(), 1500);</script>'], { type: 'text/html' })); 1" });
  const away9 = await waitTab((t) => t.active && String(t.url).startsWith("blob:"));
  const back9 = await waitTab((t) => t.active && /^https:\/\/example\.com\/?$/.test(String(t.url)));
  const stale9 = await call("browser_click", { element_index: link9 ? parseInt(link9[1]) : 0 });
  await new Promise((r) => setTimeout(r, 500));
  const after9 = (await tabs()).find((t) => t.active);
  check("an element_index read before the active tab went to a page the tools refuse is not used once the tab is back: element_no_longer_valid, nothing clicked",
    Boolean(link9) && Boolean(away9) && Boolean(back9) && stale9?.isError === true && T(stale9).includes("element_no_longer_valid") && /^https:\/\/example\.com\/?$/.test(String(after9?.url)), `${T(stale9).slice(0, 100)} | ${String(after9?.url).slice(0, 40)}`);
  // pre-review P9 — a blank page counts only while it is the one noracu opened the tab on. The active tab (opened
  // with browser_tabs, has loaded a page) takes itself to about:blank: refused like any page the tools do not
  // read, not selectable, and not the tab that takes over — while a tab still on its first blank page is read
  await call("browser_evaluate", { js: "location.href = 'about:blank'; 1" });
  const blank8 = await waitTab((t) => t.active && t.url === "about:blank");
  const read8 = await call("browser_read");
  await call("browser_tabs", { action: "new" });
  const fresh8 = (await tabs()).find((t) => t.active);
  const readFresh = await call("browser_read");
  const sel8 = await call("browser_tabs", { action: "select", tab_id: own6?.tab_id });
  const cl8 = await call("browser_tabs", { action: "close", tab_id: fresh8?.tab_id });
  check("a tab that has loaded a page and then shows about:blank: active_page_not_allowed, tab_not_selectable, and it does not take over when the active tab closes; a tab still on the blank page browser_tabs opened it on is read",
    blank8?.tab_id === own6?.tab_id && read8?.isError === true && T(read8).startsWith(`ERROR: active_page_not_allowed: the active tab ${own6?.tab_id} shows about:blank (not the blank page noracu opened the tab on) — `) && T(read8).endsWith("(delivery=not_delivered, retry=safe)")
    && fresh8?.url === "about:blank" && fresh8?.tab_id !== own6?.tab_id && fresh8?.opened_by_browser_tabs === true && !readFresh?.isError && sel8?.isError === true && T(sel8).includes("tab_not_selectable") && !cl8?.isError && T(cl8).includes("the active page is none"),
    `${T(read8).slice(0, 120)} | ${T(sel8).slice(0, 60)} | ${T(cl8).slice(0, 80)}`);
  const bad = [await call("browser_tabs", { action: "close", tab_id: "t999" }), await call("browser_tabs", { action: "frobnicate" }), await call("browser_tabs", { action: "select" }), await call("browser_tabs", { action: "new", url: "javascript:alert(1)" }), await call("browser_tabs", { action: "list", tab_id: first.tab_id })];
  check("browser_tabs: an unknown tab_id, an unknown action, a missing tab_id, a url that is not http(s), a tab_id with list — all refused", bad.every((r) => r?.isError === true) && T(bad[0]).includes("tab_not_found"), bad.map((r) => T(r).slice(0, 44)).join(" | "));
}
const bc = await call("browser_close");
check("browser_close", bc?.content?.[0]?.text?.includes("closed"), bc?.content?.[0]?.text);

// 7b. Browser fixture pages (file://, headless — nothing reaches the desktop, so this runs in CI too): a covered
// or disabled button is refused and not clicked from script, placeholders name inputs, window.open leaves the
// active page alone, long lists and long pages say what was cut, a scroll that did not move says so
{
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const dir = mkdtempSync(join(tmpdir(), "noracu-browser-e2e-"));
  const fixturePath = join(dir, "fixture.html");
  const popupPath = join(dir, "popup.html");
  const manyPath = join(dir, "many.html");
  writeFileSync(fixturePath, [
    "<!doctype html><html><head><meta charset='utf-8'><title>Noracu Fixture Main</title></head>",
    "<body style='margin:0;height:1200px'>",
    "<input id='in1' placeholder='Alpha placeholder'>",
    "<input id='in2' placeholder='Beta placeholder'>",
    "<input id='in3'>",
    "<input type='submit' value='Send Form'>",
    "<button id='under' onclick='window.__underClicked = true' style='position:fixed;left:80px;top:80px;width:140px;height:44px;z-index:1'>Covered Action</button>",
    "<button id='dis' disabled style='position:fixed;left:260px;top:80px;width:140px;height:44px;z-index:10001'>Disabled Action</button>",
    "<div id='cover' style='position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.05)'>Modal Overlay</div>",
    "<script>window.__underClicked = false;</script>",
    "</body></html>",
  ].join("\n"));
  writeFileSync(popupPath, "<!doctype html><html><head><meta charset='utf-8'><title>Popup Second Page</title></head><body><button>Popup Only Button</button></body></html>");
  const manyButtons = Array.from({ length: 125 }, (_, i) => `<button style='display:block;margin:8px'>Item ${i}</button>`).join("");
  writeFileSync(manyPath, `<!doctype html><html><head><meta charset='utf-8'><title>Many Controls</title></head><body style='height:3200px'>${manyButtons}</body></html>`);
  const fixtureUrl = pathToFileURL(fixturePath).href;
  const popupUrl = pathToFileURL(popupPath).href;
  const manyUrl = pathToFileURL(manyPath).href;
  // review 0.2.6 #8: a page longer than every cap
  const longPath = join(dir, "long.html");
  writeFileSync(longPath, `<!doctype html><html><head><meta charset='utf-8'><title>Long Page</title></head><body>${Array.from({ length: 600 }, (_, i) => `<p>Paragraph number ${i} of the long fixture page.</p>`).join("")}<p>LAST-LINE-MARKER</p></body></html>`);
  const longUrl = pathToFileURL(longPath).href;
  const s = await spawnServer({ NORACU_ALLOW_FILE_URL: "1" });
  const say = (r) => String(r?.content?.[0]?.text || "");
  try {
    await s.call("browser_launch", { headless: true });
    await s.call("browser_navigate", { url: fixtureUrl });
    const navSame = await s.call("browser_navigate", { url: `${fixtureUrl}#sec` });
    check("t07：同文档导航回报 no response 与 delivery", !navSame?.isError && say(navSame).includes("no response") && say(navSame).includes("delivery="), say(navSame).slice(0, 80));

    const snapText = say(await s.call("browser_snapshot"));
    check("t07：不同 placeholder 的两个 input 获得不同名称", snapText.includes('input "Alpha placeholder"') && snapText.includes('input "Beta placeholder"'), snapText.split("[clickable")[1]?.slice(0, 90));
    // t07 review: typed text never becomes an element's name (stable identity); a submit input is named by its value
    await s.call("browser_fill", { selector: "#in3", value: "typed-xyz-123" });
    const snapTyped = say(await s.call("browser_snapshot"));
    const elPart = snapTyped.split("[clickable")[1] || "";
    check("t07 复核：输入的文字不进入元素名；submit 按 value 命名", elPart.length > 0 && !elPart.includes("typed-xyz-123") && elPart.includes('input "Send Form"'), elPart.slice(0, 120));
    // a fill without `value` (a client that passes `text`, as the typing tools take) must not clear the field and
    // call that verified
    const noValue = await s.call("browser_fill", { selector: "#in3", text: "other" });
    const kept = await s.call("browser_evaluate", { js: "document.querySelector('#in3').value" });
    const cleared = await s.call("browser_fill", { selector: "#in3", value: "" });
    const emptied = await s.call("browser_evaluate", { js: "document.querySelector('#in3').value" });
    check("browser_fill without value is refused and the field keeps its text; an explicit empty value clears it",
      noValue?.isError && /value is required/.test(say(noValue)) && /passed as text/.test(say(noValue)) && say(noValue).includes("delivery=not_delivered")
        && say(kept).includes("typed-xyz-123") && !cleared?.isError && say(cleared).includes("delivery=delivered_verified") && /^""$/m.test(say(emptied)),
      `${say(noValue).slice(0, 90)} | kept=${say(kept).split("\n")[0]} | ${say(cleared).slice(0, 50)} | now=${say(emptied).split("\n")[0]}`);

    const mUnder = snapText.match(/\[(\d+)\] button "Covered Action"/);
    const clickUnder = mUnder ? await s.call("browser_click", { element_index: Number(mUnder[1]) }) : null;
    const evalUnder = await s.call("browser_evaluate", { js: "window.__underClicked" });
    check("t07：被遮挡按钮点击报 occluded/not_actionable 且不触发 onclick",
      Boolean(mUnder) && clickUnder?.isError && /\b(occluded|not_actionable):/.test(say(clickUnder))
        && say(clickUnder).includes("delivery=not_delivered, retry=safe")
        && /^false$/m.test(say(evalUnder)) && say(evalUnder).includes("delivery="),
      `${say(clickUnder).slice(0, 70)} | clicked=${say(evalUnder).split("\n")[0]}`);

    const mDis = snapText.match(/\[(\d+)\] button "Disabled Action"/);
    const clickDis = mDis ? await s.call("browser_click", { element_index: Number(mDis[1]) }) : null;
    check("t07：disabled 按钮点击报 not_actionable", Boolean(mDis) && clickDis?.isError && say(clickDis).includes("not_actionable:") && say(clickDis).includes("delivery=not_delivered, retry=safe"), say(clickDis).slice(0, 80));

    const opened = await s.call("browser_evaluate", { js: `Boolean(window.open(${JSON.stringify(popupUrl)}, "_blank"))` });
    await sleepMs(400);
    const titleAfter = await s.call("browser_evaluate", { js: "document.title" });
    const snapAfterPopup = say(await s.call("browser_snapshot"));
    check("t07：window.open 打开新页后活动页不变",
      /^true$/m.test(say(opened)) && say(titleAfter).includes("Noracu Fixture Main")
        && !say(titleAfter).includes("Popup Second Page")
        && snapAfterPopup.includes("Covered Action") && !snapAfterPopup.includes("Popup Only Button"),
      `opened=${say(opened).split("\n")[0]} title=${say(titleAfter).split("\n")[0]}`);

    await s.call("browser_navigate", { url: manyUrl });
    const snapMany = say(await s.call("browser_snapshot"));
    check("t07：超过 100 个可交互元素时提示 truncated 与遗漏数", snapMany.includes("truncated") && snapMany.includes("25 left out"), snapMany.slice(-90));

    await s.call("browser_navigate", { url: longUrl });
    const snapLong = say(await s.call("browser_snapshot"));
    const readLong = say(await s.call("browser_read"));
    const readSel = say(await s.call("browser_read", { selector: "body" }));
    check("0.2.6（#8）：长页面的 ARIA 快照 / browser_read 被截断时写明截断与原长度",
      /\[aria snapshot truncated: showing \d+ of \d+ chars/.test(snapLong) && !snapLong.includes("LAST-LINE-MARKER") && snapLong.includes("[clickable elements")
        && /\n\[truncated: showing 12000 of \d+ chars\]$/.test(readLong) && /\n\[truncated: showing 8000 of \d+ chars\]$/.test(readSel),
      `${snapLong.match(/\[aria snapshot truncated[^\]]*\]/)?.[0]} | ${readLong.slice(-50)} | ${readSel.slice(-45)}`);
    await s.call("browser_navigate", { url: manyUrl });
    const scDown = await s.call("browser_scroll", { direction: "down", pages: 1 });
    await s.call("browser_scroll", { direction: "up", pages: 2 });
    const scTop = await s.call("browser_scroll", { direction: "up", pages: 1 });
    check("t07：browser_scroll 回报 scrollY 变化与 did not move",
      !scDown?.isError && /scrollY 0 → [1-9]\d*/.test(say(scDown)) && say(scDown).includes("delivery=delivered_verified")
        && !scTop?.isError && say(scTop).includes("did not move") && say(scTop).includes("delivery=delivered_unverified"),
      `${say(scDown).slice(0, 50)} | ${say(scTop).slice(0, 50)}`);

    // a control nested deeper than 20 elements is listed and can be clicked by its index (the walk used to stop
    // at depth 20 and say nothing); a page nested deeper than the walk says its list may be incomplete
    const nest = (n, inner) => "<div>".repeat(n) + inner + "</div>".repeat(n);
    const deepPath = join(dir, "deep.html"), abyssPath = join(dir, "abyss.html");
    writeFileSync(deepPath, `<!doctype html><html><head><meta charset='utf-8'><title>Deep</title></head><body>${nest(30, "<button onclick='window.__deep = true'>Deep Button</button>")}</body></html>`);
    writeFileSync(abyssPath, `<!doctype html><html><head><meta charset='utf-8'><title>Abyss</title></head><body><button>Shallow Button</button>${nest(80, "<button>Abyss Button</button>")}</body></html>`);
    await s.call("browser_navigate", { url: pathToFileURL(deepPath).href });
    const snapDeep = say(await s.call("browser_snapshot"));
    const mDeep = (snapDeep.split("[clickable")[1] || "").match(/\[(\d+)\] button "Deep Button"/);
    const clickDeep = mDeep ? await s.call("browser_click", { element_index: Number(mDeep[1]) }) : null;
    const deepClicked = await s.call("browser_evaluate", { js: "window.__deep === true" });
    check("browser_snapshot lists a button nested 30 elements deep, and browser_click reaches it by element_index",
      Boolean(mDeep) && !clickDeep?.isError && /^true$/m.test(say(deepClicked)) && !snapDeep.includes("some may be missing"),
      `${(snapDeep.split("[clickable")[1] || "").slice(0, 110)} | ${say(clickDeep).slice(0, 60)}`);
    await s.call("browser_navigate", { url: pathToFileURL(abyssPath).href });
    const listAbyss = say(await s.call("browser_snapshot")).split("[clickable")[1] || "";
    check("browser_snapshot of a page nested deeper than the walk says its list may be incomplete, instead of a short list that reads as complete",
      listAbyss.includes('button "Shallow Button"') && !listAbyss.includes('button "Abyss Button"') && listAbyss.includes("some may be missing"),
      listAbyss.slice(0, 160));
  } finally {
    await s.call("browser_close").catch(() => {});
    const exited = new Promise((r) => s.proc.once("exit", r));
    s.proc.kill();
    await Promise.race([exited, sleepMs(3000)]);
    rmSync(dir, { recursive: true, force: true });
  }
}

// 7b2. first_tab：第一个标签页不算干净空白页时，browser_launch 当场说明。
// 测试开关 NORACU_TEST_FIRST_TAB_UNCOUNTED 只在 NORACU_CI=1 下生效，只会让第一个标签页不算数
{
  const say = (r) => String(r?.content?.[0]?.text || "");
  const launchWith = async (env) => {
    const s = await spawnServer(env);
    try {
      const l = say(await s.call("browser_launch", { headless: true }));
      const snap = await s.call("browser_snapshot", {});
      return { l, snap };
    } finally {
      await s.call("browser_close").catch(() => {});
      const exited = new Promise((r) => s.proc.once("exit", r));
      s.proc.kill();
      await Promise.race([exited, sleepMs(3000)]);
    }
  };
  const on = await launchWith({ NORACU_CI: "1", NORACU_TEST_FIRST_TAB_UNCOUNTED: "1" });
  const off = await launchWith({ NORACU_CI: "", NORACU_TEST_FIRST_TAB_UNCOUNTED: "1" });
  check("first_tab：第一个标签页不算数时 browser_launch 当场写明 first_tab，页面工具拒（active_page_not_allowed）；没有 NORACU_CI=1 时测试开关不生效",
    on.l.includes('"first_tab":"not counted as a fresh blank page') && on.snap?.isError === true && say(on.snap).startsWith("ERROR: active_page_not_allowed:")
      && !off.l.includes("first_tab") && off.l.includes('"browser_id"'),
    `${on.l.slice(0, 160)} | ${say(on.snap).slice(0, 60)} | ${off.l.slice(0, 80)}`);
}

// 7b3. browser_launch chrome:true：在"你自己的 Chrome"里干活，只碰 noracu 自己开的标签。
// 用一个带调试端口的 Chromium 扮演你的 Chrome（它同样写 DevToolsActivePort），里面先开着"你的"两个标签：一个 http 页、一个 chrome://version
{
  const { mkdtempSync, rmSync, existsSync: fexists, writeFileSync: wf } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createServer } = await import("node:http");
  const { createRequire } = await import("node:module");
  const say = (r) => String(r?.content?.[0]?.text || "");
  const { chromium } = createRequire(import.meta.url)("playwright");
  const dir = mkdtempSync(join(tmpdir(), "noracu-fakechrome-"));
  const srv = createServer((q, r) => { r.setHeader("content-type", "text/html; charset=utf-8"); r.end(q.url.startsWith("/b") ? "<title>B page</title><p>b</p>" : q.url.startsWith("/user") ? "<title>Your own tab</title><p>private</p>" : "<title>A page</title><a id='l' href='/b' target='_blank'>open b</a>"); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const proc = spawn(chromium.executablePath(), ["--headless=new", `--user-data-dir=${dir}`, "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", `${base}/user?mine=1`], { stdio: "ignore" });
  // up to 30 s: on a loaded Mac a headless start has taken longer than 10 s (2026-11-14, load average ~40)
  for (let i = 0; i < 300 && !fexists(join(dir, "DevToolsActivePort")); i++) await sleepMs(100);
  const { readFileSync: rf } = await import("node:fs");
  const port = rf(join(dir, "DevToolsActivePort"), "utf8").split("\n")[0].trim();
  const list = async () => { try { return await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch { return null; } };
  const pages = async () => ((await list()) || []).filter((t) => t.type === "page");
  // chrome://version on the command line holds headless start-up (measured), so that tab is opened afterwards
  await fetch(`http://127.0.0.1:${port}/json/new?chrome://version`, { method: "PUT" }).catch(() => {});
  await fetch(`http://127.0.0.1:${port}/json/new?${base}/user2`, { method: "PUT" }).catch(() => {});
  wf(join(dir, "secret.html"), "<title>Your local file</title><p>local secret</p>");
  await fetch(`http://127.0.0.1:${port}/json/new?file://${join(dir, "secret.html")}`, { method: "PUT" }).catch(() => {});
  let yoursAtStart = [];
  for (let i = 0; i < 30 && (yoursAtStart = await pages()).length < 4; i++) await sleepMs(100);
  const stop = async (x) => { const exited = new Promise((r) => x.proc.once("exit", r)); x.proc.kill(); await Promise.race([exited, sleepMs(3000)]); };
  // DevToolsActivePort that is not Chrome's, and one whose port nobody answers on any more (Chrome quit)
  const badDir = mkdtempSync(join(tmpdir(), "noracu-badport-"));
  wf(join(badDir, "DevToolsActivePort"), "nope\n");
  const staleDir = mkdtempSync(join(tmpdir(), "noracu-staleport-"));
  const freePort = await new Promise((r) => { const t = createServer(); t.listen(0, "127.0.0.1", () => { const p = t.address().port; t.close(() => r(p)); }); });
  wf(join(staleDir, "DevToolsActivePort"), `${freePort}\n/devtools/browser/0000-stale\n`);
  try {
    const g1 = await spawnServer({ NORACU_ALLOW_CHROME: "", NORACU_CHROME_DIR: dir });
    const denied = say(await g1.call("browser_launch", { chrome: true }));
    await stop(g1);
    const g2 = await spawnServer({ NORACU_ALLOW_CHROME: "1", NORACU_CHROME_DIR: dir, NORACU_READ_ONLY: "1" });
    const ro = say(await g2.call("browser_launch", { chrome: true }));
    await stop(g2);
    const g3 = await spawnServer({ NORACU_ALLOW_CHROME: "1", NORACU_CHROME_DIR: join(dir, "no-such-dir") });
    const off = say(await g3.call("browser_launch", { chrome: true }));
    const bad = say(await g3.call("browser_launch", { chrome: true, headless: true }));
    await stop(g3);
    const g4 = await spawnServer({ NORACU_ALLOW_CHROME: "1", NORACU_CHROME_DIR: badDir });
    const malformed = say(await g4.call("browser_launch", { chrome: true }));
    await stop(g4);
    const g5 = await spawnServer({ NORACU_ALLOW_CHROME: "1", NORACU_CHROME_DIR: staleDir });
    const stale = say(await g5.call("browser_launch", { chrome: true }));
    await stop(g5);
    check("chrome:true 的门槛：没设 NORACU_ALLOW_CHROME=1 → policy_denied；只读模式 → 拒；Chrome 没开远程调试 → chrome_not_reachable 并指向 chrome://inspect；文件格式不对、端口没人应（Chrome 已退）各报各的；和 headless 同传 → 校验层拒",
      denied.includes("policy_denied") && denied.includes("NORACU_ALLOW_CHROME=1") && ro.includes("NORACU_READ_ONLY=1")
        && off.includes("chrome_not_reachable") && off.includes("chrome://inspect/#remote-debugging") && off.includes("delivery=not_delivered, retry=safe")
        && malformed.includes("not in the form Chrome writes") && stale.includes("chrome_not_reachable: nothing answers on the port")
        && bad.includes("chrome:true takes neither cdp_port nor headless"),
      `${denied.slice(0, 50)} | ${ro.slice(0, 40)} | ${off.slice(0, 50)} | ${malformed.slice(0, 70)} | ${stale.slice(0, 70)} | ${bad.slice(0, 40)}`);

    const s = await spawnServer({ NORACU_ALLOW_CHROME: "1", NORACU_CHROME_DIR: dir });
    try {
      const l = say(await s.call("browser_launch", { chrome: true }));
      const t0 = JSON.parse(say(await s.call("browser_tabs", { action: "list" })) || "{}").tabs || [];
      const nav = say(await s.call("browser_navigate", { url: `${base}/a` }));
      const snap = say(await s.call("browser_snapshot", {}));
      await s.call("browser_click", { selector: "#l" });
      await sleepMs(800);
      const t1 = JSON.parse(say(await s.call("browser_tabs", { action: "list" })) || "{}").tabs || [];
      const nt = say(await s.call("browser_tabs", { action: "new", url: `${base}/b2` }));
      const t2 = JSON.parse(say(await s.call("browser_tabs", { action: "list" })) || "{}").tabs || [];
      check("chrome:true：在你的 Chrome 里开自己的窗口；只列出、只读 noracu 自己的标签（你原来的标签不出现）；它的链接新开的标签和 browser_tabs new 开的标签都算它的",
        l.includes('"chrome":true') && l.includes('"attached":true')
          && t0.length === 1 && t0[0].url === "about:blank" && nav.includes(`${base}/a`) && snap.includes("open b")
          && t1.length === 2 && t1.some((t) => /\/b$/.test(t.url)) && nt.startsWith("opened tab") && t2.length === 3
          && [...t0, ...t1, ...t2].every((t) => !String(t.url).includes("/user") && !String(t.url).startsWith("chrome://")),
        `${l.slice(0, 60)} | t0=${t0.length} t1=${t1.length} t2=${t2.length} | ${nt.slice(0, 50)}`);
      // pre-review P22: a blank tab from browser_tabs new is quick, readable and selectable again, and leaves no stray tab;
      // the window browser_launch opened is not closed with browser_tabs close
      const t5 = Date.now();
      const nb = say(await s.call("browser_tabs", { action: "new" }));
      const dt = Date.now() - t5;
      const nbId = (nb.match(/opened tab (\S+)/) || [])[1];
      const snapBlank = await s.call("browser_snapshot", {});
      const back = say(await s.call("browser_tabs", { action: "select", tab_id: t0[0].tab_id }));
      const again = say(await s.call("browser_tabs", { action: "select", tab_id: nbId }));
      const firstClose = say(await s.call("browser_tabs", { action: "close", tab_id: t0[0].tab_id }));
      const during = await pages();
      check("chrome:true（P22）：browser_tabs new 不带网址 —— 很快开好、能读、切走再切回能选中；不多出别的标签；browser_launch 开的那个窗口不能用 browser_tabs close 关",
        nb.startsWith("opened tab") && dt < 5000 && !snapBlank?.isError && back.includes("is the active page now") && again.includes("is the active page now")
          && firstClose.includes("tab_not_owned") && during.length === yoursAtStart.length + 4,
        `${nb.slice(0, 40)} ${dt}ms | ${say(snapBlank).slice(0, 40)} | ${again.slice(0, 40)} | ${firstClose.slice(0, 30)} | pages=${during.length} (yours ${yoursAtStart.length})`);
      const [closeR, againR] = await Promise.all([s.call("browser_close", {}), s.call("browser_launch", { chrome: true })]);
      const close = say(closeR), againL = say(againR);
      await sleepMs(500);
      const after = await pages();
      check("chrome:true：browser_close 只关 noracu 的 4 个标签并断开（关的同时再 attach 被拒）；你的标签还在原地，Chrome 还在跑",
        close.startsWith("closed 4 of noracu's 4 open tab(s) in your Chrome and disconnected") && close.includes("noracu did not quit Chrome")
          && againL.includes("a browser session is already open")
          && after.length === yoursAtStart.length && after.some((t) => String(t.url).includes("/user?mine=1")),
        `${close.slice(0, 110)} | ${againL.slice(0, 50)} | pages after: ${after.map((t) => t.url.replace(base, "")).join(",")}`);
    } finally { await stop(s); }
    // the person quits Chrome while noracu is attached: browser_close (no browser_id) says the connection ended and
    // that noracu's tabs may still be open — not "no such browser", not a clean close (pre-review P25)
    {
      const dir2 = mkdtempSync(join(tmpdir(), "noracu-fakechrome2-"));
      const proc2 = spawn(chromium.executablePath(), ["--headless=new", `--user-data-dir=${dir2}`, "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" });
      for (let i = 0; i < 100 && !fexists(join(dir2, "DevToolsActivePort")); i++) await sleepMs(100);
      const q = await spawnServer({ NORACU_ALLOW_CHROME: "1", NORACU_CHROME_DIR: dir2 });
      let attached = "", gone = "", again = "";
      try {
        attached = say(await q.call("browser_launch", { chrome: true }));
        proc2.kill("SIGKILL");
        await sleepMs(1500);
        gone = say(await q.call("browser_close", {}));
        again = say(await q.call("browser_launch", { chrome: true }));
      } finally { await stop(q); try { proc2.kill("SIGKILL"); } catch {} try { rmSync(dir2, { recursive: true, force: true }); } catch {} }
      const lostId = (attached.match(/"browser_id":"([^"]+)"/) || [])[1];
      check("chrome:true（P25）：attach 后 Chrome 被退出 —— browser_close（不带 id）报 chrome_disconnected、点名那个会话、说标签可能还开着；之后可以重新 attach（这里 Chrome 已退，所以报 chrome_not_reachable）",
        attached.includes('"attached":true') && gone.includes("chrome_disconnected") && lostId && gone.includes(lostId) && gone.includes("may still be open")
          && (again.includes("chrome_not_reachable") || again.includes("chrome_attach_failed")) && !again.includes("already open"),
        `${attached.slice(0, 40)} | ${gone.slice(0, 120)} | ${again.slice(0, 60)}`);
    }
    // NORACU_CHROME_TABS=all: your http(s) tabs are listed, selectable and read; still never closed by noracu
    const a = await spawnServer({ NORACU_ALLOW_CHROME: "1", NORACU_CHROME_DIR: dir, NORACU_CHROME_TABS: "all", NORACU_ENABLE_EVAL: "1", NORACU_ALLOW_FILE_URL: "1" });
    try {
      // two attaches at once: one session (pre-review P22)
      const both = (await Promise.all([a.call("browser_launch", { chrome: true }), a.call("browser_launch", { chrome: true })])).map(say);
      const la = both.find((x) => x.includes('"attached":true')) || "";
      const ta = JSON.parse(say(await a.call("browser_tabs", { action: "list" })) || "{}").tabs || [];
      const yours = ta.find((x) => String(x.url).includes("/user?mine=1"));
      const sel = say(await a.call("browser_tabs", { action: "select", tab_id: yours?.tab_id }));
      const rd = say(await a.call("browser_snapshot", {}));
      const ev = say(await a.call("browser_evaluate", { js: "document.cookie" }));
      const cl = say(await a.call("browser_tabs", { action: "close", tab_id: yours?.tab_id }));
      const navFile = say(await a.call("browser_navigate", { url: `file://${join(dir, "secret.html")}` }));
      check("chrome:true + NORACU_CHROME_TABS=all：同时两次 attach 只成一个会话；你的 http 标签也列出来（noracu_tab:false），chrome:// 和本地文件（即使 NORACU_ALLOW_FILE_URL=1）不列；能选中、能读、不会被导航到 file://；browser_evaluate 即使 NORACU_ENABLE_EVAL=1 也不跑；noracu 不关你的标签",
        both.filter((x) => x.includes('"attached":true')).length === 1 && both.some((x) => x.includes("a browser session is already open"))
          && la.includes("NORACU_CHROME_TABS=all") && ta.length === 3 && yours && yours.noracu_tab === false && ta.some((x) => x.noracu_tab === true)
          && ta.every((x) => !String(x.url).startsWith("chrome://") && !String(x.url).startsWith("file:"))
          && sel.includes("is the active page now") && rd.includes("private") && cl.includes("tab_not_owned")
          && navFile.includes("your own tabs are only sent to http(s) pages")
          && ev.includes("eval_disabled: browser_evaluate does not run in your own Chrome"),
        `${both.map((x) => x.slice(0, 40)).join(" / ")} | tabs=${ta.length} | ${sel.slice(0, 40)} | ${ev.slice(0, 50)} | ${cl.slice(0, 30)}`);
      // with your tab active, browser_tabs new is still opened by noracu's own tab (nothing runs in yours), and when
      // that new tab closes the active page falls back to noracu's tab, not yours
      const nn = say(await a.call("browser_tabs", { action: "new", url: `${base}/b3` }));
      const nnId = (nn.match(/opened tab (\S+?):/) || [])[1];
      let opUrl = "none";
      try {
        const cb = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
        // what Chrome itself records as the opener (Target.getTargets openerId), not this second client's guess
        const bs = await cb.newBrowserCDPSession();
        const { targetInfos } = await bs.send("Target.getTargets");
        const nt3 = targetInfos.find((t) => t.type === "page" && String(t.url).includes("/b3"));
        const op = nt3?.openerId ? targetInfos.find((t) => t.targetId === nt3.openerId) : null;
        opUrl = op ? op.url : "none";
        await cb.close();
      } catch (e) { opUrl = `error ${String(e).slice(0, 60)}`; }
      const nnClose = say(await a.call("browser_tabs", { action: "close", tab_id: nnId }));
      const u2 = ta.find((x) => String(x.url).includes("/user2"));
      const sel2 = say(await a.call("browser_tabs", { action: "select", tab_id: u2?.tab_id }));
      let moved = "no";
      try {
        const cb2 = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
        const pg2 = cb2.contexts()[0].pages().find((p) => p.url().includes("/user2"));
        const ps = await cb2.contexts()[0].newCDPSession(pg2);
        await ps.send("Page.navigate", { url: "chrome://version" });
        await sleepMs(600);
        moved = pg2.url();
        await cb2.close();
      } catch (e) { moved = `error ${String(e).slice(0, 60)}`; }
      await a.call("browser_tabs", { action: "list" });   // a call that only lists does not move the active page (P24)
      const navAfter = say(await a.call("browser_navigate", { url: `${base}/x` }));
      const ta2 = JSON.parse(say(await a.call("browser_tabs", { action: "list" })) || "{}").tabs || [];
      const versions = (await pages()).filter((t) => String(t.url).startsWith("chrome://version")).length;
      const bye = say(await a.call("browser_close", {}));
      const byeAgain = say(await a.call("browser_close", {}));
      await sleepMs(500);
      const left = await pages();
      check("chrome:true + all（P22）：选中你的标签时 browser_tabs new 也由 noracu 自己的标签打开（opener 不是你的标签）；关掉它后当前页回到 noracu 的标签而不是你的；你把选中的标签换到 chrome:// 后它不再是当前页、browser_navigate 不覆盖它；browser_close 后你的标签都还在",
        nn.startsWith("opened tab") && opUrl === "about:blank" && nnClose.includes("closed tab") && !nnClose.includes("/user")
          && sel2.includes("is the active page now") && moved.startsWith("chrome://version") && navAfter.includes("left http(s)") && navAfter.includes("nothing was done") && !navAfter.includes("version")
          && versions === 2 && ta2.every((x) => !String(x.url).includes("/user2")) && ta2.find((x) => x.active)?.noracu_tab === true
          && bye.startsWith("closed 1 of noracu's 1 open tab(s)") && byeAgain.includes("was already closed and disconnected") && left.length === yoursAtStart.length && left.some((x) => String(x.url).includes("/user?mine=1")),
        `${nn.slice(0, 50)} | opener=${opUrl} | ${nnClose.slice(0, 60)} | moved=${moved} | ${navAfter.slice(0, 90)} | versions=${versions} | ${bye.slice(0, 50)} | left=${left.length}`);
    } finally { await stop(a); }
  } finally {
    proc.kill();
    srv.close();
    await sleepMs(300);
    for (const d of [dir, badDir, staleDir]) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
  }
}

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
check("注入回归：工具未崩溃（两次调用都得到结构化回答）", [inj1, inj2].every((r) => r && typeof r.content?.[0]?.text === "string"), String(inj1?.content?.[0]?.text).slice(0, 60));
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
{
  // S1 (next-steps R3): without NORACU_ENABLE_EVAL=1 browser_evaluate is refused before anything runs (no
  // browser needed: the check comes first); the tool stays listed and mac_status says it is off
  const s = await spawnServer({ NORACU_ENABLE_EVAL: "" });
  try {
    const r = await s.call("browser_evaluate", { js: "1" });
    const t = String(r?.content?.[0]?.text || "");
    await s.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "eval-off" } });
    const listed = (await s.rpc("tools/list"))?.result?.tools?.some((x) => x.name === "browser_evaluate");
    check("S1：browser_evaluate 默认关 —— 未设 NORACU_ENABLE_EVAL=1 时 eval_disabled，什么都不跑；工具仍列出",
      r?.isError && t.startsWith("ERROR: eval_disabled: browser_evaluate is off by default") && t.includes("NORACU_ENABLE_EVAL=1") && t.includes("delivery=not_delivered, retry=safe") && listed === true,
      t.slice(0, 110));
  } finally { s.proc.kill(); }
}
// A session attached over a DevTools port never takes a DevTools window as its active page: keys typed into
// its console would run as script, which browser_evaluate needs NORACU_ENABLE_EVAL for.
{
  const { chromium } = await import("playwright");
  const { createServer: netServer } = await import("node:net");
  const port = await new Promise((r) => { const t = netServer(); t.listen(0, "127.0.0.1", () => { const p = t.address().port; t.close(() => r(p)); }); });
  const say = (r) => String(r?.content?.[0]?.text);
  let app = null;
  const s = await spawnServer({ NORACU_ALLOW_CDP: "any" });
  try {
    // the full browser in headless mode: the headless shell has no DevTools pages
    app = await chromium.launch({ headless: true, channel: "chromium", args: [`--remote-debugging-port=${port}`] });
    const ctx = await app.newContext();
    const appPage = await ctx.newPage();
    await appPage.goto("data:text/html,<title>app</title><p>app page</p>");
    const dev = await ctx.newPage();
    await dev.goto("devtools://devtools/bundled/devtools_app.html");
    const at = await s.call("browser_launch", { cdp_port: port });
    const before = say(await s.call("browser_read"));
    await appPage.close();
    await sleepMs(600);
    const snap = await s.call("browser_snapshot");
    const typed = await s.call("browser_type", { text: "1+1" });
    check("attached over a DevTools port, the app's page closes and a DevTools window is what is left → there is no active page: nothing is read from it or typed into it",
      !at?.isError && jsonOf(at).tabs === 1 && before.includes("app page") && snap?.isError === true && say(snap).includes("no_active_page") && typed?.isError === true && say(typed).includes("no_active_page"),
      `${say(at).slice(0, 80)} | ${say(snap).slice(0, 90)} | ${say(typed).slice(0, 60)}`);
    await s.call("browser_close");
    const at2 = await s.call("browser_launch", { cdp_port: port });
    const snap2 = await s.call("browser_snapshot");
    check("attaching when only a DevTools window is open: it is not counted as a tab and is not the active page",
      !at2?.isError && jsonOf(at2).tabs === 0 && snap2?.isError === true && say(snap2).includes("no_active_page"), `${say(at2).slice(0, 90)} | ${say(snap2).slice(0, 90)}`);
    // the same front end as the app's DevTools port serves it over http, and the port's own endpoints
    const insp = `http://127.0.0.1:${port}/devtools/inspector.html?ws=127.0.0.1:${port}/devtools/page/x`;
    const httpDev = await ctx.newPage();
    await httpDev.goto(insp);
    await s.call("browser_close");
    const at3 = await s.call("browser_launch", { cdp_port: port });
    const snap3 = await s.call("browser_snapshot");
    const navInsp = await s.call("browser_navigate", { url: insp });
    const navJson = await s.call("browser_navigate", { url: `http://localhost:${port}/json/list` });
    check("the DevTools front end that the app's DevTools port serves over http is not a tab either, and the browser tools do not navigate to that port",
      !at3?.isError && jsonOf(at3).tabs === 0 && snap3?.isError === true && say(snap3).includes("no_active_page")
        && navInsp?.isError === true && /DevTools/.test(say(navInsp)) && say(navInsp).includes("delivery=not_delivered") && navJson?.isError === true && /DevTools/.test(say(navJson)),
      `${say(at3).slice(0, 80)} | ${say(snap3).slice(0, 70)} | ${say(navInsp).slice(0, 110)} | ${say(navJson).slice(0, 60)}`);
  } catch (e) {
    check("attached over a DevTools port: a DevTools window is never the active page (the test could not run)", false, String(e?.message || e).split("\n")[0].slice(0, 200));
  } finally { s.proc.kill(); if (app) await app.close().catch(() => {}); }
}
// Browser results that were reported from another page, or with more certainty than there was (audit, the browser layer).
{
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const dir = mkdtempSync(join(tmpdir(), "noracu-bfix-"));
  const html = (name, body) => { writeFileSync(join(dir, name), `<!doctype html><html><head><meta charset='utf-8'><title>${name}</title></head>${body}</html>`); return pathToFileURL(join(dir, name)).href; };
  const say = (r) => String(r?.content?.[0]?.text || "");
  // a local web page, for addresses that must load
  const { createServer: httpServer } = await import("node:http");
  const web = httpServer((q, r) => {
    r.setHeader("content-type", "text/html; charset=utf-8");
    if (q.url.startsWith("/missing")) { r.statusCode = 404; r.end("<title>Not Found</title><p>no such page</p>"); return; }
    r.end("<title>local</title><p>a local page</p>");
  });
  await new Promise((r) => web.listen(0, "127.0.0.1", r));
  const webPort = web.address().port;
  const s = await spawnServer({ NORACU_ALLOW_FILE_URL: "1", NORACU_ENABLE_EVAL: "1" });
  try {
    await s.call("browser_launch", { headless: true });
    // browser_fill: the field goes away and the page moves on as it is filled; the page it lands on has a field
    // of the same selector that already holds the same text
    html("fill-b.html", `<body><input id='q' value='hello'></body>`);
    const fillA = html("fill-a.html", `<body><input id='q' oninput="this.remove(); location.href='fill-b.html'"></body>`);
    await s.call("browser_navigate", { url: fillA });
    const filled = await s.call("browser_fill", { selector: "#q", value: "hello" });
    check("browser_fill: the page navigates as the field is filled and the next page holds the same text in a field of that selector → not delivered_verified, and the result says the page navigated",
      !filled?.isError && say(filled).includes("delivery=delivered_unverified") && /the page navigated/.test(say(filled)), say(filled).slice(0, 220));
    // browser_type on a page that answers each key slowly: when the time runs out, the rest of the text must
    // not keep arriving
    const typeUrl = html("type.html", `<body><input id='t' onkeydown="const e = Date.now(); while (Date.now() - e < 700) {}"></body>`);
    await s.call("browser_navigate", { url: typeUrl });
    await s.call("browser_click", { selector: "#t" });
    const typedSlow = await s.call("browser_type", { text: "abcdefghijklmnopqr" });
    await sleepMs(4500);
    const inField = say(await s.call("browser_evaluate", { js: "document.querySelector('#t').value.length" })).split("\n")[0];
    check("browser_type: the time runs out on a page that answers each key slowly → the rest of the text is not sent afterwards, and the result says how much went out",
      typedSlow?.isError && /\d+ of 18 character/.test(say(typedSlow)) && /one more was under way/.test(say(typedSlow)) && /the other \d+ are not sent/.test(say(typedSlow))
        && say(typedSlow).includes("delivery=unknown, retry=unsafe") && Number(inField) > 0 && Number(inField) < 18,
      `${say(typedSlow).slice(0, 230)} | characters in the field 4.5 s later: ${inField}`);
    // browser_scroll: a page that answers the wheel by moving the other way, and one that navigates on it
    const scrollUrl = html("scroll.html", `<body style='height:6000px;margin:0'><p>tall</p><script>addEventListener('wheel', (e) => { e.preventDefault(); scrollTo(0, 300); }, { passive: false }); scrollTo(0, 1500);</script></body>`);
    await s.call("browser_navigate", { url: scrollUrl });
    const wrongWay = await s.call("browser_scroll", { direction: "down" });
    html("scroll-b.html", `<body style='height:6000px'><p>next</p></body>`);
    const scrollNav = html("scroll-nav.html", `<body style='height:6000px;margin:0'><p>tall</p><script>addEventListener('wheel', () => { location.href = 'scroll-b.html'; }); scrollTo(0, 1500);</script></body>`);
    await s.call("browser_navigate", { url: scrollNav });
    const navScroll = await s.call("browser_scroll", { direction: "down" });
    check("browser_scroll: the page moved the other way, or navigated on the wheel event → not delivered_verified, and the result says which",
      !wrongWay?.isError && say(wrongWay).includes("scrollY 1500 → 300") && say(wrongWay).includes("delivery=delivered_unverified") && /not down/.test(say(wrongWay))
        && /navigated/.test(say(navScroll)) && !say(navScroll).includes("delivered_verified"), `${say(wrongWay).slice(0, 170)} | ${say(navScroll).slice(0, 220)}`);
    // a DevTools front end on a local port this server knows nothing of: refused by what it is
    const anyInsp = "http://127.0.0.1:9/devtools/inspector.html?ws=127.0.0.1:9/devtools/page/x";
    const navAny = await s.call("browser_navigate", { url: anyInsp }), tabAny = await s.call("browser_tabs", { action: "new", url: anyInsp });
    // (a page that loads: a navigation that fails leaves an error page that can arrive after the next navigation)
    const navLocal = await s.call("browser_navigate", { url: `http://127.0.0.1:${webPort}/devtools/readme.txt` });
    check("browser_navigate / browser_tabs new: a DevTools front end on any local port is refused; another address on such a port is not taken for one",
      navAny?.isError === true && /DevTools/.test(say(navAny)) && say(navAny).includes("delivery=not_delivered") && tabAny?.isError === true && /DevTools/.test(say(tabAny))
        && !navLocal?.isError && say(navLocal).startsWith("navigated: "), `${say(navAny).slice(0, 110)} | ${say(tabAny).slice(0, 60)} | ${say(navLocal).slice(0, 80)}`);
    // browser_type: the page leaves for one noracu does not act on while the text is being typed
    const typeNav = html("type-nav.html", `<body><input id='t' onkeydown="if (event.key === 'c') location.href = 'about:blank'"></body>`);
    await s.call("browser_navigate", { url: typeNav });
    await s.call("browser_click", { selector: "#t" });
    const typedAway = await s.call("browser_type", { text: "abcdefghijklmnop" });
    check("browser_type: the tab goes to a page noracu does not act on while the text is typed → typing stops there, and the result says how much went out",
      typedAway?.isError === true && /^ERROR: active_page_not_allowed/.test(say(typedAway)) && /\d+ of 16 character/.test(say(typedAway)) && say(typedAway).includes("delivery=unknown, retry=unsafe"), say(typedAway).slice(0, 260));
    // browser_tabs list: a tab on a page the tools do not read gives no title, and only the start of its address
    const clickTwo = await s.call("browser_click", { element_index: 0, selector: "#nothing" });
    check("browser_click with element_index and a selector: refused — one way to name the target",
      clickTwo?.isError && /one of the three/.test(say(clickTwo)) && /delivery=not_delivered, retry=safe/.test(say(clickTwo)), say(clickTwo).slice(0, 140));
    // an address the server answers with 404: the navigation went through, and the result says what loaded
    const nav404 = await s.call("browser_navigate", { url: `http://127.0.0.1:${webPort}/missing` });
    const nav200 = await s.call("browser_navigate", { url: `http://127.0.0.1:${webPort}/found` });
    check("browser_navigate to an address the server answers with 404: the result says an error page loaded; a page that loaded normally is not called one",
      !nav404?.isError && /HTTP 404 — an error page/.test(say(nav404)) && /delivery=delivered_verified/.test(say(nav404)) && /HTTP 200/.test(say(nav200)) && !/error page/.test(say(nav200)),
      `${say(nav404).slice(0, 130)} | ${say(nav200).slice(0, 70)}`);
    await s.call("browser_navigate", { url: `http://127.0.0.1:${webPort}/start` });
    await s.call("browser_evaluate", { js: "location.href = URL.createObjectURL(new Blob(['<title>SECRET-TITLE</title><p>made by the page</p>'], { type: 'text/html' })); 1" });
    await sleepMs(800);
    const listed = await s.call("browser_tabs", { action: "list" });
    const blobTab = jsonOf(listed).tabs?.find((t) => String(t.url).startsWith("blob:"));
    check("browser_tabs list: a tab on a page the tools do not read (a blob: page the site made) is listed without its title and with the start of its address only",
      Boolean(blobTab) && blobTab.title === null && blobTab.not_read === true && blobTab.url.length <= 60 && !say(listed).includes("SECRET-TITLE"), say(listed).slice(0, 320));
    // browser_type: the stop file appears while a long text is being typed → the rest is not typed
    {
      const stopPath = join(dir, "stop-now");
      const s2 = await spawnServer({ NORACU_ALLOW_FILE_URL: "1", NORACU_STOP_FILE: stopPath });
      try {
        await s2.call("browser_launch", { headless: true });
        await s2.call("browser_navigate", { url: html("long.html", `<body><textarea id='t'></textarea></body>`) });
        await s2.call("browser_click", { selector: "#t" });
        const typing = s2.call("browser_type", { text: "x".repeat(400) });
        await sleepMs(900);
        writeFileSync(stopPath, "");
        const halted = await typing;
        rmSync(stopPath, { force: true });
        const m = /(\d+) of 400 character/.exec(say(halted));
        check("browser_type: the stop file appears while a long text is being typed → the rest is not typed, and the result says how much went out",
          Boolean(halted?.isError) && /user_stopped/.test(say(halted)) && Boolean(m) && Number(m[1]) > 0 && Number(m[1]) < 400 && /delivery=unknown/.test(say(halted)), say(halted).slice(0, 260));
      } finally { s2.proc.kill(); }
    }
    // the client gives a call up (notifications/cancelled: its Stop button, or its own timeout) while a long text
    // is being typed → the rest is not typed, and that call is not answered any more
    {
      const s4 = await spawnServer({ NORACU_ALLOW_FILE_URL: "1" });
      try {
        await s4.call("browser_launch", { headless: true });
        await s4.call("browser_navigate", { url: html("cancel.html", `<body><textarea id='t' oninput="document.getElementById('n').textContent = 'count=' + this.value.length"></textarea><p id='n'>count=0</p></body>`) });
        await s4.call("browser_click", { selector: "#t" });
        const answers = [];
        let buf = "";
        s4.proc.stdout.on("data", (d) => { buf += d; let nl; while ((nl = buf.indexOf("\n")) !== -1) { const l = buf.slice(0, nl); buf = buf.slice(nl + 1); try { answers.push(JSON.parse(l).id); } catch { /* not a message */ } } });
        const count = async () => Number((/count=(\d+)/.exec(say(await Promise.race([s4.call("browser_read", { selector: "#n" }), sleepMs(5000).then(() => null)]))) || [])[1]);
        s4.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 990001, method: "tools/call", params: { name: "browser_type", arguments: { text: "x".repeat(400) } } }) + "\n");
        await sleepMs(900);
        s4.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 990001, reason: "stopped by the user" } }) + "\n");
        await sleepMs(700);
        const first = await count();
        await sleepMs(1200);
        const second = await count();
        check("browser_type: the client cancels the call while a long text is being typed → the typing stops, and the call is not answered",
          first > 0 && first < 400 && second === first && !answers.includes(990001), `typed ${first} then ${second} of 400; answered: ${answers.includes(990001)}`);
      } finally { s4.proc.kill(); }
    }
    // a second call under a request id that is still under way is refused; the first goes on and is answered
    {
      const s5 = await spawnServer({ NORACU_ALLOW_FILE_URL: "1" });
      try {
        await s5.call("browser_launch", { headless: true });
        await s5.call("browser_navigate", { url: html("dup.html", `<body><textarea id='t'></textarea></body>`) });
        await s5.call("browser_click", { selector: "#t" });
        const got = [];
        let buf = "";
        s5.proc.stdout.on("data", (d) => { buf += d; let nl; while ((nl = buf.indexOf("\n")) !== -1) { const l = buf.slice(0, nl); buf = buf.slice(nl + 1); try { const m = JSON.parse(l); if (m.id === 990002) got.push(m); } catch { /* not a message */ } } });
        s5.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 990002, method: "tools/call", params: { name: "browser_type", arguments: { text: "y".repeat(60) } } }) + "\n");
        await sleepMs(300);
        s5.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 990002, method: "tools/call", params: { name: "browser_read", arguments: { selector: "#t" } } }) + "\n");
        await sleepMs(3500);
        const refused = got.find((m) => m.error), done = got.find((m) => m.result);
        check("a second call under a request id that is still under way: refused with an error, and the first is answered as usual",
          got.length === 2 && refused?.error?.code === -32600 && /already in use/.test(refused.error.message) && /typed 60/.test(String(done?.result?.content?.[0]?.text)), JSON.stringify(got).slice(0, 240));
      } finally { s5.proc.kill(); }
    }
    // …also when the second call would be refused before its tool runs (a tool this server does not have, arguments
    // that do not validate): the id is refused, so no tool result goes out under it before the first call's
    {
      const s6 = await spawnServer({ NORACU_ALLOW_FILE_URL: "1" });
      try {
        await s6.call("browser_launch", { headless: true });
        await s6.call("browser_navigate", { url: html("dup2.html", `<body><textarea id='t'></textarea></body>`) });
        await s6.call("browser_click", { selector: "#t" });
        const got = [];
        let buf = "";
        s6.proc.stdout.on("data", (d) => { buf += d; let nl; while ((nl = buf.indexOf("\n")) !== -1) { const l = buf.slice(0, nl); buf = buf.slice(nl + 1); try { const m = JSON.parse(l); if (m.id === 990003) got.push(m); } catch { /* not a message */ } } });
        s6.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 990003, method: "tools/call", params: { name: "browser_type", arguments: { text: "z".repeat(60) } } }) + "\n");
        await sleepMs(300);
        s6.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 990003, method: "tools/call", params: { name: "no_such_tool", arguments: {} } }) + "\n");
        s6.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 990003, method: "tools/call", params: { name: "mac_click", arguments: { x: "a" } } }) + "\n");
        await sleepMs(3500);
        const refused = got.filter((m) => m.error), done = got.filter((m) => m.result);
        check("a second call under a request id still under way that would be refused before its tool runs (unknown tool, bad arguments): the id is refused — no tool result goes out under it before the first call's",
          got.length === 3 && refused.length === 2 && refused.every((m) => m.error.code === -32600 && /already in use/.test(m.error.message)) && done.length === 1 && /typed 60/.test(String(done[0].result?.content?.[0]?.text)), JSON.stringify(got).slice(0, 300));
      } finally { s6.proc.kill(); }
    }
    // browser_click: a click that makes the page navigate says so
    {
      const navUrl = html("nav.html", `<body><a id='go' href='http://127.0.0.1:${webPort}/next'>go</a> <button id='stay'>stay</button></body>`);
      await s.call("browser_navigate", { url: navUrl });
      const stayed = await s.call("browser_click", { selector: "#stay" });
      const went = await s.call("browser_click", { selector: "#go" });
      check("browser_click: a click that makes the page navigate says so, one that does not, does not; neither is reported as verified",
        !went?.isError && /the page navigated after the click/.test(say(went)) && say(went).includes(`127.0.0.1:${webPort}`) && say(went).includes("delivery=delivered_unverified")
          && !stayed?.isError && !/navigated/.test(say(stayed)) && say(stayed).includes("delivery=delivered_unverified"), `${say(stayed).slice(0, 120)} | ${say(went).slice(0, 240)}`);
    }
    // browser_snapshot: the clickable list does not go into shadow roots or frames — it says so
    {
      const shadowUrl = html("shadow.html", `<body><button id='plain'>Plain</button><div id='host'></div><iframe srcdoc="<button>In frame</button>" width='200' height='60'></iframe><script>document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<button>In shadow</button>';</script></body>`);
      await s.call("browser_navigate", { url: shadowUrl });
      const withInner = say(await s.call("browser_snapshot"));
      await s.call("browser_navigate", { url: html("plain.html", `<body><button>Only</button></body>`) });
      const plainOnly = say(await s.call("browser_snapshot"));
      const listOf = (t) => t.slice(t.indexOf("[clickable elements"));
      check("browser_snapshot: a page with a shadow root and a frame — the clickable list says what it leaves out; a page without them says nothing of it",
        /not listed: what is inside 1 open shadow root\(s\) and 1 frame\(s\)/.test(listOf(withInner)) && /"Plain"/.test(listOf(withInner)) && !/"In shadow"/.test(listOf(withInner)) && !/not listed/.test(listOf(plainOnly)),
        `${listOf(withInner).slice(0, 260)} | ${listOf(plainOnly).slice(0, 120)}`);
    }
    // browser_type: the stop file cannot be checked any more while a text is being typed (a file where its folder
    // should be) → the rest is not typed, and the error is the one for that — not "the person stopped"
    {
      const blocker = join(dir, "sub");
      const s3 = await spawnServer({ NORACU_ALLOW_FILE_URL: "1", NORACU_STOP_FILE: join(blocker, "stop") });
      try {
        await s3.call("browser_launch", { headless: true });
        await s3.call("browser_navigate", { url: html("long2.html", `<body><textarea id='t'></textarea></body>`) });
        await s3.call("browser_click", { selector: "#t" });
        const typing = s3.call("browser_type", { text: "é".repeat(400) });
        await sleepMs(900);
        writeFileSync(blocker, "");
        const res = await typing;
        rmSync(blocker, { force: true });
        const m = /(\d+) of 400 character/.exec(say(res));
        check("browser_type: the stop file can no longer be checked while a text is being typed → the rest is not typed; the error names that, not a stop by the person",
          Boolean(res?.isError) && /stop_check_error: could not check/.test(say(res)) && !/user_stopped|appeared/.test(say(res)) && Boolean(m) && Number(m[1]) > 0 && Number(m[1]) < 400 && /delivery=unknown/.test(say(res)), say(res).slice(0, 280));
      } finally { s3.proc.kill(); }
    }
    // (more checks of this block go above this line)
  } finally { s.proc.kill(); web.close(); try { rmSync(dir, { recursive: true, force: true }); } catch {} }
}
// 10b. t07 CI 安全门禁（各起独立 server 进程）：READ_ONLY 优先拒 cdp_port / 未记录端口需 ALLOW_CDP=any / browser_scroll direction 校验
{
  const s = await spawnServer({ NORACU_READ_ONLY: "1", NORACU_ALLOW_CDP: "1" });
  try {
    const r = await s.call("browser_launch", { cdp_port: 9 });
    const txt = String(r?.content?.[0]?.text || "");
    check("t07：READ_ONLY + ALLOW_CDP=1 拒绝 browser_launch cdp_port", r?.isError && txt.includes("blocked by NORACU_READ_ONLY=1") && txt.includes("delivery=not_delivered, retry=safe"), txt.slice(0, 90));
  } finally { s.proc.kill(); }
}
{
  const s = await spawnServer({ NORACU_ALLOW_CDP: "1" });
  try {
    const r = await s.call("browser_launch", { cdp_port: 9222 });
    const txt = String(r?.content?.[0]?.text || "");
    check("t07：ALLOW_CDP=1 拒绝未由本进程打开的 cdp_port（提示 NORACU_ALLOW_CDP=any）", r?.isError && txt.includes("NORACU_ALLOW_CDP=any") && txt.includes("delivery=not_delivered, retry=safe"), txt.slice(0, 90));
  } finally { s.proc.kill(); }
}
{
  const s = await spawnServer();
  try {
    const r = await s.call("browser_scroll", { direction: "sideways" });
    const txt = String(r?.content?.[0]?.text || "");
    check("t07：validateArgs 拒绝 browser_scroll 非法 direction", r?.isError && txt.includes("up|down|left|right") && txt.includes("delivery=not_delivered, retry=safe"), txt.slice(0, 90));
    // t07 review: browser_type is capped at 2000 chars so its time budget always covers the 20 ms/key typing
    const t = await s.call("browser_type", { text: "x".repeat(2001) });
    const tt = String(t?.content?.[0]?.text || "");
    check("t07 复核：browser_type 超过 2000 字符被校验层拒（指向 browser_fill）", t?.isError && tt.includes("1-2000") && tt.includes("browser_fill") && tt.includes("delivery=not_delivered, retry=safe"), tt.slice(0, 90));
  } finally { s.proc.kill(); }
}
// 10c. t10 CI 安全门禁（各起独立 server 进程）：READ_ONLY 通知与 web_accessibility 门禁、通知空串校验、AXSecureTextField 不回显、全量 validateArgs
{
  const { mkdtempSync, writeFileSync, readFileSync: rf, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "noracu-e2e-"));
  const axLog = join(dir, "ax-ro.jsonl");
  const fake = join(dir, "fake-ax-ro");
  writeFileSync(fake, `#!/usr/bin/env node
const fs = require("fs");
let d = ""; process.stdin.on("data", (c) => (d += c)); process.stdin.on("end", () => {
  const req = JSON.parse(d);
  fs.appendFileSync(${JSON.stringify(axLog)}, JSON.stringify({ op: req.op, web_accessibility: req.web_accessibility }) + "\\n");
  const base = { ok: true, app: "Fake", bundle_id: "test.fake", pid: 4242, surface: "window", complete: true, visited: 1, ms: 1, container: { kind: "window", wid: 1, title: "W", subrole: "", frame: [0, 0, 100, 100], n: 0 }, nodes: [] };
  process.stdout.write(JSON.stringify(base));
});
`, { mode: 0o700 });
  const s = await spawnServer({ NORACU_READ_ONLY: "1", NORACU_AX_ENGINE: fake });
  try {
    const say = (r) => String(r?.content?.[0]?.text || "");
    const wNotif = await s.call("mac_wait", { condition: "notification" });
    const nList = await s.call("mac_notifications", {});
    const cRead = await s.call("mac_clipboard_read", {});
    const axSt = await s.call("mac_ax_state", { app: "Fake", web_accessibility: true });
    const axFd = await s.call("mac_find", { app: "Fake", role: "button", web_accessibility: true });
    const logged = rf(axLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    check("t10：READ_ONLY 拒绝 mac_wait notification / mac_notifications / mac_clipboard_read",
      wNotif?.isError && say(wNotif).includes("NORACU_READ_ONLY")
        && nList?.isError && say(nList).includes("NORACU_READ_ONLY")
        && cRead?.isError && say(cRead).includes("NORACU_READ_ONLY"),
      `${say(wNotif).slice(0, 45)} | ${say(nList).slice(0, 40)}`);
    check("t10：READ_ONLY 下 mac_ax_state / mac_find 强制 web_accessibility=false（不改目标应用无障碍模式）",
      !axSt?.isError && !axFd?.isError && logged.length === 2 && logged.every((x) => x.web_accessibility === false),
      JSON.stringify(logged));
  } finally { s.proc.kill(); rmSync(dir, { recursive: true, force: true }); }
}
{
  const s = await spawnServer();
  try {
    const say = (r) => String(r?.content?.[0]?.text || "");
    const nEmptyId = await s.call("mac_notifications", { action: "dismiss", id: "" });
    const nEmptyApp = await s.call("mac_notifications", { action: "dismiss", index: 1, expected_app: "" });
    const nEmptyTitle = await s.call("mac_notifications", { action: "dismiss", index: 1, expected_title: "" });
    const badRegion = await s.call("mac_screenshot", { region: { x: 0, y: 0, w: -5, h: 10 } });
    const badKeyMissing = await s.call("mac_key", {});
    const badScrollPages = await s.call("mac_scroll", { pages: 0 });
    const badWinApp = await s.call("mac_window", { action: "focus", app: "" });
    const badBShot = await s.call("browser_screenshot", { format: "bmp" });
    const badBClip = await s.call("browser_screenshot", { clip: { x: 0, y: 0, width: 0, height: 10 } });
    const badBRead = await s.call("browser_read", { selector: "" });
    const badWebAx = await s.call("mac_ax_state", { web_accessibility: "yes" });
    check("t10：validateArgs 拒绝 mac_notifications 空 id / expected_app / expected_title",
      nEmptyId?.isError && nEmptyApp?.isError && nEmptyTitle?.isError && /non-empty string/.test(say(nEmptyId)),
      say(nEmptyId).slice(0, 80));
    check("t10：validateArgs 覆盖截图裁剪 / 缺省键名 / 滚动页数 / 窗口空 app / 浏览器截图与读取参数",
      [badRegion, badKeyMissing, badScrollPages, badWinApp, badBShot, badBClip, badBRead, badWebAx].every((r) => r?.isError),
      `${say(badRegion).slice(0, 40)} | ${say(badBShot).slice(0, 40)}`);
  } finally { s.proc.kill(); }
}
{
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "noracu-e2e-"));
  const fake = join(dir, "fake-ax-sec");
  writeFileSync(fake, `#!/usr/bin/env node
let d = ""; process.stdin.on("data", (c) => (d += c)); process.stdin.on("end", () => {
  const req = JSON.parse(d); const say = (o) => process.stdout.write(JSON.stringify(o));
  if (req.op === "snapshot") return say({ ok: true, app: "Auth", bundle_id: "test.auth", pid: 4242, surface: "window", complete: true, visited: 1, ms: 1, container: { kind: "window", wid: 1, title: "Sign In", subrole: "", frame: [0, 0, 200, 100], n: 0 }, nodes: [{ d: 1, role: "AXTextField", subrole: "AXSecureTextField", path: [0], fp: { role: "AXTextField", subrole: "AXSecureTextField", id: "pw", name: "Password" }, title: "Password", frame: [10, 10, 120, 22], interactive: true }] });
  if (req.op === "frontmost") return say({ ok: true, front: { pid: 4242, name: "Auth", bundle: "test.auth" }, target: { pid: 4242, name: "Auth", bundle: "test.auth" }, match: true });
  if (req.op === "set_value") return say({ ok: true, mechanism: "semantic", role: "AXTextField", how: "path", delivery: "delivered_unverified", retry: "unsafe", secure: true, reason: "secure_field", via: "AXValue" });
  if (req.op === "notifications") return say({ ok: false, code: "NOTIFICATION_NOT_FOUND", message: "no notification with id gone-1 is on screen", delivery: "not_delivered", retry: "safe" });
  say({ ok: false, code: "INVALID_ARGS", message: "unexpected " + req.op });
});
`, { mode: 0o700 });
  const s = await spawnServer({ NORACU_AX_ENGINE: fake });
  try {
    const say = (r) => String(r?.content?.[0]?.text || "");
    const st = jsonOf(await s.call("mac_ax_state", { app: "Auth" }));
    const pwIdx = st.elements?.[0]?.i;
    const sv = await s.call("mac_set_value", { element_index: pwIdx, value: "top-secret-pw-99" });
    const nf = await s.call("mac_notifications", { action: "dismiss", id: "gone-1" });
    const cliPy = readFileSync(new URL("../imctl/src/imctl/cli.py", import.meta.url), "utf8");
    check("t10：mac_set_value 密码框不回显明文（显示 secure field — value not shown）；imctl type 不回显文本；消失通知报 notification_not_found",
      !sv?.isError && say(sv).includes("(secure field — value not shown)") && !say(sv).includes("top-secret-pw-99")
        && nf?.isError && say(nf).startsWith("ERROR: notification_not_found:")
        && !cliPy.includes("typed {args.text!r}") && cliPy.includes("typed {len(args.text)} chars"),
      `${say(sv).slice(0, 75)} | ${say(nf).slice(0, 45)}`);
  } finally { s.proc.kill(); rmSync(dir, { recursive: true, force: true }); }
}

// 11a. 0.1.1：imctl 随包附带 —— 包内 imctl/src/imctl/cli.py 必须存在（CI 安全：只查文件系统）
check("imctl bundled (imctl/src/imctl/cli.py)", existsSync(new URL("../imctl/src/imctl/cli.py", import.meta.url)));

// 11. G10（F9 dogfooding）：iPhone 层失败必须是工具错误 —— imctl 缺失时 phone_status 报 isError（CI 安全：不碰真实硬件）
{
  const s = await spawnServer({ NORACU_IMCTL_DIR: "/nonexistent" });
  try {
    const r = await s.call("phone_status");
    check("G10：imctl 缺失时 phone_status 报 isError", r?.isError && String(r?.content?.[0]?.text).includes("ERROR"), r?.content?.[0]?.text?.slice(0, 80));
    // R17 §2: a phone input that could not run says nothing was sent
    const t = await s.call("phone_tap", { x: 0.5, y: 0.5 });
    check("R17：phone_tap 无法运行 imctl → delivery=not_delivered, retry=safe", t?.isError && /delivery=not_delivered, retry=safe/.test(String(t?.content?.[0]?.text)), String(t?.content?.[0]?.text).slice(-90));
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

// 11b-2. imctl that prints without end is stopped; the answer says that the action may have run in part, as the
// one for a timeout does (CI-safe: a fake python, no hardware)
{
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "noracu-e2e-"));
  const fake = join(dir, "python3");
  writeFileSync(fake, "#!/bin/bash\nif [ \"$1\" = \"-c\" ]; then exit 0; fi\nhead -c 12000000 /dev/zero | tr '\\0' 'x'\nsleep 5\n", { mode: 0o700 });
  const s = await spawnServer({ NORACU_PYTHON: fake, NORACU_IMCTL_DIR: dir });
  try {
    const r = await s.call("phone_tap", { x: 0.5, y: 0.5 });
    const text = String(r?.content?.[0]?.text);
    check("phone_*: imctl stopped for printing more than 10 MB — the answer says the action may have partly run and to look before retrying",
      r?.isError && /imctl_output_overflow/.test(text) && /may have partly run/.test(text) && /phone_screenshot/.test(text), text.slice(0, 260));
  } finally { s.proc.kill(); rmSync(dir, { recursive: true, force: true }); }
}

// 11b-3. The python that was picked lacks a module: the install command in the answer names that python, not
// whatever "python3" is on the PATH (CI-safe: a fake python, no hardware)
{
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "noracu-e2e-"));
  const fake = join(dir, "python3");
  writeFileSync(fake, "#!/bin/bash\nif [ \"$1\" = \"-c\" ]; then exit 0; fi\necho \"ModuleNotFoundError: No module named 'Vision'\" >&2\nexit 1\n", { mode: 0o700 });
  const s = await spawnServer({ NORACU_PYTHON: fake, NORACU_IMCTL_DIR: dir });
  try {
    const r = await s.call("phone_status");
    const text = String(r?.content?.[0]?.text);
    check("phone_*: a missing python module — the install command names the python that was picked",
      r?.isError && /is missing the Vision module/.test(text) && text.includes(`${fake} -m pip install pyobjc-framework-Quartz`), text.slice(0, 300));
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

// Playwright's Chromium is missing (an empty PLAYWRIGHT_BROWSERS_PATH): the first browser_launch answers
// browser_installing within the wait (shortened here) while the download goes on; one download at a time; one that
// failed after its call had answered is reported by the next browser_launch (CI safe: a stand-in installer)
{
  const { mkdtempSync, writeFileSync, readFileSync: rf, existsSync: ex, mkdirSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "noracu-e2e-"));
  const log = join(dir, "install.log");
  const cli = join(dir, "fake-playwright-cli.js");
  writeFileSync(cli, `require("fs").appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(" ") + "\\n");
setTimeout(() => { process.stderr.write("fake download failed"); process.exit(1); }, 1500);
`);
  mkdirSync(join(dir, "browsers")); mkdirSync(join(dir, "home"));
  const s = await spawnServer({ NORACU_CI: "1", NORACU_TEST_PLAYWRIGHT_CLI: cli, NORACU_TEST_CHROMIUM_WAIT_MS: "300", PLAYWRIGHT_BROWSERS_PATH: join(dir, "browsers"), HOME: join(dir, "home"), NORACU_LAYERS: "browser" });
  try {
    const say = (r) => String(r?.content?.[0]?.text || "");
    const t0 = Date.now();
    const first = await s.call("browser_launch", { headless: true });
    const ms = Date.now() - t0;
    const second = await s.call("browser_launch", { headless: true });   // the download still runs: no second one
    await new Promise((r) => setTimeout(r, 2000));                       // it has failed by now
    const third = await s.call("browser_launch", { headless: true });
    const runs = ex(log) ? rf(log, "utf8").trim().split("\n").length : 0;
    check("Chromium missing: browser_launch answers browser_installing within the wait while the download goes on (one at a time), and the next call reports the download that failed",
      first?.isError && /^ERROR: browser_installing: /.test(say(first)) && ms < 8000 && /^ERROR: browser_installing: /.test(say(second))
        && third?.isError && /auto-install failed.*fake download failed/.test(say(third)) && runs === 1,
      `${ms} ms | ${say(first).slice(0, 60)} | ${say(second).slice(0, 40)} | ${say(third).slice(0, 120)} | runs ${runs}`);
  } finally { s.proc.kill(); rmSync(dir, { recursive: true, force: true }); }
}

// the client cancels a running mac_wait and a running phone_type → the engine / imctl child is stopped at
// once (SIGTERM), neither call is answered, and the trace logs both with code cancelled; a phone_type still waiting
// in the queue does not run and is logged cancelled_queued (CI safe: a fake engine and a fake python)
{
  const { mkdtempSync, writeFileSync, readFileSync: rf, existsSync: ex, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "noracu-e2e-"));
  const log = join(dir, "events.log");
  const trace = join(dir, "trace.jsonl");
  const fakePy = join(dir, "python3");
  writeFileSync(fakePy, `#!/bin/bash\nif [ "$1" = "-c" ]; then exit 0; fi\ntrap 'echo imctl-term >> "${log}"; exit 143' TERM\necho imctl-run >> "${log}"\nsleep 20 &\nwait $!\necho imctl-done >> "${log}"\n`, { mode: 0o700 });
  const fakeAx = join(dir, "fake-ax");
  writeFileSync(fakeAx, `#!/bin/bash\ntrap 'echo ax-term >> "${log}"; exit 143' TERM\ncat > /dev/null\necho ax-run >> "${log}"\nsleep 20 &\nwait $!\necho ax-done >> "${log}"\n`, { mode: 0o700 });
  const s = await spawnServer({ NORACU_PYTHON: fakePy, NORACU_IMCTL_DIR: dir, NORACU_AX_ENGINE: fakeAx, NORACU_TRACE: trace, NORACU_USER_IDLE_S: "0" });
  try {
    const replied = new Set();
    s.proc.stdout.on("data", (d) => { for (const line of String(d).split("\n")) { try { const m = JSON.parse(line); if (m.id !== undefined) replied.add(m.id); } catch {} } });
    const send = (m) => s.proc.stdin.write(JSON.stringify(m) + "\n");
    const call = (id, name, args) => send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    const cancel = (id) => send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "test" } });
    const lines = () => (ex(log) ? rf(log, "utf8").trim().split("\n").filter(Boolean) : []);
    const until = async (f, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (f()) return true; await new Promise((r) => setTimeout(r, 50)); } return f(); };
    call(991601, "mac_wait", { condition: "app_gone", app: "Nothing", timeout_ms: 20000 });
    call(991602, "phone_type", { text: "hello there" });
    call(991603, "phone_type", { text: "second one" });
    await until(() => lines().includes("ax-run") && lines().includes("imctl-run"), 5000);
    const t0 = Date.now();
    cancel(991601); cancel(991602); cancel(991603);
    const stopped = await until(() => lines().includes("ax-term") && lines().includes("imctl-term"), 4000);
    const ms = Date.now() - t0;
    // the queued phone_type's turn comes once the stopped imctl has been reaped: wait for its trace line (a loaded
    // machine takes longer than the 0.8 s this waited at first), at most 6 s
    const traced = () => (ex(trace) ? rf(trace, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
    await until(() => traced().some((x) => x.code === "cancelled_queued"), 6000);
    await new Promise((r) => setTimeout(r, 300));  // and a moment for anything that should not happen
    const pong = await s.rpc("ping");
    const tr = traced();
    const codes = tr.map((x) => `${x.tool}:${x.error ? x.code : "ok"}`);
    const ok = stopped && ms < 3000 && lines().filter((l) => l === "imctl-run").length === 1 && !lines().some((l) => /done/.test(l))
      && ![991601, 991602, 991603].some((id) => replied.has(id)) && pong?.result !== undefined
      && codes.includes("mac_wait:cancelled") && codes.includes("phone_type:cancelled") && codes.includes("phone_type:cancelled_queued");
    check("the client cancels a running mac_wait and phone_type: their engine / imctl is stopped at once, neither is answered, the trace logs cancelled; the queued phone_type does not run and logs cancelled_queued",
      ok, `${ms} ms | ${lines().join(",")} | ${codes.join(" ")} | replied ${[...replied].join(",")}`);
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

// 0.2.2 本机：命中检测到物理点击之间的空档（Reddit r/mcp 评论建议的可重复测试）。单独起一个带
// NORACU_TEST_PHYSICAL_GAP_MS 的 server：最后一次复查之后、点击之前等待，并在 stderr 报告；测试在这一刻
// 遮挡 / 移走 / 关闭目标窗口。点击只会落在测试自建的 TextEdit 文档上（目标下面垫着一个同尺寸的文档）。
// 断言：受干扰的点击结果永远不是 delivered_verified；app 级与 window 级快照的元素在窗口关掉重开后失效。
if (LOCAL && TE_READY()) {
  const GAP_MS = 2500;
  const te = (lines) => spawnSync("/usr/bin/osascript", lines.flatMap((l) => ["-e", l]), { encoding: "utf8", timeout: 15000 });
  const BOUNDS = "{160, 140, 660, 540}";
  const mkDoc = (name) => te(['tell application "TextEdit"', `make new document with properties {name:"${name}", text:"${name} text"}`, `set bounds of front window to ${BOUNDS}`, "activate", "end tell"]);
  const closeDoc = (name) => te([`tell application "TextEdit" to close (every document whose name contains "${name}") saving no`]);
  const gs = spawn("node", [new URL("../src/server.mjs", import.meta.url).pathname], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, NORACU_TEST_PHYSICAL_GAP_MS: String(GAP_MS) } });
  let gb = "", gerr = "", gid = 0;
  const gpend = new Map();
  gs.stdout.on("data", (d) => { gb += d; let i; while ((i = gb.indexOf("\n")) >= 0) { const l = gb.slice(0, i); gb = gb.slice(i + 1); try { const m = JSON.parse(l); gpend.get(m.id)?.(m); gpend.delete(m.id); } catch {} } });
  gs.stderr.on("data", (d) => { gerr += d; });
  const grpc = (method, params = {}) => new Promise((r) => { const n = ++gid; gpend.set(n, r); gs.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"); });
  const gcall = async (name, args) => (await grpc("tools/call", { name, arguments: args })).result;
  const gsay = (r) => String(r?.content?.[0]?.text ?? "");
  const gapSeen = async (since) => { for (let k = 0; k < 150; k++) { if (gerr.slice(since).includes("test gap:")) return true; await sleepMs(100); } return false; };
  await grpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "gap-test" } });
  // a fresh target over a backstop of the same size; returns the target text area's element_index
  const setup = async () => {
    closeDoc("noracu-gap-");
    mkDoc("noracu-gap-back"); await sleepMs(600);
    mkDoc("noracu-gap-target"); await sleepMs(900);
    for (let k = 0; k < 3; k++) {
      const st = jsonOf(await gcall("mac_ax_state", { app: "TextEdit", window: "noracu-gap-target", interactive: true }));
      const i = (st.elements || []).find((e) => /textarea/i.test(e.role))?.i;
      if (Number.isInteger(i)) return i;
      await sleepMs(700);
    }
    return undefined;
  };
  const clickWithGap = async (idx, interfere) => {
    const since = gerr.length;
    const pending = gcall("mac_click", { element_index: idx, mechanism: "physical" });
    const seen = await gapSeen(since);
    if (seen) interfere();
    return { seen, r: await pending };
  };
  const notVerified = (x) => x.seen && !x.r?.isError && /via physical click/.test(gsay(x.r)) && !/delivery=delivered_verified/.test(gsay(x.r));
  // R31 (0.2.4): an interfered case counts only when the click was sent in the gap. When the interference
  // lands before the last pre-send check, the click is refused with nothing sent — that attempt says nothing
  // about the after-click verdict, so it is repeated (up to 5 attempts). Any delivered_verified fails at once;
  // a refusal that does not say delivery=not_delivered fails too. Every result is logged in full.
  const gapCase = async (label, interfere, after = () => {}, extra = () => true) => {
    let last = "";
    for (let k = 1; k <= 5; k++) {
      const idx = await setup();
      if (!Number.isInteger(idx)) { console.log(`   gap ${label} attempt ${k}: fixture: no text area in noracu-gap-target`); continue; }
      const x = await clickWithGap(idx, interfere);
      after();
      last = gsay(x.r);
      console.log(`   gap ${label} attempt ${k}: seen=${x.seen} isError=${Boolean(x.r?.isError)} | ${last}`);
      if (/delivery=delivered_verified/.test(last)) return { ok: false, why: `delivered_verified on attempt ${k}` };
      if (notVerified(x)) return extra(last) ? { ok: true, why: `sent, not verified (attempt ${k})` } : { ok: false, why: `sent, not verified, but the note is missing (attempt ${k})` };
      if (!(x.r?.isError && /delivery=not_delivered/.test(last))) return { ok: false, why: `neither sent nor refused with delivery=not_delivered (attempt ${k})` };
    }
    return { ok: false, why: `inconclusive: refused before sending on every attempt; last: ${last.slice(0, 60)}` };
  };
  try {
    let idx = await setup();
    const ctl = await clickWithGap(idx, () => {});
    check("0.2.2 本机空档：对照（空档里不干扰）→ 点击发出，未报错", Number.isInteger(idx) && ctl.seen && !ctl.r?.isError && /via physical click/.test(gsay(ctl.r)), gsay(ctl.r).slice(0, 140));
    const occ = await gapCase("cover", () => mkDoc("noracu-gap-cover"), () => closeDoc("noracu-gap-cover"), (t) => /on top at/.test(t));
    check("0.2.2 本机空档：空档里被另一个窗口遮挡 → 不报 delivered_verified，并说明上面是谁", occ.ok, occ.why);
    const mov = await gapCase("move", () => te(['tell application "TextEdit" to set bounds of (first window whose name contains "noracu-gap-target") to {760, 140, 1260, 540}']));
    check("0.2.2 本机空档：空档里目标窗口被移走 → 不报 delivered_verified", mov.ok, mov.why);
    const gone = await gapCase("close", () => closeDoc("noracu-gap-target"));
    check("0.2.2 本机空档：空档里目标窗口被关闭 → 不报 delivered_verified", gone.ok, gone.why);
    // a window closed and reopened with the same name, text and bounds: an app-level index must not carry over
    closeDoc("noracu-gap-"); mkDoc("noracu-gap-back"); await sleepMs(600); mkDoc("noracu-gap-target"); await sleepMs(900);
    const fa = jsonOf(await gcall("mac_find", { app: "TextEdit", surface: "app", role: "textarea", value: "noracu-gap-target text" }));
    const ai = fa.matches?.[0]?.i;
    const okBefore = await gcall("mac_get", { element_index: ai });
    closeDoc("noracu-gap-target"); await sleepMs(500); mkDoc("noracu-gap-target"); await sleepMs(900);
    const after = await gcall("mac_get", { element_index: ai });
    check("0.2.2 本机：app 级索引所在窗口关掉重开（同名同内容同位置）→ element_no_longer_valid",
      Number.isInteger(ai) && !okBefore?.isError && after?.isError && /element_no_longer_valid/.test(gsay(after)), `${gsay(okBefore).slice(0, 60)} | ${gsay(after).slice(0, 140)}`);
    // the same for an index from a window-level snapshot (the default surface): the window is found again only
    // by its CGWindowID, so a reopened look-alike is stale for a read and for an action alike (nothing is sent)
    const wi = await setup();
    const wBefore = await gcall("mac_get", { element_index: wi });
    closeDoc("noracu-gap-target"); await sleepMs(500); mkDoc("noracu-gap-target"); await sleepMs(900);
    const wGet = await gcall("mac_get", { element_index: wi });
    const sinceClick = gerr.length;
    const wClick = await gcall("mac_click", { element_index: wi, mechanism: "physical" });
    const wSent = gerr.slice(sinceClick).includes("test gap:");
    check("0.2.2 本机：window 级索引所在窗口关掉重开（同名同内容同位置）→ mac_get 与 mac_click 都报 element_no_longer_valid，点击未发出",
      Number.isInteger(wi) && !wBefore?.isError && wGet?.isError && /element_no_longer_valid/.test(gsay(wGet)) && wClick?.isError && /element_no_longer_valid/.test(gsay(wClick)) && !/delivery=delivered_/.test(gsay(wClick)) && !wSent,
      `${gsay(wBefore).slice(0, 60)} | ${gsay(wGet).slice(0, 120)} | ${gsay(wClick).slice(0, 160)} | gap hook fired: ${wSent}`);
  } finally {
    closeDoc("noracu-gap-");
    gs.kill();
  }
} else if (LOCAL) check("0.2.2 本机空档：测试文档就绪", false, "TextEdit test document missing");

// B2 本机：元素消失后用旧 index —— element_no_longer_valid，什么都不发（关文档本身就是测试收尾）
if (LOCAL) {
  // by window id: TextEdit may also show a "… copy" window whose title contains the test document's name
  const wl = TE_READY() ? jsonOf(await call("mac_windows", { app: "TextEdit" })) : {};
  // R31 (0.2.4): TextEdit can show more than one window with this title; try each one
  const wids = (wl.windows || []).filter((w) => String(w.title ?? "").startsWith(TE_DOC)).map((w) => w.id);
  let bold;
  for (const wid of wids) {
    const st = jsonOf(await call("mac_ax_state", { app: "TextEdit", window_id: wid, interactive: true }));
    bold = (st.elements || []).find((e) => e.title === "bold")?.i;
    if (Number.isInteger(bold)) break;
  }
  // "contains": TextEdit may have made a "… copy" of the test document after the format changes above
  spawnSync("/usr/bin/osascript", ["-e", `tell application "TextEdit" to close (every document whose name contains "${TE_DOC}") saving no`], { timeout: 10000 });
  await sleepMs(500);
  if (!Number.isInteger(bold)) console.log(`   B2 fixture: TextEdit windows (on and off screen): ${JSON.stringify((jsonOf(await call("mac_windows", { app: "TextEdit", include_offscreen: true })).windows || []).filter((w) => w.title).map((w) => [w.title, w.onscreen]))}`);
  const r = Number.isInteger(bold) ? await call("mac_click", { element_index: bold }) : null;
  if (r) console.log(`   B2 result: ${String(r?.content?.[0]?.text)}`);
  check("B2：元素已消失 → element_no_longer_valid（不误点）", r?.isError && /element_no_longer_valid/.test(String(r?.content?.[0]?.text)) && /delivery=not_delivered/.test(String(r?.content?.[0]?.text)),
    r ? String(r?.content?.[0]?.text).slice(0, 100) : `fixture: bold index missing (TextEdit windows titled ${TE_DOC}…: ${JSON.stringify(wids)})`);
} else skipLocal("B2：元素已消失 → element_no_longer_valid（不误点）");

// 0.3.0（RF-3 / GH-1，CI 安全）：电脑前的人优先。假的 ioreg（NORACU_IOREG）按顺序报出"上一次键鼠事件的时刻"，
// AX 引擎和 cliclick 也是假的 —— 没有任何事件发到这台 Mac 上
{
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "noracu-idle-"));
  const fake = join(dir, "fake-ax-engine"), fakeClick = join(dir, "cliclick"), fakeIoreg = join(dir, "ioreg"), clickLog = join(dir, "cliclick.log"), ctl = join(dir, "idle.json");
  const fakeWheel = join(dir, "wheel"), wheelLog = join(dir, "wheel.log"), wheelFail = join(dir, "wheel.fail");
  writeFileSync(fake, FAKE_AX, { mode: 0o700 });
  writeFileSync(fakeClick, `#!/bin/bash\necho "$@" >> "${clickLog}"\n`, { mode: 0o700 });
  writeFileSync(fakeWheel, `#!/bin/bash\necho "wheel $#" >> "${wheelLog}"\nif [ -f "${wheelFail}" ]; then echo "the event target was not found" >&2; exit 1; fi\n`, { mode: 0o700 });
  // every run answers with the next time of the list (the last one repeats); a time in the future reads as "just now"
  writeFileSync(fakeIoreg, `#!/usr/bin/env node
const fs = require("fs");
const c = JSON.parse(fs.readFileSync(${JSON.stringify(ctl)}, "utf8"));
const at = c.at[Math.min(c.n, c.at.length - 1)];
c.n++; fs.writeFileSync(${JSON.stringify(ctl)}, JSON.stringify(c));
if (c.touch) fs.writeFileSync(c.touch, "");
if (c.delay) { const end = Date.now() + c.delay; while (Date.now() < end) { /* a slow ioreg */ } }
console.log('    | |   "HIDIdleTime" = ' + Math.max(0, Math.round((Date.now() - at) * 1e6)));
`, { mode: 0o700 });
  const idle = (...at) => writeFileSync(ctl, JSON.stringify({ at, n: 0 }));
  const idleTouching = (file, ...at) => writeFileSync(ctl, JSON.stringify({ at, n: 0, touch: file }));
  const idleSlow = (delay, ...at) => writeFileSync(ctl, JSON.stringify({ at, n: 0, delay }));
  const samples = () => JSON.parse(readFileSync(ctl, "utf8")).n;
  const QUIET = () => Date.now() - 60000, NOW = () => Date.now() + 3600000;
  idle(QUIET());
  for (const f of [fake, fakeClick, fakeIoreg]) { try { execFileSync(f, [], { input: '{"op":"warm"}', timeout: 30000 }); } catch {} }
  const read = (f) => { try { return readFileSync(f, "utf8"); } catch { return ""; } };
  const say = (r) => String(r?.content?.[0]?.text);
  const s = await spawnServer({ NORACU_AX_ENGINE: fake, NORACU_CLICLICK: fakeClick, NORACU_IOREG: fakeIoreg, NORACU_TEST_WHEEL: fakeWheel, NORACU_AX_TIMEOUT_MS: "3000", NORACU_USER_IDLE_S: "2", NORACU_NO_BGPOST: "1" });
  try {
    // RF-3: a call that sent nothing must not make the person's event of that moment look like noracu's own
    writeFileSync(clickLog, ""); idle(QUIET());
    const t1 = Date.now();
    const refused = await s.call("mac_click", { x: 600, y: 100 });   // occluded: refused, nothing sent
    idle(t1, NOW());                                                  // the person used the mouse while that call ran, and goes on
    const after = await s.call("mac_click", { x: 100, y: 100 });
    check("RF-3：一次什么都没发的调用（occluded）之后，那一刻有人动过键鼠 → 下一个输入返回 user_active、不发（那次事件不算 noracu 自己的）",
      refused?.isError && /^ERROR: occluded: /.test(say(refused)) && after?.isError && /^ERROR: user_active: /.test(say(after)) && read(clickLog) === "",
      `${say(refused).slice(0, 40)} | ${say(after).slice(0, 60)} | click=${JSON.stringify(read(clickLog))}`);
    // …and a call that did send still counts: the event of that moment is noracu's own, the next call goes ahead
    idle(QUIET()); writeFileSync(clickLog, "");
    const t2 = Date.now();
    const sent = await s.call("mac_click", { x: 100, y: 100 });
    idle(t2 + 1);
    const next = await s.call("mac_click", { x: 100, y: 10 });
    check("RF-3：发出过输入的调用照旧算数 —— 那一刻的事件是 noracu 自己的，下一个输入照常发出",
      !sent?.isError && !next?.isError && /c:100,100/.test(read(clickLog)) && /c:100,10\n/.test(read(clickLog)),
      `${say(sent).slice(0, 50)} | ${say(next).slice(0, 60)} | click=${JSON.stringify(read(clickLog))}`);
    // the same for input that does not go through cliclick (a named key through the engine's HID path)
    idle(QUIET());
    const t3 = Date.now();
    const key1 = await s.call("mac_key", { key: "return" });
    idle(t3 + 1);
    const key2 = await s.call("mac_key", { key: "return" });
    check("RF-3：不经 cliclick 发出的输入（引擎按键）同样算数 —— 下一个输入不被当成有人在用", !key1?.isError && /^pressed return/.test(say(key1)) && !key2?.isError && /^pressed return/.test(say(key2)),
      `${say(key1).slice(0, 60)} | ${say(key2).slice(0, 60)}`);
    // GH-1: quiet when the call left the queue, in use right before the pointer is taken → nothing is sent
    idle(QUIET(), NOW()); writeFileSync(clickLog, "");
    const taken = await s.call("mac_click", { x: 100, y: 100 });
    check("GH-1：出队时没人用键鼠、动指针前一刻有人用了 → user_active，一个事件都不发；两次检查都做了；delivery 只写一遍",
      taken?.isError && /^ERROR: user_active: /.test(say(taken)) && say(taken).split("delivery=not_delivered").length === 2 && read(clickLog) === "" && samples() === 3,
      `${say(taken).slice(0, 70)} | samples=${samples()} | click=${JSON.stringify(read(clickLog))}`);
    idle(QUIET()); writeFileSync(clickLog, "");
    const calm = await s.call("mac_click", { x: 100, y: 100 });
    check("GH-1：两次检查都安静 → 照常点击", !calm?.isError && /c:100,100/.test(read(clickLog)) && samples() === 2, `${say(calm).slice(0, 60)} | samples=${samples()}`);
    // a drag is refused the same way, and no stray mouse-up follows
    const one = jsonOf(await s.call("mac_ax_state", { app: "Fake" })).elements?.find((e) => e.title === "One")?.i;
    idle(QUIET()); writeFileSync(clickLog, "");
    const dragOk = await s.call("mac_drag", { from_index: one, to_index: one });
    const dragSent = read(clickLog);
    idle(QUIET(), NOW()); writeFileSync(clickLog, "");
    const dragNo = await s.call("mac_drag", { from_index: one, to_index: one });
    check("GH-1：拖动同理 —— 安静时发出（dd/du），动指针前有人用了键鼠 → user_active，不发、也不补发松开鼠标",
      !dragOk?.isError && /dd:/.test(dragSent) && /du:/.test(dragSent) && dragNo?.isError && /^ERROR: user_active: /.test(say(dragNo)) && read(clickLog) === "",
      `${say(dragOk).slice(0, 50)} | ${say(dragNo).slice(0, 50)} | click=${JSON.stringify(read(clickLog))}`);
    // S4A-s1-me-1 / -reviewer-1: an input that posts no keyboard or mouse event (AXPress) does not make the
    // person's event of that moment look like noracu's own
    idle(QUIET()); writeFileSync(clickLog, "");
    const t4 = Date.now();
    const pressed = await s.call("mac_click", { element_index: one, mechanism: "semantic" });
    idle(t4 + 1, NOW());                                              // the person moved the mouse while it ran, and goes on
    const afterPress = await s.call("mac_click", { x: 100, y: 100 });
    check("S4A：语义点击（AXPress，不发键鼠事件）之后，那一刻有人动过键鼠 → 下一个输入 user_active、不发",
      !pressed?.isError && afterPress?.isError && /^ERROR: user_active: /.test(say(afterPress)) && read(clickLog) === "",
      `${say(pressed).slice(0, 50)} | ${say(afterPress).slice(0, 60)} | click=${JSON.stringify(read(clickLog))}`);
    // a wheel scroll on an element is noracu's own event too: the next input is not taken for the person's
    idle(QUIET()); writeFileSync(clickLog, ""); writeFileSync(wheelLog, "");
    const oneNow = jsonOf(await s.call("mac_ax_state", { app: "Fake" })).elements?.find((e) => e.title === "One")?.i;
    const t5 = Date.now();
    const wheel = await s.call("mac_scroll", { element_index: oneNow, direction: "down" });
    idle(t5 + 1);                                                     // the wheel event of that moment
    const afterWheel = await s.call("mac_click", { x: 100, y: 100 });
    check("mac_scroll on an element: the wheel event is noracu's own — the next input goes out instead of being refused as user_active",
      !wheel?.isError && /^wheel /.test(read(wheelLog)) && !afterWheel?.isError && /c:100,100/.test(read(clickLog)),
      `${say(wheel).slice(0, 60)} | ${say(afterWheel).slice(0, 70)} | wheel=${JSON.stringify(read(wheelLog))}`);
    // keyboard events get the same late check as the pointer
    idle(QUIET(), NOW()); writeFileSync(clickLog, "");
    const keyTaken = await s.call("mac_key", { key: "shift-z" });      // keys sent by cliclick
    const keySamples = samples() - 1;                                  // the second look after the wait
    idle(QUIET(), NOW());
    const engKeyTaken = await s.call("mac_key", { key: "return" });    // a key sent by the engine
    check("keyboard: quiet when the call left the queue, in use right before the key events → user_active, nothing sent (cliclick keys and engine keys alike)",
      keyTaken?.isError && /^ERROR: user_active: /.test(say(keyTaken)) && /delivery=not_delivered, retry=safe/.test(say(keyTaken)) && read(clickLog) === "" && keySamples === 2
        && engKeyTaken?.isError && /^ERROR: user_active: /.test(say(engKeyTaken)) && samples() === 3,
      `${say(keyTaken).slice(0, 60)} | samples=${keySamples} | ${say(engKeyTaken).slice(0, 60)} | samples=${samples()} | click=${JSON.stringify(read(clickLog))}`);
    // a click and then keystrokes in one call: the click is noracu's own event, not the person's; the person
    // taking the keyboard after the click stops the keystrokes, and the result says that the click went out
    const frontOne = jsonOf(await s.call("mac_ax_state", { app: "Front" })).elements?.find((e) => e.title === "One")?.i;
    writeFileSync(clickLog, "");
    const t6 = Date.now();
    idle(QUIET(), QUIET(), t6 + 1);                                   // third reading: an event during this call — its own click
    const typed = await s.call("mac_type", { element_index: frontOne, text: "abc", mechanism: "physical" });
    const typedLog = read(clickLog);
    idle(QUIET(), QUIET(), NOW()); writeFileSync(clickLog, "");       // third reading: the person, after the click
    const cutShort = await s.call("mac_type", { element_index: frontOne, text: "abc", mechanism: "physical" });
    check("mac_type, a click then keystrokes: the click of the same call is not taken for the person; the person taking over after the click stops the keystrokes, and the result says an earlier part went out",
      !typed?.isError && /c:50,50/.test(typedLog) && /t:abc/.test(typedLog)
        && cutShort?.isError && /^ERROR: user_active: /.test(say(cutShort)) && /an earlier part of it was/.test(say(cutShort)) && /delivery=unknown, retry=unsafe/.test(say(cutShort)) && /c:50,50/.test(read(clickLog)) && !/t:abc/.test(read(clickLog)),
      `${say(typed).slice(0, 60)} | ${JSON.stringify(typedLog)} | ${say(cutShort).slice(0, 150)} | ${JSON.stringify(read(clickLog))}`);
    idle(QUIET(), NOW()); writeFileSync(wheelLog, "");
    const wheelTaken = await s.call("mac_scroll", { element_index: oneNow, direction: "down" });
    check("mac_scroll on an element: quiet when the call left the queue, in use right before the wheel event → user_active, no wheel event",
      wheelTaken?.isError && /^ERROR: user_active: /.test(say(wheelTaken)) && read(wheelLog) === "" && samples() === 3,
      `${say(wheelTaken).slice(0, 70)} | samples=${samples()} | wheel=${JSON.stringify(read(wheelLog))}`);
    // a window that came on top of the element's point since the hit test: no wheel event (it would scroll that window)
    idle(QUIET()); writeFileSync(wheelLog, "");
    const twoNow = jsonOf(await s.call("mac_ax_state", { app: "Fake" })).elements?.find((e) => e.title === "Two")?.i;
    const covered = await s.call("mac_scroll", { element_index: twoNow, direction: "down" });
    check("mac_scroll on an element: another window on top at its point at the late re-check → occluded, no wheel event",
      covered?.isError && /^ERROR: occluded: a window of "Other" came on top at 410,110/.test(say(covered)) && read(wheelLog) === "",
      `${say(covered).slice(0, 120)} | wheel=${JSON.stringify(read(wheelLog))}`);
    // an element with no window id of its own (a menu item, a menu bar item): what was on top at its point at
    // the hit test must still be on top right before the click
    idle(QUIET()); writeFileSync(clickLog, "");
    const menuOne = jsonOf(await s.call("mac_ax_state", { app: "MenuGone" })).elements?.find((e) => e.title === "One")?.i;
    const menuGone = await s.call("mac_click", { element_index: menuOne, mechanism: "physical" });
    const goneLog = read(clickLog);
    idle(QUIET()); writeFileSync(clickLog, "");
    const barOne = jsonOf(await s.call("mac_ax_state", { app: "BarItem" })).elements?.find((e) => e.title === "One")?.i;
    const barItem = await s.call("mac_click", { element_index: barOne, mechanism: "physical" });
    check("physical click on an element with no window id: another window on top at its point since the hit test (its menu closed) → occluded, nothing sent; the same window still on top (the menu bar, the window server's) → the click goes out",
      menuGone?.isError && /^ERROR: occluded: /.test(say(menuGone)) && goneLog === "" && !barItem?.isError && /c:40,205/.test(read(clickLog)),
      `${say(menuGone).slice(0, 120)} | ${JSON.stringify(goneLog)} | ${say(barItem).slice(0, 90)} | ${JSON.stringify(read(clickLog))}`);
    // whether the wheel script ran is read from how it ended, not from the words of its message
    const { chmodSync } = await import("node:fs");
    const oneWheel = jsonOf(await s.call("mac_ax_state", { app: "Fake" })).elements?.find((e) => e.title === "One")?.i;
    await sleepMs(200);
    idle(QUIET()); writeFileSync(clickLog, ""); writeFileSync(wheelLog, ""); writeFileSync(wheelFail, "");
    const t7 = Date.now();
    const wheelFailed = await s.call("mac_scroll", { element_index: oneWheel, direction: "down" });
    idle(t7 + 1);                                                     // the wheel event of that moment
    const afterFailed = await s.call("mac_click", { x: 100, y: 100 });
    rmSync(wheelFail);
    check("mac_scroll on an element: a wheel script that ran and failed (its message says \"not found\") → delivery=unknown, retry=unsafe, and its event counts as noracu's own",
      wheelFailed?.isError && /delivery=unknown, retry=unsafe/.test(say(wheelFailed)) && !/not_delivered/.test(say(wheelFailed)) && /^wheel /.test(read(wheelLog)) && !afterFailed?.isError && /c:100,100/.test(read(clickLog)),
      `${say(wheelFailed).slice(0, 110)} | ${say(afterFailed).slice(0, 60)} | wheel=${JSON.stringify(read(wheelLog))}`);
    const oneWheel2 = jsonOf(await s.call("mac_ax_state", { app: "Fake" })).elements?.find((e) => e.title === "One")?.i;
    await sleepMs(200);
    idle(QUIET()); writeFileSync(clickLog, ""); writeFileSync(wheelLog, ""); chmodSync(fakeWheel, 0o600);
    const t8 = Date.now();
    const wheelNoStart = await s.call("mac_scroll", { element_index: oneWheel2, direction: "down" });
    chmodSync(fakeWheel, 0o700);
    idle(t8 + 1, NOW());                                              // the person, while that call ran, and goes on
    const afterNoStart = await s.call("mac_click", { x: 100, y: 100 });
    check("mac_scroll on an element: a wheel script that could not be started → delivery=not_delivered, retry=safe, and nothing is stamped as noracu's own (the person's event of that moment still refuses the next input)",
      wheelNoStart?.isError && /could not be started/.test(say(wheelNoStart)) && /delivery=not_delivered, retry=safe/.test(say(wheelNoStart)) && read(wheelLog) === ""
        && afterNoStart?.isError && /^ERROR: user_active: /.test(say(afterNoStart)) && read(clickLog) === "",
      `${say(wheelNoStart).slice(0, 130)} | ${say(afterNoStart).slice(0, 60)} | click=${JSON.stringify(read(clickLog))}`);
    // audit S5A-s2-D-2: a left double / triple click through cliclick is its dc: / tc: verb, not two or three c:
    idle(QUIET()); writeFileSync(clickLog, "");
    const dbl = await s.call("mac_click", { x: 100, y: 100, count: 2 });
    const tri = await s.call("mac_click", { element_index: one, mechanism: "physical", count: 3 });
    check("审计 S5A：cliclick 的双击 / 三击用 dc: / tc:（不是连发 c:，那样应用收到的是单击）",
      !dbl?.isError && !tri?.isError && /^dc:100,100$/m.test(read(clickLog)) && /^tc:/m.test(read(clickLog)) && !/^c:/m.test(read(clickLog)),
      `${say(dbl).slice(0, 40)} | ${say(tri).slice(0, 40)} | click=${JSON.stringify(read(clickLog))}`);
    // audit S5A-s1-X-1: a stop file made while the idle time is read (ioreg) still stops the input
    const stopFile = join(dir, "stop-now");
    const s3 = await spawnServer({ NORACU_AX_ENGINE: fake, NORACU_CLICLICK: fakeClick, NORACU_IOREG: fakeIoreg, NORACU_AX_TIMEOUT_MS: "3000", NORACU_USER_IDLE_S: "2", NORACU_NO_BGPOST: "1", NORACU_STOP_FILE: stopFile });
    try {
      idleTouching(stopFile, QUIET()); writeFileSync(clickLog, "");
      const late = await s3.call("mac_click", { x: 100, y: 100 });
      check("审计 S5A：读空闲时间（ioreg）期间建了停止文件 → 输入照样被停（user_stopped），一个事件都不发",
        late?.isError && /^ERROR: user_stopped: /.test(say(late)) && read(clickLog) === "" && samples() === 1,
        `${say(late).slice(0, 70)} | samples=${samples()} | click=${JSON.stringify(read(clickLog))}`);
    } finally { s3.proc.kill(); rmSync(stopFile, { force: true }); }
    // review S5C (X, D, G): a client cancel that arrives while the idle time is read still cancels the input — no
    // event, no answer (MCP: a cancelled request is not answered)
    idleSlow(1500, QUIET()); writeFileSync(clickLog, "");
    const idCancel = 90101;
    let cancelReplied = false;
    const onOut = (d) => { for (const line of String(d).split("\n")) { try { if (JSON.parse(line).id === idCancel) cancelReplied = true; } catch {} } };
    s.proc.stdout.on("data", onOut);
    s.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: idCancel, method: "tools/call", params: { name: "mac_click", arguments: { x: 100, y: 100 } } }) + "\n");
    for (let i = 0; i < 40 && samples() < 1; i++) await new Promise((r) => setTimeout(r, 50));   // the ioreg read has begun
    s.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: idCancel, reason: "test" } }) + "\n");
    await new Promise((r) => setTimeout(r, 2500));
    s.proc.stdout.off("data", onOut);
    const pongC = await s.rpc("ping");
    check("复审 S5C：读空闲时间（ioreg）期间客户端取消 → 输入不发、不应答，队列照常",
      !cancelReplied && read(clickLog) === "" && samples() === 1 && pongC?.result !== undefined,
      `replied=${cancelReplied} samples=${samples()} click=${JSON.stringify(read(clickLog))}`);
    // R3 (2026-11-17): a key of the person's that is less than 2 s old — the Return that sent the request — is
    // waited out once: with nothing more from them the click goes out after the rest of the 2 s; when they go on,
    // it is refused after the wait, and the answer says that noracu waited
    idle(Date.now() - 600); writeFileSync(clickLog, "");
    const w0 = Date.now();
    const waited = await s.call("mac_click", { x: 100, y: 100 });
    const waitedMs = Date.now() - w0, waitedSamples = samples(), waitedLog = read(clickLog);
    idle(Date.now() - 600, NOW()); writeFileSync(clickLog, "");
    const goesOn = await s.call("mac_click", { x: 100, y: 100 });
    check("R3: the person's key 0.6 s ago, nothing more from them → noracu waits out the rest of the 2 s and clicks; they go on → user_active after the wait, nothing sent",
      !waited?.isError && /c:100,100/.test(waitedLog) && waitedMs >= 1300 && waitedSamples >= 2
        && goesOn?.isError && /^ERROR: user_active: /.test(say(goesOn)) && /after noracu had waited/.test(say(goesOn)) && read(clickLog) === "",
      `${say(waited).slice(0, 50)} ${waitedMs}ms samples=${waitedSamples} | ${say(goesOn).slice(0, 120)}`);
    // a phone input that imctl refused before sending anything does not stamp noracu's own input
    const fakePy = join(dir, "python3");
    writeFileSync(fakePy, `#!/bin/bash\nif [ "$1" = "-c" ]; then exit 0; fi\necho "out_of_screen: the point is on the iPhone Mirroring window's margin; nothing was sent" >&2\nexit 2\n`, { mode: 0o700 });
    const s2 = await spawnServer({ NORACU_AX_ENGINE: fake, NORACU_CLICLICK: fakeClick, NORACU_IOREG: fakeIoreg, NORACU_AX_TIMEOUT_MS: "3000", NORACU_USER_IDLE_S: "2", NORACU_NO_BGPOST: "1", NORACU_PYTHON: fakePy, NORACU_IMCTL_DIR: dir });
    try {
      idle(QUIET()); writeFileSync(clickLog, "");
      const t5 = Date.now();
      const phoneNo = await s2.call("phone_tap", { x: 0.5, y: 0.001 });
      idle(t5 + 1, NOW());                                            // the person moved the mouse while imctl ran, and goes on
      const afterPhone = await s2.call("mac_click", { x: 100, y: 100 });
      check("S4B：手机输入被 imctl 先拒（什么都没发）之后，那一刻有人动过键鼠 → 下一个输入 user_active、不发",
        phoneNo?.isError && /out_of_screen/.test(say(phoneNo)) && afterPhone?.isError && /^ERROR: user_active: /.test(say(afterPhone)) && read(clickLog) === "",
        `${say(phoneNo).slice(0, 60)} | ${say(afterPhone).slice(0, 60)} | click=${JSON.stringify(read(clickLog))}`);
      // an imctl that could not import its modules sent nothing either: the person's event of that moment still
      // refuses the next input (it was stamped as noracu's own)
      writeFileSync(fakePy, `#!/bin/bash\nif [ "$1" = "-c" ]; then exit 0; fi\necho 'Traceback (most recent call last):' >&2\necho "ModuleNotFoundError: No module named 'Quartz'" >&2\nexit 1\n`, { mode: 0o700 });
      idle(QUIET()); writeFileSync(clickLog, "");
      const t9 = Date.now();
      const phoneBroken = await s2.call("phone_tap", { x: 0.5, y: 0.5 });
      idle(t9 + 1);                                                   // the person moved the mouse while imctl ran, then stopped
      const w9 = Date.now();
      const afterBroken = await s2.call("mac_click", { x: 100, y: 100 });
      const waited9 = Date.now() - w9;
      check("an imctl that could not import its modules sent nothing: the person's event of that moment is theirs — the next input waits it out before clicking",
        phoneBroken?.isError && /imctl unavailable/.test(say(phoneBroken)) && !afterBroken?.isError && /c:100,100/.test(read(clickLog)) && waited9 >= 1300,
        `${say(phoneBroken).slice(0, 70)} | ${say(afterBroken).slice(0, 60)} | ${waited9} ms | click=${JSON.stringify(read(clickLog))}`);
    } finally { s2.proc.kill(); }
    // the pointer's position could not be read before a click: the click goes out, and the result says the pointer
    // was not put back (it said nothing)
    const fakePointer = join(dir, "pointer");
    writeFileSync(fakePointer, `#!/bin/bash\nexit 1\n`, { mode: 0o700 });
    const s5 = await spawnServer({ NORACU_AX_ENGINE: fake, NORACU_CLICLICK: fakeClick, NORACU_IOREG: fakeIoreg, NORACU_AX_TIMEOUT_MS: "3000", NORACU_USER_IDLE_S: "2", NORACU_NO_BGPOST: "1", NORACU_TEST_POINTER: fakePointer });
    try {
      idle(QUIET()); writeFileSync(clickLog, "");
      const blind = await s5.call("mac_click", { x: 100, y: 100 });
      check("a click when the pointer's position could not be read: sent, and the result says the pointer was not put back",
        !blind?.isError && /c:100,100/.test(read(clickLog)) && /the pointer's position could not be read before the click, so it was not put back/.test(say(blind)), say(blind).slice(0, 240));
    } finally { s5.proc.kill(); }
  } finally { s.proc.kill(); rmSync(dir, { recursive: true, force: true }); }
}

// mac_screenshot display + region (device run 2026-11-14): region is in screen points as mac_windows reports them;
// without Screen Recording (the engine's status says screen_recording false) mac_screenshot says so in its
// meta; with it, nothing is added, and the status is not asked again after it was seen granted
for (const granted of [false, true]) {
  const { mkdtempSync, writeFileSync, readFileSync: rf, existsSync: ex, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "noracu-srec-"));
  const ops = join(dir, "ops.log");
  const fake = join(dir, "fake-ax-engine");
  writeFileSync(fake, `#!/usr/bin/env node
let d = ""; process.stdin.on("data", (c) => (d += c)); process.stdin.on("end", () => {
  const req = JSON.parse(d);
  require("fs").appendFileSync(${JSON.stringify(ops)}, req.op + "\\n");
  if (req.op === "status") return process.stdout.write(JSON.stringify({ ok: true, accessibility: true, screen_recording: ${granted}, displays: [] }));
  process.stdout.write(JSON.stringify({ ok: false, code: "INVALID_ARGS", message: "fake engine: op " + req.op + " not scripted" }));
});
`, { mode: 0o700 });
  const fakeCap = join(dir, "screencapture");
  writeFileSync(fakeCap, `#!/usr/bin/env node
const b = Buffer.alloc(33); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(b, 0); b.writeUInt32BE(13, 8); b.write("IHDR", 12);
b.writeUInt32BE(800, 16); b.writeUInt32BE(600, 20); require("fs").writeFileSync(process.argv[process.argv.length - 1], b);
`, { mode: 0o700 });
  const s = await spawnServer({ NORACU_AX_ENGINE: fake, NORACU_SCREENCAPTURE: fakeCap });
  try {
    const metaOf = (r) => { try { return JSON.parse(r?.content?.find((c) => c.type === "text")?.text || "{}"); } catch { return {}; } };
    const one = metaOf(await s.call("mac_screenshot", {}));
    const two = metaOf(await s.call("mac_screenshot", {}));
    const statusAsked = ex(ops) ? rf(ops, "utf8").split("\n").filter((l) => l === "status").length : 0;
    const ok = granted
      ? !one.screen_recording_note && !two.screen_recording_note && statusAsked === 1
      : /Screen Recording looks not granted/.test(one.screen_recording_note || "") && /Screen & System Audio Recording/.test(one.screen_recording_note || "") && Boolean(two.screen_recording_note) && statusAsked === 2;
    check(granted ? "mac_screenshot with Screen Recording granted: no note, and the status is asked once only" : "mac_screenshot without Screen Recording: the meta says so (screen_recording_note), at every screenshot",
      ok, `${JSON.stringify(one.screen_recording_note || null).slice(0, 80)} | status asked ${statusAsked}`);
  } finally { s.proc.kill(); rmSync(dir, { recursive: true, force: true }); }
}

// an input tool that fails with an exception nobody planned for (here: an engine answering "null" to the action)
// says that what it sent is not known — delivery=unknown, retry=unsafe
{
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "noracu-throw-"));
  const fake = join(dir, "fake-ax-engine");
  writeFileSync(fake, `#!/usr/bin/env node
let d = ""; process.stdin.on("data", (c) => (d += c)); process.stdin.on("end", () => {
  const req = JSON.parse(d); const say = (o) => process.stdout.write(JSON.stringify(o));
  const app = { pid: 4242, name: "Fake", bundle: "test.fake" };
  if (req.op === "snapshot") return say({ ok: true, app: "Fake", bundle_id: "test.fake", pid: 4242, surface: "window", complete: true, visited: 1, ms: 1, container: { kind: "window", wid: 1, title: "W", subrole: "", frame: [0, 0, 100, 100] }, nodes: [{ d: 1, role: "AXButton", path: [0], fp: { role: "AXButton", subrole: "", id: "", name: "One" }, title: "One", frame: [0, 0, 10, 10], interactive: true }] });
  if (req.op === "frontmost") return say({ ok: true, front: app, target: app, match: true });
  process.stdout.write("null");
});
`, { mode: 0o700 });
  const s = await spawnServer({ NORACU_AX_ENGINE: fake, NORACU_USER_IDLE_S: "0" });
  try {
    const say = (r) => String(r?.content?.[0]?.text || "");
    const snap = await s.call("mac_ax_state", { app: "Fake" });
    const i = (() => { try { return JSON.parse(say(snap)).elements[0].i; } catch { return null; } })();
    const boom = await s.call("mac_click", { element_index: i, mechanism: "semantic" });
    check("an input tool that fails with an unplanned exception: internal_error, delivery=unknown, retry=unsafe",
      Number.isInteger(i) && boom?.isError && /^ERROR: internal_error: /.test(say(boom)) && /\(delivery=unknown, retry=unsafe\)$/.test(say(boom)), say(boom).slice(0, 200));
  } finally { s.proc.kill(); rmSync(dir, { recursive: true, force: true }); }
}

// a region outside the display named is refused before anything is captured
{
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "noracu-region-"));
  const fake = join(dir, "fake-ax-engine");
  writeFileSync(fake, `#!/usr/bin/env node
let d = ""; process.stdin.on("data", (c) => (d += c)); process.stdin.on("end", () => {
  const req = JSON.parse(d);
  if (req.op === "status") return process.stdout.write(JSON.stringify({ ok: true, displays: [{ index: 0, name: "Main", frame: [0, 0, 2560, 1440], scale: 2, main: true }, { index: 1, name: "Side", frame: [-1728, 0, 1728, 1117], scale: 1, main: false }] }));
  process.stdout.write(JSON.stringify({ ok: false, code: "INVALID_ARGS", message: "fake engine: op " + req.op + " not scripted" }));
});
`, { mode: 0o700 });
  // screencapture stand-in: a PNG signature and IHDR saying 1728 x 1117 pixels (display 1 at scale 1)
  const fakeCap = join(dir, "screencapture");
  writeFileSync(fakeCap, `#!/usr/bin/env node
const b = Buffer.alloc(33); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(b, 0); b.writeUInt32BE(13, 8); b.write("IHDR", 12);
b.writeUInt32BE(1728, 16); b.writeUInt32BE(1117, 20); require("fs").writeFileSync(process.argv[process.argv.length - 1], b);
`, { mode: 0o700 });
  const s = await spawnServer({ NORACU_AX_ENGINE: fake, NORACU_SCREENCAPTURE: fakeCap });
  try {
    const say = (r) => String(r?.content?.[0]?.text || "");
    const shot = await s.call("mac_screenshot", { display: 1 });
    const meta = (() => { try { return JSON.parse(shot?.content?.find((c) => c.type === "text")?.text || "{}"); } catch { return {}; } })();
    check("审计 S5A：mac_screenshot 截副屏时按那块屏自己的 scale 算 logical_size（副屏 1x、主屏 2x）",
      !shot?.isError && meta.scale === 1 && JSON.stringify(meta.logical_size) === "[1728,1117]", JSON.stringify(meta).slice(0, 160));
    const local = await s.call("mac_screenshot", { display: 1, region: { x: 8, y: 60, w: 1000, h: 600 } });
    const none = await s.call("mac_screenshot", { display: 5, region: { x: 0, y: 0, w: 10, h: 10 } });
    check("mac_screenshot：display 加 region 时 region 按全局点坐标；落在该屏外 → invalid_args，什么都不截（说明不是屏内坐标）",
      local?.isError && /^ERROR: invalid_args: region is in screen points as mac_windows reports them, not relative to the display; display 1 spans x -1728\.\.0, y 0\.\.1117/.test(say(local)) && /delivery=not_delivered/.test(say(local)),
      say(local).slice(0, 160));
    check("mac_screenshot：display 不存在 + region → display_unknown，什么都不截",
      none?.isError && /^ERROR: display_unknown: there is no display 5/.test(say(none)), say(none).slice(0, 120));
  } finally { s.proc.kill(); rmSync(dir, { recursive: true, force: true }); }
}

// audit S5A-s3-G-4: mac_app launch with cdp_port asks the app rules first — an IDE with a terminal on the default deny
// list is not launched with a DevTools port (the browser tools that would drive it are not judged by app rules)
{
  const { mkdtempSync, writeFileSync, rmSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "noracu-cdpdeny-"));
  const fake = join(dir, "fake-ax-engine");
  // an installed, not running Cursor: the engine gives only its path; the bundle id is in its Info.plist
  const appDir = join(dir, "Cursor.app");
  mkdirSync(join(appDir, "Contents"), { recursive: true });
  writeFileSync(join(appDir, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.todesktop.230313mzl4w4u92</string></dict></plist>
`);
  writeFileSync(fake, `#!/usr/bin/env node
let d = ""; process.stdin.on("data", (c) => (d += c)); process.stdin.on("end", () => {
  const req = JSON.parse(d);
  if (req.op === "app_info") return process.stdout.write(JSON.stringify({ ok: true, running: false, path: ${JSON.stringify(appDir)}, chromium: true, electron: true }));
  process.stdout.write(JSON.stringify({ ok: false, code: "INVALID_ARGS", message: "fake engine: op " + req.op + " not scripted" }));
});
`, { mode: 0o700 });
  const s = await spawnServer({ NORACU_AX_ENGINE: fake, NORACU_ALLOW_CDP: "1" });
  try {
    const r = await s.call("mac_app", { action: "launch", app: "Cursor", cdp_port: 0 });
    const t = String(r?.content?.[0]?.text || "");
    check("审计 S5A：mac_app 带 cdp_port 启动默认拒绝名单里的 App（Cursor）→ input_denied，不启动",
      r?.isError && /^ERROR: input_denied: "Cursor" — /.test(t) && /delivery=not_delivered/.test(t), t.slice(0, 160));
  } finally { s.proc.kill(); rmSync(dir, { recursive: true, force: true }); }
}

// the port answered by a process that is not the launched app is not recorded as the app's. A stand-in
// for open starts a loopback listener on the port it is given; the fake engine names the launched app's pid
{
  const { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "noracu-cdpown-"));
  const appDir = join(dir, "CdpFake.app");
  mkdirSync(join(appDir, "Contents"), { recursive: true });
  writeFileSync(join(appDir, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>test.cdpfake</string></dict></plist>
`);
  const at = (f) => join(dir, f);
  // the listener: answers /json/version with the websocket address it is given, and writes its pid when it listens
  writeFileSync(at("listener.cjs"), [
    "const [port, ws, out] = process.argv.slice(2);",
    "require('node:http').createServer((q, s) => s.end(JSON.stringify({ Browser: 'Fake/1', webSocketDebuggerUrl: ws })))",
    "  .listen(Number(port), '127.0.0.1', () => require('node:fs').writeFileSync(out, String(process.pid)));",
  ].join("\n"));
  // the stand-in for open: mode "wrongws" gives a websocket on another port; "other" and "own" give this port's
  writeFileSync(at("open"), [
    "#!/usr/bin/env node",
    "const fs = require('node:fs'), cp = require('node:child_process'), path = require('node:path');",
    "const dir = " + JSON.stringify(dir) + ";",
    "const port = Number((process.argv.find((a) => a.startsWith('--remote-debugging-port=')) || '=').split('=')[1]);",
    "const mode = fs.readFileSync(path.join(dir, 'mode'), 'utf8').trim();",
    "fs.writeFileSync(path.join(dir, 'port'), String(port));",
    "const ws = mode === 'wrongws' ? 'ws://127.0.0.1:1/devtools/browser/fake' : 'ws://127.0.0.1:' + port + '/devtools/browser/fake';",
    "cp.spawn(process.execPath, [path.join(dir, 'listener.cjs'), String(port), ws, path.join(dir, 'listener')], { detached: true, stdio: 'ignore' }).unref();",
    "const end = Date.now() + 5000;",
    "(function wait() { if (fs.existsSync(path.join(dir, 'listener')) || Date.now() > end) process.exit(0); setTimeout(wait, 50); })();",
  ].join("\n"), { mode: 0o700 });
  // the fake engine: an installed Electron app that is not running; app_wait names the listener's pid ("own") or
  // the server's own pid, which does not listen on the port
  writeFileSync(at("engine"), [
    "#!/usr/bin/env node",
    "const fs = require('node:fs'), path = require('node:path');",
    "const dir = " + JSON.stringify(dir) + ";",
    "let d = ''; process.stdin.on('data', (c) => (d += c)); process.stdin.on('end', () => {",
    "  const req = JSON.parse(d);",
    "  if (req.op === 'app_info') return process.stdout.write(JSON.stringify({ ok: true, running: false, path: " + JSON.stringify(appDir) + ", chromium: true, electron: true }));",
    "  if (req.op === 'app_wait') {",
    "    const own = fs.readFileSync(path.join(dir, 'mode'), 'utf8').trim() === 'own' && fs.existsSync(path.join(dir, 'listener'));",
    "    return process.stdout.write(JSON.stringify({ ok: true, name: 'CdpFake', pid: own ? Number(fs.readFileSync(path.join(dir, 'listener'), 'utf8')) : process.ppid }));",
    "  }",
    "  process.stdout.write(JSON.stringify({ ok: false, code: 'INVALID_ARGS', message: 'fake engine: op ' + req.op + ' not scripted' }));",
    "});",
  ].join("\n"), { mode: 0o700 });
  const s = await spawnServer({ NORACU_AX_ENGINE: at("engine"), NORACU_TEST_OPEN: at("open"), NORACU_ALLOW_CDP: "1" });
  const stopListener = () => {
    if (existsSync(at("listener"))) { try { process.kill(Number(readFileSync(at("listener"), "utf8"))); } catch { /* gone */ } rmSync(at("listener"), { force: true }); }
  };
  const launch = async (mode) => {
    writeFileSync(at("mode"), mode);
    const r = await s.call("mac_app", { action: "launch", app: "CdpFake", cdp_port: 0, timeout_ms: 4000 });
    const port = existsSync(at("port")) ? Number(readFileSync(at("port"), "utf8")) : null;
    // attaching for real needs a browser behind the port: only the ports that must be refused are tried
    const attach = port && mode !== "own" ? await s.call("browser_launch", { cdp_port: port }) : null;
    stopListener();
    return { r, j: jsonOf(r), port, attach: String(attach?.content?.[0]?.text || "") };
  };
  try {
    const wrong = await launch("wrongws");
    const other = await launch("other");
    const own = await launch("own");
    check("审计：带 cdp_port 启动后，答话的端点不是这个 App 的（websocket 不在本端口 / 监听进程不是它）→ 不记录（cdp:null），browser_launch 附着被拒；是它自己的照常记录",
      !wrong.r?.isError && wrong.j.cdp === null && /is not the launched app's own/.test(wrong.j.note || "") && /was not opened by this noracu process/.test(wrong.attach)
      && !other.r?.isError && other.j.cdp === null && /was not opened by this noracu process/.test(other.attach)
      && own.j.cdp?.port === own.port && own.j.cdp?.websocket_url === `ws://127.0.0.1:${own.port}/devtools/browser/fake`,
      `wrong: ${JSON.stringify(wrong.j).slice(0, 110)} | ${wrong.attach.slice(0, 60)} || other: ${JSON.stringify(other.j).slice(0, 90)} || own: ${JSON.stringify(own.j.cdp ?? null).slice(0, 90)}`);
  } finally { stopListener(); s.proc.kill(); rmSync(dir, { recursive: true, force: true }); }
}

{
  // One message is one line: a line of more than 4 MB is dropped while it arrives and answered with an error — under
  // its id, which stands before the params here — and the next message is read as usual
  const big = await spawnServer();
  try {
    const got = [];
    let buf = "";
    big.proc.stdout.on("data", (d) => { buf += d; let nl; while ((nl = buf.indexOf("\n")) !== -1) { const l = buf.slice(0, nl); buf = buf.slice(nl + 1); try { got.push(JSON.parse(l)); } catch { /* not a message */ } } });
    big.proc.stdin.write(`{"jsonrpc":"2.0","id":991001,"method":"tools/call","params":{"name":"mac_paste","arguments":{"text":"${"a".repeat(5 * 1024 * 1024)}"}}}\n`);
    await sleepMs(1500);
    const ans = got.find((m) => m.id === 991001);
    const pong = await Promise.race([big.rpc("ping"), sleepMs(4000).then(() => null)]);
    check("a request line of more than 4 MB: dropped unread and answered with an error under its id; the next request is answered as usual",
      ans?.error?.code === -32600 && /too large/.test(ans.error.message) && pong?.result !== undefined, `${JSON.stringify(ans ?? null).slice(0, 150)} | ping: ${pong?.result !== undefined ? "answered" : "no answer"}`);
    // …and a line just past the limit, whose end arrives in the chunk that takes it there, is not read either;
    // an id that is the string "params" is still found
    const pre = '{"jsonrpc":"2.0","id":"params","method":"tools/call","params":{"name":"mac_paste","arguments":{"text":"', post = '"}}}';
    big.proc.stdin.write(pre + "b".repeat(4 * 1024 * 1024 + 10 - pre.length - post.length) + post + "\n");
    await sleepMs(1500);
    const ans2 = got.find((m) => m.id === "params");
    check("a request line ten characters past the limit: not read either, and answered under its id",
      ans2?.error?.code === -32600 && /too large/.test(ans2.error.message), JSON.stringify(ans2 ?? got.at(-1) ?? null).slice(0, 170));
  } finally { big.proc.kill(); }
}
{
  // the harness's own limit: a server that never answers ends the wait, and the call reads as an error
  const mute = await spawnServer({}, new URL("./mute-server.mjs", import.meta.url).pathname, 600);
  try {
    const t0 = Date.now();
    const r = await mute.call("mac_status");
    expectedUnanswered++;
    check("测试自身：对方一直不应答时，调用在限时后以错误结束，不会挂住整轮",
      r?.isError && /^E2E_TIMEOUT/.test(String(r?.content?.[0]?.text)) && Date.now() - t0 < 5000, `${Date.now() - t0} ms`);
  } finally { mute.proc.kill(); }
}
check("每个调用都在限时内得到应答（故意不应答的那一个除外）", unanswered.length === expectedUnanswered, unanswered.join(", ").slice(0, 200));

const failed = results.filter(r => !r.pass);
console.log(`\n=== noracu MCP: ${results.length - failed.length}/${results.length} PASS ===`);
proc.kill();
process.exit(failed.length ? 1 : 0);

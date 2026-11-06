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
// G8-1 (0.2.0): in CI mode nothing may touch the desktop — a block that clicks, types, pastes or writes
// the clipboard runs only locally (checkHW alone only skipped the assertion, not the action)
const LOCAL = !CI;
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
check("B4：initialize 带使用说明 instructions", typeof init.result?.instructions === "string" && init.result.instructions.includes("element_index") && init.result.instructions.includes("retry=safe"), String(init.result?.instructions).slice(0, 60));

// 2. tools/list
const tl = await rpc("tools/list", {});
const tools = tl.result?.tools || [];
const EXPECT_TOOLS = { mac: 20, browser: 12, phone: 14 };
const EXPECT_TOTAL = EXPECT_TOOLS.mac + EXPECT_TOOLS.browser + EXPECT_TOOLS.phone;
check(`tools/list ${EXPECT_TOTAL} 个`, tools.length === EXPECT_TOTAL, `got ${tools.length}`);
const byLayer = { mac: 0, browser: 0, phone: 0 };
for (const t of tools) { if (t.name.startsWith("mac_")) byLayer.mac++; else if (t.name.startsWith("browser_")) byLayer.browser++; else if (t.name.startsWith("phone_")) byLayer.phone++; }
check("三层分布", byLayer.mac === EXPECT_TOOLS.mac && byLayer.browser === EXPECT_TOOLS.browser && byLayer.phone === EXPECT_TOOLS.phone, JSON.stringify(byLayer));
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
if (expectedReqByTool.size !== EXPECT_TOTAL) schemaBad.push(`parsed ${expectedReqByTool.size}/${EXPECT_TOTAL} tool arg specs`);
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
  spawnSync("/usr/bin/pbcopy", { input: "noracu-sentinel", timeout: 5000 });
  const mp = await call("mac_paste", { text: "x", app: "TextEdit" });
  await new Promise(r => setTimeout(r, 400));
  const after = spawnSync("/usr/bin/pbpaste", { timeout: 5000 }).stdout?.toString() ?? "";
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
  checkHW("B3：mac_notifications 列出并按 id 关闭横幅", nid && /delivered_verified/.test(say(ndm)), `${nl.count} listed; ${say(ndm).slice(0, 70)}`);
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
}

// B5（0.2.0）：假 AX 引擎（NORACU_AX_ENGINE）—— 不需要 macOS 权限即可检验 server 侧的 Mac 逻辑（CI 安全）
// The fake speaks the engine protocol: one JSON request on stdin, one JSON reply on stdout. Actions echo
// the fingerprint name of the element they were asked to act on, so a test can see which one it was.
const FAKE_AX = `#!/usr/bin/env node
const fs = require("fs");
let d = ""; process.stdin.on("data", (c) => (d += c)); process.stdin.on("end", () => {
  const req = JSON.parse(d); const say = (o) => process.stdout.write(JSON.stringify(o));
  const node = (name, i) => ({ d: 1, role: "AXButton", path: [i], fp: { role: "AXButton", subrole: "", id: "", name }, title: name, frame: [10 * i, 0, 10, 10], interactive: true });
  const base = { ok: true, app: "Fake", bundle_id: "test.fake", pid: 4242, surface: "window", complete: true, visited: 2, ms: 1, container: { kind: "window", wid: 1, title: "W", subrole: "", frame: [0, 0, 100, 100], n: 0 } };
  const webAx = req.app === "ChromeNoWeb" ? { web_accessibility: "unsupported" } : req.app === "ChromeWeb" ? { web_accessibility: "exposed" } : {};
  if (req.op === "snapshot") return say({ ...base, ...webAx, nodes: [node("One", 0), node("Two", 1)] });
  if (req.op === "find") return say({ ...base, ...webAx, nodes: [node("Three", 0), node("Four", 1)] });
  if (req.op === "act") return say({ ok: true, delivery: "delivered_verified", retry: "unsafe", changed: ["value"], surfaces: [], mechanism: "semantic", action: "AXPress", how: "path", role: "AXButton", title: req.target.fp.name });
  if (req.op === "physical_prep") return req.target.fp.name === "Two" ? say({ ok: false, code: "OCCLUDED", message: "a window of Other is on top", delivery: "not_delivered", retry: "safe" }) : say({ ok: true, point: [5, 5], hit: "reaches", before: {} });
  if (req.op === "observe_after") return say({ ok: true, delivery: "delivered_verified", retry: "unsafe", changed: ["focus"], surfaces: [] });
  if (req.op === "frontmost") {
    const o = { ok: true, front: { pid: 777, name: "Other", bundle: "x.other" }, target: { pid: 4242, name: "Fake", bundle: "test.fake" }, match: false };
    // at: x >= 500 is under a notification banner, y < 30 is the menu bar, anything else is the frontmost app's window
    if (req.at) o.top = req.at[0] >= 500 ? { pid: 999, owner: "NotificationCenter", layer: 23, wid: 9 } : req.at[1] < 30 ? { pid: 640, owner: "Window Server", layer: 24, wid: 1 } : { pid: 777, owner: "Other", layer: 0, wid: 5 };
    return say(o);
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
if [ "$3" = "open" ] && [ "$IN" = "NoSuchApp" ]; then echo "app not found: 'NoSuchApp' (Spotlight showed no Top Hit)"; exit 1; fi
if [[ "$*" == *"--expect=CapFail"* ]]; then echo "capture_failed: could not capture the iPhone Mirroring window to check --expect; no image was returned, so nothing was sent" >&2; exit 7; fi
if [ "$3" = "status" ]; then
  printf 'Traceback (most recent call last):\\n  File "cli.py", line 1, in <module>\\nRuntimeError: synthetic boom\\n' >&2
  exit 1
fi
echo "home gesture sent"
`, { mode: 0o700 });
  const menuReply = join(dir, "menu-reply.json");
  const menuReqLog = join(dir, "menu-req.jsonl");
  const keyReqLog = join(dir, "key-req.jsonl");
  const s = await spawnServer({
    NORACU_AX_ENGINE: fake, NORACU_CLICLICK: fakeClick, NORACU_AX_TIMEOUT_MS: "1500",
    NORACU_PYTHON: fakePy, NORACU_IMCTL_DIR: dir,
    NORACU_TEST_MENU_REPLY: menuReply, NORACU_TEST_MENU_REQ: menuReqLog, NORACU_TEST_KEY_REQ: keyReqLog,
  });
  const keyReqs = () => { try { return readFileSync(keyReqLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const sent = () => { try { return readFileSync(clickLog, "utf8"); } catch { return ""; } };
  const imctlSent = () => { try { return readFileSync(imctlLog, "utf8"); } catch { return ""; } };
  const menuReqs = () => { try { return readFileSync(menuReqLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  try {
    const say = (r) => String(r?.content?.[0]?.text);
    const a = jsonOf(await s.call("mac_ax_state", { app: "Fake" }));
    const one = a.elements?.find((e) => e.title === "One")?.i;
    const f = jsonOf(await s.call("mac_find", { app: "Fake", role: "button" }));
    const three = f.matches?.find((e) => e.title === "Three")?.i;
    check("B5：索引跨快照唯一（mac_find 不复用旧编号）", Number.isInteger(one) && Number.isInteger(three) && one !== three && a.snapshot_id !== f.snapshot_id, `One=${one} (${a.snapshot_id}) Three=${three} (${f.snapshot_id})`);
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
    // 0.2.1: named keys go through the engine as HID key events (Chrome's address bar ignored cliclick's Return);
    // printable-character chords stay on cliclick
    const k1 = await s.call("mac_key", { key: "return" });
    const k2 = await s.call("mac_key", { key: "cmd-arrow-up" });
    const k3 = await s.call("mac_key", { key: "cmd-c" });
    const kr = keyReqs();
    check("0.2.1：mac_key return / cmd-arrow-up 走引擎 HID 键事件（键码与 Fn/小键盘标志），cmd-c 仍走 cliclick",
      !k1?.isError && /HID key event/.test(say(k1)) && !k2?.isError && !k3?.isError && !/HID key event/.test(say(k3))
        && kr.length === 2 && kr[0].code === 36 && kr[0].mods.length === 0 && kr[0].fn_key === false
        && kr[1].code === 126 && JSON.stringify(kr[1].mods) === '["cmd"]' && kr[1].fn_key === true && kr[1].numpad === true
        && !/kp:return/.test(sent()) && /kd:cmd t:c ku:cmd/.test(sent()),
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
    // device run 2026-11-06: a paste only the frame diff saw is reported unverified
    const tu = await s.call("phone_type", { text: "X" });
    check("B5/device：phone_type 只有画面变化、OCR 读不回 → delivered_unverified",
      !tu?.isError && /OCR cannot read this text back/.test(say(tu)) && /delivery=delivered_unverified, retry=unsafe/.test(say(tu)), say(tu).slice(-70));
    check("B5/R19：phone_open app not found → delivered_unverified；--expect 截图失败 → not_delivered",
      nf?.isError && /app not found/.test(say(nf)) && /delivery=delivered_unverified, retry=safe/.test(say(nf))
        && cf?.isError && /capture_failed/.test(say(cf)) && /delivery=not_delivered, retry=safe/.test(say(cf)),
      `${say(nf).slice(-60)} | ${say(cf).slice(-60)}`);
    // R18: find / open text goes in on stdin ("-" in argv), never in the process list
    check("B5/t06：menu_item_absent 回退 imctl；find/open 文本经 stdin（argv 只有 `-- -`）；key 带 `--`；非导入异常报 imctl_error",
      !mhFb?.isError && /-m imctl\.cli home/.test(logAfter) && /find -- -\n/.test(logAfter) && /stdin:--exact/.test(logAfter) && /open -- -\n/.test(logAfter) && /stdin:-Settings/.test(logAfter) && !/cli (find|open) -- (--exact|-Settings)/.test(logAfter) && /key --expect=Home -- return/.test(logAfter) && /key --expect=--replace -- return/.test(logAfter) && psBoom?.isError && /imctl_error: RuntimeError: synthetic boom/.test(say(psBoom)) && !/imctl unavailable/.test(say(psBoom)),
      `${say(psBoom).slice(0, 60)} | log=${JSON.stringify(logAfter.trim())}`);
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
    const s = await spawnServer();
    const bl = await s.call("browser_launch", { headless: true });
    const t0 = Date.now();
    s.proc.kill("SIGTERM");
    const done = await Promise.race([exited(s.proc), sleepMs(6000).then(() => false)]);
    const { homedir } = await import("node:os");
    const lock = new URL(`file://${homedir()}/.noracu/browser-profile/SingletonLock`).pathname;
    let locked = false; try { (await import("node:fs")).lstatSync(lock); locked = true; } catch { /* no lock */ }
    check("B6：开着浏览器收到 SIGTERM → 关闭浏览器（profile 解锁）并在 3 s 内退出",
      /browser_id/.test(String(bl?.content?.[0]?.text)) && done === true && Date.now() - t0 < 4000 && !locked, `exit after ${Date.now() - t0} ms, lock=${locked}, launch=${String(bl?.content?.[0]?.text).slice(0, 40)}`);
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
const bc = await call("browser_close");
check("browser_close", bc?.content?.[0]?.text?.includes("closed"), bc?.content?.[0]?.text);

// 7b. t07 本机受控页面回归（file:// 夹具：遮挡不回退 JS click / placeholder 命名区分 / window.open 不切活动页 / >100 截断与滚动回报）
if (LOCAL) {
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

    const scDown = await s.call("browser_scroll", { direction: "down", pages: 1 });
    await s.call("browser_scroll", { direction: "up", pages: 2 });
    const scTop = await s.call("browser_scroll", { direction: "up", pages: 1 });
    check("t07：browser_scroll 回报 scrollY 变化与 did not move",
      !scDown?.isError && /scrollY 0 → [1-9]\d*/.test(say(scDown)) && say(scDown).includes("delivery=delivered_verified")
        && !scTop?.isError && say(scTop).includes("did not move") && say(scTop).includes("delivery=delivered_unverified"),
      `${say(scDown).slice(0, 50)} | ${say(scTop).slice(0, 50)}`);
  } finally {
    await s.call("browser_close").catch(() => {});
    const exited = new Promise((r) => s.proc.once("exit", r));
    s.proc.kill();
    await Promise.race([exited, sleepMs(3000)]);
    rmSync(dir, { recursive: true, force: true });
  }
} else {
  skipLocal(
    "t07：同文档导航回报 no response 与 delivery",
    "t07：不同 placeholder 的两个 input 获得不同名称",
    "t07 复核：输入的文字不进入元素名；submit 按 value 命名",
    "t07：被遮挡按钮点击报 occluded/not_actionable 且不触发 onclick",
    "t07：disabled 按钮点击报 not_actionable",
    "t07：window.open 打开新页后活动页不变",
    "t07：超过 100 个可交互元素时提示 truncated 与遗漏数",
    "t07：browser_scroll 回报 scrollY 变化与 did not move"
  );
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

// B2 本机：元素消失后用旧 index —— element_no_longer_valid，什么都不发（关文档本身就是测试收尾）
if (LOCAL) {
  // by window id: TextEdit may also show a "… copy" window whose title contains the test document's name
  const wl = TE_READY() ? jsonOf(await call("mac_windows", { app: "TextEdit" })) : {};
  const wid = (wl.windows || []).find((w) => w.title === TE_DOC)?.id;
  const st = wid ? jsonOf(await call("mac_ax_state", { app: "TextEdit", window_id: wid, interactive: true })) : {};
  const bold = (st.elements || []).find((e) => e.title === "bold")?.i;
  // "contains": TextEdit may have made a "… copy" of the test document after the format changes above
  spawnSync("/usr/bin/osascript", ["-e", `tell application "TextEdit" to close (every document whose name contains "${TE_DOC}") saving no`], { timeout: 10000 });
  await sleepMs(500);
  const r = Number.isInteger(bold) ? await call("mac_click", { element_index: bold }) : null;
  check("B2：元素已消失 → element_no_longer_valid（不误点）", r?.isError && /element_no_longer_valid/.test(String(r?.content?.[0]?.text)) && /delivery=not_delivered/.test(String(r?.content?.[0]?.text)), String(r?.content?.[0]?.text).slice(0, 100));
} else skipLocal("B2：元素已消失 → element_no_longer_valid（不误点）");

const failed = results.filter(r => !r.pass);
console.log(`\n=== noracu MCP: ${results.length - failed.length}/${results.length} PASS ===`);
proc.kill();
process.exit(failed.length ? 1 : 0);

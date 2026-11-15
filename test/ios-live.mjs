#!/usr/bin/env node
// Live run of the XCUITest iPhone backend against a real iPhone or a booted simulator — not part of
// `npm test`. It drives the real server over stdio through the ios_* tools, in the Settings app only:
// the search field (typed into, then emptied), one list drag, one tap on a row that only navigates
// (General / Battery / Accessibility), a screenshot, Home. It changes no setting.
//
//   node src/server.mjs ios-setup --team <TeamID> [--udid <udid>]     (once per device; a simulator needs no team)
//   node test/ios-live.mjs --udid <udid>
//
// Prints one line per check with its time, and ends with "IOS LIVE PASS <n>" (exit 0) or "IOS LIVE FAIL" (exit 1).
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const udid = process.argv[process.argv.indexOf("--udid") + 1];
if (!udid || process.argv.indexOf("--udid") === -1) { console.error("usage: node test/ios-live.mjs --udid <udid>"); process.exit(2); }
const SERVER = join(fileURLToPath(new URL(".", import.meta.url)), "..", "src", "server.mjs");
const SETTINGS = "com.apple.Preferences", SPRINGBOARD = "com.apple.springboard";
const TEXT = "noracu 123";
const NAV_ONLY = ["General", "通用", "Battery", "电池", "Accessibility", "无障碍", "辅助功能"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const proc = spawn("node", [SERVER], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, NORACU_LAYERS: "mac,browser,iphone", NORACU_PHONE_BACKEND: "xcuitest", NORACU_IOS_UDID: udid } });
let buf = "", id = 0;
const pending = new Map();
proc.stdout.on("data", (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    try { const m = JSON.parse(line); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch { /* not ours */ }
  }
});
const rpc = (method, params) => new Promise((res) => { const n = ++id; pending.set(n, res); proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"); });
let lastMs = 0;
async function call(name, args = {}) {
  const t0 = Date.now();
  const r = (await rpc("tools/call", { name, arguments: args })).result;
  lastMs = Date.now() - t0;
  return { isError: Boolean(r?.isError), text: r?.content?.find((b) => b.type === "text")?.text ?? "", image: r?.content?.find((b) => b.type === "image") ?? null };
}
const results = [];
function check(name, cond, detail = "") {
  results.push(Boolean(cond));
  console.log(`${cond ? "ok  " : "FAIL"} ${name}  [${lastMs} ms]${cond || detail === "" ? "" : "  | " + (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 500)}`);
  return cond;
}
const J = (r) => { try { return JSON.parse(r.text); } catch { return { elements: [], error: r.text }; } };
// an app that has just come forward keeps filling in its rows: wait until two snapshots agree
async function settled(args = {}) {
  const key = (s) => JSON.stringify((s.elements || []).filter((e) => e.type === "cell").map((e) => [e.label, Math.round(e.frame[1])]));
  let prev = J(await call("ios_snapshot", args));
  for (let i = 0; i < 10; i++) {
    await sleep(700);
    const cur = J(await call("ios_snapshot", args));
    if (key(cur) === key(prev)) return cur;
    prev = cur;
  }
  return prev;
}

try {
  const tools = (await rpc("tools/list", {})).result.tools.map((t) => t.name);
  check("the server lists ios_* and no phone_*", tools.includes("ios_tap") && !tools.some((n) => n.startsWith("phone_")));

  const st = J(await call("ios_status"));
  check("ios_status: this device, not locked, runner built", st.device?.udid?.toLowerCase() === udid.toLowerCase() && st.locked !== true && st.setup === "built", st);
  console.log(`     device: ${st.device?.model} · iOS ${st.device?.os} · ${st.device?.simulated ? "simulator" : st.device?.transport}`);

  const launch = await call("ios_launch", { bundle_id: SETTINGS, terminate_existing: true });
  check("ios_launch Settings (starts the runner the first time) — verified in front", !launch.isError && /delivered_verified/.test(launch.text), launch.text);
  const again = await call("ios_launch", { bundle_id: SETTINGS });
  check("ios_launch again, runner already up", !again.isError && /delivered_verified/.test(again.text), again.text);

  let snap = await settled();
  check("ios_snapshot: elements with frames and a screen size", snap.elements.length >= 5 && snap.screen?.w > 200 && snap.state === "runningForeground", { n: snap.elements?.length, err: snap.error });
  const W = snap.screen.w, H = snap.screen.h;

  const off = await call("ios_tap", { x: W + 50, y: 10 });
  check("a point off the screen is refused, nothing sent", off.isError && /invalid_args/.test(off.text) && /delivery=not_delivered/.test(off.text), off.text);

  // drag the list up 150 pt
  const row = snap.elements.find((e) => e.type === "cell" && e.label && e.frame[1] > H * 0.45 && e.frame[1] < H * 0.75);
  if (row) {
    const sw = await call("ios_swipe", { from: [W / 2, H * 0.7], to: [W / 2, H * 0.7 - 150] });
    await sleep(800);
    const after = J(await call("ios_snapshot")).elements.find((e) => e.type === "cell" && e.label === row.label);
    const moved = after ? after.frame[1] - row.frame[1] : null;
    lastMs = 0;
    check(`ios_swipe up 150 pt moves a row by -100..-175 pt (moved ${moved})`, !sw.isError && moved !== null && moved <= -100 && moved >= -175, sw.text);
    const stale = await call("ios_tap", { element_index: row.i });
    check("the row's index from before the drag is refused: element_no_longer_valid", stale.isError && /element_no_longer_valid/.test(stale.text), stale.text);
    await call("ios_swipe", { from: [W / 2, H * 0.4], to: [W / 2, H * 0.4 + 150] });
    await sleep(800);
  } else console.log("skip ios_swipe: no row in the middle of the screen");

  // a row that only navigates
  snap = await settled();
  const nav = snap.elements.find((e) => e.type === "cell" && NAV_ONLY.some((n) => e.label === n || e.label.startsWith(n + "、") || e.label.startsWith(n + ",")) && e.frame[1] > 60 && e.frame[1] + e.frame[3] < H - 60);
  if (nav) {
    const tap = await call("ios_tap", { element_index: nav.i });
    const ok = check(`ios_tap by element_index on the row "${nav.label}"`, !tap.isError && /delivered_unverified/.test(tap.text), tap.text);
    if (ok) {
      await sleep(1200);
      const inside = J(await call("ios_snapshot"));
      const back = inside.elements.some((e) => e.type === "button" && e.frame[1] < 140 && e.frame[0] < 120);
      const rowsNow = inside.elements.filter((e) => e.type === "cell").map((e) => e.label);
      lastMs = 0;
      check("the tap opened the row's page (the first-level list is gone, a back button is there)", back && !rowsNow.includes(snap.elements.find((e) => e.type === "cell" && e !== nav && e.label)?.label), rowsNow.slice(0, 5));
    }
    await call("ios_launch", { bundle_id: SETTINGS, terminate_existing: true });
  } else console.log("skip ios_tap on a row: none of General / Battery / Accessibility is on screen");

  // the search field
  snap = await settled({ interactive: true });
  const field = snap.elements.find((e) => e.type === "searchField");
  if (check("Settings has a search field", Boolean(field), snap.elements.map((e) => e.type).slice(0, 12))) {
    const typed = await call("ios_type", { element_index: field.i, text: TEXT });
    check(`ios_type ${TEXT.length} characters into the search field — verified by reading it back`, !typed.isError && /delivered_verified/.test(typed.text) && !typed.text.includes(TEXT), typed.text);
    const val = J(await call("ios_snapshot", { interactive: true })).elements.find((e) => e.type === "searchField")?.value;
    check("the field holds exactly the text", val === TEXT, val);
    const del = await call("ios_key", { key: "delete", count: TEXT.length });
    const empty = J(await call("ios_snapshot", { interactive: true })).elements.find((e) => e.type === "searchField")?.value ?? "";
    check("ios_key delete empties the field", !del.isError && !empty.includes("noracu"), [del.text, empty]);
  }

  const shot = await call("ios_screenshot");
  check("ios_screenshot returns a PNG and the size in points", shot.image?.mimeType === "image/png" && Buffer.from(shot.image.data, "base64").subarray(1, 4).toString() === "PNG" && JSON.parse(shot.text).w === W, shot.text.slice(0, 200));

  const home = await call("ios_home");
  check("ios_home — Settings is seen to leave the front", !home.isError && /left the front \(delivery=delivered_verified/.test(home.text), home.text);
  const bg = await call("ios_tap", { bundle_id: SETTINGS, x: 20, y: 300 });
  check("a tap for Settings, now in the background, is refused", bg.isError && /app_not_foreground/.test(bg.text) && /delivery=not_delivered/.test(bg.text), bg.text);
  const hs = J(await call("ios_snapshot"));
  check("the Home Screen is the default app after ios_home", hs.bundle_id === SPRINGBOARD && hs.elements.length > 0, hs.error);
} catch (e) {
  results.push(false);
  console.log("FAIL exception: " + (e?.stack || e));
}

proc.stdin.end();
await Promise.race([new Promise((r) => proc.on("exit", r)), sleep(6000)]);
await sleep(500);
const left = spawnSync("/usr/bin/pgrep", ["-f", `test-without-building.*${udid}`], { encoding: "utf8" }).stdout.trim();
lastMs = 0;
check("after the server exits no xcodebuild is left for this device", left === "", left);
const failed = results.filter((r) => !r).length;
console.log(failed ? `IOS LIVE FAIL ${failed} of ${results.length}` : `IOS LIVE PASS ${results.length}`);
process.exit(failed ? 1 : 0);

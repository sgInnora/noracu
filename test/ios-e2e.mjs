#!/usr/bin/env node
// End-to-end tests of the XCUITest iPhone backend (NORACU_PHONE_BACKEND=xcuitest): the real server over
// stdio, with a fake xcrun and a fake xcodebuild that carries a model phone (test/fixtures/). CI-safe:
// no iPhone, no Xcode, nothing on this Mac is touched. What they pin down is the wiring — which tools are
// listed, the argument checks, the queue, the stop file / deny list / approval file / read-only mode, the
// lock check, and that the server takes its xcodebuild with it when it goes.
import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SERVER = join(HERE, "..", "src", "server.mjs");
const UDID = "00008140-001A2B3C4D5E6F70", SETTINGS = "com.apple.Preferences", SPRINGBOARD = "com.apple.springboard";
const NOT_SENT = "(delivery=not_delivered, retry=safe)";
const results = [];
const check = (name, cond, detail = "") => { results.push({ name, pass: Boolean(cond) }); console.log(`${cond ? "✅" : "❌"} ${name}${cond || detail === "" ? "" : " | " + (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 700)}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

const device = (o = {}) => ({
  hardwareProperties: { udid: UDID, platform: "iOS", marketingName: "iPhone 16 Pro", reality: "physical", ...o.hardware },
  deviceProperties: { name: "Test iPhone", osVersionNumber: "27.2", developerModeStatus: "enabled", bootState: "booted" },
  connectionProperties: { transportType: "wired", pairingState: "paired", tunnelState: "connected", tunnelIPAddress: "::1", ...o.connection },
});

// one fake world + one server
function world({ env = {}, devices = [device()], built = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "noracu-ios-e2e-"));
  writeFileSync(join(dir, "devices.json"), JSON.stringify(devices));
  const runnerDir = join(dir, "runner");
  if (built) { mkdirSync(join(runnerDir, UDID, "Build", "Products"), { recursive: true }); writeFileSync(join(runnerDir, UDID, "Build", "Products", "NoracuRunner_iphoneos.xctestrun"), ""); }
  const proc = spawn("node", [SERVER], { stdio: ["pipe", "pipe", "pipe"], env: {
    ...process.env, NORACU_LAYERS: "mac,browser,iphone", NORACU_USER_IDLE_S: "0", NORACU_PHONE_BACKEND: "xcuitest", NORACU_FAKE_IOS_DIR: dir, NORACU_IOS_RUNNER_DIR: runnerDir,
    NORACU_IOS_XCRUN: join(HERE, "fixtures", "fake-xcrun.mjs"), NORACU_IOS_XCODEBUILD: join(HERE, "fixtures", "fake-xcodebuild.mjs"), ...env } });
  let buf = "", id = 0, stderr = "";
  const pending = new Map();
  proc.stderr.on("data", (d) => { stderr += d; });
  proc.stdout.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      try { const m = JSON.parse(line); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch { /* not a line of ours */ }
    }
  });
  const rpc = (method, params) => new Promise((res) => { const n = ++id; pending.set(n, res); proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"); });
  const call = async (name, args = {}) => { const r = (await rpc("tools/call", { name, arguments: args })).result; return { isError: Boolean(r?.isError), text: r?.content?.find((b) => b.type === "text")?.text ?? "", image: r?.content?.find((b) => b.type === "image") ?? null }; };
  const lines = (name) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const exited = new Promise((res) => proc.on("exit", res));
  return { dir, proc, rpc, call, lines, exited, stderr: () => stderr,
    put: (name, text) => writeFileSync(join(dir, name), text), drop: (name) => rmSync(join(dir, name), { force: true }),
    control: (c) => appendFileSync(join(dir, "control.jsonl"), JSON.stringify(c) + "\n"),
    async close() { proc.stdin.end(); await Promise.race([exited, sleep(5000)]); try { proc.kill("SIGKILL"); } catch { /* gone */ } rmSync(dir, { recursive: true, force: true }); } };
}
const tools = async (w) => (await w.rpc("tools/list", {})).result.tools;
const J = (r) => JSON.parse(r.text);

// ---------- which tools are listed ----------
{
  const def = world({ env: { NORACU_PHONE_BACKEND: "" } }), x = world(), typo = world({ env: { NORACU_PHONE_BACKEND: "xcui" } });
  const [d, t, y] = [await tools(def), await tools(x), await tools(typo)];
  const by = (list, p) => list.filter((k) => k.name.startsWith(p));
  const IOS = ["ios_status", "ios_launch", "ios_snapshot", "ios_screenshot", "ios_tap", "ios_type", "ios_key", "ios_swipe", "ios_home"];
  check("default backend (mirror): phone_* listed, no ios_*", by(d, "phone_").length > 0 && by(d, "ios_").length === 0, d.length);
  check("xcuitest backend: the nine ios_* tools replace phone_*; mac_* and browser_* are the same", by(t, "phone_").length === 0 && JSON.stringify(by(t, "ios_").map((k) => k.name)) === JSON.stringify(IOS) && by(t, "mac_").length === by(d, "mac_").length && by(t, "browser_").length === by(d, "browser_").length && t.length === d.length - by(d, "phone_").length + IOS.length && by(t, "mac_").length === 20 && by(t, "browser_").length === 13 && t.length === 42, t.map((k) => k.name).filter((k) => !/^(mac|browser)_/.test(k)));
  check("every ios_* description starts with EXPERIMENTAL.", by(t, "ios_").every((k) => k.description.startsWith("EXPERIMENTAL.")));
  check("ios_* schemas: every property is an object with a string type; no oneOf / anyOf", by(t, "ios_").every((k) => Object.values(k.inputSchema.properties).every((p) => p && typeof p.type === "string" && !p.oneOf && !p.anyOf)));
  const ro = (n) => t.find((k) => k.name === n).annotations.readOnlyHint;
  check("annotations: status / snapshot / screenshot are read-only, the six input tools are not, ios_launch is marked destructive", ro("ios_status") && ro("ios_snapshot") && ro("ios_screenshot") && ["ios_launch", "ios_tap", "ios_type", "ios_key", "ios_swipe", "ios_home"].every((k) => ro(k) === false) && t.find((k) => k.name === "ios_launch").annotations.destructiveHint === true && t.find((k) => k.name === "ios_tap").annotations.destructiveHint === false);
  const init = (await x.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ios-e2e" } })).result;
  check("initialize instructions name ios_* under the xcuitest backend", /ios_launch/.test(init.instructions) && !/phone_\*/.test(init.instructions));
  check("an unknown NORACU_PHONE_BACKEND warns on stderr and falls back to mirror", by(y, "ios_").length === 0 && by(y, "phone_").length > 0 && /NORACU_PHONE_BACKEND="xcui" is not mirror or xcuitest/.test(typo.stderr()), typo.stderr().slice(0, 200));
  check("an ios_* tool is unknown to a mirror server", (await def.call("ios_status")).text === "unknown tool: ios_status");
  const only = world({ env: { NORACU_LAYERS: "iphone" } });
  const o = await tools(only);
  const onlyInit = (await only.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ios-e2e" } })).result;
  check("NORACU_LAYERS=iphone under the xcuitest backend: the nine ios_* tools and nothing else; mac_status is unknown; ios_status answers",
    JSON.stringify(o.map((k) => k.name)) === JSON.stringify(IOS) && (await only.call("mac_status")).text.startsWith("unknown tool: mac_status — the mac layer is off") && !(await only.call("ios_status")).isError, o.length);
  check("NORACU_LAYERS=iphone under the xcuitest backend: the instructions name ios_* tools only", /ios_snapshot/.test(onlyInit.instructions) && !/mac_|browser_|phone_/.test(onlyInit.instructions), onlyInit.instructions.slice(0, 120));
  await Promise.all([def.close(), x.close(), typo.close(), only.close()]);
}

// ---------- the whole loop on the model phone ----------
{
  const stop = join(tmpdir(), `noracu-ios-stop-${process.pid}`);
  const w = world({ env: { NORACU_STOP_FILE: stop, NORACU_USER_IDLE_S: "60" } });
  const st = J(await w.call("ios_status"));
  check("ios_status: device, lock, build and runner state — and xcodebuild was not started", st.device.name === "Test iPhone" && st.device.udid === UDID && st.locked === false && st.setup === "built" && st.runner.state === "not_started" && w.lines("xcodebuild.log").length === 0, st);

  const bad = [
    await w.call("ios_launch", { bundle_id: "--terminate-existing" }), await w.call("ios_tap", {}), await w.call("ios_tap", { element_index: 1, x: 1, y: 1 }),
    await w.call("ios_tap", { x: 1, y: 1, count: 2, duration_ms: 500 }), await w.call("ios_tap", { element_index: 1, bundle_id: SETTINGS }), await w.call("ios_type", { text: "" }),
    await w.call("ios_key", { key: "escape" }), await w.call("ios_swipe", { from: [1, 1], to: [1] }), await w.call("ios_swipe", { from: [1, 1], to: [2, 2], velocity: "warp" }),
  ];
  check("bad arguments are refused before anything starts, and input tools say nothing was sent", bad.every((r) => r.isError && r.text.endsWith(NOT_SENT)) && w.lines("xcodebuild.log").length === 0 && w.lines("xcrun.log").every((a) => !a.includes("launch")), bad.map((r) => r.text.slice(0, 60)));
  check("a read with a bad argument carries no delivery wording", /^ERROR: ios_snapshot: max_nodes must be an integer 1-1000$/.test((await w.call("ios_snapshot", { max_nodes: 0 })).text));

  const launch = await w.call("ios_launch", { bundle_id: SETTINGS });
  const xb = w.lines("xcodebuild.log"), launchArgv = w.lines("xcrun.log").find((a) => a.includes("launch"));
  check("ios_launch starts the runner once and brings the app forward (verified)", !launch.isError && launch.text === `launched ${SETTINGS} — it is in front (delivery=delivered_verified, retry=safe)` && xb.length === 1, launch.text);
  check("xcodebuild got an argv array, the tunnel address and a token — and the token is in no argument", xb[0].argv[0] === "test-without-building" && xb[0].argv.includes(`id=${UDID}`) && xb[0].argv.at(-1) === "-only-testing:NoracuRunnerUITests/NoracuRunner/testServe" && xb[0].bind === "::1" && xb[0].token_ok === true && xb[0].argv.every((a) => !/^[0-9a-f]{32}$/.test(a)), xb[0]);
  check("devicectl launch: the bundle id is one argument of its own", launchArgv.join(" ").includes(`device process launch --device ${UDID} ${SETTINGS} --quiet`), launchArgv);

  const snap = J(await w.call("ios_snapshot"));
  const el = (label) => snap.elements.find((e) => e.label === label);
  check("ios_snapshot: elements with indexes, frames and the screen size; the secure field has no value", snap.bundle_id === SETTINGS && snap.state === "runningForeground" && snap.screen.w === 402 && el("Wi-Fi").frame.length === 4 && !("value" in el("Passcode")) && el("General").disabled === true, snap.elements.slice(0, 3));

  const [s2, tap, ...more] = await Promise.all([w.call("ios_snapshot", { interactive: true }), w.call("ios_tap", { element_index: el("Wi-Fi").i }), w.call("ios_snapshot"), w.call("ios_snapshot"), w.call("ios_screenshot"), w.call("ios_snapshot")]);
  check("six ios_* calls at once are run one after the other (no runner_busy); the tap is delivered_unverified and not held up by user_active", more.every((r) => !r.isError) && !s2.isError && !tap.isError && /^tapped element_index \d+ \(cell "Wi-Fi"\) at \(201, 246\)/.test(tap.text) && tap.text.endsWith("(delivery=delivered_unverified, retry=unsafe)"), [s2.text.slice(0, 80), tap.text]);

  const TEXT = "noracu 测试 123";
  const typed = await w.call("ios_type", { element_index: el("Search").i, text: TEXT });
  check("ios_type into the search field is verified by reading it back, and does not repeat the text", !typed.isError && typed.text === `typed 13 characters in ${SETTINGS} — a text field shows them (delivery=delivered_verified, retry=unsafe)`, typed.text);
  const after = J(await w.call("ios_snapshot"));
  check("the field holds exactly the text", after.elements.find((e) => e.type === "searchField").value === TEXT);
  const del = await w.call("ios_key", { key: "delete", count: 4 });
  check("ios_key delete ×4", !del.isError && J(await w.call("ios_snapshot")).elements.find((e) => e.type === "searchField").value === "noracu 测试", del.text);

  const sw = await w.call("ios_swipe", { from: [200, 600], to: [200, 450] });
  const moved = J(await w.call("ios_snapshot")).elements.find((e) => e.label === "Wi-Fi").frame[1];
  check("ios_swipe moves the list (points in, points out)", !sw.isError && moved === el("Wi-Fi").frame[1] - 150, [sw.text, moved]);
  const stale = await w.call("ios_tap", { element_index: after.elements.find((e) => e.label === "Bluetooth").i });
  check("an element that moved since its snapshot is refused: element_no_longer_valid, nothing sent", stale.isError && /^ERROR: element_no_longer_valid: .*moved/.test(stale.text) && stale.text.endsWith(NOT_SENT), stale.text);

  const shot = await w.call("ios_screenshot");
  check("ios_screenshot returns an image block and the size in points", shot.image?.mimeType === "image/png" && shot.image.data.startsWith("iVBOR") && JSON.parse(shot.text).w === 402, shot.text);

  // the person's stop file
  writeFileSync(stop, "");
  const stopped = [await w.call("ios_tap", { x: 10, y: 10 }), await w.call("ios_home"), await w.call("ios_launch", { bundle_id: SETTINGS })];
  const taps = w.lines("runner.log").filter(([op]) => op === "tap").length;
  check("NORACU_STOP_FILE: every ios_* input returns user_stopped and nothing reaches the phone; reading still works", stopped.every((r) => r.isError && /^ERROR: user_stopped/.test(r.text)) && !(await w.call("ios_snapshot")).isError && w.lines("runner.log").filter(([op]) => op === "tap").length === taps && w.lines("runner.log").every(([op]) => op !== "home"), stopped[0].text);
  rmSync(stop, { force: true });

  // the lock, asked before every input
  w.put("lock", "locked");
  const locked = await w.call("ios_tap", { x: 10, y: 10 });
  w.put("lock", "missing");
  const unknown = await w.call("ios_tap", { x: 10, y: 10 });
  w.drop("lock");
  check("a locked iPhone gets nothing (device_locked); an answer without the lock field counts as locked (lock_unknown)", locked.isError && /^ERROR: device_locked/.test(locked.text) && locked.text.endsWith(NOT_SENT) && unknown.isError && /^ERROR: lock_unknown/.test(unknown.text) && w.lines("runner.log").filter(([op]) => op === "tap").length === taps, [locked.text, unknown.text]);

  // someone presses Home on the phone itself
  const s3 = J(await w.call("ios_snapshot"));
  w.control({ handle: ["home", {}] });
  const gone = await w.call("ios_tap", { element_index: s3.elements.find((e) => e.label === "Wi-Fi").i });
  check("the app left the front behind noracu's back: the index is refused", gone.isError && /no longer in front/.test(gone.text) && w.lines("runner.log").filter(([op]) => op === "tap").length === taps, gone.text);

  await w.call("ios_launch", { bundle_id: SETTINGS });
  const s4 = J(await w.call("ios_snapshot"));
  const home = await w.call("ios_home");
  const dead = await w.call("ios_tap", { element_index: s4.elements[0].i });
  const hs = J(await w.call("ios_snapshot"));
  check("ios_home: verified by the app leaving the front; earlier indexes end; the Home Screen is the default app", home.text === `home pressed — ${SETTINGS} left the front (delivery=delivered_verified, retry=safe)` && /^ERROR: element_no_longer_valid/.test(dead.text) && hs.bundle_id === SPRINGBOARD, [home.text, dead.text]);
  const absent = await w.call("ios_launch", { bundle_id: "com.example.absent" });
  check("an app that is not installed: launch_failed, nothing sent", absent.isError && absent.text === `ERROR: launch_failed: The application is not installed ${NOT_SENT}`, absent.text);
  check("still one xcodebuild for the whole session", w.lines("xcodebuild.log").length === 1);

  // the server goes away: the runner is told to quit and xcodebuild does not outlive it
  const pid = w.lines("xcodebuild.log")[0].pid;
  w.proc.stdin.end();
  await Promise.race([w.exited, sleep(5000)]);
  for (let i = 0; i < 30 && alive(pid); i++) await sleep(100);
  check("when the client goes away the runner gets quit and xcodebuild is gone with the server", !alive(pid) && w.lines("runner.log").some(([op]) => op === "quit"), { alive: alive(pid) });
  await w.close();
}

// ---------- the app rule, read-only mode ----------
{
  const w = world({ env: { NORACU_DENY_APPS: SETTINGS } });
  const r = await w.call("ios_launch", { bundle_id: SETTINGS });
  check("NORACU_DENY_APPS names the bundle id: input_denied, and xcodebuild is not even started", r.isError && /^ERROR: input_denied: "com\.apple\.Preferences" — denied by NORACU_DENY_APPS/.test(r.text) && r.text.endsWith(NOT_SENT) && w.lines("xcodebuild.log").length === 0, r.text);
  const other = await w.call("ios_launch", { bundle_id: "com.example.slow" });
  check("another app is not affected (and one that comes forward late is waited for)", !other.isError && /delivered_verified/.test(other.text), other.text);
  await w.close();
}
{
  // review S4C-s12 [D]: a blank NORACU_APPROVAL_FILE refuses iPhone input of the XCUITest backend too (fail closed)
  const w = world({ env: { NORACU_APPROVAL_FILE: "" } });
  const launch = await w.call("ios_launch", { bundle_id: SETTINGS });
  const tap = await w.call("ios_tap", { bundle_id: SETTINGS, x: 10, y: 10 });
  const typed = await w.call("ios_type", { bundle_id: SETTINGS, text: "hello" });
  check("a blank NORACU_APPROVAL_FILE: ios_launch, ios_tap and ios_type are refused (approval_file_error) and nothing is launched",
    [launch, tap, typed].every((r) => r.isError && /approval_file_error/.test(r.text)) && w.lines("xcrun.log").every((a) => !a.includes("launch")),
    [launch.text.slice(0, 90), tap.text.slice(0, 90), typed.text.slice(0, 90)]);
  await w.close();
}
{
  const file = join(tmpdir(), `noracu-ios-approval-${process.pid}.json`);
  writeFileSync(file, JSON.stringify({ allow: [SPRINGBOARD], ask: ["com.apple.Pref*"] })); chmodSync(file, 0o600);
  const w = world({ env: { NORACU_APPROVAL_FILE: file } });
  const ask = await w.call("ios_launch", { bundle_id: SETTINGS });
  const home = await w.call("ios_home");
  const unlisted = await w.call("ios_launch", { bundle_id: "com.example.slow" });
  check("NORACU_APPROVAL_FILE: an app under ask (or not listed) is approval_required; ios_home passes as com.apple.springboard", ask.isError && /^ERROR: approval_required/.test(ask.text) && !home.isError && unlisted.isError && /^ERROR: approval_required/.test(unlisted.text) && w.lines("xcrun.log").every((a) => !a.includes("launch")), [ask.text.slice(0, 90), home.text, unlisted.text.slice(0, 90)]);
  await w.close();
  // next-steps R4 (2026-11-12): with an approval file, no input that names the Home Screen goes out — an app in
  // front or not, a runner up or not — and none reaches the runner; ios_home still does
  writeFileSync(file, JSON.stringify({ allow: [SPRINGBOARD, SETTINGS] })); chmodSync(file, 0o600);
  const SB_DENIED = /^ERROR: input_denied: input that names com\.apple\.springboard \(the Home Screen\) is not sent while app rules are in force \(NORACU_APPROVAL_FILE or NORACU_DENY_APPS\) — not even one tap on a system prompt's button; open apps with ios_launch, go home with ios_home/;
  const v = world({ env: { NORACU_APPROVAL_FILE: file } });
  const up = await v.call("ios_launch", { bundle_id: SETTINGS });
  const sbTap = await v.call("ios_tap", { bundle_id: SPRINGBOARD, x: 100, y: 100 });
  const sbSwipe = await v.call("ios_swipe", { bundle_id: SPRINGBOARD, from: [100, 500], to: [100, 300] });
  const home2 = await v.call("ios_home");
  const sbTap2 = await v.call("ios_tap", { bundle_id: SPRINGBOARD, x: 100, y: 100 });
  const sent = (op) => v.lines("runner.log").filter(([o]) => o === op);
  check("with an approval file, a tap and a swipe that name com.apple.springboard are input_denied with an app in front and on the Home Screen, and none reaches the runner; ios_home still goes out",
    !up.isError && !home2.isError && [sbTap, sbSwipe, sbTap2].every((r) => r.isError && SB_DENIED.test(r.text) && r.text.endsWith(NOT_SENT))
      && sent("tap").length === 0 && sent("drag").length === 0, sbTap.text.slice(0, 200));
  await v.close();
  // pre-review P5: what is refused starts no runner (a starting runner puts its own app in front)
  const q = world({ env: { NORACU_APPROVAL_FILE: file } });
  const never = [await q.call("ios_type", { bundle_id: SPRINGBOARD, text: "hello" }), await q.call("ios_key", { bundle_id: SPRINGBOARD, key: "return" }), await q.call("ios_swipe", { bundle_id: SPRINGBOARD, from: [100, 500], to: [100, 300] }),
    await q.call("ios_tap", { bundle_id: SPRINGBOARD, x: 100, y: 100, duration_ms: 600 }), await q.call("ios_tap", { bundle_id: SPRINGBOARD, x: 100, y: 100, count: 2 }), await q.call("ios_tap", { bundle_id: SPRINGBOARD, x: 100, y: 100 })];
  check("with an approval file and no runner up, text, keys, a swipe, a long press, two taps and one tap named for com.apple.springboard are refused before xcodebuild is started",
    never.every((r) => r.isError && SB_DENIED.test(r.text) && r.text.endsWith(NOT_SENT))
    && q.lines("xcodebuild.log").length === 0 && q.lines("runner.log").length === 0, never.map((r) => r.text.slice(0, 90)));
  await q.close();
  // no rules: input that names the Home Screen is sent as asked, without springboard_only
  const free = world({ env: { NORACU_DENY_APPS: "none" } });
  await free.call("ios_launch", { bundle_id: SETTINGS });
  // …but not into an app: with Settings in front SpringBoard shows no icons, and the tap would land in Settings
  const covered = await free.call("ios_tap", { bundle_id: SPRINGBOARD, x: 100, y: 100 });
  check("with no app rules and an app in front, a tap that names com.apple.springboard is not sent into that app",
    covered.isError && /app_not_foreground: the Home Screen is not what the iPhone is showing/.test(covered.text) && covered.text.endsWith(NOT_SENT), covered.text.slice(0, 120));
  await free.call("ios_home");
  const freeTap = await free.call("ios_tap", { bundle_id: SPRINGBOARD, x: 100, y: 100 });
  const freeSent = free.lines("runner.log").filter(([o, a]) => o === "tap" && !a.includes("springboard_only"));
  check("with no app rules (NORACU_DENY_APPS=none, no approval file), a tap that names com.apple.springboard is sent as asked on the Home Screen, without springboard_only",
    !freeTap.isError && /^tapped/.test(freeTap.text) && freeSent.length === 1, freeTap.text.slice(0, 120));
  await free.close();
  // pre-review P6: the stop file and read-only mode are checked before a call reaches the session, so they
  // still answer first — refusing before the gate takes nothing from them
  const stopSb = join(tmpdir(), `noracu-ios-stop-sb-${process.pid}`);
  writeFileSync(stopSb, "");
  const u = world({ env: { NORACU_APPROVAL_FILE: file, NORACU_STOP_FILE: stopSb } });
  const halted = await u.call("ios_type", { bundle_id: SPRINGBOARD, text: "hello" });
  await u.close(); rmSync(stopSb, { force: true });
  const ro = world({ env: { NORACU_APPROVAL_FILE: file, NORACU_READ_ONLY: "1" } });
  const roKey = await ro.call("ios_key", { bundle_id: SPRINGBOARD, key: "return" });
  check("text and keys named for com.apple.springboard under rules: the stop file answers user_stopped and read-only mode answers that it blocks the tool — not input_denied",
    halted.isError && /^ERROR: user_stopped/.test(halted.text) && roKey.isError && /blocked by NORACU_READ_ONLY=1/.test(roKey.text), [halted.text.slice(0, 70), roKey.text.slice(0, 70)]);
  await ro.close(); rmSync(file, { force: true });
}
{
  const w = world({ env: { NORACU_READ_ONLY: "1" } });
  const blocked = [await w.call("ios_launch", { bundle_id: SETTINGS }), await w.call("ios_tap", { x: 1, y: 1 }), await w.call("ios_type", { text: "x" }), await w.call("ios_key", { key: "return" }), await w.call("ios_swipe", { from: [1, 1], to: [2, 2] }), await w.call("ios_home")];
  const read = await w.call("ios_snapshot", { bundle_id: SPRINGBOARD });
  const shot = await w.call("ios_screenshot", { bundle_id: SPRINGBOARD });
  const status = await w.call("ios_status");
  const lines = (f) => { try { return w.lines(f); } catch { return []; } };
  check("NORACU_READ_ONLY=1: the six ios_* input tools are blocked; ios_snapshot and ios_screenshot return runner_not_started and the runner is never started; ios_status answers", blocked.every((r) => r.isError && /blocked by NORACU_READ_ONLY=1/.test(r.text)) && read.isError && /^ERROR: runner_not_started: NORACU_READ_ONLY=1 does not start the runner/.test(read.text) && shot.isError && /^ERROR: runner_not_started: NORACU_READ_ONLY=1 does not start the runner/.test(shot.text) && !status.isError && lines("xcodebuild.log").length === 0 && lines("runner.log").length === 0, [blocked[0].text, read.text.slice(0, 120), shot.text.slice(0, 120), status.text.slice(0, 80)]);
  await w.close();
}

// ---------- no device, no build, a runner that does not start ----------
{
  const none = world({ devices: [] });
  const st = J(await none.call("ios_status")), r = await none.call("ios_tap", { bundle_id: SETTINGS, x: 1, y: 1 });
  check("no iPhone: ios_status explains, an input says nothing was sent", /^device_not_found/.test(st.problem) && r.isError && /^ERROR: device_not_found/.test(r.text) && r.text.endsWith(NOT_SENT), [st.problem, r.text]);
  await none.close();
  const unbuilt = world({ built: false });
  const u = await unbuilt.call("ios_snapshot", { bundle_id: SPRINGBOARD });
  check("no runner build: the answer is the ios-setup command, and xcodebuild is not started", u.isError && u.text === `ERROR: ios_setup_required: no runner build for this device — run: npx noracu ios-setup --team <TeamID> --udid ${UDID}` && unbuilt.lines("xcodebuild.log").length === 0, u.text);
  await unbuilt.close();
  const refused = world();
  refused.put("runner-mode", "error");
  const e = await refused.call("ios_snapshot", { bundle_id: SPRINGBOARD });
  refused.put("runner-mode", "v2");
  const v = await refused.call("ios_snapshot", { bundle_id: SPRINGBOARD });
  check("a runner that refuses to start, or speaks another protocol version, is reported as such", e.isError && /^ERROR: runner_start_failed: the runner refused to start: bad_bind/.test(e.text) && v.isError && /^ERROR: runner_version_mismatch/.test(v.text), [e.text, v.text]);
  refused.put("runner-mode", "stale");
  const old = await refused.call("ios_snapshot", { bundle_id: SPRINGBOARD });
  check("a runner built from other sources is started once more, then reported: run the set-up again",
    old.isError && /^ERROR: runner_version_mismatch: the runner on the device is build 0123456789ab, this noracu's is [0-9a-f]{12} — run the iOS set-up again/.test(old.text) && refused.lines("xcodebuild.log").length === 4, [old.text, refused.lines("xcodebuild.log").length]);
  await refused.close();
  const rebuilt = world();
  rebuilt.put("runner-mode", "stale-once");
  const second = await rebuilt.call("ios_snapshot", { bundle_id: SPRINGBOARD });
  check("the first start ran another build, as seen after a rebuild: the second start is used and the call succeeds", !second.isError && rebuilt.lines("xcodebuild.log").length === 2, [second.text.slice(0, 100), rebuilt.lines("xcodebuild.log").length]);
  await rebuilt.close();
  const simw = world({ env: { NORACU_IOS_UDID: "1A2B3C4D-5E6F-4A7B-8C9D-0E1F2A3B4C5D" }, devices: [device(), device({ hardware: { udid: "1A2B3C4D-5E6F-4A7B-8C9D-0E1F2A3B4C5D", reality: "simulated", marketingName: "iPhone 17 Pro" }, connection: { transportType: "sameMachine", tunnelIPAddress: undefined } })], built: false });
  mkdirSync(join(simw.dir, "runner", "1A2B3C4D-5E6F-4A7B-8C9D-0E1F2A3B4C5D", "Build", "Products"), { recursive: true });
  writeFileSync(join(simw.dir, "runner", "1A2B3C4D-5E6F-4A7B-8C9D-0E1F2A3B4C5D", "Build", "Products", "NoracuRunner_iphonesimulator.xctestrun"), "");
  const sl = await simw.call("ios_launch", { bundle_id: SETTINGS });
  check("a simulator named in NORACU_IOS_UDID: bound to 127.0.0.1, launched through simctl, no lock question", !sl.isError && simw.lines("xcodebuild.log")[0].bind === "127.0.0.1" && simw.lines("xcrun.log").some((a) => a[0] === "simctl" && a.at(-1) === SETTINGS) && simw.lines("xcrun.log").every((a) => !a.includes("lockState")), [sl.text, simw.lines("xcrun.log").map((a) => a.slice(0, 4).join(" "))]);
  await simw.close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n=== noracu ios e2e: ${results.length - failed.length}/${results.length} PASS ===`);
if (failed.length) console.log("FAILED:\n" + failed.map((f) => " - " + f.name).join("\n"));
process.exit(failed.length ? 1 : 0);

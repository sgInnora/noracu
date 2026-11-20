// ios-session unit tests (0.3.0). CI-safe: no iPhone, no Xcode — the session runs against a model phone
// (test/fixtures/fake-ios.mjs) and a fake devicectl / xcodebuild layer. They pin down what the ios_* tools
// promise: nothing is sent past the app rule, a locked phone or a stale element_index; nothing is re-sent;
// ios_type is verified only by reading the field back.
import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import * as real from "../src/ios-xcuitest.js";
import { createIosSession, fieldShows, SPRINGBOARD } from "../src/ios-session.js";
import { makePhone, SETTINGS } from "./fixtures/fake-ios.mjs";

const UDID = "00008140-001A2B3C4D5E6F70", UDID2 = "00008150-000A1B2C3D4E5F60", SIM = "1A2B3C4D-5E6F-4A7B-8C9D-0E1F2A3B4C5D";
const dev = (o = {}) => ({ udid: UDID, name: "Test iPhone", model: "iPhone 16 Pro", os: "27.2", platform: "iOS", simulated: false, transport: "wired", paired: true, tunnel: true, tunnelIP: "fd09:6c3e:c65c::1", developerMode: true, booted: true, ...o });
const sim = () => dev({ udid: SIM, name: "iPhone 17 Pro", simulated: true, transport: "sameMachine", tunnelIP: null });
let n = 0;
const ok = (cond, name, detail) => { n++; assert.ok(cond, `${name}${detail === undefined ? "" : " | " + JSON.stringify(detail)?.slice(0, 600)}`); };
const J = (r) => JSON.parse(r.text);
const NOT_SENT = "(delivery=not_delivered, retry=safe)";

function rig({ env = {}, sbDenied = false } = {}) {
  const phone = makePhone();
  const t = { now: 1_000_000, starts: 0, stopped: 0, launches: [], locks: 0, lock: { ok: true, locked: false }, lockSeq: [], approvedOps: [], snapMs: 0, launchFail: null, devices: [dev()], xctestrun: "/x/b.xctestrun", denied: null, approved: [], children: [], startFail: null };
  const api = {
    ...real,
    listDevices: async () => { t.dcLists = (t.dcLists || 0) + 1; return t.listFail ? { ok: false, error: "devicectl_failed", message: "xcrun: no devicectl" } : { ok: true, devices: t.devices }; },
    listSimulators: async () => { t.simLists = (t.simLists || 0) + 1; return t.simFail ? { ok: false, error: "simctl_failed", message: "xcrun: no simctl" } : { ok: true, devices: t.devices.filter((d) => d.simulated) }; },
    deviceDetails: async (udid) => ({ ok: true, device: { ...t.devices.find((d) => d.udid === udid), tunnelIP: "fd09:6c3e:c65c::1" } }),
    lockState: async () => { t.locks++; if (t.lockGate) await t.lockGate; return t.lockSeq.length ? t.lockSeq.shift() : t.lock; },
    launchApp: async (udid, b, opts) => { if (t.onLaunchPrep) t.onLaunchPrep(); const no = opts?.beforeRun?.(); if (no) return no; t.launches.push(["device", b, opts, t.starts]); if (t.launchFail) return t.launchFail; return phone.launch(b) ? { ok: true, pid: 1, activated: true } : { ok: false, error: "devicectl_failed", message: "The application is not installed" }; },
    simLaunch: async (udid, b, opts) => { if (t.onLaunchPrep) t.onLaunchPrep(); const no = opts?.beforeRun?.(); if (no) return no; t.launches.push(["sim", b, opts, t.starts]); return phone.launch(b) ? { ok: true, pid: 1, activated: true } : { ok: false, error: "simctl_failed", message: "not installed" }; },
    findXctestrun: async (d) => { t.xdir = d; return t.xctestrun; },
    startRunner: async (args) => {
      t.starts++; t.startArgs = args;
      if (t.startGate) await t.startGate;
      if (t.startSeq?.length) return t.startSeq.shift();
      if (t.startFail) return t.startFail;
      const child = new EventEmitter(); t.children.push(child);
      // t.snapMs: reading the app takes that long on this rig's clock
      const client = phone.client(), call = client.call.bind(client);
      client.call = async (op, args, o) => { if (op === "snapshot") t.now += t.snapMs; if (t.onCall) t.onCall(op); return call(op, args, o); };
      return { ok: true, client, port: 50000, child, stop: () => { t.stopped++; }, ...(t.exited ? { exited: t.exited } : {}) };
    },
    killPending: () => { t.killed = (t.killed || 0) + 1; },
  };
  const s = createIosSession({ env, api, runnerDir: "/x", stopCheck: () => t.stop || null, springboardDenied: () => sbDenied, approve: (b, op) => { t.approved.push(b); t.approvedOps.push(op); return t.denied; }, now: () => t.now, sleep: async (ms) => { t.now += ms; if (t.hold && ms >= 4000) await t.hold; }, onChild: (c) => { t.onChild = c; } });
  const ops = (op) => phone.log.filter(([o]) => o === op);
  const idx = async (label, extra = {}) => J(await s.snapshot(extra)).elements.find((e) => e.label === label).i;
  return { s, t, phone, ops, idx };
}

// ---------- status and device choice ----------
{
  const { s, t } = rig();
  const st = J(await s.status());
  ok(st.backend === "xcuitest" && st.device.udid === UDID && st.locked === false && st.setup === "built" && st.runner.state === "not_started" && t.starts === 0, "ios_status describes the device, its lock and the runner build, and starts nothing", st);
}
{
  const { s, t } = rig(); t.devices = [];
  ok(/^device_not_found: no paired iPhone/.test(J(await s.status()).problem), "no iPhone: ios_status says so");
  t.devices = [dev(), dev({ udid: UDID2, name: "Second" })];
  const p = J(await s.status()).problem;
  ok(/^device_ambiguous/.test(p) && p.includes(UDID) && p.includes(UDID2), "two iPhones: the answer names both and asks for NORACU_IOS_UDID", p);
  t.devices = [dev({ tunnel: false, tunnelIP: null }), sim()];
  ok(/^device_not_found/.test(J(await s.status()).problem), "an iPhone without a live connection is not used, and a simulator is never picked on its own");
  t.listFail = true;
  ok(/^devicectl_failed: xcrun: no devicectl/.test(J(await s.status()).problem), "devicectl missing: reported as it is");
}
{
  const a = rig({ env: { NORACU_IOS_UDID: UDID2 } }); a.t.devices = [dev(), dev({ udid: UDID2, name: "Second" })];
  ok(J(await a.s.status()).device.name === "Second", "NORACU_IOS_UDID chooses among several");
  const b = rig({ env: { NORACU_IOS_UDID: "My iPhone" } });
  ok(/^ios_config/.test(J(await b.s.status()).problem), "NORACU_IOS_UDID that is not an identifier is refused");
  const c = rig({ env: { NORACU_IOS_UDID: SIM } }); c.t.devices = [dev(), sim()];
  const st = J(await c.s.status());
  ok(st.device.simulated === true && st.locked === undefined && c.t.locks === 0, "a simulator named in NORACU_IOS_UDID is used, and nobody asks for its lock state", st);
}
{
  // a simulator is looked up with simctl alone: a devicectl that fails or gives no answer (Xcode 26.6 on a CI runner) is not asked
  const c = rig({ env: { NORACU_IOS_UDID: SIM } }); c.t.devices = [dev(), sim()]; c.t.listFail = true;
  const st = J(await c.s.status());
  const r = await c.s.launch({ bundle_id: SETTINGS });
  ok(st.device?.udid === SIM && st.device.simulated && !st.problem && /delivered_verified/.test(r.text) && c.t.launches[0][0] === "sim" && !c.t.dcLists && c.t.simLists >= 1,
    "a simulator named in NORACU_IOS_UDID is found with simctl and used while devicectl does not work — devicectl is not asked", [st, r, c.t.dcLists]);
  const down = rig({ env: { NORACU_IOS_UDID: SIM } }); down.t.devices = [sim()]; down.t.simFail = true;
  ok(/^simctl_failed: xcrun: no simctl/.test(J(await down.s.status()).problem) && !down.t.dcLists, "a simctl that fails: ios_status says so, and devicectl is not asked instead");
  const p = rig(); p.t.devices = [dev(), sim()];
  const ps = J(await p.s.status());
  ok(ps.device?.udid === UDID && p.t.dcLists === 1 && !p.t.simLists, "without NORACU_IOS_UDID an iPhone is looked up with devicectl, and simctl is not asked", [ps, p.t.dcLists, p.t.simLists]);
}
{
  const { s, t, phone } = rig(); t.xctestrun = null;
  const st = J(await s.status());
  const r = await s.snapshot({ bundle_id: SPRINGBOARD });
  ok(st.setup.startsWith("missing") && r.error === `ios_setup_required: no runner build for this device — run: npx noracu ios-setup --team <TeamID> --udid ${UDID}` && t.starts === 0 && phone.log.length === 0 && t.xdir === `/x/${UDID}`, "no runner build: the answer is the command to run, and xcodebuild is not started", [st.setup, r.error]);
}
{
  const { s, t } = rig(); t.lock = { ok: true, locked: true };
  const r = await s.snapshot({ bundle_id: SPRINGBOARD });
  ok(/^device_locked/.test(r.error) && t.starts === 0, "a locked iPhone: the runner is not started", r);
  t.lock = { ok: false, error: "devicectl_failed", message: "lockState answer has no passcodeRequired" };
  const u = await s.tap({ bundle_id: SPRINGBOARD, x: 10, y: 10 });
  ok(/^lock_unknown/.test(u.error) && u.error.endsWith(NOT_SENT) && t.starts === 0, "a lock state that cannot be read counts as locked", u);
}
{
  const { s, t } = rig({ env: { NORACU_READ_ONLY: "1" } });
  const snap = await s.snapshot({ bundle_id: SPRINGBOARD });
  const shot = await s.screenshot({ bundle_id: SPRINGBOARD });
  ok(/^runner_not_started: NORACU_READ_ONLY=1 does not start the runner/.test(snap.error) && /^runner_not_started: NORACU_READ_ONLY=1 does not start the runner/.test(shot.error) && t.starts === 0, "NORACU_READ_ONLY=1: ios_snapshot and ios_screenshot return runner_not_started and the runner is never started", [snap.error, shot.error]);
  const st = J(await s.status());
  ok(st.backend === "xcuitest", "NORACU_READ_ONLY=1: ios_status still answers", st);
}

// ---------- the runner starts once, on demand ----------
{
  const { s, t } = rig();
  const [a, b] = await Promise.all([s.snapshot({ bundle_id: SPRINGBOARD }), s.snapshot({ bundle_id: SPRINGBOARD })]);
  ok(a.text && b.text && t.starts === 1 && t.startArgs.bind === "fd09:6c3e:c65c::1" && t.startArgs.udid === UDID && t.startArgs.xctestrun === "/x/b.xctestrun" && t.onChild === t.children[0], "two first calls share one runner start, bound to the device's tunnel address", t.startArgs);
}
{
  const { s, t } = rig(); t.startFail = { ok: false, error: "runner_start_timeout", message: "the runner was not ready in 120000 ms" };
  const r = await s.tap({ bundle_id: SPRINGBOARD, x: 10, y: 10 });
  ok(r.error === `runner_start_timeout: the runner was not ready in 120000 ms ${NOT_SENT}`, "a runner that does not start: the input says nothing was sent", r);
}

// ---------- snapshot ----------
{
  const { s, t } = rig();
  ok(/^bundle_id required/.test((await s.snapshot()).error) && t.starts === 0, "ios_snapshot with no app named and none launched asks for one");
  ok(/^app_not_running: .*call ios_launch first$/.test((await s.snapshot({ bundle_id: SETTINGS })).error), "a snapshot of an app that is not running says so (a read: no delivery wording)");
  await s.launch({ bundle_id: SETTINGS });
  const one = J(await s.snapshot());
  const pass = one.elements.find((e) => e.type === "secureTextField"), general = one.elements.find((e) => e.label === "General");
  ok(one.bundle_id === SETTINGS && one.state === "runningForeground" && one.screen.w === 402 && one.count === one.elements.length && one.truncated === false && !("value" in pass) && general.disabled === true && !("note" in one), "ios_snapshot: the launched app is the default; a secure field has no value; a disabled row is marked", one);
  const two = J(await s.snapshot());
  const all = [...one.elements, ...two.elements].map((e) => e.i);
  ok(new Set(all).size === all.length && two.snapshot_id !== one.snapshot_id && Math.min(...two.elements.map((e) => e.i)) > Math.max(...one.elements.map((e) => e.i)), "element_index is unique across snapshots");
  const inter = J(await s.snapshot({ interactive: true }));
  ok(inter.elements.length > 0 && inter.elements.every((e) => e.type !== "staticText"), "interactive:true leaves out plain text");
  const cut = J(await s.snapshot({ max_nodes: 2 }));
  ok(cut.count === 2 && cut.truncated === true, "max_nodes cuts the list and says so");
  await s.home();
  const bg = J(await s.snapshot({ bundle_id: SETTINGS }));
  ok(bg.state === "runningBackground" && /not in front/.test(bg.note), "a snapshot of an app in the background is marked as such", bg.note);
}

// ---------- tap ----------
{
  const { s, t, phone, ops, idx } = rig();
  await s.launch({ bundle_id: SETTINGS });
  const wifi = await idx("Wi-Fi");
  const r = await s.tap({ element_index: wifi });
  ok(r.text === `tapped element_index ${wifi} (cell "Wi-Fi") at (201, 246) in ${SETTINGS} — sent; the screen is not checked (delivery=delivered_unverified, retry=unsafe)` && ops("tap").length === 1 && ops("tap")[0][1].x === 201 && ops("tap")[0][1].y === 246, "ios_tap by element_index taps the centre of the element as it is now", r);
  const i2 = await idx("Bluetooth");
  t.now += 30001;
  const old = await s.tap({ element_index: i2 });
  ok(/^element_no_longer_valid/.test(old.error) && old.error.endsWith(NOT_SENT) && ops("tap").length === 1, "an index older than 30 s is refused and nothing is sent", old);
  const snap = J(await s.snapshot());
  const i3 = snap.elements.find((e) => e.label === "Bluetooth").i;
  ok(/^element_no_longer_valid/.test((await s.tap({ element_index: i3, snapshot_id: "ios-999" })).error), "an index with another snapshot's id is refused");
  phone.scroll = 40;
  const moved = await s.tap({ element_index: i3 });
  ok(/^element_no_longer_valid: .*moved; take a new ios_snapshot/.test(moved.error) && ops("tap").length === 1, "an element that moved since the snapshot is not tapped", moved);
  phone.scroll = 0;
  const field = await idx("Search");
  await s.tap({ element_index: field });
  const key = await idx("q");
  phone.keyboard = false;
  const gone = await s.tap({ element_index: key });
  ok(/gone or changed/.test(gone.error) && ops("tap").length === 2, "an element that is gone is not tapped", gone);
}
{
  const { s, phone, ops, idx } = rig();
  await s.launch({ bundle_id: SETTINGS });
  const wifi = await idx("Wi-Fi");
  phone.handle("home");                                  // someone pressed Home on the phone itself
  const r = await s.tap({ element_index: wifi });
  ok(/^element_no_longer_valid: .*no longer in front/.test(r.error) && ops("tap").length === 0, "the app left the front behind noracu's back: nothing is tapped", r);
  await s.launch({ bundle_id: SETTINGS });
  const again = await idx("Wi-Fi");
  await s.home();
  await s.launch({ bundle_id: SETTINGS });
  const dead = await s.tap({ element_index: again });
  ok(/^element_no_longer_valid/.test(dead.error) && ops("tap").length === 0, "ios_home and ios_launch end every earlier index, even inside 30 s and with the app back in front", dead);
}
{
  const { s, ops } = rig();
  await s.launch({ bundle_id: SETTINGS });
  const a = await s.tap({ x: 10.5, y: 300 });
  const b = await s.tap({ x: 5000, y: 10 });
  const c = await s.tap({ x: 10, y: 10, count: 2 });
  const d = await s.tap({ x: 10, y: 10, duration_ms: 800 });
  ok(/^tapped the point at \(10\.5, 300\)/.test(a.text) && b.error === `invalid_args: point outside screen ${NOT_SENT}` && ops("tap")[2][1].count === 2 && /^tapped ×2/.test(c.text) && ops("press").length === 1 && ops("press")[0][1].duration_ms === 800 && /^pressed 800 ms on the point/.test(d.text), "raw points, a point off screen, a double tap and a long press", [a, b, c, d]);
  const bg = await s.tap({ bundle_id: "com.example.stuck", x: 10, y: 10 });
  ok(/^app_not_running: .*call ios_launch first \(delivery=not_delivered, retry=safe\)$/.test(bg.error), "a tap for an app that is not running is refused before anything is sent", bg);
}

// ---------- the gates before every input ----------
{
  const { s, t, phone } = rig();
  t.denied = `input_denied: "com.apple.Preferences" — denied by NORACU_DENY_APPS ("com.apple.Preferences") ${NOT_SENT}`;
  const rs = [await s.launch({ bundle_id: SETTINGS }), await s.tap({ bundle_id: SETTINGS, x: 1, y: 1 }), await s.type({ bundle_id: SETTINGS, text: "x" }), await s.key({ bundle_id: SETTINGS, key: "return" }), await s.swipe({ bundle_id: SETTINGS, from: [1, 1], to: [2, 2] }), await s.home()];
  ok(rs.every((r) => r.error === t.denied) && t.starts === 0 && phone.log.length === 0 && t.launches.length === 0 && t.approved.at(-1) === SPRINGBOARD, "an app the deny list or approval file rules out gets no input — the runner is not even started; ios_home is judged as the Home Screen", t.approved);
}
{
  const { s, t, phone, idx } = rig();
  await s.launch({ bundle_id: SETTINGS });
  const wifi = await idx("Wi-Fi");
  const before = phone.log.length, launches = t.launches.length;
  t.lock = { ok: true, locked: true };
  const rs = [await s.tap({ element_index: wifi }), await s.tap({ x: 1, y: 1 }), await s.type({ text: "x" }), await s.key({ key: "return" }), await s.swipe({ from: [1, 1], to: [2, 2] }), await s.home(), await s.launch({ bundle_id: SETTINGS })];
  ok(rs.every((r) => /^device_locked/.test(r.error) && r.error.endsWith(NOT_SENT)) && phone.log.length === before && t.launches.length === launches, "the iPhone locked meanwhile: every input is refused and nothing reaches it", rs[0]);
  t.lock = { ok: false, error: "devicectl_timeout", message: "devicectl device info lockState gave no answer in 30000 ms" };
  const u = await s.tap({ x: 1, y: 1 });
  ok(/^lock_unknown: .*fail closed/.test(u.error) && phone.log.length === before, "no answer about the lock: refused as well", u);
  ok((await s.snapshot()).text && (await s.screenshot()).image, "within a second of the last unlocked answer a read goes ahead (this rig's clock stands still)");
}
{
  const { s, t } = rig({ env: { NORACU_IOS_UDID: SIM } }); t.devices = [sim()];
  const r = await s.launch({ bundle_id: SETTINGS });
  await s.tap({ x: 1, y: 1 });
  ok(/delivered_verified/.test(r.text) && t.launches[0][0] === "sim" && t.locks === 0 && t.startArgs.bind === "127.0.0.1", "a simulator: launched through simctl, bound to 127.0.0.1, no lock checks", [r, t.launches]);
}

// ---------- type ----------
{
  const { s, phone, ops, idx } = rig();
  await s.launch({ bundle_id: SETTINGS });
  const field = await idx("Search");
  const TEXT = "noracu 测试 123";
  const r = await s.type({ element_index: field, text: TEXT });
  ok(r.text === `typed 13 characters in ${SETTINGS} — a text field shows them (delivery=delivered_verified, retry=unsafe)` && phone.search === TEXT && ops("tap").length === 1 && ops("type").length === 1, "ios_type into a field: tapped, typed, read back — verified; the result does not repeat the text", r);
  const more = await s.type({ text: " 123" });
  ok(/delivered_verified/.test(more.text) && phone.search === TEXT + " 123", "typing text the field already ends with is still verified by counting", more);
  const short = await s.type({ text: "ab" });
  ok(short.text === `typed 2 characters in ${SETTINGS} — too short to tell from what was already there, so nothing was read back (delivery=delivered_unverified, retry=unsafe)` && phone.search.endsWith("ab"), "three characters or fewer: typed, and not called verified", short);
}
// Control Center over the app: the app still reports itself in front and is read as usual; SpringBoard shows icons
{
  const { s, phone, ops } = rig();
  await s.launch({ bundle_id: SETTINGS });
  phone.overlay = true;
  const tap = await s.tap({ x: 200, y: 760 });
  const swipe = await s.swipe({ from: [200, 600], to: [200, 300] });
  const typed = await s.type({ text: "hello" });
  phone.overlay = false;
  const after = await s.tap({ x: 200, y: 760 });
  ok([tap, swipe, typed].every((r) => /^system_overlay: /.test(r.error || "") && /delivery=not_delivered/.test(r.error)) && ops("tap").length === 1 && ops("drag").length === 0 && ops("type").length === 0 && !after.error,
    "Control Center over the app (it still reports itself in front): taps, swipes and text are not sent; once it is gone they are", [tap, swipe, typed, after, ops("tap").length]);
  // the answer does not say it is Control Center (icons also show while an app is still coming forward): look again
  // in a moment first; ios_home closes it but leaves the app
  ok(/in a moment/.test(tap.error) && /leaves the app/.test(tap.error) && /ios_launch brings the app back/.test(tap.error) && !/\(Control Center\) —/.test(tap.error),
    "system_overlay: Control Center is one case of several, the next step is to look again in a moment, and ios_home is said to leave the app", tap.error);
}
// the stop file made, or the phone locked, while the iPhone is looked at before an input: the input is not sent
{
  const { s, ops, t } = rig();
  await s.launch({ bundle_id: SETTINGS });
  t.onCall = (op) => { if (op === "front") t.stop = "user_stopped: /tmp/stop exists — the person at the Mac stopped noracu's input; nothing was sent (delivery=not_delivered, retry=safe); remove the file to resume"; };
  const stopped = await s.tap({ x: 200, y: 760 });
  t.onCall = null; t.stop = null;
  ok(stopped.error === "user_stopped: /tmp/stop exists — the person at the Mac stopped noracu's input; remove the file to resume (delivery=not_delivered, retry=safe)" && ops("tap").length === 0,
    "the stop file made while the iPhone is looked at before a tap: the tap is not sent, and the answer says so once", stopped);
  t.onCall = (op) => { if (op === "front") { t.now += 1500; t.lock = { ok: true, locked: true }; } };
  const locked = await s.tap({ x: 200, y: 760 });
  t.onCall = null; t.lock = { ok: true, locked: false };
  ok(/^device_locked: /.test(locked.error || "") && /delivery=not_delivered/.test(locked.error) && ops("tap").length === 0,
    "the iPhone locked while it is looked at before a tap (the unlocked answer is then older than a second): read again, the tap is not sent", locked);
  const after = await s.tap({ x: 200, y: 760 });
  ok(!after.error && ops("tap").length === 1, "with the stop file gone and the iPhone unlocked, the same tap is sent", after);
}
// the stop file made while that lock read is under way (devicectl can take seconds): the input is not sent either —
// the stop file is the last thing looked at
{
  const { s, ops, t } = rig();
  await s.launch({ bundle_id: SETTINGS });
  const STOP = "user_stopped: /tmp/stop exists — the person at the Mac stopped noracu's input; nothing was sent (delivery=not_delivered, retry=safe); remove the file to resume";
  t.onCall = (op) => { if (op === "front") { t.now += 1500; t.lockGate = { then: (res) => { t.stop = STOP; res(); } }; } };
  const r = await s.tap({ x: 200, y: 760 });
  t.onCall = null; t.lockGate = null; t.stop = null;
  ok(/^user_stopped: /.test(r.error || "") && ops("tap").length === 0,
    "the stop file made while the lock is read again right before a tap: the tap is not sent", r);
}
// the stop file made while the client still opens its connection to the runner (a runner just started has none; up
// to 5 s), after the session's own looks: the client looks once more right before it writes, and the tap is not sent
{
  const { s, ops, t } = rig();
  await s.launch({ bundle_id: SETTINGS });
  const STOP = "user_stopped: /tmp/stop exists — the person at the Mac stopped noracu's input; nothing was sent (delivery=not_delivered, retry=safe); remove the file to resume";
  t.onCall = (op) => { if (op === "tap") t.stop = STOP; };
  const r = await s.tap({ x: 200, y: 760 });
  t.onCall = null; t.stop = null;
  ok(/^user_stopped: /.test(r.error || "") && ops("tap").length === 0,
    "the stop file made while the client opens its connection: the tap is not written", r);
}
// …but icons that are only on their way out (the app has just come to the front) do not refuse the input
{
  const { s, phone, ops } = rig();
  await s.launch({ bundle_id: SETTINGS });
  let reads = 2;   // the fake reads phone.overlay twice per `front`: icons for the first one only
  Object.defineProperty(phone, "overlay", { configurable: true, get: () => reads-- > 0 });
  const r = await s.tap({ x: 200, y: 760 });
  ok(!r.error && /delivered_unverified/.test(r.text || "") && ops("tap").length === 1, "icons still showing for a moment after the app came to the front: looked at again, and the tap goes out", [r, ops("tap").length]);
}
// …also when they take a little longer to go (three looks still show them)
{
  const { s, phone, ops } = rig();
  await s.launch({ bundle_id: SETTINGS });
  let reads = 6;   // two reads of phone.overlay per `front`: icons for the first three
  Object.defineProperty(phone, "overlay", { configurable: true, get: () => reads-- > 0 });
  const r = await s.tap({ x: 200, y: 760 });
  ok(!r.error && /delivered_unverified/.test(r.text || "") && ops("tap").length === 1 && ops("front").length === 4, "icons still showing at the first three looks after the app came to the front: the tap goes out at the fourth", [r, ops("front").length]);
}
// An input named for the Home Screen while an app is what the iPhone shows (it came forward after ios_home, behind
// noracu's back): com.apple.springboard still reads as in front, but shows no icons — nothing is sent into that app
{
  const { s, phone, ops } = rig();
  await s.launch({ bundle_id: SETTINGS });
  await s.home();
  phone.front = "com.example.slow"; phone.state["com.example.slow"] = 4;
  const tap = await s.tap({ x: 200, y: 400 });
  const swipe = await s.swipe({ from: [300, 400], to: [60, 400] });
  const sent = (op) => ops(op).filter(([, a]) => a.bundle_id === SPRINGBOARD && a.springboard_only !== true).length;
  ok([tap, swipe].every((r) => /^app_not_foreground: the Home Screen is not what the iPhone is showing/.test(r.error || "") && /delivery=not_delivered/.test(r.error)) && sent("tap") === 0 && sent("drag") === 0,
    "an app came to the front after ios_home: a tap and a swipe named for the Home Screen are not sent into it", [tap, swipe]);
  // a system alert over that app: one tap on its button still goes out, after one look
  phone.alert = { frame: [40, 300, 320, 200], buttons: [[60, 440, 130, 44]] };
  const n = ops("front").length;
  const allow = await s.tap({ bundle_id: SPRINGBOARD, x: 100, y: 460 });
  ok(!allow.error && /delivered_unverified/.test(allow.text || "") && ops("front").length === n + 1, "…one tap on a button of a system alert over that app still goes out, after one look", [allow, ops("front").length - n]);
  phone.alert = null;
  // back on the Home Screen the tap goes out as before
  phone.front = SPRINGBOARD; phone.state["com.example.slow"] = 3;
  const home = await s.tap({ x: 200, y: 400 });
  ok(!home.error && /delivered_unverified/.test(home.text || "") && sent("tap") === 1, "…and on the Home Screen itself the tap goes out", [home, sent("tap")]);
}
// …and while the app this session brought forward still reads as in front, icons that SpringBoard still shows (one
// that has not gone yet right after ios_launch, or Control Center's) do not make the Home Screen of it
{
  const { s, phone, ops } = rig();
  await s.launch({ bundle_id: SETTINGS });
  phone.overlay = true;   // the fake's `front` reports icons while Settings stays in front
  const r = await s.tap({ bundle_id: SPRINGBOARD, x: 200, y: 400 });
  ok(/^app_not_foreground: the Home Screen is not what the iPhone is showing/.test(r.error || "") && /delivery=not_delivered/.test(r.error)
    && ops("tap").every(([, a]) => a.bundle_id !== SPRINGBOARD || a.springboard_only === true),
    "the app that was launched is still in front and SpringBoard still shows icons: a tap named for the Home Screen is not sent into the app", r);
}
// …nor after a call that named the Home Screen in between: a snapshot of it, or text typed there, does not make the
// app that is still in front forgotten
{
  const { s, phone, ops } = rig();
  await s.launch({ bundle_id: SETTINGS });
  await s.snapshot({ bundle_id: SPRINGBOARD });
  phone.overlay = true;   // icons (Control Center) while Settings stays in front
  const tap = await s.tap({ bundle_id: SPRINGBOARD, x: 200, y: 400 });
  const typed = await s.type({ bundle_id: SPRINGBOARD, text: "abcd" });
  phone.overlay = false;
  const into = (op) => ops(op).filter(([, a]) => a.bundle_id === SPRINGBOARD && a.springboard_only !== true).length;
  ok([tap, typed].every((r) => /^app_not_foreground: the Home Screen is not what the iPhone is showing/.test(r.error || "") && /delivery=not_delivered/.test(r.error)) && into("tap") === 0 && into("type") === 0,
    "a snapshot of the Home Screen taken while the launched app is still in front: a tap and text named for the Home Screen are still not sent into the app", [tap, typed]);
}
// the state of that app cannot be read: a failed look like the one at SpringBoard — nothing is sent, a failure XCTest
// recorded ends the session, and no answer makes the next call ask for a sign of life first
{
  const { s, phone, ops } = rig();
  await s.launch({ bundle_id: SETTINGS });
  phone.overlay = true; phone.issue = "app_state";
  const a = await s.tap({ bundle_id: SPRINGBOARD, x: 200, y: 400 });
  phone.issue = null;
  const ended = !s._state().running;
  ok(/^xctest_issue: .*whether com\.apple\.Preferences, the app this session brought forward, is still in front — the input was not sent\).*\(delivery=not_delivered, retry=safe\)$/.test(a.error || "") && ops("tap").length === 0 && ended,
    "the state of the launched app cannot be read before an input named for the Home Screen (XCTest recorded a failure): nothing is sent, and the session ends", [a, ended]);
}
{
  const { s, phone, ops } = rig();
  await s.launch({ bundle_id: SETTINGS });
  phone.overlay = true; phone.hang = "app_state";
  const b = await s.tap({ bundle_id: SPRINGBOARD, x: 200, y: 400 });
  phone.hang = null;
  ok(/^ios_timeout: .*\(delivery=not_delivered, retry=safe\)$/.test(b.error || "") && ops("tap").length === 0 && s._state().suspect === true,
    "…no answer to it: ios_timeout, nothing sent, and the next call asks for a sign of life first", b);
}
// the Home Screen's icons still on their way in right after ios_home: looked at again, and the tap goes out
{
  const { s, phone, ops } = rig();
  await s.launch({ bundle_id: SETTINGS });
  await s.home();
  let real = phone.front, reads = 2;   // the fake reads phone.front twice per `front`: no icons for the first one
  Object.defineProperty(phone, "front", { configurable: true, get: () => (reads-- > 0 ? SETTINGS : real), set: (v) => { real = v; } });
  const n = ops("front").length;
  const r = await s.tap({ x: 200, y: 400 });
  ok(!r.error && /delivered_unverified/.test(r.text || "") && ops("front").length === n + 2 && ops("tap").at(-1)[1].springboard_only !== true,
    "the Home Screen's icons not there yet at the first look: looked at again, and the tap goes out", [r, ops("front").length - n]);
}
// the look at SpringBoard made before an input fails: a failed call like any other — a failure XCTest recorded ends
// the session — and the input is not sent, under the failure's own name
{
  const { s, phone, ops } = rig();
  await s.launch({ bundle_id: SETTINGS });
  phone.issue = "front";
  const a = await s.tap({ x: 200, y: 760 });
  phone.issue = null;
  const ended = !s._state().running;
  ok(/^xctest_issue: .*\(delivery=not_delivered, retry=safe\)$/.test(a.error || "") && ops("tap").length === 0 && ended,
    "the look at SpringBoard before an input meets a failure XCTest recorded: xctest_issue, nothing sent, the session ends", [a, ended]);
}
{
  const { s, phone, ops } = rig();
  await s.launch({ bundle_id: SETTINGS });
  phone.hang = "front";
  const b = await s.tap({ x: 200, y: 760 });
  phone.hang = null;
  ok(/^ios_timeout: .*\(delivery=not_delivered, retry=safe\)$/.test(b.error || "") && ops("tap").length === 0,
    "the look at SpringBoard before an input gets no answer: ios_timeout, nothing sent", b);
}
// ios_type with the index of something that is not a text input: it is not tapped
{
  const { s, ops } = rig();
  await s.launch({ bundle_id: SETTINGS });
  const notText = J(await s.snapshot()).elements.find((e) => !["textField", "secureTextField", "searchField", "textView"].includes(e.type));
  const r = await s.type({ element_index: notText.i, text: "hello" });
  ok(/^not_a_text_field: /.test(r.error || "") && /delivery=not_delivered, retry=safe/.test(r.error) && ops("tap").length === 0 && ops("type").length === 0,
    "ios_type with the index of a button or a row: refused, nothing tapped or typed", [notText, r, ops("tap").length]);
}
// the read-back looks at one field: the one that was tapped, or the only one that changed
{
  const { s, phone, idx } = rig();
  phone.extraField = true;
  await s.launch({ bundle_id: SETTINGS });
  const snap = J(await s.snapshot());
  const name = snap.elements.find((e) => e.label === "Name");
  ok(name.value === "" && name.placeholder === "Your name", "a field's placeholder is passed on as placeholder, not as its value", name);
  phone.typeInto = "name";
  const wrong = await s.type({ element_index: await idx("Search"), text: "hello" });
  ok(/^type_not_confirmed: 5 characters were typed in com\.apple\.Preferences but the field that was tapped was not seen to gain exactly that text \(/.test(wrong.error) && phone.name === "hello" && phone.search === "", "the text turned up in another field than the one tapped: not verified — and the result says where it looked (the tapped field), not that no field shows the text", wrong);
  phone.typeInto = null;
  await s.tap({ bundle_id: SETTINGS, x: 20, y: 410 });
  const own = await s.type({ text: "world" });
  ok(/delivered_verified/.test(own.text) && phone.name === "helloworld", "no field named: the only field whose value changed shows the text — verified", own);
  phone.cutValue = true;
  const cut = await s.type({ element_index: await idx("Search"), text: "abcdef" });
  ok(/^type_not_confirmed/.test(cut.error) && phone.search === "abcdef", "a value that came back cut cannot verify what was typed", cut);
}
{
  const { s, phone, idx } = rig();
  await s.launch({ bundle_id: SETTINGS });
  await s.tap({ bundle_id: SETTINGS, x: 20, y: 120 });   // the search field takes the keyboard
  phone.typeInto = "void";
  phone.afterType = () => { phone.extraField = true; phone.name = "hello"; };
  const appeared = await s.type({ text: "hello" });
  ok(!appeared.error && appeared.text === `typed 5 characters in ${SETTINGS} — the text fields listed before the text went in and afterwards are not the same ones, so the text could not be tied to one of them (delivery=delivered_unverified, retry=unsafe)`,
    "a field that shows the text only appeared between the two reads: not verified — and not reported as missing either", appeared);
  // … and when the field that appeared shows something else, the text is in no field: not confirmed
  phone.extraField = false; phone.name = "";
  phone.afterType = () => { phone.extraField = true; phone.name = "other"; };
  const gone = await s.type({ text: "hello" });
  ok(gone.error === `type_not_confirmed: 5 characters were typed in ${SETTINGS} but no text field was seen to gain exactly that text (autocorrection or a field that hides its value can cause this) — read the field (ios_snapshot) before typing again (delivery=unknown, retry=unsafe)`,
    "the fields changed between the two reads and none holds the text: not confirmed", gone);
  phone.typeInto = null; phone.cutValue = true;
  phone.afterType = () => { phone.cutValue = false; };
  const wasCut = await s.type({ element_index: await idx("Search"), text: "world" });
  ok(/^type_not_confirmed/.test(wasCut.error) && phone.search === "world", "the value read before typing had come back cut: not verified", wasCut);
}
{
  const { s, phone, idx } = rig();
  phone.extraField = true;
  await s.launch({ bundle_id: SETTINGS });
  const same = await s.type({ element_index: await idx("Name"), text: "Your name" });
  ok(/the same as a field's placeholder/.test(same.text) && /delivered_unverified/.test(same.text) && phone.name === "Your name", "text equal to the field's placeholder cannot be told from an empty field: sent, not verified, not an error", same);
}
// app rules in force: no input that names com.apple.springboard goes out — not even one
// tap on a button of a SpringBoard alert; ios_home still does, and input named for an app is not touched
const SB_RE = /^input_denied: input that names com\.apple\.springboard \(the Home Screen\) is not sent while app rules are in force \(NORACU_APPROVAL_FILE or NORACU_DENY_APPS\) — not even one tap on a system prompt's button; open apps with ios_launch, go home with ios_home \(delivery=not_delivered, retry=safe\)$/;
{
  const { s, phone, ops } = rig({ sbDenied: true });
  await s.launch({ bundle_id: SETTINGS });
  phone.alert = { frame: [51, 300, 300, 200], buttons: [[67, 440, 268, 44]] };
  phone.keyboard = true;
  const before = phone.log.length;
  const refused = [
    await s.tap({ bundle_id: SPRINGBOARD, x: 200, y: 460 }),   // on the alert's button
    await s.tap({ bundle_id: SPRINGBOARD, x: 100, y: 100 }),
    await s.tap({ bundle_id: SPRINGBOARD, x: 200, y: 460, count: 2 }),
    await s.tap({ bundle_id: SPRINGBOARD, x: 200, y: 460, duration_ms: 600 }),
    await s.swipe({ bundle_id: SPRINGBOARD, from: [200, 460], to: [200, 480] }),
    await s.key({ bundle_id: SPRINGBOARD, key: "return" }),
    await s.type({ bundle_id: SPRINGBOARD, text: "hello" }),
  ];
  const sent = phone.log.slice(before).filter(([o]) => ["tap", "press", "drag", "keys", "type"].includes(o));
  ok(refused.every((r) => SB_RE.test(r.error)) && sent.length === 0,
    "rules in force, a SpringBoard alert up: a tap on its button, a tap elsewhere, two taps, a long press, a swipe, keys and text named for com.apple.springboard are all input_denied and none reaches the runner",
    [refused.map((r) => r.error), sent]);
  const home = await s.home();
  const app = await s.launch({ bundle_id: SETTINGS });
  const inApp = await s.tap({ bundle_id: SETTINGS, x: 1, y: 1 });
  ok(!home.error && !app.error && /^tapped/.test(inApp.text) && !("springboard_only" in ops("tap").at(-1)[1]),
    "ios_home still goes out, and input named for an app is sent as before (springboard_only is never sent)", [home, inApp]);
}
{
  // What is refused changes nothing — no runner is started for it (a starting runner puts its own
  // app in front of what the iPhone was showing), and the app rule is still asked first
  const { s, t } = rig({ sbDenied: true });
  const refused = [
    await s.type({ bundle_id: SPRINGBOARD, text: "hello" }),
    await s.key({ bundle_id: SPRINGBOARD, key: "return" }),
    await s.swipe({ bundle_id: SPRINGBOARD, from: [100, 500], to: [100, 300] }),
    await s.tap({ bundle_id: SPRINGBOARD, x: 100, y: 100, duration_ms: 600 }),
    await s.tap({ bundle_id: SPRINGBOARD, x: 100, y: 100, count: 2 }),
    await s.tap({ bundle_id: SPRINGBOARD, x: 100, y: 100 }),
  ];
  ok(t.starts === 0 && t.locks === 0 && refused.every((r) => SB_RE.test(r.error)) && t.approved.length === 6 && t.approvedOps.every((o) => o === "input"),
    "rules in force, no runner up: text, keys, a swipe, a long press, two taps and a single tap named for com.apple.springboard are refused without starting a runner or reading the lock, and the app rule was asked each time",
    [t.starts, t.locks, t.approvedOps, refused.map((r) => r.error)]);
  t.denied = "approval_required: com.apple.springboard is not on the list";
  const ruled = await s.tap({ bundle_id: SPRINGBOARD, x: 100, y: 100 });
  ok(ruled.error === t.denied && t.starts === 0, "the app rule answers first, in its own words", ruled);
}
{
  const { s, phone, ops, idx } = rig({ sbDenied: true });
  phone.alert = { frame: [0, 80, 402, 200], buttons: [[30, 100, 60, 60]] };
  const icon = await idx("Settings", { bundle_id: SPRINGBOARD });
  const [r, t] = [await s.type({ element_index: icon, text: "hello" }), await s.tap({ element_index: icon })];
  ok(SB_RE.test(r.error) && SB_RE.test(t.error) && ops("tap").length === 0 && ops("type").length === 0,
    "ios_type and ios_tap on a SpringBoard element under rules: refused before the tap that would focus or press it", [r, t, ops("tap").length]);
}
{
  const { s, t, phone, ops } = rig();
  await s.launch({ bundle_id: SETTINGS });
  await s.home();
  const free = await s.tap({ bundle_id: SPRINGBOARD, x: 100, y: 100 });
  ok(/^tapped the point/.test(free.text) && !("springboard_only" in ops("tap").at(-1)[1]), "without rules, input that names the Home Screen is sent while the Home Screen is what the iPhone shows", free);
  await s.launch({ bundle_id: SETTINGS });
  phone.issue = "tap";
  const bad = await s.tap({ bundle_id: SETTINGS, x: 1, y: 1 });
  ok(/^xctest_issue: failed - .*look before acting again \(ios_snapshot\) \(delivery=unknown, retry=unsafe\)$/.test(bad.error), "a failure XCTest recorded during a gesture: xctest_issue, delivery unknown — never a success", bad);
  ok(!s._state().running && t.stopped === 1, "an input XCTest recorded a failure for, and that may have gone out, ends the test session", [s._state(), t.stopped]);
  phone.issue = null;
  const next = await s.snapshot({ bundle_id: SETTINGS });
  ok(!next.error && t.starts === 2, "the next call starts a new one", [next.error, t.starts]);
  phone.issue = "snapshot";
  const read = await s.snapshot({ bundle_id: SETTINGS });
  phone.issue = null;
  const pings = ops("ping").length;
  await s.snapshot({ bundle_id: SETTINGS });
  ok(/^xctest_issue/.test(read.error) && t.starts === 3 && ops("ping").length === pings, "a read XCTest recorded a failure for ends the session as well: the next call starts a new one, and no ping stands in for that", [read.error, t.starts, ops("ping").length - pings]);
}
{
  const { s, phone, ops } = rig();
  await s.launch({ bundle_id: SETTINGS });
  const r = await s.type({ text: "hello" });
  ok(/^no_keyboard: .*tap a text field first.* \(delivery=not_delivered, retry=safe\)$/.test(r.error) && ops("type").length === 1 && phone.search === "", "ios_type with no keyboard up: refused once, nothing typed", r);
}
{
  const { s, phone, ops, idx } = rig();
  await s.launch({ bundle_id: SETTINGS });
  phone.keyboardLag = 3;
  const r = await s.type({ element_index: await idx("Search"), text: "abcd" });
  ok(/delivered_verified/.test(r.text) && ops("type").length === 4 && phone.search === "abcd", "the keyboard came up late after the tap: asked again (no_keyboard sent nothing) until it took the text once", [r, ops("type").length]);
  phone.keyboardLag = 99; phone.search = "";
  const never = await s.type({ element_index: await idx("Search"), text: "abc" });
  ok(/^no_keyboard: .*the field was tapped, no text was typed \(delivery=delivered_unverified, retry=unsafe\)$/.test(never.error) && phone.search === "", "the keyboard never came: the answer says the tap went out and the text did not", never);
}
{
  const { s, phone, idx } = rig();
  await s.launch({ bundle_id: SETTINGS });
  phone.autocorrect = true;
  const r = await s.type({ element_index: await idx("Search"), text: "hello" });
  ok(/^type_not_confirmed: 5 characters were typed/.test(r.error) && r.error.endsWith("(delivery=unknown, retry=unsafe)") && !r.error.includes("hello") && phone.search === "Hello", "the field shows something else than what was typed: type_not_confirmed, never a success", r);
}
{
  const { s, phone, ops, idx } = rig();
  await s.launch({ bundle_id: SETTINGS });
  const pass = await idx("Passcode");
  const snaps = ops("snapshot").length;
  const r = await s.type({ element_index: pass, text: "hunter2" });
  ok(/secure field/.test(r.text) && /delivered_unverified/.test(r.text) && !r.text.includes("hunter2") && phone.secret === "hunter2" && ops("snapshot").length === snaps + 1, "a secure field: typed, reported unverified, and not read back (one snapshot: the re-check before the tap)", r);
  phone.leakSecure = true;
  const leaky = J(await s.snapshot());
  ok(!("value" in leaky.elements.find((e) => e.type === "secureTextField")) && !JSON.stringify(leaky).includes("hunter2"), "a secure field's value is dropped even if a runner sent it");
  phone.leakSecure = false;
  const nl = await s.type({ text: "x\n" });
  ok(/contains a return/.test(nl.text) && /delivered_unverified/.test(nl.text), "text with a return is not read back either", nl);
}

// ---------- key, swipe ----------
{
  const { s, phone, ops, idx } = rig();
  await s.launch({ bundle_id: SETTINGS });
  const nk = await s.key({ key: "delete" });
  await s.type({ element_index: await idx("Search"), text: "abcdef" });
  const r = await s.key({ key: "delete", count: 4 });
  ok(/^no_keyboard/.test(nk.error) && nk.error.endsWith(NOT_SENT) && r.text === `pressed delete ×4 in ${SETTINGS} — sent; the screen is not checked (delivery=delivered_unverified, retry=unsafe)` && phone.search === "ab" && ops("keys").at(-1)[1].count === 4, "ios_key: refused without a keyboard, sent with one", [nk, r]);
  const sw = await s.swipe({ from: [200, 600], to: [200, 450], hold_ms: 100, end_hold_ms: 1000, velocity: "fast" });
  const d = ops("drag")[0][1];
  ok(/^swiped \(200, 600\) → \(200, 450\)/.test(sw.text) && d.hold_ms === 100 && d.end_hold_ms === 1000 && d.velocity === "fast" && phone.scroll === 150, "ios_swipe passes the points and holds as given", [sw, d]);
  await s.home();
  const bg = await s.swipe({ bundle_id: SETTINGS, from: [200, 600], to: [200, 450] });
  ok(/^app_not_foreground: .*call ios_launch first \(delivery=not_delivered, retry=safe\)$/.test(bg.error) && phone.scroll === 150, "a swipe for an app in the background is refused by the runner and moves nothing", bg);
}
{
  // system_alert: "a system prompt is up" only when the runner saw one, not when SpringBoard could not be read
  const { s, phone } = rig();
  await s.launch({ bundle_id: SETTINGS });
  phone.refuseOnce = { op: "tap", error: "system_alert", message: "a system alert is up over the app" };
  const up = await s.tap({ x: 50, y: 50 });
  phone.refuseOnce = { op: "tap", error: "system_alert", message: "com.apple.springboard could not be read, so a system alert could not be ruled out" };
  const unk = await s.tap({ x: 50, y: 50 });
  ok(/^system_alert: a system alert is up over the app — a system prompt is up on the iPhone; the person answers it there .*look at it with ios_screenshot to tell them what it asks /.test(up.error) && up.error.endsWith(NOT_SENT)
    && /^system_alert: com\.apple\.springboard could not be read, so a system alert could not be ruled out — noracu could not tell whether a system prompt is up on the iPhone; look at it \(ios_screenshot\) before acting again/.test(unk.error) && !/the person answers it there/.test(unk.error) && unk.error.endsWith(NOT_SENT),
    "system_alert: the answer says a system prompt is up only when the runner saw one", [up.error, unk.error]);
}

// ---------- home, launch ----------
{
  const { s, ops, idx } = rig();
  const icon = await idx("Settings", { bundle_id: SPRINGBOARD });
  await s.home();
  const r = await s.tap({ element_index: icon });
  ok(/^element_no_longer_valid/.test(r.error) && ops("tap").length === 0, "ios_home alone ends earlier indexes — even of the Home Screen, whose page may have changed under the same frames", r);
}
{
  const { s } = rig();
  const cold = await s.home();
  await s.launch({ bundle_id: SETTINGS });
  const r = await s.home();
  const snap = J(await s.snapshot());
  ok(/delivered_unverified/.test(cold.text) && r.text === `home pressed — ${SETTINGS} left the front (delivery=delivered_verified, retry=safe)` && snap.bundle_id === SPRINGBOARD, "ios_home: verified when the app it left is seen to leave the front; the Home Screen is then the default app", [cold, r]);
}
{
  const { s, t, phone } = rig();
  const r = await s.launch({ bundle_id: SETTINGS });
  ok(r.text === `launched ${SETTINGS} — it is in front (delivery=delivered_verified, retry=safe)` && t.launches[0][0] === "device" && t.launches[0][3] === 1 && t.launches[0][2].terminateExisting === false, "ios_launch: the runner is up before the app is launched (it would cover it otherwise), through devicectl, verified by the app's state", [r, t.launches]);
  const slow = await s.launch({ bundle_id: "com.example.slow" });
  ok(/in front \(delivery=delivered_verified/.test(slow.text) && phone.log.filter(([o, a]) => o === "app_state" && a.bundle_id === "com.example.slow").length === 2, "an app that takes a moment to come forward is waited for");
  const stuck = await s.launch({ bundle_id: "com.example.stuck" });
  ok(/^launch_not_confirmed: com\.example\.stuck was started but is not in front after 10 s \(state runningBackground\)/.test(stuck.error) && /delivered_unverified/.test(stuck.error), "an app that never comes forward: launch_not_confirmed", stuck);
  const none = await s.launch({ bundle_id: "com.example.absent" });
  ok(none.error === `launch_failed: The application is not installed ${NOT_SENT}`, "an app that is not installed: launch_failed, nothing sent", none);
  const term = await s.launch({ bundle_id: SETTINGS, terminate_existing: true });
  ok(t.launches.at(-1)[2].terminateExisting === true && /retry=unsafe/.test(term.text), "terminate_existing is passed on, and such a launch is not safe to repeat");
}

{
  // a runner that goes away between the read of the element and the tap — the tap names why
  const { s, t, ops, idx } = rig();
  await s.launch({ bundle_id: SETTINGS });
  const i = await idx("Search");
  t.onCall = (op) => { if (op === "snapshot") { t.onCall = null; t.children.at(-1).emit("exit", 1); } };
  const r = await s.tap({ element_index: i });
  ok(/^runner_unreachable: the runner stopped before the input went out/.test(r.error) && /delivery=not_delivered/.test(r.error) && ops("tap").length === 0 && t.starts === 1,
    "the runner went away after the element was read: the tap says the runner stopped, sends nothing and starts no runner", r);
}
// A read a tool makes inside its own call does not start a runner: one that starts puts its own app in front of the
// screen the call is about. The runner goes away right after ios_launch started the app…
{
  const { s, t, phone } = rig();
  const launch = phone.launch.bind(phone);
  phone.launch = (b) => { const r = launch(b); t.children.at(-1).emit("exit", 1); return r; };
  const r = await s.launch({ bundle_id: SETTINGS });
  ok(/^launch_not_confirmed: com\.apple\.Preferences was started; whether it is in front could not be read/.test(r.error || "") && /delivery=delivered_unverified/.test(r.error) && t.starts === 1,
    "the runner went away right after ios_launch started the app: no runner is started to read whether the app is in front", [r, t.starts]);
}
// …while ios_type's text went out: the fields are not read back through a new runner…
{
  const { s, t, idx } = rig();
  await s.launch({ bundle_id: SETTINGS });
  const field = await idx("Search");
  t.onCall = (op) => { if (op === "type") { t.onCall = null; t.children.at(-1).emit("exit", 1); } };
  const typed = await s.type({ element_index: field, text: "hello" });
  ok(/^typed 5 characters in com\.apple\.Preferences — the text fields could not be read afterwards/.test(typed.text || "") && t.starts === 1,
    "the runner went away while the text went out: the fields are not read back through a new runner", [typed, t.starts]);
}
// …and while home was pressed: no runner is started to see the app leave the front
{
  const { s, t } = rig();
  await s.launch({ bundle_id: SETTINGS });
  t.onCall = (op) => { if (op === "home") { t.onCall = null; t.children.at(-1).emit("exit", 1); } };
  const h = await s.home();
  ok(/^home pressed — whether com\.apple\.Preferences left the front could not be read/.test(h.text || "") && t.starts === 1,
    "the runner went away while home was pressed: no runner is started to see the app leave the front", [h, t.starts]);
}

// ---------- no answer, restarts ----------
{
  const { s, t, phone, ops } = rig();
  await s.launch({ bundle_id: SETTINGS });
  phone.hang = "tap";
  const r = await s.tap({ x: 10, y: 10 });
  ok(/^ios_timeout: the runner did not answer tap/.test(r.error) && r.error.endsWith("(delivery=unknown, retry=unsafe)") && ops("tap").length === 1 && t.stopped === 1 && s._state().running === false,
    "no answer to a tap: delivery unknown, it is not sent again, and the runner is stopped at once — a gesture still waiting in the test session cannot go out later", [r, t.stopped]);
  phone.hang = null;
  const next = await s.snapshot();
  ok(next.text && ops("ping").length === 0 && t.starts === 2, "the call after that starts a new runner", [t.starts, ops("ping").length]);
  phone.hang = "snapshot";
  const noRead = await s.snapshot();
  phone.hang = null;
  const next2 = await s.snapshot();
  ok(/^ios_timeout/.test(noRead.error) && next2.text && ops("ping").length === 1 && t.starts === 2 && t.stopped === 1, "no answer to a read: the next call first asks the runner for a sign of life; it answered, so nothing restarts", [noRead, t.starts, t.stopped]);
  phone.hang = "snapshot"; await s.snapshot(); phone.hang = "ping";
  const after = await s.snapshot({ bundle_id: SPRINGBOARD });
  ok(after.text && t.starts === 3 && t.stopped === 2, "no sign of life: the runner is stopped and started again before the next call", [t.starts, t.stopped]);
  phone.hang = null;
  t.children.at(-1).emit("exit", 1);
  const again = await s.snapshot({ bundle_id: SPRINGBOARD });
  ok(again.text && t.starts === 4, "xcodebuild ended on its own: the next call starts the runner again");
}

// ---------- the lock answer is never older than a second; what a starting runner ends ----------
{
  const { s, t, idx } = rig();
  await s.launch({ bundle_id: SETTINGS });
  const wifi = await idx("Wi-Fi");
  const locks = t.locks;
  const r = await s.tap({ element_index: wifi });
  ok(r.text && t.locks === locks + 1, "a tap by element_index reads the lock once: the re-read of the app and the tap follow within the second", t.locks - locks);
}
{
  const { s, t, ops, idx } = rig();
  await s.launch({ bundle_id: SETTINGS });
  const wifi = await idx("Wi-Fi");
  t.snapMs = 1500; t.lockSeq = [{ ok: true, locked: false }, { ok: true, locked: true }];   // unlocked at the gate; re-reading the app takes 1.5 s; locked by then
  const r = await s.tap({ element_index: wifi });
  ok(r.error === `device_locked: the iPhone is locked — unlock it ${NOT_SENT}` && ops("tap").length === 0 && t.lockSeq.length === 0, "the iPhone is locked while the app is re-read: the lock is read again before the tap, and the tap is not sent", r);
}
{
  const { s, t, ops, idx } = rig();
  await s.launch({ bundle_id: SETTINGS });
  const field = await idx("Search");
  t.snapMs = 1500; t.lockSeq = [{ ok: true, locked: false }, { ok: true, locked: false }, { ok: true, locked: true }];
  const r = await s.type({ element_index: field, text: "abcd" });
  ok(/^device_locked: .*the field was tapped, no text was typed \(delivery=delivered_unverified, retry=unsafe\)$/.test(r.error) && ops("tap").length === 1 && ops("type").length === 0, "the iPhone is locked after the tap that focuses the field: nothing is typed, and the result says the tap went out", r);
}
{
  const { s, t, phone } = rig();
  await s.launch({ bundle_id: SETTINGS });
  const locks = t.locks, seen = phone.log.length;
  const same = [await s.snapshot(), await s.screenshot()];
  ok(same[0].text && same[1].image && t.locks === locks, "reads within a second of an unlocked answer do not read the lock again");
  t.now += 1500; t.lock = { ok: true, locked: true };
  const logged = phone.log.length;
  const rd = [await s.snapshot(), await s.screenshot()];
  ok(rd.every((x) => x.error === "device_locked: the iPhone is locked — unlock it") && phone.log.length === logged && logged > seen, "a locked iPhone is not read: no snapshot and no screenshot reach the runner (its screen shows notifications)", rd);
  t.lock = { ok: false, error: "devicectl_timeout", message: "no answer" };
  const un = await s.screenshot();
  ok(/^lock_unknown: .*fail closed/.test(un.error) && phone.log.length === logged, "no answer about the lock: nothing is read either", un);
}
{
  const { s, t, ops, idx } = rig();
  const icon = await idx("Settings", { bundle_id: SPRINGBOARD });
  t.children.at(-1).emit("exit", 1);              // xcodebuild ends; the next call starts a new runner
  const r = await s.tap({ element_index: icon });
  ok(/^element_no_longer_valid/.test(r.error) && ops("tap").length === 0 && t.starts === 2, "an element_index from before the runner went away is not used: a starting runner puts its own app in front", r);
}
{
  const { s, t, phone } = rig();
  ok(JSON.stringify(t.approvedOps) === "[]", "rig");
  await s.launch({ bundle_id: SETTINGS }); await s.tap({ x: 1, y: 1 }); await s.home();
  ok(JSON.stringify(t.approvedOps) === JSON.stringify(["launch", "input", "home"]), "the app rule is told what is being asked: launch, input, home (only home may name the Home Screen while rules are in force)", t.approvedOps);
  await s.launch({ bundle_id: SETTINGS });
  phone.handleHome = false;
  const stay = await s.home();
  const snap = J(await s.snapshot());
  ok(/^home_not_confirmed: home was pressed but com\.apple\.Preferences is still in front after 3 s .*\(delivery=delivered_unverified, retry=safe\)$/.test(stay.error) && snap.bundle_id === SETTINGS, "ios_home: the app is seen to stay in front → home_not_confirmed, and it stays the default app", [stay, snap.bundle_id]);
}
{
  const { s, t } = rig();
  await s.launch({ bundle_id: SETTINGS });
  t.launchFail = { ok: false, error: "devicectl_failed", message: "the launch service did not answer" };
  const plain = await s.launch({ bundle_id: SETTINGS });
  const term = await s.launch({ bundle_id: SETTINGS, terminate_existing: true });
  ok(plain.error === `launch_failed: the launch service did not answer ${NOT_SENT}` && term.error === "launch_failed: the launch service did not answer — the running app may already have been stopped (delivery=unknown, retry=unsafe)",
    "a failed launch with terminate_existing may have stopped the app: delivery unknown, not safe to repeat; without it nothing was sent", [plain, term]);
}
{
  // a failed launch that may have changed what is in front ends the earlier indexes; one that sent nothing does not
  const { s, t, ops, idx } = rig();
  await s.launch({ bundle_id: SETTINGS });
  const kept = await idx("Wi-Fi");
  t.launchFail = { ok: false, error: "devicectl_failed", message: "the launch service did not answer" };
  await s.launch({ bundle_id: SETTINGS });
  const live = await s.tap({ element_index: kept });
  ok(!live.error && ops("tap").length === 1, "a launch that failed with nothing sent leaves the earlier indexes alone", live);
  const i = await idx("Wi-Fi");
  await s.launch({ bundle_id: SETTINGS, terminate_existing: true });
  const dead = await s.tap({ element_index: i });
  ok(/^element_no_longer_valid/.test(dead.error) && ops("tap").length === 1, "a failed launch with terminate_existing ends every earlier index", dead);
  const j = await idx("Wi-Fi");
  t.launchFail = { ok: false, error: "ios_timeout", message: "devicectl did not answer in 30 s" };
  await s.launch({ bundle_id: SETTINGS });
  const late = await s.tap({ element_index: j });
  ok(/^element_no_longer_valid/.test(late.error) && ops("tap").length === 1, "a launch that timed out ends every earlier index", late);
}

// ---------- screenshot, shutdown ----------
{
  const { s, t, phone } = rig();
  await s.shutdown();
  const shot = await s.screenshot();
  ok(shot.image.startsWith("iVBOR") && shot.mime === "image/png" && shot.meta.w === 402 && shot.meta.h === 874, "ios_screenshot returns the PNG with its size in points", shot.meta);
  await s.shutdown();
  ok(phone.quit === true && t.stopped === 1 && s._state().running === false, "shutdown tells the runner to end its test and stops xcodebuild; with no runner it does nothing");
}

// ---------- the end of a runner, and of the server ----------
{
  const { s, t } = rig();
  await s.shutdown();
  ok(t.killed === 1 && t.starts === 0, "shutdown with no runner up still ends the devicectl calls that are running", t.killed);
}
{
  const { s, t } = rig();
  let exit; t.exited = new Promise((r) => { exit = r; });
  t.hold = new Promise(() => {});   // the 4 s wait never ends on this rig: only the runner's exit lets the next start go
  await s.snapshot({ bundle_id: SPRINGBOARD });
  await s.shutdown();
  const next = s.snapshot({ bundle_id: SPRINGBOARD });
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  const before = t.starts;
  exit();
  const r = await next;
  ok(before === 1 && t.starts === 2 && !r.error, "a stopped runner is waited for before the next one starts", [before, t.starts, r.error]);
}
{
  const { s, t } = rig();
  t.exited = new Promise(() => {});   // this runner's xcodebuild never reports its exit
  await s.snapshot({ bundle_id: SPRINGBOARD });
  await s.shutdown();
  const r = await s.snapshot({ bundle_id: SPRINGBOARD });
  ok(/^runner_start_failed: the runner that was stopped has not exited yet/.test(r.error) && t.starts === 1, "a stopped runner that is still there after the wait: no second runner is started", [r.error, t.starts]);
}
{
  const { s, t } = rig();
  let go; t.startGate = new Promise((r) => { go = r; });
  const first = s.snapshot({ bundle_id: SPRINGBOARD });
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  await s.shutdown();
  go();
  const r = await first;
  ok(/shut down while the runner was starting/.test(r.error) && t.stopped === 1 && !s._state().running, "a start in flight at shutdown does not leave a runner behind", [r.error, t.stopped]);
}
{
  const { s, t } = rig();
  t.startFail = { ok: false, error: "runner_start_timeout", message: "the runner was not ready in 120000 ms", exited: new Promise(() => {}) };
  const a = await s.snapshot({ bundle_id: SPRINGBOARD });
  t.startFail = null;
  const b = await s.snapshot({ bundle_id: SPRINGBOARD });
  ok(/^runner_start_timeout/.test(a.error) && /has not exited yet/.test(b.error) && t.starts === 1, "a start that failed leaves its xcodebuild to be waited for as well", [a.error, b.error, t.starts]);
}

// ---------- the read-back after ios_type ----------
{
  // the read-back pairs one field and wants the text put in at one place
  const f = (key, value, o = {}) => ({ key, value, cut: false, ph: "", ...o });
  const K = "textField||", K2 = "searchField|search|Search";
  ok(fieldShows([f(K, "hell")], [f(K, "hello")], "hello", K) === "mismatch", "\"hell\" turning into \"hello\" is one letter arriving, not the text");
  ok(fieldShows([f(K, "")], [f(K, "hello")], "hello", K) === "shown" && fieldShows([f(K, "abcdef")], [f(K, "abchellodef")], "hello", null) === "shown" && fieldShows([f(K, "hello")], [f(K, "hellohello")], "hello", K) === "shown",
    "the text put into an empty field, into the middle of what was there, or after a copy of itself is shown");
  ok(fieldShows([f(K, "abc")], [f(K, "hello")], "hello", K) === "mismatch" && fieldShows([f(K, "")], [f(K, "Hello")], "hello", K) === "mismatch" && fieldShows([f(K, "")], [f(K, "hello.com")], "hello", K) === "mismatch",
    "a value that was replaced, changed on the way in, or completed with more than was typed is not");
  const twins = [f(K, ""), f(K, ""), f(K2, "")], twinsAfter = [f(K, ""), f(K, ""), f(K2, "hello")];
  ok(fieldShows(twins, twinsAfter, "hello", K) === "mismatch" && fieldShows(twins, twinsAfter, "hello", null) === "shown",
    "the tapped field has a twin and the text turned up in a field of another kind: a mismatch — with nothing tapped, the one changed field is the one looked at");
  ok(fieldShows([f(K, "", { ph: "Title" }), f(K2, "", { ph: "Search" })], [f(K, "Search", { ph: "Title" }), f(K2, "", { ph: "Search" })], "Search", K) === "shown"
    && fieldShows([f(K2, "", { ph: "Search" })], [f(K2, "", { ph: "Search" })], "Search", K2) === "placeholder", "a placeholder counts only on the field that took the text");
  ok(fieldShows([f(K, "", { cut: true })], [f(K, "hello")], "hello", K) === "mismatch" && fieldShows([f(K, "x", { cut: true })], [f(K, "xhello", { cut: true })], "hello", K) === "mismatch" && fieldShows([f(K, "")], [f(K, "hello", { cut: true })], "hello", K) === "cut",
    "a value that came back cut does not verify: cut before, or in both reads, is a mismatch; newly cut is 'cut' — the text could not be looked for in all of it");
  // The placeholder counts only on a field that reads empty, and after the look for the text itself
  const P = (v) => [f(K, v, { ph: "Search" })];
  ok(fieldShows(P("abc"), P("abc"), "Search", K) === "mismatch" && fieldShows(P("abc"), P("abcSearch"), "Search", K) === "shown" && fieldShows(P(""), P(""), "Search", K) === "placeholder",
    "a field with text in it whose placeholder is the typed text: unchanged is a mismatch, gained is shown; only an empty one cannot be told");
}
{
  // a failure XCTest recorded that an internal read was answered with is not lost
  const { s, phone, ops, idx } = rig();
  await s.launch({ bundle_id: SETTINGS });
  await s.tap({ element_index: await idx("Search") });
  phone.issueOnce = "snapshot";
  const held = await s.type({ text: "hello" });
  ok(/^xctest_issue: recorded after an earlier command had answered.*\(delivery=not_delivered, retry=safe\)$/.test(held.error) && ops("type").length === 0 && phone.search === "",
    "the fields could not be read before typing because XCTest had recorded a failure: the text is not sent, and the failure is reported", held);
  const refocus = await s.type({ text: "hello" });
  ok(/^runner_restarted/.test(refocus.error) && phone.search === "" && ops("type").length === 0,
    "the failure ended the test session: text with no element_index is refused once a new runner has taken the front", refocus);
  await s.launch({ bundle_id: SETTINGS });
  const again = await s.type({ element_index: await idx("Search"), text: "hello" });
  ok(/delivered_verified/.test(again.text) && phone.search === "hello", "the field tapped again, the text goes in", again);
  phone.afterType = () => { phone.issueOnce = "snapshot"; };
  const late = await s.type({ text: " world" });
  ok(/^xctest_issue: .*\(delivery=unknown, retry=unsafe\)$/.test(late.error) && phone.search === "hello world", "a failure recorded once the text had gone out: reported with delivery unknown, not as type_not_confirmed", late);
  const after = await s.tap({ bundle_id: SETTINGS, x: 1, y: 1 });
  ok(/^runner_restarted/.test(after.error), "and it is reported once: the next input is not refused with it again — only because the runner started anew", after);
  await s.launch({ bundle_id: SETTINGS });
  const after2 = await s.tap({ bundle_id: SETTINGS, x: 1, y: 1 });
  ok(/^tapped/.test(after2.text), "once the app is brought back, points go out", after2);
}
{
  // A launch with terminate_existing that went out is not safe to repeat, confirmed or not —
  // asking again would stop the app it has just started
  const { s, phone } = rig();
  phone.issueOnce = "app_state";
  const held = await s.launch({ bundle_id: SETTINGS, terminate_existing: true });
  const stuck = await s.launch({ bundle_id: "com.example.stuck", terminate_existing: true });
  const plain = await s.launch({ bundle_id: "com.example.stuck" });
  ok(/^xctest_issue: .*was started; whether it is in front was not read \(delivery=delivered_unverified, retry=unsafe\)$/.test(held.error)
    && /^launch_not_confirmed: .*\(delivery=delivered_unverified, retry=unsafe\)$/.test(stuck.error) && /^launch_not_confirmed: .*\(delivery=delivered_unverified, retry=safe\)$/.test(plain.error),
    "a launch with terminate_existing that went out and could not be confirmed is not safe to repeat; without it, it is", [held, stuck, plain]);
}
{
  const { s, phone, ops } = rig();
  phone.issueOnce = "app_state";
  const l = await s.launch({ bundle_id: SETTINGS });
  ok(/^xctest_issue: .*com\.apple\.Preferences was started; whether it is in front was not read \(delivery=delivered_unverified, retry=safe\)$/.test(l.error) && !s._state().running,
    "a failure XCTest recorded while a launched app was being waited for: ios_launch reports it, and the session has ended", [l, s._state()]);
  const r0 = await s.tap({ bundle_id: SETTINGS, x: 1, y: 1 });
  ok(/^runner_restarted/.test(r0.error) && ops("tap").length === 0, "it was reported once: the next tap is not refused with it again, but a new session started under it, so its points are refused", r0);
  await s.launch({ bundle_id: SETTINGS });
  const r = await s.tap({ bundle_id: SETTINGS, x: 1, y: 1 });
  ok(/^tapped/.test(r.text) && ops("tap").length === 1, "with the app brought back, the next tap goes out (through the new session)", r);
}
{
  const { s, phone, idx } = rig();
  await s.launch({ bundle_id: SETTINGS });
  await s.tap({ element_index: await idx("Search") });
  phone.afterType = () => { phone.truncated = true; };
  const r = await s.type({ text: "hello" });
  ok(!r.error && /^typed 5 characters in com\.apple\.Preferences — the text fields could not be read afterwards, so nothing was read back \(delivery=delivered_unverified, retry=unsafe\)$/.test(r.text) && phone.search === "hello",
    "a read-back that came back cut short verifies nothing — and is not reported as fields that were read and do not show the text", r);
}
{
  const { s, phone, idx } = rig();
  await s.launch({ bundle_id: SETTINGS });
  await s.tap({ element_index: await idx("Search") });
  phone.truncated = true;
  phone.afterType = () => { phone.truncated = false; };
  const r = await s.type({ text: "hello" });
  ok(!r.error && /the text fields could not be read before the text went in, so what they show now has nothing to be compared with \(delivery=delivered_unverified, retry=unsafe\)$/.test(r.text) && phone.search === "hello",
    "the fields could not be read before typing: the text goes in, and a field that shows it afterwards still verifies nothing (it may have been there) — the result does not say that nothing was read afterwards", r);
}
{
  const { s, phone, idx } = rig();
  await s.launch({ bundle_id: SETTINGS });
  await s.tap({ element_index: await idx("Search") });
  phone.truncated = true;
  const r = await s.type({ text: "hello" });
  ok(!r.error && /the text fields could not be read before the text went in or afterwards, so nothing was read back \(delivery=delivered_unverified, retry=unsafe\)$/.test(r.text) && phone.search === "hello",
    "the fields could not be read on either side of the typing: the result names both", r);
}
{
  // Not read before, read in full afterwards, and no field holds the text — it is not there,
  // whatever was there before: type_not_confirmed, not "nothing to compare with"
  const { s, phone, idx } = rig();
  await s.launch({ bundle_id: SETTINGS });
  await s.tap({ element_index: await idx("Search") });
  phone.truncated = true; phone.autocorrect = true;
  phone.afterType = () => { phone.truncated = false; };
  const r = await s.type({ text: "hello" });
  ok(/^type_not_confirmed: 5 characters were typed in com\.apple\.Preferences but no text field was seen to gain exactly that text \(/.test(r.error) && r.error.endsWith("(delivery=unknown, retry=unsafe)") && phone.search === "Hello",
    "the fields could not be read before typing, were read in full afterwards, and none holds the text: not confirmed", r);
  // … unless a field's value came back cut: the text may be past the cut, so nothing says it is missing
  phone.search = ""; phone.truncated = true;
  phone.afterType = () => { phone.truncated = false; phone.cutValue = true; };
  const cut = await s.type({ text: "hello" });
  ok(!cut.error && /could not be read before the text went in, so what they show now has nothing to be compared with \(delivery=delivered_unverified, retry=unsafe\)$/.test(cut.text),
    "the same, but the field's value came back cut: the text may be past the cut — unverified, not type_not_confirmed", cut);
}
{
  // Home was pressed and the app's state could not be read afterwards (the read failed, with no
  // failure of XCTest's behind it) — pressed, not seen; the app stays the one later calls default to
  const { s, phone } = rig();
  await s.launch({ bundle_id: SETTINGS });
  phone.hang = "app_state";
  const h = await s.home();
  phone.hang = null;
  ok(!h.error && h.text === `home pressed — whether ${SETTINGS} left the front could not be read (delivery=delivered_unverified, retry=safe)` && s._state().current === SETTINGS && phone.log.filter(([o]) => o === "home").length === 1,
    "home pressed, the state read failed: the result says the read failed (not that the screen was not checked), and the app stays the default for later calls", [h, s._state()]);
}
{
  const { s, phone, idx } = rig();
  await s.launch({ bundle_id: SETTINGS });
  phone.search = "hell";
  await s.tap({ element_index: await idx("Search") });
  phone.partial = 1;
  const r = await s.type({ text: "hello" });
  ok(/^type_not_confirmed/.test(r.error) && phone.search === "hello", "one letter arrived and completed a word that was already there: not verified", r);
}
{
  const { s, t } = rig();
  let exit; t.exited = new Promise((r) => { exit = r; });
  await s.snapshot({ bundle_id: SPRINGBOARD });
  await s.shutdown();
  const a = await s.snapshot({ bundle_id: SPRINGBOARD });
  const b = await s.snapshot({ bundle_id: SPRINGBOARD });
  ok(/has not exited yet/.test(a.error) && /has not exited yet/.test(b.error) && t.starts === 1, "a stopped runner that is still there: every start is refused, not only the first", [a.error, b.error, t.starts]);
  exit();
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  const c = await s.snapshot({ bundle_id: SPRINGBOARD });
  ok(!c.error && t.starts === 2, "once it has exited, however late, the next start goes ahead", [c.error, t.starts]);
}
{
  const { s, t } = rig();
  let go; t.lockGate = new Promise((r) => { go = r; });
  const first = s.snapshot({ bundle_id: SPRINGBOARD });
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  await s.shutdown();
  go();
  const r = await first;
  ok(/shut down while the runner was starting/.test(r.error) && t.starts === 0, "a shutdown while the lock was being read: no runner is started afterwards", [r.error, t.starts]);
}
{
  const { s, t } = rig();
  let go; t.startGate = new Promise((r) => { go = r; });
  t.exited = new Promise(() => {});
  const first = s.snapshot({ bundle_id: SPRINGBOARD });
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  await s.shutdown();
  go();
  await first;
  t.startGate = null;
  const r = await s.snapshot({ bundle_id: SPRINGBOARD });
  ok(/has not exited yet/.test(r.error) && t.starts === 1, "a runner that became ready after the shutdown is stopped and waited for like any other", [r.error, t.starts]);
}
{
  // a runner built from other sources: one more start once it is gone; a second one is reported
  const stale = () => ({ ok: false, error: "runner_version_mismatch", stale: true, message: "the runner on the device is build 0123456789ab, this noracu's is aaaaaaaaaaaa — run the iOS set-up again (npx noracu ios-setup), then call again", exited: Promise.resolve() });
  let { s, t } = rig();
  t.startSeq = [stale()];
  const once = await s.snapshot({ bundle_id: SPRINGBOARD });
  ok(!once.error && t.starts === 2, "the first start ran another build (seen after a rebuild): started once more, and that one is used", [once.error, t.starts]);
  ({ s, t } = rig());
  t.startSeq = [stale(), stale()];
  const twice = await s.snapshot({ bundle_id: SPRINGBOARD });
  ok(/^runner_version_mismatch: .*run the iOS set-up again/.test(twice.error) && t.starts === 2, "the second start ran another build too: reported, with no third start", [twice.error, t.starts]);
  ({ s, t } = rig());
  t.startSeq = [{ ...stale(), exited: new Promise(() => {}) }];
  const stuck = await s.snapshot({ bundle_id: SPRINGBOARD });
  const next = await s.snapshot({ bundle_id: SPRINGBOARD });
  ok(/^runner_version_mismatch/.test(stuck.error) && /has not exited yet/.test(next.error) && t.starts === 1, "a runner of another build that does not exit: no second runner beside it", [stuck.error, next.error, t.starts]);
}

// ---------- a shutdown while the runner starts ----------
{
  // a shutdown while a stopped runner is being waited for: nothing is started afterwards
  const { s, t, phone } = rig();
  let exit; t.exited = new Promise((r) => { exit = r; });
  t.hold = new Promise(() => {});   // the 4 s wait never ends on this rig: only the runner's exit lets a start go on
  await s.launch({ bundle_id: SETTINGS });
  phone.issue = "tap";
  await s.tap({ bundle_id: SETTINGS, x: 1, y: 1 });   // xctest_issue: the session ends, its xcodebuild is still there
  phone.issue = null;
  const next = s.snapshot({ bundle_id: SETTINGS });
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  await s.shutdown();
  exit();
  const r = await next;
  ok(/shut down while the runner was starting/.test(r.error) && t.starts === 1, "a shutdown while a stopped runner was waited for: the start does not go on", [r.error, t.starts]);
}
{
  // the tapped field did not take the text; another field that reads empty has it as its placeholder
  const { s, phone, idx } = rig();
  phone.extraField = true;
  await s.launch({ bundle_id: SETTINGS });
  phone.typeInto = "void";
  const r = await s.type({ element_index: await idx("Search"), text: "Your name" });
  ok(/^type_not_confirmed/.test(r.error), "the tapped field was paired and does not show the text: not confirmed, whatever another field's placeholder says", r);
}
{
  // ios_home and ios_type report a failure their own reads met, and the session ends
  const { s, t, phone, idx } = rig();
  await s.launch({ bundle_id: SETTINGS });
  phone.afterHome = () => { phone.issueOnce = "app_state"; };   // the read after the press (one before it too)
  const h = await s.home();
  ok(/^xctest_issue: .* — home was pressed; whether com\.apple\.Preferences left the front was not read \(delivery=delivered_unverified, retry=safe\)$/.test(h.error) && !s._state().running && phone.log.filter(([o]) => o === "home").length === 1,
    "home was pressed and the wait for the app to leave met a failure XCTest recorded: the result says both — pressed once, not read — and the session has ended", [h, s._state()]);
  await s.launch({ bundle_id: SETTINGS });
  await s.tap({ element_index: await idx("Search") });
  phone.afterType = () => { phone.issueOnce = "snapshot"; };
  const starts = t.starts;
  const ty = await s.type({ text: "hello" });
  ok(/^xctest_issue: .*\(delivery=unknown, retry=unsafe\)$/.test(ty.error) && !s._state().running && t.starts === starts, "a failure recorded once the text had gone out: reported with delivery unknown, and the session has ended", [ty, s._state()]);
}
{
  // Not read before, read in full afterwards, and the only sign of the text is a field that reads
  // empty with the text as its placeholder — an earlier read would not have settled that either, and the result
  // says so (it used to say there was nothing to compare with)
  const { s, phone, idx } = rig();
  phone.extraField = true;
  await s.launch({ bundle_id: SETTINGS });
  await s.tap({ element_index: await idx("Name") });
  phone.truncated = true;
  phone.afterType = () => { phone.truncated = false; };
  const r = await s.type({ text: "Your name" });
  ok(!r.error && r.text === `typed 9 characters in ${SETTINGS} — the text is the same as a field's placeholder, which cannot be told from an empty field, so nothing was read back (delivery=delivered_unverified, retry=unsafe)` && phone.name === "Your name",
    "the fields could not be read before typing and the text equals a field's placeholder: unverified, for that reason", r);
  // … and only on the tapped field: the text went nowhere, and another field has it as its placeholder
  phone.name = ""; phone.typeInto = "void";
  const i = await idx("Search");
  phone.truncated = true;
  phone.afterType = () => { phone.truncated = false; };
  const other = await s.type({ element_index: i, text: "Your name" });
  ok(other.error === `type_not_confirmed: 9 characters were typed in ${SETTINGS} but the field that was tapped was not seen to gain exactly that text (autocorrection or a field that hides its value can cause this) — read the field (ios_snapshot) before typing again (delivery=unknown, retry=unsafe)`,
    "… another field's placeholder does not count for the tapped one: not confirmed, and the result names the field that was tapped", other);
}
{
  // A wait that a failed read ended early says what was read, not what the full wait would have shown
  const { s, phone } = rig();
  await s.launch({ bundle_id: SETTINGS });
  phone.handleHome = false; phone.hangAfter = { op: "app_state", n: 2 };   // one read before the press, one after
  const h = await s.home();
  phone.hangAfter = null;
  ok(h.error === `home_not_confirmed: home was pressed and ${SETTINGS} was still in front when its state was last read; the read after that failed — look with ios_screenshot (delivery=delivered_unverified, retry=safe)` && s._state().current === SETTINGS && phone.log.filter(([o]) => o === "home").length === 1,
    "ios_home: the app was read in front, then the read failed — the result does not say it is still in front after 3 s", [h, s._state()]);
}
{
  const { s, phone } = rig();
  phone.hang = "app_state";
  const none = await s.launch({ bundle_id: SETTINGS });
  phone.hang = null;
  ok(none.error === `launch_not_confirmed: ${SETTINGS} was started; whether it is in front could not be read — look with ios_screenshot (delivery=delivered_unverified, retry=safe)`,
    "ios_launch: the app's state could not be read at all — the result does not say it is not in front after 10 s", none);
}
{
  const { s, phone } = rig();
  phone.hangAfter = { op: "app_state", n: 1 };
  const some = await s.launch({ bundle_id: "com.example.stuck" });
  phone.hangAfter = null;
  ok(some.error === "launch_not_confirmed: com.example.stuck was started; it was not in front when its state was last read (state runningBackground), and the read after that failed — look with ios_screenshot (delivery=delivered_unverified, retry=safe)",
    "ios_launch: read once (not in front), then the read failed — the result gives the state that was read and says the wait ended there", some);
}
{
  // "nothing to compare with" is only the case where the two reads do not list the same fields.
  // The same fields with none changed, or more than one changed, were compared — and no single field gained the text
  const f = (key, value, o = {}) => ({ key, value, cut: false, ph: "", ...o });
  const K = "textField||", K2 = "searchField|search|Search";
  ok(fieldShows([f(K2, "")], [f(K2, ""), f(K, "hello")], "hello", null) === "moved" && fieldShows([f(K2, ""), f(K, "")], [f(K2, "hello")], "hello", null) === "moved" && fieldShows([f("textField||Title", "")], [f("textField||Title (5)", "hello")], "hello", null) === "moved",
    "fieldShows: a field appeared, went away, or changed its label between the reads — the reads do not list the same fields (moved)");
  ok(fieldShows([f(K2, "hello"), f(K, "")], [f(K2, "hello"), f(K, "")], "hello", null) === "mismatch" && fieldShows([f(K2, ""), f(K, "")], [f(K2, "hello"), f(K, "x")], "hello", null) === "several",
    "fieldShows: the same fields with none changed (a mismatch: the text in a field that did not change proves nothing), or with two changed of which one holds the text (several)");
  const { s, phone } = rig();
  phone.extraField = true;
  await s.launch({ bundle_id: SETTINGS });
  await s.tap({ bundle_id: SETTINGS, x: 20, y: 120 });   // the search field takes the keyboard
  phone.afterType = () => { phone.name = "x"; };         // a second field changes in the same moment
  const two = await s.type({ text: "hello" });
  ok(!two.error && two.text === `typed 5 characters in ${SETTINGS} — more than one text field changed while the text went in, so it was not tied to one of them (delivery=delivered_unverified, retry=unsafe)` && phone.search === "hello",
    "the same fields before and after, two of them changed, one holds the text: unverified, and the result says why it was not tied to a field", two);
}
{
  // The same fields and more than one changed — a field holds the text, but it was not tied to one
  // of them: unverified, with that reason; no field holds it: not confirmed. And when no field changed at all while
  // one reads empty with the text as its placeholder, that field cannot be told from one that took the text —
  // whatever another field already held
  const { s, phone, idx } = rig();
  phone.extraField = true;
  await s.launch({ bundle_id: SETTINGS });
  await s.tap({ bundle_id: SETTINGS, x: 20, y: 120 });
  phone.autocorrect = true;
  phone.afterType = () => { phone.name = "x"; };
  const none = await s.type({ text: "hello" });
  ok(/^type_not_confirmed: 5 characters were typed in com\.apple\.Preferences but no text field was seen to gain exactly that text \(/.test(none.error) && phone.search === "Hello",
    "two fields changed and neither holds the text: not confirmed", none);
  phone.autocorrect = false; phone.typeInto = "void"; phone.search = "Your name"; phone.name = "";
  const still = await s.type({ text: "Your name" });
  ok(!still.error && /the text is the same as a field's placeholder, which cannot be told from an empty field, so nothing was read back \(delivery=delivered_unverified, retry=unsafe\)$/.test(still.text),
    "no field changed, one already held the text and another reads empty with it as its placeholder: the placeholder result — that field would read the same had it taken the text", still);
  // the tapped field is not listed afterwards — its label changed with its value — and the field that is holds the text
  phone.typeInto = null; phone.search = ""; phone.extraField = false;
  const i = await idx("Search");
  phone.afterType = () => { phone.searchLabel = "Search, 5 characters"; };
  const renamed = await s.type({ element_index: i, text: "hello" });
  ok(!renamed.error && renamed.text === `typed 5 characters in ${SETTINGS} — the text fields listed before the text went in and afterwards are not the same ones, so the text could not be tied to one of them (delivery=delivered_unverified, retry=unsafe)` && phone.search === "hello",
    "the tapped field's label changed as the text went in, and the field holds the text: unverified (the fields are not the same ones), not 'the tapped field was not seen to gain it'", renamed);
}

// ---------- what the two reads say is decided per field that changed ----------
{
  const f = (key, value, o = {}) => ({ key, value, cut: false, ph: "", ...o });
  const K = "textField||", K2 = "searchField|search|Search", K3 = "textField|note|Note";
  const three = [f(K, "hello"), f(K2, ""), f(K3, "")];
  ok(fieldShows(three, [f(K, "hello"), f(K2, "x"), f(K3, "y")], "hello", null) === "mismatch"
    && fieldShows(three, [f(K, "hello"), f(K2, "hello"), f(K3, "y")], "hello", null) === "several" && fieldShows(three, [f(K, "hello"), f(K2, "hello!"), f(K3, "y")], "hello", null) === "mismatch"
    && fieldShows(three, [f(K, "hello"), f(K2, "x", { cut: true }), f(K3, "y")], "hello", null) === "several",
    "fieldShows: several fields changed — 'several' only when one of the changed ones gained the text (or came back cut); the text in a field that did not change does not count, nor one that gained more than the text");
  ok(fieldShows([f(K, ""), f(K2, ""), f(K3, "", { ph: "hello" })], [f(K, "x"), f(K2, "y"), f(K3, "", { ph: "hello" })], "hello", null) === "mismatch"
    && fieldShows([f(K, ""), f(K, "", { ph: "hello" }), f(K2, "")], [f(K, ""), f(K, "", { ph: "hello" }), f(K2, "zzz")], "hello", K) === "mismatch"
    && fieldShows([f(K, "")], [f(K, ""), f(K3, "", { ph: "hello" })], "hello", null) === "mismatch"
    && fieldShows([f(K, ""), f(K, "", { ph: "hello" }), f(K2, "")], [f(K, ""), f(K, "", { ph: "hello" }), f(K2, "")], "hello", K) === "placeholder",
    "fieldShows: a field that reads empty with the text as its placeholder explains a missing text only when no field changed at all");
  const tw = [f(K, ""), f(K, ""), f(K2, "")];
  ok(fieldShows(tw, [f(K, "hello"), f(K, ""), f(K2, "z")], "hello", K) === "shown" && fieldShows(tw, [f(K, "Hello"), f(K, ""), f(K2, "hello")], "hello", K) === "mismatch"
    && fieldShows(tw, [f(K, "hello"), f(K, ""), f(K2, "z")], "hello", null) === "several",
    "fieldShows: one field like the tapped one changed — it is the one judged, whatever a field of another kind did; with nothing tapped both count (several)");
  ok(fieldShows([f(K, ""), f(K2, "")], [f(K, "hello"), f(K2, "zzz")], "hello", K) === "shown" && fieldShows([f(K, ""), f(K2, "")], [f(K, "Hello"), f(K2, "hello")], "hello", K) === "mismatch"
    && fieldShows([f(K, "")], [f(K, "hello"), f(K3, "")], "hello", K) === "shown" && fieldShows([f(K, "")], [f(K, "Hello"), f(K3, "hello")], "hello", K) === "mismatch",
    "fieldShows: the tapped field is the only one of its kind in both reads — it is judged, and a second field that changed, appeared, or holds the text changes nothing");
  ok(fieldShows([f(K, ""), f(K, "")], [f(K, ""), f("textField||Title (5)", "hello")], "hello", K) === "moved"
    && fieldShows([f(K, ""), f(K, "")], [f(K, ""), f(K, ""), f(K3, "hello")], "hello", K) === "mismatch"
    && fieldShows([f(K2, "")], [f(K2, ""), f(K, "")], "hello", null) === "mismatch",
    "fieldShows: the reads list different fields — 'moved' when a field like the tapped one holds the text, or one of those is gone and some field holds it; a new field of another kind does not count, nor a list in which nothing holds the text");
  ok(fieldShows(null, [f(K, "say hello")], "hello", null) === "unread" && fieldShows(null, [f(K, "")], "hello", null) === "mismatch" && fieldShows(null, [f(K, "", { ph: "hello" })], "hello", null) === "placeholder"
    && fieldShows(null, [f(K2, "hello")], "hello", K) === "unread" && fieldShows(null, [f(K, ""), f(K2, "hello")], "hello", K) === "mismatch" && fieldShows(null, [f(K, "", { ph: "hello" }), f(K2, "hello")], "hello", K) === "placeholder",
    "fieldShows: not read before — 'unread' when a field like the tapped one holds the text (any field when none like it is listed), 'placeholder' when one reads empty with the text as its placeholder, a mismatch otherwise");
}
{
  // … and ios_type has one sentence per answer. The tapped field is the only one of its kind: it is judged,
  // whatever another field did in the same moment
  const NOT_TAPPED = /^type_not_confirmed: 5 characters were typed in com\.apple\.Preferences but the field that was tapped was not seen to gain exactly that text \(/;
  const NO_FIELD = /^type_not_confirmed: 5 characters were typed in com\.apple\.Preferences but no text field was seen to gain exactly that text \(/;
  const VERIFIED = /a text field shows them \(delivery=delivered_verified, retry=unsafe\)$/;
  const { s, phone, idx } = rig();
  phone.extraField = true;
  await s.launch({ bundle_id: SETTINGS });
  phone.afterType = () => { phone.name = "x"; };
  const uniq = await s.type({ element_index: await idx("Search"), text: "hello" });
  ok(!uniq.error && VERIFIED.test(uniq.text) && phone.search === "hello" && phone.name === "x", "the tapped field is the only one of its kind and gained the text while another field changed: verified", uniq);
  phone.search = ""; phone.name = ""; phone.typeInto = "name";
  const other = await s.type({ element_index: await idx("Search"), text: "hello" });
  ok(NOT_TAPPED.test(other.error) && phone.name === "hello", "the tapped field is the only one of its kind and the text went to another field: not confirmed", other);
  // three fields, nothing tapped by index: two change without the text
  phone.search = ""; phone.name = ""; phone.typeInto = "void";
  phone.moreFields = [{ type: "textField", label: "Note", id: "note", value: "hello" }];
  phone.afterType = () => { phone.name = "x"; phone.search = "y"; };
  const bystander = await s.type({ text: "hello" });
  ok(NO_FIELD.test(bystander.error), "two fields changed without the text and a third, which did not change, already held it: not confirmed — not 'more than one changed'", bystander);
  phone.search = ""; phone.name = "";
  phone.moreFields = [{ type: "textField", label: "Note", id: "note", value: "", placeholder: "hello" }];
  phone.afterType = () => { phone.name = "x"; phone.search = "y"; };
  const hidden = await s.type({ text: "hello" });
  ok(NO_FIELD.test(hidden.error), "two fields changed without the text and a third reads empty with the text as its placeholder: not confirmed — not the placeholder result", hidden);
  // the tapped field has a twin
  const twins = (o = {}) => [{ type: "textField", label: "Tag", id: "tag", value: "", ...o }, { type: "textField", label: "Tag", id: "tag", value: "", ...o }];
  phone.extraField = false; phone.search = ""; phone.name = "";
  phone.moreFields = twins({ placeholder: "hello" });
  const i1 = await idx("Tag");
  phone.afterType = () => { phone.search = "zzz"; };
  const twinPh = await s.type({ element_index: i1, text: "hello" });
  ok(NOT_TAPPED.test(twinPh.error), "a twin of the tapped field reads empty with the text as its placeholder, and a field of another kind changed: not confirmed — not the placeholder result", twinPh);
  phone.search = ""; phone.typeInto = null;
  phone.moreFields = twins();
  const i2 = await idx("Tag");
  phone.afterType = () => { phone.moreFields[0].label = "Tag, 5 characters"; };
  const twinRenamed = await s.type({ element_index: i2, text: "hello" });
  ok(!twinRenamed.error && twinRenamed.text === `typed 5 characters in ${SETTINGS} — the text fields listed before the text went in and afterwards are not the same ones, so the text could not be tied to one of them (delivery=delivered_unverified, retry=unsafe)` && phone.moreFields[0].value === "hello",
    "the tapped twin's label changed as the text went in while its twin stayed: unverified (the fields are not the same ones), not 'the tapped field was not seen to gain it'", twinRenamed);
  phone.moreFields = twins();
  const i3 = await idx("Tag");
  phone.afterType = () => { phone.search = "zzz"; };
  const twinShown = await s.type({ element_index: i3, text: "hello" });
  ok(!twinShown.error && VERIFIED.test(twinShown.text) && phone.moreFields[0].value === "hello" && phone.search === "zzz", "one of the twins gained the text while a field of another kind changed: that twin is the one judged — verified", twinShown);
}

// ---------- the placeholder answer only for a field that did not change; the text counts only where it is new ----------
{
  const f = (key, value, o = {}) => ({ key, value, cut: false, ph: "", ...o });
  const K = "textField||", K2 = "searchField|search|Search", K3 = "textField|note|Note";
  const ph = [f(K, "", { ph: "hello" }), f(K2, "")];
  ok(fieldShows(ph, [f(K, "", { ph: "hello" }), f(K2, "hello")], "hello", K) === "mismatch"
    && fieldShows([f(K, "abc", { ph: "hello" })], [f(K, "", { ph: "hello" })], "hello", K) === "mismatch" && fieldShows([f(K, "abc", { ph: "hello" })], [f(K, "", { ph: "hello" })], "hello", null) === "mismatch"
    && fieldShows(ph, [f(K, "", { ph: "hello" }), f(K2, "")], "hello", K) === "placeholder",
    "fieldShows: the tapped field reads empty with the text as its placeholder — the placeholder answer only when no field changed: not when the text went to another field, nor when the field had a value and reads empty now");
  ok(fieldShows([f(K, ""), f(K2, "hello")], [f("textField||renamed", "wrong"), f(K2, "hello")], "hello", K) === "mismatch"
    && fieldShows([f(K, "hello")], [f(K, "hello"), f(K3, "")], "hello", null) === "mismatch"
    && fieldShows([f(K, "hello")], [f(K, "hello"), f(K3, "hello")], "hello", null) === "moved"
    && fieldShows([f(K, "hello")], [f(K, "hello"), f(K3, "x", { cut: true })], "hello", null) === "moved",
    "fieldShows: the reads list different fields — the text counts only where it is new (more fields have it than had it before, or one came back cut); a field that had it all along does not make it 'moved'");
  const pair = [f(K, "hello"), f(K, "a")];
  ok(fieldShows(pair, [f(K, "hello!"), f(K, "b")], "hello", K) === "mismatch" && fieldShows(pair, [f(K, "hello!"), f(K, "b")], "hello", null) === "mismatch"
    && fieldShows(pair, [f(K, "hello!"), f(K, "ahello")], "hello", K) === "several",
    "fieldShows: several changed — a changed field that had the text and gained something else does not count; one that gained the text does");
}
{
  // … and ios_type: the tapped field, the only one of its kind, reads empty with the text as its placeholder
  const notTapped = (n) => new RegExp(`^type_not_confirmed: ${n} characters were typed in com\\.apple\\.Preferences but the field that was tapped was not seen to gain exactly that text \\(`);
  const { s, phone, idx } = rig();
  phone.extraField = true;
  await s.launch({ bundle_id: SETTINGS });
  phone.typeInto = "search";
  const elsewhere = await s.type({ element_index: await idx("Name"), text: "Your name" });
  ok(notTapped(9).test(elsewhere.error) && phone.search === "Your name" && phone.name === "", "the tapped field's placeholder is the text and the text went into another field: not confirmed — not the placeholder result", elsewhere);
  phone.search = ""; phone.name = "abc"; phone.typeInto = "void";
  const i = await idx("Name");
  phone.afterType = () => { phone.name = ""; };
  const cleared = await s.type({ element_index: i, text: "Your name" });
  ok(notTapped(9).test(cleared.error), "the tapped field had a value and reads empty now, its placeholder being the text: not confirmed — it did not gain the text", cleared);
}

// ---------- a field that is cut in both reads is not evidence ----------
{
  const f = (key, value, o = {}) => ({ key, value, cut: false, ph: "", ...o });
  const K = "textField||", K3 = "textField|note|Note";
  ok(fieldShows([f(K, "abc", { cut: true })], [f(K, "abd", { cut: true }), f(K3, "")], "hello", null) === "mismatch"
    && fieldShows([f(K, "abc")], [f(K, "abd", { cut: true }), f(K3, "")], "hello", null) === "moved",
    "fieldShows: the reads list different fields — a field cut in both reads does not make it 'moved'; one that is newly cut does");
  ok(fieldShows([f(K, "p"), f(K, "q", { cut: true })], [f(K, "nope"), f(K, "still", { cut: true })], "hello", null) === "mismatch"
    && fieldShows([f(K, "p"), f(K, "q")], [f(K, "nope"), f(K, "still", { cut: true })], "hello", null) === "several",
    "fieldShows: several changed — a changed field cut in both reads does not count; one that is newly cut does");
}

// ---------- the one field that changed came back cut and was not cut before ----------
{
  const f = (key, value, o = {}) => ({ key, value, cut: false, ph: "", ...o });
  const K = "textField||", K2 = "searchField|search|Search";
  ok(fieldShows([f(K, "abcd")], [f(K, "abcdh", { cut: true })], "hello", K) === "cut" && fieldShows([f(K, "abcd")], [f(K, "abcdh", { cut: true })], "hello", null) === "cut"
    && fieldShows([f(K, "abcd"), f(K2, "")], [f(K, "abcdh", { cut: true }), f(K2, "zzz")], "hello", K) === "cut" && fieldShows([f(K, "abcd", { cut: true })], [f(K, "abcdh", { cut: true })], "hello", null) === "mismatch",
    "fieldShows: the one field singled out came back cut and was not cut before — 'cut' (unverified), by the tapped key and as the only changed field; cut in both reads stays a mismatch");
  const { s, phone, idx } = rig();
  await s.launch({ bundle_id: SETTINGS });
  const i = await idx("Search");
  phone.afterType = () => { phone.cutValue = true; };
  const newlyCut = await s.type({ element_index: i, text: "world" });
  ok(!newlyCut.error && newlyCut.text === `typed 5 characters in ${SETTINGS} — the field's value came back cut short, so the text could not be looked for in all of it (delivery=delivered_unverified, retry=unsafe)` && phone.search === "world",
    "ios_type: the tapped field's value came back cut after the text went in and was not cut before: unverified, with that reason — not type_not_confirmed", newlyCut);
}

// ---------- a value that reads the same and came back cut, when it was not before, has changed ----------
{
  const f = (key, value, o = {}) => ({ key, value, cut: false, ph: "", ...o });
  const K = "textField||", K2 = "searchField|search|Search";
  const atCap = [f(K, "abcd")], past = [f(K, "abcd", { cut: true })];
  ok(fieldShows(atCap, past, "hello", K) === "cut" && fieldShows(atCap, past, "hello", null) === "cut"
    && fieldShows([f(K, "abcd"), f(K, "", { ph: "hello" })], [f(K, "abcd", { cut: true }), f(K, "", { ph: "hello" })], "hello", K) === "cut"
    && fieldShows([f(K, "abcd", { cut: true })], [f(K, "abcd")], "hello", K) === "mismatch" && fieldShows([f(K, "abcd", { cut: true })], [f(K, "abcd", { cut: true })], "hello", K) === "mismatch"
    && fieldShows([f(K, "abcd"), f(K2, "wxyz")], [f(K, "abcd", { cut: true }), f(K2, "wxyz", { cut: true })], "hello", null) === "several"
    && fieldShows([f(K, "abcd")], [f(K, "abcd", { cut: true }), f(K2, "")], "hello", K) === "cut",
    "fieldShows: the value reads the same and came back cut, not cut before — it changed ('cut', not a mismatch and not the placeholder answer of a twin); cut before and not after, or cut in both, is no gain; two such fields are 'several'");
  // cut before and whole now, with the same value, is no change — it neither hides a field
  // that did gain the text nor the placeholder answer
  ok(fieldShows([f(K, "ab", { cut: true }), f(K2, "", { ph: "hello" })], [f(K, "ab"), f(K2, "", { ph: "hello" })], "hello", null) === "placeholder"
    && fieldShows([f(K, "ab", { cut: true }), f(K2, "abcd")], [f(K, "ab"), f(K2, "abhellocd")], "hello", null) === "shown"
    && fieldShows([f(K, "ab", { cut: true }), f(K, "abcd")], [f(K, "ab"), f(K, "abhellocd")], "hello", K) === "shown"
    && fieldShows([f(K, "ab", { cut: true })], [f(K, "ab")], "hello", K) === "mismatch",
    "fieldShows: a cut flag that clears on the same value is no change — the placeholder answer stands, a field that gained the text by insertion is shown (twin or not), and alone it is a mismatch");
  const { s, phone, idx } = rig();
  await s.launch({ bundle_id: SETTINGS });
  phone.search = "abcd";
  const i = await idx("Search");
  phone.typeInto = "void";
  phone.afterType = () => { phone.cutValue = true; };
  const pastCap = await s.type({ element_index: i, text: "world" });
  ok(!pastCap.error && pastCap.text === `typed 5 characters in ${SETTINGS} — the field's value came back cut short, so the text could not be looked for in all of it (delivery=delivered_unverified, retry=unsafe)`,
    "ios_type: the tapped field reads the same as before and came back cut, not cut before: unverified (came back cut short), not type_not_confirmed", pastCap);
}
{
  // "left the front" only when the app was in front before the press and is then seen
  // in a background state — not when it was already elsewhere, and never on an unknown state (0)
  const { s, phone } = rig();
  await s.launch({ bundle_id: SETTINGS });
  phone.state[SETTINGS] = 3; phone.front = SPRINGBOARD;          // it went to the background by itself
  const already = await s.home();
  ok(!already.error && already.text === `home pressed — ${SETTINGS} was not in front before the press, so it was not seen to leave the front (delivery=delivered_unverified, retry=safe)` && phone.log.filter(([o]) => o === "home").length === 1,
    "ios_home: the app was not in front before the press — pressed, not reported as leaving the front", already);
  await s.launch({ bundle_id: SETTINGS });
  phone.state[SETTINGS] = 0;                                    // an unknown state, with the app on screen
  const unknown = await s.home();
  ok(!/delivered_verified/.test(unknown.text || unknown.error || ""), "ios_home: an unknown app state (0) is never read as having left the front", unknown);
}

{
  // the stop file made while ios_home read the app's state (that read can take up to 10 s): the press is not sent
  const { s, t, ops } = rig();
  await s.launch({ bundle_id: SETTINGS });
  t.stop = "user_stopped: /tmp/stop exists — the person at the Mac stopped noracu's input; nothing was sent (delivery=not_delivered, retry=safe); remove the file to resume";
  const r = await s.home();
  ok(r.error === t.stop && ops("home").length === 0, "ios_home: the stop file is looked at again right before the press, after its state read", r);
  t.stop = null;
  ok(!(await s.home()).error && ops("home").length === 1, "… and once it is gone the press goes out");
}

{
  // the stop file made while ios_launch's gate reads the lock (the gate can also start the runner — seconds): nothing
  // is launched, and with terminate_existing the running app is not stopped
  const { s, t } = rig();
  const STOP = "user_stopped: /tmp/stop exists — the person at the Mac stopped noracu's input; nothing was sent (delivery=not_delivered, retry=safe); remove the file to resume";
  t.lockGate = { then: (res) => { t.stop = STOP; res(); } };
  const r = await s.launch({ bundle_id: SETTINGS, terminate_existing: true });
  t.lockGate = null; t.stop = null;
  ok(r.error === STOP && t.launches.length === 0, "ios_launch: the stop file is looked at again right before the launch, after its gate", r);
  const again = await s.launch({ bundle_id: SETTINGS });
  ok(!again.error && t.launches.length === 1, "… and once it is gone the launch goes out", again);
}

{
  // the stop file made while devicectl is being prepared (its temporary folder), after ios_launch's gate: devicectl
  // is not started, and with terminate_existing the running app is not stopped
  const { s, t } = rig();
  const STOP = "user_stopped: /tmp/stop exists — the person at the Mac stopped noracu's input; nothing was sent (delivery=not_delivered, retry=safe); remove the file to resume";
  t.onLaunchPrep = () => { t.stop = STOP; };
  const r = await s.launch({ bundle_id: SETTINGS, terminate_existing: true });
  t.onLaunchPrep = null; t.stop = null;
  ok(r.error === STOP && t.launches.length === 0, "ios_launch: the stop file is looked at once more right before devicectl starts, after it is prepared", r);
}

console.log(`ios-session unit: ${n}/${n} passed`);

// ios-session — the ios_* tools of the experimental XCUITest iPhone backend (0.3.0).
//
// One session per server: it picks the device, starts the on-device runner on the first call that needs
// it (src/ios-xcuitest.js), and turns runner answers into tool results. What it keeps to:
//  • An input is sent only after: the app rule (deny list / approval file, judged on the iOS bundle id),
//    a running runner, and a lock check through devicectl — a phone that asks for its passcode, or whose
//    lock state cannot be read, gets nothing.
//  • element_index is unique across snapshots and lasts 30 s. Before it is used the app is read again:
//    the element must still be there with the same type, label, identifier and frame, and the app must
//    still be in front — otherwise element_no_longer_valid and nothing is sent. ios_home and ios_launch
//    change what is in front, so they end every earlier index.
//  • Nothing is re-sent. A runner call that timed out is reported with delivery=unknown; the next call
//    first asks the runner for a sign of life and restarts it when there is none.
//  • ios_type reports delivered_verified only when the one field that took the text shows it afterwards
//    (four characters or more; the same text in some other field proves nothing).
//  • Results never contain the typed text. Screenshots are returned, never written to disk.

import { homedir } from "node:os";
import { join } from "node:path";
import * as iosApi from "./ios-xcuitest.js";

export const SPRINGBOARD = "com.apple.springboard";
export const IOS_TTL_MS = 30000;
const ITEMS_KEPT = 5000;
const STATE_NAMES = ["unknown", "notRunning", "runningBackgroundSuspended", "runningBackground", "runningForeground"];
const FOREGROUND = 4;
const INTERACTIVE = new Set(["button", "cell", "textField", "secureTextField", "searchField", "textView", "switch", "slider", "link", "tab", "key", "menuItem", "segmentedControl", "pickerWheel", "stepper", "toggle"]);
const TEXTY = new Set(["textField", "searchField", "textView"]);
const NOT_SENT = "(delivery=not_delivered, retry=safe)";
const UNKNOWN = "(delivery=unknown, retry=unsafe)";
const UNVERIFIED = "(delivery=delivered_unverified, retry=unsafe)";

const stateName = (n) => STATE_NAMES[n] ?? "unknown";

// What the two reads of an app's text fields say about text that was typed. `before` is null when the fields could
// not be read before the text went in. A field "of mine" is one like the tapped field when one was tapped (same
// type, identifier and label), any field otherwise. A field "gained" the text when its new value is its old value
// with the text put in at one place ("hell" turning into "hello" is one letter arriving, not "hello": pre-review
// P3) and neither value came back cut.
//   "shown"        one field was singled out and gained the text: the tapped one, when it is the only one of its
//                  kind in both reads and its value changed; otherwise, when both reads list the same fields, the
//                  only field of mine whose value changed. What other fields did does not matter then.
//   "cut"          that one field did not gain the text as far as its value was read, but the value came back
//                  cut and was not cut before: the text could not be looked for in all of it (pre-review P15).
//                  A field whose value reads the same but came back cut, when it was not before, has changed
//                  too: what was added is past where the read stops (pre-review P16). The other way round — cut
//                  before, whole now, the same value — is no change: nothing was added (pre-review P17-Grok-1).
//   "placeholder"  no field at all changed — or the fields were not read before, and none of mine holds the text —
//                  and a field of mine reads empty with the text as its own placeholder: such a field reads the
//                  same whether or not it took the text. Only a field that did not change can be that field: one
//                  that had a value and reads empty now did not gain the text (pre-review P13).
//   "unread"       not read before, and a field of mine has the text in its value or came back cut (any field, when
//                  none of mine is listed): there is nothing to compare it with.
//   "moved"        the two reads do not list the same fields (one appeared, went away, or changed its label), and
//                  the text is new among the fields of mine — more of them have it in their value than had it
//                  before, or more of them came back cut. All fields count when fewer of mine are listed than
//                  before.
//   "several"      the same fields, more than one of mine changed, and one of those gained the text, or came back
//                  cut and was not cut before: it arrived, or may have, and was not tied to one field. A field
//                  that is cut in both reads says nothing new (pre-review P14).
//   "mismatch"     everything else: the reads were compared and do not show the text arriving.
// The text in a field that did not change proves nothing, wherever it is (pre-reviews P12, P13), and neither does
// a field that is not mine.
export function fieldShows(before, after, text, key) {
  const mine = (f) => !key || f.key === key;
  const has = (f) => f.value.includes(text);
  const like = (f) => f.value === "" && Boolean(f.ph) && f.ph === text;
  const gained = (was, is) => {
    if (was.cut || is.cut) return false;
    for (let i = is.value.indexOf(text); i !== -1; i = is.value.indexOf(text, i + 1)) if (is.value.slice(0, i) + is.value.slice(i + text.length) === was.value) return true;
    return false;
  };
  const judged = (was, is) => (gained(was, is) ? "shown" : is.cut && !was.cut ? "cut" : "mismatch");
  const differs = (was, is) => was.value !== is.value || (!was.cut && is.cut);
  if (before === null) {
    if (after.some((f) => mine(f) && (f.cut || has(f))) || (!after.some(mine) && after.some((f) => f.cut || has(f)))) return "unread";
    return after.some((f) => mine(f) && like(f)) ? "placeholder" : "mismatch";
  }
  const of = (list, k) => list.filter((f) => f.key === k);
  if (key && of(before, key).length === 1 && of(after, key).length === 1 && differs(of(before, key)[0], of(after, key)[0])) return judged(of(before, key)[0], of(after, key)[0]);
  const tally = (list) => { const m = new Map(); for (const f of list) m.set(f.key, (m.get(f.key) ?? 0) + 1); return m; };
  const tb = tally(before), ta = tally(after);
  if (tb.size !== ta.size || [...tb].some(([k, n]) => ta.get(k) !== n)) {
    // the fields cannot be paired, so the text counts only where it is new
    const among = Boolean(key) && of(after, key).length < of(before, key).length ? () => true : mine;
    const n = (list, hit) => list.filter((f) => among(f) && hit(f)).length;
    const cut = (f) => f.cut;
    return n(after, has) > n(before, has) || n(after, cut) > n(before, cut) ? "moved" : "mismatch";
  }
  // the same fields: paired in order, kind by kind
  const changed = [], seen = new Map();
  for (const f of after) {
    const i = seen.get(f.key) ?? 0; seen.set(f.key, i + 1);
    const b = of(before, f.key)[i];
    if (differs(b, f)) changed.push([b, f]);
  }
  const ofMine = changed.filter(([, f]) => mine(f));
  if (ofMine.length === 1) return judged(...ofMine[0]);
  if (ofMine.length > 1) return ofMine.some(([b, f]) => (f.cut && !b.cut) || gained(b, f)) ? "several" : "mismatch";
  return changed.length === 0 && after.some((f) => mine(f) && like(f)) ? "placeholder" : "mismatch";
}

export function createIosSession({
  env = process.env, api = iosApi, approve = () => null, springboardDenied = () => false, spawnImpl, onChild = () => {},
  now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), runnerDir,
} = {}) {
  const dir = runnerDir || env.NORACU_IOS_RUNNER_DIR || join(homedir(), ".noracu", "ios-runner");
  const readOnly = env.NORACU_READ_ONLY === "1";
  let runner = null;    // { client, child, stop, device, startedAt }
  let stopping = null;  // the exit of a runner that was stopped and may still be there; cleared once it has exited
  let heldIssue = null; // an xctest_issue an internal read was answered with: the next input reports it instead of going out
  let gen = 0;          // goes up at shutdown: a start that was in flight does not hand over its runner afterwards
  let starting = null;  // the start in flight, shared by calls that arrive meanwhile
  let suspect = false;  // the last call got no answer: ask for a sign of life before the next one
  let current = null;   // the app the last call named
  let epoch = 0;        // goes up when a call changes what is in front; indexes of an older epoch are dead
  let nextIndex = 1, snapSeq = 0;
  const items = new Map();  // element_index → { snapshot_id, bundle, type, label, id, frame, ts, epoch }

  // ---------- device ----------
  async function resolveDevice() {
    const want = String(env.NORACU_IOS_UDID || "").trim();
    if (want && !api.validUdid(want)) return { ok: false, error: "ios_config", message: "NORACU_IOS_UDID is not a device identifier" };
    const list = await api.listDevices();
    if (!list.ok) return list;
    let d;
    if (want) {
      d = list.devices.find((x) => x.udid.toLowerCase() === want.toLowerCase());
      if (!d) return { ok: false, error: "device_not_found", message: "this Mac does not list the device named in NORACU_IOS_UDID" };
    } else {
      const usable = list.devices.filter((x) => !x.simulated && x.paired && x.tunnel);
      if (usable.length > 1) return { ok: false, error: "device_ambiguous", message: `${usable.length} iPhones are connected — set NORACU_IOS_UDID to one of: ${usable.map((x) => `${x.udid} (${x.name})`).join(", ")}` };
      if (!usable.length) return { ok: false, error: "device_not_found", message: "no paired iPhone with a live connection — unlock it and connect it (cable or the same network), or name a booted simulator in NORACU_IOS_UDID" };
      d = usable[0];
    }
    if (d.simulated || d.tunnelIP) return { ok: true, device: d };
    const det = await api.deviceDetails(d.udid);       // the list can lack the tunnel address
    return det.ok ? { ok: true, device: { ...d, ...det.device, udid: d.udid, name: det.device.name ?? d.name } } : det;
  }

  // ---------- runner ----------
  function stopRunner() {
    const r = runner; runner = null; suspect = false;
    if (!r) return;
    try { r.stop(); } catch { /* already gone */ }
    trackExit(r.exited);
  }
  // A runner that was stopped (or a start that failed) is remembered until its xcodebuild has really exited, not
  // for a fixed time: each start waits up to STOP_WAIT_MS for it and is refused while it is still there. (Pre-review
  // P3: the first refusal used to forget it, so the start after that ran a second test session on the device; and
  // an exit that came late was still held against a start made minutes afterwards.)
  function trackExit(exited) {
    if (!exited) return;
    const p = Promise.all([stopping, exited]).then(() => { if (stopping === p) stopping = null; });
    stopping = p;
  }

  // The lock (pre-review P1). gate() reads it before every input, as before. On top of that no runner op that
  // touches or shows the screen goes out on an "unlocked" answer older than a second: typing after the tap that
  // focuses the field reads it again, and so does a snapshot or screenshot on its own — a locked phone's screen
  // shows its notifications, so it is not read either. A tap right after its gate costs no second read.
  const LOCK_FRESH_MS = 1000;
  const STOP_WAIT_MS = 4000;
  // app_state too: a locked phone's answer to "is it in front" is not read as one (review S4A-s6-grok-2)
  const NEEDS_UNLOCKED = new Set(["snapshot", "screenshot", "app_state", "tap", "press", "drag", "type", "keys", "home"]);
  const INPUT_OPS = new Set(["tap", "press", "drag", "type", "keys", "home"]);
  let lockOkAt = -Infinity;
  async function lockRefusal(force) {
    const d = runner?.device;
    if (!d || d.simulated || (!force && now() - lockOkAt <= LOCK_FRESH_MS)) return null;
    const lock = await api.lockState(d.udid);
    if (!lock.ok) return { error: "lock_unknown", message: `could not read the iPhone's lock state (${lock.message}) — refused (fail closed)` };
    if (lock.locked) return { error: "device_locked", message: "the iPhone is locked — unlock it" };
    lockOkAt = now();
    return null;
  }

  async function startOnce() {
    // observation-only mode never starts the runner: a starting runner puts its own app in front of whatever the iPhone shows
    if (readOnly) return { ok: false, error: "runner_not_started", message: "NORACU_READ_ONLY=1 does not start the runner: starting it puts the runner's own app in front of whatever the iPhone shows — ios_status still answers; unset NORACU_READ_ONLY to read the screen" };
    const g = gen;   // read before anything is waited for: a shutdown during any wait below stops this start
    const shut = { ok: false, error: "runner_start_failed", message: "the session was shut down while the runner was starting" };
    // two test sessions on one device at once do not work: a runner that was stopped must be gone first
    if (stopping) {
      const gone = await Promise.race([stopping.then(() => true), sleep(STOP_WAIT_MS).then(() => false)]);
      if (!gone) return { ok: false, error: "runner_start_failed", message: "the runner that was stopped has not exited yet — try again in a moment" };
    }
    if (g !== gen) return shut;   // shut down while a stopped runner was waited for
    const dev = await resolveDevice();
    if (!dev.ok) return dev;
    const device = dev.device;
    const bind = api.bindAddressFor(device);
    if (!bind.ok) return bind;
    if (!device.simulated) {
      const lock = await api.lockState(device.udid);
      if (!lock.ok) return { ok: false, error: "lock_unknown", message: `could not read the iPhone's lock state (${lock.message})` };
      if (lock.locked) return { ok: false, error: "device_locked", message: "the iPhone is locked — unlock it" };
      lockOkAt = now();
    }
    const xctestrun = await api.findXctestrun(join(dir, device.udid));
    if (!xctestrun) return { ok: false, error: "ios_setup_required", message: `no runner build for this device — run: npx noracu ios-setup ${device.simulated ? "" : "--team <TeamID> "}--udid ${device.udid}` };
    if (g !== gen) return shut;   // shut down while the device, the lock or the build was looked up: nothing is started
    const start = () => api.startRunner({ udid: device.udid, xctestrun, bind: bind.bind, spawnImpl, env });
    let r = await start();
    // The first start after a rebuild has been seen running the previous build: one more start, once that one is
    // gone. A second runner of another build is an old build on the phone: the answer says to run the set-up again.
    if (!r.ok && r.stale && r.exited && g === gen) {
      const gone = await Promise.race([r.exited.then(() => true), sleep(STOP_WAIT_MS).then(() => false)]);
      if (gone && g === gen) r = await start();
    }
    if (!r.ok) { trackExit(r.exited); return { ok: false, error: r.error, message: r.message }; }
    if (g !== gen) { try { r.stop(); } catch { /* already gone */ } trackExit(r.exited); return shut; }
    runner = { ...r, device, startedAt: now() };
    suspect = false;
    epoch++;   // a starting runner puts its own app in front: whatever was read before is no longer what is on screen
    onChild(r.child);
    r.child?.once?.("exit", () => { if (runner && runner.child === r.child) { try { runner.client.close(); } catch { /* closed */ } runner = null; } });
    return { ok: true };
  }

  async function ensureRunner() {
    if (runner && suspect) {
      const p = await runner.client.call("ping", {}, { timeoutMs: 5000 });
      if (p.ok) suspect = false; else stopRunner();   // a stuck action ends with the test session
    }
    if (runner) return { ok: true };
    if (!starting) starting = startOnce().finally(() => { starting = null; });
    return starting;
  }

  // the runner that is up, asked for a sign of life when in doubt — never a new one
  async function liveRunner() {
    if (runner && suspect) {
      const p = await runner.client.call("ping", {}, { timeoutMs: 5000 });
      if (p.ok) suspect = false; else stopRunner();
    }
    return runner ? { ok: true } : { ok: false, error: "runner_unreachable", message: "the runner stopped before the input went out (input never starts one)" };
  }

  // an xctest_issue that an internal read met and the tool has not reported yet
  const takeHeld = () => { const h = heldIssue; heldIssue = null; return h; };

  async function rcall(op, args, timeoutMs) {
    // Safety net: a failure XCTest recorded that an internal read was answered with, and that the tool which made
    // the read did not report itself, is not lost — the next input is not sent, and reports it. No runner is
    // started for that.
    if (heldIssue && INPUT_OPS.has(op)) { const h = takeHeld(); return { ok: false, error: "xctest_issue", message: h.message, delivery: "not_delivered" }; }
    // input never starts a runner: a runner that starts puts its own app in front, under the points and the focus the
    // input was made for — only the gate (before anything is read for the call) may start one (review S4A-s6-gemini-1)
    const up = INPUT_OPS.has(op) ? await liveRunner() : await ensureRunner();
    const cur = runner;
    if (!up.ok || !cur) return { ok: false, error: up.ok ? "runner_unreachable" : (up.error || "runner_unreachable"), message: up.ok ? "the runner stopped" : (up.message || "the runner stopped"), delivery: "not_delivered" };
    if (NEEDS_UNLOCKED.has(op)) {
      const l = await lockRefusal(false);
      if (l) return { ok: false, error: l.error, message: l.message, delivery: "not_delivered" };
    }
    const r = await cur.client.call(op, args, { timeoutMs });
    // An input that got no answer may still be waiting inside the test session: the session ends now, so the
    // gesture cannot go out later (pre-review P1; the protocol always said so). Any failure XCTest recorded ends it
    // as well, whichever command was answered with it — an input, a read, or the next command after a late one:
    // what state the test session is in is then not known, and a ping answers from the socket alone (pre-review
    // P3 and P4). A read that got no answer only makes the next call ask for a sign of life first.
    const ends = !r.ok && (r.error === "xctest_issue" || (r.error === "ios_timeout" && INPUT_OPS.has(op)));
    if (ends) { if (runner === cur) stopRunner(); }
    else if (!r.ok && ["ios_timeout", "runner_unreachable", "runner_protocol"].includes(r.error)) suspect = true;
    return r;
  }

  // ---------- gates ----------
  // Before any input: the app rule, a running runner, then the lock. Returns an error result or null.
  async function gate(bundle, op = "input") {
    const denied = approve(bundle, op);
    if (denied) return { error: denied };
    const up = await ensureRunner();
    if (!up.ok || !runner) return { error: `${up.ok ? "runner_unreachable" : up.error}: ${up.ok ? "the runner stopped" : up.message} ${NOT_SENT}` };
    const l = await lockRefusal(true);
    if (l) return { error: `${l.error}: ${l.message} ${NOT_SENT}` };
    // the runner can exit while the lock is read (review S4A-s6-gemini-1)
    if (!runner) return { error: `runner_unreachable: the runner stopped ${NOT_SENT}` };
    return null;
  }
  // a runner started during this call: it put its own app in front, so the points and the focus the call was made for
  // are gone (review S4A-s6-grok-3). Input given as points or as the focus (no element_index) is refused whenever the
  // gate or a read started a runner during the call, whatever app it names — the runner's own "not in front" check
  // depends on how fast the app comes back, so it is not relied on. An element_index of an older epoch is stale.
  const restarted = () => ({ error: `runner_restarted: the runner started during this call, which puts its own app in front — the screen the points or the focus were meant for is gone; look again (ios_snapshot) ${NOT_SENT}` });
  const HINTS = {
    app_not_foreground: " — the app is not in front; call ios_launch first",
    app_not_running: " — the app is not running; call ios_launch first",
    system_alert: " — a system prompt is up on the iPhone; the person answers it there (noracu does not send input while one is up)",
    no_keyboard: " — no keyboard is up; tap a text field first (ios_type with element_index does that)",
    ios_timeout: " — look before acting again (ios_snapshot)",
    xctest_issue: " — XCTest reported a failure while the command ran; look before acting again (ios_snapshot)",
  };
  // While app rules are in force, no input that names com.apple.springboard is sent — not even one tap on a
  // button of a system prompt (next-steps R4, 2026-11-12). SpringBoard reads "in front" under every app, so a
  // point named for it lands on whatever app is in front (one the rules may not allow), a tap on a Home Screen
  // icon opens an app no rule was asked about (ios_launch is the way that asks), and text goes wherever the
  // keyboard focus is. ios_home is not input named for SpringBoard and still goes out.
  // The refusal comes before the gate (pre-review P5): the gate can start a runner, and a starting runner puts
  // its own app in front of what the iPhone was showing — a refusal that says nothing was sent must change
  // nothing either. The app rule is asked first and answers in its own words.
  const sbNever = (bundle) => {
    if (bundle !== SPRINGBOARD || !springboardDenied()) return null;
    const denied = approve(bundle, "input");
    return { error: denied || `input_denied: input that names com.apple.springboard (the Home Screen) is not sent while app rules are in force (NORACU_APPROVAL_FILE or NORACU_DENY_APPS) — not even one tap on a system prompt's button; open apps with ios_launch, go home with ios_home ${NOT_SENT}` };
  };
  // system_alert comes with two messages: an alert is up, or SpringBoard could not be read so one could not be ruled
  // out — only the first is told "a system prompt is up" (review S4B-s8-new-1, S4D)
  const hint = (r) => (r.error === "system_alert" && /could not be (read|ruled out)/.test(r.message || "")
    ? " — noracu could not tell whether a system prompt is up on the iPhone; look at it (ios_screenshot) before acting again"
    : HINTS[r.error] || "");
  const inputError = (r) => ({ error: `${r.error}: ${r.message || "the runner refused"}${hint(r)} ${r.delivery === "not_delivered" ? NOT_SENT : UNKNOWN}` });
  const readError = (r) => ({ error: `${r.error}: ${r.message || "the runner refused"}${r.error === "app_not_running" ? HINTS.app_not_running : ""}` });
  function pickBundle(a, input) {
    const b = a.bundle_id ?? current;
    return b ? { bundle: b } : { error: `bundle_id required: name the app (ios_launch sets it for later calls)${input ? ` ${NOT_SENT}` : ""}` };
  }

  // ---------- elements ----------
  function lookup(idx, snapshotId) {
    const it = items.get(idx);
    if (!it || it.epoch !== epoch || now() - it.ts > IOS_TTL_MS || (snapshotId !== undefined && it.snapshot_id !== snapshotId)) return null;
    return it;
  }
  const label = (idx, it) => `element_index ${idx} (${it.type}${it.label ? ` "${it.label.slice(0, 40)}"` : ""})`;
  const stale = (idx, why = "it is older than 30 s, from before the app in front changed, or unknown") =>
    ({ error: `element_no_longer_valid: element_index ${idx} — ${why}; take a new ios_snapshot ${NOT_SENT}` });
  // Read the app again and find the very element: same type, label, identifier and frame (2 pt), app in front.
  async function recheck(idx, it) {
    const r = await rcall("snapshot", { bundle_id: it.bundle, max_nodes: 1000 }, 30000);
    if (!r.ok) return { error: inputError({ ...r, delivery: "not_delivered" }).error };
    const res = r.result;
    if (it.bundle !== SPRINGBOARD && res.state !== FOREGROUND) return stale(idx, `${it.bundle} is no longer in front`);
    const same = (Array.isArray(res.nodes) ? res.nodes : []).filter((n) => n.type === it.type && (n.label || "") === it.label && (n.id || "") === it.id && Array.isArray(n.frame));
    const node = same.find((n) => n.frame.every((v, k) => Math.abs(v - it.frame[k]) <= 2));
    if (!node) return stale(idx, same.length ? `${label(idx, it)} moved` : `${label(idx, it)} is gone or changed`);
    // the centre of the part that is on screen
    const w = res.screen?.w || 0, h = res.screen?.h || 0, [fx, fy, fw, fh] = node.frame;
    const x0 = Math.max(0, fx), y0 = Math.max(0, fy), x1 = Math.min(w, fx + fw), y1 = Math.min(h, fy + fh);
    if (!(x1 > x0 && y1 > y0)) return stale(idx, `${label(idx, it)} is off screen`);
    return { x: Math.round((x0 + x1) / 2 * 10) / 10, y: Math.round((y0 + y1) / 2 * 10) / 10 };
  }
  // the app's text inputs, for the read-back after typing: [{ key, value, cut }]; null when the app cannot be read
  async function textFields(bundle) {
    const r = await rcall("snapshot", { bundle_id: bundle, max_nodes: 1000 }, 30000);
    if (!r.ok) { if (r.error === "xctest_issue") heldIssue = r; return null; }
    if (r.result.truncated === true) return null;   // fields past the limit were not read: nothing can be paired
    return (r.result.nodes || []).filter((n) => TEXTY.has(n.type) && typeof n.value === "string")
      .map((n) => ({ key: `${n.type}|${n.id || ""}|${n.label || ""}`, value: n.value, cut: n.value_truncated === true, ph: typeof n.placeholder === "string" ? n.placeholder : "" }));
  }
  // → { ok, st }: st is the last state read (null: none was); failed: a read failed, which ended the wait early
  async function waitState(bundle, want, ms) {
    const end = now() + ms;
    let st = null;
    for (;;) {
      const r = await rcall("app_state", { bundle_id: bundle }, 10000);
      if (!r.ok) { if (r.error === "xctest_issue") heldIssue = r; return { ok: false, st, failed: true }; }
      st = r.result.state;
      // "left the front" is a state seen as not running, suspended or in the background — never unknown (0) or no
      // state at all (review S4A-s6-grok-1)
      if (want ? st === FOREGROUND : [1, 2, 3].includes(st)) return { ok: true, st };
      if (now() >= end) return { ok: false, st };
      await sleep(300);
    }
  }

  // ---------- tools ----------
  return {
    async status() {
      const out = { backend: "xcuitest", experimental: true, device: null };
      const dev = await resolveDevice();
      if (!dev.ok) out.problem = `${dev.error}: ${dev.message}`;
      else {
        const d = dev.device;
        out.device = { name: d.name, model: d.model, os: d.os, udid: d.udid, simulated: d.simulated, transport: d.transport, paired: d.paired, tunnel: d.tunnel, developer_mode: d.developerMode, booted: d.booted };
        const bind = api.bindAddressFor(d);
        if (!bind.ok) out.problem = `${bind.error}: ${bind.message}`;
        if (!d.simulated) {
          const lock = await api.lockState(d.udid);
          out.locked = lock.ok ? lock.locked : null;
          if (!lock.ok) out.lock_problem = lock.message;
        }
        out.setup = (await api.findXctestrun(join(dir, d.udid))) ? "built" : `missing — run: npx noracu ios-setup ${d.simulated ? "" : "--team <TeamID> "}--udid ${d.udid}`;
      }
      out.runner = runner ? { state: "running", protocol: api.PROTOCOL_VERSION, up_s: Math.round((now() - runner.startedAt) / 1000) } : { state: starting ? "starting" : "not_started" };
      out.current_app = current;
      return { text: JSON.stringify(out) };
    },

    async launch(a) {
      const bundle = a.bundle_id;
      // the runner first: starting it puts its own app in front, which would cover an app launched before it
      const g = await gate(bundle, "launch");
      if (g) return g;
      const d = runner.device, opts = { terminateExisting: a.terminate_existing === true };
      const r = d.simulated ? await api.simLaunch(d.udid, bundle, opts) : await api.launchApp(d.udid, bundle, opts);
      if (!r.ok) {
        const late = /timeout/.test(r.error);
        // with terminate_existing the running app may already have been stopped when the launch failed
        return { error: `${late ? r.error : "launch_failed"}: ${r.message} ${opts.terminateExisting ? "— the running app may already have been stopped (delivery=unknown, retry=unsafe)" : late ? "(delivery=unknown, retry=safe)" : NOT_SENT}` };
      }
      epoch++; current = bundle;
      // the launch went out: asking again with terminate_existing would stop the app that was just started
      const again = opts.terminateExisting ? "unsafe" : "safe";
      const w = await waitState(bundle, true, 10000);
      if (heldIssue) { const h = takeHeld(); return { error: `xctest_issue: ${h.message || "XCTest recorded a failure"}${HINTS.xctest_issue} — ${bundle} was started; whether it is in front was not read (delivery=delivered_unverified, retry=${again})` }; }
      if (w.ok) return { text: `launched ${bundle} — it is in front (delivery=delivered_verified, retry=${again})` };
      // a read of the app's state failed (with no failure of XCTest's behind it), so the 10 s were not waited
      // out: the result says what was read, not "not in front after 10 s" (pre-review P8)
      if (w.failed) return { error: `launch_not_confirmed: ${bundle} was started; ${w.st === null ? "whether it is in front could not be read" : `it was not in front when its state was last read (state ${stateName(w.st)}), and the read after that failed`} — look with ios_screenshot (delivery=delivered_unverified, retry=${again})` };
      return { error: `launch_not_confirmed: ${bundle} was started but is not in front after 10 s (state ${stateName(w.st)}) — a system prompt may be covering it; look with ios_screenshot (delivery=delivered_unverified, retry=${again})` };
    },

    async snapshot(a = {}) {
      const p = pickBundle(a, false);
      if (p.error) return p;
      const max = a.max_nodes ?? 300;
      const r = await rcall("snapshot", { bundle_id: p.bundle, max_nodes: a.interactive ? 1000 : max }, 30000);
      if (!r.ok) return readError(r);
      const res = r.result, snapshot_id = `ios-${++snapSeq}`, ts = now();
      let nodes = Array.isArray(res.nodes) ? res.nodes.filter((n) => n && typeof n.type === "string" && Array.isArray(n.frame) && n.frame.length === 4) : [];
      if (a.interactive) nodes = nodes.filter((n) => INTERACTIVE.has(n.type));
      const cut = nodes.length > max;
      const elements = nodes.slice(0, max).map((n) => {
        const i = nextIndex++;
        items.set(i, { snapshot_id, bundle: p.bundle, type: n.type, label: n.label || "", id: n.id || "", frame: n.frame, ts, epoch });
        const e = { i, type: n.type, label: n.label || "" };
        if (n.id) e.id = n.id;
        if (typeof n.value === "string" && n.type !== "secureTextField") e.value = n.value;
        if (typeof n.placeholder === "string" && n.placeholder && n.type !== "secureTextField") e.placeholder = n.placeholder;
        if (n.value_truncated === true) e.value_truncated = true;
        e.frame = n.frame;
        if (n.enabled === false) e.disabled = true;
        if (n.selected === true) e.selected = true;
        return e;
      });
      while (items.size > ITEMS_KEPT) items.delete(items.keys().next().value);
      current = p.bundle;
      const out = { bundle_id: p.bundle, snapshot_id, state: stateName(res.state), screen: res.screen, count: elements.length, truncated: Boolean(res.truncated) || cut, elements };
      if (p.bundle !== SPRINGBOARD && res.state !== FOREGROUND) out.note = "this app is not in front: its elements cannot be acted on until ios_launch brings it forward";
      return { text: JSON.stringify(out) };
    },

    async tap(a) {
      let bundle, x, y, what;
      const press = a.duration_ms !== undefined;
      let e1;
      if (a.element_index !== undefined) {
        const it = lookup(a.element_index, a.snapshot_id);
        if (!it) return stale(a.element_index);
        const n = sbNever(it.bundle);
        if (n) return n;
        const g = await gate(it.bundle);
        if (g) return g;
        if (it.epoch !== epoch) return stale(a.element_index);   // the gate started a runner: what was read is gone
        e1 = epoch;
        const c = await recheck(a.element_index, it);
        if (c.error) return c;
        ({ x, y } = c); bundle = it.bundle; what = label(a.element_index, it);
      } else {
        const p = pickBundle(a, true);
        if (p.error) return p;
        const n = sbNever(p.bundle);
        if (n) return n;
        const e0 = epoch;
        const g = await gate(p.bundle);
        if (g) return g;
        if (epoch !== e0) return restarted();
        e1 = epoch;
        bundle = p.bundle; x = a.x; y = a.y; what = "the point";
      }
      if (epoch !== e1) return restarted();
      const r = press
        ? await rcall("press", { bundle_id: bundle, x, y, duration_ms: a.duration_ms }, 20000 + a.duration_ms)
        : await rcall("tap", { bundle_id: bundle, x, y, ...(a.count > 1 ? { count: a.count } : {}) }, 20000);
      if (!r.ok) return inputError(r);
      current = bundle;
      return { text: `${press ? `pressed ${a.duration_ms} ms on` : a.count > 1 ? `tapped ×${a.count}` : "tapped"} ${what} at (${x}, ${y}) in ${bundle} — sent; the screen is not checked ${UNVERIFIED}` };
    },

    async type(a) {
      let bundle, secure = false, tapped = false, key = null, e1;
      if (a.element_index !== undefined) {
        const it = lookup(a.element_index, a.snapshot_id);
        if (!it) return stale(a.element_index);
        const n = sbNever(it.bundle);   // before the gate, and before the tap that would focus: nothing is sent, no runner is started
        if (n) return n;
        const g = await gate(it.bundle);
        if (g) return g;
        if (it.epoch !== epoch) return stale(a.element_index);   // the gate started a runner: what was read is gone
        e1 = epoch;
        const c = await recheck(a.element_index, it);
        if (c.error) return c;
        if (epoch !== e1) return restarted();
        const t = await rcall("tap", { bundle_id: it.bundle, x: c.x, y: c.y }, 20000);
        if (!t.ok) return inputError(t);
        bundle = it.bundle; secure = it.type === "secureTextField"; tapped = true; key = `${it.type}|${it.id}|${it.label}`;
      } else {
        const p = pickBundle(a, true);
        if (p.error) return p;
        const n = sbNever(p.bundle);
        if (n) return n;
        const e0 = epoch;
        const g = await gate(p.bundle);
        if (g) return g;
        if (epoch !== e0) return restarted();
        e1 = epoch;
        bundle = p.bundle;
      }
      current = bundle;
      // a failure XCTest recorded that one of the reads around the typing was answered with (the session has ended)
      const issueAt = (h, typed) => (typed ? inputError({ ...h, delivery: "unknown" })
        : tapped ? { error: `xctest_issue: ${h.message || "XCTest recorded a failure"}${HINTS.xctest_issue} — the field was tapped, no text was typed (delivery=delivered_unverified, retry=unsafe)` }
        : inputError({ ...h, delivery: "not_delivered" }));
      let before = secure ? null : await textFields(bundle);
      if (heldIssue) return issueAt(takeHeld(), false);
      // after the tap the keyboard takes a moment; no_keyboard sent nothing, so asking again is safe
      let r;
      for (let i = 0; i < (tapped ? 8 : 1); i++) {
        // a read before the text (textFields) can have started a runner: the focus is gone then
        if (epoch !== e1) return tapped ? { error: `runner_restarted: the runner started again after the field was tapped — no text was typed; look again (ios_snapshot) (delivery=delivered_unverified, retry=unsafe)` } : restarted();
        r = await rcall("type", { bundle_id: bundle, text: a.text }, 30000 + 80 * a.text.length);
        if (r.ok || r.error !== "no_keyboard") break;
        await sleep(350);
        if (!secure) before = await textFields(bundle);   // the keyboard coming up can move or hide fields: read again what is there before the text goes in
        if (heldIssue) return issueAt(takeHeld(), false);
      }
      const n = [...a.text].length;
      if (!r.ok) return tapped && r.delivery === "not_delivered" ? { error: `${r.error}: ${r.message || "the runner refused"}${hint(r)} — the field was tapped, no text was typed (delivery=delivered_unverified, retry=unsafe)` } : inputError(r);
      if (secure) return { text: `typed ${n} characters into a secure field in ${bundle} — it never shows its value, so nothing was read back ${UNVERIFIED}` };
      if (a.text.includes("\n")) return { text: `typed ${n} characters in ${bundle} — the text contains a return, which can submit or clear the field, so nothing was read back ${UNVERIFIED}` };
      if (n < 4) return { text: `typed ${n} character${n === 1 ? "" : "s"} in ${bundle} — too short to tell from what was already there, so nothing was read back ${UNVERIFIED}` };
      const after = await textFields(bundle);
      // a failure XCTest recorded once the text had gone out: the "ok" the runner gave for it is in doubt
      if (heldIssue) return issueAt(takeHeld(), true);
      const notConfirmed = { error: `type_not_confirmed: ${n} characters were typed in ${bundle} but ${key ? "the field that was tapped was not" : "no text field was"} seen to gain exactly that text (autocorrection or a field that hides its value can cause this) — read the field (ios_snapshot) before typing again ${UNKNOWN}` };
      // The fields could not be read afterwards (the read failed, or the app has more elements than are read): the
      // text was not seen to be missing, which type_not_confirmed would say — unverified, and the result names the
      // side that could not be read (reviews P5, P6)
      if (after === null) return { text: `typed ${n} characters in ${bundle} — the text fields ${before !== null ? "could not be read afterwards" : "could not be read before the text went in or afterwards"}, so nothing was read back ${UNVERIFIED}` };
      // What the two reads say is decided in one place (fieldShows); each of its answers has one sentence here
      const shown = fieldShows(before, after, a.text, key);
      if (shown === "shown") return { text: `typed ${n} characters in ${bundle} — a text field shows them (delivery=delivered_verified, retry=unsafe)` };
      const unverified = {
        placeholder: "the text is the same as a field's placeholder, which cannot be told from an empty field, so nothing was read back",
        unread: "the text fields could not be read before the text went in, so what they show now has nothing to be compared with",
        moved: "the text fields listed before the text went in and afterwards are not the same ones, so the text could not be tied to one of them",
        cut: "the field's value came back cut short, so the text could not be looked for in all of it",
        several: "more than one text field changed while the text went in, so it was not tied to one of them",
      }[shown];
      return unverified ? { text: `typed ${n} characters in ${bundle} — ${unverified} ${UNVERIFIED}` } : notConfirmed;
    },

    async key(a) {
      const p = pickBundle(a, true);
      if (p.error) return p;
      const never = sbNever(p.bundle);
      if (never) return never;
      const e0 = epoch;
      const g = await gate(p.bundle);
      if (g) return g;
      if (epoch !== e0) return restarted();
      const n = a.count ?? 1;
      const r = await rcall("keys", { bundle_id: p.bundle, key: a.key, count: n }, 20000 + 100 * n);
      if (!r.ok) return inputError(r);
      current = p.bundle;
      return { text: `pressed ${a.key}${n > 1 ? ` ×${n}` : ""} in ${p.bundle} — sent; the screen is not checked ${UNVERIFIED}` };
    },

    async swipe(a) {
      const p = pickBundle(a, true);
      if (p.error) return p;
      const never = sbNever(p.bundle);
      if (never) return never;
      const e0 = epoch;
      const g = await gate(p.bundle);
      if (g) return g;
      if (epoch !== e0) return restarted();
      const args = { bundle_id: p.bundle, from: a.from, to: a.to };
      for (const k of ["hold_ms", "end_hold_ms", "velocity"]) if (a[k] !== undefined) args[k] = a[k];
      const r = await rcall("drag", args, 25000 + (a.hold_ms ?? 0) + (a.end_hold_ms ?? 0));
      if (!r.ok) return inputError(r);
      current = p.bundle;
      return { text: `swiped (${a.from[0]}, ${a.from[1]}) → (${a.to[0]}, ${a.to[1]}) in ${p.bundle} — sent; the screen is not checked ${UNVERIFIED}` };
    },

    async home() {
      const g = await gate(SPRINGBOARD, "home");
      if (g) return g;
      const prev = current;
      // whether prev was in front before the press: only then can "left the front" be seen (review S4A-s6-D-1)
      let wasFront = null;
      if (prev && prev !== SPRINGBOARD) {
        const pre = await rcall("app_state", { bundle_id: prev }, 10000);
        if (!pre.ok && pre.error === "xctest_issue") return inputError({ ...pre, delivery: "not_delivered" });
        // tri-state (review S4B-s6-1): in front, seen elsewhere (1/2/3), or not known (0, no state, a failed read)
        const st = pre.ok ? pre.result?.state : undefined;
        wasFront = st === FOREGROUND ? true : [1, 2, 3].includes(st) ? false : null;
      }
      const r = await rcall("home", {}, 15000);
      if (!r.ok) return inputError(r);
      epoch++;
      if (prev && prev !== SPRINGBOARD && wasFront !== true) {
        // not read: it stays the app later calls default to, as when its state cannot be read after the press
        if (wasFront === false) current = SPRINGBOARD;
        return { text: wasFront === false
          ? `home pressed — ${prev} was not in front before the press, so it was not seen to leave the front (delivery=delivered_unverified, retry=safe)`
          : `home pressed — whether ${prev} left the front could not be read (delivery=delivered_unverified, retry=safe)` };
      }
      if (prev && prev !== SPRINGBOARD) {
        const w = await waitState(prev, false, 3000);
        // home was pressed; XCTest then recorded a failure while the app's state was read
        if (heldIssue) { const h = takeHeld(); return { error: `xctest_issue: ${h.message || "XCTest recorded a failure"}${HINTS.xctest_issue} — home was pressed; whether ${prev} left the front was not read (delivery=delivered_unverified, retry=safe)` }; }
        if (w.ok) { current = SPRINGBOARD; return { text: `home pressed — ${prev} left the front (delivery=delivered_verified, retry=safe)` }; }
        // seen to stay in front: say so, and keep it as the app later calls default to
        // … or it was in front each time it was read and a later read failed, which ended the wait early (pre-review P8)
        if (w.st === FOREGROUND) return { error: w.failed
          ? `home_not_confirmed: home was pressed and ${prev} was still in front when its state was last read; the read after that failed — look with ios_screenshot (delivery=delivered_unverified, retry=safe)`
          : `home_not_confirmed: home was pressed but ${prev} is still in front after 3 s — look with ios_screenshot (delivery=delivered_unverified, retry=safe)` };
        // no state was read at all — any state but foreground ends the wait with ok, so what is left here is a
        // first read that failed (with no failure of XCTest's behind it): pressed and not seen — and, as when the
        // app is seen to stay, it remains the app later calls default to
        return { text: `home pressed — whether ${prev} left the front could not be read (delivery=delivered_unverified, retry=safe)` };
      }
      current = SPRINGBOARD;
      return { text: `home pressed — sent; the screen is not checked ${UNVERIFIED}` };
    },

    async screenshot() {
      const r = await rcall("screenshot", {}, 30000);
      if (!r.ok) return readError(r);
      const png = r.result.png_base64;
      if (typeof png !== "string" || png.length < 50) return { error: "capture_failed: the runner returned no image" };
      return { image: png, mime: "image/png", meta: { w: r.result.w, h: r.result.h, unit: "points (ios_tap x,y and ios_snapshot frames use the same)" } };
    },

    // best effort, bounded by the caller: tell the runner to end its test, then stop xcodebuild
    async shutdown() {
      gen++;
      try { api.killPending?.(); } catch { /* nothing to stop */ }
      const r = runner;
      if (r) {
        try { await r.client.call("quit", {}, { timeoutMs: 1000 }); } catch { /* going away anyway */ }
        stopRunner();
      }
    },
    _state: () => ({ running: Boolean(runner), suspect, current, epoch, items: items.size }),
  };
}

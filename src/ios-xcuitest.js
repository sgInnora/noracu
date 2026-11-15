// ios-xcuitest — Mac side of the experimental XCUITest iPhone backend (0.3.0). src/ios-session.js builds the
// ios_* tools on it.
//
// The phone runs a small UI-test bundle ("runner", ios-runner/) that listens on the device's own
// CoreDevice tunnel address and executes one JSON command per line (docs/ios-runner-protocol.md).
// This module finds the device, starts the runner through xcodebuild, and talks to it.
//
// What it keeps to:
//  • No internet. xcodebuild and devicectl are local tools; the socket goes to a paired device over
//    Apple's tunnel, or to 127.0.0.1 for a simulator.
//  • Every subprocess gets its arguments as an argv array — nothing is put into a shell line.
//  • devicectl answers are read from --json-output files, never from terminal text (Apple documents
//    the JSON as the stable interface and the terminal output as free to change).
//  • Every runner call has a hard time limit. A call that timed out, or whose connection broke after
//    the request left, is reported as such — "delivery unknown" for input commands — and never
//    re-sent. The connection is dropped so a late answer cannot be taken for the next call's.
//  • Launching an app and reading the lock state go through devicectl, not the runner: on a real
//    iPhone XCUIApplication.activate() was seen to wait 33–60 s for an app to settle (probe 2026-11-10).

import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PROTOCOL_VERSION = 1;
export const MAX_ANSWER_BYTES = 16 * 1024 * 1024;   // a screenshot answer is the largest line
export const MAX_REQUEST_BYTES = 64 * 1024;         // the runner closes the connection on a longer line
export const INPUT_OPS = new Set(["tap", "press", "drag", "type", "keys", "home"]);
// The runner's one long test. The method must not be called testRun: XCTest has a property of that name,
// and a test with that name "passes" in a few milliseconds without its body ever running (seen 2026-11-10).
export const RUNNER_TEST_ID = "NoracuRunnerUITests/NoracuRunner/testServe";
// refusals the protocol defines as "checked before anything is sent"
const NOTHING_SENT = new Set(["auth", "invalid_args", "app_not_running", "app_not_foreground", "no_keyboard", "unknown_op"]);

const UDID_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}$|^[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$|^[0-9A-Fa-f]{40}$/;
const BUNDLE_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,154}$/;
const TOKEN_RE = /^[0-9a-f]{32}$/;
export const validUdid = (s) => typeof s === "string" && UDID_RE.test(s);
export const validBundleId = (s) => typeof s === "string" && BUNDLE_RE.test(s);

// Apple's tools, by absolute path. The two variables exist for the test suite (a fake xcrun and a fake
// xcodebuild), like NORACU_AX_ENGINE for the Mac layer.
export const XCRUN = process.env.NORACU_IOS_XCRUN || "/usr/bin/xcrun";
export const XCODEBUILD = process.env.NORACU_IOS_XCODEBUILD || "/usr/bin/xcodebuild";
// A simulator's identifier is a UUID; an iPhone's is 8-16 hex (or 40 hex on old hardware).
export const isSimulatorUdid = (s) => typeof s === "string" && /^[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$/.test(s);

const oneLine = (s, n = 300) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

// ---------- subprocesses ----------

const pending = new Set();   // the devicectl / simctl calls still running

// run(file, argv, { timeoutMs, env }) → { code, stdout, stderr, timedOut }. Injectable for tests.
export function defaultRun(file, argv, { timeoutMs = 30000, env } = {}) {
  return new Promise((resolve) => {
    const c = execFile(file, argv, { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024, env }, (err, stdout, stderr) => {
      pending.delete(c);
      resolve({ code: err ? (typeof err.code === "number" ? err.code : null) : 0, stdout: String(stdout || ""), stderr: String(stderr || ""), timedOut: !!(err && err.killed) });
    });
    pending.add(c);
  });
}

// the devicectl / simctl calls still running: ended when the server goes away
export function killPending() { for (const c of pending) { try { c.kill("SIGKILL"); } catch { /* already gone */ } } pending.clear(); }

// One devicectl call. Returns { ok: true, result } or { ok: false, error, message }.
export async function devicectl(args, { run = defaultRun, timeoutMs = 30000 } = {}) {
  let dir;
  try {
    dir = await mkdtemp(join(tmpdir(), "noracu-dc-"));           // 0700, ours alone
    const out = join(dir, "out.json");
    const r = await run(XCRUN, ["devicectl", ...args, "--quiet", "--json-output", out], { timeoutMs });
    if (r.timedOut) return { ok: false, error: "devicectl_timeout", message: `devicectl ${args.slice(0, 3).join(" ")} gave no answer in ${timeoutMs} ms` };
    let doc = null;
    try { doc = JSON.parse(await readFile(out, "utf8")); } catch { /* no file or not JSON: reported below */ }
    if (doc && doc.info && doc.info.outcome === "success" && doc.result && typeof doc.result === "object") return { ok: true, result: doc.result };
    const why = doc?.error?.userInfo?.NSLocalizedDescription?.string || doc?.error?.localizedDescription || r.stderr || r.stdout || `exit ${r.code}`;
    return { ok: false, error: "devicectl_failed", message: oneLine(why) };
  } catch (e) {
    return { ok: false, error: "devicectl_failed", message: oneLine(e && e.message) };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------- devices ----------

// One entry of `devicectl list devices` (or the result of `device info details`) → the fields we use.
export function parseDevice(d) {
  const c = d?.connectionProperties || {}, p = d?.deviceProperties || {}, h = d?.hardwareProperties || {};
  return {
    udid: typeof h.udid === "string" ? h.udid : null,
    name: typeof p.name === "string" ? p.name : null,
    model: h.marketingName ?? null,
    os: p.osVersionNumber ?? null,
    platform: h.platform ?? null,
    simulated: h.reality === "simulated",
    transport: c.transportType ?? null,                 // wired | localNetwork | sameMachine
    paired: c.pairingState === "paired",
    tunnel: c.tunnelState === "connected",
    tunnelIP: typeof c.tunnelIPAddress === "string" ? c.tunnelIPAddress : null,
    developerMode: p.developerModeStatus === "enabled",
    booted: p.bootState === "booted",
  };
}

export async function listDevices(opts = {}) {
  const r = await devicectl(["list", "devices"], opts);
  if (!r.ok) return r;
  const devices = (Array.isArray(r.result.devices) ? r.result.devices : []).map(parseDevice).filter((d) => d.platform === "iOS" && d.udid);
  return { ok: true, devices };
}

export async function deviceDetails(udid, opts = {}) {
  if (!validUdid(udid)) return { ok: false, error: "invalid_args", message: "udid is not a device identifier" };
  const r = await devicectl(["device", "info", "details", "--device", udid], opts);
  return r.ok ? { ok: true, device: parseDevice(r.result) } : r;
}

// Which address the runner must listen on, or why the device cannot be used yet.
export function bindAddressFor(device) {
  if (!device || !device.udid) return { ok: false, error: "device_not_found", message: "no such device" };
  if (device.simulated) return device.booted ? { ok: true, bind: "127.0.0.1" } : { ok: false, error: "device_not_ready", message: "the simulator is not booted" };
  if (!device.paired) return { ok: false, error: "device_not_ready", message: "the iPhone is not paired with this Mac" };
  if (!device.developerMode) return { ok: false, error: "device_not_ready", message: "Developer Mode is off on the iPhone" };
  if (!device.tunnel || !device.tunnelIP) return { ok: false, error: "device_not_ready", message: "no CoreDevice tunnel to the iPhone (unlock it and check the cable or network)" };
  if (!net.isIPv6(device.tunnelIP)) return { ok: false, error: "device_not_ready", message: "the tunnel address is not an IPv6 address" };
  // the CoreDevice tunnel's address is unique-local (fc00::/7); anything else would listen beyond it (review S4A-s7-grok-3)
  if (device.tunnelIP !== "::1" && !/^f[cd][0-9a-f]{0,2}:/i.test(device.tunnelIP)) return { ok: false, error: "device_not_ready", message: "the tunnel address is not a unique-local (fc00::/7) address" };
  return { ok: true, bind: device.tunnelIP };
}

// { ok, locked } — locked means the phone asks for its passcode; input must be refused then.
export async function lockState(udid, opts = {}) {
  if (!validUdid(udid)) return { ok: false, error: "invalid_args", message: "udid is not a device identifier" };
  const r = await devicectl(["device", "info", "lockState", "--device", udid], opts);
  if (!r.ok) return r;
  if (typeof r.result.passcodeRequired !== "boolean") return { ok: false, error: "devicectl_failed", message: "lockState answer has no passcodeRequired" };
  return { ok: true, locked: r.result.passcodeRequired, unlockedSinceBoot: r.result.unlockedSinceBoot === true };
}

// Bring an app to the front (starting it if needed). Never terminates a running instance unless asked.
export async function launchApp(udid, bundleId, { terminateExisting = false, ...opts } = {}) {
  if (!validUdid(udid)) return { ok: false, error: "invalid_args", message: "udid is not a device identifier" };
  if (!validBundleId(bundleId)) return { ok: false, error: "invalid_args", message: "bundle_id is not a bundle identifier" };
  const r = await devicectl(["device", "process", "launch", "--device", udid, ...(terminateExisting ? ["--terminate-existing"] : []), bundleId], opts);
  if (!r.ok) return r;
  return { ok: true, pid: r.result.process?.processIdentifier ?? null, activated: r.result.launchOptions?.activatedWhenStarted === true };  // never assumed (review S4A-s7-A-1)
}

// The same for a simulator, which devicectl does not launch apps on: simctl, by exit code.
export async function simLaunch(udid, bundleId, { terminateExisting = false, run = defaultRun, timeoutMs = 30000 } = {}) {
  if (!isSimulatorUdid(udid)) return { ok: false, error: "invalid_args", message: "udid is not a simulator identifier" };
  if (!validBundleId(bundleId)) return { ok: false, error: "invalid_args", message: "bundle_id is not a bundle identifier" };
  const r = await run(XCRUN, ["simctl", "launch", ...(terminateExisting ? ["--terminate-running-process"] : []), udid, bundleId], { timeoutMs });
  if (r.timedOut) return { ok: false, error: "simctl_timeout", message: `simctl launch gave no answer in ${timeoutMs} ms` };
  if (r.code !== 0) return { ok: false, error: "simctl_failed", message: oneLine(r.stderr || r.stdout || `exit ${r.code}`) };
  return { ok: true, pid: Number(/:\s*(\d+)\s*$/.exec(r.stdout.trim())?.[1]) || null, activated: null };  // simctl's exit 0 says the command ran, not that the app came to the front
}

// The runner build `noracu ios-setup` left for one device: <dir>/Build/Products/*.xctestrun (the newest).
// The runner bundle ids an .xctestrun names (TestHostBundleIdentifier, an XML plist as xcodebuild writes it) —
// [] when it names none that can be read this way, null when the file cannot be read.
export async function xctestrunHostIds(path) {
  try {
    const t = await readFile(path, "utf8");
    return [...t.matchAll(/<key>TestHostBundleIdentifier<\/key>\s*<string>([^<]*)<\/string>/g)].map((m) => m[1]);
  } catch {
    return null;
  }
}

export async function findXctestrun(dir) {
  try {
    const products = join(dir, "Build", "Products");
    const names = (await readdir(products)).filter((n) => n.endsWith(".xctestrun"));
    let best = null;
    for (const n of names) {
      const st = await stat(join(products, n));
      if (st.isFile() && (!best || st.mtimeMs > best.mtimeMs)) best = { path: join(products, n), mtimeMs: st.mtimeMs };
    }
    return best ? best.path : null;
  } catch {
    return null;
  }
}

// ---------- runner start-up ----------

export const newToken = () => randomBytes(16).toString("hex");
export const pickPort = () => randomInt(49152, 65536);

export function runnerEnv({ token, bind, port }) {
  if (!TOKEN_RE.test(String(token))) throw new Error("token must be 32 lowercase hex characters");
  if (!net.isIP(String(bind))) throw new Error("bind must be an IP literal");
  if (!Number.isInteger(port) || port < 49152 || port > 65535) throw new Error("port must be 49152-65535");
  return { TEST_RUNNER_NORACU_TOKEN: token, TEST_RUNNER_NORACU_BIND: bind, TEST_RUNNER_NORACU_PORT: String(port) };
}

export function xcodebuildArgv({ xctestrun, udid }) {
  if (typeof xctestrun !== "string" || !xctestrun.startsWith("/") || !xctestrun.endsWith(".xctestrun")) throw new Error("xctestrun must be an absolute path to an .xctestrun file");
  if (!validUdid(udid)) throw new Error("udid is not a device identifier");
  return ["test-without-building", "-xctestrun", xctestrun, "-destination", `id=${udid}`, `-only-testing:${RUNNER_TEST_ID}`];
}

const READY_RE = /^NORACU_RUNNER ready v=(\d+) port=(\d+)(?: build=(\S{1,64}))?[ \t]*\r?\n/m;   // the whole line, so a half-received port is never read

// ---- what the runner was built from ----
// The build on the phone outlives a noracu upgrade, and the first start after a rebuild has been seen running the
// previous build (simulator, 2026-11-11). So the runner names its build on the ready line — a hash of its own
// sources, written into NoracuRunner.swift by scripts/gen-runner-build.mjs — and a runner that names another one
// is not used.
export const RUNNER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "ios-runner");
const BUILD_LINE_RE = /^let noracuRunnerBuild = "([0-9a-f]*)"$/m;
// the hash of the runner's sources (every Swift file and the project file), the build line itself left out
export function runnerSourceHash(dir = RUNNER_DIR) {
  const swift = readdirSync(join(dir, "NoracuRunnerUITests")).filter((f) => f.endsWith(".swift")).sort().map((f) => join("NoracuRunnerUITests", f));
  const h = createHash("sha256");
  for (const rel of [join("NoracuRunner.xcodeproj", "project.pbxproj"), ...swift]) {
    h.update(rel.split("\\").join("/") + "\0");
    h.update(readFileSync(join(dir, rel), "utf8").replace(BUILD_LINE_RE, 'let noracuRunnerBuild = ""') + "\0");
  }
  return h.digest("hex").slice(0, 12);
}
// What a runner must name to be used: the hash of this copy of its sources. The build line in them must say the
// same — a change under ios-runner/ without scripts/gen-runner-build.mjs would otherwise build a runner that
// passes for the one before it (pre-review P4).
export function expectedRunnerBuild(dir = RUNNER_DIR) {
  let hash;
  try { hash = runnerSourceHash(dir); } catch { return { ok: false, message: "this noracu's runner sources (ios-runner/) could not be read, so a runner cannot be checked against them" }; }
  const named = runnerBuild(dir);
  if (named !== hash) return { ok: false, message: `this noracu's runner sources were changed without their build line: they hash to ${hash}, the line says ${named || "nothing"} — run node scripts/gen-runner-build.mjs, then the iOS set-up again` };
  return { ok: true, build: hash };
}
// the build the sources name; null when they cannot be read
export function runnerBuild(dir = RUNNER_DIR) {
  try { return BUILD_LINE_RE.exec(readFileSync(join(dir, "NoracuRunnerUITests", "NoracuRunner.swift"), "utf8"))?.[1] || null; } catch { return null; }
}
const ERROR_RE = /^NORACU_RUNNER error ([a-z_]{1,40})[ \t]*\r?\n/m;

// Start the runner and wait for its ready line. Returns
//   { ok: true, client, port, child, stop() }  or  { ok: false, error, message }.
// On every failure the xcodebuild process is stopped before returning.
export function startRunner({ udid, xctestrun, bind, token = newToken(), port = pickPort(), readyTimeoutMs = 120000, spawnImpl = spawn, env = process.env, connectHost, expected = expectedRunnerBuild() } = {}) {
  if (!expected.ok) return Promise.resolve({ ok: false, error: "runner_start_failed", message: expected.message });
  const build = expected.build;
  let argv, extra;
  try { argv = xcodebuildArgv({ xctestrun, udid }); extra = runnerEnv({ token, bind, port }); }
  catch (e) { return Promise.resolve({ ok: false, error: "invalid_args", message: e.message }); }
  return new Promise((resolve) => {
    let child, seen = "", settled = false, timer = null, exited = null;
    // xcodebuild and what it started get a process group of their own (detached), so the whole group is
    // signalled; a child without one (a test's stand-in) is signalled alone
    const signal = (sig) => { if (!child) return; try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* already gone */ } } };
    const kill = () => { signal("SIGTERM"); const k = setTimeout(() => signal("SIGKILL"), 3000); k.unref?.(); };
    const finish = (v) => { if (settled) return; settled = true; clearTimeout(timer); if (!v.ok) kill(); resolve(v.ok || !exited ? v : { ...v, exited }); };
    try { child = spawnImpl(XCODEBUILD, argv, { env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"], detached: true }); }
    catch (e) { return finish({ ok: false, error: "runner_start_failed", message: oneLine(e && e.message) }); }
    exited = new Promise((res) => { child.once?.("exit", res); child.once?.("error", res); });
    const onData = (chunk) => {
      if (settled) return;
      seen = (seen + String(chunk)).slice(-65536);
      const bad = ERROR_RE.exec(seen);
      if (bad) return finish({ ok: false, error: "runner_start_failed", message: `the runner refused to start: ${bad[1]}` });
      const m = READY_RE.exec(seen);
      if (!m) return;
      if (Number(m[1]) !== PROTOCOL_VERSION) return finish({ ok: false, error: "runner_version_mismatch", message: `the runner speaks protocol ${m[1]}, this noracu speaks ${PROTOCOL_VERSION} — run the iOS set-up again` });
      if (Number(m[2]) !== port) return finish({ ok: false, error: "runner_start_failed", message: "the runner reported a different port than it was given" });
      // built from other sources than this noracu's: an old build still on the phone, or the previous one run once more after a rebuild
      if (m[3] !== build) return finish({ ok: false, error: "runner_version_mismatch", stale: true, message: `the runner on the device is ${m[3] ? `build ${m[3]}` : "a build that names no version"}, this noracu's is ${build} — run the iOS set-up again (npx noracu ios-setup), then call again` });
      const client = new RunnerClient({ host: connectHost || bind, port, token });
      finish({ ok: true, client, port, child, exited, stop: () => { client.close(); kill(); } });
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (e) => finish({ ok: false, error: "runner_start_failed", message: oneLine(e && e.message) }));
    child.on("exit", (code) => finish({ ok: false, error: "runner_start_failed", message: startFailureText(code, seen) }));
    timer = setTimeout(() => finish({ ok: false, error: "runner_start_timeout", message: `the runner was not ready in ${readyTimeoutMs} ms` }), readyTimeoutMs);
  });
}

// What xcodebuild said when it ended before the runner was ready, in words a person can act on. Right after an iOS
// update the first start ended with "Timed out while enabling automation mode" and the next one worked (device run
// 2026-11-14, iPhone 16 Pro, iOS 27.2.1). Otherwise XCTest's own "Underlying Error", else the end of the log.
export function startFailureText(code, seen) {
  const log = String(seen || "");
  if (/enabling automation mode/i.test(log)) {
    return `xcodebuild ended (exit ${code}): the iPhone did not turn on UI automation in time — this happens after an iOS update or a restart. Unlock the iPhone, check that Settings › Developer › Enable UI Automation is on (enter the passcode if the iPhone asks for it), then call again`;
  }
  const under = /Underlying Error: ([^\n]*?)\)?\s*$/m.exec(log);
  if (under) return `xcodebuild ended (exit ${code}) before the runner was ready: ${oneLine(under[1], 240)}`;
  return `xcodebuild ended (exit ${code}) before the runner was ready: ${oneLine(log.slice(-600), 240)}`;
}

// ---------- the line protocol ----------

// One connection to the runner. Calls go one at a time; a second call while one is in flight is refused.
export class RunnerClient {
  constructor({ host, port, token, connectTimeoutMs = 5000, maxAnswerBytes = MAX_ANSWER_BYTES }) {
    this.host = host; this.port = port; this.token = token;
    this.connectTimeoutMs = connectTimeoutMs; this.maxAnswerBytes = maxAnswerBytes;
    this.sock = null; this.nextId = 1; this.pending = null; this.chunks = []; this.size = 0;
  }

  close() { const s = this.sock; this.sock = null; this.chunks = []; this.size = 0; if (s) s.destroy(); }

  _connect() {
    return new Promise((resolve) => {
      const s = net.createConnection({ host: this.host, port: this.port });
      const t = setTimeout(() => { s.destroy(); resolve(false); }, this.connectTimeoutMs);
      s.once("connect", () => { clearTimeout(t); s.setNoDelay(true); this.sock = s; this.chunks = []; this.size = 0; s.on("data", (d) => this._onData(d)); s.on("close", () => this._onClose(s)); resolve(true); });
      s.once("error", () => { clearTimeout(t); resolve(false); });
      s.on("error", () => {});                         // later errors arrive as "close"
    });
  }

  _fail(error, message) { const p = this.pending; this.close(); if (p) p.settle({ ok: false, error, message, delivery: p.sentBytes ? (INPUT_OPS.has(p.op) ? "unknown" : "not_applicable") : "not_delivered" }); }
  _onClose(s) { if (s !== this.sock) return; this._fail("runner_unreachable", "the connection to the runner closed before it answered"); }

  _onData(d) {
    let from = 0, nl;
    while ((nl = d.indexOf(10, from)) !== -1) {
      this.chunks.push(d.subarray(from, nl));
      const line = Buffer.concat(this.chunks).toString("utf8");
      this.chunks = []; this.size = 0; from = nl + 1;
      this._onLine(line);
      if (!this.sock) return;                           // the line ended the connection
    }
    if (from < d.length) { this.chunks.push(d.subarray(from)); this.size += d.length - from; }
    if (this.size > this.maxAnswerBytes) this._fail("runner_protocol", "the runner sent a line longer than the limit");
  }

  _onLine(line) {
    const p = this.pending;
    let msg = null;
    try { msg = JSON.parse(line); } catch { /* handled below */ }
    if (!msg || typeof msg !== "object" || typeof msg.ok !== "boolean") return this._fail("runner_protocol", "the runner sent a line that is not a protocol answer");
    if (!p || (msg.id !== p.id && !(msg.error === "auth" && msg.id === 0))) return this._fail("runner_protocol", "the runner answered a request that is not the current one");
    if (msg.ok) return p.settle({ ok: true, result: msg.result && typeof msg.result === "object" ? msg.result : {} });
    const code = typeof msg.error === "string" && /^[a-z_]{1,40}$/.test(msg.error) ? msg.error : "runner_error";
    const input = INPUT_OPS.has(p.op);
    const delivery = !input ? "not_applicable" : (msg.sent === false || NOTHING_SENT.has(code)) ? "not_delivered" : "unknown";
    if (code === "auth") this.close();
    p.settle({ ok: false, error: code, message: oneLine(msg.message), delivery });
  }

  // → { ok: true, result } | { ok: false, error, message, delivery: "not_delivered" | "unknown" | "not_applicable" }
  async call(op, args = {}, { timeoutMs = 15000 } = {}) {
    if (this.pending) return { ok: false, error: "runner_busy", message: "another runner call is in flight", delivery: "not_delivered" };
    const id = this.nextId++;
    const line = JSON.stringify({ id, token: this.token, op, args }) + "\n";
    if (Buffer.byteLength(line) > MAX_REQUEST_BYTES) return { ok: false, error: "invalid_args", message: "the request is larger than 64 KiB", delivery: "not_delivered" };
    let settle;
    const done = new Promise((resolve) => { settle = resolve; });
    const p = this.pending = { id, op, sentBytes: 0, settle: (v) => { if (this.pending === p) this.pending = null; clearTimeout(p.timer); settle(v); } };
    p.timer = setTimeout(() => {
      const delivery = p.sentBytes ? (INPUT_OPS.has(op) ? "unknown" : "not_applicable") : "not_delivered";
      this.close();                                     // a late answer must not be read as the next call's
      p.settle({ ok: false, error: "ios_timeout", message: `the runner did not answer ${op} in ${timeoutMs} ms`, delivery });
    }, timeoutMs);
    if (!this.sock && !(await this._connect())) { if (this.pending === p) p.settle({ ok: false, error: "runner_unreachable", message: "could not connect to the runner", delivery: "not_delivered" }); return done; }
    if (this.pending !== p) return done;                // timed out while connecting
    p.sentBytes = Buffer.byteLength(line);
    this.sock.write(line);
    return done;
  }
}

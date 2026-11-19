// ios-xcuitest contract tests (0.3.0). CI-safe: no iPhone, no Xcode — a fake runner on 127.0.0.1, a fake
// xcodebuild process and a fake devicectl. They pin down what the Mac side promises: argv-only
// subprocesses, hard time limits, "delivery unknown" instead of a re-send, and fail-closed start-up.
import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import net from "node:net";

const ios = await import("../src/ios-xcuitest.js");
const { RunnerClient, startRunner, devicectl, listDevices, deviceDetails, bindAddressFor, lockState, launchApp, parseDevice,
  runnerEnv, xcodebuildArgv, newToken, pickPort, validUdid, validBundleId, PROTOCOL_VERSION, RUNNER_TEST_ID } = ios;

const UDID = "00008140-001A2B3C4D5E6F70", SIM = "1A2B3C4D-5E6F-4A7B-8C9D-0E1F2A3B4C5D";
let n = 0;
const ok = (cond, name, detail) => { n++; assert.ok(cond, `${name}${detail === undefined ? "" : " | " + JSON.stringify(detail)}`); };

// ---------- a fake runner speaking protocol v1 ----------
const TOKEN = newToken();
const seen = [];
function fakeRunner() {
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => {
      let buf = "";
      sock.on("error", () => {});
      sock.on("data", (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n")) !== -1) {
          const req = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
          seen.push(req.op);
          const send = (o) => sock.write(JSON.stringify({ id: req.id, ...o }) + "\n");
          if (req.token !== TOKEN) { sock.write(JSON.stringify({ id: 0, ok: false, error: "auth" }) + "\n"); sock.end(); return; }
          if (req.op === "ping") send({ ok: true, result: { v: 1, served: seen.length } });
          else if (req.op === "tap" && req.args.refuse) send({ ok: false, error: "app_not_foreground", message: "Settings is not\nin front", sent: false });
          else if (req.op === "tap" && req.args.vague) send({ ok: false, error: "internal", message: "gesture failed", sent: "unknown" });
          else if (req.op === "tap" && req.args.silent) { /* never answers */ }
          else if (req.op === "tap" && req.args.drop) sock.destroy();
          else if (req.op === "tap" && req.args.late) setTimeout(() => { try { send({ ok: true, result: { ms: 1 } }); } catch { /* closed */ } }, 300);
          else if (req.op === "snapshot" && req.args.garbage) sock.write("this is not json\n");
          else if (req.op === "snapshot" && req.args.wrongId) sock.write(JSON.stringify({ id: req.id + 100, ok: true, result: {} }) + "\n");
          else if (req.op === "snapshot" && req.args.huge) sock.write("x".repeat(5000));          // no newline, over the test limit
          else if (req.op === "snapshot" && req.args.hugeLine) send({ ok: true, result: { pad: "x".repeat(5000) } });  // a whole line over it
          else if (req.op === "snapshot" && req.args.split) { const s = JSON.stringify({ id: req.id, ok: true, result: { nodes: [{ label: "设置" }] } }) + "\n"; const b = Buffer.from(s); sock.write(b.subarray(0, 25)); setTimeout(() => sock.write(b.subarray(25)), 30); }
          else if (req.op === "odd") send({ ok: false, error: "Not A Code!", message: "x" });
          else send({ ok: true, result: {} });
        }
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}
const srv = await fakeRunner();
const PORT = srv.address().port;
const client = (extra = {}) => new RunnerClient({ host: "127.0.0.1", port: PORT, token: TOKEN, ...extra });

{
  const c = client();
  const r = await c.call("ping");
  ok(r.ok && r.result.v === 1, "ping answers", r);
  const r2 = await c.call("ping");
  ok(r2.ok && r2.result.served === 2, "the connection is reused for the next call", r2);

  const refused = await c.call("tap", { refuse: true });
  ok(!refused.ok && refused.error === "app_not_foreground" && refused.delivery === "not_delivered" && refused.message === "Settings is not in front", "a refusal keeps its code, is one line, and reads not_delivered", refused);
  const vague = await c.call("tap", { vague: true });
  ok(!vague.ok && vague.error === "internal" && vague.delivery === "unknown", "a failed gesture the runner cannot vouch for reads delivery unknown", vague);
  const odd = await c.call("odd");
  ok(!odd.ok && odd.error === "runner_error" && odd.delivery === "not_applicable", "an error code that is not a code becomes runner_error", odd);

  const split = await c.call("snapshot", { split: true });
  ok(split.ok && split.result.nodes[0].label === "设置", "an answer split across packets (inside a UTF-8 line) is put back together", split);

  const before = seen.length;
  const t0 = Date.now();
  const slow = await c.call("tap", { silent: true }, { timeoutMs: 200 });
  ok(!slow.ok && slow.error === "ios_timeout" && slow.delivery === "unknown" && Date.now() - t0 < 1500, "an input call with no answer times out with delivery unknown", slow);
  ok(seen.length === before + 1, "a timed-out call is not sent again", seen.slice(before));
  ok(c.sock === null, "a timed-out call drops its connection (the runner may still be busy with that command)");
  const after = await c.call("ping");
  ok(after.ok, "the next call works on a fresh connection", after);

  // close() while a call is in flight answers it at once (it used to wait for its own timeout)
  const t1 = Date.now();
  const inflight = c.call("tap", { silent: true }, { timeoutMs: 5000 });
  await new Promise((r) => setTimeout(r, 100));
  c.close();
  const closed = await inflight;
  ok(!closed.ok && closed.error === "runner_unreachable" && closed.delivery === "unknown" && Date.now() - t1 < 1500, "close() answers the call in flight at once, delivery unknown for an input that went out", { closed, ms: Date.now() - t1 });
  ok((await c.call("ping")).ok, "the next call after close() works on a fresh connection");

  const late = await c.call("tap", { late: true }, { timeoutMs: 100 });
  const next = await c.call("ping");
  await new Promise((r) => setTimeout(r, 350));
  ok(late.error === "ios_timeout" && next.ok && next.result.v === 1, "a late answer to a timed-out call is never read as the next call's answer", { late, next });

  const dropped = await c.call("tap", { drop: true });
  ok(!dropped.ok && dropped.error === "runner_unreachable" && dropped.delivery === "unknown", "a connection that closes after the request left reads delivery unknown", dropped);
  const garbage = await c.call("snapshot", { garbage: true });
  ok(!garbage.ok && garbage.error === "runner_protocol" && garbage.delivery === "not_applicable", "a line that is not JSON ends the connection with runner_protocol", garbage);
  const wrongId = await c.call("snapshot", { wrongId: true });
  ok(!wrongId.ok && wrongId.error === "runner_protocol", "an answer with another id is refused", wrongId);

  const small = client({ maxAnswerBytes: 1000 });
  const huge = await small.call("snapshot", { huge: true }, { timeoutMs: 2000 });
  ok(!huge.ok && huge.error === "runner_protocol", "an answer longer than the limit ends the connection", huge);
  small.close();
  const small2 = client({ maxAnswerBytes: 1000 });
  const line = await small2.call("snapshot", { hugeLine: true }, { timeoutMs: 2000 });
  ok(!line.ok && line.error === "runner_protocol", "a whole line longer than the limit, newline and all, ends the connection too", line);
  small2.close();

  const [a, b] = await Promise.all([c.call("tap", { late: true }, { timeoutMs: 2000 }), c.call("ping")]);
  ok(a.ok && !b.ok && b.error === "runner_busy" && b.delivery === "not_delivered", "a second call while one is in flight is refused, not queued behind it", { a, b });

  const big = await c.call("type", { text: "a".repeat(70000) });
  ok(!big.ok && big.error === "invalid_args" && big.delivery === "not_delivered", "a request over 64 KiB is refused before it is sent", big);
  c.close();

  const wrong = new RunnerClient({ host: "127.0.0.1", port: PORT, token: "0".repeat(32) });
  const auth = await wrong.call("tap", { x: 1, y: 1 });
  ok(!auth.ok && auth.error === "auth" && auth.delivery === "not_delivered", "a wrong token reads auth, nothing delivered", auth);
  wrong.close();

  const nobody = new RunnerClient({ host: "127.0.0.1", port: 1, token: TOKEN, connectTimeoutMs: 500 });
  const unreachable = await nobody.call("tap", { x: 1, y: 1 });
  ok(!unreachable.ok && unreachable.error === "runner_unreachable" && unreachable.delivery === "not_delivered", "no listener reads runner_unreachable, nothing delivered", unreachable);
}

// ---------- start-up: argv, environment, ready line ----------
{
  const env = runnerEnv({ token: TOKEN, bind: "fd95:5226:ad71::1", port: 50000 });
  ok(env.TEST_RUNNER_NORACU_TOKEN === TOKEN && env.TEST_RUNNER_NORACU_BIND === "fd95:5226:ad71::1" && env.TEST_RUNNER_NORACU_PORT === "50000", "the runner's values travel in TEST_RUNNER_ environment variables", env);
  assert.throws(() => runnerEnv({ token: "abc", bind: "::1", port: 50000 }), /token/);
  assert.throws(() => runnerEnv({ token: TOKEN, bind: "phone.local", port: 50000 }), /bind/);
  assert.throws(() => runnerEnv({ token: TOKEN, bind: "::1", port: 8100 }), /port/);
  const argv = xcodebuildArgv({ xctestrun: "/tmp/a b/Noracu Runner.xctestrun", udid: UDID });
  ok(argv[2] === "/tmp/a b/Noracu Runner.xctestrun" && argv[4] === `id=${UDID}` && !argv.join(" ").includes(TOKEN), "xcodebuild gets an argv array; a path with spaces stays one argument; the token is not in it", argv);
  const method = RUNNER_TEST_ID.split("/").pop();
  ok(argv[argv.length - 1] === `-only-testing:${RUNNER_TEST_ID}` && /^test[A-Z]\w+$/.test(method) && !["testRun", "testRunClass", "testCaseCount", "testInvocations"].includes(method),
    "xcodebuild is told to run the runner's one test, and its name is not one XCTest already uses (testRun would pass without running)", argv);
  assert.throws(() => xcodebuildArgv({ xctestrun: "relative.xctestrun", udid: UDID }), /absolute/);
  assert.throws(() => xcodebuildArgv({ xctestrun: "/tmp/x.xctestrun", udid: "id; rm -rf ~" }), /udid/);
  ok(validUdid(UDID) && validUdid(SIM) && !validUdid("My iPhone") && !validUdid(""), "udid shapes");
  ok(validBundleId("com.apple.Preferences") && !validBundleId("com.x y") && !validBundleId("--terminate-existing") && !validBundleId(""), "a bundle id cannot be mistaken for an option");
  ok(/^[0-9a-f]{32}$/.test(newToken()) && newToken() !== newToken(), "tokens are 32 hex characters and differ");
  for (let i = 0; i < 50; i++) { const p = pickPort(); assert.ok(p >= 49152 && p <= 65535); }

  const fakeChild = () => { const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.killed = []; c.kill = (s) => { c.killed.push(s); return true; }; return c; };
  const BUILD = ios.runnerBuild();
  ok(/^[0-9a-f]{12}$/.test(BUILD) && BUILD === ios.runnerSourceHash(), "the build the runner's sources name is the hash of those sources — after a change to ios-runner/ run: node scripts/gen-runner-build.mjs", [BUILD, ios.runnerSourceHash()]);
  const start = (script, opts = {}) => {
    const child = fakeChild(); let spawned;
    const p = startRunner({ udid: UDID, xctestrun: "/tmp/r.xctestrun", bind: "127.0.0.1", token: TOKEN, port: 50123, readyTimeoutMs: 400,
      spawnImpl: (file, argv, o) => { spawned = { file, argv, env: o.env, detached: o.detached }; setTimeout(() => script(child), 10); return child; }, env: { PATH: "/usr/bin" }, ...opts });
    return p.then((r) => ({ r, child, spawned }));
  };

  {
    // device run 2026-11-14: right after an iOS update the runner's first start timed out enabling automation mode
    const auto = await start((c) => { c.stdout.emit("data", "2026-11-14 05:37:48.113 xcodebuild[72868:89497040] [MT] IDETestOperations\nNoracuRunnerUITests-Runner (810) encountered an error (The test runner failed to initialize for UI testing. (Underlying Error: Timed out while enabling automation mode.))\n** TEST EXECUTE FAILED **\n"); c.emit("exit", 65); });
    ok(!auto.r.ok && auto.r.error === "runner_start_failed" && /did not turn on UI automation in time/.test(auto.r.message) && /Settings › Developer › Enable UI Automation/.test(auto.r.message),
      "an automation-mode timeout says what to do on the iPhone, not just the start of the log", auto.r.message);
    const other = await start((c) => { c.stdout.emit("data", "noise\nRunner (1) encountered an error (Something failed. (Underlying Error: The device is passcode protected.))\nmore noise\n"); c.emit("exit", 65); });
    ok(!other.r.ok && /before the runner was ready: The device is passcode protected\./.test(other.r.message), "another start failure names XCTest's underlying error", other.r.message);
    ok(ios.startFailureText(70, "a\nb\nlast line") === "xcodebuild ended (exit 70) before the runner was ready: a b last line" || /last line/.test(ios.startFailureText(70, "a\nb\nlast line")), "with nothing to point at, the end of the log", ios.startFailureText(70, "a\nb\nlast line"));
  }

  let s = await start((c) => { c.stdout.emit("data", "Testing started\nNORACU_RUNNER ready v=1 po"); c.stdout.emit("data", `rt=50123 build=${BUILD}\n`); });
  ok(s.r.ok && s.r.port === 50123 && s.spawned.file === "/usr/bin/xcodebuild" && s.spawned.env.TEST_RUNNER_NORACU_TOKEN === TOKEN && s.spawned.env.PATH === "/usr/bin" && s.child.killed.length === 0, "ready line (split across chunks) → a client; xcodebuild by absolute path; token only in the environment", s.r.error);
  s.r.stop();
  ok(s.child.killed[0] === "SIGTERM", "stop() ends xcodebuild");
  ok(s.spawned.detached === true, "xcodebuild is given a process group of its own, whoever spawns it", s.spawned.detached);
  // xcodebuild that has already exited is not signalled when the runner is stopped (or 3 s later)
  s = await start((c) => c.stdout.emit("data", `NORACU_RUNNER ready v=1 port=50123 build=${BUILD}\n`));
  s.child.emit("exit", 0);
  s.r.stop();
  await new Promise((r) => setTimeout(r, 20));
  ok(s.r.ok && s.child.killed.length === 0, "stop() after xcodebuild has exited sends it no signal", s.child.killed);
  s = await start((c) => c.stdout.emit("data", "NORACU_RUNNER ready v=1 port=50123 build=0123456789ab\n"));
  ok(!s.r.ok && s.r.error === "runner_version_mismatch" && s.r.stale === true && /is build 0123456789ab, this noracu's is [0-9a-f]{12} — run the iOS set-up again/.test(s.r.message) && s.child.killed[0] === "SIGTERM", "a runner built from other sources is not used, and is stopped", s.r);
  s = await start((c) => c.stdout.emit("data", "NORACU_RUNNER ready v=1 port=50123\n"));
  ok(!s.r.ok && s.r.error === "runner_version_mismatch" && /names no version/.test(s.r.message), "neither is one that names no build (built before 0.3.0's check)", s.r);
  s = await start(() => {}, { expected: ios.expectedRunnerBuild("/nonexistent/ios-runner") });
  ok(!s.r.ok && s.r.error === "runner_start_failed" && /could not be read/.test(s.r.message) && s.spawned === undefined, "runner sources that cannot be read: nothing is started", s.r);
  s = await start((c) => c.stdout.emit("data", `NORACU_RUNNER ready v=1 port=50123 build=${BUILD.toUpperCase()}X\n`));
  ok(!s.r.ok && s.r.error === "runner_version_mismatch", "a build token of any other shape is a mismatch at once, not a wait for the time limit", s.r);
  {
    // sources changed without their build line: the copy no longer vouches for any runner
    const { cpSync, mkdtempSync, appendFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "noracu-runner-src-"));
    cpSync(ios.RUNNER_DIR, dir, { recursive: true });
    const same = ios.expectedRunnerBuild(dir);
    appendFileSync(join(dir, "NoracuRunnerUITests", "RunnerServer.swift"), "\n// a change\n");
    const changed = ios.expectedRunnerBuild(dir);
    s = await start(() => {}, { expected: changed });
    ok(same.ok && same.build === BUILD && !changed.ok && /changed without their build line/.test(changed.message) && !s.r.ok && s.r.error === "runner_start_failed" && s.spawned === undefined,
      "a change under ios-runner/ without a new build line: no runner is started against those sources", [same, changed, s.r]);
    rmSync(dir, { recursive: true, force: true });
  }

  s = await start((c) => c.stdout.emit("data", "NORACU_RUNNER ready v=1 port=5012"));
  ok(!s.r.ok && s.r.error === "runner_start_timeout" && s.child.killed[0] === "SIGTERM", "a half-received ready line is not acted on; the start times out and xcodebuild is stopped", s.r);
  s = await start((c) => c.stdout.emit("data", "NORACU_RUNNER ready v=2 port=50123\n"));
  ok(!s.r.ok && s.r.error === "runner_version_mismatch" && s.child.killed[0] === "SIGTERM", "another protocol version is refused", s.r);
  s = await start((c) => c.stdout.emit("data", `NORACU_RUNNER ready v=1 port=50999 build=${BUILD}\n`));
  ok(!s.r.ok && s.r.error === "runner_start_failed", "a runner on another port than it was given is refused", s.r);
  s = await start((c) => c.stdout.emit("data", "NORACU_RUNNER error bind_failed\n"));
  ok(!s.r.ok && /bind_failed/.test(s.r.message) && s.child.killed[0] === "SIGTERM", "the runner's own start error is passed on", s.r);
  s = await start((c) => { c.stderr.emit("data", "xcodebuild: error: Unable to find a device\n"); c.emit("exit", 70); });
  ok(!s.r.ok && s.r.error === "runner_start_failed" && /exit 70/.test(s.r.message) && /Unable to find a device/.test(s.r.message), "xcodebuild ending early is reported with its last words", s.r);
  s = await start(() => {}, { xctestrun: "nope" });
  ok(!s.r.ok && s.r.error === "invalid_args" && s.spawned === undefined, "bad arguments never start a process", s.r);
  ok(PROTOCOL_VERSION === 1, "protocol version");
}

// beforeSend: the caller's last look, after the connection is open and right before the command is written — its
// answer stands and nothing is written (a fresh client connects first)
{
  const c = client();
  const n0 = seen.length;
  const stopped = await c.call("tap", { x: 1, y: 1 }, { beforeSend: () => ({ ok: false, error: "user_stopped", message: "stop", delivery: "not_delivered" }) });
  const go = await c.call("ping", {}, { beforeSend: () => null });
  ok(stopped.error === "user_stopped" && stopped.delivery === "not_delivered" && seen.slice(n0).join() === "ping" && go.ok,
    "beforeSend: looked at after connecting, right before the write — its refusal is the answer and nothing is written; null lets the command go", { stopped, seen: seen.slice(n0) });
  c.close();
}

// ---------- devicectl: JSON files only, argv only ----------
{
  const calls = [];
  const fake = (doc, { code = 0, timedOut = false, stderr = "" } = {}) => async (file, argv) => {
    calls.push({ file, argv });
    const out = argv[argv.indexOf("--json-output") + 1];
    if (doc !== undefined) writeFileSync(out, typeof doc === "string" ? doc : JSON.stringify(doc));
    return { code, stdout: "", stderr, timedOut };
  };
  const okDoc = (result) => ({ info: { outcome: "success", jsonVersion: 5 }, result });
  const phone = { connectionProperties: { pairingState: "paired", transportType: "wired", tunnelState: "connected", tunnelIPAddress: "fd95:5226:ad71::1" },
    deviceProperties: { name: "test phone", osVersionNumber: "27.2", developerModeStatus: "enabled", bootState: "booted" },
    hardwareProperties: { udid: UDID, platform: "iOS", reality: "physical", marketingName: "iPhone 16 Pro" } };
  const sim = { connectionProperties: { pairingState: "paired", transportType: "sameMachine", tunnelState: "connected" },
    deviceProperties: { name: "sim", osVersionNumber: "27.2", bootState: "booted" }, hardwareProperties: { udid: SIM, platform: "iOS", reality: "simulated" } };
  const mac = { connectionProperties: { pairingState: "unsupported" }, deviceProperties: {}, hardwareProperties: { platform: "macOS" } };

  const list = await listDevices({ run: fake(okDoc({ devices: [mac, phone, sim] })) });
  ok(list.ok && list.devices.length === 2 && list.devices[0].udid === UDID && list.devices[0].tunnelIP === "fd95:5226:ad71::1" && list.devices[1].simulated, "list devices keeps iOS devices only", list);
  const c0 = calls[0];
  ok(c0.file === "/usr/bin/xcrun" && c0.argv[0] === "devicectl" && c0.argv.includes("--quiet") && c0.argv.includes("--json-output"), "devicectl runs through /usr/bin/xcrun with a JSON output file", c0.argv);

  ok(bindAddressFor(parseDevice(phone)).bind === "fd95:5226:ad71::1" && bindAddressFor(parseDevice(sim)).bind === "127.0.0.1", "bind address: the tunnel address for a phone, loopback for a simulator");
  const not = (patch, re) => { const d = JSON.parse(JSON.stringify(phone)); patch(d); const r = bindAddressFor(parseDevice(d)); ok(!r.ok && r.error === "device_not_ready" && re.test(r.message), `not ready: ${re}`, r); };
  not((d) => { d.connectionProperties.pairingState = "unpaired"; }, /not paired/);
  not((d) => { d.deviceProperties.developerModeStatus = "disabled"; }, /Developer Mode/);
  not((d) => { d.connectionProperties.tunnelState = "disconnected"; }, /tunnel/);
  not((d) => { d.connectionProperties.tunnelIPAddress = "192.168.80.90"; }, /IPv6/);
  not((d) => { d.connectionProperties.tunnelIPAddress = "2001:db8::5"; }, /unique-local/);   // a global address listens beyond the tunnel
  not((d) => { d.connectionProperties.tunnelIPAddress = "fe80::1"; }, /unique-local/);
  ok(bindAddressFor(null).error === "device_not_found", "no device");

  const det = await deviceDetails(UDID, { run: fake(okDoc(phone)) });
  ok(det.ok && det.device.transport === "wired" && det.device.developerMode, "device details", det);
  ok(calls.at(-1).argv.slice(1, 6).join(" ") === `device info details --device ${UDID}`, "details argv", calls.at(-1).argv);

  const unlocked = await lockState(UDID, { run: fake(okDoc({ passcodeRequired: false, unlockedSinceBoot: true })) });
  const locked = await lockState(UDID, { run: fake(okDoc({ passcodeRequired: true, unlockedSinceBoot: true })) });
  const vague = await lockState(UDID, { run: fake(okDoc({ deviceIdentifier: "x" })) });
  ok(unlocked.ok && unlocked.locked === false && locked.ok && locked.locked === true, "lock state", { unlocked, locked });
  ok(!vague.ok && vague.error === "devicectl_failed", "a lock answer without passcodeRequired is a failure, not 'unlocked'", vague);

  const before = calls.length;
  const launched = await launchApp(UDID, "com.apple.Preferences", { run: fake(okDoc({ process: { processIdentifier: 812 }, launchOptions: { activatedWhenStarted: true } })) });
  ok(launched.ok && launched.pid === 812 && launched.activated && !calls.at(-1).argv.includes("--terminate-existing") && calls.at(-1).argv.at(-4) === "com.apple.Preferences", "launch: bundle id is the last devicectl argument before the output options; a running app is not terminated", calls.at(-1).argv);
  const relaunch = await launchApp(UDID, "com.apple.Preferences", { terminateExisting: true, run: fake(okDoc({ process: {} })) });
  ok(relaunch.ok && calls.at(-1).argv.includes("--terminate-existing"), "terminateExisting is explicit");
  const n1 = calls.length;
  const held = await launchApp(UDID, "com.apple.Preferences", { terminateExisting: true, run: fake(okDoc({})), beforeRun: () => ({ ok: false, error: "user_stopped", stopped: "user_stopped: x" }) });
  const heldSim = await ios.simLaunch(SIM, "com.apple.Preferences", { run: fake(undefined), beforeRun: () => ({ ok: false, error: "user_stopped", stopped: "user_stopped: x" }) });
  ok(held.stopped === "user_stopped: x" && heldSim.stopped === "user_stopped: x" && calls.length === n1,
    "beforeRun: looked at right before devicectl / simctl starts (after devicectl's temporary folder is made) — its answer stands and nothing is started", { held, heldSim });
  const n0 = calls.length;
  const badBundle = await launchApp(UDID, "--payload-url=x", { run: fake(okDoc({})) });
  const badUdid = await launchApp("phone; open -a Calculator", "com.apple.Preferences", { run: fake(okDoc({})) });
  const badLock = await lockState("x", { run: fake(okDoc({})) });
  ok(badBundle.error === "invalid_args" && badUdid.error === "invalid_args" && badLock.error === "invalid_args" && calls.length === n0, "an option-shaped bundle id or a strange udid never reaches devicectl", { badBundle, badUdid });
  ok(before < calls.length, "calls were recorded");

  const failed = await devicectl(["device", "info", "lockState", "--device", UDID], { run: fake({ info: { outcome: "failed" }, error: { userInfo: { NSLocalizedDescription: { string: "The device\nis locked." } } } }, { code: 1 }) });
  ok(!failed.ok && failed.error === "devicectl_failed" && failed.message === "The device is locked.", "a devicectl failure carries devicectl's own one-line reason", failed);
  const noFile = await devicectl(["list", "devices"], { run: fake(undefined, { code: 1, stderr: "xcrun: error: unable to find utility \"devicectl\"" }) });
  ok(!noFile.ok && /unable to find utility/.test(noFile.message), "no JSON file (no Xcode) is a failure with the tool's message", noFile);
  const notJson = await devicectl(["list", "devices"], { run: fake("{ not json") });
  ok(!notJson.ok && notJson.error === "devicectl_failed", "a JSON file that is not JSON is a failure", notJson);
  const timeout = await devicectl(["list", "devices"], { run: fake(undefined, { timedOut: true, code: null }) });
  ok(!timeout.ok && timeout.error === "devicectl_timeout", "a devicectl that hangs is a timeout", timeout);
}

// devicectl / simctl calls still running end with the server
{
  const { defaultRun, killPending } = await import("../src/ios-xcuitest.js");
  const t0 = Date.now();
  const p = defaultRun("/bin/sleep", ["30"], { timeoutMs: 60000 });
  await new Promise((r) => setTimeout(r, 100));
  killPending();
  const r = await Promise.race([p, new Promise((res) => setTimeout(() => res({ code: "still running" }), 2000))]);
  ok(r.code !== 0 && r.code !== "still running" && Date.now() - t0 < 2000, "killPending ends a call that is still running", r);
}

{
  // the runner bundle ids an .xctestrun names (ios-setup checks them against the prefix it built for)
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const d = mkdtempSync(join(tmpdir(), "noracu-xctestrun-"));
  const f = join(d, "a.xctestrun");
  writeFileSync(f, `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>TestConfigurations</key><array><dict><key>TestTargets</key><array><dict>\n\t\t\t\t\t<key>TestHostBundleIdentifier</key>\n\t\t\t\t\t<string>dev.noracu.x.runner.xctrunner</string>\n</dict></array></dict></array></dict></plist>\n`);
  const ids = await ios.xctestrunHostIds(f), none = await ios.xctestrunHostIds(join(d, "missing.xctestrun"));
  ok(JSON.stringify(ids) === JSON.stringify(["dev.noracu.x.runner.xctrunner"]) && none === null, "an .xctestrun's runner bundle ids are read; a file that cannot be read gives null", [ids, none]);
  rmSync(d, { recursive: true, force: true });
}

srv.close();
console.log(`ios-xcuitest unit: ${n}/${n} passed`);
process.exit(0);

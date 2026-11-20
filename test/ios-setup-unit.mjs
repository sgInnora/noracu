// `noracu ios-setup` unit tests (0.3.0). CI-safe: no Xcode — a fake device list and a fake xcodebuild.
// They pin down: arguments are checked before anything runs, xcodebuild gets an argv array (team and
// prefix are single arguments), a device is registered only on request, and known signing failures are
// explained in plain words.
import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildArgv, explain, main, parseArgs } from "../src/ios-setup.js";
import * as real from "../src/ios-xcuitest.js";

const UDID = "00008140-001A2B3C4D5E6F70", SIM = "1A2B3C4D-5E6F-4A7B-8C9D-0E1F2A3B4C5D", TEAM = "ABCDE12345";
let n = 0;
const ok = (cond, name, detail) => { n++; assert.ok(cond, `${name}${detail === undefined ? "" : " | " + JSON.stringify(detail)?.slice(0, 600)}`); };
const dev = (o = {}) => ({ udid: UDID, name: "Test iPhone", simulated: false, paired: true, tunnel: true, ...o });

ok(parseArgs(["--team", TEAM, "--udid", UDID, "--bundle-prefix", "com.example.me", "--register-device"]).register === true && parseArgs(["--team", TEAM]).prefix === null, "arguments are read");
ok(/--team must be/.test(parseArgs(["--team", "abc"]).error) && /--team must be/.test(parseArgs(["--team", "ABCDE12345 -allowProvisioningDeviceRegistration"]).error) && /needs a value/.test(parseArgs(["--team"]).error) && /needs a value/.test(parseArgs(["--team", "--udid"]).error) && /--udid is not/.test(parseArgs(["--udid", "id=x"]).error) && /--bundle-prefix must/.test(parseArgs(["--bundle-prefix", "a b"]).error) && /unknown argument/.test(parseArgs(["--force"]).error), "a team, udid or prefix that is not shaped like one is refused, as is any unknown argument");

const d = buildArgv({ project: "/p/NoracuRunner.xcodeproj", udid: UDID, simulated: false, out: "/o ut", team: TEAM, prefix: "dev.noracu.abcde12345", register: false });
ok(d[0] === "build-for-testing" && d.includes("/o ut") && d.includes(`id=${UDID}`) && d.includes(`DEVELOPMENT_TEAM=${TEAM}`) && d.includes("NORACU_BUNDLE_PREFIX=dev.noracu.abcde12345") && d.includes("-allowProvisioningUpdates") && !d.includes("-allowProvisioningDeviceRegistration") && !d.includes("CODE_SIGNING_ALLOWED=NO"), "an iPhone build: signed for the team, a path with a space stays one argument, no device registration unless asked", d);
ok(buildArgv({ udid: UDID, simulated: false, out: "/o", team: TEAM, prefix: "p.q", register: true }).includes("-allowProvisioningDeviceRegistration"), "--register-device adds the registration flag");
const s = buildArgv({ udid: SIM, simulated: true, out: "/o", team: null, prefix: null, register: true });
ok(s.includes("CODE_SIGNING_ALLOWED=NO") && !s.some((a) => /DEVELOPMENT_TEAM|allowProvisioning|NORACU_BUNDLE_PREFIX/.test(a)), "a simulator build is not signed and never talks to the developer service", s);

ok(/accept an updated agreement/.test(explain("error: PLA Update available: You currently don't have access")) && /--register-device/.test(explain("Your team has no devices… Device \"iPhone\" isn't registered in your developer account")) && /Xcode › Settings › Accounts/.test(explain("error: No Account for Team \"ABCDE12345\"")) && /--bundle-prefix/.test(explain("Failed to register bundle identifier: The app identifier \"x\" cannot be registered to your development team because it is not available")) && /Developer Mode/.test(explain("Developer Mode disabled")) && explain("ld: symbol not found") === null, "the usual signing failures are explained; anything else is left to xcodebuild's own lines");

async function run(argv, { devices = [dev()], code = 0, output = "", xctestrun = "/x/Build/Products/a.xctestrun", listOk = true, simOk = true, env = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), "noracu-setup-"));
  const lines = [], spawned = [], asked = { devicectl: 0, simctl: 0 };
  const api = { ...real, XCODEBUILD: "/usr/bin/xcodebuild",
    listDevices: async () => { asked.devicectl++; return listOk ? { ok: true, devices } : { ok: false, error: "devicectl_failed", message: "xcrun: error: unable to find utility devicectl" }; },
    listSimulators: async () => { asked.simctl++; return simOk ? { ok: true, devices: devices.filter((d) => d.simulated) } : { ok: false, error: "simctl_failed", message: "xcrun: error: unable to find utility \"simctl\"" }; },
    findXctestrun: async () => xctestrun };
  const spawnImpl = (file, a, opts) => { spawned.push([file, a, opts]); const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); setImmediate(() => { c.stderr.emit("data", output); c.emit("close", code); }); return c; };
  const rc = await main(argv, { log: (t) => lines.push(t), api, spawnImpl, home, env });
  let mode = null;
  try { mode = statSync(join(home, ".noracu", "ios-runner", devices[0]?.udid || "x")).mode & 0o777; } catch { /* not created */ }
  rmSync(home, { recursive: true, force: true });
  return { rc, text: lines.join("\n"), spawned, mode, home, asked };
}
{
  const r = await run(["--team", TEAM]);
  const a = r.spawned[0];
  ok(r.rc === 0 && r.spawned.length === 1 && a[0] === "/usr/bin/xcodebuild" && a[1].includes(`DEVELOPMENT_TEAM=${TEAM}`) && a[1].includes("NORACU_BUNDLE_PREFIX=dev.noracu.abcde12345") && a[1].includes(join(r.home, ".noracu", "ios-runner", UDID)) && r.mode === 0o700 && /Built: \/x\/Build\/Products\/a\.xctestrun/.test(r.text) && /NORACU_PHONE_BACKEND=xcuitest/.test(r.text), "the one connected iPhone is built for, into a private folder of its own; the answer is the next step", [r.text, a[1]]);
  const custom = mkdtempSync(join(tmpdir(), "noracu-setup-dir-"));
  const elsewhere = await run(["--team", TEAM], { env: { NORACU_IOS_RUNNER_DIR: custom } });
  ok(elsewhere.rc === 0 && elsewhere.spawned[0][1].includes(join(custom, UDID)) && elsewhere.mode === null, "NORACU_IOS_RUNNER_DIR moves the build to the folder the server will look in");
  rmSync(custom, { recursive: true, force: true });
  // a folder of the person's own keeps its mode; the device folder noracu makes in it is private
  const theirs = mkdtempSync(join(tmpdir(), "noracu-setup-theirs-"));
  chmodSync(theirs, 0o755);
  await run(["--team", TEAM], { env: { NORACU_IOS_RUNNER_DIR: theirs } });
  const modes = [statSync(theirs).mode & 0o777, statSync(join(theirs, UDID)).mode & 0o777];
  ok(modes[0] === 0o755 && modes[1] === 0o700, "NORACU_IOS_RUNNER_DIR that is already there keeps its mode; the device folder in it is 0700", modes.map((m) => m.toString(8)));
  rmSync(theirs, { recursive: true, force: true });
  const none = await run(["--team", "nope"]), noteam = await run([]), help = await run(["--help"]);
  ok(none.rc === 2 && noteam.rc === 2 && /must be signed/.test(noteam.text) && help.rc === 0 && /usage: noracu ios-setup/.test(help.text) && none.spawned.length + noteam.spawned.length + help.spawned.length === 0, "bad arguments, a missing team, and --help start no build");
  const two = await run(["--team", TEAM], { devices: [dev(), dev({ udid: "00008150-000A1B2C3D4E5F60", name: "Second" })] });
  const zero = await run(["--team", TEAM], { devices: [dev({ tunnel: false })] });
  const unknown = await run(["--team", TEAM, "--udid", "00008150-000A1B2C3D4E5F60"]);
  ok(two.rc === 1 && /several iPhones/.test(two.text) && two.text.includes("Second") && zero.rc === 1 && /no connected iPhone/.test(zero.text) && unknown.rc === 1 && two.spawned.length + zero.spawned.length + unknown.spawned.length === 0, "several iPhones, none, or an unknown --udid: asked to choose, nothing built", [two.text, zero.text]);
  const simr = await run(["--udid", SIM], { devices: [dev(), dev({ udid: SIM, name: "iPhone 17 Pro", simulated: true })] });
  ok(simr.rc === 0 && simr.spawned[0][1].includes("CODE_SIGNING_ALLOWED=NO") && new RegExp(`NORACU_IOS_UDID=${SIM}`).test(simr.text), "a simulator is built for without a team, and the next step names NORACU_IOS_UDID", simr.text);
  // a simulator is looked up with simctl alone: a devicectl that fails or gives no answer (Xcode 26.6 on a CI runner) is not asked
  const simOnly = await run(["--udid", SIM], { devices: [dev(), dev({ udid: SIM, name: "iPhone 17 Pro", simulated: true })], listOk: false });
  ok(simOnly.rc === 0 && simOnly.asked.devicectl === 0 && simOnly.asked.simctl === 1 && simOnly.spawned[0][1].includes(`id=${SIM}`) && simOnly.spawned[0][1].includes("CODE_SIGNING_ALLOWED=NO"),
    "a simulator named with --udid is found with simctl and built for while devicectl does not work — devicectl is not asked", [simOnly.text, simOnly.asked]);
  const simGone = await run(["--udid", "2B3C4D5E-6F70-4182-9DA4-B5C6D7E8F901"]);
  const simDown = await run(["--udid", SIM], { devices: [dev({ udid: SIM, simulated: true })], simOk: false });
  ok(simGone.rc === 1 && /does not list the simulator named with --udid/.test(simGone.text) && simDown.rc === 1 && /could not list simulators \(xcrun: error: unable to find utility "simctl"\)/.test(simDown.text)
    && simGone.spawned.length + simDown.spawned.length === 0 && simGone.asked.devicectl + simDown.asked.devicectl === 0,
    "a simulator simctl does not list, or a simctl that fails: said so, nothing built, devicectl not asked", [simGone.text, simDown.text]);
  ok(unknown.asked.devicectl === 1 && unknown.asked.simctl === 0 && two.asked.simctl === 0, "an iPhone is still looked up with devicectl, and simctl is not asked", [unknown.asked, two.asked]);
  const failed = await run(["--team", TEAM], { code: 65, output: "note: x\nerror: No Account for Team \"ABCDE12345\". Add a new account in Accounts settings\n** TEST BUILD FAILED **\n", xctestrun: null });
  ok(failed.rc === 1 && /the build failed: Xcode has no account or certificate for team ABCDE12345/.test(failed.text) && /TEST BUILD FAILED/.test(failed.text), "a failed build: the likely reason in plain words, then xcodebuild's last lines", failed.text);
  const stale = await run(["--team", TEAM], { code: 0, xctestrun: null });
  const nolist = await run(["--team", TEAM], { listOk: false });
  ok(stale.rc === 1 && nolist.rc === 1 && /is Xcode installed/.test(nolist.text) && nolist.spawned.length === 0, "a build that leaves no .xctestrun is a failure; no devicectl means no build");
}
{
  // a build that ends leaves no timer behind: the 15-minute limit is cleared (it once was not, and kept the process alive)
  const home = mkdtempSync(join(tmpdir(), "noracu-setup-"));
  const api = { ...real, XCODEBUILD: "/usr/bin/xcodebuild", listDevices: async () => ({ ok: true, devices: [dev()] }), findXctestrun: async () => "/x/a.xctestrun" };
  const spawnImpl = () => { const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => {}; setImmediate(() => c.emit("close", 0)); return c; };
  const rc = await main(["--team", TEAM], { log: () => {}, api, spawnImpl, home });
  ok(rc === 0 && !process.getActiveResourcesInfo().includes("Timeout"), "a build that ends leaves no timer running", process.getActiveResourcesInfo());
  rmSync(home, { recursive: true, force: true });
}
{
  // a build that never ends: stopped after the timeout, with the last lines and a hint at a prompt
  const home = mkdtempSync(join(tmpdir(), "noracu-setup-"));
  const lines = [], kills = [];
  const api = { ...real, XCODEBUILD: "/usr/bin/xcodebuild", listDevices: async () => ({ ok: true, devices: [dev()] }), findXctestrun: async () => "/x/a.xctestrun" };
  const spawnImpl = () => { const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = (sig) => { kills.push(sig); if (sig === "SIGKILL") setImmediate(() => c.emit("close", null)); }; return c; };   // ignores SIGTERM, ends on SIGKILL
  const p = main(["--team", TEAM], { log: (t) => lines.push(t), api, spawnImpl, home, buildTimeoutMs: 50, killGraceMs: 30 });
  const rc = await Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("ios-setup timeout test hung")), 2000))]);
  ok(rc === 1 && /did not finish/.test(lines.join("\n")) && kills.join() === "SIGTERM,SIGKILL", "a build that does not finish in time gets SIGTERM, then SIGKILL, and the answer waits for it to be gone", { rc, text: lines.join("\n"), kills });
  rmSync(home, { recursive: true, force: true });
}
{
  // Ctrl-C while building: the group is told to end, the exit code is 130, and nothing says the build failed
  const home = mkdtempSync(join(tmpdir(), "noracu-setup-"));
  const lines = [], kills = [], exits = [];
  const api = { ...real, XCODEBUILD: "/usr/bin/xcodebuild", listDevices: async () => ({ ok: true, devices: [dev()] }), findXctestrun: async () => "/x/a.xctestrun" };
  const spawnImpl = () => { const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = (sig) => { kills.push(sig); setImmediate(() => c.emit("close", null)); }; return c; };   // ends on SIGTERM
  const before = process.listenerCount("SIGINT");
  const p = main(["--team", TEAM], { log: (t) => lines.push(t), api, spawnImpl, home, exit: (code) => exits.push(code) });
  for (let i = 0; i < 100 && process.listenerCount("SIGINT") === before; i++) await new Promise((r) => setTimeout(r, 10));
  process.emit("SIGINT");
  const rc = await Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("ios-setup Ctrl-C test hung")), 2000))]);
  ok(rc === 130 && exits.join() === "130" && kills[0] === "SIGTERM" && !/build failed|could not be run/.test(lines.join("\n")) && process.listenerCount("SIGINT") === before,
    "Ctrl-C during the build: xcodebuild is told to end, the exit code is 130, and nothing says the build failed", { rc, exits, kills, text: lines.join("\n").slice(0, 200) });
  await new Promise((r) => setTimeout(r, 1200));
  ok(kills.join() === "SIGTERM", "once xcodebuild is gone no SIGKILL follows a second later", kills);
  rmSync(home, { recursive: true, force: true });
  // a build that does not end on SIGTERM, and Ctrl-C pressed twice: the handler is still there for the second
  // one (it does not end this process), and the SIGKILL goes out a second after the first
  {
    const home2 = mkdtempSync(join(tmpdir(), "noracu-setup-")), kills2 = [], exits2 = [];
    const stubborn = () => { const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = (sig) => { kills2.push(sig); if (sig === "SIGKILL") setImmediate(() => c.emit("close", null)); }; return c; };
    const before2 = process.listenerCount("SIGINT");
    const p2 = main(["--team", TEAM], { log: () => {}, api, spawnImpl: stubborn, home: home2, exit: (code) => exits2.push(code) });
    for (let i = 0; i < 100 && process.listenerCount("SIGINT") === before2; i++) await new Promise((r) => setTimeout(r, 10));
    process.emit("SIGINT", "SIGINT");
    const held = process.listenerCount("SIGINT") > before2;
    process.emit("SIGINT", "SIGINT");
    const rc2 = await Promise.race([p2, new Promise((_, rej) => setTimeout(() => rej(new Error("ios-setup second Ctrl-C test hung")), 4000))]);
    ok(held && rc2 === 130 && kills2.join() === "SIGTERM,SIGKILL" && process.listenerCount("SIGINT") === before2,
      "Ctrl-C twice on a build that ignores SIGTERM: the handler is still in place for the second one, and SIGKILL follows", { held, rc2, kills2 });
    const kills3 = [], exits3 = [];
    const quick = () => { const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = (sig) => { kills3.push(sig); setImmediate(() => c.emit("close", null)); }; return c; };
    const before3 = process.listenerCount("SIGTERM");
    const p3 = main(["--team", TEAM], { log: () => {}, api, spawnImpl: quick, home: home2, exit: (code) => exits3.push(code) });
    for (let i = 0; i < 100 && process.listenerCount("SIGTERM") === before3; i++) await new Promise((r) => setTimeout(r, 10));
    process.emit("SIGTERM", "SIGTERM");
    const rc3 = await Promise.race([p3, new Promise((_, rej) => setTimeout(() => rej(new Error("ios-setup SIGTERM test hung")), 3000))]);
    ok(rc3 === 143 && exits3.join() === "143" && kills3[0] === "SIGTERM", "SIGTERM during the build: the exit code is 143, not Ctrl-C's 130", { rc3, exits3, kills3 });
    // the handlers are off before exit is called
    const seen = [];
    const before4 = process.listenerCount("SIGINT");
    const p4 = main(["--team", TEAM], { log: () => {}, api, spawnImpl: quick, home: home2, exit: () => seen.push(process.listenerCount("SIGINT")) });
    for (let i = 0; i < 100 && process.listenerCount("SIGINT") === before4; i++) await new Promise((r) => setTimeout(r, 10));
    process.emit("SIGINT", "SIGINT");
    await Promise.race([p4, new Promise((_, rej) => setTimeout(() => rej(new Error("ios-setup exit-order test hung")), 3000))]);
    ok(seen.length === 1 && seen[0] === before4, "Ctrl-C: the signal handlers are taken off before exit is called", { seen, before4 });
    rmSync(home2, { recursive: true, force: true });
  }
}
{
  // a build for another bundle prefix in the same folder is removed first; the build must name a runner under the
  // prefix asked for (device run 2026-11-13: after a prefix change the old runner was still the one named)
  const home = mkdtempSync(join(tmpdir(), "noracu-setup-"));
  const out = join(home, ".noracu", "ios-runner", UDID), stamp = join(out, "noracu-setup.json"), marker = join(out, "Build", "old");
  const PREFIX = "dev.noracu.abcde12345";
  let hosts = [`${PREFIX}.runner.xctrunner`];
  const api = { ...real, XCODEBUILD: "/usr/bin/xcodebuild", listDevices: async () => ({ ok: true, devices: [dev()] }), findXctestrun: async () => "/x/a.xctestrun", xctestrunHostIds: async () => hosts };
  const spawnImpl = () => { const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); setImmediate(() => c.emit("close", 0)); return c; };
  const go = async (argv = ["--team", TEAM]) => { const lines = []; const rc = await main(argv, { log: (t) => lines.push(t), api, spawnImpl, home }); return { rc, text: lines.join("\n") }; };
  const seed = (prefix) => { mkdirSync(join(out, "Build"), { recursive: true }); writeFileSync(marker, "x"); if (prefix) writeFileSync(stamp, JSON.stringify({ prefix })); else rmSync(stamp, { force: true }); };
  seed("com.other.prefix");
  const changed = await go();
  ok(changed.rc === 0 && !existsSync(marker) && /Removed the earlier build .*for bundle prefix com\.other\.prefix/.test(changed.text) && JSON.parse(readFileSync(stamp, "utf8")).prefix === PREFIX && (statSync(stamp).mode & 0o777) === 0o600,
    "a build for another prefix is removed before building, and the prefix built for is recorded", changed.text);
  seed(PREFIX);
  const same = await go();
  ok(same.rc === 0 && existsSync(marker) && !/Removed/.test(same.text), "the same prefix again: the earlier build is kept (an incremental build)", same.text);
  seed(null);
  const unknown = await go();
  ok(unknown.rc === 0 && !existsSync(marker) && /before this version recorded its bundle prefix/.test(unknown.text), "a build from before the prefix was recorded is removed too", unknown.text);
  seed(PREFIX); hosts = ["com.other.prefix.runner.xctrunner"];
  const wrong = await go();
  ok(wrong.rc === 1 && /names a runner with another bundle id \(com\.other\.prefix\.runner\.xctrunner\), not one under dev\.noracu\.abcde12345/.test(wrong.text) && !/Built:/.test(wrong.text), "a build that still names a runner under another prefix is a failure, not 'Built'", wrong.text);
  hosts = null;
  const unread = await go();
  ok(unread.rc === 0 && /Built:/.test(unread.text) && /Not checked: no runner bundle id could be read from \/x\/a\.xctestrun, so whether it is one under dev\.noracu\.abcde12345 is not known/.test(unread.text), "an .xctestrun that cannot be read back is not taken for a wrong one, and the answer says the bundle id was not checked", unread.text);
  hosts = [];
  const none = await go();
  ok(none.rc === 0 && /Not checked: no runner bundle id/.test(none.text), "an .xctestrun that names no runner bundle id: the answer says it was not checked", none.text);
  hosts = [`${PREFIX}.runner.xctrunner`];
  const good = await go();
  ok(good.rc === 0 && !/Not checked/.test(good.text), "a runner under the prefix asked for: no 'not checked' note", good.text);
  rmSync(home, { recursive: true, force: true });
}

// a locked keychain is not a locked iPhone
ok(/keychain is locked/.test(explain("error: The keychain /Users/me/Library/Keychains/login.keychain-db is locked.")) && !/unlock the iPhone/.test(explain("error: The keychain /Users/me/Library/Keychains/login.keychain-db is locked.")) && /keychain is locked/.test(explain("codesign: errSecInteractionNotAllowed")) && /unlock the iPhone/.test(explain("error: Someone's iPhone is locked.")),
  "explain: a locked keychain is told apart from a locked iPhone", [explain("error: The keychain /Users/me/Library/Keychains/login.keychain-db is locked."), explain("error: Someone's iPhone is locked.")]);

// a prefix with an empty part (a dot at the end, two dots in a row) would make a bundle identifier Xcode refuses
ok(["com.example.", "com..example", ".com.example"].every((p) => /--bundle-prefix must look/.test(parseArgs(["--team", TEAM, "--bundle-prefix", p]).error || "")) && ["com.example.me", "a-b.c9", "abc"].every((p) => parseArgs(["--team", TEAM, "--bundle-prefix", p]).prefix === p),
  "--bundle-prefix: an empty part between dots is refused", ["com.example.", "com..example"].map((p) => parseArgs(["--team", TEAM, "--bundle-prefix", p])));

// xcodebuild ended by a signal that did not come from this command: not "could not be run — is Xcode installed?"
{
  const home = mkdtempSync(join(tmpdir(), "noracu-setup-"));
  const lines = [];
  const api = { ...real, XCODEBUILD: "/usr/bin/xcodebuild", listDevices: async () => ({ ok: true, devices: [dev()] }), findXctestrun: async () => null };
  const spawnImpl = () => { const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => {}; setImmediate(() => { c.stderr.emit("data", "CompileSwift normal arm64\n"); c.emit("close", null, "SIGKILL"); }); return c; };
  const rc = await main(["--team", TEAM], { log: (t) => lines.push(t), api, spawnImpl, home });
  rmSync(home, { recursive: true, force: true });
  ok(rc === 1 && /ended by SIGKILL/.test(lines.join("\n")) && !/is Xcode installed|could not be run/.test(lines.join("\n")), "xcodebuild killed from outside: the message says so", lines);
}

console.log(`ios-setup unit: ${n}/${n} passed`);

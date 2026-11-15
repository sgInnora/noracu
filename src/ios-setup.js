// ios-setup — `noracu ios-setup`: build the on-device runner for one iPhone or simulator (0.3.0, EXPERIMENTAL).
//
// An explicit command; nothing runs on install. It uses Apple's own tools on this Mac:
//   xcrun devicectl list devices      which device
//   xcodebuild build-for-testing      the runner in ios-runner/, into ~/.noracu/ios-runner/<udid>
// For an iPhone the build is signed for the developer team given with --team, and Xcode may create or
// update a development provisioning profile in that team (-allowProvisioningUpdates talks to Apple's
// developer service — the one step of this backend that leaves the Mac, and only when you run this
// command). A device is registered in the team only with --register-device. A simulator build is not signed.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as iosApi from "./ios-xcuitest.js";

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), "..", "ios-runner", "NoracuRunner.xcodeproj");
export const USAGE = `usage: noracu ios-setup --team <TeamID> [--udid <udid>] [--bundle-prefix <prefix>] [--register-device]
       noracu ios-setup --udid <simulator udid>

Builds noracu's on-device runner (a UI-test bundle, source in ios-runner/) for one device and leaves it in
~/.noracu/ios-runner/<udid>. Then start the MCP server with NORACU_PHONE_BACKEND=xcuitest.

  --team <TeamID>          your Apple developer team (10 characters); needed for an iPhone, not for a simulator
  --udid <udid>            the device; may be left out when exactly one iPhone is connected
  --bundle-prefix <p>      bundle identifier prefix for the runner (default: dev.noracu.<teamid>)
  --register-device        let Xcode register this iPhone in the team if it is not registered yet`;

const TEAM_RE = /^[A-Z0-9]{10}$/, PREFIX_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{2,100}$/;

export function parseArgs(argv) {
  const o = { team: null, udid: null, prefix: null, register: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") o.help = true;
    else if (a === "--register-device") o.register = true;
    else if (a === "--team" || a === "--udid" || a === "--bundle-prefix") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) return { error: `${a} needs a value` };
      o[a === "--team" ? "team" : a === "--udid" ? "udid" : "prefix"] = v;
    } else return { error: `unknown argument ${JSON.stringify(a.slice(0, 40))}` };
  }
  if (o.team !== null && !TEAM_RE.test(o.team)) return { error: "--team must be a 10-character team identifier (letters and digits, as shown in your Apple developer account)" };
  if (o.udid !== null && !iosApi.validUdid(o.udid)) return { error: "--udid is not a device identifier" };
  if (o.prefix !== null && !PREFIX_RE.test(o.prefix)) return { error: "--bundle-prefix must look like a bundle identifier prefix (letters, digits, dots, hyphens)" };
  return o;
}

// Every value is an argument of its own: nothing is put into a shell line.
export function buildArgv({ project = PROJECT, udid, simulated, out, team, prefix, register }) {
  const argv = ["build-for-testing", "-project", project, "-scheme", "NoracuRunner", "-destination", `id=${udid}`, "-derivedDataPath", out];
  if (simulated) argv.push("CODE_SIGNING_ALLOWED=NO");
  else argv.push(`DEVELOPMENT_TEAM=${team}`, `NORACU_BUNDLE_PREFIX=${prefix}`, "-allowProvisioningUpdates", ...(register ? ["-allowProvisioningDeviceRegistration"] : []));
  return argv;
}

// What a failed build most likely means, from xcodebuild's own words.
export function explain(output, team = "your team") {
  const t = String(output || "");
  if (/Program License Agreement|PLA Update available|agree to the latest/i.test(t)) return "Apple asks the account holder of the team to accept an updated agreement: sign in at developer.apple.com/account, accept it, then run this again.";
  if (/cannot be registered to your development team|Failed to register bundle identifier|app identifier .{0,80}not available/i.test(t)) return "the runner's bundle identifier is taken by another team: pass --bundle-prefix with a prefix of your own.";
  if (/isn.t registered|is not registered|doesn.t include the currently selected device|Device .{0,80}isn.t included/i.test(t)) return `this iPhone is not registered in ${team}: run again with --register-device (it adds the device to the team), or register it at developer.apple.com.`;
  if (/No Account for Team|No profiles for|requires a development team|no signing certificate|Signing for .{0,80}requires/i.test(t)) return `Xcode has no account or certificate for ${team}: open Xcode › Settings › Accounts, sign in, then run this again.`;
  if (/Developer Mode/i.test(t)) return "turn on Developer Mode on the iPhone (Settings › Privacy & Security › Developer Mode), then run this again.";
  if (/device is locked|unlock the device|is locked/i.test(t)) return "unlock the iPhone and run this again.";
  return null;
}

export const BUILD_TIMEOUT_MS = 15 * 60 * 1000;

// xcodebuild runs in a process group of its own, so the compilers it starts end with it. On the time limit the
// group gets SIGTERM, after killGraceMs SIGKILL, and the answer waits for xcodebuild to be gone (at most
// killGraceMs more). Ctrl-C on this command ends the group too.
function run(file, argv, spawnImpl, timeoutMs, killGraceMs = 3000, exit = (code) => process.exit(code)) {
  return new Promise((resolve) => {
    let out = "", child, settled = false, timer = null, sigTimer = null, timedOut = false, signalled = false;
    const signal = (sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* already gone */ } } };
    // Ctrl-C: the group is told to end and this command exits with 130 once xcodebuild is gone, a second later at the latest
    const interrupted = () => { if (settled) return; exit(130); done({ code: null, out, signalled: true }); };
    const onSignal = () => { if (signalled) return; signalled = true; signal("SIGTERM"); sigTimer = setTimeout(() => { signal("SIGKILL"); interrupted(); }, 1000); sigTimer.unref?.(); };
    const done = (v) => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(sigTimer); process.removeListener("SIGINT", onSignal); process.removeListener("SIGTERM", onSignal); resolve(v); };
    try { child = spawnImpl(file, argv, { stdio: ["ignore", "pipe", "pipe"], detached: true }); } catch (e) { return done({ code: null, out: String(e && e.message) }); }
    process.once("SIGINT", onSignal); process.once("SIGTERM", onSignal);
    timer = setTimeout(() => {
      timedOut = true;
      signal("SIGTERM");
      timer = setTimeout(() => { signal("SIGKILL"); timer = setTimeout(() => done({ code: null, out, timedOut: true }), killGraceMs); }, killGraceMs);
    }, timeoutMs);
    const add = (d) => { out = (out + String(d)).slice(-200000); };
    child.stdout?.on("data", add); child.stderr?.on("data", add);
    child.on("error", (e) => done({ code: null, out: String(e && e.message) }));
    child.on("close", (code) => (signalled ? interrupted() : done(timedOut ? { code: null, out, timedOut: true } : { code, out })));
  });
}

// → the process exit code
export async function main(argv, { log = (s) => process.stdout.write(s + "\n"), api = iosApi, spawnImpl = spawn, home = homedir(), env = process.env, buildTimeoutMs = BUILD_TIMEOUT_MS, killGraceMs = 3000, exit = (code) => process.exit(code) } = {}) {
  const o = parseArgs(argv);
  if (o.error) { log(`noracu ios-setup: ${o.error}\n\n${USAGE}`); return 2; }
  if (o.help) { log(USAGE); return 0; }
  const list = await api.listDevices();
  if (!list.ok) { log(`noracu ios-setup: could not list devices (${list.message}) — is Xcode installed?`); return 1; }
  let device;
  if (o.udid) {
    device = list.devices.find((d) => d.udid.toLowerCase() === o.udid.toLowerCase());
    if (!device) { log("noracu ios-setup: this Mac does not list the device named with --udid"); return 1; }
  } else {
    const phones = list.devices.filter((d) => !d.simulated && d.paired && d.tunnel);
    if (phones.length !== 1) { log(`noracu ios-setup: ${phones.length ? "several iPhones are connected" : "no connected iPhone found"} — name the device with --udid${phones.length ? ": " + phones.map((d) => `${d.udid} (${d.name})`).join(", ") : ""}`); return 1; }
    device = phones[0];
  }
  if (!device.simulated && !o.team) { log(`noracu ios-setup: an iPhone build must be signed — pass --team <TeamID>\n\n${USAGE}`); return 2; }
  const prefix = o.prefix || (o.team ? `dev.noracu.${o.team.toLowerCase()}` : null);
  // the same place the server looks in (NORACU_IOS_RUNNER_DIR, default ~/.noracu/ios-runner)
  const root = join(home, ".noracu"), base = env.NORACU_IOS_RUNNER_DIR || join(root, "ios-runner"), out = join(base, device.udid);
  for (const d of env.NORACU_IOS_RUNNER_DIR ? [base, out] : [root, base, out]) { mkdirSync(d, { recursive: true, mode: 0o700 }); try { chmodSync(d, 0o700); } catch { /* not ours to change */ } }
  // A build for another bundle prefix in the same folder leaves products the next build can keep: the runner it names
  // then still carries the old bundle id, and the server starts an old runner (device run 2026-11-13). When the prefix
  // changes — or a folder from before this check holds a build of unknown prefix — the earlier build is removed first.
  const stampPath = join(out, "noracu-setup.json"), want = device.simulated ? "(simulator)" : prefix;
  let prev = null;
  try { prev = JSON.parse(readFileSync(stampPath, "utf8")); } catch { /* none yet */ }
  if (prev ? prev.prefix !== want : existsSync(join(out, "Build"))) {
    rmSync(join(out, "Build"), { recursive: true, force: true });
    try { rmSync(stampPath, { force: true }); } catch { /* gone */ }
    log(`Removed the earlier build in ${out}: it was made ${prev ? `for bundle prefix ${prev.prefix}` : "before this version recorded its bundle prefix"}.`);
  }
  log(`Building the runner for ${device.name || device.udid}${device.simulated ? " (simulator)" : ` (team ${o.team}, bundle prefix ${prefix})`} — this takes a minute or two…`);
  const r = await run(api.XCODEBUILD, buildArgv({ udid: device.udid, simulated: device.simulated, out, team: o.team, prefix, register: o.register }), spawnImpl, buildTimeoutMs, killGraceMs, exit);
  if (r.signalled) return 130;   // Ctrl-C: not a failed build
  if (r.timedOut) {
    log(`noracu ios-setup: the build did not finish in ${Math.round(buildTimeoutMs / 60000)} min and was stopped — a signing or keychain prompt may be waiting on this Mac's screen; answer it and run the command again.\n--- last lines of xcodebuild ---\n${r.out.trim().split("\n").slice(-15).join("\n")}`);
    return 1;
  }
  const xctestrun = r.code === 0 ? await api.findXctestrun(out) : null;
  if (!xctestrun) {
    const why = r.code === null ? `xcodebuild could not be run (${r.out.slice(0, 200)}) — is Xcode installed?` : explain(r.out, o.team ? `team ${o.team}` : "your team");
    log(`noracu ios-setup: the build failed${why ? `: ${why}` : "."}\n--- last lines of xcodebuild ---\n${r.out.trim().split("\n").slice(-15).join("\n")}`);
    return 1;
  }
  let unchecked = "";
  if (!device.simulated) {
    // the build must name a runner under this prefix — never report an older runner as built
    const hosts = await (api.xctestrunHostIds || iosApi.xctestrunHostIds)(xctestrun);
    if (!hosts || !hosts.length) unchecked = `\nNot checked: no runner bundle id could be read from ${xctestrun}, so whether it is one under ${prefix} is not known.`;
    const other = (hosts || []).filter((h) => !h.startsWith(`${prefix}.`));
    if (other.length) {
      log(`noracu ios-setup: the build names a runner with another bundle id (${other.join(", ")}), not one under ${prefix} — remove ${join(out, "Build")} and run this again.`);
      return 1;
    }
  }
  try { writeFileSync(stampPath, JSON.stringify({ prefix: want, built: new Date().toISOString() }) + "\n", { mode: 0o600 }); } catch { /* the next build cleans up instead */ }
  log(`Built: ${xctestrun}${unchecked}\nNext: start the MCP server with NORACU_PHONE_BACKEND=xcuitest${o.udid ? ` and NORACU_IOS_UDID=${device.udid}` : ""} in its environment, keep the iPhone unlocked, and call ios_status.`);
  return 0;
}

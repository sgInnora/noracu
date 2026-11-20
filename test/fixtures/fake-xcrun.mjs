#!/usr/bin/env node
// A stand-in for /usr/bin/xcrun in test/ios-e2e.mjs (NORACU_IOS_XCRUN): the devicectl and simctl calls
// noracu makes, answered from files in NORACU_FAKE_IOS_DIR. Every call's argv is appended to xcrun.log.
//   devices.json   the devices `devicectl list devices` reports (devicectl's own JSON shape); `simctl list --json`
//                  reports the simulators among them, in simctl's shape
//   devicectl      "hang": every devicectl call waits until it is killed, as devicectl did on a CI runner
//   lock           "locked" | "missing" (no passcodeRequired in the answer) | "fail"; absent = unlocked
//   launches.log   one JSON line per app launch — the fake runner (fake-xcodebuild.mjs) applies them
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.NORACU_FAKE_IOS_DIR;
const argv = process.argv.slice(2);
if (!dir) { process.stderr.write("fake-xcrun: NORACU_FAKE_IOS_DIR is not set\n"); process.exit(64); }
appendFileSync(join(dir, "xcrun.log"), JSON.stringify(argv) + "\n");
const read = (name, fallback) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8").trim() : fallback);
const devices = JSON.parse(read("devices.json", "[]"));
const INSTALLED = new Set(["com.apple.springboard", "com.apple.Preferences", "com.example.slow", "com.example.stuck"]);

if (argv[0] === "simctl" && argv[1] === "launch") {
  const rest = argv.slice(2).filter((a) => a !== "--terminate-running-process");
  const [, bundle] = rest;
  if (!INSTALLED.has(bundle)) { process.stderr.write("An error was encountered processing the command (domain=FBSOpenApplicationServiceErrorDomain, code=4): not installed\n"); process.exit(4); }
  appendFileSync(join(dir, "launches.log"), JSON.stringify({ bundle, terminate: argv.includes("--terminate-running-process"), via: "simctl" }) + "\n");
  process.stdout.write(`${bundle}: 4242\n`);
  process.exit(0);
}

if (argv[0] === "simctl" && argv[1] === "list" && argv[2] === "--json") {
  const doc = { devicetypes: [], runtimes: [], devices: {} };
  for (const d of devices.filter((x) => x.hardwareProperties?.reality === "simulated")) {
    const os = d.deviceProperties?.osVersionNumber || "26.5", model = d.hardwareProperties.marketingName || "iPhone";
    const rt = `com.apple.CoreSimulator.SimRuntime.iOS-${os.replace(/\./g, "-")}`, type = `com.apple.CoreSimulator.SimDeviceType.${model.replace(/ /g, "-")}`;
    if (!doc.runtimes.some((r) => r.identifier === rt)) doc.runtimes.push({ identifier: rt, platform: "iOS", version: os, isAvailable: true });
    if (!doc.devicetypes.some((t) => t.identifier === type)) doc.devicetypes.push({ identifier: type, name: model });
    (doc.devices[rt] ||= []).push({ udid: d.hardwareProperties.udid, name: d.deviceProperties?.name || model, state: d.deviceProperties?.bootState === "booted" ? "Booted" : "Shutdown", isAvailable: true, deviceTypeIdentifier: type });
  }
  process.stdout.write(JSON.stringify(doc));
  process.exit(0);
}

if (argv[0] !== "devicectl") { process.stderr.write(`fake-xcrun: unexpected ${argv[0]}\n`); process.exit(64); }
if (read("devicectl", "") === "hang") { setInterval(() => {}, 1 << 30); await new Promise(() => {}); }
const out = argv[argv.indexOf("--json-output") + 1];
const answer = (result) => { writeFileSync(out, JSON.stringify({ info: { outcome: "success" }, result })); process.exit(0); };
const fail = (text) => { writeFileSync(out, JSON.stringify({ info: { outcome: "failed" }, error: { userInfo: { NSLocalizedDescription: { string: text } } } })); process.exit(1); };
const udid = argv[argv.indexOf("--device") + 1];
const device = devices.find((d) => d.hardwareProperties?.udid === udid);
const cmd = argv.slice(1, 4).join(" ");

if (cmd.startsWith("list devices")) answer({ devices });
if (!device) fail(`No device found with identifier ${udid}`);
if (cmd === "device info details") answer(device);
if (cmd === "device info lockState") {
  const lock = read("lock", "");
  if (lock === "fail") fail("The device is not connected");
  answer(lock === "missing" ? { unlockedSinceBoot: true } : { passcodeRequired: lock === "locked", unlockedSinceBoot: true });
}
if (cmd === "device process launch") {
  const bundle = argv[argv.indexOf("--quiet") - 1];   // devicectl ... launch --device <udid> [--terminate-existing] <bundle> --quiet --json-output <file>
  if (!INSTALLED.has(bundle)) fail("The application is not installed");
  appendFileSync(join(dir, "launches.log"), JSON.stringify({ bundle, terminate: argv.includes("--terminate-existing"), via: "devicectl" }) + "\n");
  answer({ process: { processIdentifier: 4242 }, launchOptions: { activatedWhenStarted: true } });
}
fail(`fake-xcrun: unexpected devicectl ${cmd}`);

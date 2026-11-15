#!/usr/bin/env node
// A stand-in for /usr/bin/xcodebuild in test/ios-e2e.mjs (NORACU_IOS_XCODEBUILD): it plays
// `xcodebuild test-without-building` with the runner inside — a TCP line server speaking protocol v1
// (docs/ios-runner-protocol.md) over the model phone of fake-ios.mjs. Files in NORACU_FAKE_IOS_DIR:
//   xcodebuild.log  one JSON line per start: { argv, bind, port, token_ok, pid } (never the token itself)
//   runner-mode     "error" (prints a start-up error and exits) | "silent" (never ready) | "v2" | "stale" (names another build) | "stale-once" (the first start only); absent = normal
//   launches.log    app launches made through fake-xcrun.mjs, applied before each command
//   control.jsonl   test controls applied before each command: {"set":{"scroll":40}} or {"handle":["home",{}]}
//   runner.log      one line per op the phone received
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { makePhone } from "./fake-ios.mjs";
import { runnerBuild } from "../../src/ios-xcuitest.js";

const dir = process.env.NORACU_FAKE_IOS_DIR;
const token = process.env.TEST_RUNNER_NORACU_TOKEN || "", bind = process.env.TEST_RUNNER_NORACU_BIND || "", port = Number(process.env.TEST_RUNNER_NORACU_PORT);
if (!dir) { process.stderr.write("fake-xcodebuild: NORACU_FAKE_IOS_DIR is not set\n"); process.exit(64); }
appendFileSync(join(dir, "xcodebuild.log"), JSON.stringify({ argv: process.argv.slice(2), bind, port, token_ok: /^[0-9a-f]{32}$/.test(token), pid: process.pid }) + "\n");
const mode = existsSync(join(dir, "runner-mode")) ? readFileSync(join(dir, "runner-mode"), "utf8").trim() : "";
process.on("SIGTERM", () => process.exit(143));
// "stale-once": the first start of this test names another build, the ones after it the right one
const starts = readFileSync(join(dir, "xcodebuild.log"), "utf8").split("\n").filter(Boolean).length;
const stale = mode === "stale" || (mode === "stale-once" && starts === 1);
if (mode === "error") { process.stdout.write("NORACU_RUNNER error bad_bind\n"); setTimeout(() => process.exit(65), 50); }
else if (mode === "silent") setInterval(() => {}, 1000);
else {
  const phone = makePhone();
  const seen = { "launches.log": 0, "control.jsonl": 0 };
  const fresh = (name) => {
    if (!existsSync(join(dir, name))) return [];
    const lines = readFileSync(join(dir, name), "utf8").split("\n").filter(Boolean);
    const out = lines.slice(seen[name]).map((l) => JSON.parse(l));
    seen[name] = lines.length;
    return out;
  };
  const sync = () => {
    for (const l of fresh("launches.log")) phone.launch(l.bundle);
    for (const c of fresh("control.jsonl")) { if (c.set) Object.assign(phone, c.set); if (c.handle) phone.handle(c.handle[0], c.handle[1]); }
  };
  const server = net.createServer((sock) => {
    let buf = "";
    sock.on("error", () => {});
    sock.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        let msg = null;
        try { msg = JSON.parse(line); } catch { /* answered as auth below */ }
        if (!msg || msg.token !== token) { sock.end(JSON.stringify({ id: msg?.id ?? 0, ok: false, error: "auth" }) + "\n"); return; }
        sync();
        appendFileSync(join(dir, "runner.log"), JSON.stringify([msg.op, Object.keys(msg.args || {})]) + "\n");
        const r = phone.handle(msg.op, msg.args || {});
        sock.write(JSON.stringify({ id: msg.id, ...r }) + "\n", () => { if (msg.op === "quit") { process.stdout.write("NORACU_RUNNER exit served=0 by_quit=true\n"); process.exit(0); } });
      }
    });
  });
  server.listen(port, bind, () => process.stdout.write(`Test Case '-[NoracuRunnerUITests.NoracuRunner testServe]' started.\nNORACU_RUNNER ready v=${mode === "v2" ? 2 : 1} port=${port} build=${stale ? "0123456789ab" : runnerBuild()}\n`));
  server.on("error", (e) => { process.stdout.write("NORACU_RUNNER error bind_failed\n"); process.stderr.write(String(e.message) + "\n"); process.exit(65); });
}

// The iOS runner's rules that need no XCTest — which start setting is wrong, which bind address it listens on,
// what the listener's states mean, whether SpringBoard's frame is a screen. Each runner source keeps them in one
// block ("// MARK: - pure rules" … "// MARK: - end of pure rules"); this compiles those blocks on their own with
// swiftc, with the checks below, and runs them. macOS with Xcode's command-line tools only (as the runner itself);
// elsewhere it says so and passes.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "ios-runner", "NoracuRunnerUITests");
const BLOCK = /\/\/ MARK: - pure rules[^\n]*\n([\s\S]*?)\/\/ MARK: - end of pure rules/;
let n = 0;
const check = (name, ok, detail = "") => { n++; console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` | ${detail}` : ""}`); if (!ok) process.exitCode = 1; };

const blocks = ["NoracuRunner.swift", "RunnerCommands.swift"].map((f) => ({ f, m: BLOCK.exec(readFileSync(join(SRC, f), "utf8")) }));
// NoracuRunner.swift must have one; another source's block is compiled with it when it has one
const missing = blocks.filter((b) => !b.m && b.f === "NoracuRunner.swift").map((b) => b.f);
check("the runner keeps its XCTest-free rules in one block", missing.length === 0, missing.length ? `no block in ${missing.join(", ")}` : "");

// what the rules must answer — Swift, run against the blocks above
const CHECKS = String.raw`
var fails = 0
func expect(_ ok: Bool, _ what: String) { print((ok ? "✅ " : "❌ ") + what); if !ok { fails += 1 } }
let tok = String(repeating: "a", count: 32)
func env(_ bind: String, _ port: String = "50000", _ token: String = tok) -> [String: String] {
    ["NORACU_TOKEN": token, "NORACU_BIND": bind, "NORACU_PORT": port]
}
expect(NoracuRules.problem(env("0.0.0.0")) == "bad_bind" && NoracuRules.problem(env("::")) == "bad_bind",
       "a wildcard address parses but is not one the runner listens on: bad_bind, not bad_port")
expect(NoracuRules.problem(env("192.168.1.5")) == "bad_bind" && NoracuRules.problem(env("fe80::1")) == "bad_bind" && NoracuRules.problem(env("x")) == "bad_bind",
       "a Wi-Fi, a link-local and an unreadable address: bad_bind")
expect(NoracuRules.problem(env("127.0.0.1")) == nil && NoracuRules.problem(env("::1")) == nil && NoracuRules.problem(env("fd12::5")) == nil,
       "loopback and the tunnel's unique-local address are taken")
expect(NoracuRules.problem(env("127.0.0.1", "80")) == "bad_port" && NoracuRules.problem(env("127.0.0.1", "x")) == "bad_port",
       "a port outside 49152-65535: bad_port")
expect(NoracuRules.problem(env("127.0.0.1", "50000", "ABC")) == "bad_token" && NoracuRules.problem(env("0.0.0.0", "80", "")) == "bad_token",
       "a bad token is named first")
var w = NoracuListenerWatch()
w.note("waiting", "no network path")
expect(!w.settled && !w.ready && w.notReadyDetail == "waiting: no network path", "waiting does not end the ready wait, and names itself if the deadline passes")
w.note("ready")
expect(w.settled && w.ready && !w.gone, "ready after waiting: the runner serves")
w.note("failed", "POSIXErrorCode(rawValue: 50)")
expect(w.gone, "the listener failing after ready: gone, the session ends")
var w2 = NoracuListenerWatch()
w2.note("waiting", "a"); w2.note("failed", "b")
expect(w2.settled && !w2.ready && w2.notReadyDetail == "failed: b" && w2.notes == ["waiting: a", "failed: b"], "a failure after waiting ends the wait and is the one named; both are kept")
var w3 = NoracuListenerWatch()
w3.note("ready"); w3.note("cancelled")
expect(w3.gone, "a listener cancelled under the runner after ready: gone")
expect(!noracuScreenReadable(.zero) && !noracuScreenReadable(.null) && !noracuScreenReadable(CGRect(x: 0, y: 0, width: 402, height: 0))
       && noracuScreenReadable(CGRect(x: 0, y: 0, width: 402, height: 874)), "a SpringBoard frame without an area (a read that failed) is no screen")
//@@more
exit(fails == 0 ? 0 : 1)
`;

// where it is used: SpringBoard's front (its icons and alerts) is not read against a frame that is no screen
const commands = readFileSync(join(SRC, "RunnerCommands.swift"), "utf8");
const front = /static func springboardFront\(\)[\s\S]*?\n    \}\n/.exec(commands)?.[0] || "";
check("springboardFront answers nil (and its callers fail closed) when SpringBoard's frame is no screen",
  /let scr = screen\(\)\s*\n\s*guard noracuScreenReadable\(scr\) else \{ return nil \}/.test(front));

const swiftc = spawnSync("xcrun", ["--find", "swiftc"], { encoding: "utf8" });
if (process.platform !== "darwin" || swiftc.status !== 0) {
  console.log(`ios-runner rules: skipped (needs macOS with swiftc)`);
} else if (!missing.length) {
  const dir = mkdtempSync(join(tmpdir(), "noracu-runner-rules-"));
  try {
    const main = join(dir, "main.swift");
    writeFileSync(main, ["import Foundation", "import Network", "import CoreGraphics", ...blocks.filter((b) => b.m).map((b) => b.m[1]), CHECKS].join("\n"));
    const c = spawnSync("xcrun", ["swiftc", "-o", join(dir, "rules"), main], { encoding: "utf8", timeout: 180000 });
    check("the blocks compile on their own (no XCTest)", c.status === 0, String(c.stderr || "").split("\n").slice(0, 4).join(" / "));
    if (c.status === 0) {
      const r = spawnSync(join(dir, "rules"), [], { encoding: "utf8", timeout: 30000 });
      for (const line of String(r.stdout || "").trim().split("\n").filter(Boolean)) {
        const ok = line.startsWith("✅ ");
        check(`runner: ${line.slice(2).trim()}`, ok);
      }
      check("the checks ran to the end", r.status === 0 || process.exitCode === 1, `exit ${r.status}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
console.log(process.exitCode ? "ios-runner rules FAILED" : `ios-runner rules: ${n} passed`);

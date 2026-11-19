// scripts/gen-tools.mjs against stand-in servers (CI-safe: a throwaway copy of the script; no real server runs).
// A server that never answers, or exits, ends the run with an error instead of hanging it; one that names no
// version gets nothing written, not "?" in docs/tools.md.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "noracu-gentools-"));
const out = join(dir, "docs", "tools.md");
// a stand-in server: answers each request with reply(method), or not at all when that gives null
const server = (body) => [
  'import { createInterface } from "node:readline";',
  `const reply = ${body};`,
  'createInterface({ input: process.stdin }).on("line", (l) => { const m = JSON.parse(l); const r = reply(m.method); if (r) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: r }) + String.fromCharCode(10)); }).on("close", () => process.exit(0));',
  "setInterval(() => {}, 1 << 30);",
].join("\n");
const tools = '{ tools: [{ name: "mac_status", description: "d", inputSchema: { type: "object", properties: {} } }] }';
const run = (src) => {
  writeFileSync(join(dir, "src", "server.mjs"), src);
  rmSync(out, { force: true });
  const t0 = Date.now();
  const r = spawnSync("node", [join(dir, "scripts", "gen-tools.mjs")], { encoding: "utf8", timeout: 40000 });
  return { status: r.status, out: `${r.stdout}${r.stderr}`.trim(), ms: Date.now() - t0, wrote: existsSync(out) };
};
try {
  mkdirSync(join(dir, "scripts")); mkdirSync(join(dir, "src")); mkdirSync(join(dir, "docs"));
  copyFileSync(join(here, "..", "scripts", "gen-tools.mjs"), join(dir, "scripts", "gen-tools.mjs"));

  const silent = run(server("() => null"));
  assert.ok(silent.status !== null && silent.status !== 0 && !silent.wrote && /did not answer/.test(silent.out),
    `a server that never answers: the run ends with an error, nothing written (status ${silent.status}, ${silent.ms} ms: ${silent.out.slice(0, 160)})`);

  const gone = run("process.exit(3);");
  assert.ok(gone.status !== null && gone.status !== 0 && !gone.wrote && /exited/.test(gone.out) && gone.ms < 10000,
    `a server that exits: the run ends at once with an error (status ${gone.status}, ${gone.ms} ms: ${gone.out.slice(0, 160)})`);

  const noVersion = run(server(`(m) => m === "initialize" ? { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "x" } } : m === "tools/list" ? ${tools} : null`));
  assert.ok(noVersion.status === 1 && !noVersion.wrote && /version/.test(noVersion.out),
    `a server that names no version: nothing written (status ${noVersion.status}: ${noVersion.out.slice(0, 160)})`);

  const ok = run(server(`(m) => m === "initialize" ? { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "x", version: "9.9.9" } } : m === "tools/list" ? ${tools} : null`));
  assert.ok(ok.status === 0 && ok.wrote && readFileSync(out, "utf8").includes("mac_status"), `a server that answers: the reference is written (status ${ok.status}: ${ok.out.slice(0, 160)})`);
  console.log("gen-tools unit: 4/4 passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

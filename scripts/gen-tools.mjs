#!/usr/bin/env node
// scripts/gen-tools.mjs — 从运行中的 server 生成 docs/tools.md
// 通过 MCP tools/list 拉取（与实际实现永远同步，避免手改漂移）
// 用法：node scripts/gen-tools.mjs

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, "..", "src", "server.mjs");
const OUT = join(__dirname, "..", "docs", "tools.md");

// One server per iPhone backend: only the chosen backend's iPhone tools are listed (phone_* for mirror,
// ios_* for xcuitest), so the reference asks both and prints both groups.
async function listTools(env) {
  // all three layers: the reference lists every layer whatever the shell that runs this has set (unset is
  // mac,browser)
  // no NORACU_* setting of the shell that runs this reaches the server (NORACU_READ_ONLY or a
  // kill switch would change what the reference says)
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("NORACU_")));
  const proc = spawn("node", [SERVER], { stdio: ["pipe", "pipe", "ignore"], env: { ...clean, NORACU_LAYERS: "mac,browser,iphone", ...env } });
  let buf = "";
  const pending = new Map();
  let msgId = 0;
  // a server that exits answers nothing more: every request still waiting gets an error at once
  proc.stdin.on("error", () => { /* the exit below says it */ });
  proc.on("exit", (code, signal) => {
    for (const done of pending.values()) done({ error: { message: `the server exited (${signal || `code ${code}`})` } });
    pending.clear();
  });
  proc.stdout.on("data", (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line);
        if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      } catch {}
    }
  });
  // a request with no answer within 15 s ends the run (the server answers in about a second)
  const rpc = (method, params) => new Promise((res) => {
    const id = ++msgId;
    const timer = setTimeout(() => { pending.delete(id); res({ error: { message: `the server did not answer ${method} within 15 s` } }); }, 15000);
    pending.set(id, (m) => { clearTimeout(timer); res(m); });
    if (proc.exitCode === null && proc.signalCode === null) proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const init = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "gen-tools" } });
  const version = init.result?.serverInfo?.version;
  if (typeof version !== "string" || !version) {
    proc.kill();
    console.error(`gen-tools: initialize gave no server version (${JSON.stringify(init.error || init).slice(0, 200)})`);
    process.exit(1);
  }
  const tl = await rpc("tools/list", {});
  proc.kill();
  // an error or no answer is not an empty tool list: docs/tools.md is not overwritten from it
  if (!Array.isArray(tl.result?.tools) || !tl.result.tools.length) { console.error(`gen-tools: tools/list gave no tools (${JSON.stringify(tl.error || tl).slice(0, 200)})`); process.exit(1); }
  return { version, tools: tl.result.tools };
}

const mirror = await listTools({ NORACU_PHONE_BACKEND: "mirror" });
const xcuitest = await listTools({ NORACU_PHONE_BACKEND: "xcuitest" });
const version = mirror.version;
const tools = [...mirror.tools, ...xcuitest.tools.filter((t) => t.name.startsWith("ios_"))];

const layers = [
  { prefix: "mac_", title: "Mac layer (computer-use)", note: "macOS Accessibility API (src/mac-ax.js) · cliclick · screencapture" },
  { prefix: "browser_", title: "Browser layer (browser-use)", note: "Playwright" },
  { prefix: "phone_", title: "iPhone layer (device-use)", note: "listed when NORACU_LAYERS includes iphone (off by default) · imctl / iPhone Mirroring — the default iPhone backend" },
  { prefix: "ios_", title: "iPhone layer, XCUITest backend (device-use)", note: "listed instead of the phone_* tools when NORACU_LAYERS includes iphone and NORACU_PHONE_BACKEND=xcuitest · a UI-test runner on the phone (ios-runner/) · devicectl" },
];

function argsCell(schema) {
  const props = schema?.properties || {};
  const req = new Set(schema?.required || []);
  const parts = Object.entries(props).map(([k, v]) => {
    const t = (v.type || (v.anyOf ? v.anyOf.map(x => x.type ?? "?").join("|") : "?"));
    return req.has(k) ? `**${k}**:${t}` : `${k}:${t}?`;
  });
  return parts.length ? parts.join(", ") : "—";
}

// annotations (0.2.5): hints for the client, not permissions
// all four values: R read-only, D destructive, I idempotent, O open-world; – false, ? missing
const hintsCell = (a = {}) => [["readOnlyHint", "R"], ["destructiveHint", "D"], ["idempotentHint", "I"], ["openWorldHint", "O"]]
  .map(([k, c]) => (a[k] === true ? c : a[k] === false ? "–" : "?")).join(" ");

let md = `# Tool reference\n\n> Auto-generated from the running server (\`node scripts/gen-tools.mjs\`) — always in sync with the implementation. Hints are the four MCP tool annotations each tool reports — R read-only, D destructive, I idempotent, O open-world, – false — hints for the client, not permissions.\n> noracu v${version} · ${mirror.tools.filter((t) => /^(mac|browser)_/.test(t.name)).length} tools listed by default (the Mac and browser layers; NORACU_LAYERS unset), ${mirror.tools.length} with NORACU_LAYERS=mac,browser,iphone (iPhone Mirroring backend), ${xcuitest.tools.length} with NORACU_PHONE_BACKEND=xcuitest as well (the ios_* group replaces phone_*)\n\n`;
for (const L of layers) {
  const ts = tools.filter(t => t.name.startsWith(L.prefix));
  if (!ts.length) continue;
  md += `## ${L.title}\n\n*${L.note}*\n\n| Tool | Arguments | Hints | Description |\n|---|---|---|---|\n`;
  for (const t of ts) {
    md += `| \`${t.name}\` | ${argsCell(t.inputSchema)} | ${hintsCell(t.annotations)} | ${String(t.description || "").replace(/\|/g, "\\|").split("\n")[0]} |\n`;
  }
  md += "\n";
}
writeFileSync(OUT, md);
console.log(`${OUT}: ${mirror.tools.length} tools (mirror) / ${xcuitest.tools.length} (xcuitest), ${tools.length} described across ${layers.length} sections (v${version})`);

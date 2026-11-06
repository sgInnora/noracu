#!/usr/bin/env node
// scripts/gen-tools.mjs — 从运行中的 server 生成 docs/tools.md
// 通过 MCP tools/list 拉取（与实际实现永远同步，避免手改漂移——T17 建议）
// 用法：node scripts/gen-tools.mjs

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, "..", "src", "server.mjs");
const OUT = join(__dirname, "..", "docs", "tools.md");

const proc = spawn("node", [SERVER], { stdio: ["pipe", "pipe", "ignore"] });
let buf = "";
const pending = new Map();
let msgId = 0;
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
function rpc(method, params) {
  return new Promise((res) => {
    const id = ++msgId;
    pending.set(id, res);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

const init = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "gen-tools" } });
const version = init.result?.serverInfo?.version || "?";
const tl = await rpc("tools/list", {});
const tools = tl.result?.tools || [];
proc.kill();

const layers = [
  { prefix: "mac_", title: "Mac layer (computer-use)", note: "macOS Accessibility API (src/mac-ax.js) · cliclick · screencapture" },
  { prefix: "browser_", title: "Browser layer (browser-use)", note: "Playwright" },
  { prefix: "phone_", title: "iPhone layer (device-use)", note: "imctl / iPhone Mirroring" },
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

let md = `# Tool reference\n\n> Auto-generated from the running server (\`node scripts/gen-tools.mjs\`) — always in sync with the implementation. Hints are the four MCP tool annotations each tool reports — R read-only, D destructive, I idempotent, O open-world, – false — hints for the client, not permissions.\n> noracu v${version} · ${tools.length} tools\n\n`;
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
console.log(`${OUT}: ${tools.length} tools across ${layers.length} layers (v${version})`);

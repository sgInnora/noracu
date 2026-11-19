// `noracu doctor`, `noracu --help`, `noracu --version` — what a person at a terminal sees. None of this
// talks to an MCP client, and nothing is sent anywhere: it only reads this machine.
//
// doctor prints the client configuration with the absolute paths filled in (a GUI client does not inherit
// the shell's PATH, so `node` and the server both have to be named in full) and checks what the server
// needs around it. It cannot see the macOS permissions: those belong to the app that runs the server, and
// from a terminal only the terminal's own would show. The mac_status tool reports them from inside the client.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, isAbsolute, resolve } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "src", "server.mjs");
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
// Where Homebrew puts cliclick: /opt/homebrew on Apple silicon, /usr/local on an Intel Mac. Without NORACU_CLICLICK
// the server runs the first of these that exists (server.mjs CLICLICK); when neither does, the first is the one its
// "not found" answer names.
export const CLICLICK_PLACES = ["/opt/homebrew/bin/cliclick", "/usr/local/bin/cliclick"];
export function defaultCliclick(exists = existsSync) { return CLICLICK_PLACES.find((p) => exists(p)) || CLICLICK_PLACES[0]; }
const ISSUES = "https://github.com/sgInnora/noracu/issues/new/choose";
// the settings the server accepts (server.mjs LAYERS, PHONE_BACKEND); a value it would refuse or replace is not copied
// into a configuration
const LAYER_NAMES = ["mac", "browser", "iphone"];
const layersValid = (raw) => { const n = raw.trim().toLowerCase().split(",").map((x) => x.trim()).filter(Boolean); return n.length > 0 && n.every((x) => LAYER_NAMES.includes(x)); };
const backendValid = (raw) => ["mirror", "xcuitest"].includes(raw.trim().toLowerCase());

const run = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; } };
const shq = (s) => (/^[\w@%+:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

// The node to name in a client's configuration: this one, by a path that survives an upgrade where there is
// one. process.execPath is the versioned path under a package manager's cellar (it changes with every
// upgrade); the usual symlinks are preferred when they lead to this same binary, then `node` on PATH — unless
// that is a per-shell link of a version manager (under a temporary folder), which dies with the shell.
const EPHEMERAL = /^(?:\/private)?\/(?:tmp|var\/folders)\/|fnm_multishells/;
function stableNodePath() {
  let real;
  try { real = realpathSync(process.execPath); } catch { return process.execPath; }
  for (const p of ["/opt/homebrew/bin/node", "/usr/local/bin/node", run("/usr/bin/which", ["node"])]) {
    try { if (p && isAbsolute(p) && !EPHEMERAL.test(p) && realpathSync(p) === real) return p; } catch { /* not there */ }
  }
  return real;
}

export const HELP = `noracu ${VERSION} — a local MCP server: macOS apps and a browser by element index, plus iPhone (experimental).

It is started by an MCP client (Claude Desktop, Claude Code, Cursor), not by hand: it speaks JSON-RPC on stdin / stdout.

  noracu                 the MCP server on stdio (what a client runs)
  noracu doctor          check this machine and print the client configuration with absolute paths
                         (also: noracu --doctor); exits 1 when something the server needs is missing
  noracu doctor --json   the same as JSON
  noracu ios-setup …     build the on-device runner of the XCUITest iPhone backend
  noracu --version       print the version

Documentation: https://github.com/sgInnora/noracu#readme
`;

// `sys` stands in for this machine in tests: its platform, whether a file exists, and where `which` finds cliclick.
export async function collect(env = process.env, sys = {}) {
  const { platform = process.platform, exists = existsSync, whichCliclick = () => run("/usr/bin/which", ["cliclick"]) } = sys;
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const cliclickDefault = defaultCliclick(exists);
  const cliclickPath = env.NORACU_CLICLICK ? resolve(env.NORACU_CLICLICK) : cliclickDefault;
  const cliclickFound = exists(cliclickPath);
  const onPath = cliclickFound ? null : whichCliclick();
  const elsewhere = cliclickFound ? null : (CLICLICK_PLACES.find((p) => p !== cliclickPath && exists(p)) || (onPath && isAbsolute(onPath) && !EPHEMERAL.test(onPath) ? onPath : null));
  let browser;
  try {
    const { chromium } = await import("playwright");
    const path = chromium.executablePath();
    browser = { installed: Boolean(path) && exists(path), path: path || null };
  } catch (e) {
    browser = { installed: false, path: null, error: String(e?.message || e).split("\n")[0].slice(0, 200) };
  }
  // What this shell has set is not what a GUI client starts the server with: a cliclick that is not at the
  // server's default place, and layers asked for here, go into the configuration that is printed.
  const cliclickUse = cliclickFound ? cliclickPath : elsewhere;
  const layersSet = Boolean((env.NORACU_LAYERS || "").trim()), layersOk = !layersSet || layersValid(env.NORACU_LAYERS);
  const backendSet = Boolean((env.NORACU_PHONE_BACKEND || "").trim()), backendOk = !backendSet || backendValid(env.NORACU_PHONE_BACKEND);
  // the layers the server would run with: the ones set here when it accepts them (they go into the configuration
  // below), else its default. macOS is needed by the Mac and iPhone layers, cliclick by the Mac layer only.
  const layers = layersSet && layersOk ? env.NORACU_LAYERS.trim().toLowerCase().split(",").map((x) => x.trim()).filter(Boolean) : ["mac", "browser"];
  const needsMacos = layers.includes("mac") || layers.includes("iphone"), needsCliclick = layers.includes("mac");
  const serverEnvMap = {
    ...(cliclickUse && cliclickUse !== cliclickDefault ? { NORACU_CLICLICK: cliclickUse } : {}),
    ...(layersSet && layersOk ? { NORACU_LAYERS: env.NORACU_LAYERS.trim() } : {}),
    ...(backendSet && backendOk ? { NORACU_PHONE_BACKEND: env.NORACU_PHONE_BACKEND.trim().toLowerCase() } : {}),
  };
  const serverEnv = Object.keys(serverEnvMap).length ? serverEnvMap : undefined;
  const nodePath = stableNodePath();
  const macos = platform === "darwin" ? run("/usr/bin/sw_vers", ["-productVersion"]) : null;
  // what keeps the server from working as configured; any of these makes doctor exit 1. Playwright's Chromium is
  // not one: the first browser_launch downloads it.
  const problems = [
    ...(nodeMajor >= 20 ? [] : ["node: Node 20 or later is needed"]),
    ...(platform === "darwin" || !needsMacos ? [] : ["system: the Mac and iPhone layers need macOS"]),
    ...(cliclickUse || !needsCliclick ? [] : ["cliclick: not found — brew install cliclick"]),
    ...(layersOk ? [] : [`NORACU_LAYERS=${JSON.stringify(env.NORACU_LAYERS.slice(0, 40))}: not a comma-separated list of mac, browser, iphone — the server would not start; left out of the configuration`]),
    ...(backendOk ? [] : [`NORACU_PHONE_BACKEND=${JSON.stringify(env.NORACU_PHONE_BACKEND.slice(0, 20))}: not mirror or xcuitest — left out of the configuration`]),
  ];
  // a line for a bug report: versions and what was found, no path and no user name
  const report = `noracu ${VERSION} · node ${process.version} · ${platform === "darwin" ? `macOS ${macos || "?"}` : platform} ${process.arch} · cliclick ${cliclickUse ? "found" : "missing"} · Chromium ${browser.installed ? "installed" : "not installed"} · layers ${layersSet && layersOk ? env.NORACU_LAYERS.trim() : "mac,browser (default)"}${backendSet && backendOk ? ` · iPhone backend ${env.NORACU_PHONE_BACKEND.trim().toLowerCase()}` : ""}`;
  return {
    noracu: VERSION,
    ok: problems.length === 0,
    problems,
    report,
    node: { version: process.version, path: nodePath, exec_path: process.execPath, ok: nodeMajor >= 20 },
    platform: { os: platform, arch: process.arch, macos, ok: platform === "darwin", needed: needsMacos },
    server: { path: SERVER, in_npx_cache: /[\\/]_npx[\\/]/.test(SERVER) },
    cliclick: { path: cliclickPath, found: cliclickFound, elsewhere, default: cliclickDefault, needed: needsCliclick },
    browser,
    layers: layersSet ? env.NORACU_LAYERS.trim() : "mac,browser (default)",
    config: { mcpServers: { noracu: { command: nodePath, args: [SERVER], ...(serverEnv ? { env: serverEnv } : {}) } } },
    claude_code: `claude mcp add -s user noracu ${Object.entries(serverEnv || {}).map(([k, v]) => `-e ${k}=${shq(v)} `).join("")}-- ${shq(nodePath)} ${shq(SERVER)}`,
  };
}

export function render(d) {
  const row = (name, value, note) => `  ${name.padEnd(10)}${value}${note ? `\n  ${" ".repeat(10)}${note}` : ""}`;
  const out = [`noracu ${d.noracu} — setup check. Nothing is sent anywhere; this only reads this machine.`, ""];
  out.push(row("node", `${d.node.version} at ${d.node.path}`, d.node.ok ? "" : "needs Node 20 or later"));
  out.push(row("system", d.platform.ok ? `macOS ${d.platform.macos || "(version unknown)"} (${d.platform.arch})` : `${d.platform.os} (${d.platform.arch})`,
    d.platform.ok ? "" : d.platform.needed === false ? "NORACU_LAYERS=browser: the browser layer does not need macOS" : "the Mac and iPhone layers need macOS; start the server with NORACU_LAYERS=browser to use the browser layer alone"));
  out.push(row("cliclick", d.cliclick.found ? d.cliclick.path : `not at ${d.cliclick.path}`,
    d.cliclick.found ? (d.cliclick.path !== d.cliclick.default ? "not where the server looks by default — the configuration below passes it as NORACU_CLICLICK" : "") : d.cliclick.elsewhere ? (d.cliclick.elsewhere === d.cliclick.default ? `found at ${d.cliclick.elsewhere}, where the server looks by default — the configuration below leaves NORACU_CLICLICK out` : `found at ${d.cliclick.elsewhere} — the configuration below passes it as NORACU_CLICLICK`) : d.cliclick.needed === false ? "not needed: NORACU_LAYERS leaves the Mac layer out" : "physical Mac input needs it (mac_key, mac_drag, physical clicks and typing): brew install cliclick. Reading and semantic actions work without it."));
  out.push(row("browser", d.browser.installed ? "Playwright's Chromium is installed" : "Playwright's Chromium is not installed yet",
    d.browser.installed ? "" : d.browser.error ? `playwright could not be loaded: ${d.browser.error}` : "the first browser_launch downloads it (the one download noracu makes); or run: npx playwright install chromium"));
  out.push(row("layers", d.layers, d.config.mcpServers.noracu.env?.NORACU_LAYERS ? "set in this shell — the configuration below passes it as NORACU_LAYERS" : d.problems.some((p) => p.startsWith("NORACU_LAYERS")) ? "not valid — the server would not start with it; the configuration below leaves it out" : "NORACU_LAYERS=mac,browser,iphone turns the experimental iPhone layer on"));
  out.push(row("server", d.server.path, d.server.in_npx_cache ? "this copy is in npx's cache, which npm may clear: for a client configuration that keeps working, install it in a folder you keep (npm install noracu) and run doctor from there" : ""));
  out.push("", "macOS permissions (Accessibility, Screen Recording) are granted to the app that runs noracu — Claude Desktop,",
    "Cursor, or your terminal for Claude Code — not to node, and they apply after that app is quit and reopened.",
    "This check cannot see them from here: once the client is set up, ask it to call mac_status.", "",
    "Claude Desktop (~/Library/Application Support/Claude/claude_desktop_config.json) and Cursor (~/.cursor/mcp.json):", "",
    JSON.stringify(d.config, null, 2), "", "Claude Code (for every project of yours; drop `-s user` to add it to the current project only):", "", `  ${d.claude_code}`, "");
  out.push(d.ok ? "Nothing is missing." : `Missing or not valid (exit code 1):\n${d.problems.map((p) => `  - ${p}`).join("\n")}`, "",
    `Something does not work? Open an issue at ${ISSUES} with the tool, the steps, and this line (it holds no path or user name):`, "", `  ${d.report}`, "");
  return out.join("\n");
}

// argv: what follows `noracu` on the command line. Returns the exit code.
export async function cli(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === "--version") { process.stdout.write(`${VERSION}\n`); return 0; }
  if (cmd === "--help") { process.stdout.write(HELP); return 0; }
  if (cmd === "doctor" || cmd === "--doctor") {
    const unknown = rest.filter((a) => a !== "--json");
    if (unknown.length) { process.stderr.write(`noracu doctor: unknown option ${unknown[0]} (the only option is --json)\n`); return 2; }
    const d = await collect();
    process.stdout.write(rest.includes("--json") ? `${JSON.stringify(d, null, 2)}\n` : render(d));
    return d.ok ? 0 : 1;
  }
  process.stderr.write(`noracu: unknown command ${cmd}\n\n${HELP}`);
  return 2;
}

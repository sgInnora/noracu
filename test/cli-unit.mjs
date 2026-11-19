// CI-safe checks of what a person at a terminal sees: `noracu --version`, `--help`, `doctor`.
// Nothing here starts the MCP server or touches the desktop. Run: node test/cli-unit.mjs
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeChecker } from "./engine-harness.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "src", "server.mjs");
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const { check, done } = makeChecker();
const run = (args, env = {}) => spawnSync(process.execPath, [SERVER, ...args], { encoding: "utf8", timeout: 60000, env: { ...process.env, ...env } });

const v = run(["--version"]);
check("cli: --version prints the package version and exits 0", v.status === 0 && v.stdout.trim() === VERSION && v.stderr === "", JSON.stringify([v.status, v.stdout, v.stderr.slice(0, 80)]));

const h = run(["--help"]);
check("cli: --help names doctor and says the server is started by a client; exits 0", h.status === 0 && /noracu doctor/.test(h.stdout) && /started by an MCP client/.test(h.stdout), h.stdout.slice(0, 120));

const j = run(["doctor", "--json"]);
let d = null;
try { d = JSON.parse(j.stdout); } catch { /* reported below */ }
const cfg = d?.config?.mcpServers?.noracu;
check("cli: doctor --json is JSON with the version, an absolute node path and the server's own path",
  j.status === 0 && d?.noracu === VERSION && isAbsolute(d.node.path) && realpathSync(d.node.path) === realpathSync(process.execPath) && d.node.exec_path === process.execPath && realpathSync(d.server.path) === realpathSync(SERVER) && d.node.ok === true,
  j.stdout.slice(0, 160) + j.stderr.slice(0, 160));
check("cli: doctor's client configuration runs this node (by a path that leads to it) with this server, both by absolute path",
  cfg?.command === d.node.path && Array.isArray(cfg.args) && cfg.args.length === 1 && realpathSync(cfg.args[0]) === realpathSync(SERVER) && d.claude_code.includes(cfg.args[0]),
  JSON.stringify(cfg));
check("cli: doctor reports cliclick and the browser as found or not, without starting either",
  typeof d?.cliclick?.found === "boolean" && typeof d?.browser?.installed === "boolean" && typeof d?.server?.in_npx_cache === "boolean", JSON.stringify([d?.cliclick, d?.browser]));

const missing = run(["doctor", "--json"], { NORACU_CLICLICK: "/nonexistent/cliclick" });
const dm = JSON.parse(missing.stdout);
const DEFAULT_CLICLICK = dm.cliclick.default;
check("cli: a cliclick that is not where this shell points is reported as not found; one found elsewhere goes into the configuration unless it is at the server's default place",
  dm.cliclick.found === false && dm.cliclick.path === "/nonexistent/cliclick"
    && (dm.cliclick.elsewhere === null || dm.cliclick.elsewhere === DEFAULT_CLICLICK ? dm.config.mcpServers.noracu.env?.NORACU_CLICLICK === undefined : dm.config.mcpServers.noracu.env?.NORACU_CLICLICK === dm.cliclick.elsewhere),
  JSON.stringify([dm.cliclick, dm.config.mcpServers.noracu.env]));

// what this shell has set goes into the configuration: a GUI client does not inherit it
const custom = JSON.parse(run(["doctor", "--json"], { NORACU_CLICLICK: process.execPath, NORACU_LAYERS: "mac,browser,iphone" }).stdout);
check("cli: a cliclick set in this shell (found, not at the default place) and NORACU_LAYERS go into the configuration and the Claude Code command",
  custom.cliclick.found === true && custom.config.mcpServers.noracu.env?.NORACU_CLICLICK === process.execPath && custom.config.mcpServers.noracu.env?.NORACU_LAYERS === "mac,browser,iphone"
    && custom.claude_code.includes("-e NORACU_CLICLICK=") && custom.claude_code.includes("-e NORACU_LAYERS=mac,browser,iphone") && custom.claude_code.includes("-s user"),
  JSON.stringify([custom.config.mcpServers.noracu.env, custom.claude_code.slice(0, 120)]));
check("cli: the node named in the configuration is absolute and not a per-shell link under a temporary folder", isAbsolute(d.node.path) && !/fnm_multishells|^\/(private\/)?(tmp|var\/folders)\//.test(d.node.path), d.node.path);

const short = run(["-v"], {});
check("cli: only doctor, --help and --version are commands — a short flag is not (the server starts and ends when stdin closes)", !/^\d+\.\d+\.\d+\s*$/.test(short.stdout), JSON.stringify([short.status, short.stdout.slice(0, 40)]));

// the line about cliclick says what the configuration does, in both cases
const tm = run(["doctor"], { NORACU_CLICLICK: "/nonexistent/cliclick" }).stdout;
check("cli: the cliclick line says \"passes it as NORACU_CLICLICK\" exactly when the configuration does",
  /passes it as NORACU_CLICLICK/.test(tm) === (dm.config.mcpServers.noracu.env?.NORACU_CLICLICK !== undefined), tm.split("\n").filter((l) => /cliclick|found at/.test(l)).join(" | ").slice(0, 300));

const t = run(["doctor"]);
check("cli: doctor's text names the permissions' owner and mac_status, and carries the configuration",
  t.status === (d.problems.length ? 1 : 0) && /granted to the app that runs noracu/.test(t.stdout) && /mac_status/.test(t.stdout) && t.stdout.includes('"mcpServers"') && t.stdout.includes(SERVER), t.stdout.slice(0, 100));

const bad = run(["doctor", "--frobnicate"]);
check("cli: an unknown doctor option exits 2 with a message", bad.status === 2 && /unknown option --frobnicate/.test(bad.stderr) && bad.stdout === "", JSON.stringify([bad.status, bad.stderr.slice(0, 60)]));

// --doctor is the same command (the README's spelling)
const dd = run(["--doctor", "--json"]);
let ddj = null;
try { ddj = JSON.parse(dd.stdout); } catch { /* reported below */ }
check("cli: --doctor is doctor — it prints the configuration and exits, the server is not started",
  ddj?.noracu === VERSION && ddj?.config?.mcpServers?.noracu && dd.status === (ddj.problems.length ? 1 : 0) && !/\[noracu\] ready/.test(dd.stderr), JSON.stringify([dd.status, dd.stdout.slice(0, 80), dd.stderr.slice(0, 80)]));

// the exit code says whether something the server needs is missing; Playwright's Chromium is not one of them
check("cli: doctor exits 1 exactly when it lists a problem, and a missing Chromium is not a problem",
  j.status === (d.problems.length ? 1 : 0) && d.ok === (d.problems.length === 0) && !d.problems.some((p) => /chromium/i.test(p)), JSON.stringify([j.status, d.problems]));

// a setting the server would refuse or replace is not copied into the configuration, and doctor says so
const badLayers = run(["doctor", "--json"], { NORACU_LAYERS: "mac,brwoser", NORACU_PHONE_BACKEND: "xcui" });
const bl = JSON.parse(badLayers.stdout);
check("cli: an invalid NORACU_LAYERS or NORACU_PHONE_BACKEND stays out of the configuration and makes doctor exit 1",
  badLayers.status === 1 && bl.config.mcpServers.noracu.env?.NORACU_LAYERS === undefined && bl.config.mcpServers.noracu.env?.NORACU_PHONE_BACKEND === undefined
    && bl.problems.some((p) => p.startsWith("NORACU_LAYERS")) && bl.problems.some((p) => p.startsWith("NORACU_PHONE_BACKEND")) && !bl.claude_code.includes("brwoser"),
  JSON.stringify([badLayers.status, bl.problems, bl.config.mcpServers.noracu.env]));
const xc = JSON.parse(run(["doctor", "--json"], { NORACU_LAYERS: "mac,browser,iphone", NORACU_PHONE_BACKEND: "XCUITest" }).stdout);
check("cli: NORACU_PHONE_BACKEND set in this shell goes into the configuration (a GUI client would otherwise start the mirror backend)",
  xc.config.mcpServers.noracu.env?.NORACU_PHONE_BACKEND === "xcuitest" && xc.claude_code.includes("-e NORACU_PHONE_BACKEND=xcuitest"), JSON.stringify(xc.config.mcpServers.noracu.env));

// the line for a bug report: versions and findings, no path, no user name
const home = process.env.HOME || "/Users/";
check("cli: doctor ends with a line to paste into an issue — versions and what was found, no path and no user name",
  /^noracu \d+\.\d+\.\d+ · node v\d+/.test(d.report) && !d.report.includes("/") && !d.report.includes(home) && !d.report.includes(ROOT) && t.stdout.includes(d.report) && /issues\/new\/choose/.test(t.stdout),
  d.report);

// cliclick without NORACU_CLICLICK: Apple silicon's Homebrew place, then Intel's
const { defaultCliclick, CLICLICK_PLACES } = await import("../src/doctor.js");
check("cli: without NORACU_CLICLICK cliclick is looked for under /opt/homebrew/bin, then /usr/local/bin (an Intel Mac's Homebrew)",
  defaultCliclick((p) => p === "/usr/local/bin/cliclick") === "/usr/local/bin/cliclick" && defaultCliclick((p) => p === "/opt/homebrew/bin/cliclick" || p === "/usr/local/bin/cliclick") === "/opt/homebrew/bin/cliclick"
    && defaultCliclick(() => false) === "/opt/homebrew/bin/cliclick" && CLICLICK_PLACES.length === 2,
  JSON.stringify(CLICLICK_PLACES));
const srv = readFileSync(SERVER, "utf8");
check("cli: the server takes its cliclick from the same rule as doctor", /const CLICLICK = process\.env\.NORACU_CLICLICK \|\| defaultCliclick\(\);/.test(srv), "");

// what doctor counts as missing follows the layers the server would run with: macOS for the Mac and iPhone layers,
// cliclick for the Mac layer — so the browser-only setup that its "system" line suggests on another system passes
const { collect } = await import("../src/doctor.js");
const { existsSync } = await import("node:fs");
const away = { platform: "linux", exists: (p) => !/\/cliclick$/.test(p) && existsSync(p), whichCliclick: () => null };
const bo = await collect({ NORACU_LAYERS: "browser" }, away), df = await collect({}, away), ip = await collect({ NORACU_LAYERS: "browser,iphone" }, away);
const has = (d, k) => d.problems.some((p) => p.startsWith(`${k}:`));
check("cli: doctor with NORACU_LAYERS=browser on another system and without cliclick lists nothing missing; the default layers miss macOS and cliclick, the iPhone layer macOS only",
  bo.ok === true && bo.problems.length === 0 && !df.ok && has(df, "system") && has(df, "cliclick") && has(ip, "system") && !has(ip, "cliclick"),
  JSON.stringify([bo.problems, df.problems, ip.problems]));
// …and the text says the same: a browser-only setup elsewhere is not told to install cliclick or to set the layers
const { render } = await import("../src/doctor.js");
const tb = render(bo), td = render(df);
check("cli: doctor's text for NORACU_LAYERS=browser on another system asks for neither cliclick nor macOS; the default layers' text does",
  /Nothing is missing/.test(tb) && !/brew install cliclick/.test(tb) && !/start the server with NORACU_LAYERS=browser/.test(tb)
    && /brew install cliclick/.test(td) && /start the server with NORACU_LAYERS=browser/.test(td),
  tb.split("\n").filter((l) => /cliclick|macOS|system/.test(l)).join(" | ").slice(0, 300));

done("cli unit");

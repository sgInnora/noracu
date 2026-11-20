// The command line tests once more with cliclick out of sight, as on a CI runner, which has none installed: a
// sandbox hides every file named cliclick from them (macOS; elsewhere there is nothing to hide). A check that holds
// only where cliclick is installed fails here (one did: CI failed on runners without cliclick).
// Run: node test/cli-no-cliclick.mjs
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_UNIT = join(dirname(fileURLToPath(import.meta.url)), "cli-unit.mjs");
const SANDBOX = "/usr/bin/sandbox-exec";
const HIDE_CLICLICK = '(version 1)(allow default)(deny file-read* (regex #"/cliclick$"))';

if (process.platform !== "darwin") { console.log("cli without cliclick: skipped — not macOS"); process.exit(0); }
if (!existsSync(SANDBOX)) { console.log(`cli without cliclick: FAIL — ${SANDBOX} is not on this Mac, so cliclick cannot be hidden`); process.exit(1); }
// the places doctor looks in by default (which the sandbox hides), and the layers that need cliclick
const env = { ...process.env };
for (const k of ["NORACU_CLICLICK", "NORACU_LAYERS", "NORACU_PHONE_BACKEND"]) delete env[k];
const r = spawnSync(SANDBOX, ["-p", HIDE_CLICLICK, process.execPath, CLI_UNIT], { encoding: "utf8", env, timeout: 300000 });
process.stdout.write(r.stdout);
process.stderr.write(r.stderr);
// the sandbox did hide it: inside, doctor said cliclick was missing
const hidden = /cliclick: not found/.test(r.stdout);
const pass = r.status === 0 && hidden;
console.log(`cli without cliclick: ${pass ? "PASS" : "FAIL"} (exit ${r.status}${hidden ? "" : ", and doctor never reported cliclick missing — it was not hidden"})`);
process.exit(pass ? 0 : 1);

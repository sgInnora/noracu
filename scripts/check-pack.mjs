#!/usr/bin/env node
// Checks what `npm pack` would ship: the runtime files must be there, internal material must not.
// Run: node scripts/check-pack.mjs   (CI and prepublishOnly)
import { execFileSync } from "node:child_process";

const out = execFileSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
const files = JSON.parse(out)[0].files.map((f) => f.path);
const must = ["src/server.mjs", "src/mac-ax.js", "imctl/src/imctl/cli.py", "README.md", "LICENSE"];
const forbidden = [/^OUTPUTS\//, /^docs\/analysis\//, /chatgpt-re-findings/, /\.demo-video\//, /__pycache__/, /\.pyc$/, /\.tgz$/, /^test\//, /^\.github\//];
const missing = must.filter((m) => !files.includes(m));
const leaked = files.filter((f) => forbidden.some((re) => re.test(f)));
console.log(`npm pack: ${files.length} files`);
if (missing.length) console.log(`missing: ${missing.join(", ")}`);
if (leaked.length) console.log(`must not ship: ${leaked.join(", ")}`);
process.exit(missing.length || leaked.length ? 1 : 0);

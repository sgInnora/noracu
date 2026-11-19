#!/usr/bin/env node
// Checks what `npm pack` would ship: the runtime files must be there, internal material must not.
// Run: node scripts/check-pack.mjs   (CI and prepublishOnly)
// The rules are in pack-rules.mjs. This file does not ask "was I started directly?": it always runs. Such a test
// compares two spellings of this file's path, and through a symlinked folder they differ — the check would then
// print nothing and exit 0.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { SCANNED, labelled, verdict } from "./pack-rules.mjs";

const out = execFileSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
const files = JSON.parse(out)[0].files.map((f) => f.path);
const { missing, leaked, readmes } = verdict(files, readdirSync("."));
console.log(`npm pack: ${files.length} files`);
if (missing.length) console.log(`missing: ${missing.join(", ")}`);
if (leaked.length) console.log(`must not ship: ${leaked.join(", ")}`);
if (readmes.length) console.log(`more than one README in the package folder (npm may show the wrong one): ${readmes.join(", ")} — keep translations under docs/`);
const labels = labelled(files.filter((f) => SCANNED.test(f)).map((path) => ({ path, source: readFileSync(path, "utf8") })));
if (labels.length) console.log(`review or device-test labels in the comments of shipped sources (reword the comment, drop the label):\n  ${labels.join("\n  ")}`);
process.exit(missing.length || leaked.length || readmes.length || labels.length ? 1 : 0);

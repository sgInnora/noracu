#!/usr/bin/env node
// Release gate (maintainer checkouts only): a release of version X needs the recorded verdict of a
// three-model cross-verification — three reviewers from three different model families, two or more
// rounds (independent review, then cross-check), every reviewer's final round SHIP — made on a tree
// that differs from the one being released only in the version bump itself.
//
// Runs from `prepublishOnly` and from the maintainer's local pre-push hook. A checkout without the
// maintainer's (git-ignored) evidence folder has nothing to check and passes (forks, CI) — except
// when publishing the official "noracu" package: then a missing folder is a failure.
//
// usage: node scripts/release-gate.mjs [version] [commit]
//   version: default package.json's. commit: the tree being released (the pre-push hook passes the
//   commit it pushes; compared commit to commit). Without a commit the gate checks what `npm publish`
//   would pack — npm's own file list (`npm pack --dry-run`), each file compared with the verified
//   commit — plus every tracked file in the working tree. Publishing a packed tarball skips npm's
//   prepublishOnly, so the release checklist runs this before packing as well.
//
// "Only the version bump": a file may differ from the verified commit only if it is one of the
// version files, and only by the old version becoming the new one (the CHANGELOG's "[Unreleased]"
// heading becoming "[X] — date") — compared as whole files after exactly that substitution.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = process.argv[2] || pkg.version;
const target = process.argv[3] || null; // null: what npm would pack from the working tree
const evidence = join(root, "OUTPUTS");
const fail = (msg) => { console.error(`release gate: ${version} is NOT cleared — ${msg}`); process.exit(1); };
if (!existsSync(evidence)) {
  if (pkg.name === "noracu" && process.env.npm_lifecycle_event === "prepublishOnly") {
    fail("publishing the official package from a checkout without the maintainer evidence folder (OUTPUTS/)");
  }
  console.log("release gate: no maintainer evidence folder in this checkout — nothing to check");
  process.exit(0);
}
const file = join(evidence, `release-${version}`, "XV-VERDICT.json");
if (!existsSync(file)) fail(`no release-${version}/XV-VERDICT.json: run the three-model cross-verification (2 rounds) first`);

let v;
try { v = JSON.parse(readFileSync(file, "utf8")); } catch (e) { fail(`XV-VERDICT.json is not JSON (${e.message})`); }
if (v.version !== version) fail(`the verdict is for ${v.version}, not ${version}`);
if (!/^[0-9a-f]{40}$/i.test(String(v.head || ""))) fail(`"head" must be the verified commit's full 40-character hash, not ${JSON.stringify(v.head)}`);
if (!(Number.isInteger(v.rounds) && v.rounds >= 2)) fail("fewer than 2 rounds recorded");
const reviewers = Array.isArray(v.reviewers) ? v.reviewers : [];
const families = new Set(reviewers.map((r) => String(r.family || "").toLowerCase()).filter(Boolean));
if (reviewers.length < 3 || families.size < 3) fail(`needs 3 reviewers from 3 different model families (got ${reviewers.length} reviewers, ${families.size} families)`);
const notShip = reviewers.filter((r) => String(r.final || "").toUpperCase() !== "SHIP");
if (notShip.length) fail(`final round not SHIP for: ${notShip.map((r) => `${r.model} (${r.final || "none"})`).join(", ")}`);
if (v.device_tests !== "pass") fail("device tests are not recorded as pass");

const VERSION_FILES = new Set(["package.json", "package-lock.json", "server.json", "CHANGELOG.md", "docs/tools.md",
  "imctl/pyproject.toml", "imctl/src/imctl/__init__.py"]);
const git = (args, opts = {}) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 << 20, ...opts });
const atHead = (path) => { try { return git(["show", `${v.head}:${path}`], { stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; } };
let oldVersion;
try { oldVersion = JSON.parse(atHead("package.json")).version; } catch { fail(`cannot read package.json at the verified commit ${v.head}`); }
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// the version bump and nothing else: the CHANGELOG heading, then every old/new version token
const normalize = (text) => text
  .replace(new RegExp(`^## \\[(?:Unreleased|${esc(version)})\\](?: — \\d{4}-\\d{2}-\\d{2})?$`, "m"), "## [V]")
  .replace(new RegExp(`(?<![\\d.])(?:${esc(version)}|${esc(oldVersion)})(?![\\d.])`, "g"), "V");
const same = (path, before, after) => before === after || (VERSION_FILES.has(path) && before !== null && normalize(before) === normalize(after));

const bad = [];
if (target) {
  let changed;
  try { changed = git(["diff", "--name-only", v.head, target]).split("\n").filter(Boolean); }
  catch (e) { fail(`cannot compare ${target} with the verified commit ${v.head} (${e.message.split("\n")[0]})`); }
  for (const f of changed) {
    let after = null;
    try { after = git(["show", `${target}:${f}`]); } catch { /* deleted */ }
    if (after === null || !same(f, atHead(f), after)) bad.push(f);
  }
} else {
  // every tracked file of the working tree (staged or not)…
  let changed;
  try { changed = git(["diff", "--name-only", v.head]).split("\n").filter(Boolean); }
  catch (e) { fail(`cannot compare the working tree with the verified commit ${v.head} (${e.message.split("\n")[0]})`); }
  for (const f of changed) {
    const p = join(root, f);
    if (!existsSync(p) || !same(f, atHead(f), readFileSync(p, "utf8"))) bad.push(f);
  }
  // …and every file npm would pack, ignored or untracked ones included
  let packed;
  try {
    const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 });
    packed = JSON.parse(out)[0].files.map((x) => x.path);
  } catch (e) { fail(`cannot list what npm would pack (${e.message.split("\n")[0]})`); }
  for (const f of packed) {
    if (bad.includes(f)) continue;
    const before = atHead(f);
    if (before === null) { bad.push(`${f} (not in the verified commit)`); continue; }
    if (!same(f, before, readFileSync(join(root, f), "utf8"))) bad.push(f);
  }
}
if (bad.length) fail(`differs from the verified commit ${v.head} beyond the version bump: ${[...new Set(bad)].join(", ")} — re-test and re-verify`);
console.log(`release gate: ${version} cleared — ${reviewers.map((r) => r.model).join(", ")}, ${v.rounds} rounds, all SHIP; verified at ${v.head.slice(0, 12)}${target ? ` (checked ${target})` : " (checked the npm pack list and the working tree)"}`);

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
import { existsSync, readFileSync, lstatSync } from "node:fs";
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
// EA-3 (2026-11-09: a verdict copied from a plan debate cleared the gate): the rounds are logged, and every
// reviewer's final round is a file in this release's evidence folder that says SHIP
const roundLog = v.round_log && typeof v.round_log === "object" && !Array.isArray(v.round_log) ? Object.keys(v.round_log) : [];
if (roundLog.length < 2) fail(`"round_log" must name each review round (at least the independent round and the cross-check), got ${roundLog.length}`);
if (roundLog.length < v.rounds) fail(`"rounds" is ${v.rounds} but "round_log" names only ${roundLog.length}`);
const reviewers = Array.isArray(v.reviewers) ? v.reviewers : [];
// a family is the vendor: "orcacyber-hy4" and "orcacyber-ultra" are one family
const vendorOf = (r) => String(r.family || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)[0] || "";
const families = new Set(reviewers.map(vendorOf).filter(Boolean));
if (reviewers.length < 3 || families.size < 3) fail(`needs 3 reviewers from 3 different model families (got ${reviewers.length} reviewers, ${families.size} families: ${[...families].join(", ") || "none"})`);
const notShip = reviewers.filter((r) => String(r.final || "").toUpperCase() !== "SHIP");
if (notShip.length) fail(`final round not SHIP for: ${notShip.map((r) => `${r.model} (${r.final || "none"})`).join(", ")}`);
// cross-verification A0 (2026-11-09): the verdict is the file's last line, the file names the verified commit,
// it is a plain file of this release's folder, and no two reviewers share one
// case folded: on a case-insensitive volume "r1.md" and "R1.md" are one file (review S5C-D-2, -G-3); hard links are
// caught below by device and inode
if (new Set(reviewers.map((r) => String(r.file).toLowerCase())).size !== reviewers.length) fail("two reviewers name the same final-round file");
const inodes = new Set();
for (const r of reviewers) {
  // a bare file name: "./x.md" or "sub/x.md" could name one file under several spellings, or go through a
  // symlinked folder (audit S5A-s28-G-1)
  const f = typeof r.file === "string" && /^[\w][\w.-]*$/.test(r.file) ? join(evidence, `release-${version}`, r.file) : null;
  let text = "";
  try {
    const st = f ? lstatSync(f) : null;
    if (st && st.isFile()) {
      if (inodes.has(`${st.dev}:${st.ino}`)) fail("two reviewers name the same final-round file");
      inodes.add(`${st.dev}:${st.ino}`);
      text = readFileSync(f, "utf8");
    }
  } catch { /* missing */ }
  if (!text) fail(`${r.model || "a reviewer"}: "file" must name its final-round answer, a plain file inside release-${version}/ (got ${JSON.stringify(r.file)})`);
  const last = text.split("\n").map((l) => l.trim()).filter(Boolean).pop() || "";
  if (last !== "VERDICT: SHIP") fail(`${r.model}: the last line of ${r.file} is ${JSON.stringify(last.slice(0, 60))}, not "VERDICT: SHIP"`);
  if (!text.includes(String(v.head).slice(0, 12))) fail(`${r.model}: ${r.file} does not name the verified commit ${String(v.head).slice(0, 12)}`);
}
if (v.device_tests !== "pass") fail("device tests are not recorded as pass");

const VERSION_FILES = new Set(["package.json", "package-lock.json", "server.json", "CHANGELOG.md", "docs/tools.md",
  "imctl/pyproject.toml", "imctl/src/imctl/__init__.py"]);
const git = (args, opts = {}) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 << 20, ...opts });
const atHead = (path) => { try { return git(["show", `${v.head}:${path}`], { stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; } };
let oldVersion;
try { oldVersion = JSON.parse(atHead("package.json")).version; } catch { fail(`cannot read package.json at the verified commit ${v.head}`); }
// EA-1: the version asked for is the version of the tree being released
{
  let treeVersion;
  try { treeVersion = JSON.parse(target ? git(["show", `${target}:package.json`]) : readFileSync(join(root, "package.json"), "utf8")).version; }
  catch { fail(`cannot read package.json of ${target || "the working tree"}`); }
  if (treeVersion !== version) fail(`asked to clear ${version}, but package.json of ${target || "the working tree"} is ${treeVersion}`);
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// The version bump and nothing else: the CHANGELOG heading, then, token by token, each old or new version
// number in the same place — old→new (the bump), old→old or new→new (unchanged). EA-2: a new→old token is a
// swap, not a bump (both used to normalize to the same placeholder).
const heading = new RegExp(`^## \\[(?:Unreleased|${esc(version)})\\](?: — \\d{4}-\\d{2}-\\d{2})?$`, "m");
const token = new RegExp(`(?<![\\d.])(${esc(version)}|${esc(oldVersion)})(?![\\d.])`, "g");
const bumpOnly = (before, after) => {
  const b = before.replace(heading, "## [V]").split(token), a = after.replace(heading, "## [V]").split(token);
  if (b.length !== a.length) return false;
  // split with a capture group: even entries are the text between tokens, odd entries the tokens
  return b.every((x, i) => (i % 2 === 0 ? x === a[i] : x === a[i] || (x === oldVersion && a[i] === version)));
};
const same = (path, before, after) => before === after || (VERSION_FILES.has(path) && before !== null && bumpOnly(before, after));

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

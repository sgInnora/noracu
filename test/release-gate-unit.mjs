// Release-gate tests (CI-safe: a throwaway git repository with a copy of scripts/release-gate.mjs; the gate
// runs in its commit-to-commit mode, so npm is never called). Among the cases: a version file changed after the
// verified tree (0.2.7), and a verdict with two reviewers of one vendor that cleared 0.3.0 (2026-11-09).
import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, symlinkSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "noracu-gate-"));
const git = (...a) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" }).trim();
const put = (files) => { for (const [p, s] of Object.entries(files)) { mkdirSync(join(dir, p, ".."), { recursive: true }); writeFileSync(join(dir, p), s); } };
const commit = (files, msg) => { put(files); git("add", "-A"); git("commit", "-q", "-m", msg); return git("rev-parse", "HEAD"); };
const gate = (version, target) => {
  const r = spawnSync("node", [join(dir, "scripts", "release-gate.mjs"), version, target], { encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}`.trim() };
};
try {
  git("init", "-q");
  mkdirSync(join(dir, "scripts"));
  copyFileSync(join(here, "..", "scripts", "release-gate.mjs"), join(dir, "scripts", "release-gate.mjs"));
  const pkg = (v, dep = "0.2.9") => JSON.stringify({ name: "noracu-gate-test", version: v, dependencies: { "some-dep": dep } }, null, 2) + "\n";
  // the verified commit: before the version bump
  const A = commit({
    "scripts/.keep": "",
    "package.json": pkg("0.2.9"),
    "docs/tools.md": "# noracu 0.2.9 tools\nsince 0.2.9, before 0.3.0\n",
    "CHANGELOG.md": "# Changelog\n\n## [Unreleased]\n\n- x\n\n## [0.2.9] — 2026-01-01\n",
    "src/a.js": "export const a = 1;\n",
  }, "verified");
  // a proper bump
  const B = commit({
    "package.json": pkg("0.3.0"),
    "docs/tools.md": "# noracu 0.3.0 tools\nsince 0.2.9, before 0.3.0\n",
    "CHANGELOG.md": "# Changelog\n\n## [0.3.0] — 2026-02-02\n\n- x\n\n## [0.2.9] — 2026-01-01\n",
  }, "release: 0.3.0");
  // A new→old swap inside a version file
  const C = commit({ "docs/tools.md": "# noracu 0.3.0 tools\nsince 0.3.0, before 0.2.9\n" }, "swap");
  git("checkout", "-q", B);
  // the old number becoming the new one somewhere else in a version file: a dependency pinned at the old number,
  // a number in the text
  const E = commit({ "package.json": pkg("0.3.0", "0.3.0") }, "a dependency's number bumped along");
  git("checkout", "-q", B);
  const G = commit({ "docs/tools.md": "# noracu 0.3.0 tools\nsince 0.3.0, before 0.3.0\n" }, "a number in the text bumped along");
  git("checkout", "-q", B);
  // a code change after the verdict
  const D = commit({ "src/a.js": "export const a = 2;\n" }, "code");

  const rel = join(dir, "OUTPUTS", "release-0.3.0");
  mkdirSync(rel, { recursive: true });
  // a final-round file: names the verified commit, mentions SHIP and HOLD in passing, ends on its verdict line
  const ship = (name, last = "VERDICT: SHIP", head = A) => { writeFileSync(join(rel, name), `round B at ${head}\n- a point: we would SHIP once X, HOLD otherwise\n\n${last}\n`); return name; };
  // the default reviewers' files are written only when the call does not bring its own reviewers
  const verdict = (over = {}) => writeFileSync(join(rel, "XV-VERDICT.json"), JSON.stringify({
    version: "0.3.0", head: A, rounds: 2, round_log: { A: "independent", B: "cross-check" }, device_tests: "pass",
    ...(over.reviewers ? {} : { reviewers: [
      { model: "alpha/model-1", family: "alpha", final: "SHIP", file: ship("xv-B__X.md") },
      { model: "beta-model-2", family: "beta", final: "SHIP", file: ship("xv-B__D.md") },
      { model: "gamma-model-3", family: "gamma", final: "SHIP", file: ship("xv-B__G.md") },
    ] }),
    ...over,
  }));

  verdict();
  let r = gate("0.3.0", B);
  assert.ok(r.ok, `a proper bump clears: ${r.out}`);
  r = gate("0.3.0", C);
  assert.ok(!r.ok && /beyond the version bump: docs\/tools\.md/.test(r.out), `a new→old swap is not a bump: ${r.out}`);
  r = gate("0.3.0", E);
  assert.ok(!r.ok && /beyond the version bump: package\.json/.test(r.out), `a dependency pinned at the old number that becomes the new one is not the bump: ${r.out}`);
  r = gate("0.3.0", G);
  assert.ok(!r.ok && /beyond the version bump: docs\/tools\.md/.test(r.out), `the old number becoming the new one in the text of a version file is not the bump: ${r.out}`);
  r = gate("0.3.0", D);
  assert.ok(!r.ok && /src\/a\.js/.test(r.out), `a code change after the verdict is refused: ${r.out}`);
  r = gate("0.3.0", A);
  assert.ok(!r.ok && /package\.json of .* is 0\.2\.9/.test(r.out), `the version asked for must be the tree's: ${r.out}`);

  verdict({ reviewers: [
    { model: "delta-direct", family: "delta", final: "SHIP", file: ship("p1.md") },
    { model: "acme-small", family: "acme-small", final: "SHIP", file: ship("p2.md") },
    { model: "acme-large", family: "acme-large", final: "SHIP", file: ship("p3.md") },
  ] });
  r = gate("0.3.0", B);
  assert.ok(!r.ok && /3 different model families .* 2 families/.test(r.out), `two models of one vendor are one family: ${r.out}`);

  verdict({ reviewers: [
    { model: "alpha/model-1", family: "alpha", final: "SHIP", evidence: "~/.pi/agent/panel/…" },
    { model: "beta-model-2", family: "beta", final: "SHIP", file: ship("xv-B__D.md") },
    { model: "gamma-model-3", family: "gamma", final: "SHIP", file: ship("xv-B__G.md") },
  ] });
  r = gate("0.3.0", B);
  assert.ok(!r.ok && /"file" must name its final-round answer/.test(r.out), `a final round outside the evidence folder does not count: ${r.out}`);

  verdict({ reviewers: [
    { model: "alpha/model-1", family: "alpha", final: "SHIP", file: ship("xv-B__X.md", "VERDICT: HOLD") },
    { model: "beta-model-2", family: "beta", final: "SHIP", file: ship("xv-B__D.md") },
    { model: "gamma-model-3", family: "gamma", final: "SHIP", file: ship("xv-B__G.md") },
  ] });
  r = gate("0.3.0", B);
  assert.ok(!r.ok && /last line of xv-B__X\.md is "VERDICT: HOLD"/.test(r.out), `a final round that ends on HOLD does not count as SHIP: ${r.out}`);

  // the final-round file: its last line is the verdict, it names the commit, and no two reviewers share it
  const three = (x) => [x, { model: "beta-model-2", family: "beta", final: "SHIP", file: ship("xv-B__D.md") }, { model: "gamma-model-3", family: "gamma", final: "SHIP", file: ship("xv-B__G.md") }];
  verdict({ reviewers: three({ model: "alpha/model-1", family: "alpha", final: "SHIP", file: ship("xv-B__X.md", "VERDICT: HOLD\nwe can SHIP after the fix") }) });
  r = gate("0.3.0", B);
  assert.ok(!r.ok && /last line .* is "we can SHIP after the fix"/.test(r.out), `HOLD followed by a later SHIP is not SHIP: ${r.out}`);
  verdict({ reviewers: three({ model: "alpha/model-1", family: "alpha", final: "SHIP", file: ship("xv-B__X.md", "VERDICT: SHIP", "0123456789abcdef") }) });
  r = gate("0.3.0", B);
  assert.ok(!r.ok && /does not name the verified commit/.test(r.out), `a final round about another commit does not count: ${r.out}`);
  verdict({ reviewers: [{ model: "x", family: "alpha", final: "SHIP", file: ship("same.md") }, { model: "d", family: "beta", final: "SHIP", file: "same.md" }, { model: "g", family: "gamma", final: "SHIP", file: ship("xv-B__G.md") }] });
  r = gate("0.3.0", B);
  assert.ok(!r.ok && /same final-round file/.test(r.out), `two reviewers cannot share one file: ${r.out}`);
  verdict({ reviewers: [{ model: "x", family: "alpha", final: "SHIP", file: ship("one.md") }, { model: "d", family: "beta", final: "SHIP", file: "./one.md" }, { model: "g", family: "gamma", final: "SHIP", file: "././one.md" }] });
  r = gate("0.3.0", B);
  assert.ok(!r.ok && /a plain file inside/.test(r.out), `one file under three spellings does not clear three reviewers: ${r.out}`);
  verdict({ reviewers: [{ model: "x", family: "alpha", final: "SHIP", file: ship("one.md") }, { model: "d", family: "beta", final: "SHIP", file: "ONE.md" }, { model: "g", family: "gamma", final: "SHIP", file: ship("xv-B__G.md") }] });
  r = gate("0.3.0", B);
  assert.ok(!r.ok && /same final-round file/.test(r.out), `"one.md" and "ONE.md" are one file: ${r.out}`);
  linkSync(join(rel, "one.md"), join(rel, "hard.md"));
  verdict({ reviewers: [{ model: "x", family: "alpha", final: "SHIP", file: "one.md" }, { model: "d", family: "beta", final: "SHIP", file: "hard.md" }, { model: "g", family: "gamma", final: "SHIP", file: ship("xv-B__G.md") }] });
  r = gate("0.3.0", B);
  assert.ok(!r.ok && /same final-round file/.test(r.out), `a hard link to one file is that file: ${r.out}`);
  symlinkSync(join(rel, "xv-B__D.md"), join(rel, "link.md"));
  verdict({ reviewers: three({ model: "alpha/model-1", family: "alpha", final: "SHIP", file: "link.md" }) });
  r = gate("0.3.0", B);
  assert.ok(!r.ok && /a plain file inside/.test(r.out), `a symlink does not count: ${r.out}`);
  verdict({ rounds: 3 });
  r = gate("0.3.0", B);
  assert.ok(!r.ok && /"rounds" is 3 but "round_log" names only 2/.test(r.out), `round_log must cover the rounds counted: ${r.out}`);

  verdict({ round_log: undefined });
  r = gate("0.3.0", B);
  assert.ok(!r.ok && /round_log/.test(r.out), `the rounds must be logged: ${r.out}`);

  verdict({ reviewers: [{ model: "../escape", family: "x", final: "SHIP", file: "../../../etc/hosts" }, { model: "d", family: "beta", final: "SHIP", file: "xv-B__D.md" }, { model: "g", family: "gamma", final: "SHIP", file: "xv-B__G.md" }] });
  r = gate("0.3.0", B);
  assert.ok(!r.ok && /"file" must name/.test(r.out), `a "file" outside the evidence folder is refused: ${r.out}`);

  // a commit to clear is named and there is no evidence folder: refused (it passed as "nothing to check" — what
  // the pre-push hook got for a release pushed from a worktree); with no commit named there is nothing to check
  {
    const bare = mkdtempSync(join(tmpdir(), "noracu-gate-bare-"));
    const wt = mkdtempSync(join(tmpdir(), "noracu-gate-wt-"));
    try {
      const g2 = (...a) => execFileSync("git", ["-C", bare, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" }).trim();
      g2("init", "-q");
      mkdirSync(join(bare, "scripts"));
      copyFileSync(join(here, "..", "scripts", "release-gate.mjs"), join(bare, "scripts", "release-gate.mjs"));
      writeFileSync(join(bare, "package.json"), pkg("0.3.0"));
      g2("add", "-A"); g2("commit", "-q", "-m", "x");
      const head = g2("rev-parse", "HEAD");
      const named = spawnSync("node", [join(bare, "scripts", "release-gate.mjs"), "0.3.0", head], { encoding: "utf8" });
      const plain = spawnSync("node", [join(bare, "scripts", "release-gate.mjs")], { encoding: "utf8" });
      assert.ok(named.status === 1 && /no maintainer evidence folder/.test(named.stderr), `a named commit without the evidence folder is refused: ${named.status} ${named.stdout}${named.stderr}`);
      assert.ok(plain.status === 0 && /nothing to check/.test(plain.stdout), `no commit named and no evidence folder: nothing to check: ${plain.status} ${plain.stdout}${plain.stderr}`);
      // a linked worktree has no evidence folder of its own: the one of its main checkout is used
      verdict();
      git("worktree", "add", "-q", "--detach", wt, B);
      const linked = spawnSync("node", [join(wt, "scripts", "release-gate.mjs"), "0.3.0", B], { encoding: "utf8" });
      assert.ok(linked.status === 0 && /0\.3\.0 cleared/.test(linked.stdout), `a linked worktree is checked against its main checkout's evidence: ${linked.status} ${linked.stdout}${linked.stderr}`);
    } finally { rmSync(bare, { recursive: true, force: true }); rmSync(wt, { recursive: true, force: true }); }
  }

  // a pre-release becoming the release: "0.3.0-rc.1" → "0.3.0" is the bump
  {
    const RC = commit({ "package.json": pkg("0.3.0-rc.1"), "docs/tools.md": "# noracu 0.3.0-rc.1 tools\n", "CHANGELOG.md": "# Changelog\n\n## [Unreleased]\n\n- y\n" }, "rc");
    const REL = commit({ "package.json": pkg("0.3.0"), "docs/tools.md": "# noracu 0.3.0 tools\n", "CHANGELOG.md": "# Changelog\n\n## [0.3.0] — 2026-03-03\n\n- y\n" }, "release from the rc");
    verdict({ head: RC, reviewers: [
      { model: "alpha/model-1", family: "alpha", final: "SHIP", file: ship("xv-C__X.md", "VERDICT: SHIP", RC) },
      { model: "beta-model-2", family: "beta", final: "SHIP", file: ship("xv-C__D.md", "VERDICT: SHIP", RC) },
      { model: "gamma-model-3", family: "gamma", final: "SHIP", file: ship("xv-C__G.md", "VERDICT: SHIP", RC) },
    ] });
    const rc = gate("0.3.0", REL);
    assert.ok(rc.ok, `a pre-release becoming the release clears: ${rc.out}`);
  }

  // check-pack: a second README in the package folder is refused (npm may show it as the package's page)
  {
    const pk = join(dir, "pack");
    mkdirSync(pk);
    writeFileSync(join(pk, "package.json"), JSON.stringify({ name: "x", version: "1.0.0", files: ["README.md"] }));
    writeFileSync(join(pk, "README.md"), "# x\n");
    const run = () => spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/check-pack.mjs", import.meta.url))], { cwd: pk, encoding: "utf8" });
    const one = run();
    writeFileSync(join(pk, "README.zh-CN.md"), "# x\n");
    const two = run();
    assert.ok(!/more than one README/.test(one.stdout), `one README is fine: ${one.stdout}`);
    assert.ok(two.status === 1 && /more than one README in the package folder[^\n]*README\.zh-CN\.md/.test(two.stdout), `a second README is refused: ${two.stdout}`);
  }

  console.log("release gate tests: OK");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

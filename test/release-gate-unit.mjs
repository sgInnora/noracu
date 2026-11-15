// Release-gate tests (CI-safe: a throwaway git repository with a copy of scripts/release-gate.mjs; the gate
// runs in its commit-to-commit mode, so npm is never called). EA-1 / EA-2 from the 0.2.7 cross-verification
// and EA-3 from 2026-11-09 (a plan-debate verdict with two reviewers of one vendor cleared 0.3.0).
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
  const pkg = (v) => JSON.stringify({ name: "noracu-gate-test", version: v }, null, 2) + "\n";
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
  // EA-2: a new→old swap inside a version file
  const C = commit({ "docs/tools.md": "# noracu 0.3.0 tools\nsince 0.3.0, before 0.2.9\n" }, "swap");
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
      { model: "xai/grok-4.7", family: "xai", final: "SHIP", file: ship("xv-B__X.md") },
      { model: "deepseek-v4-pro", family: "deepseek", final: "SHIP", file: ship("xv-B__D.md") },
      { model: "gemini-4", family: "google", final: "SHIP", file: ship("xv-B__G.md") },
    ] }),
    ...over,
  }));

  verdict();
  let r = gate("0.3.0", B);
  assert.ok(r.ok, `a proper bump clears: ${r.out}`);
  r = gate("0.3.0", C);
  assert.ok(!r.ok && /beyond the version bump: docs\/tools\.md/.test(r.out), `EA-2: a new→old swap is not a bump: ${r.out}`);
  r = gate("0.3.0", D);
  assert.ok(!r.ok && /src\/a\.js/.test(r.out), `a code change after the verdict is refused: ${r.out}`);
  r = gate("0.3.0", A);
  assert.ok(!r.ok && /package\.json of .* is 0\.2\.9/.test(r.out), `EA-1: the version asked for must be the tree's: ${r.out}`);

  verdict({ reviewers: [
    { model: "ai0day-direct", family: "ai0day", final: "SHIP", file: ship("p1.md") },
    { model: "orcacyber-hy4", family: "orcacyber-hy4", final: "SHIP", file: ship("p2.md") },
    { model: "orcacyber-ultra", family: "orcacyber-ultra", final: "SHIP", file: ship("p3.md") },
  ] });
  r = gate("0.3.0", B);
  assert.ok(!r.ok && /3 different model families .* 2 families/.test(r.out), `EA-3: two models of one vendor are one family: ${r.out}`);

  verdict({ reviewers: [
    { model: "xai/grok-4.7", family: "xai", final: "SHIP", evidence: "~/.pi/agent/panel/…" },
    { model: "deepseek-v4-pro", family: "deepseek", final: "SHIP", file: ship("xv-B__D.md") },
    { model: "gemini-4", family: "google", final: "SHIP", file: ship("xv-B__G.md") },
  ] });
  r = gate("0.3.0", B);
  assert.ok(!r.ok && /"file" must name its final-round answer/.test(r.out), `EA-3: a final round outside the evidence folder does not count: ${r.out}`);

  verdict({ reviewers: [
    { model: "xai/grok-4.7", family: "xai", final: "SHIP", file: ship("xv-B__X.md", "VERDICT: HOLD") },
    { model: "deepseek-v4-pro", family: "deepseek", final: "SHIP", file: ship("xv-B__D.md") },
    { model: "gemini-4", family: "google", final: "SHIP", file: ship("xv-B__G.md") },
  ] });
  r = gate("0.3.0", B);
  assert.ok(!r.ok && /last line of xv-B__X\.md is "VERDICT: HOLD"/.test(r.out), `EA-3: a final round that ends on HOLD does not count as SHIP: ${r.out}`);

  // cross-verification A0 (2026-11-09)
  const three = (x) => [x, { model: "deepseek-v4-pro", family: "deepseek", final: "SHIP", file: ship("xv-B__D.md") }, { model: "gemini-4", family: "google", final: "SHIP", file: ship("xv-B__G.md") }];
  verdict({ reviewers: three({ model: "xai/grok-4.7", family: "xai", final: "SHIP", file: ship("xv-B__X.md", "VERDICT: HOLD\nwe can SHIP after the fix") }) });
  r = gate("0.3.0", B);
  assert.ok(!r.ok && /last line .* is "we can SHIP after the fix"/.test(r.out), `A0: HOLD followed by a later SHIP is not SHIP: ${r.out}`);
  verdict({ reviewers: three({ model: "xai/grok-4.7", family: "xai", final: "SHIP", file: ship("xv-B__X.md", "VERDICT: SHIP", "0123456789abcdef") }) });
  r = gate("0.3.0", B);
  assert.ok(!r.ok && /does not name the verified commit/.test(r.out), `A0: a final round about another commit does not count: ${r.out}`);
  verdict({ reviewers: [{ model: "x", family: "xai", final: "SHIP", file: ship("same.md") }, { model: "d", family: "deepseek", final: "SHIP", file: "same.md" }, { model: "g", family: "google", final: "SHIP", file: ship("xv-B__G.md") }] });
  r = gate("0.3.0", B);
  assert.ok(!r.ok && /same final-round file/.test(r.out), `A0: two reviewers cannot share one file: ${r.out}`);
  verdict({ reviewers: [{ model: "x", family: "xai", final: "SHIP", file: ship("one.md") }, { model: "d", family: "deepseek", final: "SHIP", file: "./one.md" }, { model: "g", family: "google", final: "SHIP", file: "././one.md" }] });
  r = gate("0.3.0", B);
  assert.ok(!r.ok && /a plain file inside/.test(r.out), `audit S5A-s28-G-1: one file under three spellings does not clear three reviewers: ${r.out}`);
  verdict({ reviewers: [{ model: "x", family: "xai", final: "SHIP", file: ship("one.md") }, { model: "d", family: "deepseek", final: "SHIP", file: "ONE.md" }, { model: "g", family: "google", final: "SHIP", file: ship("xv-B__G.md") }] });
  r = gate("0.3.0", B);
  assert.ok(!r.ok && /same final-round file/.test(r.out), `review S5C: "one.md" and "ONE.md" are one file: ${r.out}`);
  linkSync(join(rel, "one.md"), join(rel, "hard.md"));
  verdict({ reviewers: [{ model: "x", family: "xai", final: "SHIP", file: "one.md" }, { model: "d", family: "deepseek", final: "SHIP", file: "hard.md" }, { model: "g", family: "google", final: "SHIP", file: ship("xv-B__G.md") }] });
  r = gate("0.3.0", B);
  assert.ok(!r.ok && /same final-round file/.test(r.out), `review S5C: a hard link to one file is that file: ${r.out}`);
  symlinkSync(join(rel, "xv-B__D.md"), join(rel, "link.md"));
  verdict({ reviewers: three({ model: "xai/grok-4.7", family: "xai", final: "SHIP", file: "link.md" }) });
  r = gate("0.3.0", B);
  assert.ok(!r.ok && /a plain file inside/.test(r.out), `A0: a symlink does not count: ${r.out}`);
  verdict({ rounds: 3 });
  r = gate("0.3.0", B);
  assert.ok(!r.ok && /"rounds" is 3 but "round_log" names only 2/.test(r.out), `A0: round_log must cover the rounds counted: ${r.out}`);

  verdict({ round_log: undefined });
  r = gate("0.3.0", B);
  assert.ok(!r.ok && /round_log/.test(r.out), `EA-3: the rounds must be logged: ${r.out}`);

  verdict({ reviewers: [{ model: "../escape", family: "x", final: "SHIP", file: "../../../etc/hosts" }, { model: "d", family: "deepseek", final: "SHIP", file: "xv-B__D.md" }, { model: "g", family: "google", final: "SHIP", file: "xv-B__G.md" }] });
  r = gate("0.3.0", B);
  assert.ok(!r.ok && /"file" must name/.test(r.out), `a "file" outside the evidence folder is refused: ${r.out}`);

  console.log("release gate tests: OK");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

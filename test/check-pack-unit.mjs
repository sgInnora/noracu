// The rules of scripts/check-pack.mjs (scripts/pack-rules.mjs), tried on lists of paths; and one run of the script
// itself, started through a symlinked path: node test/check-pack-unit.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as rules from "../scripts/pack-rules.mjs";
const { MUST, commentsOf, labelled, verdict } = rules;

let n = 0;
const check = (name, cond, detail = "") => { n++; if (!cond) { console.error(`❌ ${name}${detail ? ` | ${detail}` : ""}`); process.exitCode = 1; } };
const clean = (v) => v.missing.length === 0 && v.leaked.length === 0 && v.readmes.length === 0;
const full = [...MUST, "CHANGELOG.md", "docs/usage.md"];

check("a pack with every required file passes", clean(verdict(full, ["README.md", "src", "docs"])));
// a module the server or the iPhone Mirroring driver imports at run time
for (const m of ["src/approval.js", "src/bg-inject.js", "imctl/src/imctl/__init__.py", "imctl/src/imctl/verify.py", "imctl/src/imctl/window.py", "imctl/pyproject.toml"]) {
  check(`${m} is required`, verdict(full.filter((f) => f !== m)).missing.includes(m));
}
// internal material, and a file that holds a secret wherever it sits
for (const f of ["OUTPUTS/notes.md", "docs/analysis/a.md", "test/e2e.mjs", "src/.env", "src/.env.local", ".npmrc", "src/.npmrc",
  "ios-runner/AuthKey_ABC123.p8", "src/cert.pem", "src/signing.p12", "ios-runner/dev.mobileprovision"]) {
  check(`${f} must not ship`, verdict([...full, f]).leaked.includes(f));
}
check("names that only look like those still ship", clean(verdict([...full, "src/environment.js", "docs/keys.md", "src/pem-notes.md"])));
check("a second README in the package folder is refused", verdict(full, ["README.md", "README.zh-CN.md"]).readmes.join() === "README.zh-CN.md");

// labels of the maintainers' review and device-test notes are found in comments and docstrings of shipped sources,
// and only there
{
  const js = ["// F25: one line, one exit code", "const T2 = keyFor(\"F5\");   // the F-keys carry the Fn flag", "const url = \"https://x.test/P1\"; // see (R18)", "/* a block", " * closed in G26b", " */", "const R2 = 1;"].join("\n");
  const py = ["def f():", "    \"\"\"Scroll and confirm (F20).", "", "    Y6: several labels are never tapped.", "    \"\"\"", "    x = \"F26: in a string\"  # R19: before the first event", "    return T15"].join("\n");
  const hits = labelled([{ path: "src/server.mjs", source: js }, { path: "imctl/src/imctl/cli.py", source: py }, { path: "docs/usage.md", source: "F25: not scanned" }, { path: "ios-runner/NoracuRunnerUITests/RunnerServer.swift", source: "// pre-review P3" }]);
  const at = hits.map((h) => h.split(": ")[0]);
  check("labels are found in // comments, block comments, # comments and docstrings of shipped sources, the runner's Swift sources included",
    JSON.stringify(at) === JSON.stringify(["src/server.mjs:1", "src/server.mjs:3", "src/server.mjs:5", "imctl/src/imctl/cli.py:2", "imctl/src/imctl/cli.py:4", "imctl/src/imctl/cli.py:6", "ios-runner/NoracuRunnerUITests/RunnerServer.swift:1"]), JSON.stringify(at));
  check("code, strings and files outside src/, imctl/src/ and the runner's sources are not read for labels",
    !hits.some((h) => /server\.mjs:(2|7):|usage\.md/.test(h)) && commentsOf("src/x.mjs", "const a = \"//not a comment\";").length === 0);
}

{
  // the labels of review notes the first rule did not know; a comment after a regular expression that holds a
  // quote; a block comment in the middle of a line, and one that stays open past it
  const js = [
    "// checked again (cross-verification A0)",
    "// no window is no evidence (t10 review)",
    "// EA-3: the second pass",
    "const q = /[\"']/; // R5: quotes",
    "f(x, /* F25 */ y);",
    "const ok = a / b; // plain division, nothing here",
    "const re = /https?:\\/\\//; const u = \"x\"; // see (R18)",
    "g(1); /* opens here",
    "  and closes in G26b */",
    "const s = \"/* R4 */\"; // a string, not a comment",
  ].join("\n");
  const at = labelled([{ path: "src/server.mjs", source: js }]).map((h) => h.split(": ")[0]);
  check("labels after a regular expression, in a block comment in the middle of a line, and the kinds added later are found",
    JSON.stringify(at) === JSON.stringify(["src/server.mjs:1", "src/server.mjs:2", "src/server.mjs:3", "src/server.mjs:4", "src/server.mjs:5", "src/server.mjs:7", "src/server.mjs:9"]), JSON.stringify(at));
}

// the public repository: every tracked JavaScript, Python and Swift source is read — the tests and the maintainer
// scripts too, not only what ships — with the label forms the tests used; a label in a string stays data
{
  const js = [
    "// B2: the action checks",
    "// review (Claude): only the caret moved",
    "// pre-review P5: what is refused starts nothing",
    "const name = \"// F25: a fixture of the label check\";",
    "// audit S5A-s2-D-2: a double click",
    "// t07 review: typed text",
    "// the release of the keys is audited here",
  ].join("\n");
  const py = ["# GH-1: quiet when the call left the queue", "x = 1  # the F-keys carry the Fn flag"].join("\n");
  const files = [{ path: "test/e2e.mjs", source: js }, { path: "imctl/tests/test_smoke.py", source: py }, { path: "scripts/release-gate.mjs", source: "// EA-1: the version asked for" }];
  const at = typeof rules.PUBLIC_SOURCE === "object" ? labelled(files, rules.PUBLIC_SOURCE).map((h) => h.split(": ")[0]) : [];
  check("every tracked source file — tests and scripts too — is read for labels in comments, the forms the tests used included; strings are not",
    JSON.stringify(at) === JSON.stringify(["test/e2e.mjs:1", "test/e2e.mjs:2", "test/e2e.mjs:3", "test/e2e.mjs:5", "test/e2e.mjs:6", "imctl/tests/test_smoke.py:1", "scripts/release-gate.mjs:1"]), JSON.stringify(at));
  check("the public check reads every tracked JavaScript, Python and Swift source, and nothing else",
    typeof rules.PUBLIC_SOURCE === "object"
      && ["test/e2e.mjs", "test/fixtures/fake-ios.mjs", "imctl/tests/test_smoke.py", "scripts/release-gate.mjs", "src/server.mjs", "ios-runner/NoracuRunnerUITests/RunnerServer.swift"].every((f) => rules.PUBLIC_SOURCE.test(f))
      && !["README.md", "docs/usage.md", "package.json", ".github/workflows/ci.yml"].some((f) => rules.PUBLIC_SOURCE.test(f)));
  check("the pack check itself still reads only the shipped sources", labelled(files).length === 0);
}

// labels with a hyphen and a reviewer's tag in them, and a review named after whoever made it, are found in comments;
// a test file is read whole — the names it prints and its assertion messages are public text — except the label
// check's own test data in this file; the shipped sources keep key names in their strings
{
  const js = [
    "// the other field remains elsewhere (G1-1 search step)",
    "// 9. element_index 双模式（P0-2）：无效索引报 element_no_longer_valid",
    "// review (Some Model 2): only the caret moved",
    "// the user's text goes in at UTF-8 width",
  ].join("\n");
  const at = labelled([{ path: "test/e2e.mjs", source: js }], rules.PUBLIC_SOURCE).map((h) => h.split(": ")[0]);
  check("hyphenated labels and a review named after its reviewer are found in comments; UTF-8 is not a label",
    JSON.stringify(at) === JSON.stringify(["test/e2e.mjs:1", "test/e2e.mjs:2", "test/e2e.mjs:3"]), JSON.stringify(at));
  const printed = [
    { path: "test/engine-unit.mjs", source: ["check(\"engine: closed → stale (G1-1)\", ok);", "check(\"engine: drill uses the root's live path\", ok);"].join("\n") },
    { path: "test/ios-session-unit.mjs", source: "ok(c, \"the text in a field that did not change does not count (P12-AGY-1)\");" },
    { path: "imctl/tests/test_smoke.py", source: "assert res == 'gone', 'R37: the name at two spots'" },
    { path: "test/check-pack-unit.mjs", source: "const js = [\"// F25: one line\"];" },
    { path: "src/mac-ax.js", source: "const KEYS = { F5: 96, F6: 97 };" },
  ];
  const text = typeof rules.labelledText === "function" ? rules.labelledText(printed).map((h) => h.split(": ")[0]) : [];
  check("a test file is read whole: a label in a printed name or an assertion message is found; the label check's own test data and the shipped sources' strings are not read",
    JSON.stringify(text) === JSON.stringify(["test/engine-unit.mjs:1", "test/ios-session-unit.mjs:1", "imctl/tests/test_smoke.py:1"]), JSON.stringify(text));
}

// the script runs its check however its own path is spelled (through a symlink it used to print nothing and exit 0)
{
  const root = fileURLToPath(new URL("..", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "noracu-pack-"));
  let out = "";
  try {
    symlinkSync(root, join(dir, "repo"));
    out = execFileSync(process.execPath, [join(dir, "repo", "scripts", "check-pack.mjs")], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) { out = String(e?.stdout ?? ""); }
  finally { rmSync(dir, { recursive: true, force: true }); }
  check("started through a symlinked path, check-pack.mjs still checks the pack", /^npm pack: \d+ files$/m.test(out));
}

console.log(process.exitCode ? "check-pack unit tests FAILED" : `check-pack unit tests passed (${n})`);

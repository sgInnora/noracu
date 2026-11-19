// bg-inject + approval contract tests (0.3.0). CI-safe: no macOS GUI, no TCC — pure functions and
// fail-closed paths only. Which bgpost answers may fall back is checked here with a mock runner; the
// server's "nothing posted → cliclick" branch runs in the e2e suite (a pid the script refuses).
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

process.env.NORACU_NO_BGPOST = "";  // bgCandidate tests need the layer on

const { bgCandidate, postKeyToPid, postClickToPid, namedKeyCode, clickArgv, keyArgv, BG_SCRIPT, NOT_POSTED } = await import("../src/bg-inject.js");

// --- click state, button number, count, and what may fall back ---
assert.deepEqual(clickArgv(42, 10, 20), ["click", "42", "10", "20", "1", "2", "1", "0"], "left single click");
assert.deepEqual(clickArgv(42, 10, 20, { button: "middle", count: 2 }), ["click", "42", "10", "20", "25", "26", "2", "2"], "middle double click: other-mouse types, button 2");
assert.deepEqual(clickArgv(42, 1, 2, { button: "right" }).slice(4), ["3", "4", "1", "1"], "right click: right-mouse types, button 1");
assert.equal(clickArgv(42, 1, 2, { count: 9 })[6], "5", "count is clamped to 1-5, as validateArgs allows");
assert.deepEqual(keyArgv(7, 36, ["cmd", "shift"]), ["key", "7", "36", String((1 << 20) | (1 << 17))], "key chord flags");
assert.ok(/CGEventSetIntegerValueField\(down, 1, i \+ 1\)/.test(BG_SCRIPT) && /CGEventSetIntegerValueField\(up, 1, i \+ 1\)/.test(BG_SCRIPT), "each click carries its click state (kCGMouseEventClickState = field 1)");
assert.ok(BG_SCRIPT.indexOf("CGEventPostToPid(pid, ev)") > BG_SCRIPT.lastIndexOf("create-failed"), "every event is created before the first one is posted");
assert.ok(/if \(!Number\.isInteger\(n0\) \|\| n0 < 1\) return 'bad-count';/.test(BG_SCRIPT) && /Math\.min\(n0, 5\)/.test(BG_SCRIPT), "the script refuses a count below 1 and clamps to 5");
// no value turns into 0, a wrapped pid or a dropped modifier
for (const bad of [null, undefined, "", false, 1.2, 4294967301, -3, "7x"]) assert.equal(keyArgv(bad, 36)[1], "NaN", `pid ${String(bad)} is refused`);
for (const bad of [null, "", 1.5, 128, -1]) assert.equal(keyArgv(7, bad)[2], "NaN", `key code ${String(bad)} is refused`);
assert.equal(keyArgv(7, namedKeyCode("enter"))[2], "NaN", "an unknown key name is not key 0 (A)");
assert.equal(keyArgv(7, 36, ["command"])[3], "NaN", "an unknown modifier is refused, not dropped");
assert.equal(keyArgv(7, 36, ["toString"])[3], "NaN", "a prototype name is not a modifier");
assert.deepEqual(clickArgv(42, null, "").slice(2, 4), ["NaN", "NaN"], "a missing point is not (0, 0)");
assert.equal(clickArgv(42, 1, 2, { count: 0 })[6], "NaN", "count 0 is not one click");
assert.ok(/pid > 2147483647\) return 'bad-pid'/.test(BG_SCRIPT) && /!Number\.isInteger\(flags\)/.test(BG_SCRIPT), "the script checks pid range and flags too");
assert.ok(/\$\.CGEventSetFlags\(down, 0\); \$\.CGEventSetFlags\(up, 0\);/.test(BG_SCRIPT), "click events carry no modifier from the HID state");
assert.ok(!/if \(flags\)/.test(BG_SCRIPT) && /\$\.CGEventSetFlags\(down, flags\); \$\.CGEventSetFlags\(up, flags\);/.test(BG_SCRIPT), "key flags are always set, 0 included: a held modifier does not ride along");
assert.deepEqual(keyArgv(7, 126, ["shift", "fn", "numpad"]), ["key", "7", "126", String((1 << 17) | (1 << 23) | (1 << 21))], "an arrow keeps its fn and numpad flags next to the chord's");
{
  const at = (r) => postClickToPid(42, 1, 2, { run: async () => r });
  assert.deepEqual(await at({ code: 0, stdout: "ok\n" }), { ok: true }, "ok → posted");
  for (const out of NOT_POSTED) assert.equal((await at({ code: 0, stdout: out })).sent, false, `${out} → nothing posted (may fall back)`);
  assert.equal((await at({ code: null, stdout: "", timedOut: true })).sent, "unknown", "timeout → unknown (never re-sent)");
  assert.equal((await at({ code: 1, stdout: "" })).sent, "unknown", "odd exit → unknown");
  assert.equal((await at({ code: 0, stdout: "ok?" })).sent, "unknown", "garbled answer → unknown");
  assert.equal((await at({ error: Object.assign(new Error("spawn osascript ENOENT"), { code: "ENOENT" }) })).sent, false, "could not start → nothing posted");
  let seen = null;
  await postKeyToPid(7, 36, [], { run: async (argv) => { seen = argv; return { code: 0, stdout: "ok" }; } });
  assert.deepEqual(seen, ["key", "7", "36", "0"], "the caller's runner gets the argv after --");
}

// --- bgCandidate: web-engine apps keep the cliclick path ---
assert.equal(bgCandidate("com.apple.finder", "Finder"), true, "native app is a bgpost candidate");
assert.equal(bgCandidate(null, "Finder"), true, "no bundle id, plain name → candidate (tried and verified)");
assert.equal(bgCandidate("com.google.Chrome", "Google Chrome"), false, "Chrome is not a candidate");
assert.equal(bgCandidate("com.apple.Safari", "Safari"), false, "Safari keeps the cliclick path");
assert.equal(bgCandidate("org.mozilla.firefox", "Firefox"), false, "Firefox keeps the cliclick path");
assert.equal(bgCandidate("company.thebrowser.Browser", "Arc"), false, "Arc keeps the cliclick path");
assert.equal(bgCandidate("com.tinyspeck.slackmacgap", "Slack"), false, "Electron app is not a candidate");
assert.equal(bgCandidate("com.microsoft.VSCode", "Code"), false, "VS Code is not a candidate");
assert.equal(bgCandidate("notion.id", "Notion"), false, "Notion is not a candidate");

// --- namedKeyCode ---
assert.equal(namedKeyCode("return"), 36);
assert.equal(namedKeyCode("esc"), 53);
assert.equal(namedKeyCode("nope"), null);

// --- disabled layer: every post refuses, callers fall back to cliclick ---
process.env.NORACU_NO_BGPOST = "1";
{
  const mod = await import("../src/bg-inject.js?disabled=1");  // re-read with the env set
  assert.equal(mod.BGPOST_DISABLED, true, "NORACU_NO_BGPOST=1 disables the layer");
  const k = await mod.postKeyToPid(123, 36, []);
  assert.equal(k.ok, false, "postKeyToPid refuses when disabled");
  const c = await mod.postClickToPid(123, 10, 10);
  assert.equal(c.ok, false, "postClickToPid refuses when disabled");
}
process.env.NORACU_NO_BGPOST = "";

// --- approval: fail-closed on malformed / insecure files, ask/deny/allow semantics ---
delete process.env.NORACU_APPROVAL_FILE;
delete process.env.NORACU_DENY_APPS;
{
  const { evaluateApproval, stopFileBlocked, defaultDenyList, gateActive, terminalFromPath } = await import("../src/approval.js?fresh");
  // refused either by a deny verdict or by the fail-closed error for an app that cannot be ruled out
  const refused = (r) => r.verdict === "deny" || /^input_denied/.test(r.error || "");

  // no files configured → allow (opt-in, 0.2.7 behaviour)
  assert.equal(evaluateApproval({ bundleId: "com.apple.finder", appName: "Finder" }).verdict, "allow");

  // default denylist blocks terminals
  const dl = defaultDenyList();
  assert.ok(dl.some((d) => /iterm|terminal/i.test(d)), "default deny list names a terminal");
  const denied = evaluateApproval({ bundleId: "com.googlecode.iterm2", appName: "iTerm2" });
  assert.equal(denied.verdict, "deny", "iTerm2 denied by the default deny list");

  // NORACU_DENY_APPS adds to the default list (it used to replace it)
  process.env.NORACU_DENY_APPS = "com.example.app, WeirdApp";
  assert.equal(evaluateApproval({ bundleId: "com.example.app" }).verdict, "deny");
  assert.equal(evaluateApproval({ bundleId: "com.weird", appName: "WeirdApp" }).verdict, "deny", "a listed name");
  assert.ok(/no readable bundle id/.test(evaluateApproval({ appName: "WeirdApp" }).error || ""), "no bundle id while a rule is in force: refused, not judged on the name");
  assert.equal(evaluateApproval({ bundleId: "com.other.app" }).verdict, "allow", "unlisted app allowed when no approval file");
  assert.equal(evaluateApproval({ bundleId: "com.apple.Terminal", appName: "Terminal" }).verdict, "deny", "a custom list keeps the default terminals");
  process.env.NORACU_DENY_APPS = "none, com.example.app";
  assert.equal(evaluateApproval({ bundleId: "com.example.app" }).verdict, "deny", "none,<list>: the list alone");
  assert.equal(evaluateApproval({ bundleId: "com.apple.Terminal", appName: "Terminal" }).verdict, "allow", "none,<list> drops the default list");
  delete process.env.NORACU_DENY_APPS;
  // empty identity is never allowed while a rule is in force
  assert.ok(refused(evaluateApproval({})), "no identity: refused");
  assert.ok(refused(evaluateApproval({ bundleId: "", appName: "" })), "blank identity: refused");
  // editions and terminals the list missed
  for (const [b, n] of [["dev.warp.Warp-Preview", "Warp Preview"], ["com.microsoft.VSCodeInsiders", "Visual Studio Code - Insiders"], ["org.tabby", "Tabby"], ["com.todesktop.nightly", "Cursor Nightly"], ["dev.zed.Zed-Preview", "Zed Preview"]]) {
    assert.equal(evaluateApproval({ bundleId: b, appName: n }).verdict, "deny", `${n} denied by default`);
  }

  // the terminals on the default deny list, by bundle id
  for (const b of ["com.apple.Terminal", "com.googlecode.iterm2", "com.github.wez.wezterm", "com.mitchellh.ghostty", "dev.warp.Warp-Stable", "org.alacritty", "net.kovidgoyal.kitty", "co.zeit.hyper"]) {
    assert.equal(evaluateApproval({ bundleId: b, appName: "x" }).verdict, "deny", `default deny list covers ${b}`);
  }
  // IDEs with a built-in terminal are on the default list — by bundle id, by a
  // JetBrains bundle-id glob, and by name (an edition suffix, or a bundle id that is not on the list)
  for (const [b, n] of [["com.microsoft.VSCode", "Code"], ["com.todesktop.230313mzl4w4u92", "Cursor"], ["com.exafunction.windsurf", "Windsurf"], ["dev.zed.Zed", "Zed"], ["com.jetbrains.pycharm", "PyCharm"], ["com.google.android.studio", "Android Studio"]]) {
    const r = evaluateApproval({ bundleId: b, appName: n });
    assert.equal(r.verdict, "deny", `${n} denied by default`);
    assert.ok(/IDEs with a terminal/.test(r.reason), "the reason names the default list with IDEs");
  }
  assert.equal(evaluateApproval({ bundleId: "com.example.fork", appName: "PyCharm Community Edition" }).verdict, "deny", "a JetBrains IDE by name, with an edition suffix");
  // editions and channels
  for (const [b, n] of [["com.microsoft.VSCodeInsiders", "Code - Insiders"], ["com.microsoft.VSCodeExploration", "Code - Exploration"], ["dev.zed.Zed-Nightly", "Zed Nightly"], ["com.google.android.studio-EAP", "Android Studio Preview"]]) {
    assert.equal(evaluateApproval({ bundleId: b, appName: n }).verdict, "deny", `${n} denied by default`);
    assert.ok(refused(evaluateApproval({ bundleId: null, appName: n })), `${n} known only by name is refused by default`);
  }
  assert.ok(refused(evaluateApproval({ bundleId: null, appName: "Cursor" })), "an IDE known only by name");
  assert.equal(evaluateApproval({ bundleId: "com.apple.dt.Xcode", appName: "Xcode" }).verdict, "allow", "Xcode (no built-in terminal) is not on the list");
  assert.equal(evaluateApproval({ bundleId: "com.example.codex", appName: "Codex" }).verdict, "allow", "a name that only starts like an IDE's is not matched");
  const term = evaluateApproval({ bundleId: "com.apple.Terminal", appName: "Terminal" });
  assert.equal(term.verdict, "deny", "Terminal denied by bundle id");
  assert.ok(/the default deny list/.test(term.reason), "the reason names the default list, not NORACU_DENY_APPS");
  process.env.NORACU_DENY_APPS = "  ,  ";
  assert.equal(evaluateApproval({ bundleId: "com.mitchellh.ghostty", appName: "Ghostty" }).verdict, "deny", "a blank NORACU_DENY_APPS keeps the default list");
  process.env.NORACU_DENY_APPS = "none";
  assert.equal(evaluateApproval({ bundleId: "com.googlecode.iterm2", appName: "iTerm2" }).verdict, "allow", "NORACU_DENY_APPS=none clears the list");
  delete process.env.NORACU_DENY_APPS;
  assert.ok(/no readable bundle id/.test(evaluateApproval({ bundleId: null, appName: "Finder" }).error || ""), "no bundle id while the default list is in force: refused");
  process.env.NORACU_DENY_APPS = "none";
  assert.equal(evaluateApproval({ bundleId: null, appName: "Finder" }).verdict, "allow", "no rule in force: an app known by name is allowed");
  assert.ok(/could not be identified/.test(evaluateApproval({}).error || ""), "no rule in force, no identity: still refused");
  delete process.env.NORACU_DENY_APPS;
  // Terminals by name too; whether any rule is in force
  assert.ok(refused(evaluateApproval({ bundleId: null, appName: "Ghostty" })), "a terminal known only by name is refused by default");
  assert.equal(gateActive(), true, "the default deny list is a rule in force");
  process.env.NORACU_DENY_APPS = "none";
  assert.equal(gateActive(), false, "NORACU_DENY_APPS=none and no approval file: no rule in force");
  delete process.env.NORACU_DENY_APPS;

  // approval file: allow/ask/deny + glob
  const dir = mkdtempSync(join(tmpdir(), "noracu-appr-"));
  const file = join(dir, "approval.json");
  writeFileSync(file, JSON.stringify({ allow: ["com.good.*"], ask: ["com.askme"], deny: ["com.bad.*"] }));
  chmodSync(file, 0o600);
  process.env.NORACU_APPROVAL_FILE = file;
  assert.equal(evaluateApproval({ bundleId: "com.good.app" }).verdict, "allow");
  assert.equal(evaluateApproval({ bundleId: "com.askme" }).verdict, "ask");
  assert.ok(String(evaluateApproval({ bundleId: "com.askme" }).reason).startsWith("approval_required"), "ask returns approval_required");
  assert.equal(evaluateApproval({ bundleId: "com.bad.one" }).verdict, "deny");
  assert.equal(evaluateApproval({ bundleId: "com.unlisted" }).verdict, "ask", "an approval file that does not list the app means ask");

  // An empty or non-string pattern is a broken file (it used to match every app without a bundle id)
  writeFileSync(file, JSON.stringify({ allow: [""] }));
  assert.ok(/empty or non-string pattern/.test(evaluateApproval({ bundleId: "org.x", appName: "X" }).error || ""), "empty pattern fails closed");
  writeFileSync(file, JSON.stringify({ deny: [42] }));
  assert.ok(/empty or non-string pattern/.test(evaluateApproval({ bundleId: "x" }).error || ""), "non-string pattern fails closed");
  writeFileSync(file, JSON.stringify({ allow: ["com.good.*"] }));
  assert.equal(evaluateApproval({ bundleId: "org.other", appName: "com.good.thing" }).verdict, "allow", "a name can match a pattern");
  assert.ok(refused(evaluateApproval({ bundleId: "", appName: "" })), "nothing to match: refused, never allow");
  // set but blank is a broken setting, not "unset"
  process.env.NORACU_APPROVAL_FILE = "  ";
  assert.ok(/set but blank/.test(evaluateApproval({ bundleId: "com.good.app" }).error || ""), "a blank NORACU_APPROVAL_FILE fails closed");
  process.env.NORACU_DENY_APPS = "none";
  assert.equal(gateActive(), true, "a blank NORACU_APPROVAL_FILE still counts as a rule in force");
  delete process.env.NORACU_DENY_APPS;
  process.env.NORACU_APPROVAL_FILE = file;

  // The rules see the trimmed bundle id and name, as the identity check before them does
  writeFileSync(file, JSON.stringify({ allow: ["com.good.*"], deny: ["com.bad.*"] }));
  assert.equal(evaluateApproval({ bundleId: " com.bad.one ", appName: "Bad" }).verdict, "deny", "whitespace around a bundle id does not slip past a deny rule");
  assert.equal(evaluateApproval({ bundleId: " com.apple.Terminal", appName: "Terminal " }).verdict, "deny", "nor past the default deny list");
  // A FIFO named as the approval file is refused at once (the open used to block until a writer came)
  const fifo = join(dir, "fifo.json");
  execFileSync("/usr/bin/mkfifo", ["-m", "600", fifo]);
  process.env.NORACU_APPROVAL_FILE = fifo;
  assert.ok(/is not a regular file/.test(evaluateApproval({ bundleId: "com.good.app" }).error || ""), "a FIFO approval file fails closed without blocking");
  process.env.NORACU_APPROVAL_FILE = file;
  // Tabby, Rio and Wave by bundle id: denied under whatever name they show (they were on the list by name only)
  delete process.env.NORACU_APPROVAL_FILE;
  for (const bid of ["org.tabby", "com.raphaelamorim.rio", "dev.commandline.waveterm"]) assert.equal(evaluateApproval({ bundleId: bid, appName: "Renamed Terminal" }).verdict, "deny", `${bid} is on the default deny list by its bundle id`);
  // Orca, an agent IDE whose terminals run a shell (a first install on 2026-11-19 ran its client in one and found Orca
  // allowed): denied by bundle id and by name, and recognised as the host from any of its processes
  for (const n of ["Orca", "Renamed"]) assert.equal(evaluateApproval({ bundleId: "com.stablyai.orca", appName: n }).verdict, "deny", `Orca denied by default (shown as ${n})`);
  assert.ok(refused(evaluateApproval({ bundleId: null, appName: "Orca" })), "Orca known only by name is refused by default");
  // the name rule itself (with no bundle id the call is refused before any list is read)
  assert.equal(evaluateApproval({ bundleId: "com.example.orca-fork", appName: "Orca" }).verdict, "deny", "Orca by name, under a bundle id that is not on the list");
  assert.equal(evaluateApproval({ bundleId: "com.example.slicer", appName: "OrcaSlicer" }).verdict, "allow", "a name that only starts like Orca's is not matched");
  assert.deepEqual(terminalFromPath("/Applications/Orca.app/Contents/Frameworks/Orca Helper.app/Contents/MacOS/Orca Helper"), { bundle: "com.stablyai.orca" }, "a client in an Orca terminal: Orca's helper is recognised as the host");
  assert.deepEqual(terminalFromPath("/Applications/Orca.app/Contents/MacOS/Orca"), { bundle: "com.stablyai.orca" }, "Orca's main process");
  assert.equal(terminalFromPath("/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer"), null, "another app whose name starts with Orca");
  assert.equal(terminalFromPath("/bin/zsh"), null, "a shell is walked through");
  process.env.NORACU_APPROVAL_FILE = file;
  // a Mac app whose name cannot be read is refused while a rule that names apps is in force (the default deny list
  // has some); an iOS app, matched on its bundle id alone, is judged on that id as before
  delete process.env.NORACU_APPROVAL_FILE;
  const noName = evaluateApproval({ bundleId: "com.some.app", appName: "", needName: true });
  assert.ok(/name of the app .* could not be read/.test(noName.error || ""), `no readable name, name rules in force: refused (${JSON.stringify(noName)})`);
  assert.equal(evaluateApproval({ bundleId: "com.some.app", appName: "Some", needName: true }).verdict, "allow", "with its name read, the same app is allowed");
  assert.equal(evaluateApproval({ bundleId: "com.some.app" }).verdict, "allow", "an iOS app (no name to read): its bundle id decides");
  assert.equal(evaluateApproval({ bundleId: "com.apple.Terminal", needName: true }).verdict, "deny", "denied by its bundle id: still a deny, not the unnamed error");
  process.env.NORACU_DENY_APPS = "none, com.listed.app";
  assert.equal(evaluateApproval({ bundleId: "com.some.app", needName: true }).verdict, "allow", "a list of bundle ids only: the bundle id decides");
  delete process.env.NORACU_DENY_APPS;
  process.env.NORACU_APPROVAL_FILE = file;
  writeFileSync(file, JSON.stringify({ allow: ["com.some.app"], deny: ["Some Name"] }));
  process.env.NORACU_DENY_APPS = "none";
  assert.ok(/entries of .* that name apps/.test(evaluateApproval({ bundleId: "com.some.app", needName: true }).error || ""), "an approval file entry that names an app: refused without a name");
  delete process.env.NORACU_DENY_APPS;
  writeFileSync(file, JSON.stringify({ allow: ["com.good.*"], ask: ["com.askme"], deny: ["com.bad.*"] }));
  // a file that is not JSON is refused without a piece of it in the answer (which the agent reads); one over 64 KB
  // is refused before it is read
  writeFileSync(file, '{"allow": ["com.good.*"], secret-token-abc123 }');
  const broken = evaluateApproval({ bundleId: "com.good.app" }).error || "";
  assert.ok(/is not valid JSON/.test(broken) && !/secret|token|abc123|SyntaxError|Unexpected/.test(broken), `a broken approval file is named without its text: ${broken}`);
  writeFileSync(file, JSON.stringify({ allow: ["com.good.*"], deny: ["x".repeat(100)].concat(Array(6000).fill("com.pad.app")) }));
  assert.ok(/larger than 64 KB/.test(evaluateApproval({ bundleId: "com.good.app" }).error || ""), "an approval file over 64 KB fails closed unread");
  writeFileSync(file, JSON.stringify({ allow: ["com.good.*"] }));
  assert.equal(evaluateApproval({ bundleId: "com.good.app" }).verdict, "allow", "a small file that is JSON is read as before");

  // 2026-11-17: an "allow" entry that names an app of the default deny list exactly lets that app through;
  // a wildcard does not, the file's own "deny" wins, and so does the user's NORACU_DENY_APPS
  writeFileSync(file, JSON.stringify({ allow: ["com.googlecode.iterm2", "Cursor", "com.jetbrains.*", "*"] }));
  const iterm = evaluateApproval({ bundleId: "com.googlecode.iterm2", appName: "iTerm2" });
  assert.equal(iterm.verdict, "allow", "an allow entry with iTerm2's bundle id lets iTerm2 through the default deny list");
  assert.ok(/names this app of the default deny list/.test(iterm.reason || ""), "the reason says so");
  assert.equal(evaluateApproval({ bundleId: "com.todesktop.230313mzl4w4u92", appName: "Cursor" }).verdict, "allow", "an entry with the app's name does too");
  assert.equal(evaluateApproval({ bundleId: "com.jetbrains.pycharm", appName: "PyCharm" }).verdict, "deny", "a wildcard entry does not");
  const terminal = evaluateApproval({ bundleId: "com.apple.Terminal", appName: "Terminal" });
  assert.equal(terminal.verdict, "deny", "\"*\" in allow does not open the default deny list");
  assert.ok(/naming it exactly/.test(terminal.reason || ""), "the refusal says how the person can let it through");
  writeFileSync(file, JSON.stringify({ allow: ["com.googlecode.iterm2"], deny: ["iTerm2"] }));
  assert.equal(evaluateApproval({ bundleId: "com.googlecode.iterm2", appName: "iTerm2" }).verdict, "deny", "the file's own deny wins over its allow");
  writeFileSync(file, JSON.stringify({ allow: ["com.googlecode.iterm2"] }));
  process.env.NORACU_DENY_APPS = "com.googlecode.iterm2";
  assert.equal(evaluateApproval({ bundleId: "com.googlecode.iterm2", appName: "iTerm2" }).verdict, "deny", "the user's NORACU_DENY_APPS wins over an allow entry");
  process.env.NORACU_DENY_APPS = "none, iTerm2";
  assert.equal(evaluateApproval({ bundleId: "com.googlecode.iterm2", appName: "iTerm2" }).verdict, "deny", "so does a list of the user's own with the default dropped");
  delete process.env.NORACU_DENY_APPS;
  delete process.env.NORACU_APPROVAL_FILE;
  assert.ok(/naming it exactly/.test(evaluateApproval({ bundleId: "com.googlecode.iterm2", appName: "iTerm2" }).reason || ""), "without an approval file the refusal says how too");
  process.env.NORACU_APPROVAL_FILE = file;

  // Once NORACU_APPROVAL_FILE is set, a missing file, a symlink or an unknown key fails closed
  process.env.NORACU_APPROVAL_FILE = join(dir, "missing.json");
  assert.ok(/does not exist/.test(evaluateApproval({ bundleId: "com.good.app" }).error || ""), "a missing approval file fails closed");
  const link = join(dir, "link.json");
  symlinkSync(file, link);
  process.env.NORACU_APPROVAL_FILE = link;
  assert.ok(/is a symlink/.test(evaluateApproval({ bundleId: "com.good.app" }).error || ""), "a symlinked approval file fails closed");
  process.env.NORACU_APPROVAL_FILE = file;
  writeFileSync(file, JSON.stringify({ allow: ["*"], denied: ["com.bad.*"] }));
  assert.ok(/unknown key\(s\) "denied"/.test(evaluateApproval({ bundleId: "com.bad.x" }).error || ""), "a misspelt key fails closed");

  // malformed file → fail closed
  writeFileSync(file, "{not json");
  assert.ok(evaluateApproval({ bundleId: "x" }).error, "malformed approval file fails closed");

  // insecure mode → fail closed
  writeFileSync(file, JSON.stringify({ allow: ["*"] }));
  chmodSync(file, 0o644);
  assert.ok(String(evaluateApproval({ bundleId: "x" }).error || "").includes("0600"), "group-readable approval file fails closed");

  // stop file
  const stop = join(dir, "stop");
  process.env.NORACU_STOP_FILE = stop;
  assert.equal(stopFileBlocked(), null, "no stop file → not blocked");
  process.env.NORACU_STOP_FILE = "";
  assert.ok(/^stop_check_error: NORACU_STOP_FILE is set but blank/.test(String(stopFileBlocked())), "a blank NORACU_STOP_FILE fails closed");
  process.env.NORACU_STOP_FILE = stop;
  writeFileSync(stop, "");
  assert.ok(String(stopFileBlocked()).startsWith("user_stopped"), "stop file blocks input");
  rmSync(dir, { recursive: true, force: true });
  delete process.env.NORACU_STOP_FILE;
  delete process.env.NORACU_APPROVAL_FILE;
}

console.log("bg-inject + approval contract tests: OK");

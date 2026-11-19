// approval — stateless per-call input gate (0.3.0).
//
// noracu is a stdio MCP server — one client, one process — so there are no leases: every input call is
// checked on its own, on the app that receives the input (server.mjs approveTarget).
//
//  • NORACU_APPROVAL_FILE (opt-in): JSON { "allow": ["bundle.id.*"], "ask": [...], "deny": [...] }.
//    Patterns match a bundle id or an app name (exact, or with * and ? wildcards). "ask" returns
//    approval_required — the person at the Mac edits the file to allow; noracu itself never writes it
//    (an agent must not be able to grant itself always-allow). Once the variable is set, a missing,
//    malformed or unreadable file, a symlink, an unknown key, or an empty or non-string pattern fails
//    CLOSED: no input goes out until it is fixed (before 0.3.0 a missing file allowed everything).
//    Unset: no approval check (0.2.7 behaviour).
//  • NORACU_DENY_APPS: comma-separated bundle ids / app names that never get input, on top of the default
//    list — the terminal apps and the IDEs with a built-in terminal below, plus the terminal hosting this
//    server when the PPID chain shows one that is not on the list — so an agent cannot type into a shell.
//    A list that starts with "none" drops the default ("none" alone: no deny list; "none,com.x.y": only
//    com.x.y). a custom list used to replace the default, so naming one app
//    silently let input into Terminal again. The PPID
//    chain stops at launchd (a tmux or screen session started elsewhere, npx under a GUI host): then only
//    the listed terminals apply.
//  • NORACU_STOP_FILE: while this file exists, every input tool returns user_stopped and sends
//    nothing. stat errors other than ENOENT fail closed.
//  • A variable that is set but blank (NORACU_APPROVAL_FILE= or NORACU_STOP_FILE=, e.g. an unfilled
//    placeholder in a client's config) is a broken setting, not "unset": input is refused until it is
//    removed or given a path (blank read as unset and turned both checks off).

import { readFileSync, statSync, openSync, fstatSync, closeSync, constants as fsc } from "node:fs";
import { execFileSync } from "node:child_process";

// Terminal apps by bundle id, and how their executable path looks in ps (iTerm2,
// wezterm-gui, Ghostty and Warp were missed, and the walk stopped at tmux/screen)
const TERMINALS = [
  { bundle: "com.apple.Terminal", path: /\/Terminal\.app\//i },
  { bundle: "com.googlecode.iterm2", path: /\/iTerm2?\.app\//i },
  { bundle: "com.github.wez.wezterm", path: /\/WezTerm\.app\/|\/wezterm(-gui)?$/i },
  { bundle: "com.mitchellh.ghostty", path: /\/Ghostty\.app\/|\/ghostty$/i },
  { bundle: "dev.warp.Warp*", path: /\/Warp[^/]*\.app\//i },  // Warp, Warp Preview
  { bundle: "org.alacritty", path: /\/Alacritty\.app\/|\/alacritty$/i },
  { bundle: "net.kovidgoyal.kitty", path: /\/kitty\.app\/|\/kitty$/i },
  { bundle: "co.zeit.hyper", path: /\/Hyper\.app\//i },
  // bundle ids from their signed bundles' code requirements and Homebrew's cask (2026-11-18)
  { bundle: "org.tabby", path: /\/Tabby\.app\//i },
  { bundle: "com.raphaelamorim.rio", path: /\/Rio\.app\/|\/rio$/i },
  { bundle: "dev.commandline.waveterm", path: /\/Wave\.app\//i },
];

// --- host terminal (resolved once): the first ancestor that is a terminal app; tmux / screen are walked
// through. Returns { bundle } for a listed terminal, { name } for another app bundle named like a terminal,
// or null (chain broken, no terminal found).
function hostTerminal() {
  try {
    let pid = process.ppid;
    for (let i = 0; i < 12 && pid > 1; i++) {
      const comm = execFileSync("/bin/ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 }).trim();
      const t = TERMINALS.find((x) => x.path.test(comm));
      if (t) return { bundle: t.bundle };
      const app = /\/([^/]+)\.app\/Contents\/MacOS\/[^/]+$/.exec(comm);
      if (app && /term|shell|console/i.test(app[1])) return { name: app[1] };
      // anything else — a shell, node, npm, tmux, screen — is walked through to its parent
      const ppidLine = execFileSync("/bin/ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 }).trim();
      pid = Number(ppidLine);
      if (!Number.isFinite(pid) || pid <= 1) break;
    }
  } catch { /* chain broken — only the listed terminals apply */ }
  return null;
}
const HOST_TERMINAL = hostTerminal();

// the same apps by name too, for an app whose bundle id cannot be read (Warp Preview was missed)
const TERMINAL_NAMES = ["Terminal", "iTerm2", "iTerm", "WezTerm", "Ghostty", "Warp*", "Alacritty", "kitty", "Hyper", "Tabby", "Rio", "Wave"];
// IDEs with a built-in terminal (2026-11-12): keys typed into one can reach its shell, so
// they get no input by default either. Bundle ids (VS Code and Cursor read from installed apps), and names,
// which also match when the bundle id is read but differs (a fork, an edition)
// Editions and channels are covered by a trailing * (Insiders, Exploration, Preview, Nightly, Canary).
// Two entries are broad on purpose and fail closed: the name "Code" (VS Code's own app name) also denies any other
// app named exactly "Code", and com.jetbrains.* also denies JetBrains Toolbox, which has no shell.
const IDE_BUNDLES = [
  "com.microsoft.VSCode*", "com.vscodium*",
  "com.todesktop.230313mzl4w4u92", // Cursor
  "com.exafunction.windsurf*", "dev.zed.Zed*",
  "com.jetbrains.*", "com.google.android.studio*",
];
const IDE_NAMES = ["Code", "Visual Studio Code*", "Code - Insiders", "Code - Exploration", "VSCodium*", "Cursor*", "Windsurf*", "Zed*",
  "IntelliJ IDEA*", "PyCharm*", "WebStorm*", "GoLand*", "CLion*", "RubyMine*", "PhpStorm*", "Rider*", "DataGrip*", "RustRover*", "Fleet", "Android Studio*"];
export function defaultDenyList() {
  const list = [...TERMINALS.map((t) => t.bundle), ...TERMINAL_NAMES, ...IDE_BUNDLES, ...IDE_NAMES];
  if (HOST_TERMINAL?.name && !list.some((l) => l.toLowerCase() === HOST_TERMINAL.name.toLowerCase())) list.push(HOST_TERMINAL.name);
  return list;
}
// the deny list in force, and where it came from
export function denyList() {
  const raw = process.env.NORACU_DENY_APPS;
  const list = (raw || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (list.length && list[0].toLowerCase() === "none") {
    const own = list.slice(1);
    return own.length ? { list: own, source: "NORACU_DENY_APPS (none: default list dropped)" } : { list: [], source: "NORACU_DENY_APPS=none" };
  }
  if (list.length) return { list: [...list, ...defaultDenyList()], own: list.length, source: "NORACU_DENY_APPS and the default deny list" };
  return { list: defaultDenyList(), source: "the default deny list (terminal apps and IDEs with a terminal; NORACU_DENY_APPS unset)" };
}
// whether any approval rule is in force — then an app known only by name cannot be ruled out
export function gateActive() {
  return denyList().list.length > 0 || process.env.NORACU_APPROVAL_FILE !== undefined;
}

// --- stop file ---
export function stopFileBlocked() {
  const p = process.env.NORACU_STOP_FILE;
  if (p === undefined) return null;
  if (!p.trim()) return "stop_check_error: NORACU_STOP_FILE is set but blank — remove it or give a path; nothing was sent (fail closed; delivery=not_delivered, retry=safe)";
  try {
    statSync(p);
    return `user_stopped: ${p} exists — the person at the Mac stopped noracu's input; nothing was sent (delivery=not_delivered, retry=safe); remove the file to resume`;
  } catch (e) {
    if (e && e.code === "ENOENT") return null;
    return `stop_check_error: could not check ${p} (${e && e.code ? e.code : "unknown"}) — nothing was sent (fail closed; delivery=not_delivered, retry=safe)`;
  }
}

// --- pattern match: "com.apple.*" glob against a bundle id or app name. A missing bundle id or name is
// never matched (an empty pattern matched every app without a bundle id) ---
function matches(pattern, bundleId, appName) {
  const p = String(pattern ?? "").trim();
  if (!p) return false;
  const rx = new RegExp("^" + p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i");
  return (bundleId ? rx.test(String(bundleId)) : false) || (appName ? rx.test(String(appName)) : false);
}

// a rule written as a bundle id ("com.apple.Terminal", "com.example.*"); anything else names apps by their name
const byBundle = (p) => /^[\w*?-]+(\.[\w*?-]+)+$/.test(String(p).trim());
const unnamed = (what) => ({ error: `input_denied: the name of the app that would receive the input could not be read, so ${what} cannot rule it out — nothing was sent (fail closed; delivery=not_delivered, retry=safe)` });

// --- approval file (opt-in). Returns { verdict: "allow"|"ask"|"deny", reason } or { error } (fail closed). ---
// needName: the app has a name to read (a Mac app). Without one, a rule that names apps cannot rule it out, so the
// input is refused while such a rule is in force. An iOS app is matched on its bundle id alone (it has no name here).
export function evaluateApproval({ bundleId, appName, needName = false } = {}) {
  // an app known by no name cannot be ruled out, and with a rule in force an app whose
  // bundle id is unknown cannot be ruled out by bundle-id patterns (server.mjs approveKnown already refuses
  // both; this keeps the module safe on its own)
  const bid = String(bundleId ?? "").trim(), name = String(appName ?? "").trim();
  if (!bid && (!name || gateActive())) {
    return { error: `input_denied: the app that would receive the input ${name ? `("${name}") has no readable bundle id, so the deny list / approval file cannot rule it out` : "could not be identified"} — nothing was sent (fail closed; delivery=not_delivered, retry=safe)` };
  }
  const deny = denyList();
  // how many entries at the head of the list the user wrote (NORACU_DENY_APPS): those always win. The rest is the
  // default list, which an approval file can open for an app it names exactly
  const userCount = deny.own !== undefined ? deny.own : /^NORACU_DENY_APPS/.test(deny.source) ? deny.list.length : 0;
  let byDefault = null;
  // the trimmed bundle id and name are what every rule is matched against, as they are what was checked above
  // (" com.apple.Terminal" was checked as known and then missed the deny list)
  for (const [i, d] of deny.list.entries()) if (matches(d, bid, name)) {
    // with a list of the user's own, say which of the two lists named the app
    const src = deny.own === undefined ? deny.source : i < deny.own ? "NORACU_DENY_APPS" : "the default deny list (terminal apps and IDEs with a terminal)";
    if (i < userCount) return { verdict: "deny", reason: `denied by ${src} ("${d}")` };
    byDefault = { verdict: "deny", reason: `denied by ${src} ("${d}") — the person at the Mac can let this one app through by naming it exactly (no * or ?) under "allow" in an approval file (NORACU_APPROVAL_FILE)` };
    break;
  }
  // the default list names some apps by name (editions and forks whose bundle id differs)
  if (needName && !name && !byDefault && deny.list.some((d) => !byBundle(d))) return unnamed("the deny list's entries that name apps");
  const file = process.env.NORACU_APPROVAL_FILE;
  if (file === undefined) return byDefault || { verdict: "allow" };
  if (!file.trim()) return { error: "approval_file_error: NORACU_APPROVAL_FILE is set but blank — remove it or give a path; nothing was sent (fail closed; delivery=not_delivered, retry=safe)" };
  let conf;
  let fd = null;
  try {
    // opened without following a symlink, and checked on the open descriptor (no swap between check and read)
    // O_NONBLOCK: a FIFO there would otherwise block the open, and the whole server with it, until something writes
    // to it; the open descriptor is then refused as not a regular file
    fd = openSync(file, fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile()) return { error: `approval_file_error: ${file} is not a regular file — nothing was sent (fail closed; delivery=not_delivered, retry=safe)` };
    if (st.mode & 0o077) return { error: `approval_file_insecure: ${file} must be mode 0600 (is 0${(st.mode & 0o777).toString(8)}) — nothing was sent (fail closed; delivery=not_delivered, retry=safe)` };
    if (st.uid !== process.getuid?.()) return { error: `approval_file_owner: ${file} is not owned by this user — nothing was sent (fail closed; delivery=not_delivered, retry=safe)` };
    // a list of apps is small: a file over 64 KB is not read at all (it is read again before every input)
    if (st.size > 65536) return { error: `approval_file_error: ${file} is larger than 64 KB — nothing was sent (fail closed; delivery=not_delivered, retry=safe)` };
    const text = readFileSync(fd, "utf8");
    // JSON.parse's message quotes a piece of the file, and this answer goes to the agent: it is not passed on
    try { conf = JSON.parse(text); } catch {
      return { error: `approval_file_error: ${file} is not valid JSON — NORACU_APPROVAL_FILE is set, so nothing was sent (fail closed; delivery=not_delivered, retry=safe)` };
    }
  } catch (e) {
    const why = e && e.code === "ENOENT" ? "does not exist" : e && e.code === "ELOOP" ? "is a symlink" : `is unreadable or not JSON (${e && e.code ? e.code : String(e).slice(0, 80)})`;
    return { error: `approval_file_error: ${file} ${why} — NORACU_APPROVAL_FILE is set, so nothing was sent (fail closed; delivery=not_delivered, retry=safe)` };
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* already closed */ }
  }
  if (!conf || typeof conf !== "object" || Array.isArray(conf)) return { error: `approval_file_error: ${file} must hold a JSON object — nothing was sent (fail closed; delivery=not_delivered, retry=safe)` };
  const unknown = Object.keys(conf).filter((k) => !["allow", "ask", "deny"].includes(k));
  if (unknown.length) return { error: `approval_file_error: ${file} has unknown key(s) ${unknown.slice(0, 3).map((k) => JSON.stringify(k)).join(", ")} — only "allow", "ask" and "deny"; nothing was sent (fail closed; delivery=not_delivered, retry=safe)` };
  for (const key of ["allow", "ask", "deny"]) if (conf[key] !== undefined && !Array.isArray(conf[key])) return { error: `approval_file_error: "${key}" must be an array — nothing was sent (fail closed; delivery=not_delivered, retry=safe)` };
  // an empty or non-string pattern is a broken file, not a pattern
  for (const key of ["allow", "ask", "deny"]) for (const p of conf[key] || []) if (typeof p !== "string" || !p.trim() || p.length > 200) return { error: `approval_file_error: "${key}" holds an empty or non-string pattern (${JSON.stringify(p)?.slice(0, 40)}) — nothing was sent (fail closed; delivery=not_delivered, retry=safe)` };
  if (needName && !name && [...(conf.deny || []), ...(conf.ask || [])].some((p) => !byBundle(p))) return unnamed(`the entries of ${file} that name apps`);
  for (const d of conf.deny || []) if (matches(d, bid, name)) return { verdict: "deny", reason: `denied by approval file ("${d}")` };
  // on the default deny list: only an "allow" entry that names this app — its bundle id or its name, without a
  // wildcard — lets it through; "*" or "com.example.*" in "allow" does not open a terminal
  if (byDefault) {
    for (const a of conf.allow || []) if (!/[*?]/.test(a) && matches(a, bid, name)) return { verdict: "allow", reason: `allowed by approval file ("${a}"), which names this app of the default deny list` };
    return byDefault;
  }
  for (const a of conf.ask || []) if (matches(a, bid, name)) {
    return { verdict: "ask", reason: `approval_required: "${bundleId || appName}" is listed under "ask" in ${file} — the person at the Mac must move it to "allow" (noracu never edits this file); nothing was sent (delivery=not_delivered, retry=safe)` };
  }
  for (const a of conf.allow || []) if (matches(a, bid, name)) return { verdict: "allow", reason: `allowed by approval file ("${a}")` };
  // nothing matched: ask (an approval file that lists apps but not this one means "ask")
  return { verdict: "ask", reason: `approval_required: ${file} lists apps but not "${bundleId || appName}" — add it to "allow" or "deny"; nothing was sent (delivery=not_delivered, retry=safe)` };
}

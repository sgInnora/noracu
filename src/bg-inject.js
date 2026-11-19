// bg-inject — background targeted input via CGEventPostToPid (0.3.0).
//
// Events are posted straight to a pid: the real pointer never moves, the target app need not be
// frontmost, and the person at the Mac sees nothing. Everything runs in ONE osascript invocation per
// gesture: CF event objects must stay inside a single ObjC call chain, and each osascript spawn costs
// 50–200 ms.
//
// Scope guards:
//  • NORACU_NO_BGPOST=1 turns the whole layer off (cliclick as in 0.2.7).
//  • Web-engine apps (Chromium/Electron renderers) keep the cliclick path: their event loops check
//    key-window state and the pointer location, so pid-posted events often do not land. Detection is a
//    bundle-id / name heuristic — a denylist, not a promise: unknown apps are tried.
//  • Only an answer that proves nothing was posted falls back to cliclick. A posted click is checked by
//    the caller (AX observe_after) and reported as it reads — never re-sent another way, since a click
//    that did land but changed nothing visible would then go out twice.
//  • Posted events reset HIDIdleTime like any other input; mac_* input jobs run under serializedInput,
//    whose drain() advances lastOwnInputEnd, so user_active does not mistake our own events for the
//    person's (server.mjs, 0.2.7 comment block).

import { execFile } from "node:child_process";

export const BGPOST_DISABLED = process.env.NORACU_NO_BGPOST === "1";

// Chromium / Electron / web-shell bundle ids (and app names, for hosts that report no bundle id).
// Anything matching keeps the physical cliclick path even when bgpost is on.
// Safari (WebKit) and Firefox take the cliclick path too — a pid-posted event they swallow
// would still read as posted, and only a "nothing was posted" answer may fall back; Arc is company.thebrowser.*
const WEB_ENGINE = /electron|chrome|chromium|brave|edge|arc\.|thebrowser|vivaldi|opera|safari|webkit|firefox|mozilla|discord|slack|vscode|code\.oss|notion|linear|spotify|figma|teams|zoom|feishu|lark|dingtalk|wecom|wechat|qq\.browser/i;
export function bgCandidate(bundleId, appName) {
  if (BGPOST_DISABLED) return false;
  const b = String(bundleId || "");
  const n = String(appName || "");
  return !(WEB_ENGINE.test(b) || WEB_ENGINE.test(n));
}

// macOS virtual key codes for named keys (mirrors server.mjs ENGINE_KEYS) and modifier flag masks
// (CGEventSetFlags): cmd 1<<20, shift 1<<17, alt 1<<19, ctrl 1<<18, fn 1<<23, numpad 1<<21.
const NAMED_KEYS = {
  return: 36, esc: 53, tab: 48, space: 49, delete: 51, "fwd-delete": 117, home: 115, end: 119,
  "page-up": 116, "page-down": 121, "arrow-left": 123, "arrow-right": 124, "arrow-down": 125, "arrow-up": 126,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
  f13: 105, f14: 107, f15: 113, f16: 106,
};
const MOD_FLAGS = { cmd: 1 << 20, shift: 1 << 17, alt: 1 << 19, ctrl: 1 << 18, fn: 1 << 23, numpad: 1 << 21 };

// One osascript per gesture. argv: [op, pid, ...numbers]. Numbers are clamped server-side; pid is
// Math.trunc()'d (pid_t is int32 — a float here is undefined behaviour through libffi).
// Every event of a gesture is created before the first one is posted, so the "nothing was posted"
// answers (bad-*, create-failed) are exact: only those may fall back to the cliclick pointer path.
// A click carries its click state (1, 2, 3… — kCGMouseEventClickState, field 1): without it a double
// click is two single clicks. The button number is 0 left, 1 right, 2 other
// (middle); macOS reads it for the "other" event types only.
export const BG_SCRIPT = `
  ObjC.import('CoreGraphics');
  ObjC.bindFunction('CGEventCreateKeyboardEvent', ['void*', ['void*', 'int', 'bool']]);
  ObjC.bindFunction('CGEventCreateMouseEvent', ['void*', ['void*', 'int', '{CGPoint=dd}', 'int']]);
  ObjC.bindFunction('CGEventPostToPid', ['void', ['int', 'void*']]);
  ObjC.bindFunction('CGEventSetFlags', ['void', ['void*', 'uint64']]);
  ObjC.bindFunction('CGEventSetIntegerValueField', ['void', ['void*', 'int', 'int64']]);
  function run(argv) {
    // whole numbers in range only: pid_t is int32, and a fraction or a wrap would post to another process
    const pid = Number(argv[1]);
    if (!Number.isInteger(pid) || pid <= 0 || pid > 2147483647) return 'bad-pid';
    const src = $.CGEventSourceCreate($.kCGEventSourceStateHIDSystemState);
    const events = [];
    if (argv[0] === 'key') {
      // argv: key, pid, keyCode, flags
      const code = Number(argv[2]), flags = Number(argv[3]);
      if (!Number.isInteger(code) || code < 0 || code > 127 || !Number.isInteger(flags) || flags < 0) return 'bad-key';
      const down = $.CGEventCreateKeyboardEvent(src, code, true);
      const up = $.CGEventCreateKeyboardEvent(src, code, false);
      if (!down || !up) return 'create-failed';
      // always set: 0 too, so a modifier someone holds on the keyboard does not ride along
      $.CGEventSetFlags(down, flags); $.CGEventSetFlags(up, flags);
      events.push(down, up);
    } else if (argv[0] === 'click') {
      // argv: click, pid, x, y, downType, upType, count, button
      const x = Number(argv[2]), y = Number(argv[3]);
      const dT = Math.trunc(Number(argv[4])), uT = Math.trunc(Number(argv[5]));
      const n0 = Number(argv[6]);
      if (!Number.isInteger(n0) || n0 < 1) return 'bad-count';
      const n = Math.min(n0, 5);
      const btn = Math.min(Math.max(Math.trunc(Number(argv[7]) || 0), 0), 2);
      if (!isFinite(x) || !isFinite(y)) return 'bad-point';
      const pt = $.CGPointMake(x, y);
      for (let i = 0; i < n; i++) {
        const down = $.CGEventCreateMouseEvent(src, dT, pt, btn);
        const up = $.CGEventCreateMouseEvent(src, uT, pt, btn);
        if (!down || !up) return 'create-failed';
        // no modifier rides along from the HID state the source was created from
        $.CGEventSetFlags(down, 0); $.CGEventSetFlags(up, 0);
        $.CGEventSetIntegerValueField(down, 1, i + 1);
        $.CGEventSetIntegerValueField(up, 1, i + 1);
        events.push(down, up);
      }
    } else return 'bad-op';
    for (const ev of events) $.CGEventPostToPid(pid, ev);
    return 'ok';
  }`;

// kCGEvent{Left,Right,Other}Mouse{Down,Up} and the button number CGEventCreateMouseEvent takes
const MOUSE = { left: { types: [1, 2], button: 0 }, right: { types: [3, 4], button: 1 }, middle: { types: [25, 26], button: 2 } };
// answers that prove nothing was posted
export const NOT_POSTED = new Set(["bad-pid", "bad-key", "bad-point", "bad-count", "bad-op", "create-failed"]);

// null, "", false and fractions are not numbers here — Number(null) is 0, which is the A
// key, the pid of no process and the screen corner. A bad value goes out as "NaN" and the script answers bad-*.
const num = (v) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);
const intIn = (v, lo, hi) => { const n = num(v); return Number.isInteger(n) && n >= lo && n <= hi ? n : NaN; };

// The argv after `--` for one gesture (pure: the contract tests check it).
export function keyArgv(pid, keyCode, mods = []) {
  let flags = 0;
  // an unknown modifier is a bad chord, not a bare key
  for (const m of mods) { if (!Object.hasOwn(MOD_FLAGS, m)) { flags = NaN; break; } flags |= MOD_FLAGS[m]; }
  return ["key", intIn(pid, 1, 2147483647), intIn(keyCode, 0, 127), flags].map(String);
}
export function clickArgv(pid, x, y, { button = "left", count = 1 } = {}) {
  const m = MOUSE[button] || MOUSE.left;
  const c = intIn(count, 1, Number.MAX_SAFE_INTEGER);  // 0 or a fraction is not one click
  return ["click", intIn(pid, 1, 2147483647), num(x), num(y), m.types[0], m.types[1], Number.isNaN(c) ? NaN : Math.min(c, 5), m.button].map(String);
}

// Runs one gesture. run(argv) → { code, stdout, timedOut, error } — the server passes its own runner, so
// the osascript child is timed, counted among the running children (killed on shutdown) and waited for
// by the input queue like every other one (invariant 10). Answers:
//   { ok: true }                      posted
//   { ok: false, sent: false, error } nothing was posted (the caller may use another path)
//   { ok: false, sent: "unknown", error } a timeout or an odd exit: events may have gone out — no fallback
function defaultRun(argv) {
  return new Promise((resolve) => {
    execFile("/usr/bin/osascript", ["-l", "JavaScript", "-e", BG_SCRIPT, "--", ...argv], { timeout: 8000 }, (err, stdout) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout || ""), timedOut: Boolean(err && err.killed), error: err && err.code === "ENOENT" ? err : null });
    });
  });
}
async function post(argv, run = defaultRun) {
  if (BGPOST_DISABLED) return { ok: false, sent: false, error: "bgpost disabled" };
  const r = await run(argv);
  if (r.error) return { ok: false, sent: false, error: `bgpost could not start: ${String(r.error.message || r.error).slice(0, 120)}` };
  if (r.timedOut) return { ok: false, sent: "unknown", error: "bgpost did not finish in time" };
  const out = String(r.stdout || "").trim();
  if (out === "ok" && r.code === 0) return { ok: true };
  if (NOT_POSTED.has(out)) return { ok: false, sent: false, error: `bgpost ${out}` };
  return { ok: false, sent: "unknown", error: `bgpost ${out || `exited with ${r.code}`}` };
}

// Post a key chord to one pid. keyCode: a macOS virtual key code; mods: array of "cmd"|"shift"|"alt"|"ctrl"|"fn"|"numpad".
export function postKeyToPid(pid, keyCode, mods = [], { run } = {}) { return post(keyArgv(pid, keyCode, mods), run); }

// Post count clicks at a point to one pid. Coordinates are in points (logical screen coordinates).
export function postClickToPid(pid, x, y, { button = "left", count = 1, run } = {}) { return post(clickArgv(pid, x, y, { button, count }), run); }

export function namedKeyCode(name) { return NAMED_KEYS[name] ?? null; }

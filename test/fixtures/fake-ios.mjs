// A small model of an iPhone as the runner sees it (protocol v1), for tests that have no phone:
// test/ios-session-unit.mjs talks to it in-process, test/fixtures/fake-xcodebuild.mjs serves it over TCP.
// Two apps: the Home Screen and Settings (a search field, a secure field, three rows, a keyboard).

export const SPRINGBOARD = "com.apple.springboard";
export const SETTINGS = "com.apple.Preferences";
export const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const W = 402, H = 874;
const INPUT_OPS = new Set(["tap", "press", "drag", "type", "keys", "home"]);
const inside = (f, x, y) => x >= f[0] && x <= f[0] + f[2] && y >= f[1] && y <= f[1] + f[3];

export function makePhone() {
  const phone = {
    installed: new Set([SPRINGBOARD, SETTINGS, "com.example.slow", "com.example.stuck"]),   // slow: in front after two looks; stuck: never
    state: { [SPRINGBOARD]: 4 },          // XCUIApplication.State raw values; absent = 1 (not running)
    front: SPRINGBOARD,
    keyboard: false, focus: null, search: "", secret: "", scroll: 0,
    extraField: false, name: "",        // a second text field ("Name", with a placeholder)
    typeInto: null,                       // typed text lands in this field ("name") whatever was tapped
    cutValue: false,                      // the search field's value comes back cut (value_truncated)
    searchLabel: "Search",                // the search field's label (an app can change it with the value)
    moreFields: [],                       // further text fields, listed as given: { type, label, id, value, placeholder? } — two alike are twins
    issue: null,                          // an op during which XCTest records a failure: the answer is xctest_issue
    alert: null,                          // a SpringBoard alert that is up: { frame: [x, y, w, h], buttons: [[x, y, w, h], …] }
    issueOnce: null,                      // an op that is answered once with a failure XCTest recorded after an earlier command (and is not run)
    partial: 0,                           // a type delivers only its last N characters (0: all of them)
    truncated: false,                     // snapshots come back cut short
    afterType: null,
    afterHome: null,                      // called once the phone has taken a `home` (ios_home reads the app before it, S4A)                      // called once the phone has taken a `type` (to move things between two reads)
    autocorrect: false,                   // type "hello" → the field gets "Hello"
    slowFront: 0,                         // app_state answers before a launched app reports foreground
    hang: null,                           // an op that never answers
    hangAfter: null,                      // { op, n }: the op answers n more times, then never
    leakSecure: false,                    // a runner that (wrongly) returns a secure field's value
    keyboardLag: 0, pendingKb: 0,         // after a tap on a field the keyboard is up only after this many type attempts
    log: [],                              // every op that reached the phone: [op, args]
    quit: false,

    launch(bundle) {
      if (!phone.installed.has(bundle)) return false;
      if (phone.front !== bundle && phone.front !== SPRINGBOARD) phone.state[phone.front] = 3;
      phone.front = bundle; phone.keyboard = false; phone.focus = null;
      phone.state[bundle] = /^com\.example\./.test(bundle) ? 3 : 4;
      if (bundle === "com.example.slow") phone.slowFront = 2;
      return true;
    },

    nodes(bundle) {
      if (bundle === SPRINGBOARD) return [
        { type: "button", label: "Settings", id: "icon-settings", frame: [30, 100, 60, 60] },
        { type: "button", label: "Safari", id: "icon-safari", frame: [120, 100, 60, 60] },
        { type: "staticText", label: "9:41", id: "", frame: [20, 10, 50, 20] },
      ];
      const y = -phone.scroll;
      const list = [
        { type: "staticText", label: "Settings", id: "", frame: [16, 60 + y, 200, 40] },
        { type: "searchField", label: phone.searchLabel, id: "search", value: phone.search, frame: [16, 110 + y, 370, 36] },
        { type: "secureTextField", label: "Passcode", id: "pass", value: phone.secret, frame: [16, 160 + y, 370, 36] },
        { type: "cell", label: "Wi-Fi", id: "", frame: [0, 220 + y, W, 52] },
        { type: "cell", label: "Bluetooth", id: "", frame: [0, 272 + y, W, 52] },
        { type: "cell", label: "General", id: "", frame: [0, 324 + y, W, 52], enabled: false },
        { type: "other", label: "", id: "", frame: [0, 0, W, H] },
      ];
      // as XCUITest has it: a value equal to the placeholder cannot be told from an empty field, and comes back empty
      if (phone.extraField) list.push({ type: "textField", label: "Name", id: "name", value: phone.name === "Your name" ? "" : phone.name, placeholder: "Your name", frame: [16, 400 + y, 370, 36] });
      phone.moreFields.forEach((m, i) => list.push({ frame: [16, 460 + 50 * i + y, 370, 36], ...m, value: m.placeholder && m.value === m.placeholder ? "" : m.value }));
      if (phone.keyboard) list.push({ type: "key", label: "q", id: "", frame: [4, 600, 36, 42] }, { type: "key", label: "return", id: "", frame: [300, 800, 98, 42] });
      return list;
    },

    // → { ok: true, result } | { ok: false, error, message, sent? }
    handle(op, args = {}) {
      phone.log.push([op, args]);
      const st = (b) => phone.state[b] ?? 1;
      const no = (error, message, sent) => ({ ok: false, error, message, ...(sent === undefined ? {} : { sent }) });
      const gate = (b) => (st(b) === 1 ? no("app_not_running", "state 1", false) : b !== SPRINGBOARD && st(b) !== 4 ? no("app_not_foreground", `state ${st(b)}`, false)
        : b === SPRINGBOARD && args.springboard_only === true ? sbOnly() : null);
      // springboard_only as the runner has it: one tap on a button of an alert; never a long press, a drag, text or keys
      const sbOnly = () => {
        if (op === "drag") return no("app_not_foreground", "a drag named for com.apple.springboard is not sent", false);
        if (op === "press") return no("app_not_foreground", "a long press named for com.apple.springboard is not sent", false);
        if (op === "type" || op === "keys") return no("app_not_foreground", "text and keys named for com.apple.springboard are not sent", false);
        if (args.count !== undefined && args.count !== 1) return no("app_not_foreground", "more than one tap named for com.apple.springboard is not sent", false);
        const a = phone.alert;
        return a && inside(a.frame, args.x, args.y) && (a.buttons || []).some((f) => inside(f, args.x, args.y)) ? null : no("app_not_foreground", "the point is not on a button of one of SpringBoard's alerts", false);
      };
      const b = args.bundle_id;
      if (phone.refuseOnce?.op === op) { const f = phone.refuseOnce; phone.refuseOnce = null; return no(f.error, f.message, false); }
      if (phone.issueOnce === op) { phone.issueOnce = null; return no("xctest_issue", "recorded after an earlier command had answered: failed - late", INPUT_OPS.has(op) ? false : undefined); }
      if (phone.issue === op) return no("xctest_issue", "failed - Failed to synthesize event", INPUT_OPS.has(op) ? "unknown" : undefined);
      switch (op) {
        case "front": return { ok: true, result: { home: phone.front === SPRINGBOARD, icons: phone.front === SPRINGBOARD ? 2 : 0, alerts: phone.alert ? [phone.alert.frame] : [], alert_buttons: phone.alert?.buttons?.length ?? 0, ms: 5 } };
        case "ping": return { ok: true, result: { v: 1, uptime_ms: 5, served: phone.log.length } };
        case "quit": phone.quit = true; return { ok: true, result: {} };
        case "app_state": {
          if (phone.slowFront > 0 && b === "com.example.slow" && --phone.slowFront === 0) phone.state[b] = 4;
          return { ok: true, result: { state: st(b) } };
        }
        case "snapshot": {
          if (st(b) === 1) return no("app_not_running", "state 1");
          const all = phone.nodes(b).filter((n) => n.label || n.type !== "other");
          const max = args.max_nodes ?? 400;
          return { ok: true, result: { bundle_id: b, state: st(b), screen: { w: W, h: H }, truncated: phone.truncated || all.length > max, ms: 3,
            nodes: all.slice(0, max).map((n, i) => ({ i, type: n.type, label: n.label, id: n.id, frame: n.frame, enabled: n.enabled !== false, selected: false, ...(n.value !== undefined && (n.type !== "secureTextField" || phone.leakSecure) ? { value: n.value } : {}), ...(n.placeholder ? { placeholder: n.placeholder } : {}), ...(phone.cutValue && n.id === "search" ? { value_truncated: true } : {}) })) } };
        }
        case "tap": case "press": {
          if (!(args.x >= 0 && args.y >= 0 && args.x <= W && args.y <= H)) return no("invalid_args", "point outside screen", false);
          const g = gate(b); if (g) return g;
          if (b === SETTINGS) {
            const hit = phone.nodes(b).find((n) => (n.type === "searchField" || n.type === "secureTextField" || n.type === "textField") && inside(n.frame, args.x, args.y));
            if (hit) { phone.focus = hit.id; if (phone.keyboardLag > 0) { phone.pendingKb = phone.keyboardLag; phone.keyboard = false; } else phone.keyboard = true; }
          }
          return { ok: true, result: { ms: 400 } };
        }
        case "drag": {
          const g = gate(b); if (g) return g;
          if (b === SETTINGS) phone.scroll += args.from[1] - args.to[1];
          return { ok: true, result: { ms: 900 } };
        }
        case "type": {
          const g = gate(b); if (g) return g;
          if (phone.pendingKb > 0) { if (--phone.pendingKb === 0) phone.keyboard = true; return no("no_keyboard", "no keyboard", false); }
          if (!phone.keyboard) return no("no_keyboard", "no keyboard", false);
          const got = phone.partial > 0 ? args.text.slice(-phone.partial) : args.text;
          const text = phone.autocorrect ? got.replace(/^./, (c) => c.toUpperCase()) : got;
          const into = phone.typeInto || phone.focus;
          const more = phone.moreFields.find((m) => m.id === into);   // of twins, the first
          if (more) more.value += text; else if (into === "pass") phone.secret += text; else if (into === "name") phone.name += text; else if (into !== "void") phone.search += text.replace(/\n/g, "");
          if (phone.afterType) { const f = phone.afterType; phone.afterType = null; f(); }
          return { ok: true, result: { ms: 50 * args.text.length } };
        }
        case "keys": {
          const g = gate(b); if (g) return g;
          if (!phone.keyboard) return no("no_keyboard", "no keyboard", false);
          if (args.key === "delete") phone.search = phone.search.slice(0, Math.max(0, phone.search.length - (args.count ?? 1)));
          return { ok: true, result: { ms: 60 } };
        }
        case "home":
          if (phone.handleHome === false) return { ok: true, result: { ms: 300 } };   // a press the system ignored
          if (phone.front !== SPRINGBOARD) phone.state[phone.front] = 3;
          phone.front = SPRINGBOARD; phone.keyboard = false; phone.focus = null;
          if (phone.afterHome) { const f = phone.afterHome; phone.afterHome = null; f(); }
          return { ok: true, result: { ms: 300 } };
        case "screenshot": return { ok: true, result: { png_base64: PNG_1X1, w: W, h: H, ms: 80 } };
        default: return no("unknown_op", `unknown op ${op}`);
      }
    },

    // the same answers shaped as src/ios-xcuitest.js RunnerClient.call returns them
    client() {
      return {
        closed: 0,
        close() { this.closed++; },
        async call(op, args, { timeoutMs } = {}) {
          if (phone.hang === op || (phone.hangAfter?.op === op && phone.hangAfter.n-- <= 0)) { phone.log.push([op, args, "hung"]); return { ok: false, error: "ios_timeout", message: `the runner did not answer ${op} in ${timeoutMs} ms`, delivery: INPUT_OPS.has(op) ? "unknown" : "not_applicable" }; }
          const r = phone.handle(op, args);
          if (r.ok) return r;
          return { ok: false, error: r.error, message: r.message, delivery: !INPUT_OPS.has(op) ? "not_applicable" : r.sent === false ? "not_delivered" : "unknown" };
        },
      };
    },
  };
  return phone;
}

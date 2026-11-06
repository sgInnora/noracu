// Test harness for src/mac-ax.js without macOS: the engine is a plain script, so it runs in node:vm with
// stub ObjC bridges, and its top-level functions (readNode, children, attr, runningApps, …) become
// context globals that a test replaces with a fake accessibility tree. Only pure logic is exercised
// here (fingerprints, resolve, matching, verdicts, policy); real AX behaviour is covered by e2e on a Mac.
import vm from "node:vm";
import { readFileSync } from "node:fs";

export function loadEngine(path) {
  const src = readFileSync(path, "utf8");
  const fns = {
    AXIsProcessTrusted: () => true,
    NSThread: { sleepForTimeInterval() {} },
    NSNumber: { numberWithBool: (b) => Boolean(b), numberWithDouble: (n) => Number(n) },
  };
  const dollar = new Proxy(function () {}, {
    get: (t, k) => (k in fns ? fns[k] : () => 0),
    set: (t, k, v) => { fns[k] = v; return true; }, // a test can stub one bridge function: ctx.$.CGEventPost = …
    apply: (t, s, a) => a[0],
  });
  const ctx = vm.createContext({
    ObjC: { import() {}, bindFunction() {}, castRefToObject: (x) => x }, $: dollar, Ref: () => [],
    console, Date, JSON, Math, Number, String, Boolean, Object, Array, Set, Map, RegExp, Error,
  });
  vm.runInContext(src, ctx, { filename: "mac-ax.js" });
  return ctx;
}

// A fake element: { role, subrole, title, desc, value, id, placeholder, frame:[x,y,w,h], enabled,
// actions:[…], settable:{AXValue:true…}, kids:[…], gone, wid (windows), label (test-only name) }
export function el(role, props = {}, kids = []) {
  const e = { role, ...props, kids };
  for (const k of kids) k.parent = e;
  return e;
}
export function reparent(e) { for (const k of e.kids || []) { k.parent = e; reparent(k); } return e; }

export function readFake(e) {
  if (!e || e.gone) return { __err: -25202 };
  if (e.hung) return { __err: -25204 };
  const v = { AXRole: e.role, AXChildren: (e.kids || []).filter(Boolean) };
  if (e.subrole) v.AXSubrole = e.subrole;
  if (e.title !== undefined) v.AXTitle = e.title;
  if (e.desc !== undefined) v.AXDescription = e.desc;
  if (e.value !== undefined) v.AXValue = e.value;
  if (e.id) v.AXIdentifier = e.id;
  if (e.placeholder) v.AXPlaceholderValue = e.placeholder;
  if (e.frame) v.AXFrame = { x: e.frame[0], y: e.frame[1], w: e.frame[2], h: e.frame[3] };
  if (e.enabled !== undefined) v.AXEnabled = e.enabled;
  if (e.selected !== undefined) v.AXSelected = e.selected;
  if (e.focusedFlag !== undefined) v.AXFocused = e.focusedFlag;
  return v;
}

// Install a fake app into the engine context. app = { pid, name, bundle, windows:[…], menubar, focused,
// extra:{attr: value} on the app element }. Returns { appEl, calls } where calls records writes/actions.
export function installApp(ctx, app) {
  const appEl = el("AXApplication", {}, [...(app.menubar ? [app.menubar] : []), ...app.windows]);
  reparent(appEl);
  const calls = [];
  const apps = [{ ns: {}, name: app.name, bundle: app.bundle || "test.app", pid: app.pid, policy: 0, active: true, hidden: false }];
  ctx.runningApps = () => apps;
  ctx.frontApp = () => ({ ns: {}, name: app.name, bundle: app.bundle || "test.app", pid: app.frontPid ?? app.pid });
  ctx.appElement = () => appEl;
  ctx.windowsOf = () => (appEl.kids || []).filter((w) => w && w.role === "AXWindow" && !w.gone);
  ctx.axWindowId = (w) => (w && w.wid !== undefined ? w.wid : null);
  ctx.readNode = readFake;
  ctx.readLite = readFake;
  ctx.children = (e) => (e && !e.gone ? (e.kids || []).filter(Boolean) : []);
  ctx.childCount = (e) => ctx.children(e).length;
  ctx.childAt = (e, i) => ctx.children(e)[i] || null;
  ctx.actionNames = (e) => (e && e.actions) || [];
  ctx.settable = (e, name) => Boolean(e && e.settable && e.settable[name]);
  ctx.same = (a, b) => a === b;
  ctx.perform = (e, action) => { calls.push(["perform", e.label || e.role, action]); if (e.onPerform) e.onPerform(action); return e.gone ? -25202 : 0; };
  ctx.setAttr = (e, name, value) => { calls.push(["set", e.label || e.role, name, value]); if (e.onSet) e.onSet(name, value); return e.gone ? -25202 : 0; };
  ctx.attr = (e, name) => {
    if (!e || e.gone) return null;
    if (e === appEl && app.extra && name in app.extra) return app.extra[name];
    if (name === "AXParent") return e.parent ? { el: e.parent } : null;
    if (name === "AXMenuBar") return app.menubar ? { el: app.menubar } : null;
    if (name === "AXFocusedUIElement") return app.focused ? { el: app.focused } : null;
    if (name === "AXFocusedWindow") return app.focusedWindow ? { el: app.focusedWindow } : null;
    if (name === "AXWindow") { let c = e; while (c && c.role !== "AXWindow") c = c.parent; return c ? { el: c } : null; }
    if (e.attrs && name in e.attrs) return e.attrs[name];
    const v = readFake(e);
    return v[name] === undefined ? null : v[name];
  };
  return { appEl, calls };
}

// The evidence the server keeps for an element_index (see server.mjs addItems / targetOf).
export function targetOf(res, node) { return { pid: res.pid, container: res.container, path: node.path, fp: node.fp }; }

export function makeChecker() {
  const results = [];
  const check = (name, cond, detail = "") => { results.push({ name, pass: Boolean(cond) }); console.log(`${cond ? "✅" : "❌"} ${name}${detail ? " | " + String(detail).slice(0, 110) : ""}`); };
  const done = (label) => { const failed = results.filter((r) => !r.pass); console.log(`\n${label}: ${results.length - failed.length}/${results.length} passed`); if (failed.length) process.exitCode = 1; return failed.length; };
  return { check, done };
}

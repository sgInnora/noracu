// noracu macOS accessibility engine (JXA).
//
// Run:  osascript -l JavaScript src/mac-ax.js      (one JSON request on stdin → one JSON reply on stdout)
//
// It calls the macOS Accessibility C API (ApplicationServices: AXUIElement*) through the JXA
// Objective-C bridge instead of System Events: reading a Finder window of ~500 nodes takes about
// 0.15 s this way.
//
// Invariant 1 (argv / no code from data): this script is static. Every parameter, including any text
// to insert, arrives as JSON on stdin, so it never appears in a process list or inside script source.
//
// Element identity. An AXUIElement cannot outlive this process, so an element is described by evidence
// the server keeps between calls: the owning process (pid + bundle id), its container (a window, the
// menu bar, or the app), the child-index path from that container, and a fingerprint (role, subrole,
// AXIdentifier, stable name, frame). `resolve` walks the path and checks the fingerprint; if that fails
// it searches the container for exactly one element with the same fingerprint. Zero matches is
// STALE_REF, several is AMBIGUOUS_TARGET: it never guesses.
//
// AX return codes do not prove an effect (Finder returns success for an action that does not exist), so
// every action reads the element and its window again afterwards and reports delivery as
// delivered_verified (an observed change), delivered_unverified (the call succeeded, nothing observable
// changed), not_delivered (nothing was sent) or unknown (timed out or failed mid-action), together with
// whether a retry is safe.

ObjC.import('ApplicationServices');
ObjC.import('AppKit');
ObjC.import('CoreGraphics');
ObjC.import('Foundation');

// ── CF type ids and small bridges ──────────────────────────────────────────────────────────────
const TID = {
  ax: Number($.AXUIElementGetTypeID()), val: Number($.AXValueGetTypeID()), str: Number($.CFStringGetTypeID()),
  num: Number($.CFNumberGetTypeID()), bool: Number($.CFBooleanGetTypeID()), arr: Number($.CFArrayGetTypeID()),
};
const KS = {};
function ks(name) { return KS[name] || (KS[name] = $(name)); }
function cast(raw) { if (raw === null || raw === undefined) return null; try { return ObjC.castRefToObject(raw); } catch (e) { return null; } }
function tid(o) { try { return Number($.CFGetTypeID(o)); } catch (e) { return -1; } }
function sleep(ms) { $.NSThread.sleepForTimeInterval(ms / 1000); }
function now() { return Date.now(); }

// AXValue → plain data, parsed from its description ("{value = x:1.0 y:2.0 type = kAXValueCGPointType}").
// AXValueGetValue does not bridge in JXA (the out-pointer type is rejected), the description always does.
function axValue(o) {
  let d = '';
  try { d = o.description.js; } catch (e) { return null; }
  const type = (d.match(/type = kAXValue(\w+?)Type/) || [])[1] || '';
  const num = {};
  const re = /(x|y|w|h|location|length|error):(-?[\d.]+)/g;
  let m;
  while ((m = re.exec(d))) num[m[1]] = Number(m[2]);
  if (type === 'AXError') return { error: num.error };
  if (type === 'CGPoint') return { x: num.x, y: num.y };
  if (type === 'CGSize') return { w: num.w, h: num.h };
  if (type === 'CGRect') return { x: num.x, y: num.y, w: num.w, h: num.h };
  if (type === 'CFRange') return { location: num.location, length: num.length };
  return null;
}

// Any AX attribute value → JS. Elements are returned as { el } so callers can keep using them.
function jsv(o, depth) {
  if (o === null || o === undefined) return null;
  const t = tid(o);
  if (t === TID.str) return o.js;
  if (t === TID.bool) return Boolean(o.js);
  if (t === TID.num) return Number(o.js);
  if (t === TID.val) return axValue(o);
  if (t === TID.ax) return { el: o };
  if (t === TID.arr) {
    if ((depth || 0) > 0) return null;
    const out = [];
    const n = Number(o.count);
    for (let i = 0; i < n; i++) out.push(jsv(o.objectAtIndex(i), 1));
    return out;
  }
  try { const s = o.js; if (typeof s === 'string') return s; } catch (e) { /* attributed string etc. */ }
  return null;
}

function attrErr(el, name) {
  const r = Ref();
  const e = Number($.AXUIElementCopyAttributeValue(el, ks(name), r));
  return { err: e, raw: e === 0 ? r[0] : null };
}
function attr(el, name) { const a = attrErr(el, name); return a.err === 0 ? jsv(cast(a.raw)) : null; }
function children(el) {
  const a = attrErr(el, 'AXChildren');
  if (a.err !== 0) return [];
  const arr = cast(a.raw);
  if (!arr) return [];
  const n = Number(arr.count);
  const out = [];
  for (let i = 0; i < n; i++) out.push(arr.objectAtIndex(i));
  return out;
}
function elemsOf(el, name) {
  const a = attrErr(el, name);
  if (a.err !== 0) return [];
  const o = cast(a.raw);
  if (!o) return [];
  if (tid(o) === TID.ax) return [o];
  if (tid(o) !== TID.arr) return [];
  const out = [];
  const n = Number(o.count);
  for (let i = 0; i < n; i++) out.push(o.objectAtIndex(i));
  return out;
}
function actionNames(el) {
  const r = Ref();
  if (Number($.AXUIElementCopyActionNames(el, r)) !== 0) return [];
  const arr = cast(r[0]);
  if (!arr) return [];
  const out = [];
  const n = Number(arr.count);
  for (let i = 0; i < n; i++) { try { out.push(arr.objectAtIndex(i).js); } catch (e) { /* skip */ } }
  return out;
}
function settable(el, name) {
  const r = Ref();
  return Number($.AXUIElementIsAttributeSettable(el, ks(name), r)) === 0 && Boolean(r[0]);
}
function same(a, b) { try { return Boolean($.CFEqual(a, b)); } catch (e) { return false; } }

const READ = ['AXRole', 'AXSubrole', 'AXTitle', 'AXDescription', 'AXValue', 'AXIdentifier', 'AXFrame',
  'AXEnabled', 'AXFocused', 'AXSelected', 'AXExpanded', 'AXPlaceholderValue', 'AXChildren'];
let READ_NS = null;
// One IPC round trip for every attribute a snapshot needs; missing ones come back as AXError values.
function readNode(el) {
  if (!READ_NS) READ_NS = $(READ);
  const r = Ref();
  const e = Number($.AXUIElementCopyMultipleAttributeValues(el, READ_NS, 0, r));
  const v = {};
  if (e !== 0) { v.__err = e; return v; }
  const arr = cast(r[0]);
  if (!arr) { v.__err = -1; return v; }
  for (let i = 0; i < READ.length; i++) {
    const o = arr.objectAtIndex(i);
    if (READ[i] === 'AXChildren') {
      const t = tid(o);
      const kids = [];
      if (t === TID.arr) { const n = Number(o.count); for (let k = 0; k < n; k++) kids.push(o.objectAtIndex(k)); }
      v.AXChildren = kids;
      continue;
    }
    const j = jsv(o);
    if (j && typeof j === 'object' && 'error' in j && Object.keys(j).length === 1) continue;
    v[READ[i]] = j;
  }
  return v;
}

// ── roles, names, states ─────────────────────────────────────────────────────────────────────────
const INTERACTIVE_ROLES = new Set(['AXButton', 'AXCheckBox', 'AXRadioButton', 'AXPopUpButton', 'AXMenuButton',
  'AXComboBox', 'AXTextField', 'AXTextArea', 'AXSlider', 'AXIncrementor', 'AXLink', 'AXMenuItem', 'AXMenuBarItem',
  'AXDisclosureTriangle', 'AXColorWell', 'AXDateField', 'AXDockItem', 'AXSearchField', 'AXSwitch', 'AXStepper',
  'AXRow', 'AXCell', 'AXTab', 'AXScrollArea', 'AXSegmentedControl', 'AXLevelIndicator', 'AXRuler']);
const PRIMARY_ACTIONS = new Set(['AXPress', 'AXConfirm', 'AXPick', 'AXOpen', 'AXShowMenu', 'AXIncrement', 'AXDecrement']);
const TEXT_ROLES = new Set(['AXTextField', 'AXTextArea', 'AXComboBox', 'AXSearchField']);
const TOGGLE_ROLES = new Set(['AXCheckBox', 'AXRadioButton', 'AXSwitch']);
const WRAPPER_ROLES = new Set(['AXGroup', 'AXUnknown', 'AXSplitGroup', 'AXLayoutArea', 'AXLayoutItem', 'AXList', 'AXSection', 'AXGenericElement']);

function nameOf(v) {
  const t = v.AXTitle, d = v.AXDescription, p = v.AXPlaceholderValue;
  if (typeof t === 'string' && t) return t;
  if (typeof d === 'string' && d) return d;
  if (typeof p === 'string' && p) return p;
  return '';
}
function valueOf(v, max) {
  const x = v.AXValue;
  if (typeof x === 'string') return x.length > max ? x.slice(0, max) + '…' : x;
  if (typeof x === 'number' || typeof x === 'boolean') return x;
  return undefined;
}
function statesOf(v) {
  const s = [];
  if (v.AXEnabled === false) s.push('disabled');
  if (v.AXFocused === true) s.push('focused');
  if (v.AXSelected === true) s.push('selected');
  if (v.AXExpanded === true) s.push('expanded'); else if (v.AXExpanded === false && v.AXRole !== 'AXWindow') s.push('collapsed');
  if (TOGGLE_ROLES.has(v.AXRole) || v.AXSubrole === 'AXSwitch' || v.AXSubrole === 'AXToggle') {
    if (v.AXValue === 1 || v.AXValue === true) s.push('checked'); else if (v.AXValue === 2) s.push('mixed');
  }
  return s;
}
function frameOf(v) {
  const f = v.AXFrame;
  if (f && Number.isFinite(f.x) && Number.isFinite(f.w)) return [Math.round(f.x), Math.round(f.y), Math.round(f.w), Math.round(f.h)];
  return null;
}
function roleKey(v) { return v.AXSubrole === 'AXSearchField' ? 'AXSearchField' : v.AXSubrole === 'AXSwitch' ? 'AXSwitch' : v.AXSubrole === 'AXTabButton' ? 'AXTab' : v.AXRole; }
function isInteractive(v, actions) {
  if (INTERACTIVE_ROLES.has(roleKey(v)) || INTERACTIVE_ROLES.has(v.AXRole)) return true;
  for (const a of actions) if (PRIMARY_ACTIONS.has(a)) return true;
  return false;
}
// A web/layout wrapper that carries nothing of its own: walked through, not shown in compact output,
// and not counted against the depth limit.
function isWrapper(v, actions) {
  if (!WRAPPER_ROLES.has(v.AXRole)) return false;
  if (nameOf(v) || (typeof v.AXValue === 'string' && v.AXValue) || v.AXIdentifier) return false;
  for (const a of actions) if (PRIMARY_ACTIONS.has(a)) return false;
  return true;
}
// A label identifies an element, content does not. nameOf reads only labels (title, description,
// placeholder), so a text field keeps its label as its name while its value changes; static text has
// nothing but content, so it has no stable name.
function stableName(v) { return v.AXRole === 'AXStaticText' ? '' : nameOf(v).slice(0, 120); }

// ── apps ─────────────────────────────────────────────────────────────────────────────────────────
function runningApps() {
  const a = $.NSWorkspace.sharedWorkspace.runningApplications;
  const out = [];
  const n = Number(a.count);
  for (let i = 0; i < n; i++) {
    const x = a.objectAtIndex(i);
    let name = '', bundle = '';
    try { name = x.localizedName.js || ''; } catch (e) { /* none */ }
    try { bundle = x.bundleIdentifier.js || ''; } catch (e) { /* none */ }
    out.push({ ns: x, name, bundle, pid: Number(x.processIdentifier), policy: Number(x.activationPolicy), active: Boolean(x.active), hidden: Boolean(x.hidden) });
  }
  return out;
}
function frontApp() {
  const x = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  if (!x || x.isNil()) return null;
  let bundle = '';
  try { bundle = x.bundleIdentifier.js || ''; } catch (e) { /* none */ }
  return { ns: x, name: x.localizedName.js, bundle, pid: Number(x.processIdentifier) };
}
function findApp(spec) {
  if (!spec) return frontApp();
  const apps = runningApps();
  const want = String(spec);
  if (/^\/.+\.app\/?$/.test(want)) {
    const p = want.replace(/\/$/, '');
    const hit = apps.filter(a => { try { return a.ns.bundleURL && !a.ns.bundleURL.isNil() && a.ns.bundleURL.path.js === p; } catch (e) { return false; } });
    return hit.length ? hit.sort((a, b) => b.pid - a.pid)[0] : null;
  }
  const lower = want.toLowerCase();
  let hit = apps.filter(a => a.name === want || a.bundle === want);
  if (!hit.length) hit = apps.filter(a => a.name.toLowerCase() === lower || a.bundle.toLowerCase() === lower);
  if (!hit.length) return null;
  hit.sort((a, b) => (a.policy - b.policy) || (b.active - a.active));
  return hit[0];
}
const POLICY = ['foreground', 'background', 'helper'];

const AX_MSG_TIMEOUT_S = 3.0;
function appElement(app) {
  const el = $.AXUIElementCreateApplication(app.pid);
  $.AXUIElementSetMessagingTimeout(el, AX_MSG_TIMEOUT_S);
  return el;
}

// Chromium and Electron apps build their web accessibility tree only when asked to.
const CHROMIUM_MARKERS = ['Electron Framework.framework', 'Chromium Embedded Framework.framework'];
function rendererOf(app) {
  try {
    const url = app.ns.bundleURL;
    if (!url || url.isNil()) return null;
    const dir = url.path.js + '/Contents/Frameworks';
    const list = $.NSFileManager.defaultManager.contentsOfDirectoryAtPathError(dir, null);
    if (!list || list.isNil()) return null;
    const names = [];
    const n = Number(list.count);
    for (let i = 0; i < n; i++) names.push(list.objectAtIndex(i).js);
    if (names.some(x => CHROMIUM_MARKERS.indexOf(x) >= 0 || /(Chrome|Chromium|Edge|Brave|Vivaldi|Opera|Arc).* Framework\.framework$/.test(x))) return 'chromium';
  } catch (e) { /* unknown */ }
  return null;
}
function enableWebAccessibility(appEl) {
  if (attr(appEl, 'AXManualAccessibility') === true) return 'already_on';
  if (setAttr(appEl, 'AXManualAccessibility', YES()) === 0) { sleep(600); return 'enabled'; }
  return 'unsupported';
}
// Google Chrome refuses AXManualAccessibility (-25205), yet exposes its pages when started with
// --force-renderer-accessibility (device probe 2026-11-06: AXWebArea and the page's button readable,
// while the setter still said unsupported). So for a
// window the status says what the tree holds: 'exposed' when a web area is found under it. Other
// surfaces cannot be judged and keep the setter's answer.
function webAxStatus(setter, rootEl, rootPath, isWindow) {
  if (setter !== 'unsupported' || !isWindow) return setter;
  const w = walk(rootEl, rootPath, { depth: 60, maxNodes: 100000, budgetMs: 1500, maxVisit: 5000, find: { role: 'AXWebArea', limit: 1 }, pruneMenuBar: true, rootIsContainer: true });
  return w.nodes.length ? 'exposed' : 'unsupported';
}

// ── containers (where a path starts) ─────────────────────────────────────────────────────────────
function windowsOf(appEl) { return elemsOf(appEl, 'AXWindows'); }
// The CGWindowID behind an AX window (HIServices' _AXUIElementGetWindow, bound at run time). It is the
// window's identity for its whole life, so an element is only ever re-found inside the very window it was
// seen in. null when the function is unavailable or the element is not a real window.
let AXGW = null;
function axWindowId(w) {
  if (AXGW === null) { try { ObjC.bindFunction('_AXUIElementGetWindow', ['int', ['id', 'void *']]); AXGW = true; } catch (e) { AXGW = false; } }
  if (!AXGW) return null;
  try { const r = Ref('I'); return Number($._AXUIElementGetWindow(w, r)) === 0 && Number(r[0]) > 0 ? Number(r[0]) : null; } catch (e) { return null; }
}
// The CGWindowID of the window an element is in: the element itself when it is a window, else its
// AXWindow, else the nearest AXWindow up its AXParent chain. null when none has an id.
function windowIdOf(el) {
  if (!el) return null;
  if (attr(el, 'AXRole') === 'AXWindow') return axWindowId(el);
  const aw = attr(el, 'AXWindow');
  if (aw && aw.el) { const id = axWindowId(aw.el); if (id) return id; }
  let c = el;
  for (let k = 0; k < 64 && c; k++) {
    const p = attr(c, 'AXParent');
    c = p && p.el ? p.el : null;
    if (c && attr(c, 'AXRole') === 'AXWindow') return axWindowId(c);
  }
  return null;
}
function windowInfo(w, n) {
  const v = readNode(w);
  return { kind: 'window', n, wid: axWindowId(w), title: typeof v.AXTitle === 'string' ? v.AXTitle : '', subrole: v.AXSubrole || '', frame: frameOf(v), focused: v.AXFocused === true, main: attr(w, 'AXMain') === true, minimized: attr(w, 'AXMinimized') === true };
}
function rectNear(a, b, tol) { return a && b && Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol && Math.abs(a[3] - b[3]) <= tol; }
// Finder's desktop: the one window without a CGWindowID seen on the test Mac (wid probe 2026-11-06; its
// frame is the bounding box of all displays). It is never closed and reopened, so its elements keep the
// title/frame match; any other window without an id is refused (a closed and reopened window with the
// same title and frame could not be told apart).
function isFinderDesktop(app, c) {
  if (!(app && app.bundle === 'com.apple.finder' && c && c.title === '' && !c.subrole && c.frame)) return false;
  const ds = displays().map(d => d.frame);
  if (!ds.length) return false;
  const x0 = Math.min(...ds.map(f => f[0])), y0 = Math.min(...ds.map(f => f[1]));
  const x1 = Math.max(...ds.map(f => f[0] + f[2])), y1 = Math.max(...ds.map(f => f[1] + f[3]));
  return rectNear([x0, y0, x1 - x0, y1 - y0], c.frame, 2) || ds.some(f => rectNear(f, c.frame, 2));
}

// Pick the window a snapshot is about: an explicit index/title, else the focused or main window,
// else the only window. Several candidates and no way to choose → AMBIGUOUS_WINDOW with the list.
function pickWindow(appEl, req) {
  const ws = windowsOf(appEl);
  const infos = ws.map((w, i) => windowInfo(w, i));
  if (!ws.length) return { error: { code: 'WINDOW_NOT_FOUND', message: 'the app has no window that accessibility can read (not open, minimized to the Dock, or on another Space)' } };
  if (req.window_id !== undefined && req.window_id !== null) {
    const hit = infos.filter(x => x.wid === Number(req.window_id));
    if (hit.length === 1) return { el: ws[hit[0].n], info: hit[0] };
    return { error: { code: 'WINDOW_NOT_FOUND', message: `window_id ${req.window_id} is not one of this app's windows`, details: { windows: infos.map(summaryOfWindow) } } };
  }
  if (req.window !== undefined && req.window !== null && req.window !== '') {
    const want = req.window;
    if (typeof want === 'number') {
      if (want >= 0 && want < ws.length) return { el: ws[want], info: infos[want] };
      return { error: { code: 'WINDOW_NOT_FOUND', message: `window ${want} does not exist (the app has ${ws.length})`, details: { windows: infos.map(summaryOfWindow) } } };
    }
    const hits = infos.filter(x => x.title === want);
    const loose = hits.length ? hits : infos.filter(x => x.title.toLowerCase().indexOf(String(want).toLowerCase()) >= 0);
    if (loose.length === 1) return { el: ws[loose[0].n], info: loose[0] };
    return { error: { code: loose.length ? 'AMBIGUOUS_WINDOW' : 'WINDOW_NOT_FOUND', message: `${loose.length || 'no'} window(s) match "${want}"`, details: { windows: infos.map(summaryOfWindow) } } };
  }
  const f = infos.filter(x => x.focused);
  if (f.length === 1) return { el: ws[f[0].n], info: f[0] };
  const m = infos.filter(x => x.main);
  if (m.length === 1) return { el: ws[m[0].n], info: m[0] };
  const vis = infos.filter(x => !x.minimized);
  if (vis.length === 1) return { el: ws[vis[0].n], info: vis[0] };
  if (ws.length === 1) return { el: ws[0], info: infos[0] };
  return { error: { code: 'AMBIGUOUS_WINDOW', message: `the app has ${ws.length} windows and none is focused — pass window (an index or title)`, details: { windows: infos.map(summaryOfWindow) } } };
}
function summaryOfWindow(x) { return { n: x.n, window_id: x.wid, title: x.title.slice(0, 80), frame: x.frame, minimized: x.minimized }; }

function surfaceRoot(appEl, win, surface) {
  if (surface === 'menubar') { const mb = attr(appEl, 'AXMenuBar'); return mb && mb.el ? { el: mb.el, container: { kind: 'menubar' } } : { error: { code: 'SURFACE_ABSENT', message: 'the app exposes no menu bar' } }; }
  if (surface === 'menu') {
    // an open menu hangs below a pop-up button or a context-menu target, or (menu bar menus, while open)
    // below its AXMenuBarItem; it is its own container, identified by its frame
    const found = openMenus(appEl);
    if (!found.length) return { error: { code: 'SURFACE_ABSENT', message: 'no menu is open' } };
    return { el: found[0], container: { kind: 'menu', frame: frameOf(readNode(found[0])) }, path: [] };
  }
  if (surface === 'focused') {
    const f = attr(appEl, 'AXFocusedUIElement');
    if (!f || !f.el) return { error: { code: 'SURFACE_ABSENT', message: 'the app reports no focused element' } };
    return { el: f.el, container: null }; // path is computed upward from the window by the caller
  }
  if (surface === 'sheet' || surface === 'alert' || surface === 'popover' || surface === 'dialog') {
    if (!win) return { error: { code: 'WINDOW_NOT_FOUND', message: 'no window to look for a ' + surface + ' in' } };
    const want = surface === 'sheet' ? ['AXSheet'] : surface === 'popover' ? ['AXPopover'] : ['AXSheet', 'AXDialog', 'AXSystemDialog'];
    const found = [];
    const visit = (el, d, path) => { if (d > 6 || found.length) return; const kids = children(el); for (let i = 0; i < kids.length; i++) { const v = readNode(kids[i]); if (want.indexOf(v.AXRole) >= 0 || want.indexOf(v.AXSubrole) >= 0) { found.push({ el: kids[i], path: path.concat(i) }); return; } visit(kids[i], d + 1, path.concat(i)); } };
    visit(win.el, 0, []);
    if (!found.length && surface !== 'sheet' && surface !== 'popover') {
      // a dialog or alert can also be a window of its own
      const ws = windowsOf(appEl);
      for (let i = 0; i < ws.length; i++) { const sr = attr(ws[i], 'AXSubrole'); if (sr === 'AXDialog' || sr === 'AXSystemDialog') return { el: ws[i], container: windowInfo(ws[i], i), path: [] }; }
    }
    return found.length ? { el: found[0].el, container: win.info, path: found[0].path } : { error: { code: 'SURFACE_ABSENT', message: 'no ' + surface + ' is open' } };
  }
  return null;
}

// child-index path from `top` down to `el`, by walking AXParent upward
function pathUp(el, top) {
  const path = [];
  let cur = el;
  for (let guard = 0; guard < 200; guard++) {
    if (same(cur, top)) return path.reverse();
    const p = attr(cur, 'AXParent');
    if (!p || !p.el) return null;
    const kids = children(p.el);
    let idx = -1;
    for (let i = 0; i < kids.length; i++) if (same(kids[i], cur)) { idx = i; break; }
    if (idx < 0) return null;
    path.push(idx);
    cur = p.el;
  }
  return null;
}
function windowOfElement(appEl, el) {
  const w = attr(el, 'AXWindow');
  const ws = windowsOf(appEl);
  if (w && w.el) for (let i = 0; i < ws.length; i++) if (same(ws[i], w.el)) return { el: ws[i], info: windowInfo(ws[i], i) };
  return null;
}

// ── walk ─────────────────────────────────────────────────────────────────────────────────────────
// Short digest of a value (length + hash): enough to tell two contents apart, small enough to carry
// between calls (observeState compares values through it, so a 10 MB document never travels).
function vhash(x) {
  if (x === undefined || x === null) return null;
  if (typeof x !== 'string') return typeof x === 'object' ? null : String(x);
  let h = 5381;
  for (let i = 0; i < x.length; i++) h = ((h << 5) + h + x.charCodeAt(i)) | 0;
  return x.length + ':' + (h >>> 0).toString(36);
}
function makeNode(v, ldepth, path, actions, interactive) {
  const role = v.AXRole || '?';
  const node = { d: ldepth, role, path, fp: { role, subrole: v.AXSubrole || '', id: v.AXIdentifier || '', name: stableName(v) } };
  if (v.AXSubrole) node.subrole = v.AXSubrole;
  const nm = nameOf(v); if (nm) node.title = nm.length > 80 ? nm.slice(0, 80) + '…' : nm;
  const val = valueOf(v, 120); if (val !== undefined && val !== '') node.value = val;
  const fr = frameOf(v); if (fr) { node.frame = fr; node.fp.frame = fr; }
  const st = statesOf(v); if (st.length) node.states = st;
  if (v.AXIdentifier) node.id = String(v.AXIdentifier).slice(0, 80);
  const acts = actions.filter(a => PRIMARY_ACTIONS.has(a) || a === 'AXScrollToVisible');
  if (acts.length) node.actions = acts.map(a => a.replace(/^AX/, '').toLowerCase());
  node.interactive = interactive;
  return node;
}

// Returns flat nodes in document order. Each node carries what the server needs to show it and to
// find it again (path from the container root). Logical depth skips transparent wrappers.
function walk(rootEl, rootPath, opt) {
  const nodes = [];
  const deadline = now() + opt.budgetMs;
  let visited = 0;
  let complete = true;
  const skeleton = Boolean(opt.skeleton);
  const maxDepth = skeleton ? Math.min(opt.depth, 3) : opt.depth;
  // anc: evidence about the path from the container down to this node (see pathEvidence, which re-derives
  // it while resolving) — the child count at every level (shape), the labels of the ancestors (chain),
  // and the text collectors of the nearest ITEM_LEVELS ancestors (item keys, see itemKeyOf)
  function visit(el, path, ldepth, inMenuBar, anc) {
    if (nodes.length >= opt.maxNodes || now() > deadline || visited >= opt.maxVisit) { complete = false; return 'stop'; }
    visited++;
    collect(anc.accs, null, true);
    const v = readNode(el);
    if (v.__err) { if (v.__err !== -25202) complete = false; return; } // vanished: skip; unanswered: incomplete
    const role = v.AXRole || '?';
    const isRoot = el === rootEl;
    // a text field's value counts for an ancestor's item only through a cell or row (table content)
    const t = itemText(v, true);
    if (t) collect(anc.accs, t, false, TEXT_ROLES.has(role) ? anc.cells : null);
    if (opt.pruneMenuBar && (role === 'AXMenuBar') && !inMenuBar) return;
    // every visited element counts towards "is this fingerprint unique" — also the ones a filtered
    // (find) or interactive-only snapshot does not show
    const fid = fpKey(role, v.AXSubrole || '', v.AXIdentifier || '', stableName(v));
    seen[fid] = (seen[fid] || 0) + 1;
    const actions = actionNames(el);
    const wrapper = isWrapper(v, actions);
    const interactive = isInteractive(v, actions);
    const kids = v.AXChildren || [];
    const atLimit = ldepth >= maxDepth;
    const show = !(opt.compact && wrapper) && (!opt.interactive || interactive || (skeleton && atLimit && kids.length));
    // app-level snapshots (no window container): an element under a window records that window's
    // CGWindowID, so a window closed and reopened with the same content is not taken for the old one
    const wwid = opt.trackWindow ? (role === 'AXWindow' ? axWindowId(el) : anc.wwid) : null;
    if (opt.find ? matches(v, opt.find) : show) {
      const node = makeNode(v, ldepth, path, actions, interactive);
      if (wwid) node.fp.wwid = wwid;
      if (anc.chain.length) node.fp.chain = chainKey(anc.chain);
      node._shape = anc.shape.slice();
      node._accs = anc.accs;
      node._el = el;
      if (!opt.find && atLimit && kids.length) { node.children_count = kids.length; node.truncated = true; }
      nodes.push(node);
      if (opt.find && nodes.length >= opt.find.limit) { complete = false; return 'stop'; }
    }
    if (atLimit && !opt.find) { if (kids.length && !skeleton) complete = false; if (kids.length) for (const a of anc.accs) if (!a.full) a.cut = true; return; }
    const nextDepth = wrapper ? ldepth : ldepth + 1;
    const name = isRoot && opt.rootIsContainer ? '' : chainName(v);
    // the container itself is never an item (its texts are the whole window's: toolbars, status lines),
    // nor are page-, toolbar- or pane-level groups
    const own = { texts: [], seen: 0, full: false, cut: false, closed: false, noItem: (isRoot && Boolean(opt.rootIsContainer)) || ITEM_SKIP_ROLES.has(role) };
    if (nodes.length && nodes[nodes.length - 1]._el === el) nodes[nodes.length - 1]._own = own;
    const cell = CELL_ROLES.has(role);
    const childAnc = { shape: anc.shape.concat(kids.length), chain: name ? anc.chain.concat(name) : anc.chain, accs: [own].concat(anc.accs).slice(0, ITEM_LEVELS), cells: [cell].concat(anc.cells.map(c => c || cell)).slice(0, ITEM_LEVELS), wwid };
    if (atLimit) own.cut = true;
    for (let i = 0; i < kids.length; i++) {
      if (visit(kids[i], path.concat(i), nextDepth, inMenuBar || role === 'AXMenuBar', childAnc) === 'stop') return 'stop';
    }
    own.closed = true;
  }
  const pre = opt.evidence || { shape: [], chain: [] };
  const seen = {};
  visit(rootEl, rootPath.slice(), 0, false, { shape: pre.shape.slice(), chain: pre.chain.slice(), accs: [], cells: [], wwid: opt.trackWindow ? windowIdOf(rootEl) : null });
  // Elements that share their fingerprint with another one in the container (several "Delete" buttons,
  // one per list item) are told apart by their surroundings: the path shape, and the item key. Uniqueness
  // is known only when the whole container was walked: a snapshot that stopped early, or one drilled into
  // part of the container, may have missed look-alikes, so all its elements count as duplicated.
  // Every labelled element also records its item key — the first texts under itself or its nearest
  // ancestor (within ITEM_LEVELS, never the container) that has any — because a look-alike can appear
  // after the snapshot (a second message arriving above the only one there was). Every element records
  // its path shape. An item key that two look-alikes share (both rows climbed to the same section
  // heading) tells nothing apart and is dropped.
  const whole = complete && opt.rootIsContainer !== false;
  const picked = new Map();
  for (const n of nodes) {
    const fid = fpKey(n.fp.role, n.fp.subrole, n.fp.id, n.fp.name);
    const dup = !whole || seen[fid] > 1;
    const anon = anonymousFp(n.fp);
    n.fp.shape = n._shape;
    if (dup) n.fp.dup = true;
    if (dup || !anon) {
      // its own texts first (a row's content is the row), then the nearest ancestors'
      const accs = [n._own].concat(n._accs);
      for (let k = 0; k < accs.length; k++) {
        const a = accs[k];
        if (a && a.closed && !a.cut && !a.noItem && a.texts.length) {
          n.fp.item = `${k}:${a.texts.join('\u0001')}`;
          n._acc = a;
          if (dup) { if (!picked.has(fid)) picked.set(fid, new Map()); const m = picked.get(fid); m.set(a, (m.get(a) || 0) + 1); }
          break;
        }
      }
    }
  }
  for (const n of nodes) {
    if (n.fp.dup && n._acc) { const m = picked.get(fpKey(n.fp.role, n.fp.subrole, n.fp.id, n.fp.name)); if (m && m.get(n._acc) > 1) delete n.fp.item; }
    delete n._shape; delete n._accs; delete n._el; delete n._own; delete n._acc;
  }
  return { nodes, complete, visited };
}

function textMatch(have, want, exact) {
  if (want === undefined || want === null || want === '') return true;
  if (have === undefined || have === null) return false;
  const h = String(have).toLowerCase(), w = String(want).toLowerCase();
  return exact ? h === w : h.indexOf(w) >= 0;
}
function matches(v, f) {
  if (f.role) {
    const r = String(f.role).toLowerCase().replace(/^ax/, '');
    const rk = String(roleKey(v) || '').toLowerCase().replace(/^ax/, '');
    const rr = String(v.AXRole || '').toLowerCase().replace(/^ax/, '');
    const sr = String(v.AXSubrole || '').toLowerCase().replace(/^ax/, '');
    if (r !== rk && r !== rr && r !== sr) return false;
  }
  if (f.title !== undefined && f.title !== '' && !textMatch(nameOf(v), f.title, f.exact)) return false;
  if (f.value !== undefined && f.value !== '' && !textMatch(typeof v.AXValue === 'string' || typeof v.AXValue === 'number' ? v.AXValue : null, f.value, f.exact)) return false;
  if (f.id && !textMatch(v.AXIdentifier, f.id, f.exact)) return false;
  // text: the label or the value, each matched on its own (exact means the whole string, case-insensitive)
  if (f.text !== undefined && f.text !== '' && !textMatch(nameOf(v), f.text, f.exact) && !textMatch(typeof v.AXValue === 'string' || typeof v.AXValue === 'number' ? v.AXValue : null, f.text, f.exact)) return false;
  return Boolean(f.role || f.title || f.value || f.id || f.text);
}

// ── resolve (re-identify an element from stored evidence) ────────────────────────────────────────
// Fingerprint check. Role, subrole, AXIdentifier and stable name must match exactly in both directions
// (an element that gained or lost a label is not the one that was seen).
function fpOk(v, fp) {
  if ((v.AXRole || '') !== fp.role) return false;
  if ((v.AXSubrole || '') !== (fp.subrole || '')) return false;
  if ((v.AXIdentifier || '') !== (fp.id || '')) return false;
  if (stableName(v) !== (fp.name || '')) return false;
  return true;
}
// An element with neither an identifier nor a label is told apart from its look-alikes only by where it
// is, so its position is part of its identity.
function anonymousFp(fp) { return !fp.id && !fp.name; }
// Frames are screen coordinates. Comparing them after subtracting how far the container (window or
// open menu) moved since the snapshot keeps a dragged window's elements identifiable; a change inside
// the window (scrolling, a row inserted above) still shows.
const POS_TOL = 4;          // px: same element, re-laid-out by at most rounding
const PATH_NAMED_TOL = 48;  // px: a named element still at its recorded path but moved further is re-searched
const SEARCH_NAMED_TOL = 64; // px: how far from its place a labelled element may be found by search
function frameNear(v, fp, shift, tol) {
  if (!fp.frame) return true;
  const f = frameOf(v);
  if (!f) return false;
  return rectNear([f[0] - shift[0], f[1] - shift[1], f[2], f[3]], fp.frame, tol);
}
// ── evidence along the path ──────────────────────────────────────────────────────────────────────
// Besides its own fingerprint an element is described by where it sits: the labels of its ancestors
// (chain; window-level titles such as a web page's are left out because they change with content, and
// digits are ignored so "Inbox (3)" stays "Inbox (#)"), and, when it has no label or shares its
// fingerprint with another element, the child count at every level of its path (shape: an item
// inserted or removed above it shows) and the first texts of the nearest ancestor that has any (item:
// a re-sorted or recycled list puts another item's content at the same place).
const ITEM_LEVELS = 4, ITEM_TEXTS = 6, ITEM_VISIT = 40;
const CELL_ROLES = new Set(['AXCell', 'AXRow']);
const ITEM_SKIP_ROLES = new Set(['AXWebArea', 'AXToolbar', 'AXScrollArea', 'AXSplitGroup', 'AXWindow', 'AXSheet', 'AXApplication']);
const VOLATILE_NAME_ROLES = new Set(['AXWebArea', 'AXWindow', 'AXSheet', 'AXScrollArea', 'AXApplication']);
// text that identifies a list item: static text, a link's label, and a text field's content only when
// the field is table content (a cell or row lies between the item and the field: a file name in
// Finder's name column) — a form field's value is what the user types, not where the element is; never
// a button title (every item has the same buttons)
function itemText(v, cellOk) {
  const r = v.AXRole;
  const field = TEXT_ROLES.has(r) && cellOk;
  const t = r === 'AXStaticText' || field ? (typeof v.AXValue === 'string' ? v.AXValue : '') : r === 'AXLink' ? nameOf(v) : '';
  return t.trim() ? t.trim().slice(0, 60) : '';
}
function fpKey(role, subrole, id, name) { return [role, subrole, id, name].join('\u0001'); }
// walk-side collection: every visited descendant counts against ITEM_VISIT (whether or not it answers),
// texts are kept in document order until ITEM_TEXTS — itemKeyOf counts the same way
function collect(accs, text, counting, mask) {
  for (let j = 0; j < accs.length; j++) {
    const a = accs[j];
    if (a.full) continue;
    if (counting) { if (++a.seen > ITEM_VISIT) a.full = true; continue; }
    if (text && (!mask || mask[j])) { a.texts.push(text); if (a.texts.length >= ITEM_TEXTS) a.full = true; }
  }
}
function chainName(v) { return VOLATILE_NAME_ROLES.has(v.AXRole) ? '' : stableName(v).replace(/\d+/g, '#'); }
function chainKey(chain) { return chain.join('\u0001').slice(0, 300); }
// the item key of `anc`, the k-th ancestor: the first ITEM_TEXTS texts among its first ITEM_VISIT
// descendants in document order (menu bars are skipped as in walk unless the container is the menu bar)
function itemKeyOf(anc, k, skipMenuBar) {
  const texts = [];
  let seen = 0, stop = false;
  // cellOk: a cell or row lies between `anc` (inclusive) and this element (exclusive)
  const visit = (e, cellOk) => {
    if (stop) return;
    if (++seen > ITEM_VISIT) { stop = true; return; }
    const v = readNode(e);
    if (v.__err) return;
    const t = itemText(v, cellOk);
    if (t) { texts.push(t); if (texts.length >= ITEM_TEXTS) { stop = true; return; } }
    if (skipMenuBar && v.AXRole === 'AXMenuBar') return;
    const below = cellOk || CELL_ROLES.has(v.AXRole);
    for (const c of v.AXChildren || []) { visit(c, below); if (stop) return; }
  };
  const top = CELL_ROLES.has(attr(anc, 'AXRole'));
  for (const c of children(anc)) { visit(c, top); if (stop) break; }
  return `${k}:${texts.join('\u0001')}`;
}
// One child by index, and the child count, without bridging the whole AXChildren array (a 5,000-row
// outline would otherwise cross the bridge on every step); falls back to the full list.
function childCount(el) {
  const r = Ref();
  if (Number($.AXUIElementGetAttributeValueCount(el, ks('AXChildren'), r)) === 0) { const n = Number(r[0]); if (Number.isFinite(n)) return n; }
  return children(el).length;
}
function childAt(el, i) {
  const r = Ref();
  if (Number($.AXUIElementCopyAttributeValues(el, ks('AXChildren'), i, 1, r)) === 0) { const a = cast(r[0]); if (a && Number(a.count) === 1) return a.objectAtIndex(0); }
  const kids = children(el);
  return i < kids.length ? kids[i] : null;
}
const LITE = ['AXRole', 'AXSubrole', 'AXTitle', 'AXDescription', 'AXPlaceholderValue', 'AXIdentifier'];
let LITE_NS = null;
// role and label attributes only (no children, no value) — for ancestors along a path
function readLite(el) {
  if (!LITE_NS) LITE_NS = $(LITE);
  const r = Ref();
  if (Number($.AXUIElementCopyMultipleAttributeValues(el, LITE_NS, 0, r)) !== 0) return { __err: -1 };
  const arr = cast(r[0]);
  if (!arr) return { __err: -1 };
  const v = {};
  for (let i = 0; i < LITE.length; i++) { const j = jsv(arr.objectAtIndex(i)); if (j && typeof j === 'object' && 'error' in j) continue; v[LITE[i]] = j; }
  return v;
}
// shape and chain of the element reached by following `path` from `root`; `els` are the elements along
// the way (root excluded, the element itself last)
function pathEvidence(root, path, skipMenuBar) {
  const shape = [], chain = [], els = [];
  let el = root;
  for (let k = 0; k < path.length; k++) {
    const n = childCount(el);
    shape.push(n);
    if (path[k] >= n) return { ok: false };
    el = childAt(el, path[k]);
    if (!el) return { ok: false };
    els.push(el);
    if (k < path.length - 1) {
      const v = readLite(el);
      if (v.__err) return { ok: false };
      if (skipMenuBar && v.AXRole === 'AXMenuBar') return { ok: false };
      const nm = chainName(v); if (nm) chain.push(nm);
    } else if (skipMenuBar && k === 0 && attr(el, 'AXRole') === 'AXMenuBar') return { ok: false };
  }
  return { ok: true, el, shape, chain, els };
}
// chain, shape and nearest ancestors of an element found by search, climbing AXParent to the container
function climbEvidence(e, root) {
  const chain = [], ancs = [], shape = [];
  const p0 = attr(e, 'AXParent');
  let cur = p0 && p0.el ? p0.el : null;
  for (let g = 0; g < 200 && cur; g++) {
    ancs.push(cur);
    shape.unshift(childCount(cur));
    if (same(cur, root)) return { chain, ancs, shape };
    const v = readLite(cur);
    if (v.__err) return null;
    const n = chainName(v); if (n) chain.unshift(n);
    const up = attr(cur, 'AXParent');
    cur = up && up.el ? up.el : null;
  }
  return null;
}
// item key check: level 0 is the element itself, then its ancestors nearest first (the container last)
// A look-alike's item must match exactly ("Invoice 12" is not "Invoice 13"); a unique element's item
// ignores digits like the ancestor chain does (a counter or a relative time in the same group changes)
function itemSame(el, ancs, fp, skipMenuBar, exact) {
  if (!fp.item) return true;
  const k = itemLevel(fp);
  const a = k === 0 ? el : ancs[k - 1];
  if (!a) return false;
  const live = itemKeyOf(a, k, skipMenuBar);
  return fp.dup || exact ? live === fp.item : live.replace(/\d+/g, '#') === fp.item.replace(/\d+/g, '#');
}
function itemLevel(fp) { return fp.item ? Number(fp.item.slice(0, fp.item.indexOf(':'))) : -1; }
// open menus (a pop-up, a context menu, a menu bar menu while it is open)
function openMenus(appEl) {
  const found = [];
  const visit = (el, d) => { if (d > 30) return; const r = attr(el, 'AXRole'); if (r === 'AXMenu') { found.push(el); return; } for (const k of children(el)) visit(k, d + 1); };
  for (const w of windowsOf(appEl)) visit(w, 0);
  const mb = attr(appEl, 'AXMenuBar');
  if (mb && mb.el) for (const item of children(mb.el)) if (attr(item, 'AXSelected') === true) for (const k of children(item)) if (attr(k, 'AXRole') === 'AXMenu') found.push(k);
  return found;
}
function containerEl(appEl, c, app) {
  if (!c || c.kind === 'app') return { el: appEl, shift: [0, 0] };
  if (c.kind === 'menubar') { const mb = attr(appEl, 'AXMenuBar'); return mb && mb.el ? { el: mb.el, shift: [0, 0] } : { error: 'menubar_absent' }; }
  if (c.kind === 'menu') {
    // the same open menu: an AXMenu at the recorded frame; a closed menu is a stale reference, never a
    // reason to look anywhere else (closed menu items can still be pressed, so a look-alike would run)
    const hit = openMenus(appEl).filter(m => rectNear(frameOf(readNode(m)), c.frame, POS_TOL));
    if (hit.length === 1) return { el: hit[0], shift: [0, 0] };
    return { error: hit.length ? 'menu_ambiguous' : 'menu_closed' };
  }
  if (c.kind === 'window') {
    const ws = windowsOf(appEl);
    const shiftOf = (w) => { const f = frameOf(readNode(w)); return f && c.frame ? [f[0] - c.frame[0], f[1] - c.frame[1]] : [0, 0]; };
    // exact: the same CGWindowID (survives title changes, never matches another window)
    if (c.wid) {
      for (const w of ws) if (axWindowId(w) === c.wid) return { el: w, shift: shiftOf(w) };
      return { error: 'window_absent' };
    }
    // no id was available when the element was seen: a window closed and reopened with the same title,
    // subrole and frame could not be told apart from it, so refuse — except Finder's desktop, which is
    // never reopened. (Reddit r/mcp review 2026-11-06)
    if (!isFinderDesktop(app, c)) return { error: 'window_unverifiable' };
    // the desktop: same title, subrole and frame; a changed frame is a stale reference
    const infos = ws.map((w, i) => windowInfo(w, i));
    const hits = infos.filter(x => x.title === c.title && x.subrole === c.subrole && (!c.frame || rectNear(x.frame, c.frame, POS_TOL)));
    if (hits.length === 1) return { el: ws[hits[0].n], shift: [0, 0] };
    return { error: hits.length ? 'window_ambiguous' : 'window_absent' };
  }
  return { error: 'container_unknown' };
}
const SEARCH_MAX_DEPTH = 150, SEARCH_MAX_VISIT = 20000;
// An element seen in an app-level snapshot recorded the CGWindowID of the window it was in (fp.wwid):
// found again, it must still be in that very window — a window closed and reopened with the same content
// has a new id and is a stale reference (Reddit r/mcp review 2026-11-06).
function resolveTarget(t, budgetMs) {
  const r = resolveTargetCore(t, budgetMs);
  if (r.error || !t || !t.fp || !t.fp.wwid) return r;
  const live = windowIdOf(r.el);
  if (live === t.fp.wwid) return r;
  return { error: { code: 'STALE_REF', message: live ? 'the element\'s window was closed and another one opened in its place since the snapshot' : 'the element is no longer in the window it was seen in', details: { kind: 'window_replaced' } } };
}
function resolveTargetCore(t, budgetMs) {
  if (!$.AXIsProcessTrusted()) return { error: permError() };
  const apps = runningApps().filter(a => a.pid === t.pid);
  if (!apps.length) return { error: { code: 'STALE_REF', message: `the app (pid ${t.pid}) is no longer running`, details: { kind: 'app_gone' } } };
  const app = apps[0];
  const appEl = appElement(app);
  const kind = t.container && t.container.kind || 'app';
  const c = containerEl(appEl, t.container, app);
  if (c.error === 'window_unverifiable') {
    return { error: { code: 'POLICY_DENIED', message: 'the element\'s window had no window ID when it was read, so a window closed and reopened with the same title and frame could not be told apart from it — element_index actions in this window are refused (use the app\'s menu with mac_menu_command, or mac_click x,y, which checks the window on top)', details: { kind: 'window_unverifiable' } } };
  }
  if (c.error) {
    const amb = /ambiguous/.test(c.error);
    const what = kind === 'menu' ? 'the menu the element was in is closed' : 'the element\'s window is gone';
    return { error: { code: amb ? 'AMBIGUOUS_TARGET' : 'STALE_REF', message: amb ? `several ${kind === 'menu' ? 'menus' : 'windows'} match the element's ${kind === 'menu' ? 'menu' : 'window'}` : what, details: { kind: c.error } } };
  }
  const anon = anonymousFp(t.fp);
  // the menu bar is searched only for elements that were seen in it: a closed menu's items can still be
  // pressed, so a vanished pop-up item must not turn into the menu bar item of the same name
  const skipMenuBar = kind !== 'menubar';
  const chainOk = (chain) => chainKey(chain) === (t.fp.chain || '');
  const shapeOk = (shape) => !t.fp.shape || JSON.stringify(shape) === JSON.stringify(t.fp.shape);
  // 1) the recorded path: the element there must carry the same fingerprint, sit where it sat (relative
  // to its container) under the same labelled ancestors; an unlabelled or duplicated element must also
  // keep its item key, or — without one — the shape of its path
  const pe = pathEvidence(c.el, t.path, skipMenuBar);
  if (pe.ok) {
    const v = readNode(pe.el);
    const ancs = pe.els.slice(0, -1).reverse().concat([c.el]);
    // the shape of the path must hold unless the element's own item (itself or its parent) vouches for
    // it word for word — an unlabelled element always needs it; a different shape sends a labelled one
    // to the search (a row prepended above "Invoice 12" that reads "Invoice 13" is not a match)
    const ownItem = !anon && itemLevel(t.fp) >= 0 && itemLevel(t.fp) <= 1;
    const shaped = shapeOk(pe.shape);
    if (!v.__err && fpOk(v, t.fp) && frameNear(v, t.fp, c.shift, anon ? POS_TOL : PATH_NAMED_TOL) && chainOk(pe.chain)
      && (shaped ? (!t.fp.item || itemSame(pe.el, ancs, t.fp, skipMenuBar)) : ownItem && itemSame(pe.el, ancs, t.fp, skipMenuBar, true))) {
      return { el: pe.el, app, appEl, v, how: 'path', path: t.path.slice(), containerEl: c.el };
    }
  }
  // An unlabelled element is identified only by where it is: when its path no longer leads to it, it is
  // stale (a look-alike elsewhere is not evidence of anything).
  if (anon) return { error: { code: 'STALE_REF', message: 'the element moved or was replaced since the snapshot (it has no label or identifier, so only its place identifies it)', details: { kind: 'saved_ref_moved' } } };
  // 2) a labelled element: search the container for the same fingerprint
  const deadline = now() + (budgetMs || 3000);
  const hits = [];
  let complete = true, visited = 0;
  const visit = (e, d) => {
    if (now() > deadline || d > SEARCH_MAX_DEPTH || visited >= SEARCH_MAX_VISIT) { complete = false; return; }
    visited++;
    const v = readNode(e);
    if (v.__err) { if (v.__err !== -25202) complete = false; return; }
    if (skipMenuBar && v.AXRole === 'AXMenuBar') return;
    if (fpOk(v, t.fp)) hits.push({ el: e, v });
    for (const k of v.AXChildren || []) visit(k, d + 1);
  };
  visit(c.el, 0);
  const found = (h, how) => ({ el: h.el, app, appEl, v: h.v, how, path: null, containerEl: c.el });
  const evOk = (h, withItem) => { const ev = climbEvidence(h.el, c.el); return Boolean(ev) && chainOk(ev.chain) && (!withItem || itemSame(h.el, ev.ancs, t.fp, skipMenuBar)); };
  if (t.fp.dup) {
    // one of several look-alikes (a Delete per list item): only its item's texts tell which one it was
    if (!t.fp.item) return { error: { code: 'STALE_REF', message: 'the element moved and it has look-alikes that nothing tells apart — take a new snapshot', details: { kind: 'saved_ref_moved' } } };
    const agree = hits.filter(h => evOk(h, true));
    const pick = agree.length > 1 ? agree.filter(h => frameNear(h.v, t.fp, c.shift, POS_TOL)) : agree;
    if (pick.length === 1 && (complete || agree.length === 1)) return found(pick[0], 'search+item');
    if (agree.length > 1) return { error: { code: 'AMBIGUOUS_TARGET', message: `${agree.length} look-alikes now match this element and its item — take a new snapshot`, details: { kind: 'saved_ref_ambiguous' } } };
    return { error: { code: 'STALE_REF', message: 'the element and its item are gone or changed since the snapshot', details: { kind: complete ? 'saved_ref_absent' : 'search_incomplete' } } };
  }
  // the only element with this identifier in the snapshot: unique in the whole container, under the same
  // ancestors, is enough
  if (t.fp.id && hits.length === 1 && complete && evOk(hits[0], true)) return found(hits[0], 'search');
  // the only element with this label in the snapshot: it must still be close to where it was (a
  // same-named control elsewhere — another panel's Delete after this panel closed — is not it), under the
  // same ancestors and, when it has one, in the same item (a look-alike that arrived since is not it)
  const close = hits.filter(h => frameNear(h.v, t.fp, c.shift, SEARCH_NAMED_TOL) && evOk(h, true));
  if (close.length === 1 && (complete || frameNear(close[0].v, t.fp, c.shift, POS_TOL))) return found(close[0], 'search+frame');
  if (close.length > 1) return { error: { code: 'AMBIGUOUS_TARGET', message: `${close.length} elements with this element's role and name are near where it was — take a new snapshot`, details: { kind: 'saved_ref_ambiguous' } } };
  return { error: { code: 'STALE_REF', message: hits.length ? 'the element is no longer where it was (a control with the same name exists elsewhere, which is not taken for it)' : 'the element is gone or changed since the snapshot', details: { kind: complete ? (hits.length ? 'saved_ref_moved' : 'saved_ref_absent') : 'search_incomplete' } } };
}
// the live child-index path of a resolved element (the recorded one, or re-derived after a search)
function livePath(r) { return r.path || pathUp(r.el, r.containerEl); }

function permError() {
  return { code: 'PERM_DENIED', message: 'Accessibility permission is missing for the app that runs noracu (the MCP host) — System Settings → Privacy & Security → Accessibility (on macOS 27: Device Control and Data Access), enable the host, then quit and reopen it' };
}

// ── ops ──────────────────────────────────────────────────────────────────────────────────────────
function opSnapshot(req) {
  if (!$.AXIsProcessTrusted()) return fail(permError());
  const app = req.root ? (runningApps().find(a => a.pid === req.root.pid) || null) : appForRequest(req);
  if (!app) return fail(req.root ? { code: 'STALE_REF', message: `the app (pid ${req.root.pid}) is no longer running`, details: { kind: 'app_gone' } } : appNotFound(req));
  const appEl = appElement(app);
  let webAx = null;
  if (req.web_accessibility !== false && rendererOf(app) === 'chromium') webAx = enableWebAccessibility(appEl);
  const opt = {
    depth: clamp(req.depth, 1, 40, 12), maxNodes: clamp(req.max_nodes, 10, 2000, 400), budgetMs: clamp(req.budget_ms, 500, 20000, 8000),
    maxVisit: 20000, interactive: Boolean(req.interactive), compact: req.compact !== false, skeleton: Boolean(req.skeleton),
    pruneMenuBar: true,
  };
  // contEl: the element the container record stands for (where paths start); the root is walked
  let root, container, basePath = [], winInfo = null, surface = req.surface || 'window', contEl = null;
  if (req.root) {
    const r = resolveTarget(req.root, 3000);
    if (r.error) return fail(r.error);
    // children are numbered from where the root is now, not from where it was (it may have been found
    // by search after siblings moved)
    const p = livePath(r);
    if (!p) return fail({ code: 'STALE_REF', message: 'the element was found but could not be placed inside its container — take a new snapshot', details: { kind: 'unplaceable' } });
    root = r.el; container = req.root.container; basePath = p; surface = 'root'; contEl = r.containerEl;
    opt.pruneMenuBar = false;
  } else if (surface === 'window' || surface === 'app') {
    if (surface === 'app') { root = appEl; container = { kind: 'app' }; }
    else {
      const w = pickWindow(appEl, req);
      if (w.error) return fail(w.error);
      root = w.el; container = w.info; winInfo = w.info;
    }
    contEl = root;
  } else {
    let win = null;
    if (surface === 'sheet' || surface === 'alert' || surface === 'popover' || surface === 'dialog') { const w = pickWindow(appEl, req); if (w.error) return fail(w.error); win = w; winInfo = w.info; }
    const s = surfaceRoot(appEl, win, surface);
    if (!s) return fail({ code: 'INVALID_ARGS', message: `unknown surface "${surface}"` });
    if (s.error) return fail(s.error);
    root = s.el; opt.pruneMenuBar = false;
    if (surface === 'focused') {
      const w = windowOfElement(appEl, s.el);
      if (w) { container = w.info; winInfo = w.info; contEl = w.el; const p = pathUp(s.el, w.el); if (!p) return fail({ code: 'INTERNAL', message: 'could not place the element inside its window' }); basePath = p; }
      else {
        const mb = attr(appEl, 'AXMenuBar');
        const pm = mb && mb.el ? pathUp(s.el, mb.el) : null;
        if (pm) { container = { kind: 'menubar' }; basePath = pm; contEl = mb.el; }
        else { const p = pathUp(s.el, appEl); if (!p) return fail({ code: 'INTERNAL', message: 'could not place the element inside its app' }); container = { kind: 'app' }; basePath = p; contEl = appEl; }
      }
    } else {
      container = s.container; basePath = s.path || [];
      // a sheet / popover / dialog inside a window starts its paths at the window; a dialog that is a
      // window of its own, a menu or the menu bar is its own container
      contEl = basePath.length && win ? win.el : root;
    }
  }
  // evidence of the path above the walk's root: none when the root is the container itself; for a drill
  // or a surface inside a window, what resolve will re-derive along basePath
  opt.rootIsContainer = !basePath.length || !contEl || same(root, contEl);
  if (!opt.rootIsContainer) {
    const ev = pathEvidence(contEl, basePath, false);
    if (!ev.ok) return fail({ code: 'STALE_REF', message: 'the element moved while the snapshot started — take a new snapshot', details: { kind: 'unplaceable' } });
    opt.evidence = { shape: ev.shape, chain: ev.chain };
  }
  const t0 = now();
  const rv = readNode(root);
  if (rv.__err === -25204) return fail({ code: 'APP_UNRESPONSIVE', message: `"${app.name}" did not answer accessibility in time (it may be busy or hung)` });
  opt.trackWindow = !container || container.kind === 'app';
  const w = walk(root, basePath, opt);
  const out = {
    ok: true, app: app.name, bundle_id: app.bundle, pid: app.pid, surface, complete: w.complete,
    container: containerOut(container), nodes: w.nodes, visited: w.visited, ms: now() - t0,
  };
  if (req.root) out.root_path = basePath;
  if (winInfo) out.window = { title: winInfo.title, frame: winInfo.frame, n: winInfo.n, window_id: winInfo.wid };
  if (webAx) out.web_accessibility = webAxStatus(webAx, root, basePath, surface === 'window');
  if (container && container.kind === 'window' && !container.wid && !isFinderDesktop(app, container)) out.window_identity = 'unverifiable';
  return out;
}
function containerOut(c) {
  if (!c) return { kind: 'app' };
  if (c.kind === 'window') return { kind: 'window', wid: c.wid, title: c.title, subrole: c.subrole, frame: c.frame, n: c.n };
  if (c.kind === 'menu') return { kind: 'menu', frame: c.frame };
  return { kind: c.kind };
}
// The app a request is about: app (name, bundle id or .app path), else the owner of window_id (a
// CGWindowID from mac_windows), else the frontmost app.
function appForRequest(req) {
  if (!req.app && req.window_id !== undefined && req.window_id !== null) {
    const cg = cgWindow(Number(req.window_id));
    return cg ? runningApps().find(a => a.pid === cg.pid) || null : null;
  }
  return findApp(req.app);
}
function appNotFound(req) {
  if (!req.app && req.window_id !== undefined && req.window_id !== null) return { code: 'WINDOW_NOT_FOUND', message: `no window with id ${req.window_id}` };
  return { code: 'APP_NOT_FOUND', message: req.app ? `no running app named "${req.app}"` : 'no frontmost app' };
}

function opFind(req) {
  if (!$.AXIsProcessTrusted()) return fail(permError());
  const app = appForRequest(req);
  if (!app) return fail(appNotFound(req));
  const appEl = appElement(app);
  let webAx = null;
  if (req.web_accessibility !== false && rendererOf(app) === 'chromium') webAx = enableWebAccessibility(appEl);
  let root, container, basePath = [];
  const surface = req.surface || 'window';
  if (surface === 'menubar') { const s = surfaceRoot(appEl, null, 'menubar'); if (s.error) return fail(s.error); root = s.el; container = { kind: 'menubar' }; }
  else if (surface === 'app') { root = appEl; container = { kind: 'app' }; }
  else { const w = pickWindow(appEl, req); if (w.error) return fail(w.error); root = w.el; container = w.info; }
  const f = { role: req.role, title: req.title, value: req.value, id: req.id, text: req.text, exact: Boolean(req.exact), limit: clamp(req.limit, 1, 50, 10) };
  if (!(f.role || f.title || f.value || f.id || f.text)) return fail({ code: 'INVALID_ARGS', message: 'give at least one of role, title, value, id, text' });
  const w = walk(root, basePath, { depth: 60, maxNodes: 100000, budgetMs: clamp(req.budget_ms, 500, 20000, 8000), maxVisit: 30000, find: f, pruneMenuBar: surface !== 'menubar', rootIsContainer: true, trackWindow: surface === 'app' });
  const out = { ok: true, app: app.name, bundle_id: app.bundle, pid: app.pid, surface, container: containerOut(container), nodes: w.nodes, complete: w.complete, visited: w.visited };
  if (webAx) out.web_accessibility = webAxStatus(webAx, root, basePath, surface === 'window');
  if (container && container.kind === 'window' && !container.wid && !isFinderDesktop(app, container)) out.window_identity = 'unverifiable';
  return out;
}

function opGet(req) {
  const r = resolveTarget(req.target, 3000);
  if (r.error) return fail(r.error);
  const v = r.v;
  const out = { ok: true, how: r.how, role: v.AXRole, title: nameOf(v) };
  if (v.AXSubrole) out.subrole = v.AXSubrole;
  if (typeof v.AXDescription === 'string' && v.AXDescription && v.AXDescription !== out.title) out.description = v.AXDescription;
  const val = valueOf(v, clamp(req.max_chars, 1, 100000, 4000)); if (val !== undefined) out.value = val;
  const fr = frameOf(v); if (fr) out.frame = fr;
  out.states = statesOf(v);
  out.actions = actionNames(r.el).map(a => a.replace(/^AX/, '').toLowerCase());
  if (v.AXIdentifier) out.id = v.AXIdentifier;
  const help = attr(r.el, 'AXHelp'); if (typeof help === 'string' && help) out.help = help.slice(0, 300);
  out.settable = { value: settable(r.el, 'AXValue'), selected_text: settable(r.el, 'AXSelectedText'), focused: settable(r.el, 'AXFocused') };
  out.children = (v.AXChildren || []).length;
  return out;
}

function opApps(req) {
  const front = frontApp();
  const apps = runningApps().filter(a => req.all || a.policy <= 1).map(a => ({
    name: a.name, pid: a.pid, bundle_id: a.bundle, presentation: POLICY[a.policy] || 'helper',
    frontmost: Boolean(front && front.pid === a.pid), hidden: a.hidden,
  }));
  const f = req.filter ? String(req.filter).toLowerCase() : '';
  return { ok: true, apps: f ? apps.filter(a => a.name.toLowerCase().indexOf(f) >= 0 || a.bundle_id.toLowerCase().indexOf(f) >= 0) : apps };
}

function displays() {
  const s = $.NSScreen.screens;
  const out = [];
  const n = Number(s.count);
  // AppKit's origin is bottom-left of the main screen; accessibility and cliclick use top-left
  const mainH = n ? Number(s.objectAtIndex(0).frame.size.height) : 0;
  for (let i = 0; i < n; i++) {
    const sc = s.objectAtIndex(i);
    const f = sc.frame;
    const x = Number(f.origin.x), y = Number(f.origin.y), w = Number(f.size.width), h = Number(f.size.height);
    let name = '';
    try { name = sc.localizedName.js; } catch (e) { /* older macOS */ }
    out.push({ index: i, name, frame: [Math.round(x), Math.round(mainH - y - h), Math.round(w), Math.round(h)], scale: Number(sc.backingScaleFactor), main: i === 0 });
  }
  return out;
}

function opWindows(req) {
  const opts = req.include_offscreen ? $.kCGWindowListOptionAll : ($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements);
  const info = cast($.CGWindowListCopyWindowInfo(opts, 0));
  const front = frontApp();
  const out = [];
  let named = 0;
  const n = info ? Number(info.count) : 0;
  const wantApp = req.app ? String(req.app).toLowerCase() : '';
  for (let i = 0; i < n; i++) {
    const d = info.objectAtIndex(i);
    const get = k => { const o = d.objectForKey(ks(k)); return o && !o.isNil() ? o : null; };
    const layer = Number(get('kCGWindowLayer') ? get('kCGWindowLayer').js : 0);
    if (layer !== 0 && !req.all_layers) continue;
    const owner = get('kCGWindowOwnerName') ? get('kCGWindowOwnerName').js : '';
    if (wantApp && owner.toLowerCase().indexOf(wantApp) < 0) continue;
    const b = get('kCGWindowBounds');
    const bounds = b ? [Math.round(Number(b.objectForKey(ks('X')).js)), Math.round(Number(b.objectForKey(ks('Y')).js)), Math.round(Number(b.objectForKey(ks('Width')).js)), Math.round(Number(b.objectForKey(ks('Height')).js))] : null;
    const title = get('kCGWindowName') ? get('kCGWindowName').js : null;
    if (title !== null) named++;
    const pid = Number(get('kCGWindowOwnerPID') ? get('kCGWindowOwnerPID').js : 0);
    out.push({ id: Number(get('kCGWindowNumber').js), app: owner, pid, title, bounds, onscreen: Boolean(get('kCGWindowIsOnscreen') && get('kCGWindowIsOnscreen').js), layer, frontmost_app: Boolean(front && front.pid === pid) });
  }
  // Without Screen Recording permission window titles are withheld; fill them from accessibility.
  if ($.AXIsProcessTrusted()) {
    const byPid = {};
    for (const w of out) if (w.title === null || w.title === '') (byPid[w.pid] = byPid[w.pid] || []).push(w);
    for (const pid of Object.keys(byPid)) {
      const appEl = $.AXUIElementCreateApplication(Number(pid));
      $.AXUIElementSetMessagingTimeout(appEl, 1.0);
      const ws = windowsOf(appEl);
      for (let i = 0; i < ws.length; i++) {
        const wi = windowInfo(ws[i], i);
        const hit = byPid[pid].find(x => rectNear(x.bounds, wi.frame, 2));
        if (hit) { hit.title = wi.title; hit.ax_index = i; }
      }
    }
  }
  return { ok: true, windows: out, displays: displays(), titles_from_screen_recording: named > 0 };
}

function opStatus(req) {
  const front = frontApp();
  let screenRecording = null;
  try {
    // window titles of other apps are visible only with Screen Recording permission
    const info = cast($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0));
    const n = info ? Number(info.count) : 0;
    const me = Number($.NSProcessInfo.processInfo.processIdentifier);
    let others = 0, named = 0;
    for (let i = 0; i < n; i++) {
      const d = info.objectAtIndex(i);
      const pid = Number(d.objectForKey(ks('kCGWindowOwnerPID')).js);
      if (pid === me) continue;
      others++;
      const t = d.objectForKey(ks('kCGWindowName'));
      if (t && !t.isNil()) named++;
    }
    screenRecording = others ? named > 0 : null;
  } catch (e) { /* unknown */ }
  const ver = $.NSProcessInfo.processInfo.operatingSystemVersion;
  return {
    ok: true, accessibility: Boolean($.AXIsProcessTrusted()), screen_recording: screenRecording,
    frontmost: front ? { name: front.name, pid: front.pid, bundle_id: front.bundle } : null,
    macos: `${Number(ver.majorVersion)}.${Number(ver.minorVersion)}.${Number(ver.patchVersion)}`,
    displays: displays(),
  };
}

function clamp(v, lo, hi, dflt) { const n = Number(v); if (!Number.isFinite(n)) return dflt; return Math.min(Math.max(Math.round(n), lo), hi); }
function fail(e) { const o = { ok: false, code: e.code, message: e.message }; if (e.details) o.details = e.details; if (e.delivery) o.delivery = e.delivery; if (e.retry) o.retry = e.retry; return o; }

// ── actions ──────────────────────────────────────────────────────────────────────────────────────
const YES = () => $.NSNumber.numberWithBool(true);
const NO = () => $.NSNumber.numberWithBool(false);
function perform(el, action) { return Number($.AXUIElementPerformAction(el, ks(action))); }
function setAttr(el, name, value) { return Number($.AXUIElementSetAttributeValue(el, ks(name), value)); }
function notDelivered(e) { return Object.assign({ delivery: 'not_delivered', retry: 'safe' }, e); }

// AX error code of a write or an action → what it means for delivery
function axCallError(code, what) {
  if (code === -25204) return { code: 'APP_UNRESPONSIVE', message: `${what}: the app did not answer in time (it may still have acted, e.g. a menu that opened) — look before retrying`, delivery: 'unknown', retry: 'unsafe' };
  if (code === -25206) return notDelivered({ code: 'ACTION_NOT_SUPPORTED', message: `${what}: the element does not support it` });
  if (code === -25205) return notDelivered({ code: 'ACTION_NOT_SUPPORTED', message: `${what}: the element has no such attribute` });
  if (code === -25202) return notDelivered({ code: 'STALE_REF', message: `${what}: the element no longer exists`, details: { kind: 'invalid_element' } });
  if (code === -25211) return notDelivered(permError());
  if (code === -25201) return notDelivered({ code: 'ACTION_NOT_SUPPORTED', message: `${what}: the app rejected the value` });
  return { code: 'ACTION_FAILED', message: `${what}: accessibility error ${code}`, delivery: 'unknown', retry: 'unsafe' };
}

// Transient checks are polled until the budget runs out: the element must still exist and be enabled.
function waitActionable(el, timeoutMs) {
  const end = now() + timeoutMs;
  for (;;) {
    const v = readNode(el);
    if (v.__err) return { error: notDelivered({ code: 'STALE_REF', message: 'the element disappeared', details: { kind: 'gone' } }) };
    if (v.AXEnabled !== false) return { v };
    if (now() >= end) return { error: notDelivered({ code: 'NOT_ACTIONABLE', message: 'the element is disabled', details: { kind: 'disabled' } }) };
    sleep(100);
  }
}

function menuOpen(appEl) {
  const mb = attr(appEl, 'AXMenuBar');
  if (mb && mb.el) for (const item of children(mb.el)) if (attr(item, 'AXSelected') === true) return true;
  const f = attr(appEl, 'AXFocusedUIElement');
  if (f && f.el) { const r = attr(f.el, 'AXRole'); if (r === 'AXMenu' || r === 'AXMenuItem') return true; }
  return false;
}
// What an action could change, read before and after it. Comparing the two is the delivery evidence.
function observeState(el, appEl) {
  const o = { gone: true };
  if (el) {
    const v = readNode(el);
    if (!v.__err) {
      o.gone = false;
      o.value = v.AXValue === undefined ? null : typeof v.AXValue === 'string' ? vhash(v.AXValue) : v.AXValue;
      o.selected = v.AXSelected === undefined ? null : v.AXSelected;
      o.expanded = v.AXExpanded === undefined ? null : v.AXExpanded;
      o.focused = v.AXFocused === undefined ? null : v.AXFocused;
      o.title = nameOf(v);
      o.enabled = v.AXEnabled === undefined ? null : v.AXEnabled;
      o.frame = frameOf(v);
      const sr = attr(el, 'AXSelectedTextRange'); if (sr) o.selection = sr;
      const sb = attr(el, 'AXVerticalScrollBar'); if (sb && sb.el) o.vscroll = attr(sb.el, 'AXValue');
      const hb = attr(el, 'AXHorizontalScrollBar'); if (hb && hb.el) o.hscroll = attr(hb.el, 'AXValue');
    }
  }
  const ws = windowsOf(appEl);
  o.windows = ws.map(w => `${attr(w, 'AXSubrole') || ''}:${attr(w, 'AXTitle') || ''}`);
  o.sheets = 0;
  for (const w of ws) for (const k of children(w)) if (attr(k, 'AXRole') === 'AXSheet') o.sheets++;
  o.menu = menuOpen(appEl);
  const f = attr(appEl, 'AXFocusedUIElement');
  if (f && f.el) { const fv = readNode(f.el); o.focus = `${fv.AXRole || ''}:${nameOf(fv).slice(0, 60)}`; }
  const fw = attr(appEl, 'AXFocusedWindow');
  o.focusedWindow = fw && fw.el ? attr(fw.el, 'AXTitle') || '' : null;
  const fa = frontApp();
  o.frontmost = fa ? fa.pid : null;
  return o;
}
const STATE_KEYS = ['gone', 'value', 'selection', 'selected', 'expanded', 'focused', 'title', 'enabled', 'frame', 'vscroll', 'hscroll', 'menu', 'focus', 'focusedWindow', 'sheets', 'windows', 'frontmost'];
const WEAK_STATE_KEYS = new Set(['frontmost', 'focusedWindow', 'focus']);
function diffState(a, b, keys) {
  const changed = STATE_KEYS.filter(k => JSON.stringify(a[k] === undefined ? null : a[k]) !== JSON.stringify(b[k] === undefined ? null : b[k]));
  const allowed = Array.isArray(keys) ? new Set(keys) : null;
  const verified = changed.some(k => !WEAK_STATE_KEYS.has(k) && (!allowed || allowed.has(k)) && !(b.gone === true && k !== 'gone' && b[k] === undefined));
  const surfaces = [];
  if ((b.sheets || 0) > (a.sheets || 0)) surfaces.push('sheet');
  if (b.menu && !a.menu) surfaces.push('menu');
  for (const w of (b.windows || []).filter(x => (a.windows || []).indexOf(x) < 0)) {
    const [sub, ...t] = w.split(':');
    surfaces.push(`${/Dialog/.test(sub) ? 'dialog' : 'window'} "${t.join(':').slice(0, 60)}"`);
  }
  return { changed, verified, surfaces };
}
function verdict(before, after, extra, keys) {
  if (Array.isArray(extra) && keys === undefined) { keys = extra; extra = {}; }
  const d = diffState(before, after, keys);
  return Object.assign({ ok: true, delivery: d.verified ? 'delivered_verified' : 'delivered_unverified', retry: 'unsafe', changed: d.changed, surfaces: d.surfaces }, extra || {});
}

const PRESS_ACTIONS = ['AXPress', 'AXConfirm', 'AXPick', 'AXOpen'];
// Semantic activation: the element's own action, never the pointer. `auto_press` picks the element's
// primary action, or selects a row / cell / tab that has none.
function opAct(req) {
  const r = resolveTarget(req.target, 3000);
  if (r.error) return fail(notDelivered(r.error));
  const w = waitActionable(r.el, clamp(req.timeout_ms, 0, 30000, 3000));
  if (w.error) return fail(w.error);
  const v = w.v;
  const actions = actionNames(r.el);
  let action = req.action;
  if (action === 'auto_press') {
    action = PRESS_ACTIONS.find(a => actions.indexOf(a) >= 0) || null;
    if (!action && settable(r.el, 'AXSelected')) action = 'select';
    if (!action) return fail(notDelivered({ code: 'ACTION_NOT_SUPPORTED', message: `the element (${v.AXRole}) offers no semantic activation`, details: { actions } }));
  }
  if (action !== 'select' && action !== 'focus' && actions.indexOf(action) < 0) {
    return fail(notDelivered({ code: 'ACTION_NOT_SUPPORTED', message: `the element (${v.AXRole}) does not offer ${action}`, details: { actions } }));
  }
  const before = observeState(r.el, r.appEl);
  const err = action === 'select' ? setAttr(r.el, 'AXSelected', YES()) : action === 'focus' ? setAttr(r.el, 'AXFocused', YES()) : perform(r.el, action);
  if (err !== 0) return fail(axCallError(err, action));
  sleep(clamp(req.settle_ms, 0, 3000, 300));
  const after = observeState(r.el, r.appEl);
  return verdict(before, after, { mechanism: 'semantic', action, how: r.how, role: v.AXRole, title: nameOf(v).slice(0, 60) });
}

function onSomeDisplay(x, y) { return displays().some(d => x >= d.frame[0] && y >= d.frame[1] && x < d.frame[0] + d.frame[2] && y < d.frame[1] + d.frame[3]); }
function appNameOfPid(pid) { const a = runningApps().find(x => x.pid === pid); return a ? a.name : ''; }
// Does a pointer event at (x, y) reach the element? The element at that point must be the target or
// inside it. An ancestor of the target is inconclusive (some controls are not hit-testable): the click
// goes ahead, as agent-desktop's gate fails open. Anything else — another element, another app's
// window — is an occluder, and nothing is sent.
function hitTest(target, x, y) {
  const sys = $.AXUIElementCreateSystemWide();
  $.AXUIElementSetMessagingTimeout(sys, 2.0);
  const ref = Ref();
  const e = Number($.AXUIElementCopyElementAtPosition(sys, x, y, ref));
  if (e !== 0) return { verdict: 'unknown', reason: `hit test error ${e}` };
  const hit = cast(ref[0]);
  if (!hit) return { verdict: 'unknown', reason: 'no element at the point' };
  let cur = hit;
  for (let i = 0; i < 50 && cur; i++) { if (same(cur, target)) return { verdict: 'reaches' }; const p = attr(cur, 'AXParent'); cur = p && p.el ? p.el : null; }
  let up = target;
  for (let i = 0; i < 50 && up; i++) { if (same(up, hit)) return { verdict: 'unknown', reason: 'the point hits a container of the element' }; const p = attr(up, 'AXParent'); up = p && p.el ? p.el : null; }
  const hv = readNode(hit);
  const pr = Ref();
  let pid = 0;
  if (Number($.AXUIElementGetPid(hit, pr)) === 0) pid = Number(pr[0]);
  return { verdict: 'intercepted', occluder: { role: hv.AXRole || '?', title: nameOf(hv).slice(0, 60), app: appNameOfPid(pid) } };
}

// The frontmost app by pid (NSWorkspace — no System Events, no Automation permission), and whether a
// given app (name, bundle id, .app path, or pid) is it. The server's focus guard asks this before it
// sends keystrokes or a paste.
function opFrontmost(req) {
  const f = frontApp();
  const out = { ok: true, front: f ? { pid: f.pid, name: f.name, bundle: f.bundle } : null };
  // at: [x, y] also reports whose window is on top at that point (raw-coordinate clicks check it first)
  if (Array.isArray(req.at) && req.at.length === 2 && req.at.every(v => typeof v === 'number' && isFinite(v))) out.top = cgTopAt(req.at[0], req.at[1]);
  if (req.pid !== undefined || req.app) {
    const t = req.pid !== undefined ? runningApps().find(a => a.pid === Number(req.pid)) || null : findApp(req.app);
    out.target = t ? { pid: t.pid, name: t.name, bundle: t.bundle } : null;
    out.match = Boolean(f && t && f.pid === t.pid);
  }
  return out;
}
// The strips of each display that macOS keeps for the Dock: the display's frame minus its visible frame,
// at the bottom, left and right (the top strip is the menu bar). screens: [{ f, v }] — frame and visible
// frame in AppKit coordinates (origin bottom-left of the main screen); returns top-left [x, y, w, h].
function dockStripsOf(screens) {
  const mainH = screens.length ? screens[0].f[3] : 0;
  const out = [];
  for (const { f, v } of screens) {
    const [fx, fy, fw] = f, [vx, vy, vw, vh] = v;
    const tl = (y, h) => mainH - y - h;
    if (vy > fy) out.push([fx, tl(fy, vy - fy), fw, vy - fy]);
    if (vx > fx) out.push([fx, tl(vy, vh), vx - fx, vh]);
    if (fx + fw > vx + vw) out.push([vx + vw, tl(vy, vh), fx + fw - vx - vw, vh]);
  }
  return out;
}
function dockStrips() {
  const s = $.NSScreen.screens;
  const screens = [];
  for (let i = 0; i < Number(s.count); i++) {
    const sc = s.objectAtIndex(i), f = sc.frame, v = sc.visibleFrame;
    screens.push({ f: [f.origin.x, f.origin.y, f.size.width, f.size.height].map(Number), v: [v.origin.x, v.origin.y, v.size.width, v.size.height].map(Number) });
  }
  return dockStripsOf(screens);
}
function inRect(x, y, r) { return x >= r[0] && y >= r[1] && x < r[0] + r[2] && y < r[1] + r[3]; }
// While a banner or alert shows, Notification Center keeps one full-display window above everything (layer
// 23) that lets clicks through except where a notification is drawn (E2 run 2026-11-07, macOS 27.2: a
// memory-warning banner at the top right made a point in the middle of the screen read as covered). The
// frames of the banners and alerts on screen, from accessibility; null — the whole overlay counts as
// covering — when Notification Center's list is open, an element cannot be read, or none is found.
function ncDrawnRects() {
  const a = ncApp();
  if (!a) return null;
  const rects = [];
  let doubt = false;
  const visit = (el, d) => {
    if (d > 14 || doubt) return;
    const v = readNode(el);
    if (v.__err) { doubt = true; return; }
    const sr = String(v.AXSubrole || '');
    if (sr.indexOf('AXNotificationCenter') === 0) {
      const fr = frameOf(v);
      if ((sr !== 'AXNotificationCenterBanner' && sr !== 'AXNotificationCenterAlert') || !fr) { doubt = true; return; }
      rects.push([fr[0] - 4, fr[1] - 4, fr[2] + 8, fr[3] + 8]); // a little margin for the shadow
      return;
    }
    for (const k of v.AXChildren || []) visit(k, d + 1);
  };
  for (const w of windowsOf(appElement(a))) visit(w, 0);
  return doubt || !rects.length ? null : rects;
}

// The topmost on-screen window at a point, front to back, as the window server stacks them. Skipped:
// invisible windows (alpha 0), desktop-level ones (negative layer), and the Dock's full-display overlay,
// which lets clicks through — except over the strip macOS keeps for the Dock, where the Dock is drawn:
// there the overlay counts as covering (E2 run 2026-11-07: on macOS 27 the Dock has no window of its own
// for its platter, so a point under the Dock read as the window behind it). The strip is the whole width
// (or height) the Dock reserves, the gaps beside its platter included. Other Dock-owned windows cover
// what is under them. Notification Center's full-display overlay (shown with a banner or alert) is
// skipped the same way except over a banner or alert frame (ncDrawnRects), or everywhere when those
// frames cannot be told.
function cgTopAt(x, y) {
  const list = cast($.CGWindowListCopyWindowInfo((1 << 0) | (1 << 4), 0)); // on screen only, no desktop elements
  if (!list) return null;
  let screens = null, strips = null, nc;
  for (let i = 0; i < Number(list.count); i++) {
    const d = list.objectAtIndex(i);
    const g = k => { const o = d.objectForKey(ks(k)); return o && !o.isNil() ? o.js : null; };
    const layer = Number(g('kCGWindowLayer')), alpha = Number(g('kCGWindowAlpha'));
    const owner = String(g('kCGWindowOwnerName') || '');
    if (!(alpha > 0) || layer < 0) continue;
    const b = d.objectForKey(ks('kCGWindowBounds'));
    if (!b || b.isNil()) continue;
    const [bx, by, bw, bh] = ['X', 'Y', 'Width', 'Height'].map(k => Number(b.objectForKey(ks(k)).js));
    if (bw * bh < 4 || x < bx || y < by || x >= bx + bw || y >= by + bh) continue;
    if (owner === 'Dock' || owner === 'Notification Center') {
      if (!screens) screens = displays().map(s => s.frame);
      if (screens.some(f => rectNear(f, [bx, by, bw, bh], 2))) {
        if (owner === 'Dock') {
          if (!strips) strips = dockStrips();
          if (!strips.some(r => inRect(x, y, r))) continue;
        } else {
          if (nc === undefined) nc = ncDrawnRects();
          if (nc && !nc.some(r => inRect(x, y, r))) continue;
        }
      }
    }
    return { pid: Number(g('kCGWindowOwnerPID')), owner, layer, wid: Number(g('kCGWindowNumber')) };
  }
  return null;
}

// Physical input on an element (count > 1, middle button, no semantic action, or asked for): resolve,
// check it is enabled, on a display and not covered at its center, and hand the point plus the
// before-state back to the server, which clicks with cliclick and then calls observe_after.
function opPhysicalPrep(req) {
  const r = resolveTarget(req.target, 3000);
  if (r.error) return fail(notDelivered(r.error));
  const w = waitActionable(r.el, clamp(req.timeout_ms, 0, 30000, 3000));
  if (w.error) return fail(w.error);
  const fr = frameOf(w.v);
  if (!fr || fr[2] <= 0 || fr[3] <= 0) return fail(notDelivered({ code: 'NOT_ACTIONABLE', message: 'the element has no size on screen', details: { kind: 'no_frame' } }));
  const x = Math.round(fr[0] + fr[2] / 2), y = Math.round(fr[1] + fr[3] / 2);
  if (!onSomeDisplay(x, y)) return fail(notDelivered({ code: 'NOT_ACTIONABLE', message: `the element's center (${x},${y}) is off every display — scroll it into view (mac_scroll with element_index) or move the window`, details: { kind: 'offscreen' } }));
  if (attr(r.el, 'AXWindow') && attr(attr(r.el, 'AXWindow').el, 'AXMinimized') === true) return fail(notDelivered({ code: 'NOT_ACTIONABLE', message: 'the element\'s window is minimized', details: { kind: 'minimized' } }));
  // the element's window id: its AXWindow or the window up its AXParent chain (R20); else, for a window
  // snapshot, the snapshot's window
  let ewid = windowIdOf(r.el);
  if (!ewid && req.target && req.target.container && req.target.container.kind === 'window') ewid = (r.containerEl && axWindowId(r.containerEl)) || req.target.container.wid || null;
  const h = hitTest(r.el, x, y);
  if (h.verdict === 'intercepted') return fail(notDelivered({ code: 'OCCLUDED', message: `something else is on top of the element at ${x},${y} — bring its window to the front or close what covers it`, details: { occluder: h.occluder } }));
  if (h.verdict === 'unknown') {
    // the accessibility hit test was inconclusive (an error, nothing there, or only a container of the
    // element): the window server decides — the topmost window at the point must be the target app's
    const top = cgTopAt(x, y);
    if (!top) return fail(notDelivered({ code: 'NOT_ACTIONABLE', message: `no window is under ${x},${y} — the element is not visible there`, details: { kind: 'no_window_at_point' } }));
    if (top.pid !== r.app.pid) return fail(notDelivered({ code: 'OCCLUDED', message: `a window of "${top.owner}" is on top at ${x},${y} — bring the element's window to the front or close what covers it`, details: { occluder: { app: top.owner, layer: top.layer } } }));
    // the app's own window, but not the one the element is in (a floating panel, another document)
    // the element's own window id; else its AXWindow's; else (a window snapshot) the snapshot's window —
    // an unknown window id must not skip the check (R19)
    // without the element's window id the topmost window cannot be confirmed to be that window: refuse
    // (R20 follow-up) — except Finder's desktop, which sits below every window and has no id
    const desktop = req.target && req.target.container && isFinderDesktop(r.app, req.target.container);
    if (!ewid && !desktop) return fail(notDelivered({ code: 'OCCLUDED', message: `the hit test at ${x},${y} was inconclusive and the element's window has no window ID, so the window on top cannot be confirmed to be its own — use the element's semantic action (mechanism auto) or bring its window to the front and take a new snapshot`, details: { occluder: { app: top.owner, layer: top.layer, window_unverifiable: true } } }));
    if (ewid && top.wid && top.wid !== ewid) return fail(notDelivered({ code: 'OCCLUDED', message: `another window of "${top.owner}" is on top at ${x},${y} — bring the element's window to the front or close what covers it`, details: { occluder: { app: top.owner, layer: top.layer, other_window: true } } }));
    h.reason = (h.reason ? h.reason + '; ' : '') + 'the topmost window there is the app\'s own';
  }
  return { ok: true, point: [x, y], hit: h.verdict, reason: h.reason, pid: r.app.pid, wid: ewid || null, before: observeState(r.el, r.appEl), role: w.v.AXRole, title: nameOf(w.v).slice(0, 60), how: r.how };
}
const ABSENT_CODES = new Set(['STALE_REF', 'WINDOW_NOT_FOUND', 'APP_NOT_FOUND']);
function resolveOrError(target, budgetMs) {
  let r;
  try { r = resolveTarget(target, budgetMs); }
  catch (e) { return { error: { code: 'INTERNAL', message: String(e && e.message || e).slice(0, 200) } }; }
  try {
    if (!r.error) {
      if ((r.containerEl && readNode(r.containerEl).__err === -25204) || (r.appEl && readNode(r.appEl).__err === -25204) || (r.el && readNode(r.el).__err === -25204)) {
        return { error: { code: 'APP_UNRESPONSIVE', message: 'the app did not answer accessibility in time' } };
      }
      return r;
    }
    if (r.error.code === 'STALE_REF' && target && target.pid !== undefined) {
      const apps = runningApps().filter(a => a.pid === target.pid);
      if (apps.length) {
        const appEl = appElement(apps[0]);
        if (readNode(appEl).__err === -25204 || windowsOf(appEl).some(w => readNode(w).__err === -25204)) {
          return { error: { code: 'APP_UNRESPONSIVE', message: 'the app did not answer accessibility in time' } };
        }
        const c = containerEl(appEl, target.container, apps[0]);
        if (!c.error && c.el) {
          if (readNode(c.el).__err === -25204) return { error: { code: 'APP_UNRESPONSIVE', message: 'the app did not answer accessibility in time' } };
          const skipMenuBar = (target.container && target.container.kind || 'app') !== 'menubar';
          const pe = Array.isArray(target.path) ? pathEvidence(c.el, target.path, skipMenuBar) : { ok: false };
          if (pe.ok && readNode(pe.el).__err === -25204) return { error: { code: 'APP_UNRESPONSIVE', message: 'the app did not answer accessibility in time' } };
        }
      }
    }
  } catch (e) { return { error: { code: 'INTERNAL', message: String(e && e.message || e).slice(0, 200) } }; }
  return r;
}
function opObserveAfter(req) {
  const r = resolveOrError(req.target, 2000);
  let after;
  if (r.error) {
    if (!ABSENT_CODES.has(r.error.code)) {
      return { ok: true, delivery: 'delivered_unverified', retry: 'unsafe', changed: [], surfaces: [], note: `could not read the element after the action (${r.error.code})` };
    }
    // gone after a physical click: the click cannot be tied to it — something else may have closed the
    // window between the hit test and the click (Reddit r/mcp review 2026-11-06), so it is not proof
    if (req.physical === true) {
      return { ok: true, delivery: 'delivered_unverified', retry: 'unsafe', changed: ['gone'], surfaces: [], note: 'the element is gone after the click — that may not have been this click (it could have closed between the hit test and the click)' };
    }
    // gone after the click: that is itself an observed change
    const apps = runningApps().filter(a => a.pid === req.target.pid);
    if (!apps.length) {
      const verified = !Array.isArray(req.keys) || req.keys.indexOf('gone') >= 0;
      return { ok: true, delivery: verified ? 'delivered_verified' : 'delivered_unverified', retry: 'unsafe', changed: ['gone', 'app_exited'], surfaces: [] };
    }
    try { after = observeState(null, appElement(apps[0])); }
    catch (e) { return { ok: true, delivery: 'delivered_unverified', retry: 'unsafe', changed: [], surfaces: [], note: 'could not read the element after the action (INTERNAL)' }; }
  } else {
    try { after = observeState(r.el, r.appEl); }
    catch (e) { return { ok: true, delivery: 'delivered_unverified', retry: 'unsafe', changed: [], surfaces: [], note: 'could not read the element after the action (INTERNAL)' }; }
  }
  const v = verdict(req.before || {}, after, {}, req.keys);
  // a physical click: if another window is now on top at the click point (one that covered the element,
  // or the element's window moved away, between the hit test and the click — or one this click opened),
  // the click cannot be tied to the element's change: not proof (Reddit r/mcp review 2026-11-06)
  if (req.physical === true && Array.isArray(req.point) && req.wid) {
    const top = cgTopAt(req.point[0], req.point[1]);
    if (!top || top.wid !== req.wid) {
      v.delivery = 'delivered_unverified';
      v.note = top ? `after the click, a window of "${top.owner}" is on top at ${req.point[0]},${req.point[1]}, not the element's — the click may have landed there (or opened it)` : `after the click, no window is on top at ${req.point[0]},${req.point[1]} — the element's window moved or closed`;
    }
  }
  return v;
}

// Text into an element through accessibility: AXSelectedText inserts at the caret (replacing any
// selection), AXValue replaces the whole value. No key events, so no input method can re-segment it
// and the clipboard is not touched. Verified by reading the value back (secure fields cannot be read).
function opInsertText(req) {
  let el, appEl, how = 'focused', label = 'the focused element';
  if (req.target) {
    const r = resolveTarget(req.target, 3000);
    if (r.error) return fail(notDelivered(r.error));
    el = r.el; appEl = r.appEl; how = r.how; label = 'the element';
  } else {
    const app = req.app ? findApp(req.app) : frontApp();
    if (!app) return fail(notDelivered({ code: 'APP_NOT_FOUND', message: req.app ? `no running app named "${req.app}"` : 'no frontmost app' }));
    appEl = appElement(app);
    const f = attr(appEl, 'AXFocusedUIElement');
    if (!f || !f.el) return fail(notDelivered({ code: 'ACTION_NOT_SUPPORTED', message: `"${app.name}" reports no focused element`, details: { kind: 'no_focus' } }));
    el = f.el; label = `the focused element of "${app.name}"`;
  }
  const v = readNode(el);
  if (v.__err) return fail(notDelivered({ code: 'STALE_REF', message: 'the element disappeared', details: { kind: 'gone' } }));
  if (v.AXEnabled === false) return fail(notDelivered({ code: 'NOT_ACTIONABLE', message: `${label} is disabled`, details: { kind: 'disabled' } }));
  const canSel = settable(el, 'AXSelectedText'), canVal = settable(el, 'AXValue');
  if (req.replace ? !canVal : !(canSel || canVal)) {
    // text-like but read-only through accessibility (a terminal, a custom editor) vs. not text at all
    // (a button, a list, a sheet): the server only falls back to keystrokes for the first kind
    const textlike = TEXT_ROLES.has(roleKey(v)) || v.AXRole === 'AXWebArea' || attr(el, 'AXSelectedTextRange') !== null || attr(el, 'AXInsertionPointLineNumber') !== null;
    return fail(notDelivered({ code: 'ACTION_NOT_SUPPORTED', message: `${label} (${v.AXRole}${v.AXSubrole ? '/' + v.AXSubrole : ''}) takes no text through accessibility${textlike ? '' : ' and is not a text input — focus a text field first'}`, details: { kind: 'not_text', role: v.AXRole, textlike } }));
  }
  const text = String(req.text);
  const secure = v.AXSubrole === 'AXSecureTextField';
  const before = typeof v.AXValue === 'string' ? v.AXValue : null;
  const beforeLen = attr(el, 'AXNumberOfCharacters');
  const selBefore = attr(el, 'AXSelectedTextRange');
  const beforeSel = JSON.stringify(selBefore);
  if (req.replace && !secure && sameText(before, text)) {
    return { ok: true, mechanism: 'semantic', via: 'AXValue', how, role: v.AXRole, delivery: 'not_delivered', retry: 'safe', reason: 'already', note: `${label} already shows exactly this text — nothing sent` };
  }
  // R36: appending through AXValue rewrites the whole value; when the value cannot be read, that would
  // replace what is there with the text — refuse instead
  if (!req.replace && !canSel && typeof before !== 'string' && !secure) {
    return fail(notDelivered({ code: 'ACTION_NOT_SUPPORTED', message: `${label} takes text only by rewriting its whole value, and its value cannot be read — appending would replace what is there; nothing was sent`, details: { kind: 'value_unreadable' } }));
  }
  let err, via;
  if (req.replace) { err = setAttr(el, 'AXValue', $(text)); via = 'AXValue'; }
  else if (canSel) { err = setAttr(el, 'AXSelectedText', $(text)); via = 'AXSelectedText'; }
  else { err = setAttr(el, 'AXValue', $((before || '') + text)); via = 'AXValue (append)'; }
  if (err !== 0) return fail(axCallError(err, via));
  const deadline = now() + WRITE_POLL_MS;
  sleep(150);
  let after = attr(el, 'AXValue');
  const base = { ok: true, mechanism: 'semantic', via, how, role: v.AXRole };
  if (secure || typeof after !== 'string') return Object.assign(base, { delivery: 'delivered_unverified', retry: 'unsafe', reason: secure ? 'secure_field' : 'value_unreadable' });
  // CP: the value must be exactly what the write should give — the replaced text, the text over the
  // selection that was there (AXSelectedText), or the old value plus the text (append)
  const expect = req.replace ? text : via === 'AXSelectedText' ? expectedInsert(before, selBefore, text) : (before || '') + text;
  const isOk = (a) => typeof a === 'string' && a !== before && expect !== null && sameText(a, expect);
  let moved = attr(el, 'AXNumberOfCharacters') !== beforeLen || JSON.stringify(attr(el, 'AXSelectedTextRange')) !== beforeSel;
  if (!isOk(after) && after === before && !moved) {
    for (let i = 0; i < 6 && now() < deadline; i++) {
      sleep(100);
      after = attr(el, 'AXValue');
      if (typeof after !== 'string') return Object.assign(base, { delivery: 'delivered_unverified', retry: 'unsafe', reason: 'value_unreadable' });
      moved = attr(el, 'AXNumberOfCharacters') !== beforeLen || JSON.stringify(attr(el, 'AXSelectedTextRange')) !== beforeSel;
      if (after !== before) break;
    }
  }
  if (isOk(after)) return Object.assign(base, { delivery: 'delivered_verified', retry: 'unsafe', length: after.length });
  if (after === before && !moved) {
    return fail({ code: 'NOT_CONFIRMED', message: `${label} did not change — the app ignored the accessibility write; mac_type with mechanism:"physical" or mac_paste sends real keystrokes instead`, delivery: 'delivered_unverified', retry: 'unsafe', details: { role: v.AXRole } });
  }
  if (after === before && moved) {
    // the caret or the length moved but the value reads the same: something happened, not shown to be the text
    return Object.assign(base, { delivery: 'delivered_unverified', retry: 'unsafe', reason: 'selection_moved' });
  }
  // changed and the text is in it, but not as the write should have left it (or the insertion point
  // could not be read): something was delivered, not shown to be this text
  if (typeof after === 'string' && unifyNl(after).indexOf(unifyNl(text)) >= 0) {
    return Object.assign(base, { delivery: 'delivered_unverified', retry: 'unsafe', reason: expect === null ? 'insertion_point_unreadable' : 'not_at_insertion_point' });
  }
  return fail({ code: 'NOT_CONFIRMED', message: `${label} changed but does not show the text`, delivery: 'unknown', retry: 'unsafe' });
}

// after an accessibility write the app accepted, how long to look for the value to show it: the answer
// only decides verified vs unverified (an unchanged value is still reported delivered_unverified)
const WRITE_POLL_MS = 400;
// CP (Y6): a text verdict needs the change itself. Texts compare with line endings unified (\r\n and \r
// become \n); set_value also ignores leading and trailing white space. "The value now contains the text
// somewhere" is never enough — the text may have been there before the write.
// a finite decimal written out (Number("") is 0 and Number(" ") is 0: those are not numbers here)
function decimalOrNull(s) { return /^\s*[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?\s*$/.test(String(s)) ? Number(s) : null; }
function unifyNl(s) { return String(s).replace(/\r\n?/g, '\n'); }
function sameText(a, b, trim) { return typeof a === 'string' && (trim ? unifyNl(a).trim() === unifyNl(b).trim() : unifyNl(a) === unifyNl(b)); }
// what inserting text over the selected range r of before must give; null when before or r is unreadable
function expectedInsert(before, r, text) {
  if (typeof before !== 'string' || !r || typeof r.location !== 'number' || typeof r.length !== 'number') return null;
  if (r.location < 0 || r.length < 0 || r.location + r.length > before.length) return null;
  return before.slice(0, r.location) + text + before.slice(r.location + r.length);
}
function parseBool(s) {
  const t = String(s).trim().toLowerCase();
  if (['true', '1', 'on', 'yes', 'checked', 'selected', 'expanded', 'open'].indexOf(t) >= 0) return true;
  if (['false', '0', 'off', 'no', 'unchecked', 'deselected', 'collapsed', 'closed'].indexOf(t) >= 0) return false;
  return null;
}
function invalid(msg) { return fail(notDelivered({ code: 'INVALID_ARGS', message: msg })); }
function isOn(v) { return v.AXValue === 1 || v.AXValue === true; }
function toggleState(v) {
  if (v.AXValue === 2) return 'mixed';
  if (v.AXValue === 1 || v.AXValue === true) return true;
  if (v.AXValue === 0 || v.AXValue === false) return false;
  return null;
}
function toggleLabel(s) { return s === 'mixed' ? 'mixed' : s === true ? 'on' : s === false ? 'off' : 'unknown'; }
function normOption(s) { return String(s).replace(/\s+/g, ' ').trim().replace(/(?:\s*(?:…|\.{3}))+$/, '').toLowerCase(); }

function findOpenMenu(el, appEl) {
  for (const k of children(el)) if (attr(k, 'AXRole') === 'AXMenu') return k;
  // some pop-ups attach the menu elsewhere: look at the app's focused element and its ancestors
  const f = attr(appEl, 'AXFocusedUIElement');
  let cur = f && f.el ? f.el : null;
  for (let i = 0; i < 6 && cur; i++) { if (attr(cur, 'AXRole') === 'AXMenu') return cur; const p = attr(cur, 'AXParent'); cur = p && p.el ? p.el : null; }
  return null;
}
function chooseOption(r, want, timeoutMs) {
  const acts = actionNames(r.el);
  const opener = acts.indexOf('AXPress') >= 0 ? 'AXPress' : acts.indexOf('AXShowMenu') >= 0 ? 'AXShowMenu' : null;
  if (!opener) return fail(notDelivered({ code: 'ACTION_NOT_SUPPORTED', message: 'the control does not open a menu', details: { actions: acts } }));
  const e = perform(r.el, opener);
  if (e !== 0 && e !== -25204) return fail(axCallError(e, opener));
  let menu = null;
  const end = now() + Math.min(timeoutMs, 3000);
  while (!menu && now() < end) { sleep(150); menu = findOpenMenu(r.el, r.appEl); }
  if (!menu) return fail({ code: 'ACTION_FAILED', message: 'the menu did not open', delivery: 'unknown', retry: 'unsafe' });
  const items = children(menu).map(k => ({ el: k, title: String(attr(k, 'AXTitle') || ''), enabled: attr(k, 'AXEnabled') !== false })).filter(i => i.title);
  const wantStr = String(want);
  const w = wantStr.toLowerCase();
  let hit = items.filter(i => i.title === wantStr);
  if (!hit.length) hit = items.filter(i => i.title.toLowerCase() === w);
  if (!hit.length) { const nw = normOption(wantStr); hit = items.filter(i => normOption(i.title) === nw); }
  if (hit.length !== 1 || !hit[0].enabled) {
    perform(menu, 'AXCancel');
    const why = hit.length > 1 ? `${hit.length} options match "${want}"` : hit.length ? `option "${hit[0].title}" is disabled` : `no option matches "${want}"`;
    return fail({ code: hit.length > 1 ? 'AMBIGUOUS_TARGET' : 'ACTION_FAILED', message: `${why} (the menu was opened and closed again)`, details: { options: items.slice(0, 40).map(i => i.title) }, delivery: 'not_delivered', retry: 'safe' });
  }
  const pe = perform(hit[0].el, 'AXPress');
  if (pe !== 0 && pe !== -25204) { perform(menu, 'AXCancel'); return fail(axCallError(pe, 'AXPress on the option')); }
  sleep(300);
  const after = readNode(r.el);
  const shown = [after.AXValue, after.AXTitle, nameOf(after)].map(x => String(x === undefined || x === null ? '' : x));
  const okv = shown.some(s => s === hit[0].title);
  // a changed value that does not show the chosen option is not proof it was chosen
  return { ok: true, mechanism: 'semantic', via: 'menu option', option: hit[0].title, delivery: okv ? 'delivered_verified' : 'delivered_unverified', retry: 'unsafe', value: after.AXValue === undefined ? null : after.AXValue };
}

// Role-aware value setting: text, toggles (idempotent), disclosure, selection, menu options, numbers.
// Like every action it reports what opened as a result (a sheet, a dialog, a menu left open).
function opSetValue(req) {
  const r = resolveTarget(req.target, 3000);
  if (r.error) return fail(notDelivered(r.error));
  const before = observeState(r.el, r.appEl);
  const res = setValueCore(req, r);
  if (res.ok && res.delivery !== 'not_delivered') {
    const d = diffState(before, observeState(r.el, r.appEl));
    if (d.surfaces.length) res.surfaces = d.surfaces;
  }
  return res;
}
function setValueCore(req, r) {
  const timeoutMs = clamp(req.timeout_ms, 0, 30000, 3000);
  const w = waitActionable(r.el, timeoutMs);
  if (w.error) return fail(w.error);
  const v = w.v;
  const role = roleKey(v);
  const val = String(req.value === undefined || req.value === null ? '' : req.value);
  const acts = actionNames(r.el);
  const done = (delivery, extra) => Object.assign({ ok: true, mechanism: 'semantic', role: v.AXRole, how: r.how, delivery, retry: delivery === 'not_delivered' ? 'safe' : 'unsafe' }, extra || {});

  if (TOGGLE_ROLES.has(role) || TOGGLE_ROLES.has(v.AXRole) || v.AXSubrole === 'AXToggle') {
    const want = val.trim().toLowerCase() === 'mixed' ? 'mixed' : parseBool(val);
    if (want === null) return invalid('a checkbox, radio button or switch takes true or false');
    const cur = toggleState(v);
    if (cur === want) return done('not_delivered', { note: `already ${toggleLabel(want)} — nothing sent`, value: want });
    if (v.AXRole === 'AXRadioButton' && want !== true) return invalid('a radio button is turned off by choosing another one in its group');
    if (acts.indexOf('AXPress') < 0) return fail(notDelivered({ code: 'ACTION_NOT_SUPPORTED', message: 'the control cannot be pressed', details: { actions: acts } }));
    const e = perform(r.el, 'AXPress');
    if (e !== 0) return fail(axCallError(e, 'AXPress'));
    sleep(200);
    let afterState = toggleState(readNode(r.el));
    if (afterState !== want) {
      const e2 = perform(r.el, 'AXPress');
      if (e2 !== 0) return fail({ code: 'NOT_CONFIRMED', message: `pressed once, then second AXPress failed (${axCallError(e2, 'AXPress').message})`, delivery: 'unknown', retry: 'unsafe' });
      sleep(200);
      afterState = toggleState(readNode(r.el));
    }
    if (afterState === want) return done('delivered_verified', { value: want, via: 'AXPress' });
    return fail({ code: 'NOT_CONFIRMED', message: `pressed, but the control still reads ${toggleLabel(afterState)}`, delivery: 'unknown', retry: 'unsafe' });
  }

  const b = parseBool(val);
  if (b !== null && (role === 'AXDisclosureTriangle' || settable(r.el, 'AXExpanded') || settable(r.el, 'AXDisclosing') || (v.AXExpanded !== undefined && acts.indexOf('AXPress') >= 0 && (v.AXRole === 'AXRow' || v.AXRole === 'AXDisclosureTriangle')))) {
    const attrName = settable(r.el, 'AXExpanded') ? 'AXExpanded' : settable(r.el, 'AXDisclosing') ? 'AXDisclosing' : null;
    const cur = attr(r.el, attrName || 'AXExpanded') === true || (role === 'AXDisclosureTriangle' && isOn(v));
    if (cur === b) return done('not_delivered', { note: `already ${b ? 'expanded' : 'collapsed'} — nothing sent`, value: b });
    const e = attrName ? setAttr(r.el, attrName, b ? YES() : NO()) : perform(r.el, 'AXPress');
    if (e !== 0) return fail(axCallError(e, attrName || 'AXPress'));
    sleep(250);
    const now2 = attr(r.el, attrName || 'AXExpanded') === true || (role === 'AXDisclosureTriangle' && isOn(readNode(r.el)));
    return now2 === b ? done('delivered_verified', { value: b, via: attrName || 'AXPress' }) : fail({ code: 'NOT_CONFIRMED', message: `the element still reads ${now2 ? 'expanded' : 'collapsed'}`, delivery: 'unknown', retry: 'unsafe' });
  }

  if (b === true && (v.AXRole === 'AXRow' || v.AXRole === 'AXCell' || role === 'AXTab' || v.AXRole === 'AXMenuItem') && (settable(r.el, 'AXSelected') || acts.indexOf('AXPress') >= 0)) {
    if (v.AXSelected === true) return done('not_delivered', { note: 'already selected — nothing sent', value: true });
    const e = settable(r.el, 'AXSelected') ? setAttr(r.el, 'AXSelected', YES()) : perform(r.el, 'AXPress');
    if (e !== 0) return fail(axCallError(e, 'select'));
    sleep(200);
    return attr(r.el, 'AXSelected') === true ? done('delivered_verified', { value: true, via: 'AXSelected' }) : done('delivered_unverified', { value: true, via: 'AXSelected' });
  }

  if (v.AXRole === 'AXPopUpButton' || v.AXRole === 'AXMenuButton' || (v.AXRole === 'AXComboBox' && !settable(r.el, 'AXValue'))) {
    const res = chooseOption(r, val, timeoutMs);
    if (res.ok) { res.role = v.AXRole; res.how = r.how; }
    return res;
  }

  if (['AXSlider', 'AXIncrementor', 'AXLevelIndicator', 'AXStepper', 'AXScrollBar', 'AXValueIndicator'].indexOf(v.AXRole) >= 0) {
    const n = Number(val);
    if (!Number.isFinite(n)) return invalid(`a ${v.AXRole} takes a number`);
    const minV = attr(r.el, 'AXMinValue'), maxV = attr(r.el, 'AXMaxValue');
    if (typeof minV === 'number' && n < minV) return invalid(`${n} is below the minimum ${minV}`);
    if (typeof maxV === 'number' && n > maxV) return invalid(`${n} is above the maximum ${maxV}`);
    const tol = typeof minV === 'number' && typeof maxV === 'number' ? Math.max(Math.abs(maxV - minV) * 0.01, 1e-9) : 1e-6;
    if (typeof v.AXValue === 'number' && Math.abs(v.AXValue - n) <= tol) return done('not_delivered', { note: 'already at that value — nothing sent', value: v.AXValue });
    if (settable(r.el, 'AXValue')) {
      const e = setAttr(r.el, 'AXValue', $.NSNumber.numberWithDouble(n));
      if (e !== 0) return fail(axCallError(e, 'AXValue'));
    } else if (acts.indexOf('AXIncrement') >= 0 && acts.indexOf('AXDecrement') >= 0 && typeof v.AXValue === 'number') {
      let steps = 0;
      for (let i = 0; i < 200; i++) {
        const cur = attr(r.el, 'AXValue');
        if (typeof cur !== 'number' || Math.abs(cur - n) <= tol) break;
        const dir = cur < n ? 'AXIncrement' : 'AXDecrement';
        const e = perform(r.el, dir);
        if (e !== 0) {
          if (steps > 0) {
            const curNow = attr(r.el, 'AXValue');
            return done('delivered_unverified', { value: typeof curNow === 'number' ? curNow : cur, via: dir, note: `stopped after ${steps} steps: ${axCallError(e, 'step').message}` });
          }
          return fail(axCallError(e, 'step'));
        }
        steps++;
        const nxt = attr(r.el, 'AXValue');
        if (nxt === cur || (cur < n && nxt > n) || (cur > n && nxt < n)) break;
      }
    } else return fail(notDelivered({ code: 'ACTION_NOT_SUPPORTED', message: 'the value cannot be set', details: { actions: acts } }));
    sleep(150);
    const after = attr(r.el, 'AXValue');
    return typeof after === 'number' && Math.abs(after - n) <= tol ? done('delivered_verified', { value: after, via: 'AXValue' }) : done('delivered_unverified', { value: after, via: 'AXValue', note: 'the control settled on a different value (it may step)' });
  }

  if (settable(r.el, 'AXValue')) {
    const secure = v.AXSubrole === 'AXSecureTextField';
    const numeric = !secure && typeof v.AXValue === 'number';
    const valNum = numeric ? decimalOrNull(val) : null;
    if (!secure && v.AXValue !== null && v.AXValue !== undefined
      && (valNum !== null ? v.AXValue === valNum : sameText(String(v.AXValue), val, true))) {
      return done('not_delivered', { note: 'already that value — nothing sent', reason: 'already', value: typeof v.AXValue === 'string' ? v.AXValue.slice(0, 200) : v.AXValue });
    }
    const beforeLen = attr(r.el, 'AXNumberOfCharacters');
    const beforeSel = JSON.stringify(attr(r.el, 'AXSelectedTextRange'));
    const e = setAttr(r.el, 'AXValue', valNum !== null ? $.NSNumber.numberWithDouble(valNum) : $(val));
    if (e !== 0) return fail(axCallError(e, 'AXValue'));
    const deadline = now() + WRITE_POLL_MS;
    sleep(150);
    if (secure) return done('delivered_unverified', { secure: true, reason: 'secure_field', via: 'AXValue' });
    let after = attr(r.el, 'AXValue');
    if (after === null || after === undefined) return done('delivered_unverified', { reason: 'value_unreadable', via: 'AXValue' });
    const matchesVal = (a) => a !== null && a !== undefined && JSON.stringify(a) !== JSON.stringify(v.AXValue)
      && (valNum !== null ? Number(a) === valNum : sameText(String(a), val, true));
    let moved = attr(r.el, 'AXNumberOfCharacters') !== beforeLen || JSON.stringify(attr(r.el, 'AXSelectedTextRange')) !== beforeSel;
    if (!matchesVal(after) && JSON.stringify(after) === JSON.stringify(v.AXValue) && !moved) {
      for (let i = 0; i < 6 && now() < deadline; i++) {
        sleep(100);
        after = attr(r.el, 'AXValue');
        if (after === null || after === undefined) return done('delivered_unverified', { reason: 'value_unreadable', via: 'AXValue' });
        moved = attr(r.el, 'AXNumberOfCharacters') !== beforeLen || JSON.stringify(attr(r.el, 'AXSelectedTextRange')) !== beforeSel;
        if (JSON.stringify(after) !== JSON.stringify(v.AXValue)) break;
      }
    }
    if (matchesVal(after)) return done('delivered_verified', { value: typeof after === 'string' ? after.slice(0, 200) : after, via: 'AXValue' });
    if (JSON.stringify(after) === JSON.stringify(v.AXValue) && !moved) {
      return fail({ code: 'NOT_CONFIRMED', message: 'the value did not change — the app ignored the write', delivery: 'delivered_unverified', retry: 'unsafe', details: { role: v.AXRole } });
    }
    if (JSON.stringify(after) === JSON.stringify(v.AXValue) && moved) {
      return done('delivered_unverified', { via: 'AXValue', reason: 'selection_moved' });
    }
    return fail({ code: 'NOT_CONFIRMED', message: 'the value changed but differs from what was set', delivery: 'unknown', retry: 'unsafe', details: { value: typeof after === 'string' ? after.slice(0, 200) : after } });
  }
  return fail(notDelivered({ code: 'ACTION_NOT_SUPPORTED', message: `${v.AXRole} has no settable value here`, details: { actions: acts } }));
}

// Scroll an element into view (AXScrollToVisible), or find where to send wheel events for a scroll area.
function opScrollPrep(req) {
  const r = resolveTarget(req.target, 3000);
  if (r.error) return fail(notDelivered(r.error));
  const v = readNode(r.el);
  const scrollable = ['AXScrollArea', 'AXWebArea', 'AXList', 'AXTable', 'AXOutline', 'AXBrowser', 'AXTextArea'].indexOf(v.AXRole) >= 0 || attr(r.el, 'AXVerticalScrollBar') !== null;
  if (!scrollable) {
    const acts = actionNames(r.el);
    if (acts.indexOf('AXScrollToVisible') < 0) return fail(notDelivered({ code: 'ACTION_NOT_SUPPORTED', message: `${v.AXRole} is neither a scroll area nor able to scroll itself into view`, details: { actions: acts } }));
    const before = observeState(r.el, r.appEl);
    const e = perform(r.el, 'AXScrollToVisible');
    if (e !== 0) return fail(axCallError(e, 'AXScrollToVisible'));
    sleep(250);
    return Object.assign(verdict(before, observeState(r.el, r.appEl), { mechanism: 'semantic', action: 'AXScrollToVisible', role: v.AXRole }), { scrolled_into_view: true });
  }
  const p = opPhysicalPrep(req);
  if (p.ok) p.role = v.AXRole;
  return p;
}

// ── wait ─────────────────────────────────────────────────────────────────────────────────────────
// Polls inside this one process (no respawn per poll). Conditions:
//   window / window_gone   a window of `app` whose title contains `title` (any window when title is empty)
//   text / text_gone       `text` anywhere in the app's window tree (title or value)
//   element                the target element exists | is gone | enabled | focused | has value (equals / contains)
//   menu / menu_closed     an open menu in `app`
//   sheet / sheet_gone     a sheet, alert or dialog in `app`
//   app_running / app_gone `app` is running / not running
//   notification           a new notification (from `app`, containing `text`) appeared after the wait began
const ABSENCE_APP_CONDS = new Set(['window_gone', 'text_gone', 'menu_closed', 'sheet_gone']);
function opWait(req) {
  const timeoutMs = clamp(req.timeout_ms, 0, 60000, 10000);
  const end = now() + timeoutMs;
  const cond = String(req.condition || '');
  let last = null;
  let sawApp = false;
  const needAX = cond !== 'app_running' && cond !== 'app_gone';
  if (needAX && !$.AXIsProcessTrusted()) return fail(permError());
  const baseline = cond === 'notification' ? new Set(listNotifications().map(n => n.id)) : null;
  const check = () => {
    if (cond === 'app_running' || cond === 'app_gone') {
      const a = findApp(req.app);
      last = { running: Boolean(a) };
      return cond === 'app_running' ? Boolean(a) : !a;
    }
    if (cond === 'notification') {
      const fresh = listNotifications().filter(n => !baseline.has(n.id) && (!req.app || textMatch(n.app, req.app, false)) && (!req.text || textMatch([n.title, n.subtitle, n.body].join('\n'), req.text, false)));
      last = { new_notifications: fresh.length };
      if (fresh.length) { last.notification = fresh[0]; return true; }
      return false;
    }
    if (cond === 'element') {
      const r = resolveOrError(req.target, 1500);
      const p = req.predicate || 'exists';
      if (r.error) {
        const absent = ABSENT_CODES.has(r.error.code);
        last = { exists: absent ? false : null, code: r.error.code };
        return p === 'gone' && absent;
      }
      const v = r.v;
      last = { exists: true, enabled: v.AXEnabled !== false, focused: v.AXFocused === true, value: valueOf(v, 200) === undefined ? null : valueOf(v, 200) };
      if (p === 'exists') return true;
      if (p === 'gone') return false;
      if (p === 'enabled') return v.AXEnabled !== false;
      if (p === 'focused') return v.AXFocused === true;
      if (p === 'value_equals') return String(v.AXValue) === String(req.value);
      if (p === 'value_contains') return String(v.AXValue === undefined ? '' : v.AXValue).toLowerCase().indexOf(String(req.value).toLowerCase()) >= 0;
      return false;
    }
    const app = findApp(req.app);
    if (!app) {
      if (ABSENCE_APP_CONDS.has(cond) && !sawApp) return 'app_not_found';
      last = { app_running: false };
      return ABSENCE_APP_CONDS.has(cond) && sawApp;
    }
    sawApp = true;
    const appEl = appElement(app);
    if (cond === 'window' || cond === 'window_gone') {
      const titles = windowsOf(appEl).map(w => String(attr(w, 'AXTitle') || ''));
      last = { windows: titles.slice(0, 8) };
      const hit = titles.some(t => !req.title || textMatch(t, req.title, req.exact));
      return cond === 'window' ? hit : !hit;
    }
    if (cond === 'menu' || cond === 'menu_closed') { const m = menuOpen(appEl); last = { menu: m }; return cond === 'menu' ? m : !m; }
    if (cond === 'sheet' || cond === 'sheet_gone') {
      let n = 0;
      for (const w of windowsOf(appEl)) {
        const sr = attr(w, 'AXSubrole');
        if (sr === 'AXDialog' || sr === 'AXSystemDialog') n++;
        for (const k of children(w)) if (attr(k, 'AXRole') === 'AXSheet') n++;
      }
      last = { sheets: n };
      return cond === 'sheet' ? n > 0 : n === 0;
    }
    if (cond === 'text' || cond === 'text_gone') {
      const w = pickWindow(appEl, req);
      if (w.error) { last = { window: w.error.code }; return cond === 'text_gone' && w.error.code === 'WINDOW_NOT_FOUND'; }
      const f = walk(w.el, [], { depth: 60, maxNodes: 1, budgetMs: 3000, maxVisit: 20000, find: { text: req.text, exact: Boolean(req.exact), limit: 1 } });
      last = { found: f.nodes.length > 0, complete: f.complete };
      return cond === 'text' ? f.nodes.length > 0 : f.nodes.length === 0 && f.complete;
    }
    throw new Error(`unknown condition ${cond}`);
  };
  const t0 = now();
  for (;;) {
    let ok;
    try { ok = check(); } catch (e) { return fail({ code: 'INVALID_ARGS', message: String(e.message || e) }); }
    if (ok === 'app_not_found') return fail(appNotFound(req));
    if (ok) return { ok: true, met: true, condition: cond, elapsed_ms: now() - t0, observed: last };
    if (now() >= end) return fail({ code: 'TIMEOUT', message: `${cond} not met within ${timeoutMs} ms`, details: { kind: 'wait_timeout', last_observed: last } });
    sleep(250);
  }
}

// ── apps: activate / hide / quit, and waiting for a launch ───────────────────────────────────────
// Session-critical processes are never quit, whatever is asked (matched exactly by bundle id).
const PROTECTED_BUNDLES = new Set(['com.apple.loginwindow', 'com.apple.dock', 'com.apple.systemuiserver', 'com.apple.controlcenter',
  'com.apple.notificationcenterui', 'com.apple.finder', 'com.apple.WindowManager', 'com.apple.Spotlight', 'com.apple.SecurityAgent',
  'com.apple.coreservices.uiagent', 'com.apple.TextInputMenuAgent', 'com.apple.universalcontrol', 'com.apple.WindowServer']);
function appInfo(spec) {
  const a = findApp(spec);
  const out = { running: Boolean(a) };
  if (a) Object.assign(out, { name: a.name, pid: a.pid, bundle_id: a.bundle, presentation: POLICY[a.policy] || 'helper', hidden: a.hidden });
  // where the app lives, also when it is not running (for launch checks)
  let path = null;
  try {
    if (a && a.ns.bundleURL && !a.ns.bundleURL.isNil()) path = a.ns.bundleURL.path.js;
    else if (/^\/.+\.app\/?$/.test(String(spec)) && $.NSFileManager.defaultManager.fileExistsAtPath(String(spec))) path = String(spec).replace(/\/$/, '');
    else if (/^[\w-]+(\.[\w-]+)+$/.test(String(spec))) { const u = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier(String(spec)); if (u && !u.isNil()) path = u.path.js; }
    else { const p = $.NSWorkspace.sharedWorkspace.fullPathForApplication(String(spec)); if (p && !p.isNil()) path = p.js; }
  } catch (e) { /* unknown */ }
  out.path = path;
  if (path) {
    try {
      const list = $.NSFileManager.defaultManager.contentsOfDirectoryAtPathError(path + '/Contents/Frameworks', null);
      const names = [];
      if (list && !list.isNil()) for (let i = 0; i < Number(list.count); i++) names.push(list.objectAtIndex(i).js);
      out.chromium = names.some(x => CHROMIUM_MARKERS.indexOf(x) >= 0 || /(Chrome|Chromium|Edge|Brave|Vivaldi|Opera|Arc).* Framework\.framework$/.test(x));
      out.electron = names.indexOf('Electron Framework.framework') >= 0;
    } catch (e) { out.chromium = false; }
  }
  return out;
}
function opAppInfo(req) { return Object.assign({ ok: true }, appInfo(req.app)); }
function opAppCtl(req) {
  const a = findApp(req.app);
  const action = String(req.action);
  if (!a) return fail(notDelivered({ code: 'APP_NOT_FOUND', message: `no running app named "${req.app}"` }));
  if (action === 'quit') {
    if (PROTECTED_BUNDLES.has(a.bundle)) return fail(notDelivered({ code: 'POLICY_DENIED', message: `${a.name} (${a.bundle}) is part of the macOS session and is never quit` }));
    if ((req.protect_pids || []).indexOf(a.pid) >= 0) return fail(notDelivered({ code: 'POLICY_DENIED', message: `${a.name} runs noracu itself (the MCP host) — quitting it would end this session` }));
    // NSRunningApplication's `terminated` flag is cached in this process (no run loop), so whether the
    // process actually ended is checked by the server, by pid
    const ok = req.force ? a.ns.forceTerminate : a.ns.terminate;
    if (!ok) return fail(notDelivered({ code: 'ACTION_FAILED', message: `${a.name} refused to ${req.force ? 'force-quit' : 'quit'}` }));
    sleep(800); // the request is delivered asynchronously; exiting at once can drop it
    return { ok: true, sent: true, name: a.name, pid: a.pid, method: req.force ? 'force' : 'graceful' };
  }
  if (action === 'hide' || action === 'unhide') {
    // NSRunningApplication's own `hidden` is a cached KVO value that never refreshes here (no run loop);
    // the app's AXHidden attribute is live
    const appEl = appElement(a);
    if (action === 'hide') a.ns.hide; else a.ns.unhide;
    sleep(400);
    const hidden = attr(appEl, 'AXHidden') === true;
    return { ok: true, delivery: hidden === (action === 'hide') ? 'delivered_verified' : 'delivered_unverified', retry: 'safe', name: a.name, pid: a.pid, hidden };
  }
  return fail(notDelivered({ code: 'INVALID_ARGS', message: `unknown app action "${action}"` }));
}
function opAppWait(req) {
  const end = now() + clamp(req.timeout_ms, 0, 60000, 15000);
  let a = null, win = null;
  while (now() < end) {
    a = findApp(req.app);
    if (a && (!req.not_pid || a.pid !== req.not_pid)) {
      if (!req.want_window) break;
      if ($.AXIsProcessTrusted()) {
        const ws = windowsOf(appElement(a));
        if (ws.length) { win = windowInfo(ws[0], 0); break; }
      } else break;
    }
    sleep(250);
  }
  const front = frontApp();
  if (!a) return fail({ code: 'TIMEOUT', message: `"${req.app}" did not start in time`, delivery: 'unknown', retry: 'unsafe', details: { kind: 'launch_timeout' } });
  const out = { ok: true, name: a.name, pid: a.pid, bundle_id: a.bundle, frontmost: Boolean(front && front.pid === a.pid) };
  if (win) out.window = { title: win.title, frame: win.frame };
  else if (req.want_window) out.note = 'running, but no window yet (a document app may show one only when brought forward)';
  return out;
}

// ── windows: focus / minimize / restore / move / resize / maximize ───────────────────────────────
function cgWindow(id) {
  const info = cast($.CGWindowListCopyWindowInfo(8, id));
  if (!info || Number(info.count) < 1) return null;
  const d = info.objectAtIndex(0);
  const g = k => { const o = d.objectForKey(ks(k)); return o && !o.isNil() ? o : null; };
  const b = g('kCGWindowBounds');
  return { id, pid: Number(g('kCGWindowOwnerPID').js), app: g('kCGWindowOwnerName') ? g('kCGWindowOwnerName').js : '', title: g('kCGWindowName') ? g('kCGWindowName').js : null,
    bounds: b ? [Number(b.objectForKey(ks('X')).js), Number(b.objectForKey(ks('Y')).js), Number(b.objectForKey(ks('Width')).js), Number(b.objectForKey(ks('Height')).js)].map(Math.round) : null };
}
// the AX window behind a CGWindowID (same process, same bounds, then same title), or by app + index/title
function axWindowFor(req) {
  if (req.window_id !== undefined && req.window_id !== null) {
    const cg = cgWindow(Number(req.window_id));
    if (!cg) return { error: notDelivered({ code: 'WINDOW_NOT_FOUND', message: `no window with id ${req.window_id}` }) };
    const app = runningApps().find(x => x.pid === cg.pid);
    if (!app) return { error: notDelivered({ code: 'WINDOW_NOT_FOUND', message: 'the window\'s app is gone' }) };
    const appEl = appElement(app);
    const ws = windowsOf(appEl);
    const infos = ws.map((w, i) => windowInfo(w, i));
    // the CGWindowID itself when accessibility exposes it; bounds and title only as a fallback
    let hits = infos.filter(x => x.wid === Number(req.window_id));
    if (!hits.length) hits = infos.filter(x => x.wid === null && rectNear(x.frame, cg.bounds, 2));
    if (hits.length > 1 && cg.title) hits = hits.filter(x => x.title === cg.title);
    if (hits.length !== 1) return { error: notDelivered({ code: hits.length ? 'AMBIGUOUS_WINDOW' : 'WINDOW_NOT_FOUND', message: hits.length ? 'several accessibility windows match that id' : 'accessibility cannot see that window (minimized windows are listed with include_offscreen)' }) };
    return { el: ws[hits[0].n], info: hits[0], app, appEl };
  }
  const app = findApp(req.app);
  if (!app) return { error: notDelivered({ code: 'APP_NOT_FOUND', message: req.app ? `no running app named "${req.app}"` : 'no frontmost app' }) };
  const appEl = appElement(app);
  const w = pickWindow(appEl, req);
  if (w.error) return { error: notDelivered(w.error) };
  return { el: w.el, info: w.info, app, appEl };
}
// AXValueCreate needs a typed pointer holding a real struct. On macOS 27 the bridge's first struct
// conversion in a process can come out as zeros (a plain JS object always does), so the value is read
// back and rebuilt until it holds what was asked; a value that never does is an error, not a zero move.
function axStruct(kind, a, b) {
  for (let i = 0; i < 4; i++) {
    const r = kind === 1 ? Ref('{CGPoint="x"d"y"d}') : Ref('{CGSize="width"d"height"d}');
    r[0] = kind === 1 ? $.CGPointMake(a, b) : $.CGSizeMake(a, b);
    const v = cast($.AXValueCreate(kind, r));
    const back = v ? axValue(v) : null;
    if (back && (kind === 1 ? back.x === a && back.y === b : back.w === a && back.h === b)) return v;
  }
  throw new Error('could not build an accessibility point/size value');
}
function axPoint(x, y) { return axStruct(1, Math.round(x), Math.round(y)); }
function axSize(w, h) { return axStruct(2, Math.round(w), Math.round(h)); }
function visibleFrameOf(x, y) {
  const s = $.NSScreen.screens;
  const mainH = Number(s.objectAtIndex(0).frame.size.height);
  for (let i = 0; i < Number(s.count); i++) {
    const sc = s.objectAtIndex(i);
    const f = sc.frame, v = sc.visibleFrame;
    const fx = Number(f.origin.x), fy = mainH - Number(f.origin.y) - Number(f.size.height), fw = Number(f.size.width), fh = Number(f.size.height);
    if (x >= fx && x < fx + fw && y >= fy && y < fy + fh) return [Number(v.origin.x), mainH - Number(v.origin.y) - Number(v.size.height), Number(v.size.width), Number(v.size.height)];
  }
  return null;
}
function opWindowOp(req) {
  if (!$.AXIsProcessTrusted()) return fail(permError());
  const w = axWindowFor(req);
  if (w.error) return fail(w.error);
  const action = String(req.action);
  const before = windowInfo(w.el, w.info.n);
  let err = 0, raiseErr = 0;
  if (action === 'focus' || action === 'raise') {
    // several steps change the window before AXRaise answers, so an AXRaise error is not "nothing
    // sent": the result is decided by the state asked for (R19)
    if (before.minimized) { setAttr(w.el, 'AXMinimized', NO()); sleep(150); }
    raiseErr = perform(w.el, 'AXRaise');
    setAttr(w.el, 'AXMain', YES());
    if (action === 'focus') { try { w.app.ns.activateWithOptions(1 << 1); } catch (e) { /* activation may be refused */ } }
  } else if (action === 'minimize') err = setAttr(w.el, 'AXMinimized', YES());
  else if (action === 'restore') { err = setAttr(w.el, 'AXMinimized', NO()); perform(w.el, 'AXRaise'); }
  else if (action === 'move') {
    if (!Number.isFinite(Number(req.x)) || !Number.isFinite(Number(req.y))) return invalid('move needs x and y');
    err = setAttr(w.el, 'AXPosition', axPoint(Number(req.x), Number(req.y)));
  } else if (action === 'resize') {
    if (!(Number(req.width) > 0) || !(Number(req.height) > 0)) return invalid('resize needs width and height');
    err = setAttr(w.el, 'AXSize', axSize(Number(req.width), Number(req.height)));
  } else if (action === 'maximize') {
    const fr = before.frame;
    const vf = fr ? visibleFrameOf(fr[0] + fr[2] / 2, fr[1] + fr[3] / 2) : null;
    if (!vf) return fail(notDelivered({ code: 'ACTION_FAILED', message: 'could not tell which display the window is on' }));
    err = setAttr(w.el, 'AXPosition', axPoint(vf[0], vf[1]));
    if (err === 0) {
      const se = setAttr(w.el, 'AXSize', axSize(vf[2], vf[3]));
      if (se !== 0) return fail({ code: 'ACTION_FAILED', message: `moved the window but could not resize it: ${axCallError(se, 'AXSize').message}`, delivery: 'delivered_unverified', retry: 'safe' });
    }
  } else if (action === 'fullscreen' || action === 'exit_fullscreen') {
    err = setAttr(w.el, 'AXFullScreen', action === 'fullscreen' ? YES() : NO());
  } else return invalid(`unknown window action "${action}"`);
  if (err !== 0) return fail(axCallError(err, `window ${action}`));
  sleep(action === 'fullscreen' || action === 'exit_fullscreen' ? 900 : 300);
  const after = windowInfo(w.el, w.info.n);
  const front = frontApp();
  const changed = JSON.stringify([before.frame, before.minimized, before.focused, before.main]) !== JSON.stringify([after.frame, after.minimized, after.focused, after.main]);
  // verified only by the state that was asked for, not by any change
  const fr = after.frame, near = (a, b) => Math.abs(a - b) <= 4;
  const want = {
    focus: () => Boolean(front && front.pid === w.app.pid && (after.focused || after.main)),
    raise: () => after.main === true || changed,
    minimize: () => after.minimized === true,
    restore: () => after.minimized === false,
    move: () => Boolean(fr) && near(fr[0], Number(req.x)) && near(fr[1], Number(req.y)),
    resize: () => Boolean(fr) && near(fr[2], Number(req.width)) && near(fr[3], Number(req.height)),
    maximize: () => { const vf = before.frame ? visibleFrameOf(before.frame[0] + before.frame[2] / 2, before.frame[1] + before.frame[3] / 2) : null; return Boolean(fr && vf) && rectNear(fr, vf, 8); },
    fullscreen: () => attr(w.el, 'AXFullScreen') === true,
    exit_fullscreen: () => attr(w.el, 'AXFullScreen') === false,
  };
  const verified = want[action] ? want[action]() : changed;
  if (raiseErr !== 0 && !verified) {
    const e = axCallError(raiseErr, `window ${action}`);
    // the window may already have been unminimized / made main / activated
    return fail(e.delivery === 'not_delivered' ? Object.assign({}, e, { delivery: 'delivered_unverified', retry: 'safe' }) : e);
  }
  return { ok: true, action, app: w.app.name, window: { title: after.title, frame: after.frame, minimized: after.minimized, focused: after.focused }, frontmost: front ? front.name : null,
    delivery: verified ? 'delivered_verified' : 'delivered_unverified', retry: 'safe' };
}

// ── paste (mac_paste) ────────────────────────────────────────────────────────────────────────────
// One engine call does the whole paste, so the user's clipboard never leaves this process and nothing
// can slip in between the steps: focus guard → copy every item and type aside → write the text (marked
// transient, so clipboard managers skip it) → ⌘V as a key event, only if the clipboard and the
// frontmost app are still as they were → wait for the paste to show in the focused element (else at
// least 1 s, and only while the app answers) → put the user's items back, only if nobody else wrote
// to the clipboard meanwhile. A password manager's concealed item is never copied or put back: the
// clipboard is cleared instead.
const PB_CONCEALED = 'org.nspasteboard.ConcealedType', PB_TRANSIENT = 'org.nspasteboard.TransientType';
const PB_REMOTE = 'com.apple.is-remote-clipboard';
const CLIP_SAVE_LIMIT = 64 * 1024 * 1024;
function pbGeneral() { return $.NSPasteboard.generalPasteboard; }
function pbTypes() {
  const out = [], tl = pbGeneral().types;
  if (tl && !tl.isNil()) for (let i = 0; i < Number(tl.count); i++) out.push(tl.objectAtIndex(i).js);
  return out;
}
function pbChangeCount() { return Number(pbGeneral().changeCount); }
// the types of every item (NSPasteboard.types lists only the first item's), read without any data
function pbItemTypes() {
  const out = [], items = pbGeneral().pasteboardItems;
  if (items && !items.isNil()) for (let i = 0; i < Number(items.count); i++) {
    const tl = items.objectAtIndex(i).types;
    if (tl && !tl.isNil()) for (let j = 0; j < Number(tl.count); j++) out.push(tl.objectAtIndex(j).js);
  }
  return out;
}
// every item with every type's data, kept as NSData in this process
function pbSave(limit) {
  const items = pbGeneral().pasteboardItems, out = [];
  let bytes = 0;
  if (items && !items.isNil()) for (let i = 0; i < Number(items.count); i++) {
    const it = items.objectAtIndex(i), tl = it.types, rec = [];
    if (tl && !tl.isNil()) for (let j = 0; j < Number(tl.count); j++) {
      const t = tl.objectAtIndex(j).js, d = it.dataForType(ks(t));
      if (!d || d.isNil()) continue;
      bytes += Number(d.length);
      if (bytes > limit) return { too_large: true, bytes };
      rec.push([t, d]);
    }
    if (rec.length) out.push(rec);
  }
  if (!out.length) {
    const d = pbGeneral().dataForType(ks('public.utf8-plain-text'));
    if (d && !d.isNil()) { bytes = Number(d.length); out.push([['public.utf8-plain-text', d]]); }
  }
  return { items: out, bytes };
}
function pbWriteObjects(objs) {
  const p = pbGeneral();
  p.clearContents;
  if (!objs.length) return true;
  const a = $.NSMutableArray.alloc.init;
  for (const o of objs) a.addObject(o);
  return Boolean(p.writeObjects(a));
}
// our text as UTF-8 plain text, marked transient; the change count afterwards identifies our write
function pbWriteText(text) {
  const it = $.NSPasteboardItem.alloc.init;
  it.setStringForType($(text), ks('public.utf8-plain-text'));
  it.setDataForType($.NSData.data, ks(PB_TRANSIENT));
  return pbWriteObjects([it]) ? pbChangeCount() : null;
}
function pbRestore(saved) {
  return pbWriteObjects(saved.items.map(rec => { const it = $.NSPasteboardItem.alloc.init; for (const [t, d] of rec) it.setDataForType(d, ks(t)); return it; }));
}
function pbClear() { pbGeneral().clearContents; }
// a program by absolute path with an argv array (no shell), output discarded, under a time limit
function runTool(path, args, timeoutMs) {
  if (!$.NSFileManager.defaultManager.isExecutableFileAtPath(String(path))) return { started: false, error: `${path} is not an executable file` };
  const t = $.NSTask.alloc.init;
  t.launchPath = String(path);
  t.arguments = $(args.map(String));
  t.standardOutput = $.NSFileHandle.fileHandleWithNullDevice;
  t.standardError = $.NSFileHandle.fileHandleWithNullDevice;
  try { t.launch; } catch (e) { return { started: false, error: String(e.message || e).slice(0, 160) }; }
  const end = now() + timeoutMs;
  while (t.running && now() < end) sleep(20);
  if (t.running) {
    // never leave it running: it could still send its events after we have moved on
    t.terminate;
    const grace = now() + 300;
    while (t.running && now() < grace) sleep(20);
    if (t.running) { const k = $.NSTask.alloc.init; k.launchPath = '/bin/kill'; k.arguments = $(['-9', String(Number(t.processIdentifier))]); try { k.launch; k.waitUntilExit; } catch (e) { /* gone */ } }
    return { started: true, timedOut: true };
  }
  return { started: true, status: Number(t.terminationStatus) };
}
// what a paste changes in the focused element (null when nothing there can be read)
// { el, key } — the focused element and a digest of its value, length and selection; null when
// nothing there can be read. Each read gives up after half a second (an app that hangs right after
// ⌘V must not eat the whole call's time).
function focusEvidence(appEl) {
  const f = attr(appEl, 'AXFocusedUIElement');
  if (!f || !f.el) return null;
  try { $.AXUIElementSetMessagingTimeout(f.el, 0.5); } catch (e) { /* default */ }
  const v = readNode(f.el);
  if (v.__err) return null;
  const n = attr(f.el, 'AXNumberOfCharacters'), sel = attr(f.el, 'AXSelectedTextRange');
  const raw = typeof v.AXValue === 'string' ? v.AXValue : null;
  const val = raw !== null ? vhash(raw) : null;
  if (val === null && typeof n !== 'number' && !sel) return null;
  // raw and sel stay inside the engine process (CP: the paste is checked against the insertion point)
  return { el: f.el, key: JSON.stringify([val, typeof n === 'number' ? n : null, sel || null]), raw, sel: sel || null };
}
const PASTE_MIN_HOLD_MS = 300;
// The current keyboard layout's id (e.g. com.apple.keylayout.US), or null when it cannot be read.
function keyboardLayoutId() {
  try {
    ObjC.import('Carbon');
    const s = $.TISCopyCurrentKeyboardLayoutInputSource();
    return String(ObjC.castRefToObject($.TISGetInputSourceProperty(s, $.kTISPropertyInputSourceID)).js);
  } catch (e) { return null; }
}
// Key code 9 is V on QWERTY, QWERTZ, AZERTY and Colemak layouts; a Dvorak layout puts K there, so ⌘ with
// it would be ⌘K. The "Dvorak - QWERTY ⌘" layouts keep ⌘ shortcuts on QWERTY and are fine.
function vKeyIsElsewhere(layout) { return typeof layout === 'string' && /dvorak/i.test(layout) && !/qwerty/i.test(layout); }
function opPaste(req) {
  const text = String(req.text === undefined || req.text === null ? '' : req.text);
  if (!text) return invalid('text required');
  const layout = keyboardLayoutId();
  if (vKeyIsElsewhere(layout)) return fail(notDelivered({ code: 'ACTION_NOT_SUPPORTED', message: `the keyboard layout ${layout} does not have V where ⌘V is sent from (key code 9) — nothing was pasted; mac_type types without the clipboard`, details: { kind: 'keyboard_layout' } }));
  const front = frontApp();
  if (!front) return fail(notDelivered({ code: 'FOCUS_UNKNOWN', message: 'could not read the frontmost app — nothing was pasted' }));
  let target = front;
  if (req.app) {
    const t = findApp(req.app);
    if (!t) return fail(notDelivered({ code: 'FOCUS_LOST', message: `"${req.app}" is not running (frontmost is "${front.name}") — nothing was pasted` }));
    if (t.pid !== front.pid) return fail(notDelivered({ code: 'FOCUS_LOST', message: `expected "${t.name}", frontmost is "${front.name}" — nothing was pasted` }));
    target = t;
  }
  const force = req.force === true;
  const appEl = appElement(target);
  const ev0 = focusEvidence(appEl);
  // the change count before anything is read: a copy that lands while we save is not overwritten
  const cc0 = pbChangeCount();
  // the first item's types tell a remote (Universal Clipboard) clipboard before any item is touched;
  // the other items' types are read without their data
  const first = pbTypes();
  const remote = first.indexOf(PB_REMOTE) >= 0;
  const types = remote ? first : first.concat(pbItemTypes());
  // keep: why the clipboard will not be put back exactly as it was
  let saved = null, keep = null;
  if (!remote && types.indexOf(PB_CONCEALED) >= 0) keep = 'previous_concealed';
  else if (!remote && types.indexOf(PB_TRANSIENT) >= 0) keep = 'previous_transient';
  else if (remote || (types.some(t => /^com\.apple\.pasteboard\.promised-file/.test(t)) && types.indexOf('public.file-url') < 0)) {
    // reading it would start a transfer from the other device (or make the promised file)
    if (!force) return fail(notDelivered({ code: 'CLIPBOARD_REMOTE', message: 'the clipboard holds content from another device (Universal Clipboard) or a file not made yet, which cannot be copied aside without fetching it — nothing was pasted. mac_type types without the clipboard; force:true pastes and leaves the pasted text on the clipboard' }));
    keep = 'remote';
  } else if (!types.length) keep = 'was_empty';
  else {
    const sv = pbSave(CLIP_SAVE_LIMIT);
    if (sv.too_large) {
      if (!force) return fail(notDelivered({ code: 'CLIPBOARD_TOO_LARGE', message: `the clipboard holds more than ${CLIP_SAVE_LIMIT / 1048576} MB, which is not copied aside — nothing was pasted. mac_type types without the clipboard; force:true pastes and leaves the pasted text on the clipboard` }));
      keep = 'too_large';
    } else saved = sv;
  }
  const putBack = (ours) => {
    if (pbChangeCount() !== ours) return 'false (changed_externally)';
    if (keep === 'previous_concealed' || keep === 'previous_transient') { pbClear(); return `cleared (${keep})`; }
    if (keep === 'was_empty') { pbClear(); return 'true (was_empty)'; }
    if (keep) return `false (${keep})`;
    return pbRestore(saved) ? 'true' : 'false (write_failed)';
  };
  if (pbChangeCount() !== cc0) return fail(notDelivered({ code: 'NOT_CONFIRMED', message: 'another app wrote to the clipboard while it was being copied aside — nothing was written or pasted' }));
  const ours = pbWriteText(text);
  if (ours === null) {
    const restored = saved || keep ? putBack(pbChangeCount()) : 'false';
    return fail(notDelivered({ code: 'ACTION_FAILED', message: `could not write the text to the clipboard — nothing was pasted (clipboard restored: ${restored})` }));
  }
  if (ours !== cc0 + 1) {
    // someone else wrote between the last check and our write: that write is gone; do not paste
    const restored = putBack(ours);
    return fail(notDelivered({ code: 'NOT_CONFIRMED', message: `another app wrote to the clipboard at the same moment as noracu — nothing was pasted (clipboard restored: ${restored})` }));
  }
  // last check before the keystroke: still our text on the clipboard, still the same app in front
  const f2 = frontApp();
  if (pbChangeCount() !== ours) return fail(notDelivered({ code: 'NOT_CONFIRMED', message: 'another app wrote to the clipboard just before the paste — nothing was pasted (the clipboard keeps what that app wrote)' }));
  if (!f2 || f2.pid !== target.pid) {
    const restored = putBack(ours);
    return fail(notDelivered({ code: 'FOCUS_LOST', message: `the frontmost app changed to "${f2 ? f2.name : 'unknown'}" just before the paste — nothing was pasted (clipboard restored: ${restored})` }));
  }
  // ⌘V is the V key itself (key code 9) with the ⌘ flag, posted here. cliclick's `kd:cmd t:v ku:cmd`
  // types text, not that key: on macOS 27.2 TextEdit got a plain "v", or nothing, instead of a paste
  // (E2 run 2026-11-07, T7).
  const sent = postKey(KEY_V, [[MOD_KEYCODES.cmd, KEY_FLAGS.cmd]], 0);
  releaseStuckModifiers(['cmd']);
  if (!sent) {
    // the V key was never posted (postKey creates both events before posting either)
    const restored = putBack(ours);
    return fail(notDelivered({ code: 'ACTION_FAILED', message: `could not create the keyboard events for ⌘V — nothing was pasted (clipboard restored: ${restored})` }));
  }
  // the paste is done when the focused element shows it; without that evidence the clipboard stays
  // ours for at least hold_ms, so an app that reads it late does not get the user's clipboard instead
  // evidence counts only from the element that was focused before (a focus move is not a paste), and
  // the clipboard stays ours for at least PASTE_MIN_HOLD_MS even then
  const holdMs = clamp(req.hold_ms, PASTE_MIN_HOLD_MS, 5000, 1000);
  const t0 = now();
  // CP (Y6): evidence is the focused element's value becoming exactly the text pasted over the selection
  // that was there; a change that does not match (or no readable insertion point) keeps waiting and
  // ends delivered_unverified with the reason
  let evidence = false, changed = false;
  const expectAfter = ev0 ? expectedInsert(ev0.raw, ev0.sel, text) : null;
  const end = t0 + holdMs;
  while (now() < end) {
    sleep(100);
    const e = focusEvidence(appEl);
    if (ev0 && e && same(e.el, ev0.el) && e.key !== ev0.key) {
      changed = true;
      // R36: the value itself must have changed — pasting over a selection that already held the same
      // text leaves an identical value, and a moved caret alone is no proof that ⌘V was handled
      if (expectAfter !== null && sameText(e.raw, expectAfter) && !sameText(e.raw, ev0.raw)) { evidence = true; break; }
    }
  }
  if (evidence && now() - t0 < PASTE_MIN_HOLD_MS) sleep(PASTE_MIN_HOLD_MS - (now() - t0));
  // an app that does not answer may not have read the clipboard yet: leave our text there
  const hung = !evidence && readNode(appEl).__err === -25204;
  const restored = hung ? 'false (app_unresponsive)' : putBack(ours);
  const reason = evidence || !changed ? undefined : expectAfter === null ? 'insertion_point_unreadable' : sameText(expectAfter, ev0.raw) ? 'value_unchanged' : 'not_at_insertion_point';
  return { ok: true, delivery: evidence ? 'delivered_verified' : 'delivered_unverified', retry: 'unsafe', restored, front: target.name, chars: text.length, reason };
}

// ── clipboard (read) ─────────────────────────────────────────────────────────────────────────────
// Password managers mark secrets with org.nspasteboard.ConcealedType (nspasteboard.org); such an item is
// never returned. Text is capped; an image comes back as PNG for the server to attach.
function opClipboard(req) {
  const pb = $.NSPasteboard.generalPasteboard;
  const types = [];
  const tl = pb.types;
  if (tl && !tl.isNil()) for (let i = 0; i < Number(tl.count); i++) types.push(tl.objectAtIndex(i).js);
  const out = { ok: true, types: types.slice(0, 20), change_count: Number(pb.changeCount) };
  // a concealed mark on any item (types lists only the first item's) withholds the whole clipboard
  if (types.indexOf('org.nspasteboard.ConcealedType') >= 0 || pbItemTypes().indexOf('org.nspasteboard.ConcealedType') >= 0) { out.concealed = true; out.note = 'the clipboard holds an item marked concealed (e.g. a password manager copy); its content is not returned'; return out; }
  const fmt = req.format || 'auto';
  if (fmt === 'auto' || fmt === 'files') {
    const items = pb.pasteboardItems;
    const files = [];
    if (items && !items.isNil()) for (let i = 0; i < Number(items.count); i++) {
      const s = items.objectAtIndex(i).stringForType(ks('public.file-url'));
      if (s && !s.isNil()) { const u = $.NSURL.URLWithString(s); if (u && !u.isNil() && u.path && !u.path.isNil()) files.push(u.path.js); }
    }
    if (files.length) { out.type = 'files'; out.files = files.slice(0, 200); return out; }
    if (fmt === 'files') { out.type = 'none'; return out; }
  }
  if (fmt === 'auto' || fmt === 'image') {
    const t = types.indexOf('public.png') >= 0 ? 'public.png' : types.indexOf('public.tiff') >= 0 ? 'public.tiff' : null;
    if (t) {
      const data = pb.dataForType(ks(t));
      const rep = $.NSBitmapImageRep.imageRepWithData(data);
      if (rep && !rep.isNil()) {
        const png = rep.representationUsingTypeProperties(4, $({}));
        out.type = 'image'; out.width = Number(rep.pixelsWide); out.height = Number(rep.pixelsHigh);
        out.png_base64 = png.base64EncodedStringWithOptions(0).js;
        return out;
      }
    }
    if (fmt === 'image') { out.type = 'none'; return out; }
  }
  const s = pb.stringForType(ks('public.utf8-plain-text'));
  if (s && !s.isNil()) {
    const text = s.js;
    const max = clamp(req.max_chars, 1, 200000, 20000);
    out.type = 'text'; out.length = text.length; out.text = text.length > max ? text.slice(0, max) : text; out.truncated = text.length > max;
    return out;
  }
  out.type = 'none';
  return out;
}

// ── notifications ────────────────────────────────────────────────────────────────────────────────
// Banners, alerts and (when it is open) Notification Center's list live in the Notification Center
// process as groups with an AXNotificationCenter* subrole. Each carries a stable AXIdentifier (a UUID),
// a description "App, title, subtitle, body", text children identified as title / subtitle / body, and
// its buttons as named actions ("Name:Close\nTarget:…").
function ncApp() { return runningApps().find(a => a.bundle === 'com.apple.notificationcenterui') || null; }
function actionLabel(a) { const m = String(a).match(/^Name:(.*?)(\n|$)/); return m ? m[1] : a === 'AXPress' ? 'press' : null; }
function collectNotifications(appEl) {
  const found = [];
  const visit = (el, d) => {
    if (d > 14) return;
    const v = readNode(el);
    if (v.__err) return;
    if (String(v.AXSubrole || '').indexOf('AXNotificationCenter') === 0) {
      const texts = {};
      for (const k of v.AXChildren || []) { const kv = readNode(k); if (kv.AXRole === 'AXStaticText' && kv.AXIdentifier) texts[kv.AXIdentifier] = typeof kv.AXValue === 'string' ? kv.AXValue : ''; }
      const desc = typeof v.AXDescription === 'string' ? v.AXDescription : '';
      const acts = actionNames(el);
      found.push({ el, id: String(v.AXIdentifier || ''), kind: String(v.AXSubrole).replace('AXNotificationCenter', '').toLowerCase(),
        app: desc.split(', ')[0] || '', title: texts.title || '', subtitle: texts.subtitle || '', body: texts.body || '',
        actions: acts.map(actionLabel).filter(Boolean), rawActions: acts });
      return;
    }
    for (const k of v.AXChildren || []) visit(k, d + 1);
  };
  for (const w of windowsOf(appEl)) visit(w, 0);
  return found;
}
function listNotifications() {
  const a = ncApp();
  if (!a) return [];
  return collectNotifications(appElement(a)).map(n => ({ id: n.id, kind: n.kind, app: n.app, title: n.title, subtitle: n.subtitle, body: n.body, actions: n.actions }));
}
// Notification Center's history opens from the clock in the menu bar, when accessibility exposes it.
function clockExtra() {
  for (const b of ['com.apple.controlcenter', 'com.apple.systemuiserver', 'com.apple.notificationcenterui']) {
    const a = runningApps().find(x => x.bundle === b);
    if (!a) continue;
    const mb = attr(appElement(a), 'AXExtrasMenuBar');
    if (!mb || !mb.el) continue;
    for (const it of children(mb.el)) {
      const v = readNode(it);
      const tag = [v.AXIdentifier, v.AXTitle, v.AXDescription].map(x => String(x || '')).join(' ').toLowerCase();
      if (/clock|notification center/.test(tag)) return it;
    }
  }
  return null;
}
// True only on positive evidence that Notification Center's panel is already open: the menu-bar clock reads
// selected / expanded, or a window holds a Notification Center element that is not a banner or alert.
// Desktop widgets are windows of the same process (macOS 27.2: 180 × 180 AXUnknown windows, verified on a
// real Mac), so "it has a window" is no evidence (t10 review).
function ncCenterOpen(appEl, clock) {
  if (clock && (attr(clock, 'AXSelected') === true || attr(clock, 'AXExpanded') === true)) return true;
  for (const w of windowsOf(appEl)) {
    let panel = false;
    const scan = (el, d) => {
      if (d > 8 || panel) return;
      const v = readNode(el);
      if (v.__err) return;
      const sr = String(v.AXSubrole || '');
      if (sr.indexOf('AXNotificationCenter') === 0 && sr !== 'AXNotificationCenterBanner' && sr !== 'AXNotificationCenterAlert') { panel = true; return; }
      for (const k of v.AXChildren || []) scan(k, d + 1);
    };
    scan(w, 0);
    if (panel) return true;
  }
  return false;
}
function opNotifications(req) {
  if (!$.AXIsProcessTrusted()) return fail(permError());
  if (req.id === '' || req.expected_app === '' || req.expected_title === '') {
    return invalid('id, expected_app and expected_title must be non-empty strings');
  }
  const a = ncApp();
  if (!a) return fail(notDelivered({ code: 'APP_NOT_FOUND', message: 'Notification Center is not running' }));
  const appEl = appElement(a);
  const action = req.action || 'list';
  let opened = false, alreadyOpen = false;
  if (req.open_center) {
    const clock = clockExtra();
    if (ncCenterOpen(appEl, clock)) {
      alreadyOpen = true;
    } else {
      if (!clock) return fail(notDelivered({ code: 'ACTION_NOT_SUPPORTED', message: 'accessibility does not expose the menu-bar clock here, so Notification Center cannot be opened from noracu — open it yourself (click the clock) and list again; banners on screen are listed without it', details: { kind: 'open_center_unavailable' } }));
      if (perform(clock, 'AXPress') === 0) { opened = true; sleep(900); }
    }
  }
  const all = collectNotifications(appEl);
  const close = () => { if (opened) { const c = clockExtra(); if (c) perform(c, 'AXPress'); } };
  if (action === 'list') {
    let list = all.map((n, i) => ({ index: i + 1, id: n.id, kind: n.kind, app: n.app, title: n.title, subtitle: n.subtitle, body: n.body, actions: n.actions }));
    if (req.app) list = list.filter(n => textMatch(n.app, req.app, false));
    if (req.text) list = list.filter(n => textMatch([n.title, n.subtitle, n.body].join('\n'), req.text, false));
    close();
    // center_opened: this call opened it (and closed it again); center_was_open: it was already open, so the clock was not clicked
    return { ok: true, count: list.length, notifications: list.slice(0, clamp(req.limit, 1, 100, 20)), center_opened: opened, center_was_open: alreadyOpen,
      note: list.length || opened || alreadyOpen ? undefined : 'only notifications on screen (banners, alerts, an open Notification Center) are visible to accessibility' };
  }
  // dismiss / act: by id (preferred) or 1-based index, and the listing must still match the fingerprint
  const hasId = typeof req.id === 'string' && req.id.length > 0;
  let n = hasId ? all.find(x => x.id === req.id) : (Number.isInteger(req.index) ? all[req.index - 1] : null);
  if (!n) {
    close();
    const missingMsg = hasId
      ? `no notification with id ${req.id} is on screen (it may have been dismissed or moved into Notification Center)`
      : Number.isInteger(req.index)
        ? `no notification at index ${req.index} (${all.length} visible on screen)`
        : 'give id (from mac_notifications list) or index';
    return fail(notDelivered({ code: 'NOTIFICATION_NOT_FOUND', message: missingMsg }));
  }
  if ((req.expected_app && !textMatch(n.app, req.expected_app, false)) || (req.expected_title && !textMatch(n.title, req.expected_title, false))) {
    close();
    return fail(notDelivered({ code: 'NOTIFICATION_NOT_FOUND', message: `the notification there now is from "${n.app}" titled "${n.title}", not the expected one — list again`, details: { kind: 'fingerprint_mismatch' } }));
  }
  const want = action === 'dismiss' ? 'close' : String(req.name || 'press').toLowerCase();
  const idx = n.rawActions.findIndex(x => String(actionLabel(x) || '').toLowerCase() === want);
  if (idx < 0) { close(); return fail(notDelivered({ code: 'ACTION_NOT_SUPPORTED', message: `the notification offers ${n.actions.join(', ') || 'no actions'}, not "${want}"`, details: { actions: n.actions } })); }
  const e = perform(n.el, n.rawActions[idx]);
  if (e !== 0) {
    // only "invalid element" proves it was gone before the action ran; after any other error a missing
    // notification may be this action's own effect, so delivery stays what the error says (t10 review)
    const goneNow = e !== -25202 && !collectNotifications(appEl).some(x => x.id === n.id);
    close();
    if (e === -25202) return fail(notDelivered({ code: 'NOTIFICATION_NOT_FOUND', message: `no notification with id ${n.id} is on screen (it was dismissed before the action ran)` }));
    const err = axCallError(e, `notification ${want}`);
    if (goneNow) err.message += ' — the notification is no longer on screen (this action may have closed it); list again before retrying';
    return fail(err);
  }
  sleep(500);
  const still = collectNotifications(appEl).some(x => x.id === n.id);
  close();
  return { ok: true, action: want, id: n.id, app: n.app, title: n.title, delivery: want === 'close' ? (still ? 'delivered_unverified' : 'delivered_verified') : 'delivered_unverified', retry: 'unsafe' };
}

// ── menu bar commands ────────────────────────────────────────────────────────────────────────────
// Menu items are reachable through the menu bar hierarchy without opening any menu; AXPress on an item
// runs it without moving the pointer. `command` is an item title (must be unique in the menu bar) or a
// path "File > Export > PDF…". Matching is by the titles the app shows, so it follows the app's language.
function menuItems(menuBar, topMenu) {
  const out = [];
  const barKids = children(menuBar);
  let bars = [];
  for (let i = 0; i < barKids.length; i++) {
    const v = readNode(barKids[i]);
    if (v.__err || v.AXRole !== 'AXMenuBarItem') continue;
    bars.push({ el: barKids[i], bar: i, title: nameOf(v) });
  }
  // a path whose first segment names a top-level menu walks only that menu; a path that starts below
  // the top level ("Export > PDF…") still matches as a suffix anywhere
  if (topMenu) {
    const exact = bars.filter(b => b.title === topMenu);
    const scoped = exact.length ? exact : bars.filter(b => normMenu(b.title) === normMenu(topMenu));
    if (scoped.length) bars = scoped;
  }
  const visit = (el, path, bar, d) => {
    if (d > 8) return;
    for (const k of children(el)) {
      const v = readNode(k);
      if (v.__err) continue;
      if (v.AXRole === 'AXMenuItem') {
        const t = nameOf(v);
        const p = t ? path.concat(t) : path;
        if (t) out.push({ el: k, path: p, enabled: v.AXEnabled !== false, bar, id: v.AXIdentifier || '' });
        visit(k, p, bar, d + 1);
      } else if (v.AXRole === 'AXMenu') visit(k, path, bar, d + 1);
    }
  };
  for (const b of bars) visit(b.el, b.title ? [b.title] : [], b.bar, 1);
  return out;
}
function normMenu(x) { return String(x).replace(/[.…]+$/, '').trim().toLowerCase(); }
// Menu shortcut attributes → chord id in the server's format ("alt+cmd+shift+q"), or null when none.
// AXMenuItemCmdModifiers bits: 1 = Shift, 2 = Option, 4 = Control, 8 = NoCommand (Command is present unless bit 8 is set).
function menuChord(cmdChar, mods, vk) {
  const ch = typeof cmdChar === 'string' ? cmdChar : '';
  const v = typeof vk === 'number' && Number.isInteger(vk) ? vk : null;
  let key = null;
  if (v === 117) key = 'fwd-delete';
  else if (ch === '\u0008' || v === 51) key = 'delete';
  else if (ch === '\u238b' || v === 53) key = 'esc';
  else if (ch.length === 1 && !/[\x00-\x1f\x7f-\x9f\ue000-\uf8ff]/.test(ch)) key = ch.toLowerCase();
  if (!key) return null;
  const m = typeof mods === 'number' ? mods : 0;
  const ms = [];
  if (m & 2) ms.push('alt');
  if (!(m & 8)) ms.push('cmd');
  if (m & 4) ms.push('ctrl');
  if (m & 1) ms.push('shift');
  return ms.concat(key).join('+');
}
function opMenu(req) {
  if (!$.AXIsProcessTrusted()) return fail(permError());
  const app = findApp(req.app);
  if (!app) return fail(notDelivered({ code: 'APP_NOT_FOUND', message: `no running app named "${req.app}"` }));
  const appEl = appElement(app);
  const mb = attr(appEl, 'AXMenuBar');
  if (!mb || !mb.el) return fail(notDelivered({ code: 'SURFACE_ABSENT', message: `"${app.name}" exposes no menu bar` }));
  const want = String(req.command || '').split(/\s*>\s*/).filter(Boolean);
  if (!want.length) return fail(notDelivered({ code: 'INVALID_ARGS', message: 'menu command required' }));
  const items = menuItems(mb.el, want.length > 1 ? want[0] : null);
  let hits = items.filter(i => i.path.length >= want.length && want.every((w, k) => i.path[i.path.length - want.length + k] === w));
  if (!hits.length) hits = items.filter(i => i.path.length >= want.length && want.every((w, k) => normMenu(i.path[i.path.length - want.length + k]) === normMenu(w)));
  if (!hits.length) return fail(notDelivered({ code: 'ACTION_FAILED', message: `no menu item "${req.command}" in ${app.name}`, details: { kind: 'menu_item_absent' } }));
  if (hits.length > 1) return fail(notDelivered({ code: 'AMBIGUOUS_TARGET', message: `${hits.length} menu items match "${req.command}" — give the path, e.g. "${hits[0].path.join(' > ')}"`, details: { kind: 'menu_item_ambiguous', paths: hits.slice(0, 8).map(h => h.path.join(' > ')) } }));
  const h = hits[0];
  const itemPath = h.path.join(' > ');
  // the shortcut is read for the chosen item only (not for every item walked)
  const chord = menuChord(attr(h.el, 'AXMenuItemCmdChar'), attr(h.el, 'AXMenuItemCmdModifiers'), attr(h.el, 'AXMenuItemCmdVirtualKey'));
  const isQuit = chord === 'cmd+q' || chord === 'alt+cmd+q' || h.id === 'terminate:' || h.id === 'NSAlternateQuitMenuItem';
  if (isQuit && PROTECTED_BUNDLES.has(app.bundle)) {
    return fail(notDelivered({ code: 'POLICY_DENIED', message: `"${itemPath}" in ${app.name}: ${app.name} (${app.bundle}) is part of the macOS session and is never quit` }));
  }
  if (isQuit && (req.protect_pids || []).indexOf(app.pid) >= 0) {
    return fail(notDelivered({ code: 'POLICY_DENIED', message: `"${itemPath}" in ${app.name}: ${app.name} runs noracu itself (the MCP host) — quitting it would end this session` }));
  }
  if (h.bar === 0 && req.force !== true) {
    return fail(notDelivered({ code: 'POLICY_DENIED', message: `"${itemPath}" is under the Apple menu (sleep, lock, log out, restart, shut down, Force Quit) — nothing was sent; pass force:true if that is intended` }));
  }
  if (chord && (req.deny_chords || []).indexOf(chord) >= 0 && req.force !== true) {
    return fail(notDelivered({ code: 'POLICY_DENIED', message: `"${itemPath}" in ${app.name} has shortcut ${chord}, which is a refused chord — nothing was sent; pass force:true if that is intended` }));
  }
  if (req.require_enabled === true && !h.enabled) {
    return fail(notDelivered({ code: 'ACTION_FAILED', message: `menu item "${itemPath}" in ${app.name} is disabled`, details: { kind: 'menu_item_disabled' } }));
  }
  // AppKit re-validates a menu only when it opens, so AXEnabled on an item of a closed menu can be stale
  // (Select All reads disabled while the text view would accept it). Pressing a truly disabled item does
  // nothing, so it is pressed anyway and the before/after reading decides what is reported.
  const before = observeState(null, appEl);
  const focusEl = attr(appEl, 'AXFocusedUIElement');
  const fBefore = focusEl && focusEl.el ? observeState(focusEl.el, appEl) : null;
  const e = perform(h.el, 'AXPress');
  if (e !== 0 && e !== -25204) return fail(axCallError(e, 'AXPress'));
  sleep(clamp(req.settle_ms, 0, 3000, 300));
  const v = verdict(before, observeState(null, appEl), { mechanism: 'semantic', action: 'AXPress', path: itemPath, app: app.name });
  // the focused element is where most menu commands land (Select All, Bold, Paste…)
  if (fBefore && v.delivery === 'delivered_unverified') {
    const fAfter = observeState(focusEl.el, appEl);
    const d = diffState(fBefore, fAfter);
    if (d.verified) { v.delivery = 'delivered_verified'; v.changed = d.changed; }
  }
  if (!h.enabled && v.delivery !== 'delivered_verified') v.note = 'the item reported disabled (menus refresh that state lazily) and nothing observable changed';
  if (e === -25204) { v.delivery = 'unknown'; v.note = 'the app did not answer in time (a modal menu or dialog may be open)'; }
  return v;
}

// A named key (return, esc, tab, arrows, F-keys…) with optional modifiers, posted to the frontmost app at
// the HID level from a HID-state event source, the way a hardware keyboard sends it: each modifier pressed
// (a flags-changed event), the key down and up 20 ms apart, the modifiers released last-first. Chrome's
// address bar ignored cliclick 5.1's Return (0 of 2) and took these events (2 of 2) — iTerm2 Claude Code run
// 2026-11-06. Flags are always set explicitly: a key event that carries a modifier flag without the
// modifier's own press and release leaves the system believing it is still held (seen on the device run:
// Cmd after cmd-arrow-up, Shift after shift-tab). Navigation and F-keys carry the Fn flag, arrows the
// keypad flag, as hardware sends them. The server's focus guard runs before this op.
const KEY_FLAGS = { cmd: 0x100000, shift: 0x20000, alt: 0x80000, ctrl: 0x40000, fn: 0x800000 };
const MOD_KEYCODES = { cmd: 55, shift: 56, alt: 58, ctrl: 59 }; // left-hand keys; fn is a flag only (pressing Fn alone can switch input source)
const KEY_V = 9; // the V key position (ANSI); mac_paste's ⌘V — see vKeyIsElsewhere for layouts that move it
const FLAG_NUMPAD = 0x200000;
const HELD_MASK = KEY_FLAGS.cmd | KEY_FLAGS.shift | KEY_FLAGS.alt | KEY_FLAGS.ctrl;
const EV_FLAGS_CHANGED = 12;
function postKey(code, modKeys, extra) {
  const src = $.CGEventSourceCreate($.kCGEventSourceStateHIDSystemState);
  const ev = (k, down, flags, flagsChanged) => {
    const e = $.CGEventCreateKeyboardEvent(src, k, down);
    if (!e) return null;
    if (flagsChanged) $.CGEventSetType(e, EV_FLAGS_CHANGED);
    $.CGEventSetFlags(e, flags);
    return e;
  };
  let flags = 0, ok = true;
  const held = [];
  for (const [k, f] of modKeys) {
    const e = ev(k, true, flags | f, true);
    if (!e) { ok = false; break; }
    flags |= f; $.CGEventPost($.kCGHIDEventTap, e); held.push([k, f]); sleep(5);
  }
  if (ok) {
    const down = ev(code, true, flags | extra, false), up = ev(code, false, flags | extra, false);
    if (down && up) { $.CGEventPost($.kCGHIDEventTap, down); sleep(20); $.CGEventPost($.kCGHIDEventTap, up); }
    else ok = false;
  }
  for (const [k, f] of held.reverse()) {
    flags &= ~f;
    const e = ev(k, false, flags, true);
    if (e) $.CGEventPost($.kCGHIDEventTap, e);
    sleep(5);
  }
  return ok;
}
// The modifiers this call pressed that the system still believes held (CGEventSourceFlagsState, HID
// state) get one more release each; modifiers the user is holding on the keyboard are left alone.
// Returns the names still held after that (normally none).
function releaseStuckModifiers(names) {
  const mask = names.reduce((a, m) => a | KEY_FLAGS[m], 0) & HELD_MASK;
  const now = () => Number($.CGEventSourceFlagsState($.kCGEventSourceStateHIDSystemState)) & mask;
  if (!mask || !now()) return [];
  const src = $.CGEventSourceCreate($.kCGEventSourceStateHIDSystemState);
  for (const m of names) {
    if (!MOD_KEYCODES[m]) continue;
    const e = $.CGEventCreateKeyboardEvent(src, MOD_KEYCODES[m], false);
    if (!e) continue;
    $.CGEventSetType(e, EV_FLAGS_CHANGED); $.CGEventSetFlags(e, 0); $.CGEventPost($.kCGHIDEventTap, e);
  }
  sleep(30);
  const left = now();
  return names.filter(m => MOD_KEYCODES[m] && (left & KEY_FLAGS[m]));
}
function opKey(req) {
  const code = req.code;
  if (!Number.isInteger(code) || code < 0 || code > 127) return fail(notDelivered({ code: 'INVALID_ARGS', message: 'key: code must be an integer 0-127' }));
  const mods = Array.isArray(req.mods) ? req.mods : [];
  const modKeys = [];
  let extra = 0;
  for (const m of mods) {
    if (!Object.prototype.hasOwnProperty.call(KEY_FLAGS, m)) return fail(notDelivered({ code: 'INVALID_ARGS', message: `key: unknown modifier "${String(m).slice(0, 20)}"` }));
    if (m === 'fn') extra |= KEY_FLAGS.fn;
    else modKeys.push([MOD_KEYCODES[m], KEY_FLAGS[m]]);
  }
  if (req.fn_key === true) extra |= KEY_FLAGS.fn;
  if (req.numpad === true) extra |= FLAG_NUMPAD;
  const sent = postKey(code, modKeys, extra);
  const stuck = releaseStuckModifiers(mods.filter(m => m !== 'fn'));
  if (!sent) return fail(notDelivered({ code: 'ACTION_FAILED', message: 'key: could not create the keyboard events', details: stuck.length ? { modifiers_still_held: stuck } : undefined }));
  const out = { ok: true, delivery: 'delivered_unverified', retry: 'unsafe', flags: modKeys.reduce((a, [, f]) => a | f, 0) | extra };
  if (stuck.length) out.note = `the system still reports ${stuck.join('+')} held — press and release it on the keyboard`;
  return out;
}

const OPS = {
  key: opKey,
  snapshot: opSnapshot, find: opFind, get: opGet, apps: opApps, windows: opWindows, status: opStatus,
  act: opAct, physical_prep: opPhysicalPrep, observe_after: opObserveAfter, insert_text: opInsertText, set_value: opSetValue, scroll_prep: opScrollPrep,
  menu: opMenu, wait: opWait, frontmost: opFrontmost, app_info: opAppInfo, app_ctl: opAppCtl, app_wait: opAppWait, window_op: opWindowOp, clipboard: opClipboard, paste: opPaste, notifications: opNotifications,
};

function readStdin() {
  const d = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  return $.NSString.alloc.initWithDataEncoding(d, $.NSUTF8StringEncoding).js;
}

function run(argv) {
  let req;
  try { req = JSON.parse(readStdin()); } catch (e) { return JSON.stringify({ ok: false, code: 'INVALID_ARGS', message: 'request is not JSON' }); }
  const fn = OPS[req && req.op];
  if (!fn) return JSON.stringify({ ok: false, code: 'INVALID_ARGS', message: `unknown op "${req && req.op}"` });
  // the system-wide element's messaging timeout is this process's default for every element whose own
  // timeout is unset (children, parents, hit-test results): a hung app costs at most this per call
  try { $.AXUIElementSetMessagingTimeout($.AXUIElementCreateSystemWide(), AX_MSG_TIMEOUT_S); } catch (e) { /* keep the default */ }
  try { return JSON.stringify(fn(req)); } catch (e) { return JSON.stringify({ ok: false, code: 'INTERNAL', message: String(e).slice(0, 300) }); }
}

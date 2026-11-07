// CI-safe unit tests of the Mac accessibility engine's pure logic (src/mac-ax.js) — no macOS needed.
// The engine runs in node:vm with stub bridges and a fake accessibility tree (test/engine-harness.mjs).
// Run: node test/engine-unit.mjs
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadEngine, el, reparent, installApp, targetOf, makeChecker } from "./engine-harness.mjs";

const ENGINE = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "mac-ax.js");
const { check, done } = makeChecker();
const tag = (r) => (r.error ? `${r.error.code}/${r.error.details?.kind || ""}` : `${r.how} → ${r.el.label || r.el.role}`);
const snap = (ctx, req) => ctx.opSnapshot({ op: "snapshot", ...req });
const nodeAt = (res, pred) => res.nodes.find(pred);

// ── identity: anonymous elements ────────────────────────────────────────────────────────────────
{
  // form rows: label + unlabelled field; a row is inserted above → the old path now holds another row's
  // field at the very same position: it must not be taken for the target
  const ctx = loadEngine(ENGINE);
  const row = (name, y) => el("AXGroup", { frame: [0, y, 400, 26] }, [el("AXStaticText", { value: name, frame: [10, y, 80, 20] }), Object.assign(el("AXTextField", { value: "", frame: [100, y, 200, 22] }), { label: `${name} field` })]);
  const form = el("AXGroup", { frame: [0, 0, 400, 200] }, [row("First", 10), row("Second", 40), row("Third", 70)]);
  const win = el("AXWindow", { title: "Form", frame: [0, 0, 400, 300], wid: 7 }, [form]);
  installApp(ctx, { pid: 42, name: "T", windows: [win] });
  const res = snap(ctx, { app: "T" });
  const third = nodeAt(res, (n) => n.role === "AXTextField" && n.frame[1] === 70);
  const t = targetOf(res, third);
  check("engine: snapshot of an unlabelled field records its path shape", JSON.stringify(third.fp.shape) === "[1,3,2]" && third.fp.vh === undefined, JSON.stringify(third.fp));
  check("engine: unchanged form → field resolves by path", tag(ctx.resolveTarget(t, 1000)) === "path → Third field", tag(ctx.resolveTarget(t, 1000)));
  form.kids.unshift(row("Zero", 10));
  form.kids.forEach((r, i) => { const y = 10 + 30 * i; r.frame[1] = y; r.kids[0].frame[1] = y; r.kids[1].frame[1] = y; });
  reparent(form);
  const r = ctx.resolveTarget(t, 1000);
  check("engine: row inserted above an unlabelled field → never the neighbour (G1-1)", r.error && r.error.code === "STALE_REF", tag(r));
}
{
  // the whole window moved: an unlabelled field is still the same field
  const ctx = loadEngine(ENGINE);
  const f = Object.assign(el("AXTextField", { value: "abc", frame: [110, 60, 200, 22] }), { label: "field" });
  const win = el("AXWindow", { title: "W", frame: [100, 50, 400, 300], wid: 8 }, [el("AXGroup", { frame: [100, 50, 400, 300] }, [f])]);
  installApp(ctx, { pid: 43, name: "T", windows: [win] });
  const res = snap(ctx, { app: "T" });
  const t = targetOf(res, nodeAt(res, (n) => n.role === "AXTextField"));
  const shift = (e) => { if (e.frame) { e.frame[0] += 300; e.frame[1] += 200; } (e.kids || []).forEach(shift); };
  shift(win);
  check("engine: window dragged → unlabelled field still resolves (frames compared relative to the window)", tag(ctx.resolveTarget(t, 1000)) === "path → field", tag(ctx.resolveTarget(t, 1000)));
  f.value = "changed by the user";
  check("engine: content is not identity — a field whose value changed still resolves (mac_get reads it)", tag(ctx.resolveTarget(t, 1000)) === "path → field", tag(ctx.resolveTarget(t, 1000)));
  // identical, empty, unlabelled siblings: one inserted above changes the parent's child count
  const g = win.kids[0];
  g.kids.unshift(Object.assign(el("AXTextField", { value: "", frame: [410, 260, 200, 22] }), { label: "new field" }));
  reparent(g);
  const r = ctx.resolveTarget(t, 1000);
  check("engine: a sibling inserted next to an unlabelled field → stale (path shape changed)", r.error && r.error.code === "STALE_REF", tag(r));
}
{
  // the panel holding the target closed; another unlabelled field remains elsewhere (G1-1 search step)
  const ctx = loadEngine(ENGINE);
  const a = Object.assign(el("AXTextField", { frame: [10, 10, 200, 22] }), { label: "A" });
  const b = Object.assign(el("AXTextField", { frame: [10, 400, 200, 22] }), { label: "B" });
  const win = el("AXWindow", { title: "Two", frame: [0, 0, 500, 500], wid: 9 }, [el("AXGroup", { desc: "left" }, [a]), el("AXGroup", { desc: "right" }, [b])]);
  installApp(ctx, { pid: 44, name: "T", windows: [win] });
  const res = snap(ctx, { app: "T" });
  const t = targetOf(res, nodeAt(res, (n) => n.role === "AXTextField" && n.frame[1] === 400));
  win.kids.splice(1, 1);
  const r = ctx.resolveTarget(t, 1000);
  check("engine: target's panel closed → stale, not the other panel's field (G1-1)", r.error && r.error.code === "STALE_REF", tag(r));
}

// ── identity: named elements ────────────────────────────────────────────────────────────────────
{
  // two panels with a "Delete" button each; the panels swap places → each Delete is still its own
  const ctx = loadEngine(ENGINE);
  const del = (who, x) => Object.assign(el("AXButton", { title: "Delete", frame: [x, 20, 60, 20], actions: ["AXPress"] }), { label: `${who} Delete` });
  const left = el("AXGroup", { desc: "Inbox", frame: [0, 0, 250, 400] }, [del("Inbox", 10)]);
  const right = el("AXGroup", { desc: "Trash", frame: [250, 0, 250, 400] }, [del("Trash", 260)]);
  const win = el("AXWindow", { title: "Mail", frame: [0, 0, 500, 400], wid: 10 }, [left, right]);
  installApp(ctx, { pid: 45, name: "T", windows: [win] });
  const res = snap(ctx, { app: "T" });
  const t = targetOf(res, nodeAt(res, (n) => n.role === "AXButton" && n.frame[0] === 260));
  win.kids.reverse();
  left.frame[0] = 250; left.kids[0].frame[0] = 260; right.frame[0] = 0; right.kids[0].frame[0] = 10;
  reparent(win);
  const r = ctx.resolveTarget(t, 1000);
  check("engine: panels swapped → never the Inbox Delete now at the Trash Delete's old place", (r.error && r.error.code === "STALE_REF") || r.el?.label === "Trash Delete", tag(r));
}
{
  // the panel holding the target closed; the other panel's same-named button must not be taken (R11 #5a)
  const ctx = loadEngine(ENGINE);
  const del = (who, x) => Object.assign(el("AXButton", { title: "Delete", frame: [x, 20, 60, 20], actions: ["AXPress"] }), { label: `${who} Delete` });
  const win = el("AXWindow", { title: "Mail", frame: [0, 0, 500, 400], wid: 20 }, [el("AXGroup", { desc: "Inbox" }, [del("Inbox", 10)]), el("AXGroup", { desc: "Trash" }, [del("Trash", 260)])]);
  installApp(ctx, { pid: 60, name: "T", windows: [win] });
  const res = snap(ctx, { app: "T" });
  const t = targetOf(res, nodeAt(res, (n) => n.role === "AXButton" && n.frame[0] === 260));
  win.kids.splice(1, 1);
  const r = ctx.resolveTarget(t, 1000);
  check("engine: target panel closed → stale, never the other panel's same-named button (R11)", r.error && r.error.code === "STALE_REF", tag(r));
}
{
  // a list sorted (or recycled) under a stale index: another row's Delete sits at the same place
  const ctx = loadEngine(ENGINE);
  const row = (name, y) => el("AXRow", { frame: [0, y, 400, 24] }, [el("AXCell", {}, [el("AXStaticText", { value: name })]), el("AXCell", {}, [Object.assign(el("AXButton", { title: "Delete", frame: [300, y, 60, 20], actions: ["AXPress"] }), { label: `${name} Delete` })])]);
  const table = el("AXTable", { frame: [0, 0, 400, 300] }, [row("Alpha", 0), row("Beta", 30), row("Gamma", 60)]);
  const win = el("AXWindow", { title: "List", frame: [0, 0, 400, 300], wid: 21 }, [table]);
  installApp(ctx, { pid: 61, name: "T", windows: [win] });
  const res = snap(ctx, { app: "T" });
  const beta = nodeAt(res, (n) => n.role === "AXButton" && n.frame[1] === 30);
  check("engine: a duplicated control records its item's texts", beta.fp.dup === true && /^2:Beta$/.test(beta.fp.item), JSON.stringify(beta.fp));
  const t = targetOf(res, beta);
  table.kids = [row("Gamma", 0), row("Alpha", 30), row("Beta", 60)];
  reparent(table);
  const r = ctx.resolveTarget(t, 1000);
  check("engine: list re-sorted → never another row's Delete at the same place", (r.error && r.error.code === "STALE_REF") || r.el?.label === "Beta Delete", tag(r));
}
{
  // a same-named control replaced far away in the same panel (R11 #5b)
  const ctx = loadEngine(ENGINE);
  const msg = (n, y) => Object.assign(el("AXButton", { title: "Delete", frame: [300, y, 60, 20], actions: ["AXPress"] }), { label: `msg ${n} Delete` });
  const thread = el("AXGroup", { desc: "Thread" }, [msg(1, 120)]);
  const win = el("AXWindow", { title: "Chat", frame: [0, 0, 500, 600], wid: 22 }, [thread]);
  installApp(ctx, { pid: 62, name: "T", windows: [win] });
  const res = snap(ctx, { app: "T" });
  const t = targetOf(res, nodeAt(res, (n) => n.role === "AXButton"));
  thread.kids = [el("AXGroup", {}, []), msg(3, 480)]; reparent(thread);
  const r = ctx.resolveTarget(t, 1000);
  check("engine: same-named control replaced far away in the same panel → stale (R11)", r.error && r.error.code === "STALE_REF", tag(r));
}
{
  // a named button moved far after a window resize → found by its unique label
  const ctx = loadEngine(ENGINE);
  const ok = Object.assign(el("AXButton", { title: "OK", frame: [300, 250, 60, 20], actions: ["AXPress"] }), { label: "OK" });
  const win = el("AXWindow", { title: "D", frame: [0, 0, 400, 300], wid: 11 }, [el("AXGroup", {}, [ok])]);
  installApp(ctx, { pid: 46, name: "T", windows: [win] });
  const res = snap(ctx, { app: "T" });
  const t = targetOf(res, nodeAt(res, (n) => n.role === "AXButton"));
  win.kids.unshift(el("AXGroup", {}, [])); reparent(win);
  ok.frame[0] = 340;
  check("engine: named button nudged (≤64 px) with its path changed → resolves", tag(ctx.resolveTarget(t, 1000)) === "search+frame → OK", tag(ctx.resolveTarget(t, 1000)));
  win.frame[2] = 900; ok.frame[0] = 800;
  const r = ctx.resolveTarget(t, 1000);
  check("engine: named button re-laid-out far away → stale, not guessed (R11 rule)", r.error && r.error.code === "STALE_REF", tag(r));
}
{
  // a label is not content: a text field keeps its placeholder label while its value changes
  const ctx = loadEngine(ENGINE);
  const f = Object.assign(el("AXTextField", { placeholder: "Email", value: "", frame: [10, 10, 200, 22] }), { label: "Email field" });
  const win = el("AXWindow", { title: "Sign up", frame: [0, 0, 400, 300], wid: 12 }, [f]);
  installApp(ctx, { pid: 47, name: "T", windows: [win] });
  const res = snap(ctx, { app: "T" });
  const n = nodeAt(res, (x) => x.role === "AXTextField");
  f.value = "a@b.c";
  check("engine: text field named by its placeholder, value change does not break it", n.fp.name === "Email" && tag(ctx.resolveTarget(targetOf(res, n), 1000)) === "path → Email field", `${n.fp.name} ${tag(ctx.resolveTarget(targetOf(res, n), 1000))}`);
}
{
  // deep web content: a named control far below physical depth 40 is still found after its path changed
  const ctx = loadEngine(ENGINE);
  let leaf = Object.assign(el("AXButton", { title: "Send", frame: [10, 10, 50, 20], actions: ["AXPress"] }), { label: "Send" });
  let node = leaf;
  for (let i = 0; i < 60; i++) node = el("AXGroup", {}, [node]);
  const web = el("AXWebArea", { title: "page" }, [node]);
  const win = el("AXWindow", { title: "App", frame: [0, 0, 400, 300], wid: 13 }, [web]);
  installApp(ctx, { pid: 48, name: "T", windows: [win] });
  const res = snap(ctx, { app: "T", depth: 40 });
  const n = nodeAt(res, (x) => x.role === "AXButton");
  web.kids.unshift(el("AXGroup", {}, [])); reparent(web);
  const r = n ? ctx.resolveTarget(targetOf(res, n), 2000) : { error: { code: "NOT_IN_SNAPSHOT" } };
  check("engine: control 60 wrappers deep re-found after its path shifted (G1-2 / G9-3)", !r.error && r.el.label === "Send", tag(r));
}

{
  // panes share an AXIdentifier (one nib / component per pane); the target pane closes (R12 #1)
  const ctx = loadEngine(ENGINE);
  const pane = (name, x) => el("AXGroup", { desc: name }, [Object.assign(el("AXButton", { id: "del", title: "Delete", frame: [x, 20, 60, 22], actions: ["AXPress"] }), { label: `${name} Delete` })]);
  const win = el("AXWindow", { title: "W", frame: [0, 0, 400, 200], wid: 24 }, [pane("Inbox", 10), pane("Trash", 260)]);
  installApp(ctx, { pid: 64, name: "T", windows: [win] });
  const res = snap(ctx, { app: "T" });
  const t = targetOf(res, nodeAt(res, (n) => n.role === "AXButton" && n.frame[0] === 260));
  win.kids.splice(1, 1);
  const r = ctx.resolveTarget(t, 1000);
  check("engine: shared AXIdentifier, target pane closed → stale, never the other pane's button (R12)", r.error && r.error.code === "STALE_REF", tag(r));
}
{
  // rows whose first text is a shared badge and whose title is a link (R12 #2); the table is re-sorted
  const ctx = loadEngine(ENGINE);
  const tr = (badge, title, y) => el("AXRow", { frame: [0, y, 400, 28] }, [el("AXStaticText", { value: badge }), el("AXLink", { title }), Object.assign(el("AXButton", { title: "Delete", frame: [320, y, 60, 22], actions: ["AXPress"] }), { label: `${title} Delete` })]);
  const tbl = el("AXTable", {}, [tr("Open", "Draft", 0), tr("Open", "Prod DB", 28)]);
  const win = el("AXWindow", { title: "Issues", frame: [0, 0, 400, 200], wid: 25 }, [tbl]);
  installApp(ctx, { pid: 65, name: "T", windows: [win] });
  const res = snap(ctx, { app: "T" });
  const t = targetOf(res, nodeAt(res, (n) => n.role === "AXButton" && n.frame[1] === 0));
  tbl.kids = [tr("Open", "Prod DB", 0), tr("Open", "Draft", 28)]; reparent(tbl);
  const r = ctx.resolveTarget(t, 1000);
  check("engine: re-sorted rows with a shared badge → the Draft row's Delete, never Prod DB's (R12)", !r.error && r.el.label === "Draft Delete", tag(r));
}
{
  // a list of AXGroup items (no AXRow), 28 px apart; the first item is deleted (R12 #3)
  const ctx = loadEngine(ENGINE);
  const item = (title, y) => el("AXGroup", { frame: [0, y, 400, 28] }, [el("AXStaticText", { value: title }), Object.assign(el("AXButton", { title: "Delete", frame: [320, y, 60, 22], actions: ["AXPress"] }), { label: `${title} Delete` })]);
  const list = el("AXGroup", {}, [item("one", 0), item("two", 28), item("three", 56)]);
  const win = el("AXWindow", { title: "Feed", frame: [0, 0, 400, 200], wid: 26 }, [list]);
  installApp(ctx, { pid: 66, name: "T", windows: [win] });
  const res = snap(ctx, { app: "T" });
  const t = targetOf(res, nodeAt(res, (n) => n.role === "AXButton" && n.frame[1] === 28));
  list.kids = [item("two", 0), item("three", 28)]; reparent(list);
  const r = ctx.resolveTarget(t, 1000);
  check("engine: list item above deleted → item two's Delete (moved up), never item three's (R12)", !r.error && r.el.label === "two Delete", tag(r));
}
{
  // a row as the target itself: its own texts identify it
  const ctx = loadEngine(ENGINE);
  const row = (name, y) => Object.assign(el("AXRow", { frame: [0, y, 300, 20] }, [el("AXCell", {}, [el("AXStaticText", { value: name })])]), { label: `${name} row` });
  const outline = el("AXOutline", {}, [row("a.txt", 0), row("b.txt", 20)]);
  const win = el("AXWindow", { title: "Finder", frame: [0, 0, 300, 200], wid: 27 }, [outline]);
  installApp(ctx, { pid: 67, name: "T", windows: [win] });
  const res = snap(ctx, { app: "T" });
  const t = targetOf(res, nodeAt(res, (n) => n.role === "AXRow" && n.frame[1] === 20));
  check("engine: a row target uses its own texts as item key", t.fp.item === "0:b.txt", JSON.stringify(t.fp));
  outline.kids = [row("b.txt", 0), row("a.txt", 20)]; reparent(outline);
  const r = ctx.resolveTarget(t, 1000);
  check("engine: rows re-sorted → the b.txt row is never taken for a.txt", (r.error && r.error.code === "STALE_REF") || r.el?.label === "b.txt row", tag(r));
}

// ── identity: look-alikes that appear after the snapshot (R13 §1) ──────────────────────────────
{
  // (1) newest-first feed with a single item; a second item arrives on top → the old path now holds the
  // new item's Delete at the very same position
  const ctx = loadEngine(ENGINE);
  const item = (title, y) => el("AXGroup", { frame: [0, y, 400, 28] }, [el("AXStaticText", { value: title }), Object.assign(el("AXButton", { title: "Delete", frame: [320, y, 60, 22], actions: ["AXPress"] }), { label: `${title} Delete` })]);
  const feed = el("AXGroup", {}, [item("Draft", 0)]);
  const win = el("AXWindow", { title: "Inbox", frame: [0, 0, 400, 200], wid: 81 }, [feed]);
  installApp(ctx, { pid: 81, name: "T", windows: [win] });
  const res = snap(ctx, { app: "T" });
  const t = targetOf(res, nodeAt(res, (n) => n.role === "AXButton"));
  check("engine: a unique labelled control still records its item key (R13)", !t.fp.dup && t.fp.item === "1:Draft", JSON.stringify(t.fp));
  feed.kids = [item("Prod DB", 0), item("Draft", 28)]; reparent(feed);
  const r = ctx.resolveTarget(t, 1000);
  check("engine: a look-alike arrives on top of a one-item list → Draft's Delete, never Prod DB's (R13 §1-1)", !r.error && r.el.label === "Draft Delete", tag(r));
  // same slot, the old item gone and a different one in its place → stale, not the new item's Delete
  feed.kids = [item("Prod DB", 0)]; reparent(feed);
  const r2 = ctx.resolveTarget(t, 1000);
  check("engine: the only item replaced by another one in the same place → stale (R13 §1)", r2.error && r2.error.code === "STALE_REF", tag(r2));
}
{
  // (2) snapshot drilled into one row of a table: uniqueness is unknown → the row's Delete is treated as a
  // look-alike; re-sorting puts Prod DB into that row
  const ctx = loadEngine(ENGINE);
  const tr = (name, y) => el("AXRow", { frame: [0, y, 400, 28] }, [el("AXCell", {}, [el("AXStaticText", { value: name })]), el("AXCell", {}, [Object.assign(el("AXButton", { title: "Delete", frame: [320, y, 60, 22], actions: ["AXPress"] }), { label: `${name} Delete` })])]);
  const tbl = el("AXTable", {}, [tr("Draft", 0), tr("Prod DB", 28), tr("Notes", 56)]);
  const win = el("AXWindow", { title: "DBs", frame: [0, 0, 400, 200], wid: 82 }, [tbl]);
  installApp(ctx, { pid: 82, name: "T", windows: [win] });
  const top = snap(ctx, { app: "T" });
  const row0 = nodeAt(top, (n) => n.role === "AXRow" && n.frame[1] === 0);
  const d = ctx.opSnapshot({ op: "snapshot", root: targetOf(top, row0) });
  const t = targetOf(d, nodeAt(d, (n) => n.role === "AXButton"));
  check("engine: a drilled snapshot marks its elements as look-alikes (R13 §1-2)", t.fp.dup === true && /Draft/.test(t.fp.item || ""), JSON.stringify(t.fp));
  tbl.kids = [tr("Prod DB", 0), tr("Draft", 28), tr("Notes", 56)]; reparent(tbl);
  const r = ctx.resolveTarget(t, 1000);
  check("engine: drilled row re-sorted → Draft's Delete, never Prod DB's (R13 §1-2)", !r.error && r.el.label === "Draft Delete", tag(r));
}
{
  // (3) mac_find filtered by value: the other look-alike was visited, not shown → still a look-alike
  const ctx = loadEngine(ENGINE);
  const tr = (file, y) => el("AXRow", { frame: [0, y, 400, 22] }, [el("AXCell", {}, [Object.assign(el("AXTextField", { desc: "Name", value: file, frame: [10, y, 200, 20] }), { label: `${file} field` })])]);
  const outline = el("AXOutline", {}, [tr("draft.txt", 0), tr("prod.db", 22)]);
  const win = el("AXWindow", { title: "Files", frame: [0, 0, 400, 200], wid: 83 }, [outline]);
  installApp(ctx, { pid: 83, name: "T", windows: [win] });
  const f = ctx.opFind({ op: "find", app: "T", role: "textfield", value: "draft.txt" });
  const t = targetOf(f, f.nodes[0]);
  check("engine: a filtered find knows the field has a look-alike it did not show (R13 §1-3)", f.nodes.length === 1 && t.fp.dup === true && t.fp.item === "1:draft.txt", JSON.stringify(t.fp));
  outline.kids = [tr("prod.db", 0), tr("draft.txt", 22)]; reparent(outline);
  const r = ctx.resolveTarget(t, 1000);
  check("engine: rows re-sorted after a filtered find → the draft.txt field, never prod.db's (R13 §1-3)", !r.error && r.el.label === "draft.txt field", tag(r));
}
{
  // no false stale: typing into a form field does not change the identity of the Save button next to it
  const ctx = loadEngine(ENGINE);
  const field = Object.assign(el("AXTextField", { value: "", frame: [100, 10, 200, 22] }), { label: "name field" });
  const save = Object.assign(el("AXButton", { title: "Save", frame: [100, 40, 60, 22], actions: ["AXPress"] }), { label: "Save" });
  const form = el("AXGroup", { frame: [0, 0, 400, 80] }, [el("AXStaticText", { value: "Name" }), field, save]);
  const win = el("AXWindow", { title: "Form", frame: [0, 0, 400, 200], wid: 84 }, [form]);
  installApp(ctx, { pid: 84, name: "T", windows: [win] });
  const res = snap(ctx, { app: "T" });
  const t = targetOf(res, nodeAt(res, (n) => n.role === "AXButton"));
  field.value = "typed by mac_type";
  const r = ctx.resolveTarget(t, 1000);
  check("engine: a form field's value is not part of the Save button's item key (R13 §1-③)", t.fp.item === "1:Name" && !r.error && r.el.label === "Save", `${t.fp.item} ${tag(r)}`);
  // the window's own texts are never an item: a status line that changes does not make a toolbar button stale
  const ctx2 = loadEngine(ENGINE);
  const status = el("AXStaticText", { value: "Line 1" });
  const bold = Object.assign(el("AXButton", { title: "Bold", frame: [10, 10, 30, 22], actions: ["AXPress"] }), { label: "Bold" });
  const win2 = el("AXWindow", { title: "Doc", frame: [0, 0, 400, 200], wid: 85 }, [status, bold]);
  installApp(ctx2, { pid: 85, name: "T", windows: [win2] });
  const res2 = snap(ctx2, { app: "T" });
  const t2 = targetOf(res2, nodeAt(res2, (n) => n.role === "AXButton"));
  status.value = "Line 7";
  const r2 = ctx2.resolveTarget(t2, 1000);
  check("engine: the container is never an item ancestor (R13 §1-④)", t2.fp.item === undefined && !r2.error, `${t2.fp.item} ${tag(r2)}`);
}

// ── identity v6 (R14 §1) ───────────────────────────────────────────────────────────────────────
{
  // (a)1 form rows whose only text is a field value (not table content): both Remove buttons climb to the
  // section heading → that shared item tells nothing apart; removing b's row must not send b's index to a's
  const ctx = loadEngine(ENGINE);
  const row = (v, x) => el("AXGroup", { frame: [x, 30, 220, 28] }, [el("AXTextField", { value: v, frame: [x, 30, 140, 22] }), Object.assign(el("AXButton", { title: "Remove", frame: [x + 150, 30, 60, 22], actions: ["AXPress"] }), { label: `rm ${v}` })]);
  const sec = el("AXGroup", { frame: [0, 0, 600, 80] }, [el("AXStaticText", { value: "Invitees" }), row("a@x.com", 10), row("b@x.com", 260)]);
  const win = el("AXWindow", { title: "Invite", frame: [0, 0, 600, 200], wid: 91 }, [sec]);
  installApp(ctx, { pid: 91, name: "T", windows: [win] });
  const res = snap(ctx, { app: "T" });
  const t = targetOf(res, nodeAt(res, (n) => n.role === "AXButton" && n.frame[0] === 410));
  check("engine: an item key shared by look-alikes is dropped (R14 §1a-1)", t.fp.dup === true && t.fp.item === undefined, JSON.stringify(t.fp));
  sec.kids.splice(2, 1); reparent(sec);
  const r = ctx.resolveTarget(t, 1000);
  check("engine: b's row removed → b's Remove index is stale, never a's Remove (R14 §1a-1)", r.error && r.error.code === "STALE_REF", tag(r));
}
{
  // (a)2 a one-card list without any text; a second card arrives on top at the very same place
  const ctx = loadEngine(ENGINE);
  const card = (name, y) => el("AXGroup", { frame: [0, y, 300, 40] }, [el("AXImage", { frame: [0, y, 40, 40] }), Object.assign(el("AXButton", { title: "Remove", frame: [250, y, 50, 22], actions: ["AXPress"] }), { label: `${name} Remove` })]);
  const list = el("AXGroup", { frame: [0, 0, 300, 200] }, [card("first", 0)]);
  const win = el("AXWindow", { title: "Attachments", frame: [0, 0, 300, 200], wid: 92 }, [list]);
  installApp(ctx, { pid: 92, name: "T", windows: [win] });
  const res = snap(ctx, { app: "T" });
  const t = targetOf(res, nodeAt(res, (n) => n.role === "AXButton"));
  list.kids = [card("new", 0), card("first", 40)]; reparent(list);
  const r = ctx.resolveTarget(t, 1000);
  check("engine: a textless card arrives on top of the only one → never the new card's Remove (R14 §1a-2)", (r.error && /STALE_REF|AMBIGUOUS_TARGET/.test(r.error.code)) || r.el?.label === "first Remove", tag(r));
}
{
  // (b) a character counter next to the Send button changes while typing: Send stays valid; so does a
  // toolbar button next to a status word (toolbars are never items)
  const ctx = loadEngine(ENGINE);
  const counter = el("AXStaticText", { value: "0/280" });
  const send = Object.assign(el("AXButton", { title: "Send", frame: [300, 10, 60, 22], actions: ["AXPress"] }), { label: "Send" });
  const box = el("AXGroup", { frame: [0, 0, 400, 60] }, [el("AXTextArea", { value: "", frame: [0, 0, 280, 40] }), counter, send]);
  const status = el("AXStaticText", { value: "Saved" });
  const run = Object.assign(el("AXButton", { title: "Run", frame: [10, 100, 40, 22], actions: ["AXPress"] }), { label: "Run" });
  const bar = el("AXToolbar", { frame: [0, 90, 400, 40] }, [status, run]);
  const win = el("AXWindow", { title: "Compose", frame: [0, 0, 400, 200], wid: 93 }, [box, bar]);
  installApp(ctx, { pid: 93, name: "T", windows: [win] });
  const res = snap(ctx, { app: "T" });
  const tSend = targetOf(res, nodeAt(res, (n) => n.title === "Send"));
  const tRun = targetOf(res, nodeAt(res, (n) => n.title === "Run"));
  counter.value = "12/280"; status.value = "Edited";
  const r1 = ctx.resolveTarget(tSend, 1000), r2 = ctx.resolveTarget(tRun, 1000);
  check("engine: a counter in the item does not make a unique Send stale; a toolbar is never an item (R14 §1b)", !r1.error && r1.el.label === "Send" && !r2.error && r2.el.label === "Run" && tRun.fp.item === undefined, `${tag(r1)} ${tag(r2)} ${tRun.fp.item}`);
}
{
  // (c) view-based table: AXRow > AXCell > AXGroup > AXTextField — the file name still identifies the row
  const ctx = loadEngine(ENGINE);
  const tr = (file, y) => el("AXRow", { frame: [0, y, 400, 22] }, [el("AXCell", {}, [el("AXGroup", {}, [el("AXTextField", { value: file }), Object.assign(el("AXButton", { title: "Share", frame: [300, y, 40, 20], actions: ["AXPress"] }), { label: `${file} Share` })])])]);
  const outline = el("AXOutline", {}, [tr("draft.txt", 0), tr("prod.db", 22)]);
  const win = el("AXWindow", { title: "Files", frame: [0, 0, 400, 200], wid: 94 }, [outline]);
  installApp(ctx, { pid: 94, name: "T", windows: [win] });
  const res = snap(ctx, { app: "T" });
  const t = targetOf(res, nodeAt(res, (n) => n.role === "AXButton" && n.frame[1] === 0));
  check("engine: a field value under a cell several levels up is item text (R14 §1c)", t.fp.item === "2:draft.txt", JSON.stringify(t.fp));
  outline.kids = [tr("prod.db", 0), tr("draft.txt", 22)]; reparent(outline);
  const r = ctx.resolveTarget(t, 1000);
  check("engine: view-based rows re-sorted → draft.txt's Share, never prod.db's (R14 §1c)", !r.error && r.el.label === "draft.txt Share", tag(r));
}

{
  // R15 §2: a unique Delete in a one-row list; "Invoice 13" is prepended above "Invoice 12" — digits are
  // ignored for a unique element's item, so the shape must still hold for the path to be taken
  const ctx = loadEngine(ENGINE);
  const row = (name, y) => el("AXGroup", { frame: [0, y, 400, 28] }, [el("AXStaticText", { value: name }), Object.assign(el("AXButton", { title: "Delete", frame: [320, y, 60, 22], actions: ["AXPress"] }), { label: `${name} Delete` })]);
  const list = el("AXList", { frame: [0, 0, 400, 200] }, [row("Invoice 12", 0)]);
  const win = el("AXWindow", { title: "Billing", frame: [0, 0, 400, 200], wid: 95 }, [list]);
  installApp(ctx, { pid: 95, name: "T", windows: [win] });
  const res = snap(ctx, { app: "T" });
  const t = targetOf(res, nodeAt(res, (n) => n.role === "AXButton"));
  list.kids = [row("Invoice 13", 0), row("Invoice 12", 28)]; reparent(list);
  const r = ctx.resolveTarget(t, 1000);
  check("engine: \"Invoice 13\" prepended above the only \"Invoice 12\" → never Invoice 13's Delete (R15 §2)", (r.error && /STALE_REF|AMBIGUOUS_TARGET/.test(r.error.code)) || r.el?.label === "Invoice 12 Delete", tag(r));
  // the same row, its counter changing in place (shape unchanged): still resolves
  list.kids = [row("Invoice 12 (2 items)", 0)]; reparent(list);
  const t2 = targetOf(snap(ctx, { app: "T" }), nodeAt(snap(ctx, { app: "T" }), (n) => n.role === "AXButton"));
  list.kids[0].kids[0].value = "Invoice 12 (3 items)";
  const r2 = ctx.resolveTarget(t2, 1000);
  check("engine: a digit changing in place in a unique element's item does not make it stale (R15 §2)", !r2.error && r2.el.label === "Invoice 12 (2 items) Delete", tag(r2));
}

// ── containers ──────────────────────────────────────────────────────────────────────────────────
{
  // a pop-up menu item: when the menu closes, the reference is stale — never the menu bar item of the same name
  const ctx = loadEngine(ENGINE);
  const popItem = Object.assign(el("AXMenuItem", { title: "Delete", frame: [100, 100, 120, 20], actions: ["AXPress"] }), { label: "popup Delete" });
  const popup = el("AXMenu", { frame: [100, 100, 120, 60] }, [popItem]);
  const barItem = Object.assign(el("AXMenuItem", { title: "Delete", actions: ["AXPress"] }), { label: "Edit > Delete" });
  const menubar = el("AXMenuBar", {}, [el("AXMenuBarItem", { title: "Edit" }, [el("AXMenu", {}, [barItem])])]);
  const win = el("AXWindow", { title: "Doc", frame: [0, 0, 600, 400], wid: 14 }, [popup]);
  installApp(ctx, { pid: 49, name: "T", windows: [win], menubar });
  const res = snap(ctx, { app: "T", surface: "menu" });
  const n = nodeAt(res, (x) => x.role === "AXMenuItem");
  const t = targetOf(res, n);
  check("engine: surface menu is its own container (kind menu, by frame)", res.container.kind === "menu" && tag(ctx.resolveTarget(t, 1000)) === "path → popup Delete", `${JSON.stringify(res.container)} ${tag(ctx.resolveTarget(t, 1000))}`);
  win.kids = []; popItem.gone = true;
  const r = ctx.resolveTarget(t, 1000);
  check("engine: pop-up closed → stale (menu_closed), never Edit > Delete (G1-5)", r.error && r.error.details.kind === "menu_closed", tag(r));
  const tApp = { pid: 49, container: { kind: "app" }, path: [9, 0], fp: { role: "AXMenuItem", subrole: "", id: "", name: "Delete" } };
  const r2 = ctx.resolveTarget(tApp, 1000);
  check("engine: app-container search skips the menu bar (G1-5)", r2.error && r2.error.code === "STALE_REF", tag(r2));
}
{
  // window without a CGWindowID: a moved window is not "the same" by title alone
  const ctx = loadEngine(ENGINE);
  const b = Object.assign(el("AXButton", { title: "Go", frame: [10, 10, 40, 20], actions: ["AXPress"] }), { label: "Go" });
  const w1 = el("AXWindow", { title: "Untitled", frame: [0, 0, 300, 200] }, [b]);
  const w2 = el("AXWindow", { title: "Untitled", frame: [1920, 0, 300, 200] }, [Object.assign(el("AXButton", { title: "Go", frame: [1930, 10, 40, 20], actions: ["AXPress"] }), { label: "other Go" })]);
  installApp(ctx, { pid: 50, name: "T", windows: [w1, w2] });
  const res = snap(ctx, { app: "T", window: 0 });
  const t = targetOf(res, nodeAt(res, (x) => x.role === "AXButton"));
  const open = ctx.resolveTarget(t, 1000);
  w1.gone = true;
  const r = ctx.resolveTarget(t, 1000);
  // 0.2.2: a window without an id is refused outright (a closed and reopened one could not be told
  // apart), so the closed window is never taken for the other "Untitled" either
  check("engine: id-less window → policy_denied window_unverifiable, open or closed, never the other \"Untitled\" (G1-7, 0.2.2)",
    res.window_identity === "unverifiable" && open.error && open.error.code === "POLICY_DENIED" && open.error.details.kind === "window_unverifiable"
      && r.error && r.error.code === "POLICY_DENIED" && !r.el, `${tag(open)} | ${tag(r)}`);
}
{
  // drill after siblings shifted: children are numbered from the root's live path
  const ctx = loadEngine(ENGINE);
  const inbox = el("AXGroup", { id: "inbox", frame: [0, 30, 300, 300] }, [Object.assign(el("AXRow", { frame: [0, 30, 300, 20], value: "msg 1" }), { label: "inbox row" })]);
  const trash = el("AXGroup", { id: "trash", frame: [300, 30, 300, 300] }, [Object.assign(el("AXRow", { frame: [300, 30, 300, 20], value: "junk" }), { label: "trash row" })]);
  const win = el("AXWindow", { title: "Mail", frame: [0, 0, 600, 400], wid: 15 }, [trash, inbox]);
  installApp(ctx, { pid: 51, name: "T", windows: [win] });
  const res = snap(ctx, { app: "T", skeleton: true });
  const ib = nodeAt(res, (x) => x.fp.id === "inbox");
  win.kids.unshift(el("AXGroup", { desc: "banner", frame: [0, 0, 600, 30] }, [])); reparent(win);
  const d = ctx.opSnapshot({ op: "snapshot", root: targetOf(res, ib) });
  const rowNode = d.nodes && d.nodes.find((x) => x.role === "AXRow");
  const r = rowNode ? ctx.resolveTarget({ pid: 51, container: d.container, path: rowNode.path, fp: rowNode.fp }, 1000) : { error: { code: "NO_ROW" } };
  check("engine: drill uses the root's live path (G1-3)", JSON.stringify(d.root_path) === "[2]" && !r.error && r.el.label === "inbox row", `${JSON.stringify(d.root_path)} ${tag(r)}`);
}
{
  // window_id without app: the window's owner is the app
  const ctx = loadEngine(ENGINE);
  const win = el("AXWindow", { title: "Bg", frame: [0, 0, 300, 200], wid: 77 }, [el("AXButton", { title: "X", actions: ["AXPress"] })]);
  installApp(ctx, { pid: 52, name: "Bg", windows: [win], frontPid: 1 });
  ctx.cgWindow = (id) => (id === 77 ? { id, pid: 52, app: "Bg", title: "Bg", bounds: [0, 0, 300, 200] } : null);
  const res = snap(ctx, { window_id: 77 });
  check("engine: window_id alone selects its owner app (G1-7)", res.ok && res.pid === 52 && res.window.window_id === 77, JSON.stringify({ ok: res.ok, pid: res.pid, code: res.code }));
}
{
  // a hung root is not an empty, complete tree
  const ctx = loadEngine(ENGINE);
  const win = el("AXWindow", { title: "Hung", frame: [0, 0, 300, 200], wid: 16 }, []);
  installApp(ctx, { pid: 53, name: "T", windows: [win] });
  win.hung = true;
  const res = snap(ctx, { app: "T", window_id: 16 });
  check("engine: root answering -25204 → APP_UNRESPONSIVE, not complete:true (G9-2)", res.ok === false && res.code === "APP_UNRESPONSIVE", JSON.stringify({ ok: res.ok, code: res.code, complete: res.complete }));
}

{
  // the focused element is a menu bar item: it is stored under the menu bar, and resolves there
  const ctx = loadEngine(ENGINE);
  const item = Object.assign(el("AXMenuBarItem", { title: "File", actions: ["AXPress"] }), { label: "File" });
  const menubar = el("AXMenuBar", {}, [el("AXMenuBarItem", { title: "Apple" }), item]);
  installApp(ctx, { pid: 63, name: "T", windows: [el("AXWindow", { title: "W", wid: 23 }, [])], menubar, focused: item });
  ctx.pathUp = (e, top) => { const p = []; let c = e; while (c && c !== top) { const par = c.parent; if (!par) return null; p.unshift(par.kids.indexOf(c)); c = par; } return c === top ? p : null; };
  const res = snap(ctx, { app: "T", surface: "focused" });
  const n = res.nodes && res.nodes[0];
  const r = n ? ctx.resolveTarget({ pid: 63, container: res.container, path: n.path, fp: n.fp }, 1000) : { error: { code: "NONE" } };
  check("engine: focused menu bar item → menubar container and resolvable (R11)", res.container?.kind === "menubar" && !r.error && r.el.label === "File", `${JSON.stringify(res.container)} ${tag(r)}`);
}

// ── physical input gate ─────────────────────────────────────────────────────────────────────────
{
  // the accessibility hit test is inconclusive → the window server's topmost window at the point decides
  const ctx = loadEngine(ENGINE);
  const b = Object.assign(el("AXButton", { title: "Go", frame: [10, 10, 40, 20] }), { label: "Go" });
  const win = el("AXWindow", { title: "W", frame: [0, 0, 300, 200], wid: 30 }, [b]);
  installApp(ctx, { pid: 70, name: "T", windows: [win] });
  ctx.onSomeDisplay = () => true;
  const res = snap(ctx, { app: "T" });
  const t = targetOf(res, nodeAt(res, (n) => n.role === "AXButton"));
  ctx.hitTest = () => ({ verdict: "unknown", reason: "hit test error -25204" });
  ctx.cgTopAt = () => ({ pid: 999, owner: "Other", layer: 0, wid: 5 });
  const r1 = ctx.opPhysicalPrep({ target: t });
  check("engine: inconclusive hit test + another app's window on top → OCCLUDED, nothing sent (G2-6)", r1.ok === false && r1.code === "OCCLUDED" && r1.delivery === "not_delivered", JSON.stringify({ code: r1.code, occ: r1.details?.occluder }));
  ctx.cgTopAt = () => null;
  const r2 = ctx.opPhysicalPrep({ target: t });
  check("engine: inconclusive hit test + no window at the point → NOT_ACTIONABLE", r2.ok === false && r2.code === "NOT_ACTIONABLE", r2.code);
  ctx.cgTopAt = () => ({ pid: 70, owner: "T", layer: 0, wid: 30 });
  const r3 = ctx.opPhysicalPrep({ target: t });
  check("engine: inconclusive hit test + the app's own window on top → click allowed", r3.ok === true && r3.hit === "unknown" && /own/.test(r3.reason), JSON.stringify({ ok: r3.ok, reason: r3.reason }));
  ctx.hitTest = () => ({ verdict: "intercepted", occluder: { role: "AXSheet", title: "", app: "T" } });
  const r4 = ctx.opPhysicalPrep({ target: t });
  check("engine: hit test intercepted → OCCLUDED", r4.ok === false && r4.code === "OCCLUDED", r4.code);
  // R17: the app's own, but another window (a floating panel) on top of the element's window
  ctx.hitTest = () => ({ verdict: "unknown", reason: "no element at the point" });
  ctx.axWindowId = (e) => { let c = e; while (c && c.wid === undefined) c = c.parent; return c ? c.wid : null; };
  ctx.cgTopAt = () => ({ pid: 70, owner: "T", layer: 3, wid: 31 });
  const r5 = ctx.opPhysicalPrep({ target: t });
  check("engine: inconclusive hit test + another window of the same app on top → OCCLUDED (R17 §1-1)", r5.ok === false && r5.code === "OCCLUDED" && r5.details?.occluder?.other_window === true, JSON.stringify({ code: r5.code, occ: r5.details?.occluder }));
  ctx.cgTopAt = () => ({ pid: 70, owner: "T", layer: 0, wid: 30 });
  const r6 = ctx.opPhysicalPrep({ target: t });
  check("engine: …and the element's own window on top → allowed", r6.ok === true, JSON.stringify({ ok: r6.ok, code: r6.code }));
}
{
  // the focus guard compares pids, whatever name the caller used
  const ctx = loadEngine(ENGINE);
  installApp(ctx, { pid: 71, name: "Visual Studio Code", bundle: "com.microsoft.VSCode", windows: [], frontPid: 71 });
  const a = ctx.opFrontmost({ app: "com.microsoft.VSCode" });
  const b = ctx.opFrontmost({ pid: 71 });
  check("engine: frontmost matches by bundle id or pid (G2-3)", a.match === true && b.match === true && a.front.pid === 71, JSON.stringify(a));
}

// ── matching ────────────────────────────────────────────────────────────────────────────────────
{
  const ctx = loadEngine(ENGINE);
  const m = (v, f) => ctx.matches(v, f);
  check("engine: text exact matches the title alone (G1-6)", m({ AXRole: "AXButton", AXTitle: "Save" }, { text: "save", exact: true }) === true);
  check("engine: text exact matches the value alone (G1-6)", m({ AXRole: "AXStaticText", AXValue: "Loading" }, { text: "Loading", exact: true }) === true);
  check("engine: text exact rejects a longer string", m({ AXRole: "AXButton", AXTitle: "Save As…" }, { text: "Save", exact: true }) === false);
  check("engine: id is a substring match unless exact (tool description)", m({ AXRole: "AXButton", AXIdentifier: "toolbar.save" }, { id: "save" }) === true && m({ AXRole: "AXButton", AXIdentifier: "toolbar.save" }, { id: "save", exact: true }) === false);
}

// ── menu policy ─────────────────────────────────────────────────────────────────────────────────
{
  const DENY = ["cmd+q", "alt+cmd+q", "cmd+shift+q", "alt+cmd+shift+q", "alt+cmd+esc", "cmd+ctrl+q", "alt+cmd+delete", "cmd+shift+delete", "alt+cmd+shift+delete"];
  const mItem = (title, { cmdChar, mods, vk, id, enabled, label } = {}, kids = []) => {
    const attrs = {};
    if (cmdChar !== undefined) attrs.AXMenuItemCmdChar = cmdChar;
    if (mods !== undefined) attrs.AXMenuItemCmdModifiers = mods;
    if (vk !== undefined) attrs.AXMenuItemCmdVirtualKey = vk;
    return Object.assign(el("AXMenuItem", { title, id, enabled, actions: ["AXPress"], attrs }, kids), { label: label || title });
  };
  const barItem = (title, items) => el("AXMenuBarItem", { title }, [el("AXMenu", {}, items)]);

  {
    const ctx = loadEngine(ENGINE);
    check("menu policy: menuChord formats modifiers + key and returns null without shortcut",
      ctx.menuChord(null, 0, null) === null &&
      ctx.menuChord("Q", 4, null) === "cmd+ctrl+q" &&
      ctx.menuChord("Q", 3, null) === "alt+cmd+shift+q" &&
      ctx.menuChord("\u238b", 2, 53) === "alt+cmd+esc" &&
      ctx.menuChord("\b", 1, 51) === "cmd+shift+delete" &&
      ctx.menuChord("", 8, 117) === "fwd-delete");
    // values read from Finder / iTerm2 menus on the test Mac (macOS 27.2; OUTPUTS/r10-gemini/probes/menu-attrs.js)
    check("menu policy: menuChord matches real menu attributes (Delete Immediately, Log Out, Lock Screen, Force Quit, Empty Trash)",
      ctx.menuChord("\b", 2, 51) === "alt+cmd+delete" && ctx.menuChord("Q", 1, undefined) === "cmd+shift+q" &&
      ctx.menuChord("Q", 4, undefined) === "cmd+ctrl+q" && ctx.menuChord("⎋", 2, 53) === "alt+cmd+esc" &&
      ctx.menuChord("\b", 1, 51) === "cmd+shift+delete" && ctx.menuChord("\b", 3, 51) === "alt+cmd+shift+delete" &&
      ctx.menuChord("Q", 2, undefined) === "alt+cmd+q" && ctx.menuChord(undefined, 10, undefined) === null);
  }

  {
    const ctx = loadEngine(ENGINE);
    const menubar = el("AXMenuBar", {}, [
      barItem("Apple", [
        mItem("Sleep", { id: "_sleepRequested:" }),
        mItem("Lock Screen", { id: "_lockScreenRequested:", cmdChar: "Q", mods: 4 }),
      ]),
      barItem("TextEdit", [
        mItem("Quit TextEdit", { cmdChar: "Q", mods: 0 }),
        mItem("Quit and Close All Windows", { id: "NSAlternateQuitMenuItem", cmdChar: "Q", mods: 2 }),
      ]),
      barItem("File", [
        mItem("Empty Trash…", { id: "_NS:413", cmdChar: "\b", mods: 1, vk: 51 }),
      ]),
      barItem("Edit", [
        mItem("Select All", { cmdChar: "A", mods: 0, label: "Edit > Select All" }),
        mItem("Paste", { cmdChar: "V", mods: 0, enabled: false }),
      ]),
      // Submenu "Edit > Select All" under "Format": suffix matches "Edit > Select All", so a 2-segment
      // command would be ambiguous if opMenu walked every top-level menu instead of only "Edit".
      barItem("Format", [
        mItem("Edit", {}, [el("AXMenu", {}, [mItem("Select All", { label: "Format > Edit > Select All" })])]),
      ]),
    ]);
    const { calls } = installApp(ctx, { pid: 70, name: "TextEdit", bundle: "com.apple.TextEdit", windows: [], menubar });

    const rLockDeny = ctx.opMenu({ op: "menu", app: "TextEdit", command: "Lock Screen", deny_chords: DENY });
    check("menu policy: Lock Screen (bar 0) refused without force",
      rLockDeny.ok === false && rLockDeny.code === "POLICY_DENIED" && rLockDeny.delivery === "not_delivered" && calls.length === 0,
      JSON.stringify(rLockDeny));

    const rSleepDeny = ctx.opMenu({ op: "menu", app: "TextEdit", command: "Sleep", deny_chords: [] });
    check("menu policy: Apple-menu item without chord (bar 0) refused without force",
      rSleepDeny.ok === false && rSleepDeny.code === "POLICY_DENIED" && calls.length === 0,
      JSON.stringify(rSleepDeny));

    const rLockOk = ctx.opMenu({ op: "menu", app: "TextEdit", command: "Lock Screen", force: true, deny_chords: DENY });
    check("menu policy: Lock Screen (bar 0) pressed with force",
      rLockOk.ok === true && calls.length === 1 && calls[0][1] === "Lock Screen" && calls[0][2] === "AXPress",
      JSON.stringify({ ok: rLockOk.ok, calls }));
    calls.length = 0;

    const rTrash = ctx.opMenu({ op: "menu", app: "TextEdit", command: "Empty Trash…", deny_chords: DENY });
    check("menu policy: ⇧⌘⌫ Empty Trash refused without force",
      rTrash.ok === false && rTrash.code === "POLICY_DENIED" && calls.length === 0,
      JSON.stringify(rTrash));

    const rAltQuit = ctx.opMenu({ op: "menu", app: "TextEdit", command: "Quit and Close All Windows", deny_chords: DENY });
    check("menu policy: ⌥⌘Q refused without force",
      rAltQuit.ok === false && rAltQuit.code === "POLICY_DENIED" && calls.length === 0,
      JSON.stringify(rAltQuit));

    const rDisabled = ctx.opMenu({ op: "menu", app: "TextEdit", command: "Edit > Paste", require_enabled: true, deny_chords: DENY });
    check("menu policy: require_enabled with disabled item → menu_item_disabled, nothing pressed",
      rDisabled.ok === false && rDisabled.code === "ACTION_FAILED" && rDisabled.details?.kind === "menu_item_disabled" && calls.length === 0,
      JSON.stringify(rDisabled));

    const rAmb = ctx.opMenu({ op: "menu", app: "TextEdit", command: "Select All", deny_chords: DENY });
    const rTwoSeg = ctx.opMenu({ op: "menu", app: "TextEdit", command: "Edit > Select All", deny_chords: DENY });
    check("menu policy: ordinary item pressed, and two-segment command walks only the named top-level menu",
      rAmb.ok === false && rAmb.code === "AMBIGUOUS_TARGET" &&
      rTwoSeg.ok === true && rTwoSeg.path === "Edit > Select All" &&
      calls.length === 1 && calls[0][1] === "Edit > Select All" && calls[0][2] === "AXPress",
      JSON.stringify({ amb: rAmb.code, ok: rTwoSeg.ok, calls }));
  }

  // review fix (Claude): a path that starts below the top level ("Export > PDF…") still matches as a suffix
  {
    const ctx = loadEngine(ENGINE);
    const menubar = el("AXMenuBar", {}, [
      barItem("Apple", []),
      barItem("File", [mItem("Export", {}, [el("AXMenu", {}, [mItem("PDF…", { label: "File > Export > PDF…" })])])]),
    ]);
    const { calls } = installApp(ctx, { pid: 73, name: "Pages", bundle: "com.apple.iWork.Pages", windows: [], menubar });
    const rSub = ctx.opMenu({ op: "menu", app: "Pages", command: "Export > PDF", deny_chords: DENY });
    const rFull = ctx.opMenu({ op: "menu", app: "Pages", command: "File > Export > PDF…", deny_chords: DENY });
    check("menu policy: a path starting below the top level still resolves (no regression from top-menu scoping)",
      rSub.ok === true && rSub.path === "File > Export > PDF…" && rFull.ok === true && calls.length === 2,
      JSON.stringify({ sub: rSub.code || rSub.path, full: rFull.code || rFull.path, calls }));
  }

  {
    const ctx = loadEngine(ENGINE);
    const menubar = el("AXMenuBar", {}, [
      barItem("Apple", [mItem("Lock Screen", { cmdChar: "Q", mods: 4 })]),
      barItem("Finder", [mItem("Quit Finder", { cmdChar: "Q", mods: 0 })]),
    ]);
    const { calls } = installApp(ctx, { pid: 71, name: "Finder", bundle: "com.apple.finder", windows: [], menubar });
    const r = ctx.opMenu({ op: "menu", app: "Finder", command: "Quit Finder", force: true, deny_chords: DENY });
    check("menu policy: Quit (⌘Q) of com.apple.finder refused even with force",
      r.ok === false && r.code === "POLICY_DENIED" && calls.length === 0,
      JSON.stringify(r));
  }

  {
    const ctx = loadEngine(ENGINE);
    const menubar = el("AXMenuBar", {}, [
      barItem("Apple", []),
      barItem("Host", [
        mItem("Quit Host", { cmdChar: "Q", mods: 0 }),
        mItem("Quit Mirror", { id: "terminate:" }),
      ]),
    ]);
    const { calls } = installApp(ctx, { pid: 72, name: "Host", bundle: "dev.example.host", windows: [], menubar });
    const r1 = ctx.opMenu({ op: "menu", app: "Host", command: "Quit Host", force: true, protect_pids: [72], deny_chords: DENY });
    const r2 = ctx.opMenu({ op: "menu", app: "Host", command: "Quit Mirror", force: true, protect_pids: [72], deny_chords: DENY });
    check("menu policy: Quit of a pid in protect_pids refused even with force",
      r1.ok === false && r1.code === "POLICY_DENIED" && r2.ok === false && r2.code === "POLICY_DENIED" && calls.length === 0,
      JSON.stringify({ r1: r1.code, r2: r2.code, calls }));
  }
}

// ── mac_paste: one engine call, clipboard copied aside and put back (R13 §2) ───────────────────────
{
  // a fake pasteboard and clock; frontApp/findApp come from installApp
  const setup = (opts = {}) => {
    const ctx = loadEngine(ENGINE);
    const appEl = installApp(ctx, { pid: 90, name: "TextEdit", bundle: "com.apple.TextEdit", windows: [], frontPid: opts.frontPid }).appEl;
    if (opts.hung) appEl.hung = true;
    let clock = 0, cc = 10;
    const pb = { types: opts.types ?? ["public.utf8-plain-text"], items: opts.items ?? [[["public.utf8-plain-text", "user text"]]] };
    const log = [];
    ctx.now = () => clock;
    ctx.sleep = (ms) => { clock += ms; if (opts.onSleep) opts.onSleep(clock, api); };
    ctx.pbTypes = () => pb.types.slice();
    ctx.pbItemTypes = () => (opts.itemTypes ?? pb.types).slice();
    ctx.pbChangeCount = () => cc;
    ctx.pbSave = (limit) => { log.push("save"); if (opts.duringSave) opts.duringSave(api); return opts.tooLarge ? { too_large: true } : { items: JSON.parse(JSON.stringify(pb.items)), bytes: 9 }; };
    ctx.pbWriteText = (t) => { log.push(`write:${t}`); const mine = ++cc; pb.types = ["public.utf8-plain-text", "org.nspasteboard.TransientType"]; pb.items = [[["public.utf8-plain-text", t]]]; if (opts.afterWrite) opts.afterWrite(api); return mine; };
    ctx.pbRestore = (saved) => { log.push("restore"); cc++; pb.items = saved.items; pb.types = ["public.utf8-plain-text"]; return true; };
    ctx.pbClear = () => { log.push("clear"); cc++; pb.items = []; pb.types = []; };
    // E2 T7: ⌘V is posted by the engine as key code 9 with the ⌘ modifier (no cliclick)
    ctx.postKey = (code, mods) => { log.push(`key:${code}:${mods.map((m) => m[0]).join("+")}`); if (opts.afterKey) opts.afterKey(api); return opts.keyResult ?? true; };
    ctx.releaseStuckModifiers = () => [];
    ctx.keyboardLayoutId = () => opts.layout ?? "com.apple.keylayout.US";
    const FOCUSED = { id: "field" };
    // CP: evidence carries the raw value and selection; "after" is the pasted text over an empty field
    let ev = opts.evidence === undefined ? null : { el: FOCUSED, key: opts.evidence, raw: opts.raw ?? "", sel: opts.sel === undefined ? { location: 0, length: 0 } : opts.sel };
    ctx.focusEvidence = () => ev;
    ctx.same = (a, b) => a === b;
    const api = { ctx, pb, log, now: () => clock, bump: () => { cc++; }, setEvidence: (x, el, raw) => { ev = { el: el || FOCUSED, key: x, raw: raw ?? (x === "after" ? "hello" : x), sel: { location: 0, length: 0 } }; }, setFront: (pid) => { ctx.frontApp = () => ({ ns: {}, name: "Other", bundle: "x.other", pid }); } };
    return api;
  };
  {
    const t = setup({ evidence: "before", afterKey: (a) => a.setEvidence("after") });
    const r = t.ctx.opPaste({ op: "paste", text: "hello", app: "TextEdit" });
    check("paste: the user's items are copied aside and put back after the paste shows → delivered_verified, restored true",
      r.ok && r.delivery === "delivered_verified" && r.restored === "true" && t.log.join(",") === "save,write:hello,key:9:55,restore" && t.pb.items[0][0][1] === "user text", JSON.stringify({ r, log: t.log }));
  }
  {
    const t = setup({ types: ["public.utf8-plain-text", "org.nspasteboard.ConcealedType"], evidence: "before", afterKey: (a) => a.setEvidence("after") });
    const r = t.ctx.opPaste({ op: "paste", text: "hello" });
    check("paste: a concealed (password manager) item is never copied; the clipboard is cleared afterwards",
      r.ok && r.restored === "cleared (previous_concealed)" && t.log.indexOf("save") < 0 && t.log[t.log.length - 1] === "clear", JSON.stringify({ r, log: t.log }));
  }
  {
    const t = setup({ types: [] });
    const r = t.ctx.opPaste({ op: "paste", text: "hello" });
    check("paste: an empty clipboard stays empty; without evidence the result is delivered_unverified after the hold",
      r.ok && r.delivery === "delivered_unverified" && r.restored === "true (was_empty)" && t.log[t.log.length - 1] === "clear", JSON.stringify({ r, log: t.log }));
  }
  {
    const t = setup({ frontPid: 91 });
    const r = t.ctx.opPaste({ op: "paste", text: "s3cret", app: "TextEdit" });
    check("paste: focus guard by pid — another app in front → nothing written, nothing sent",
      !r.ok && r.code === "FOCUS_LOST" && r.delivery === "not_delivered" && t.log.length === 0, JSON.stringify({ r, log: t.log }));
  }
  {
    const t = setup({ afterWrite: (a) => a.bump() });
    const r = t.ctx.opPaste({ op: "paste", text: "hello" });
    check("paste: another app writes to the clipboard just before ⌘V → no keystroke, its content is left alone",
      !r.ok && r.code === "NOT_CONFIRMED" && r.delivery === "not_delivered" && !t.log.some((x) => x.startsWith("key:")) && t.log.indexOf("restore") < 0, JSON.stringify({ r, log: t.log }));
  }
  {
    const t = setup({ afterWrite: (a) => a.setFront(91) });
    const r = t.ctx.opPaste({ op: "paste", text: "hello", app: "TextEdit" });
    check("paste: the frontmost app changes just before ⌘V → no keystroke, the user's clipboard is put back",
      !r.ok && r.code === "FOCUS_LOST" && !t.log.some((x) => x.startsWith("key:")) && t.log[t.log.length - 1] === "restore", JSON.stringify({ r, log: t.log }));
  }
  {
    const t = setup({ afterKey: (a) => a.bump() });
    const r = t.ctx.opPaste({ op: "paste", text: "hello" });
    check("paste: someone copies during the hold → their copy is kept (restored false (changed_externally))",
      r.ok && r.restored === "false (changed_externally)" && t.log.indexOf("restore") < 0, JSON.stringify({ r, log: t.log }));
  }
  {
    const t = setup({ types: ["public.utf8-plain-text", "com.apple.is-remote-clipboard"] });
    const r = t.ctx.opPaste({ op: "paste", text: "hello" });
    const t2 = setup({ types: ["public.utf8-plain-text", "com.apple.is-remote-clipboard"] });
    const r2 = t2.ctx.opPaste({ op: "paste", text: "hello", force: true });
    check("paste: Universal Clipboard content → refused without force (nothing read or written); force pastes and says it was not restored",
      !r.ok && r.code === "CLIPBOARD_REMOTE" && t.log.length === 0 && r2.ok && r2.restored === "false (remote)" && t2.log.indexOf("save") < 0, JSON.stringify({ r: r.code, log: t.log, r2: r2.restored, log2: t2.log }));
  }
  {
    const t = setup({ tooLarge: true });
    const r = t.ctx.opPaste({ op: "paste", text: "hello" });
    check("paste: a clipboard over the limit → refused, nothing written (never silently lost)",
      !r.ok && r.code === "CLIPBOARD_TOO_LARGE" && t.log.join(",") === "save", JSON.stringify({ r, log: t.log }));
  }
  {
    const t = setup({ hung: true });
    const r = t.ctx.opPaste({ op: "paste", text: "hello" });
    check("paste: an app that does not answer after ⌘V keeps our text on the clipboard (it may read it late)",
      r.ok && r.restored === "false (app_unresponsive)" && t.log.indexOf("restore") < 0, JSON.stringify({ r, log: t.log }));
  }
  {
    // E2 T7: the key events for ⌘V cannot be created → the V key never went out: not delivered, clipboard put back
    const t = setup({ keyResult: false });
    const r = t.ctx.opPaste({ op: "paste", text: "hello" });
    check("paste: ⌘V events cannot be created → not_delivered, the user's clipboard is put back",
      !r.ok && r.delivery === "not_delivered" && r.code === "ACTION_FAILED" && t.log[t.log.length - 1] === "restore", JSON.stringify({ r, log: t.log }));
  }
  {
    // E2 T7: a Dvorak layout has K on key code 9 → refused before anything is read or written; Dvorak - QWERTY ⌘ is fine
    const t = setup({ layout: "com.apple.keylayout.Dvorak" });
    const r = t.ctx.opPaste({ op: "paste", text: "hello" });
    const t2 = setup({ layout: "com.apple.keylayout.DVORAK-QWERTYCMD", evidence: "before", afterKey: (a) => a.setEvidence("after") });
    const r2 = t2.ctx.opPaste({ op: "paste", text: "hello" });
    check("paste: Dvorak → refused, nothing read or written; Dvorak - QWERTY ⌘ → pasted",
      !r.ok && r.delivery === "not_delivered" && t.log.length === 0 && r2.ok && r2.delivery === "delivered_verified", JSON.stringify({ r, log: t.log, r2: r2.delivery }));
  }
  {
    // R15: a copy that lands while the clipboard is being copied aside is not overwritten
    const t = setup({ duringSave: (a) => a.bump() });
    const r = t.ctx.opPaste({ op: "paste", text: "hello" });
    check("paste: another app copies during the save → nothing written, nothing sent (R15 §1-3)",
      !r.ok && r.code === "NOT_CONFIRMED" && !t.log.some((x) => x.startsWith("write") || x.startsWith("key:")), JSON.stringify({ r, log: t.log }));
  }
  {
    // R15: the paste shows at once → still held for the minimum before the clipboard goes back
    let restoredAt = null;
    const t = setup({ evidence: "before", afterKey: (a) => a.setEvidence("after") });
    const orig = t.ctx.pbRestore;
    t.ctx.pbRestore = (saved) => { restoredAt = t.now(); return orig(saved); };
    const r = t.ctx.opPaste({ op: "paste", text: "hello" });
    check("paste: evidence at once → restore only after the 300 ms minimum hold (R15 §1-4)", r.ok && r.delivery === "delivered_verified" && restoredAt >= 300, `restoredAt=${restoredAt}`);
  }
  {
    // CP (F4): the text was in the field before; after ⌘V the value changed in another way → not verified
    const t = setup({ evidence: "before", raw: "hello", sel: { location: 5, length: 0 }, afterKey: (a) => a.setEvidence("after2", undefined, "hello ") });
    const r = t.ctx.opPaste({ op: "paste", text: "hello" });
    check("CP (F4): paste — text already there, value changed otherwise → delivered_unverified not_at_insertion_point; clipboard restored after the hold",
      r.ok && r.delivery === "delivered_unverified" && r.reason === "not_at_insertion_point" && r.restored === "true", JSON.stringify(r));
  }
  {
    const t = setup({ evidence: "before", raw: "abc", sel: null, afterKey: (a) => a.setEvidence("after3", undefined, "abchello") });
    const r = t.ctx.opPaste({ op: "paste", text: "hello" });
    check("CP: paste — insertion point unreadable → delivered_unverified insertion_point_unreadable even though the text shows",
      r.ok && r.delivery === "delivered_unverified" && r.reason === "insertion_point_unreadable", JSON.stringify(r));
  }
  {
    const t = setup({ evidence: "before", raw: "ab", sel: { location: 1, length: 0 }, afterKey: (a) => a.setEvidence("after4", undefined, "ahellob") });
    const r = t.ctx.opPaste({ op: "paste", text: "hello" });
    check("CP: paste — value becomes before[0:loc] + text + rest → delivered_verified",
      r.ok && r.delivery === "delivered_verified" && r.reason === undefined, JSON.stringify(r));
  }
  for (const [after, want] of [["abXYcd", "delivered_verified"], ["abcdXY", "delivered_unverified"], ["XYabcd", "delivered_unverified"]]) {
    const t = setup({ evidence: "before", raw: "abcd", sel: { location: 2, length: 0 }, afterKey: (a) => a.setEvidence(`k-${after}`, undefined, after) });
    const r = t.ctx.opPaste({ op: "paste", text: "XY" });
    check(`CP R35: paste XY into "ab|cd" → ${after} gives ${want}; clipboard restored`, r.ok && r.delivery === want && r.restored === "true",
      JSON.stringify({ delivery: r.delivery, reason: r.reason, restored: r.restored }));
  }
  {
    // R36 (F4): PAYLOAD fully selected, PAYLOAD pasted over it: the value reads the same, only the selection moved
    const t = setup({ evidence: "before", raw: "PAYLOAD", sel: { location: 0, length: 7 }, afterKey: (a) => a.setEvidence("k-sel-moved", undefined, "PAYLOAD") });
    const r = t.ctx.opPaste({ op: "paste", text: "PAYLOAD" });
    check("CP R36 (F4): paste PAYLOAD over a selected PAYLOAD, value unchanged → delivered_unverified value_unchanged, never verified",
      r.ok && r.delivery === "delivered_unverified" && r.reason === "value_unchanged", JSON.stringify({ delivery: r.delivery, reason: r.reason, restored: r.restored }));
  }
  {
    // R15: focus moving to another element is not evidence of the paste
    const t = setup({ evidence: "before", afterKey: (a) => a.setEvidence("other", { id: "elsewhere" }) });
    const r = t.ctx.opPaste({ op: "paste", text: "hello" });
    check("paste: a focus change is not evidence → delivered_unverified after the full hold (R15 §1-4)", r.ok && r.delivery === "delivered_unverified", JSON.stringify(r));
  }
  {
    // R15: a concealed marker on the second item (NSPasteboard.types lists only the first item's)
    const t = setup({ types: ["public.utf8-plain-text"], itemTypes: ["public.utf8-plain-text", "public.utf8-plain-text", "org.nspasteboard.ConcealedType"] });
    const r = t.ctx.opPaste({ op: "paste", text: "hello" });
    check("paste: a concealed second item is never copied (R15 §1-5)", r.ok && r.restored === "cleared (previous_concealed)" && t.log.indexOf("save") < 0, JSON.stringify({ r, log: t.log }));
  }
  {
    // without evidence the clipboard is not restored before the hold (1 s by default)
    let restoredAt = null;
    const t = setup({});
    const orig = t.ctx.pbRestore;
    let clockRef = 0;
    t.ctx.sleep = ((s) => (ms) => { clockRef += ms; })();
    t.ctx.now = () => clockRef;
    t.ctx.pbRestore = (saved) => { restoredAt = clockRef; return orig(saved); };
    const r = t.ctx.opPaste({ op: "paste", text: "hello" });
    check("paste: with no evidence the user's clipboard is put back only after the 1 s hold", r.ok && restoredAt >= 1000, `restoredAt=${restoredAt}`);
  }
}

// ── delivery honesty + role/option fixes ────────────────────────────────────────────────────────
{
  // verdict: environment-only changes do not count as verification; element/surface keys do; keys restriction honoured
  const ctx = loadEngine(ENGINE);
  const vWeak = ctx.verdict({ frontmost: 1, focus: "AXButton:A", focusedWindow: "W1" }, { frontmost: 2, focus: "AXTextField:B", focusedWindow: "W2" });
  check("verdict: only environment keys (frontmost/focus/focusedWindow) changed → delivered_unverified",
    vWeak.delivery === "delivered_unverified" && vWeak.changed.includes("frontmost") && vWeak.changed.length === 3,
    JSON.stringify(vWeak));
  const vVal = ctx.verdict({ value: "old", frontmost: 1 }, { value: "new", frontmost: 2 });
  check("verdict: value changed → delivered_verified",
    vVal.delivery === "delivered_verified" && vVal.changed.includes("value"),
    JSON.stringify(vVal));
  const vKeysMiss = ctx.verdict({ value: "old", vscroll: 0.2 }, { value: "new", vscroll: 0.2 }, {}, ["vscroll", "hscroll"]);
  const vKeysHit = ctx.verdict({ value: "old", vscroll: 0.2 }, { value: "old", vscroll: 0.6 }, {}, ["vscroll", "hscroll"]);
  check("verdict: keys restriction honoured (only vscroll/hscroll count when restricted)",
    vKeysMiss.delivery === "delivered_unverified" && vKeysMiss.changed.includes("value") &&
    vKeysHit.delivery === "delivered_verified" && vKeysHit.changed.includes("vscroll"),
    JSON.stringify({ miss: vKeysMiss, hit: vKeysHit }));
}

{
  // opObserveAfter: non-absent resolve failure (-25204 hung root or thrown error) → delivered_unverified, never gone
  const ctx = loadEngine(ENGINE);
  const btn = Object.assign(el("AXButton", { title: "Save", frame: [10, 10, 60, 20], actions: ["AXPress"] }), { label: "Save" });
  const win = el("AXWindow", { title: "Doc", frame: [0, 0, 300, 200], wid: 31 }, [btn]);
  installApp(ctx, { pid: 80, name: "T", windows: [win] });
  const res = snap(ctx, { app: "T" });
  const t = targetOf(res, nodeAt(res, (n) => n.role === "AXButton"));
  const before = ctx.observeState(btn, ctx.appElement());
  win.hung = true;
  const rHung = ctx.opObserveAfter({ target: t, before });
  check("observe_after: root answering -25204 → delivered_unverified, not gone",
    rHung.ok === true && rHung.delivery === "delivered_unverified" && !rHung.changed.includes("gone") && /APP_UNRESPONSIVE/.test(rHung.note || ""),
    JSON.stringify(rHung));
  win.hung = false;
  const origRead = ctx.readNode;
  ctx.readNode = () => { throw new Error("ipc timeout"); };
  const rThrow = ctx.opObserveAfter({ target: t, before });
  check("observe_after: readNode throws → delivered_unverified (INTERNAL), not gone",
    rThrow.ok === true && rThrow.delivery === "delivered_unverified" && !rThrow.changed.includes("gone") && /INTERNAL/.test(rThrow.note || ""),
    JSON.stringify(rThrow));
  ctx.readNode = origRead;
  btn.gone = true; win.kids = [];
  const rGone = ctx.opObserveAfter({ target: t, before });
  check("observe_after: STALE_REF when element vanished → gone counts as delivered_verified",
    rGone.ok === true && rGone.delivery === "delivered_verified" && rGone.changed.includes("gone"),
    JSON.stringify(rGone));
}

{
  // opInsertText + setValueCore: write returns 0, value never changes → NOT_CONFIRMED with delivered_unverified, retry unsafe
  const ctx = loadEngine(ENGINE);
  const tf = Object.assign(el("AXTextField", { placeholder: "Name", value: "old", frame: [10, 10, 200, 22], settable: { AXSelectedText: true, AXValue: true } }), { label: "Name field" });
  const slider = Object.assign(el("AXSlider", { title: "Volume", value: 2, frame: [10, 50, 200, 20], actions: ["AXIncrement", "AXDecrement"] }), { label: "Volume" });
  const win = el("AXWindow", { title: "Form", frame: [0, 0, 300, 200], wid: 32 }, [tf, slider]);
  const { calls } = installApp(ctx, { pid: 81, name: "T", windows: [win] });
  const res = snap(ctx, { app: "T" });
  const tField = targetOf(res, nodeAt(res, (n) => n.role === "AXTextField"));
  const tSlider = targetOf(res, nodeAt(res, (n) => n.role === "AXSlider"));
  const rIns = ctx.opInsertText({ target: tField, text: "hello" });
  check("insert_text: write=0 with unchanged value → NOT_CONFIRMED, delivered_unverified, retry unsafe",
    rIns.ok === false && rIns.code === "NOT_CONFIRMED" && rIns.delivery === "delivered_unverified" && rIns.retry === "unsafe" && calls.length === 1,
    JSON.stringify(rIns));
  // review (Claude): only the caret moved after the write → not verified
  tf.attrs = { AXSelectedTextRange: { location: 0, length: 0 } };
  tf.onSet = () => { tf.attrs.AXSelectedTextRange = { location: 3, length: 0 }; };
  const rMoved = ctx.opInsertText({ target: tField, text: "hello" });
  check("insert_text: value unchanged but the caret moved → delivered_unverified (selection_moved), never verified",
    rMoved.ok === true && rMoved.delivery === "delivered_unverified" && rMoved.reason === "selection_moved", JSON.stringify(rMoved));
  delete tf.attrs; delete tf.onSet;
  const rSet = ctx.opSetValue({ target: tField, value: "world" });
  check("set_value: generic AXValue write=0 with unchanged value → NOT_CONFIRMED, delivered_unverified, retry unsafe",
    rSet.ok === false && rSet.code === "NOT_CONFIRMED" && rSet.delivery === "delivered_unverified" && rSet.retry === "unsafe",
    JSON.stringify(rSet));
  const origPerform = ctx.perform;
  let stepCalls = 0;
  ctx.perform = (e, action) => {
    if (e === slider) {
      stepCalls++;
      if (stepCalls === 1) { slider.value = 3; return 0; }
      return -25206;
    }
    return origPerform(e, action);
  };
  const rStep = ctx.opSetValue({ target: tSlider, value: "5" });
  check("set_value: stepping fails after ≥1 succeeded step → delivered_unverified/unsafe with stopped note",
    rStep.ok === true && rStep.delivery === "delivered_unverified" && rStep.retry === "unsafe" && rStep.value === 3 && /stopped after 1 steps/.test(rStep.note || ""),
    JSON.stringify(rStep));
}

{
  // chooseOption: no substring fallback ("One" must not match "None"); normalized fallback still works
  const ctx = loadEngine(ENGINE);
  const optNone = Object.assign(el("AXMenuItem", { title: "None", actions: ["AXPress"] }), { label: "opt:None" });
  const optTwo = Object.assign(el("AXMenuItem", { title: "Two", actions: ["AXPress"] }), { label: "opt:Two" });
  const optSave = Object.assign(el("AXMenuItem", { title: "Save As…", actions: ["AXPress"] }), { label: "opt:SaveAs" });
  const menu = Object.assign(el("AXMenu", { actions: ["AXCancel"] }, [optNone, optTwo, optSave]), { label: "popupMenu" });
  const pop = Object.assign(el("AXPopUpButton", { title: "Choice", value: "Two", frame: [10, 10, 120, 24], actions: ["AXPress"] }), {
    label: "ChoicePop",
    onPerform(act) { if (act === "AXPress") { pop.kids = [menu]; reparent(pop); } },
  });
  menu.onPerform = (act) => { if (act === "AXCancel") pop.kids = []; };
  optSave.onPerform = () => { pop.value = "Save As…"; pop.kids = []; };
  const win = el("AXWindow", { title: "Prefs", frame: [0, 0, 300, 200], wid: 33 }, [pop]);
  const { calls } = installApp(ctx, { pid: 82, name: "T", windows: [win] });
  const res = snap(ctx, { app: "T" });
  const t = targetOf(res, nodeAt(res, (n) => n.role === "AXPopUpButton"));
  const rNo = ctx.opSetValue({ target: t, value: "One", timeout_ms: 500 });
  check("chooseOption: options ['None','Two',…], want 'One' → no match, nothing pressed except opener + AXCancel",
    rNo.ok === false && rNo.code === "ACTION_FAILED" && rNo.delivery === "not_delivered" && rNo.retry === "safe" &&
    /no option matches "One"/.test(rNo.message) &&
    JSON.stringify(calls) === JSON.stringify([["perform", "ChoicePop", "AXPress"], ["perform", "popupMenu", "AXCancel"]]),
    JSON.stringify({ rNo, calls }));
  calls.length = 0;
  const rNorm = ctx.opSetValue({ target: t, value: "  save   as... ", timeout_ms: 500 });
  check("chooseOption: normalized fallback matches 'Save As…' without substring matching",
    rNorm.ok === true && rNorm.option === "Save As…" && rNorm.delivery === "delivered_verified",
    JSON.stringify(rNorm));
}

{
  // mixed checkbox: AXValue 2 is neither on nor off — want false presses (up to twice), never "already off"
  const ctx = loadEngine(ENGINE);
  const cb = Object.assign(el("AXCheckBox", { title: "Select All", value: 2, frame: [10, 10, 100, 20], actions: ["AXPress"] }), {
    label: "SelectAll",
    onPerform(act) { if (act === "AXPress") cb.value = cb.value === 2 ? 1 : cb.value === 1 ? 0 : 1; },
  });
  const win = el("AXWindow", { title: "List", frame: [0, 0, 300, 200], wid: 34 }, [cb]);
  const { calls } = installApp(ctx, { pid: 83, name: "T", windows: [win] });
  const res = snap(ctx, { app: "T" });
  const t = targetOf(res, nodeAt(res, (n) => n.role === "AXCheckBox"));
  const rMixed = ctx.opSetValue({ target: t, value: "mixed" });
  check("mixed checkbox: AXValue 2, want 'mixed' → already mixed (nothing sent)",
    rMixed.ok === true && rMixed.delivery === "not_delivered" && rMixed.value === "mixed" && calls.length === 0,
    JSON.stringify(rMixed));
  const rOff = ctx.opSetValue({ target: t, value: "false" });
  check("mixed checkbox: AXValue 2, want false → pressed (not 'already off') until off",
    rOff.ok === true && rOff.delivery === "delivered_verified" && rOff.value === false && calls.length === 2,
    JSON.stringify({ rOff, calls }));
}

{
  // opWait: element gone with hung app (-25204) → TIMEOUT; text_gone with app never running → APP_NOT_FOUND immediately
  const ctx = loadEngine(ENGINE);
  const btn = Object.assign(el("AXButton", { title: "Run", frame: [10, 10, 60, 20], actions: ["AXPress"] }), { label: "Run" });
  const w1 = el("AXWindow", { title: "One", frame: [0, 0, 300, 200], wid: 35 }, [btn]);
  installApp(ctx, { pid: 84, name: "Runner", windows: [w1] });
  const res = snap(ctx, { app: "Runner" });
  const t = targetOf(res, nodeAt(res, (n) => n.role === "AXButton"));
  w1.hung = true;
  const rHungGone = ctx.opWait({ condition: "element", predicate: "gone", target: t, timeout_ms: 0 });
  check("opWait: element predicate gone with hung app (-25204) → TIMEOUT, not met",
    rHungGone.ok === false && rHungGone.code === "TIMEOUT" && rHungGone.details?.last_observed?.code === "APP_UNRESPONSIVE",
    JSON.stringify(rHungGone));
  const rNever = ctx.opWait({ condition: "text_gone", app: "NoSuchApp", text: "Busy", timeout_ms: 5000 });
  check("opWait: text_gone with app never running → APP_NOT_FOUND immediately",
    rNever.ok === false && rNever.code === "APP_NOT_FOUND",
    JSON.stringify(rNever));
  w1.hung = false;
  const w2 = el("AXWindow", { title: "Two", frame: [400, 0, 300, 200], wid: 36 }, []);
  ctx.appElement().kids.push(w2); reparent(ctx.appElement());
  const rAmb = ctx.opWait({ condition: "text_gone", app: "Runner", text: "Busy", timeout_ms: 0 });
  check("opWait: text_gone with AMBIGUOUS_WINDOW → TIMEOUT, not met",
    rAmb.ok === false && rAmb.code === "TIMEOUT" && rAmb.details?.last_observed?.window === "AMBIGUOUS_WINDOW",
    JSON.stringify(rAmb));
}

{
  // opWindowOp: focus with app frontmost but window neither focused nor main → delivered_unverified; maximize partial failure
  const ctx = loadEngine(ENGINE);
  const w1 = Object.assign(el("AXWindow", { title: "Doc", frame: [0, 0, 400, 300], wid: 37, focusedFlag: false, attrs: { AXMain: false } }), { label: "DocWin" });
  installApp(ctx, { pid: 85, name: "Editor", windows: [w1], frontPid: 85 });
  const rUnv = ctx.opWindowOp({ action: "focus", app: "Editor", window: 0 });
  check("opWindowOp: focus with app frontmost but window not focused/main → delivered_unverified",
    rUnv.ok === true && rUnv.delivery === "delivered_unverified" && rUnv.frontmost === "Editor",
    JSON.stringify(rUnv));
  w1.onSet = (name, val) => { if (name === "AXMain") w1.attrs.AXMain = Boolean(val); };
  const rVer = ctx.opWindowOp({ action: "focus", app: "Editor", window: 0 });
  check("opWindowOp: focus with app frontmost and window main → delivered_verified",
    rVer.ok === true && rVer.delivery === "delivered_verified",
    JSON.stringify(rVer));
  ctx.visibleFrameOf = () => [0, 25, 1440, 875];
  ctx.axPoint = (x, y) => ({ x, y });
  ctx.axSize = (w, h) => ({ w, h });
  ctx.setAttr = (e, name) => (name === "AXSize" ? -25201 : 0);
  const rMax = ctx.opWindowOp({ action: "maximize", app: "Editor", window: 0 });
  check("opWindowOp: maximize AXPosition ok + AXSize failed → ACTION_FAILED, delivered_unverified, retry safe",
    rMax.ok === false && rMax.code === "ACTION_FAILED" && rMax.delivery === "delivered_unverified" && rMax.retry === "safe" && /moved the window but could not resize it/.test(rMax.message),
    JSON.stringify(rMax));
}
{
  // R19 §1-5: AXRaise fails after the window was already unminimized / made main → not "nothing sent"
  const ctx = loadEngine(ENGINE);
  const w1 = Object.assign(el("AXWindow", { title: "Doc", frame: [0, 0, 400, 300], wid: 38, focusedFlag: false, attrs: { AXMain: false } }), { label: "DocWin" });
  installApp(ctx, { pid: 86, name: "Editor", windows: [w1], frontPid: 86 });
  ctx.perform = (e, a) => (a === "AXRaise" ? -25206 : 0);
  const rF = ctx.opWindowOp({ action: "focus", app: "Editor", window: 0 });
  check("opWindowOp: AXRaise unsupported and focus not reached → ACTION_NOT_SUPPORTED, delivered_unverified (R19)",
    rF.ok === false && rF.code === "ACTION_NOT_SUPPORTED" && rF.delivery === "delivered_unverified" && rF.retry === "safe", JSON.stringify(rF));
  w1.onSet = (name, val) => { if (name === "AXMain") w1.attrs.AXMain = Boolean(val); };
  const rV = ctx.opWindowOp({ action: "focus", app: "Editor", window: 0 });
  check("opWindowOp: AXRaise unsupported but the window became main → delivered_verified (R19)", rV.ok === true && rV.delivery === "delivered_verified", JSON.stringify(rV));
}
{
  // R19 §1-6: the element's own window id is unknown → its window's (or the snapshot window's) id is used, never skipped
  const ctx = loadEngine(ENGINE);
  const b = Object.assign(el("AXButton", { title: "Go", frame: [10, 10, 40, 20] }), { label: "Go" });
  const win = el("AXWindow", { title: "W", frame: [0, 0, 300, 200], wid: 40 }, [b]);
  installApp(ctx, { pid: 87, name: "T", windows: [win] });
  ctx.onSomeDisplay = () => true;
  const res = snap(ctx, { app: "T" });
  const t = targetOf(res, nodeAt(res, (n) => n.role === "AXButton"));
  ctx.hitTest = () => ({ verdict: "unknown", reason: "no element at the point" });
  ctx.axWindowId = (e) => (e && e.wid !== undefined ? e.wid : null); // only windows answer
  ctx.cgTopAt = () => ({ pid: 87, owner: "T", layer: 3, wid: 41 });
  const r1 = ctx.opPhysicalPrep({ target: t });
  check("engine: element window id unknown + another window of the same app on top → OCCLUDED (R19)", r1.ok === false && r1.code === "OCCLUDED" && r1.details?.occluder?.other_window === true, JSON.stringify({ ok: r1.ok, code: r1.code }));
  ctx.cgTopAt = () => ({ pid: 87, owner: "T", layer: 0, wid: 40 });
  const r2 = ctx.opPhysicalPrep({ target: t });
  check("engine: …and its own window on top → allowed (R19)", r2.ok === true, JSON.stringify({ ok: r2.ok, code: r2.code }));
  // R20: an app-surface snapshot and no AXWindow attribute → the window is found by climbing AXParent
  const resApp = snap(ctx, { app: "T", surface: "app" });
  const tApp = targetOf(resApp, nodeAt(resApp, (n) => n.role === "AXButton"));
  const origAttr = ctx.attr;
  ctx.attr = (e, n) => (n === "AXWindow" ? null : origAttr(e, n));
  ctx.cgTopAt = () => ({ pid: 87, owner: "T", layer: 3, wid: 41 });
  const r3 = ctx.opPhysicalPrep({ target: tApp });
  ctx.attr = origAttr;
  check("engine: app-surface target without AXWindow + another window of the same app on top → OCCLUDED (R20)",
    resApp.container?.kind === "app" && r3.ok === false && r3.code === "OCCLUDED" && r3.details?.occluder?.other_window === true, JSON.stringify({ kind: resApp.container?.kind, ok: r3.ok, code: r3.code }));
}

{
  // t10 §1: enableWebAccessibility writes only AXManualAccessibility (never AXEnhancedUserInterface), and honours web_accessibility:false
  const ctx = loadEngine(ENGINE);
  const win = el("AXWindow", { title: "App", frame: [0, 0, 300, 200], wid: 50 }, [el("AXButton", { title: "OK", frame: [10, 10, 40, 20] })]);
  const { appEl } = installApp(ctx, { pid: 95, name: "ElectronApp", windows: [win] });
  ctx.rendererOf = () => "chromium";
  const setCalls = [];
  ctx.setAttr = (_e, name, value) => {
    setCalls.push([name, value]);
    return name === "AXManualAccessibility" ? -25205 : 0;
  };
  const unsupported = ctx.enableWebAccessibility(appEl);
  check("t10: enableWebAccessibility unsupported → returns 'unsupported' and never writes AXEnhancedUserInterface",
    unsupported === "unsupported" && JSON.stringify(setCalls) === JSON.stringify([["AXManualAccessibility", true]]),
    JSON.stringify({ unsupported, setCalls }));
  setCalls.length = 0;
  ctx.setAttr = (_e, name, value) => { setCalls.push([name, value]); return 0; };
  const enabled = ctx.enableWebAccessibility(appEl);
  check("t10: enableWebAccessibility supported → writes AXManualAccessibility=true and returns 'enabled'",
    enabled === "enabled" && JSON.stringify(setCalls) === JSON.stringify([["AXManualAccessibility", true]]),
    JSON.stringify({ enabled, setCalls }));
  setCalls.length = 0;
  ctx.opSnapshot({ app: "ElectronApp", web_accessibility: false });
  ctx.opFind({ app: "ElectronApp", role: "button", web_accessibility: false });
  check("t10: opSnapshot and opFind with web_accessibility:false do not call enableWebAccessibility",
    setCalls.length === 0, JSON.stringify(setCalls));
}

{
  // t10 §3: opSetValue on AXSecureTextField never returns the value
  const ctx = loadEngine(ENGINE);
  const pw = Object.assign(el("AXTextField", { subrole: "AXSecureTextField", title: "Password", value: "••••", frame: [10, 10, 160, 22], settable: { AXValue: true } }), { label: "Password" });
  const win = el("AXWindow", { title: "Sign In", frame: [0, 0, 300, 200], wid: 51 }, [pw]);
  installApp(ctx, { pid: 96, name: "Auth", windows: [win] });
  const res = snap(ctx, { app: "Auth" });
  const t = targetOf(res, nodeAt(res, (n) => n.role === "AXTextField"));
  const r = ctx.opSetValue({ target: t, value: "hunter2-secret" });
  check("t10: opSetValue on AXSecureTextField returns no value and never echoes secret",
    r.ok === true && r.delivery === "delivered_unverified" && r.secure === true && r.value === undefined && !JSON.stringify(r).includes("hunter2-secret") && !JSON.stringify(r).includes("••••"),
    JSON.stringify(r));
}

{
  // t10 §2: opNotifications — open_center skips clock click when already open; missing/vanished id → NOTIFICATION_NOT_FOUND
  const ctx = loadEngine(ENGINE);
  const clockItem = Object.assign(el("AXMenuBarItem", { id: "Clock", title: "Clock", actions: ["AXPress"] }), { label: "Clock" });
  const extrasBar = el("AXMenuBar", {}, [clockItem]);
  const banner = Object.assign(
    el("AXGroup", { subrole: "AXNotificationCenterBanner", id: "n-1", desc: "Mail, Subject, , Body", actions: ["Name:Close\nTarget:0x1", "AXPress"] }, [
      el("AXStaticText", { id: "title", value: "Subject" }),
    ]),
    { label: "Banner1" }
  );
  // 1) Closed (only a floating banner on screen) → open_center clicks clock to open and again to close
  const floatWin = el("AXWindow", { subrole: "AXSystemFloatingWindow", frame: [1080, 36, 340, 84], wid: 52 }, [banner]);
  const { appEl, calls } = installApp(ctx, { pid: 97, name: "Notification Center", bundle: "com.apple.notificationcenterui", windows: [floatWin], extra: { AXExtrasMenuBar: { el: extrasBar } } });
  const rClosed = ctx.opNotifications({ action: "list", open_center: true });
  check("t10: opNotifications open_center:true when closed (banner-only) clicks clock to open and close",
    rClosed.ok === true && rClosed.center_opened === true && calls.filter((c) => c[1] === "Clock").length === 2,
    JSON.stringify({ rClosed, calls }));
  // 2) Desktop widgets are windows of the same process (macOS 27.2) — no evidence that the center is open
  calls.length = 0;
  const widget = el("AXWindow", { subrole: "AXUnknown", frame: [20, 40, 180, 180], wid: 54 }, [el("AXGroup", { subrole: "AXHostingView" }, [el("AXButton", { title: "W" })])]);
  appEl.kids = [widget, floatWin]; reparent(appEl);
  const rWidget = ctx.opNotifications({ action: "list", open_center: true });
  check("t10 review: widget windows are not an open Notification Center → the clock is clicked (opened, then closed)",
    rWidget.ok === true && rWidget.center_opened === true && rWidget.center_was_open === false && calls.filter((c) => c[1] === "Clock").length === 2,
    JSON.stringify({ rWidget, calls }));
  // 3) Already open (the clock reads selected) → open_center does NOT click clock
  calls.length = 0;
  clockItem.attrs = Object.assign(clockItem.attrs || {}, { AXSelected: true });
  const openWin = el("AXWindow", { title: "Notification Center", frame: [1060, 25, 360, 860], wid: 53 }, [el("AXScrollArea", {}, [banner])]);
  appEl.kids = [openWin]; reparent(appEl);
  const rOpen = ctx.opNotifications({ action: "list", open_center: true });
  check("t10: opNotifications open_center:true when already open does not click clock",
    rOpen.ok === true && rOpen.center_was_open === true && rOpen.center_opened === false && rOpen.count === 1 && calls.length === 0,
    JSON.stringify({ rOpen, calls }));
  // 3) Missing id and notification disappearing during perform → NOTIFICATION_NOT_FOUND
  const rMissing = ctx.opNotifications({ action: "dismiss", id: "no-such-id" });
  const origPerform = ctx.perform;
  ctx.perform = (e, a) => { if (e === banner) { banner.gone = true; return -25202; } return origPerform(e, a); };
  const rVanished = ctx.opNotifications({ action: "dismiss", id: "n-1" });
  check("t10: opNotifications absent or just-dismissed id → NOTIFICATION_NOT_FOUND (not generic error)",
    rMissing.ok === false && rMissing.code === "NOTIFICATION_NOT_FOUND" && rMissing.delivery === "not_delivered"
      && rVanished.ok === false && rVanished.code === "NOTIFICATION_NOT_FOUND" && rVanished.delivery === "not_delivered",
    JSON.stringify({ rMissing, rVanished }));
  // t10 review: a generic failure after which the notification is gone may be the action's own effect → not "not delivered"
  banner.gone = false;
  ctx.perform = (e, a) => { if (e === banner) { banner.gone = true; return -25200; } return origPerform(e, a); };
  const rAmb = ctx.opNotifications({ action: "dismiss", id: "n-1" });
  check("t10 review: action error then notification gone → ACTION_FAILED delivery=unknown (never not_delivered)",
    rAmb.ok === false && rAmb.code === "ACTION_FAILED" && rAmb.delivery === "unknown" && /no longer on screen/.test(rAmb.message),
    JSON.stringify(rAmb));
}

{
  // 0.2.1: frontmost with at:[x,y] also reports the topmost window there (raw-coordinate click guard); without
  // at, or with a malformed one, there is no top key — the server then refuses the click (focus_unknown)
  const ctx = loadEngine(ENGINE);
  installApp(ctx, { pid: 97, name: "Front", windows: [] });
  const seen = [];
  ctx.cgTopAt = (x, y) => { seen.push([x, y]); return { pid: 98, owner: "Banner", layer: 23, wid: 3 }; };
  const withAt = ctx.opFrontmost({ at: [12, 34] });
  const without = ctx.opFrontmost({});
  const bad = ctx.opFrontmost({ at: ["12", 34] });
  check("0.2.1: opFrontmost at:[x,y] → top from cgTopAt; no at / malformed at → no top",
    withAt.top?.owner === "Banner" && withAt.front?.pid === 97 && !("top" in without) && !("top" in bad) && JSON.stringify(seen) === "[[12,34]]",
    JSON.stringify({ withAt, without, bad, seen }));
}

{
  // 0.2.1: opKey posts one key with its flags (modifiers, Fn, keypad); bad input is refused before posting
  const ctx = loadEngine(ENGINE);
  const posted = [];
  const realPostKey = ctx.postKey;
  ctx.postKey = (code, modKeys, extra) => { posted.push([code, modKeys, extra]); return true; };
  const plain = ctx.opKey({ code: 36 });
  const arrow = ctx.opKey({ code: 126, mods: ["cmd", "shift"], fn_key: true, numpad: true });
  const badCode = ctx.opKey({ code: 200 });
  const badMod = ctx.opKey({ code: 36, mods: ["hyper"] });
  ctx.postKey = () => false;
  const noEvent = ctx.opKey({ code: 53 });
  check("0.2.1: opKey modifier keys (cmd 55, shift 56) + Fn/keypad flags, invalid code / modifier refused unsent, event failure not_delivered",
    plain.ok && plain.flags === 0 && arrow.ok && arrow.flags === (0x100000 | 0x20000 | 0x800000 | 0x200000)
      && JSON.stringify(posted) === JSON.stringify([[36, [], 0], [126, [[55, 0x100000], [56, 0x20000]], 0xA00000]])
      && badCode.ok === false && badCode.code === "INVALID_ARGS" && badCode.delivery === "not_delivered"
      && badMod.ok === false && badMod.code === "INVALID_ARGS"
      && noEvent.ok === false && noEvent.code === "ACTION_FAILED" && noEvent.delivery === "not_delivered" && noEvent.retry === "safe",
    JSON.stringify({ plain, arrow, posted, badCode: badCode.code, badMod: badMod.code, noEvent }));

  // the real postKey: modifiers pressed first (flags-changed, cumulative flags), the key down/up with all
  // flags, modifiers released last-first ending at flags 0 — so nothing is left "held" (device run 2026-11-06)
  const evs = [];
  let nextId = 0;
  const made = new Map();
  ctx.$.CGEventCreateKeyboardEvent = (_src, k, down) => { const e = { id: ++nextId, k, down, type: down ? "down" : "up", flags: null }; made.set(e.id, e); return e; };
  ctx.$.CGEventSetType = (e, t) => { if (t === 12) e.type = "flags"; };
  ctx.$.CGEventSetFlags = (e, f) => { e.flags = f; };
  ctx.$.CGEventPost = (_tap, e) => { evs.push(`${e.type}:${e.k}:${e.flags.toString(16)}`); };
  const okPost = realPostKey(126, [[55, 0x100000], [56, 0x20000]], 0xA00000);
  check("0.2.1: postKey sequence cmd↓ shift↓ key↓↑ shift↑ cmd↑, flags explicit and back to 0",
    okPost && JSON.stringify(evs) === JSON.stringify(["flags:55:100000", "flags:56:120000", "down:126:b20000", "up:126:b20000", "flags:56:100000", "flags:55:0"]),
    JSON.stringify(evs));
  evs.length = 0;
  realPostKey(36, [], 0);
  check("0.2.1: postKey plain key sets flags 0 explicitly (never inherits a stale modifier)",
    JSON.stringify(evs) === JSON.stringify(["down:36:0", "up:36:0"]), JSON.stringify(evs));
}

{
  // 0.2.1: web_accessibility reports what the window holds — Chrome refuses AXManualAccessibility but may
  // expose its pages anyway (Chrome started with --force-renderer-accessibility)
  const make = (withWeb) => {
    const ctx = loadEngine(ENGINE);
    const page = withWeb ? [el("AXWebArea", { title: "Page", frame: [0, 80, 400, 300] }, [el("AXButton", { title: "Press me", frame: [10, 90, 80, 20] })])] : [];
    const win = el("AXWindow", { title: "Chrome", frame: [0, 0, 400, 400], wid: 60 }, [el("AXGroup", { frame: [0, 0, 400, 400] }, [el("AXTextField", { title: "Address and search bar", frame: [10, 40, 300, 22] }), ...page])]);
    installApp(ctx, { pid: 99, name: "Google Chrome", windows: [win], focusedWindow: win });
    ctx.rendererOf = () => "chromium";
    ctx.setAttr = (_e, name) => (name === "AXManualAccessibility" ? -25205 : 0);
    return ctx;
  };
  const exposed = make(true).opSnapshot({ app: "Google Chrome" });
  const refused = make(false).opSnapshot({ app: "Google Chrome" });
  const findExposed = make(true).opFind({ app: "Google Chrome", role: "button" });
  const findRefused = make(false).opFind({ app: "Google Chrome", role: "button" });
  const focusedOnly = make(false).webAxStatus("unsupported", null, [], false);
  const enabled = make(false).webAxStatus("enabled", null, [], true);
  check("0.2.1: setter unsupported + web area in the window → 'exposed'; none → 'unsupported' (snapshot and find); non-window or enabled unchanged",
    exposed.web_accessibility === "exposed" && refused.web_accessibility === "unsupported"
      && findExposed.web_accessibility === "exposed" && findExposed.nodes.length === 1 && findRefused.web_accessibility === "unsupported"
      && focusedOnly === "unsupported" && enabled === "enabled",
    JSON.stringify({ exposed: exposed.web_accessibility, refused: refused.web_accessibility, findExposed: findExposed.web_accessibility, findRefused: findRefused.web_accessibility, focusedOnly, enabled }));
}

{
  // 0.2.2 (Reddit r/mcp review): an element from an app-level snapshot is bound to its window's CGWindowID —
  // the same window resolves; a window closed and reopened with the same content (new id) is stale
  const ctx = loadEngine(ENGINE);
  const mk = (wid) => el("AXWindow", { title: "Doc", frame: [0, 0, 400, 300], wid }, [Object.assign(el("AXButton", { title: "Save", frame: [10, 10, 60, 20], actions: ["AXPress"] }), { label: `Save in ${wid}` })]);
  const { appEl } = installApp(ctx, { pid: 120, name: "App", windows: [mk(30)] });
  const res = snap(ctx, { app: "App", surface: "app" });
  const node = nodeAt(res, (n) => n.role === "AXButton");
  const t = targetOf(res, node);
  const same = ctx.resolveTarget(t, 1000);
  appEl.kids[0] = mk(31); reparent(appEl);
  const replaced = ctx.resolveTarget(t, 1000);
  check("0.2.2: app-surface element records its window id; same window resolves, reopened window (new id) → STALE_REF window_replaced",
    res.container?.kind === "app" && node.fp.wwid === 30 && !same.error && same.el.label === "Save in 30"
      && replaced.error?.code === "STALE_REF" && replaced.error.details.kind === "window_replaced",
    `wwid=${node.fp.wwid} same=${tag(same)} replaced=${tag(replaced)}`);
}

{
  // 0.2.2: Finder's desktop (no CGWindowID, frame = bounding box of all displays) keeps the title/frame
  // match; the same id-less window in another app is refused
  const run = (bundle) => {
    const ctx = loadEngine(ENGINE);
    const icon = Object.assign(el("AXImage", { title: "Report.pdf", frame: [1800, 60, 64, 64], actions: ["AXOpen"] }), { label: "icon" });
    const desk = el("AXWindow", { title: "", frame: [-1728, 0, 4288, 1440] }, [el("AXGroup", { frame: [-1728, 0, 4288, 1440] }, [icon])]);
    installApp(ctx, { pid: 130, name: "Finder", bundle, windows: [desk] });
    ctx.runningApps = () => [{ ns: {}, name: "Finder", bundle, pid: 130, policy: 0, active: true, hidden: false }];
    ctx.displays = () => [{ frame: [0, 0, 2560, 1440] }, { frame: [-1728, 0, 1728, 1117] }];
    const res = snap(ctx, { app: "Finder", window: 0 });
    return { res, r: ctx.resolveTarget(targetOf(res, nodeAt(res, (n) => n.role === "AXImage")), 1000) };
  };
  const finder = run("com.apple.finder");
  const other = run("com.example.other");
  check("0.2.2: Finder desktop (no window id) still resolves; an id-less window of another app → policy_denied",
    !finder.r.error && finder.r.el.label === "icon" && !("window_identity" in finder.res)
      && other.r.error?.code === "POLICY_DENIED" && other.res.window_identity === "unverifiable",
    `finder=${tag(finder.r)} other=${tag(other.r)}`);
}

{
  // 0.2.2: after a physical click a vanished element is not proof of delivery (it may have closed in the
  // gap between the hit test and the click); after a semantic action it still is
  const ctx = loadEngine(ENGINE);
  const b = Object.assign(el("AXButton", { title: "Close", frame: [10, 10, 60, 20], actions: ["AXPress"] }), { label: "Close" });
  const win = el("AXWindow", { title: "Dlg", frame: [0, 0, 300, 200], wid: 140 }, [b, el("AXStaticText", { value: "keep", frame: [10, 40, 60, 20] })]);
  const { appEl } = installApp(ctx, { pid: 141, name: "T", windows: [win] });
  const res = snap(ctx, { app: "T" });
  const t = targetOf(res, nodeAt(res, (n) => n.role === "AXButton"));
  const before = ctx.observeState(b, appEl);
  b.gone = true;
  const phys = ctx.opObserveAfter({ target: t, before, physical: true });
  const sem = ctx.opObserveAfter({ target: t, before });
  check("0.2.2: observe_after physical + element gone → delivered_unverified with a note; non-physical gone → delivered_verified (unchanged)",
    phys.delivery === "delivered_unverified" && /may not have been this click/.test(phys.note || "") && sem.delivery === "delivered_verified",
    JSON.stringify({ phys: [phys.delivery, phys.note], sem: sem.delivery }));
  // element still there and changed, but another window is on top at the click point now → not proof
  b.gone = false;
  b.focusedFlag = false;
  const before2 = ctx.observeState(b, appEl);
  b.focusedFlag = true;
  ctx.cgTopAt = () => ({ pid: 999, owner: "Cover", layer: 0, wid: 777 });
  const covered = ctx.opObserveAfter({ target: t, before: before2, physical: true, point: [40, 20], wid: 140 });
  ctx.cgTopAt = () => ({ pid: 141, owner: "T", layer: 0, wid: 140 });
  const own = ctx.opObserveAfter({ target: t, before: before2, physical: true, point: [40, 20], wid: 140 });
  check("0.2.2: observe_after physical + another window on top at the click point → unverified (names it); own window on top → verified",
    covered.delivery === "delivered_unverified" && /"Cover" is on top at 40,20/.test(covered.note || "") && own.delivery === "delivered_verified",
    JSON.stringify({ covered: [covered.delivery, covered.note], own: own.delivery }));
}

{
  // 0.2.2 (R20 follow-up): inconclusive hit test and no window id anywhere → refused, never assumed to be its own window
  const ctx = loadEngine(ENGINE);
  const b = Object.assign(el("AXButton", { title: "Go", frame: [10, 10, 40, 20] }), { label: "Go" });
  const win = el("AXWindow", { title: "W", frame: [0, 0, 300, 200], wid: 150 }, [b]);
  installApp(ctx, { pid: 151, name: "T", windows: [win] });
  ctx.onSomeDisplay = () => true;
  const res = snap(ctx, { app: "T", surface: "app" });
  const t = targetOf(res, nodeAt(res, (n) => n.role === "AXButton"));
  delete t.fp.wwid; // as if the id had not been readable when the element was seen
  ctx.hitTest = () => ({ verdict: "unknown", reason: "no element at the point" });
  ctx.axWindowId = () => null;
  ctx.cgTopAt = () => ({ pid: 151, owner: "T", layer: 0, wid: 152 });
  const r = ctx.opPhysicalPrep({ target: t });
  check("0.2.2: physical_prep inconclusive + no window id → OCCLUDED window_unverifiable (not sent)",
    r.ok === false && r.code === "OCCLUDED" && r.delivery === "not_delivered" && r.details?.occluder?.window_unverifiable === true, JSON.stringify({ ok: r.ok, code: r.code, d: r.details }));
}

// ── CP (Y6): a text verdict needs the change itself — not "the value contains the text somewhere" ──────
{
  const mk = (value, attrs) => {
    const ctx = loadEngine(ENGINE);
    const tf = Object.assign(el("AXTextField", { placeholder: "F", value, frame: [10, 10, 200, 22], settable: { AXSelectedText: true, AXValue: true } }), { label: "F" });
    if (attrs) tf.attrs = attrs;
    const win = el("AXWindow", { title: "W", frame: [0, 0, 300, 200], wid: 41 }, [tf]);
    const { calls } = installApp(ctx, { pid: 91, name: "T", windows: [win] });
    const res = snap(ctx, { app: "T" });
    return { ctx, tf, calls, t: targetOf(res, nodeAt(res, (n) => n.role === "AXTextField")) };
  };
  {
    const m = mk("Hello \r\n");
    const r = m.ctx.opSetValue({ target: m.t, value: "Hello" });
    check("CP: set_value to the value already there (line endings and outer white space aside) → not_delivered already, nothing written",
      r.ok === true && r.delivery === "not_delivered" && r.reason === "already" && r.retry === "safe" && m.calls.length === 0, JSON.stringify(r));
  }
  {
    const m = mk("old");
    m.tf.onSet = (name, v) => { if (name === "AXValue") m.tf.value = String(v) + "\n"; };
    const r = m.ctx.opSetValue({ target: m.t, value: "new" });
    check("CP: set_value changes the value to the target (a trailing newline aside) → delivered_verified",
      r.ok === true && r.delivery === "delivered_verified", JSON.stringify(r));
  }
  {
    const m = mk("Hello world", { AXSelectedTextRange: { location: 5, length: 0 } });
    m.tf.onSet = (name, v) => { if (name === "AXSelectedText") m.tf.value = "Hello" + v + " world"; };
    const r = m.ctx.opInsertText({ target: m.t, text: " big" });
    check("CP: mac_type inserts over the selection → the value is before[0:loc] + text + the rest → delivered_verified",
      r.ok === true && r.delivery === "delivered_verified", JSON.stringify(r));
  }
  {
    // F4: the text was in the field before the write, and the value then changed in some other way
    const m = mk("hello", { AXSelectedTextRange: { location: 5, length: 0 } });
    m.tf.onSet = (name) => { if (name === "AXSelectedText") m.tf.value = "hello "; };
    const r = m.ctx.opInsertText({ target: m.t, text: "hello" });
    check("CP (F4): text already in the field, value changed otherwise → delivered_unverified not_at_insertion_point, never verified",
      r.ok === true && r.delivery === "delivered_unverified" && r.reason === "not_at_insertion_point", JSON.stringify(r));
  }
  {
    const m = mk("abc");
    m.tf.onSet = (name, v) => { if (name === "AXSelectedText") m.tf.value = "abc" + v; };
    const r = m.ctx.opInsertText({ target: m.t, text: "def" });
    check("CP: the insertion point cannot be read → delivered_unverified insertion_point_unreadable, even though the text shows",
      r.ok === true && r.delivery === "delivered_unverified" && r.reason === "insertion_point_unreadable", JSON.stringify(r));
  }
  {
    const m = mk("same text");
    const r = m.ctx.opInsertText({ target: m.t, text: "same text", replace: true });
    check("CP: mac_type replace with the text already there → not_delivered already, nothing written",
      r.ok === true && r.delivery === "not_delivered" && r.reason === "already" && m.calls.length === 0, JSON.stringify(r));
  }
}

// ── CP R35 counterexamples (Grok) ───────────────────────────────────────────────────────────────────
{
  const mk = (value, attrs) => {
    const ctx = loadEngine(ENGINE);
    const tf = Object.assign(el("AXTextField", { placeholder: "F", value, frame: [10, 10, 200, 22], settable: { AXSelectedText: true, AXValue: true } }), { label: "F" });
    if (attrs) tf.attrs = attrs;
    const win = el("AXWindow", { title: "W", frame: [0, 0, 300, 200], wid: 42 }, [tf]);
    const { calls } = installApp(ctx, { pid: 92, name: "T", windows: [win] });
    const res = snap(ctx, { app: "T" });
    return { ctx, tf, calls, t: targetOf(res, nodeAt(res, (n) => n.role === "AXTextField")) };
  };
  const say = (r) => JSON.stringify({ ok: r.ok, code: r.code, delivery: r.delivery, reason: r.reason });
  for (const v of ["", " "]) {
    const m = mk(0);
    const r = m.ctx.opSetValue({ target: m.t, value: v });
    check(`CP R35: numeric field at 0, set_value ${JSON.stringify(v)} → neither already nor verified (an empty string is not the number 0)`,
      r.delivery !== "delivered_verified" && r.reason !== "already" && !m.calls.some((c) => typeof c[3] === "number"), `${say(r)} writes=${JSON.stringify(m.calls)}`);
  }
  {
    const m = mk(" hello ");
    const r = m.ctx.opSetValue({ target: m.t, value: "hello" });
    check("CP R35: \" hello \" set to \"hello\" → not_delivered already, no AXValue write", r.delivery === "not_delivered" && r.reason === "already" && m.calls.length === 0, say(r));
  }
  {
    const m = mk("hello world");
    const r = m.ctx.opSetValue({ target: m.t, value: "hello" });
    check("CP R35: \"hello world\" set to \"hello\", the app ignores the write → not verified", r.delivery !== "delivered_verified", say(r));
  }
  {
    const m = mk("abcd", { AXSelectedTextRange: { location: 1, length: 0 } });
    m.tf.onSet = (name, v) => { if (name === "AXSelectedText") m.tf.value = "a" + v + "bcd"; };
    const r = m.ctx.opInsertText({ target: m.t, text: "XY" });
    check("CP R35: \"abcd\" at {1,0} + XY → \"aXYbcd\" → delivered_verified", r.delivery === "delivered_verified" && r.reason === undefined, say(r));
  }
  {
    const m = mk("abcd", { AXSelectedTextRange: { location: 1, length: 0 } });
    m.tf.onSet = (name, v) => { if (name === "AXSelectedText") m.tf.value = "abcd" + v; };
    const r = m.ctx.opInsertText({ target: m.t, text: "XY" });
    check("CP R35: \"abcd\" at {1,0} + XY → \"abcdXY\" → delivered_unverified not_at_insertion_point", r.delivery === "delivered_unverified" && r.reason === "not_at_insertion_point", say(r));
  }
  {
    const m = mk("abcd");
    m.tf.onSet = (name, v) => { if (name === "AXSelectedText") m.tf.value = "abcd" + v; };
    const r = m.ctx.opInsertText({ target: m.t, text: "XY" });
    check("CP R35: no readable range, after equals before + text → delivered_unverified insertion_point_unreadable", r.delivery === "delivered_unverified" && r.reason === "insertion_point_unreadable", say(r));
  }
  {
    const m = mk("PAYLOAD", { AXSelectedTextRange: { location: 7, length: 0 } });
    const r = m.ctx.opInsertText({ target: m.t, text: "PAYLOAD" });
    check("CP R35 (F4): value already PAYLOAD and still only PAYLOAD after the write → not verified", r.delivery !== "delivered_verified", say(r));
  }
}

{
  // R36: append through AXValue when the value cannot be read would replace it → refused, nothing written
  const ctx = loadEngine(ENGINE);
  const tf = Object.assign(el("AXTextArea", { frame: [10, 10, 200, 80], settable: { AXValue: true } }), { label: "Area" });
  const win = el("AXWindow", { title: "W", frame: [0, 0, 300, 200], wid: 43 }, [tf]);
  const { calls } = installApp(ctx, { pid: 93, name: "T", windows: [win] });
  const res = snap(ctx, { app: "T" });
  const r = ctx.opInsertText({ target: targetOf(res, nodeAt(res, (n) => n.role === "AXTextArea")), text: "XY" });
  check("CP R36: append path with an unreadable value → ACTION_NOT_SUPPORTED not_delivered, nothing written (no clobbering)",
    r.ok === false && r.code === "ACTION_NOT_SUPPORTED" && r.delivery === "not_delivered" && calls.length === 0, JSON.stringify({ ok: r.ok, code: r.code, delivery: r.delivery, calls }));
}

{
  // E2 run 2026-11-07 (T11): on macOS 27 the Dock is one full-display overlay window; a point over the strip
  // the Dock reserves must read as covered by the Dock, not as the window behind it
  const ctx = loadEngine(ENGINE);
  // AppKit coordinates: main 2560×1440 with a 66-pt Dock at the bottom; a second display on the left with no Dock
  const strips = ctx.dockStripsOf([{ f: [0, 0, 2560, 1440], v: [0, 66, 2560, 1349] }, { f: [-1728, 0, 1728, 1117], v: [-1728, 0, 1728, 1092] }]);
  const left = ctx.dockStripsOf([{ f: [0, 0, 1000, 800], v: [70, 0, 930, 775] }]);
  const right = ctx.dockStripsOf([{ f: [0, 0, 1000, 800], v: [0, 0, 930, 775] }]);
  check("E2 T11: dockStripsOf — bottom Dock strip in top-left coordinates; no strip for a display without a Dock; left / right Docks",
    JSON.stringify(strips) === "[[0,1374,2560,66]]" && JSON.stringify(left) === "[[0,25,70,775]]" && JSON.stringify(right) === "[[930,25,70,775]]",
    JSON.stringify({ strips, left, right }));
  // a fake window list, front to back: the Dock's full-display overlay, then a TextEdit window reaching into the strip
  const win = (owner, pid, layer, b, wid) => ({ kCGWindowOwnerName: owner, kCGWindowOwnerPID: pid, kCGWindowLayer: layer, kCGWindowAlpha: 1, kCGWindowNumber: wid, kCGWindowBounds: { X: b[0], Y: b[1], Width: b[2], Height: b[3] } });
  const rows = [win("Dock", 20, 20, [0, 0, 2560, 1440], 80), win("TextEdit", 30, 0, [1030, 1257, 500, 300], 90)];
  const box = (v) => ({ isNil: () => v === undefined, js: v, objectForKey: (k) => box(v?.[k]) });
  ctx.cast = () => ({ count: rows.length, objectAtIndex: (i) => box(rows[i]) });
  ctx.ks = (k) => k;
  ctx.displays = () => [{ frame: [0, 0, 2560, 1440] }];
  ctx.dockStrips = () => [[0, 1374, 2560, 66]];
  const under = ctx.cgTopAt(1280, 1407), beside = ctx.cgTopAt(1040, 1400), above = ctx.cgTopAt(1280, 1300);
  check("E2 T11: cgTopAt — under the Dock strip → the Dock (also beside its platter); above it → the window",
    under?.owner === "Dock" && under?.layer === 20 && beside?.owner === "Dock" && above?.owner === "TextEdit",
    JSON.stringify({ under, beside, above }));
  // E2 T10: a banner shows → Notification Center's full-display overlay sits on top; only the banner covers
  rows.unshift(win("Notification Center", 11, 23, [0, 0, 2560, 1440], 40));
  ctx.ncDrawnRects = () => [[2186, 36, 368, 88]];
  const mid = ctx.cgTopAt(1280, 700), onBanner = ctx.cgTopAt(2400, 70), dock = ctx.cgTopAt(1280, 1407);
  ctx.ncDrawnRects = () => null; // the list is open, or the banner frames cannot be read
  const unsure = ctx.cgTopAt(1280, 700);
  check("E2 T10: cgTopAt — Notification Center's overlay covers only its banners; when they cannot be told, everything",
    mid === null && onBanner?.owner === "Notification Center" && dock?.owner === "Dock" && unsure?.owner === "Notification Center",
    JSON.stringify({ mid, onBanner, dock, unsure }));
}

{
  // E2 T10: ncDrawnRects reads banner / alert frames from Notification Center's accessibility tree
  const ctx = loadEngine(ENGINE);
  const banner = el("AXGroup", { subrole: "AXNotificationCenterBanner", frame: [2190, 40, 360, 80] });
  const win = el("AXWindow", { title: "", frame: [0, 0, 2560, 1440], wid: 40 }, [el("AXGroup", {}, [banner])]);
  installApp(ctx, { pid: 11, name: "Notification Center", bundle: "com.apple.notificationcenterui", windows: [win] });
  const rects = ctx.ncDrawnRects();
  const panelCtx = loadEngine(ENGINE);
  const panel = el("AXWindow", { title: "", frame: [0, 0, 2560, 1440], wid: 41 }, [el("AXGroup", { subrole: "AXNotificationCenterWidget", frame: [2100, 40, 400, 900] })]);
  installApp(panelCtx, { pid: 12, name: "Notification Center", bundle: "com.apple.notificationcenterui", windows: [panel] });
  check("E2 T10: ncDrawnRects — a banner's frame (with a 4-pt margin); an open list or another NC element → null",
    JSON.stringify(rects) === "[[2186,36,368,88]]" && panelCtx.ncDrawnRects() === null, JSON.stringify({ rects, panel: panelCtx.ncDrawnRects() }));
}
done("engine unit");

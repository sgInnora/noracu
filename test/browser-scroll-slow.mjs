// browser_scroll when Chromium is slow to answer the wheel. The real server (browser layer, headless) runs twice:
// as usual, and at background priority (`taskpolicy -b`), which is how macOS runs a launchd job that has no
// ProcessType — the CI runner's, for one. There the page got the wheel 0.2–0.7 s after mouse.wheel returned
// (measured 2026-11-19), and browser_scroll, which read the position 80 ms after the wheel, said "did not move" for a
// scroll that went through, verified the late scroll of the call before as its own, and missed a navigation the
// wheel started. macOS only (taskpolicy); nothing here touches this Mac's keyboard, mouse or screen (the browsers
// are headless). Run: node test/browser-scroll-slow.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

if (process.platform !== "darwin") { console.log("browser scroll on a slow Chromium: skipped — not macOS"); process.exit(0); }
const SERVER = fileURLToPath(new URL("../src/server.mjs", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "noracu-scroll-"));
const html = (name, body) => { writeFileSync(join(dir, name), `<!doctype html><html><head><meta charset='utf-8'><title>${name}</title></head>${body}</html>`); return pathToFileURL(join(dir, name)).href; };
const tall = html("tall.html", `<body style='height:3200px'>${Array.from({ length: 125 }, (_, i) => `<button style='display:block;margin:8px'>Item ${i}</button>`).join("")}</body>`);
// a page that answers the wheel by moving the other way, one that navigates on it, one that swallows it
const wrong = html("wrong.html", `<body style='height:6000px;margin:0'><p>tall</p><script>addEventListener('wheel', (e) => { e.preventDefault(); scrollTo(0, 300); }, { passive: false }); scrollTo(0, 1500);</script></body>`);
html("next.html", `<body style='height:6000px'><p>next</p></body>`);
const leaves = html("leaves.html", `<body style='height:6000px;margin:0'><p>tall</p><script>addEventListener('wheel', () => { location.href = 'next.html'; }); scrollTo(0, 1500);</script></body>`);
const swallows = html("swallows.html", `<body style='height:6000px;margin:0'><p>tall</p><script>addEventListener('wheel', (e) => e.preventDefault(), { passive: false });</script></body>`);
// a frame over the middle of the page (the wheel goes to its document), the same inside a shadow root, a page that
// keeps the wheel from every listener after its own and scrolls, and one that keeps it and does not scroll
html("inner.html", `<body style='height:5000px'>inner</body>`);
const framed = html("framed.html", `<body style='height:3000px;margin:0'><iframe src='inner.html' style='position:fixed;left:0;top:0;width:100%;height:100%;border:0'></iframe></body>`);
const shadowFramed = html("shadow-framed.html", `<body style='height:3000px;margin:0'><div id='h'></div><script>document.getElementById('h').attachShadow({ mode: 'open' }).innerHTML = "<iframe src='inner.html' style='position:fixed;left:0;top:0;width:100%;height:100%;border:0'></iframe>";</script></body>`);
const hides = html("hides.html", `<body style='height:6000px;margin:0'><p>tall</p><script>addEventListener('wheel', (e) => e.stopImmediatePropagation(), { capture: true });</script></body>`);
const hidesStill = html("hides-still.html", `<body style='height:6000px;margin:0'><p>tall</p><script>addEventListener('wheel', (e) => { e.stopImmediatePropagation(); e.preventDefault(); }, { capture: true, passive: false });</script></body>`);
// a frame that keeps the wheel and tells the page around it, which then scrolls itself down: a movement the asked
// way that is not the wheel's
html("tells.html", `<body style='height:5000px'>inner<script>addEventListener('wheel', (e) => { e.preventDefault(); parent.postMessage('wheel', '*'); }, { passive: false });</script></body>`);
const frameTells = html("frame-tells.html", `<body style='height:3000px;margin:0'><iframe src='tells.html' style='position:fixed;left:0;top:0;width:100%;height:100%;border:0'></iframe><script>addEventListener('message', () => scrollTo(0, 700));</script></body>`);
// a frame that cannot scroll, over a tall page: the wheel goes to the frame and on to the page around it
html("short.html", `<body style='margin:0;height:100px;overflow:hidden'>short</body>`);
const chains = html("chains.html", `<body style='height:6000px;margin:0'><iframe src='short.html' style='position:fixed;left:0;top:0;width:100%;height:100%;border:0'></iframe></body>`);
// an <object> that shows an image: the call finds it at the point as it would a frame, but the wheel reaches the
// page itself, which reports it and scrolls
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const objectImage = html("object-image.html", `<body style='height:6000px;margin:0'><object data='${PNG}' type='image/png' style='position:fixed;left:0;top:0;width:100%;height:100%'></object></body>`);
// pages that act on a wheel 1.5 s later (and not at once), two calls one after the other: one that scrolls down
// whichever way the wheel went; one that cannot scroll until then (it grows first); one whose first wheel listener
// also blocks the page for 6 s, so that mouse.wheel itself gives no answer within its 5 s
const delayed = html("delayed.html", `<body style='height:6000px;margin:0'><p>tall</p><script>let k = 0; addEventListener('wheel', (e) => { e.preventDefault(); if (k++ === 0) setTimeout(() => scrollBy(0, 600), 1500); }, { passive: false });</script></body>`);
const grows = html("grows.html", `<body style='margin:0'><div id='c' style='height:10px'>short</div><script>let k = 0; addEventListener('wheel', (e) => { e.preventDefault(); if (k++ === 0) setTimeout(() => { document.getElementById('c').style.height = '6000px'; scrollBy(0, 600); }, 1500); }, { passive: false });</script></body>`);
// a page the tab leaves once a call on it has ended: the next page starts afresh
html("lands.html", `<body style='height:6000px;margin:0'><p>landed</p></body>`);
const goesOn = html("goes-on.html", `<body style='height:6000px;margin:0'><p>tall</p><script>window.goOn = () => { location.href = 'lands.html'; };</script></body>`);
const blocks = html("blocks.html", `<body style='height:6000px;margin:0'><p>tall</p><script>let k = 0; addEventListener('wheel', (e) => { e.preventDefault(); if (k++ === 0) { const t = Date.now(); while (Date.now() - t < 6000) {} setTimeout(() => scrollBy(0, 600), 500); } }, { passive: false });</script></body>`);
// a history.pushState on the first wheel, and a scroll 0.6 s later: the call that sent that wheel ends at once (the
// page navigated), the document stays, and the scroll comes in the next call
const pushes = html("pushes.html", `<body style='height:6000px;margin:0'><p>tall</p><script>let k = 0; addEventListener('wheel', (e) => { e.preventDefault(); if (k++ === 0) { history.pushState({}, '', '#moved'); setTimeout(() => scrollBy(0, 600), 600); } }, { passive: false });</script></body>`);
// a page that deletes window.__noracu_scroll_doubt on every wheel (noracu keeps nothing there: its state is the
// server's), and scrolls 1.5 s after the first
const erases = html("erases.html", `<body style='height:6000px;margin:0'><p>tall</p><script>let k = 0; addEventListener('wheel', (e) => { e.preventDefault(); delete window.__noracu_scroll_doubt; if (k++ === 0) setTimeout(() => scrollBy(0, 600), 1500); }, { passive: false });</script></body>`);
// a page whose document.elementFromPoint throws once: the first call fails before any input, the second scrolls
const failsOnce = html("fails-once.html", `<body style='height:6000px;margin:0'><p>tall</p><script>const efp = document.elementFromPoint.bind(document); let once = true; document.elementFromPoint = (x, y) => { if (once) { once = false; throw new Error('not now'); } return efp(x, y); };</script></body>`);
// a page whose mousemove listener, once armed, holds the page for 3 s: moving the pointer waits for it
const holdsMove = html("holds-move.html", `<body style='height:6000px;margin:0'><p>tall</p><script>window.__arm = false; addEventListener('mousemove', () => { if (window.__arm) { window.__arm = false; const t = Date.now(); while (Date.now() - t < 3000) {} } });</script></body>`);
// a page 1600 px tall in an 800 px viewport: down to its end, up, down again
const shortPage = html("short-page.html", `<body style='height:1600px;margin:0'><p style='margin:0'>short</p></body>`);
// a page that keeps the first wheel from scrolling and lets the second through: two calls at once
const firstKept = html("first-kept.html", `<body style='height:6000px;margin:0'><p>tall</p><script>let k = 0; addEventListener('wheel', (e) => { if (k++ === 0) e.preventDefault(); }, { passive: false });</script></body>`);
// a page whose script hands every wheel on as one of its own (as some scrolling libraries do), and scrolls
const redispatch = html("redispatch.html", `<body style='height:6000px;margin:0'><p>tall</p><script>addEventListener('wheel', (e) => { if (e.isTrusted) dispatchEvent(new WheelEvent('wheel', { deltaY: e.deltaY })); }, { passive: true });</script></body>`);

// pages over http: for a browser with the back-forward cache on (the cache keeps no file:// page), one whose second
// wheel scrolls it, and which, as it is put in the cache, deletes window.__noracu_scroll_doubt; and one that, once
// the pointer is in the middle of the page, holds for 2 s any name noracu defines on its window, and says so first
// (a beacon, which goes out while the page is held)
let heldWait = [];
const heldSignal = () => new Promise((r) => heldWait.push(r));
// a page that goes on to a third site at once and holds its renderer 2 s (two pages committed in a row), and the third
const PAGES = {
  "/chain-b": () => `<body><p>b</p><script>location.replace('http://localhost:${web.address().port}/chain-c'); const t = Date.now(); while (Date.now() - t < 2000) {}</script></body>`,
  "/chain-c": "<body style='height:6000px;margin:0'><p>c</p></body>",
  "/bf-a": "<body style='height:6000px;margin:0'><p>a</p><script>let k = 0; addEventListener('wheel', (e) => { e.preventDefault(); if (k++ === 1) scrollBy(0, 600); }, { passive: false }); addEventListener('pageshow', (e) => { window.__persisted = e.persisted; }); addEventListener('pagehide', () => { delete window.__noracu_scroll_doubt; });</script></body>",
  "/holds-mark": "<body style='height:6000px;margin:0'><p>tall</p><script>let moved = false; addEventListener('mousemove', (e) => { if (e.clientX > 100) moved = true; }, { capture: true }); const dp = Object.defineProperty; Object.defineProperty = function (o, k, d) { if (moved && o === window && String(k).startsWith('__noracu')) { navigator.sendBeacon('/held'); const t = Date.now(); while (Date.now() - t < 2000) {} } return dp.call(Object, o, k, d); };</script></body>",
};
const web = http.createServer((req, res) => {
  if (req.url === "/held") {
    const w = heldWait;
    heldWait = [];
    w.forEach((r) => r());
    res.writeHead(204);
    return res.end();
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  const body = typeof PAGES[req.url] === "function" ? PAGES[req.url]() : PAGES[req.url];
  res.end(`<!doctype html><title>${req.url.slice(1)}</title>${body || `<body>${req.url.slice(1)}</body>`}`);
});
await new Promise((r) => web.listen(0, "127.0.0.1", r));
const WEB = `http://127.0.0.1:${web.address().port}`;
// a page that keeps the wheel from every listener after its own, goes to another site (127.0.0.1) at once and holds
// its renderer 2 s; that page goes on to a third site (localhost) the same way: the wheel may still be on its way
// while both commit
const chainA = html("chain-a.html", `<body style='height:6000px;margin:0'><p>a</p><script>addEventListener('wheel', (e) => { e.stopImmediatePropagation(); location.href = '${WEB}/chain-b'; const t = Date.now(); while (Date.now() - t < 2000) {} }, { capture: true });</script></body>`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Chrome for Testing in headless mode, the back-forward cache on as in a person's own Chrome, its DevTools on a port
async function cachingChrome() {
  const prof = mkdtempSync(join(tmpdir(), "noracu-bf-"));
  const p = spawn(chromium.executablePath(), ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${prof}`, "--no-first-run", "--no-default-browser-check", "--use-mock-keychain", `${WEB}/start`], { stdio: "ignore" });
  // its helper processes go a moment after it and can still write to the profile: wait for it to exit, retry the
  // removal, and let a profile left in the temporary folder not fail the run
  const exited = new Promise((r) => p.once("exit", r));
  const stop = async () => {
    try { p.kill("SIGKILL"); } catch { /* gone */ }
    await Promise.race([exited, sleep(5000)]);
    try { rmSync(prof, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* left in tmp */ }
  };
  for (let i = 0; i < 150; i++) {
    try {
      const port = readFileSync(join(prof, "DevToolsActivePort"), "utf8").split("\n")[0].trim();
      if (/^\d+$/.test(port)) return { port: Number(port), stop };
    } catch { /* not yet */ }
    await sleep(100);
  }
  await stop();
  throw new Error("Chrome for Testing wrote no DevToolsActivePort in 15 s");
}

// browser_evaluate is on here only to look for what a call left on the page and to wait for the page; the stop file
// is made by three cases; the DevTools attach is to the Chrome this test starts
const STOP = join(dir, "stop");
const ENV = { ...process.env, NORACU_LAYERS: "browser", NORACU_ALLOW_FILE_URL: "1", NORACU_ENABLE_EVAL: "1", NORACU_STOP_FILE: STOP, NORACU_ALLOW_CDP: "any" };
delete ENV.NORACU_DISABLE_EVAL;
function server(background) {
  const p = background
    ? spawn("/usr/sbin/taskpolicy", ["-b", process.execPath, SERVER], { stdio: ["pipe", "pipe", "pipe"], env: ENV })
    : spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"], env: ENV });
  let buf = "", id = 0;
  const waiting = new Map();
  p.stderr.on("data", () => {});
  p.stdout.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      try { const m = JSON.parse(line); if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } } catch { /* not ours */ }
    }
  });
  const rpc = (method, params) => new Promise((res) => { const n = ++id; waiting.set(n, res); p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"); });
  const call = async (name, args = {}) => String((await rpc("tools/call", { name, arguments: args })).result?.content?.[0]?.text ?? "");
  const exited = new Promise((r) => p.on("exit", r));
  return { rpc, call, async close() { p.stdin.end(); await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))]); try { p.kill("SIGKILL"); } catch { /* gone */ } } };
}

const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? "✅" : "❌"} ${name} | ${String(detail).replace(/\s+/g, " ").slice(0, 700)}`); };
for (const background of [false, true]) {
  const how = background ? "at background priority" : "as usual";
  const s = server(background);
  try {
    await s.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "browser-scroll-slow" } });
    await s.call("browser_launch", { headless: true });
    await s.call("browser_navigate", { url: tall });
    let t = Date.now();
    const down = await s.call("browser_scroll", { direction: "down", pages: 1 });
    const downMs = Date.now() - t;
    check(`${how}: a scroll down from the top is verified, with the position it reached`, /scrollY 0 → [1-9]\d*/.test(down) && down.includes("delivery=delivered_verified"), `${downMs} ms: ${down}`);
    await s.call("browser_scroll", { direction: "up", pages: 2 });
    t = Date.now();
    const top = await s.call("browser_scroll", { direction: "up", pages: 1 });
    check(`${how}: a scroll up at the top did not move — the scroll before it is not taken for this one`, top.includes("did not move") && top.includes("delivery=delivered_unverified"), `${Date.now() - t} ms: ${top}`);
    // a request for less than a pixel (a 2500th of a page): no pixel moves, nothing is verified
    await s.call("browser_navigate", { url: tall });
    const tiny = await s.call("browser_scroll", { direction: "down", pages: 0.0004 });
    check(`${how}: a scroll of under a pixel moves nothing and is not verified`, tiny.includes("scrollY 0 → 0") && !tiny.includes("delivered_verified"), tiny);
    await s.call("browser_navigate", { url: wrong });
    const w = await s.call("browser_scroll", { direction: "down" });
    check(`${how}: a page that moves the other way on the wheel is not verified, and the result says so`, w.includes("scrollY 1500 → 300") && w.includes("but not down") && w.includes("delivery=delivered_unverified"), w);
    await s.call("browser_navigate", { url: leaves });
    const n = await s.call("browser_scroll", { direction: "down" });
    // whether the navigation shows in a read or cuts one short, the wheel went out: not an error, not verified
    check(`${how}: a page that navigates on the wheel is not verified, and the result says it navigated`, /navigated/.test(n) && !n.startsWith("ERROR") && n.includes("delivery=delivered_unverified"), n);
    await s.call("browser_navigate", { url: swallows });
    const sw = await s.call("browser_scroll", { direction: "down" });
    check(`${how}: a page that takes the wheel and does not move: did not move, not verified`, sw.includes("did not move") && sw.includes("delivery=delivered_unverified"), sw);
    for (const [what, url] of [["a frame", framed], ["a frame inside a shadow root", shadowFramed]]) {
      await s.call("browser_navigate", { url });
      t = Date.now();
      const fr = await s.call("browser_scroll", { direction: "down" });
      const frMs = Date.now() - t;
      // the text names the frame's 1.5 s window, not the 3 s wait for the page to report the wheel
      check(`${how}: the wheel over ${what}: the page itself did not move, not verified, said without waiting the 3 s for the page to report the wheel`, fr.includes("did not move") && fr.includes("in the 1.5 s after the wheel was sent") && fr.includes("over a frame") && fr.includes("delivery=delivered_unverified"), `${frMs} ms: ${fr}`);
    }
    await s.call("browser_navigate", { url: hides });
    t = Date.now();
    const hd = await s.call("browser_scroll", { direction: "down" });
    const hdMs = Date.now() - t;
    check(`${how}: a page that moves but never reports the wheel: not verified, said once it has stopped`, hd.includes("scrollY 0 → 600") && hd.includes("did not report the wheel") && hd.includes("delivery=delivered_unverified") && hdMs < 2500, `${hdMs} ms: ${hd}`);
    await s.call("browser_navigate", { url: hidesStill });
    t = Date.now();
    const hs = await s.call("browser_scroll", { direction: "down" });
    const hsMs = Date.now() - t;
    check(`${how}: a page that neither moves nor reports the wheel: delivery unknown after 3 s, it may still arrive`, hs.includes("did not move") && hs.includes("may still arrive") && hs.includes("delivery=unknown") && hsMs >= 3000, `${hsMs} ms: ${hs}`);
    await s.call("browser_navigate", { url: frameTells });
    const ft = await s.call("browser_scroll", { direction: "down" });
    check(`${how}: the wheel over a frame, and the page around it scrolls itself down: not verified, the result says so`, ft.includes("over a frame") && !ft.includes("delivered_verified") && ft.includes("delivery=delivered_unverified"), ft);
    // the page around the frame moves when the frame passes the wheel on (late at background priority): the call
    // reads that movement, does not verify it, and the call after it starts from where it ended
    await s.call("browser_navigate", { url: chains });
    const c1 = await s.call("browser_scroll", { direction: "down" });
    const c2 = await s.call("browser_scroll", { direction: "down" });
    check(`${how}: a frame that cannot scroll passes the wheel to the page around it: the call reads the page's movement, neither call is verified`, /scrollY 0 → [1-9]/.test(c1) && c1.includes("over a frame") && !/scrollY 0 →/.test(c2) && !c1.includes("delivered_verified") && !c2.includes("delivered_verified"), `${c1} || ${c2}`);
    await s.call("browser_navigate", { url: firstKept });
    const [one, two] = await Promise.all([s.call("browser_scroll", { direction: "down" }), s.call("browser_scroll", { direction: "down" })]);
    // the second call reads its own window: 0 → 600; it is not verified, as the first wheel had shown no effect
    check(`${how}: two calls at once on one page take turns: the first wheel was kept (did not move), the second scrolled and is not taken for its own`, one.includes("scrollY 0 → 0") && one.includes("did not move") && one.includes("delivery=delivered_unverified") && /scrollY 0 → [1-9]/.test(two) && two.includes("an earlier wheel that may have reached this page was not verified") && two.includes("delivery=delivered_unverified"), `${one} || ${two}`);
    await s.call("browser_navigate", { url: objectImage });
    const ob = await s.call("browser_scroll", { direction: "down" });
    check(`${how}: an <object> image at the point: the page reports one wheel and scrolls, and the call still does not verify`, /scrollY 0 → [1-9]/.test(ob) && ob.includes("over a frame") && ob.includes("delivery=delivered_unverified"), ob);
    // a later effect of a wheel that was not verified is not taken for the next call's own: the same way, the other
    // way, on a page that could not scroll at first, and after a wheel that mouse.wheel did not answer for
    for (const [what, url, first] of [["the same way", delayed, "down"], ["the other way", delayed, "up"], ["on a page that could not scroll then", grows, "down"], ["after a wheel the page held for 6 s", blocks, "down"], ["after the page changed its address in place", pushes, "down"], ["after the page deleted a name noracu might use", erases, "down"]]) {
      await s.call("browser_navigate", { url });
      const d1 = await s.call("browser_scroll", { direction: first });
      const d2 = await s.call("browser_scroll", { direction: "down" });
      // the first call may still see its own wheel's late movement (on a slow machine its window ends later): then
      // it is its own, and the second wheel has none; what must not happen is the second call verifying the first
      // one's movement
      check(`${how}: a page that acts on a wheel later, ${what}: the next call does not take that movement for its own`, !d2.includes("delivered_verified") && /delivery=(delivered_unverified|unknown)/.test(d2), `${d1} || ${d2}`);
    }
    // a page the tab leaves after a call on it has ended: that call saw its wheel handled, and the next page starts
    // afresh
    await s.call("browser_navigate", { url: goesOn });
    const g1 = await s.call("browser_scroll", { direction: "down" });
    await s.call("browser_evaluate", { js: "goOn(), 1" });
    let at = "";
    for (let i = 0; i < 50 && !at.includes("lands.html"); i++) { await sleep(100); at = await s.call("browser_evaluate", { js: "location.href" }); }
    const g2 = await s.call("browser_scroll", { direction: "down" });
    check(`${how}: the page the tab goes to after a call that saw its wheel: the next scroll there is verified`, at.includes("lands.html") && g1.includes("delivery=delivered_verified") && /scrollY 0 → [1-9]/.test(g2) && g2.includes("delivery=delivered_verified"), `${g1} || ${g2}`);
    // two pages committed in a row while the wheel may still be on its way are both in doubt; the page after them,
    // loaded once a call there saw its own wheel handled, starts afresh
    await s.call("browser_navigate", { url: chainA });
    const h1 = await s.call("browser_scroll", { direction: "down" });
    let at2 = "";
    for (let i = 0; i < 80 && !at2.includes("/chain-c"); i++) { await sleep(100); at2 = await s.call("browser_evaluate", { js: "location.href" }); }
    const h2 = await s.call("browser_scroll", { direction: "down" });
    await s.call("browser_navigate", { url: tall });
    const h3 = await s.call("browser_scroll", { direction: "down" });
    check(`${how}: two pages committed in a row while a wheel may be on its way: the scroll on the second is not verified, and the page after it starts afresh`, at2.includes("/chain-c") && h1.includes("navigated") && h1.includes("delivery=delivered_unverified") && /scrollY 0 → [1-9]/.test(h2) && h2.includes("an earlier wheel that may have reached this page was not verified") && h2.includes("delivery=delivered_unverified") && /scrollY 0 → [1-9]/.test(h3) && h3.includes("delivery=delivered_verified"), `${h1} || ${h2} || ${h3}`);
    // a wheel over a frame is not verified, but once the call has ended it is no longer on its way: the page loaded
    // next starts afresh
    await s.call("browser_navigate", { url: framed });
    const fr1 = await s.call("browser_scroll", { direction: "down" });
    await s.call("browser_navigate", { url: tall });
    const fr2 = await s.call("browser_scroll", { direction: "down" });
    check(`${how}: after a wheel over a frame, the page loaded next starts afresh: its scroll is verified`, fr1.includes("over a frame") && fr1.includes("delivery=delivered_unverified") && /scrollY 0 → [1-9]/.test(fr2) && fr2.includes("delivery=delivered_verified"), `${fr1} || ${fr2}`);
    // in a document where a wheel was not verified, nothing after it is (the end of the page included); a new
    // document starts afresh
    await s.call("browser_navigate", { url: shortPage });
    const sp = [];
    for (const direction of ["down", "down", "down", "up"]) sp.push(await s.call("browser_scroll", { direction }));
    await s.call("browser_navigate", { url: shortPage });
    sp.push(await s.call("browser_scroll", { direction: "down" }));
    check(`${how}: down to the end of a page (verified, verified, did not move), up (not verified: the wheel before it was not), and down on the page loaded again (verified)`, sp[0].includes("delivery=delivered_verified") && sp[1].includes("delivery=delivered_verified") && sp[2].includes("did not move") && sp[2].includes("scrollY 800 → 800") && sp[3].includes("scrollY 800 → 200") && sp[3].includes("an earlier wheel that may have reached this page was not verified") && sp[4].includes("scrollY 0 → 600") && sp[4].includes("delivery=delivered_verified"), sp.map((t) => `${t.match(/scrollY \d+ → \d+/)?.[0]} ${t.match(/delivery=\w+/)?.[0]}`).join(" | "));
    await s.call("browser_navigate", { url: redispatch });
    const rd = await s.call("browser_scroll", { direction: "down" });
    check(`${how}: a page that hands the wheel on as an event of its own: only the trusted one counts, verified`, /scrollY 0 → [1-9]/.test(rd) && rd.includes("delivery=delivered_verified"), rd);
    // a call that waits for its turn is checked again when the turn comes: the stop file made while it waited stops it
    await s.call("browser_navigate", { url: hidesStill });
    const slow = s.call("browser_scroll", { direction: "down" });
    await new Promise((r) => setTimeout(r, 400));
    const waiting = s.call("browser_scroll", { direction: "down" });
    await new Promise((r) => setTimeout(r, 400));
    writeFileSync(STOP, "");
    const [, stopped] = await Promise.all([slow, waiting]);
    rmSync(STOP, { force: true });
    check(`${how}: the stop file made while a call waited for its turn stops it: nothing sent`, stopped.includes("user_stopped") && stopped.includes("delivery=not_delivered"), stopped);
    // the stop file made while a call waits for the page before its wheel: checked again right before the wheel (a
    // script that holds the page for 2 s, sent together with the scroll, makes the scroll's first reads wait)
    await s.call("browser_navigate", { url: tall });
    const hold = s.call("browser_evaluate", { js: "(() => { const t = Date.now(); while (Date.now() - t < 2000) {} return 1; })()" });
    const mv = s.call("browser_scroll", { direction: "down" });
    await new Promise((r) => setTimeout(r, 300));
    writeFileSync(STOP, "");
    const [, mvR] = await Promise.all([hold, mv]);
    rmSync(STOP, { force: true });
    check(`${how}: the stop file made while a call waited for the page before its wheel stops it: nothing sent`, mvR.includes("user_stopped") && mvR.includes("delivery=not_delivered"), mvR);
    // nothing noracu runs in the page sits between the last stop check and the wheel: a page that holds such a step
    // (and says so as it starts) would have the stop file made then come too late
    await s.call("browser_navigate", { url: `${WEB}/holds-mark` });
    await s.call("browser_click", { xy: [5, 5] });
    const heldNow = heldSignal();
    const hmCall = s.call("browser_scroll", { direction: "down" });
    const hmFirst = await Promise.race([heldNow.then(() => "held"), hmCall.then(() => "done")]);
    if (hmFirst === "held") writeFileSync(STOP, "");
    const hm = await hmCall;
    rmSync(STOP, { force: true });
    check(`${how}: no script of noracu's runs in the page between the pointer move and the wheel`, hmFirst === "done" && /scrollY 0 → [1-9]/.test(hm) && hm.includes("delivery=delivered_verified"), `${hmFirst} || ${hm}`);
    // a call that failed before any input leaves no doubt: the next call on the page verifies
    await s.call("browser_navigate", { url: failsOnce });
    const f1 = await s.call("browser_scroll", { direction: "down" });
    const f2 = await s.call("browser_scroll", { direction: "down" });
    check(`${how}: a call that fails before any input (the page's elementFromPoint throws) leaves no doubt: the next one is verified`, f1.includes("not_actionable") && f1.includes("delivery=not_delivered") && /scrollY 0 → [1-9]/.test(f2) && f2.includes("delivery=delivered_verified"), `${f1} || ${f2}`);
    // the stop file made while the pointer moves (the page holds the move 3 s): checked again right before the wheel.
    // The file is made once the page has the move: a listener that runs before the one that holds the page says so
    await s.call("browser_navigate", { url: holdsMove });
    await s.call("browser_click", { xy: [5, 5] });
    await s.call("browser_evaluate", { js: "window.__arm = true; window.__moved = new Promise((r) => addEventListener('mousemove', () => r('pointer here'), { capture: true, once: true })); 1" });
    const mm = s.call("browser_scroll", { direction: "down" });
    const moved = await s.call("browser_evaluate", { js: "window.__moved" });
    writeFileSync(STOP, "");
    const mmR = await mm;
    rmSync(STOP, { force: true });
    check(`${how}: the stop file made while the pointer moved stops the wheel, and the result says the pointer had moved`, moved.includes("pointer here") && mmR.includes("user_stopped") && mmR.includes("the pointer had moved") && mmR.includes("no wheel was sent") && mmR.includes("delivery=not_delivered"), `${moved} || ${mmR}`);
    // nothing of the call is left on the page: no name of its own, no listener
    const left = await s.call("browser_evaluate", { js: "Object.getOwnPropertyNames(window).filter((k) => k.startsWith('__noracu_wheel_')).length" });
    check(`${how}: the call leaves nothing on the page`, /\b0\b/.test(left), left);
    await s.call("browser_close");
    // a page brought back from the back-forward cache is the document it was, timers and all: a wheel it had that was
    // not verified still counts there, whatever the page did to itself as it was put away
    const bf = await cachingChrome();
    try {
      const at = await s.call("browser_launch", { cdp_port: bf.port });
      await s.call("browser_navigate", { url: `${WEB}/bf-a` });
      const b1 = await s.call("browser_scroll", { direction: "down" });
      await s.call("browser_navigate", { url: `${WEB}/bf-b` });
      await s.call("browser_evaluate", { js: "history.back(), 1" });
      let back = "";
      for (let i = 0; i < 50 && !back.includes("/bf-a "); i++) { await sleep(100); back = await s.call("browser_evaluate", { js: "location.pathname + ' ' + window.__persisted" }); }
      const b2 = await s.call("browser_scroll", { direction: "down" });
      check(`${how}: a page brought back from the back-forward cache keeps the doubt of a wheel it had: the next scroll there is not verified`, back.includes("/bf-a true") && b1.includes("did not move") && b1.includes("delivery=delivered_unverified") && /scrollY 0 → [1-9]/.test(b2) && b2.includes("an earlier wheel that may have reached this page was not verified") && b2.includes("delivery=delivered_unverified"), `${at.slice(0, 80)} || ${b1} || ${back} || ${b2}`);
      await s.call("browser_close");
    } finally {
      await bf.stop();
    }
  } finally {
    await s.close();
  }
}
rmSync(dir, { recursive: true, force: true });
web.close();
const passed = results.filter(Boolean).length;
console.log(`browser scroll on a slow Chromium: ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);

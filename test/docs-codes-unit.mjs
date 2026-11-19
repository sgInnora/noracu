// Every error code the server can answer is named in docs/usage.md.
//
// A code is the snake_case word an answer opens with ("user_active: …", "tab_not_found: …") or carries as its
// `error` field (the XCUITest backend). A person who meets one looks it up in the error reference; a code that
// is not there sends them to the source. This reads the shipped source for codes and the document for their
// names — no server is started, nothing on the Mac is touched, so it runs the same under NORACU_CI=1.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const SRC = [
  ...readdirSync(join(ROOT, "src")).filter((f) => /\.(js|mjs)$/.test(f)).map((f) => `src/${f}`),
  ...readdirSync(join(ROOT, "imctl/src/imctl")).filter((f) => f.endsWith(".py")).map((f) => `imctl/src/imctl/${f}`),
];
const usage = read("docs/usage.md");

// Words of the same shape that are not codes: tool and argument names that open a validation message
// ("browser_launch: chrome must be a boolean"), and field names quoted inside one.
const NOT_A_CODE = /^(?:mac|browser|phone|ios)_|^(?:element_index|snapshot_id|screenshot_id|window_id|tab_id|browser_id|bundle_id|timeout_ms|max_nodes|max_chars|cdp_port|wait_window|include_offscreen|web_accessibility|expected_app|expected_title|value_equals|value_contains|open_center|all_layers|full_page|wait_until)$/;
// Engine-internal markers that never reach a client under their own name (the server turns each into one of
// the documented codes before answering).
const INTERNAL = new Set(["container_unknown", "menubar_absent", "window_unverifiable"]);

const codes = new Map();   // code → where it was first seen
const add = (code, where) => { if (code.length >= 5 && !NOT_A_CODE.test(code) && !INTERNAL.has(code) && !codes.has(code)) codes.set(code, where); };
const WORD = "([a-z][a-z0-9]*(?:_[a-z0-9]+)+)";

// the engine's codes are upper case; the server answers with the prefix AX_ERROR_PREFIX gives, else the
// code in lower case
const server = read("src/server.mjs");
const mapSrc = /const AX_ERROR_PREFIX = \{([\s\S]*?)\};/.exec(server);
if (!mapSrc) { console.log("❌ docs codes: AX_ERROR_PREFIX not found in src/server.mjs"); process.exit(1); }
const prefixOf = new Map([...mapSrc[1].matchAll(/([A-Z_]+):\s*"([a-z_]+)"/g)].map((m) => [m[1], m[2]]));
for (const [, v] of prefixOf) add(v, "src/server.mjs AX_ERROR_PREFIX");
for (const m of read("src/mac-ax.js").matchAll(/code:\s*'([A-Z][A-Z0-9_]{3,})'/g)) add(prefixOf.get(m[1]) || m[1].toLowerCase(), "src/mac-ax.js");

for (const p of SRC) {
  const t = read(p);
  // an answer that opens with the code: "code: text", `code: text`, 'code: text', "code — text"
  for (const m of t.matchAll(new RegExp("[\"'`]" + WORD + "(?:: | — )", "g"))) add(m[1], p);
  // the XCUITest backend's { error: "code", message: … }
  if (/^src\/(?:ios-|approval)/.test(p)) for (const m of t.matchAll(new RegExp("error:\\s*[\"']" + WORD + "[\"']", "g"))) add(m[1], p);
}
// the iPhone Mirroring driver's codes the server passes through as they are
const pass = /const IMCTL_PASS_THROUGH = \[([^\]]*)\]/.exec(server);
if (pass) for (const m of pass[1].matchAll(new RegExp("\"" + WORD + "\"", "g"))) add(m[1], "src/server.mjs IMCTL_PASS_THROUGH");

const missing = [...codes].filter(([c]) => !usage.includes(c)).sort();
for (const [c, where] of missing) console.log(`❌ docs/usage.md does not name \`${c}\` (answered from ${where})`);
const ok = missing.length === 0 && codes.size >= 60;   // fewer than 60 found means the patterns above stopped matching the source
console.log(`${ok ? "✅" : "❌"} docs codes: ${codes.size - missing.length}/${codes.size} of the codes the source can answer are named in docs/usage.md`);
if (codes.size < 60) console.log(`❌ only ${codes.size} codes were found in the source — the search patterns in this test no longer match it`);
process.exit(ok ? 0 : 1);

// What `npm pack` must and must not ship: the rules of scripts/check-pack.mjs. They are kept apart from it so that
// they can be tried on lists of paths (test/check-pack-unit.mjs) while the script itself runs whenever it is started.
// every module the server and the iPhone Mirroring driver load at run time is named: a file that is renamed or
// left out of package.json's "files" fails here, not on a user's machine
export const MUST = ["src/server.mjs", "src/mac-ax.js", "src/approval.js", "src/bg-inject.js", "src/doctor.js", "src/ios-xcuitest.js", "src/ios-session.js", "src/ios-setup.js", "README.md", "LICENSE",
  "imctl/pyproject.toml", ...["__init__", "cli", "gestures", "input", "pointer", "screenrect", "verify", "vision", "window"].map((m) => `imctl/src/imctl/${m}.py`),
  "ios-runner/NoracuRunner.xcodeproj/project.pbxproj", "ios-runner/NoracuRunner.xcodeproj/xcshareddata/xcschemes/NoracuRunner.xcscheme",
  "ios-runner/NoracuRunnerUITests/NoracuRunner.swift", "ios-runner/NoracuRunnerUITests/RunnerServer.swift", "ios-runner/NoracuRunnerUITests/RunnerCommands.swift", "ios-runner/LICENSE", "docs/ios-runner-protocol.md"];
// internal material, build leftovers, and files that hold a secret wherever they sit ("src" ships as a whole folder:
// a key or an .env dropped into it would go out with it)
export const FORBIDDEN = [/^OUTPUTS\//, /^docs\/analysis\//, /re-findings/, /\.demo-video\//, /__pycache__/, /\.pyc$/, /\.tgz$/, /^test\//, /^\.github\//, /xcuserdata/, /DerivedData/, /\.xcresult/, /\.xctestrun$/,
  /(^|\/)\.env(\.|$)/, /(^|\/)\.npmrc$/, /\.(p8|p12|pem|key|cer|mobileprovision)$/i];
// npm takes the package's page from a README* in the package folder, and not always README.md (0.3.0's page
// showed README.zh-CN.md): README.md is the only one allowed there, shipped or not
const isReadme = (f) => /^readme(\.|$)/i.test(f) && f !== "README.md";

// files: the paths npm would pack; folder: the names in the package folder
export function verdict(files, folder = []) {
  return {
    missing: MUST.filter((m) => !files.includes(m)),
    leaked: files.filter((f) => FORBIDDEN.some((re) => re.test(f))),
    readmes: [...new Set([...files.filter(isReadme), ...folder.filter(isReadme)])],
  };
}

// Labels of the maintainers' own review and device-test notes (a letter or two and a number, with or without a
// hyphenated tail, alone or in one of the phrases that LABEL lists, or a review named after whoever made it) mean
// nothing to a reader: none may be in a comment of a source file that ships (check-pack.mjs: SCANNED), nor of any
// other tracked source file — the tests and the maintainer scripts are public too (check-public.mjs:
// PUBLIC_SOURCE). In sources they are looked for in comments and docstrings only — in code and in strings the same
// letters and digits can be something else, a key name for one. A test file is read whole (labelledText): the names
// its checks print and its assertion messages are public text as well.
const LABEL = /(?<![\w.-])(?:F\d{1,2}|R\d{1,2}|G\d{1,2}[a-z]?|Y\d|P\d{1,2}|CR\d|T\d{1,2})(?![\w-])|\bE2 run\b|\bnext-steps\b|\bS\d[A-F]-[\w-]+|\bt\d{1,2} review\b|\bcross-verification [A-Z]\d\b|\bEA-\d+\b|(?<![\w.-])(?:[BES]\d[A-F]?|A0)(?![\w-])|\b(?:RF|GH)-\d+\b|(?<![\w.-])t\d{2}(?![\w-])|\breview (?:\d+\.\d+\.\d+ )?#\d+|\bpre-reviews?\b|\baudit S\d|\breview (?:S\d|CR\d|[A-Z]\d)|\bcross-verification (?:round )?[A-Z]\b|\breview(?: fix)? \([^)]{1,30}\)|\bv\d #\d+|\bs\d{1,2}#\d+|\b[A-Z]\d-[a-z]+\.md\b|(?<![\w.$-])[A-Z]{1,3}\d{1,3}[a-z]?-(?:[A-Za-z]{1,10}-)?\d+[a-z]?(?![\w-])|(?<![\w.$-])[A-Z]{2}\d{1,2}(?![\w-])/;
export const SCANNED = /^(?:src\/[^/]+\.(?:js|mjs)|imctl\/src\/imctl\/[^/]+\.py|ios-runner\/NoracuRunnerUITests\/[^/]+\.swift)$/;
export const PUBLIC_SOURCE = /\.(?:m?js|cjs|py|swift)$/;
// the tests, read whole by labelledText — except the label check's own test data
export const WHOLE_TEXT = /^(?:test|imctl\/tests)\/.+\.(?:m?js|cjs|py)$/;
export const LABEL_FIXTURES = new Set(["test/check-pack-unit.mjs"]);
// where a comment starts on a line of code (-1: nowhere): the first `mark` outside a quoted string
function commentStart(line, mark) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (line.startsWith(mark, i) && !(mark === "//" && line[i - 1] === ":")) return i;
  }
  return -1;
}
// the comment parts of one line of JavaScript: the text after //, and /* … */ blocks (the last one may stay open
// past the line). Strings and regular expression literals are skipped: the quote in /["']/ opens no string.
function jsCommentParts(line) {
  const parts = [];
  let quote = null, open = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c !== "/") continue;
    if (line[i + 1] === "/" && line[i - 1] !== ":") { parts.push(line.slice(i)); break; }
    if (line[i + 1] === "*") {
      const end = line.indexOf("*/", i + 2);
      if (end === -1) { parts.push(line.slice(i)); open = true; break; }
      parts.push(line.slice(i, end + 2));
      i = end + 1;
      continue;
    }
    // a regular expression literal starts where an operand may: at the start, after an operator or punctuation,
    // or after return / typeof / case; a / after a name, a number or ) is a division
    const before = line.slice(0, i).trimEnd();
    if (before && !/[(,=:[!&|?{};+\-*%<>~^]$/.test(before) && !/\b(?:return|typeof|case)$/.test(before)) continue;
    let cls = false, j = i + 1;
    for (; j < line.length; j++) {
      const d = line[j];
      if (d === "\\") { j++; continue; }
      if (cls) { if (d === "]") cls = false; continue; }
      if (d === "[") cls = true;
      else if (d === "/") break;
    }
    if (j < line.length) i = j;
  }
  return { parts, open };
}
// the comment text of a source file: [[line number, text], …] — // and /* */ in JavaScript and Swift; # and triple-quoted
// text in Python (docstrings; a script kept as a string is read too, which errs on the side of looking)
export function commentsOf(path, source) {
  const py = path.endsWith(".py"), out = [];
  let block = null;
  source.split("\n").forEach((line, i) => {
    if (block) {
      out.push([i + 1, line]);
      if (line.includes(block)) block = null;
      return;
    }
    if (py) {
      const q = line.match(/\"\"\"|'''/);
      if (q) { out.push([i + 1, line]); if (line.split(q[0]).length % 2 === 0) block = q[0]; return; }
    } else if (/^\s*(\/\*|\*)/.test(line)) {
      out.push([i + 1, line]);
      if (/^\s*\/\*/.test(line) && !line.includes("*/")) block = "*/";
      return;
    }
    if (py) {
      const at = commentStart(line, "#");
      if (at !== -1) out.push([i + 1, line.slice(at)]);
      return;
    }
    const { parts, open } = jsCommentParts(line);
    if (parts.length) out.push([i + 1, parts.join(" ")]);
    if (open) block = "*/";
  });
  return out;
}
// files: [{ path, source }] → "path:line: text" for every comment line that carries such a label; scope: the paths
// that are read (the shipped sources unless told otherwise)
export function labelled(files, scope = SCANNED) {
  const hits = [];
  for (const { path, source } of files) {
    if (!scope.test(path)) continue;
    for (const [n, text] of commentsOf(path, source)) if (LABEL.test(text)) hits.push(`${path}:${n}: ${text.trim().slice(0, 100)}`);
  }
  return hits;
}
// files: [{ path, source }] → "path:line: text" for every line of a test file (WHOLE_TEXT, not LABEL_FIXTURES) that
// carries such a label, in code, a string or a comment
export function labelledText(files) {
  const hits = [];
  for (const { path, source } of files) {
    if (!WHOLE_TEXT.test(path) || LABEL_FIXTURES.has(path)) continue;
    source.split("\n").forEach((line, i) => { if (LABEL.test(line)) hits.push(`${path}:${i + 1}: ${line.trim().slice(0, 100)}`); });
  }
  return hits;
}

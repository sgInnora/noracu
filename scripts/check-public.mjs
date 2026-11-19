#!/usr/bin/env node
// The public repository's own check: no label of the maintainers' review and device-test notes in a comment or
// docstring of any tracked source file — the tests and the maintainer scripts too, not only what ships (that is
// check-pack.mjs) — nor anywhere in a test file, the names its checks print included. The rules are in
// pack-rules.mjs. Run from a git checkout (npm run check does): git ls-files names the files.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { PUBLIC_SOURCE, labelled, labelledText } from "./pack-rules.mjs";

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter((f) => PUBLIC_SOURCE.test(f));
const read = files.map((path) => ({ path, source: readFileSync(path, "utf8") }));
const hits = [...new Set([...labelled(read, PUBLIC_SOURCE), ...labelledText(read)])];
if (hits.length) {
  console.log(`review or device-test labels in tracked sources — in a comment, or anywhere in a test (reword it, drop the label):\n  ${hits.join("\n  ")}`);
  process.exit(1);
}
console.log(`check-public: ${files.length} tracked source files, no review labels in their comments nor in the tests' text`);

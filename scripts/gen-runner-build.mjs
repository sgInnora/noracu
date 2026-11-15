#!/usr/bin/env node
// Writes the hash of the iOS runner's sources into ios-runner/NoracuRunnerUITests/NoracuRunner.swift
// (`let noracuRunnerBuild = "…"`). The runner prints that value on its ready line and the Mac side refuses a
// runner that names another one, so run this after every change under ios-runner/ — test/ios-xcuitest-unit.mjs
// fails when it was not.
//
//   node scripts/gen-runner-build.mjs           write the line when it is out of date
//   node scripts/gen-runner-build.mjs --check   exit 1 when it is out of date; write nothing
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RUNNER_DIR, runnerBuild, runnerSourceHash } from "../src/ios-xcuitest.js";

const want = runnerSourceHash(), have = runnerBuild();
if (process.argv.includes("--check")) {
  if (want !== have) { console.error(`ios-runner: noracuRunnerBuild is ${have}, the sources hash to ${want} — run: node scripts/gen-runner-build.mjs`); process.exit(1); }
  console.log(`ios-runner build ${have}`);
  process.exit(0);
}
if (want === have) { console.log(`ios-runner build ${have} (up to date)`); process.exit(0); }
const file = join(RUNNER_DIR, "NoracuRunnerUITests", "NoracuRunner.swift");
const src = readFileSync(file, "utf8");
const out = src.replace(/^let noracuRunnerBuild = "[0-9a-f]*"$/m, `let noracuRunnerBuild = "${want}"`);
if (out === src) { console.error("ios-runner: no `let noracuRunnerBuild = \"…\"` line in NoracuRunner.swift"); process.exit(1); }
writeFileSync(file, out);
console.log(`ios-runner build ${want} (written; was ${have})`);

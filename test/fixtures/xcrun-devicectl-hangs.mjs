#!/usr/bin/env node
// xcrun as on a Mac whose devicectl gives no answer — as on GitHub's macOS 26 runners with Xcode 26.6, where it hung
// for 30 s or listed no simulator: the CI simulator job sets NORACU_IOS_XCRUN to this file. simctl (and anything else)
// goes to the real /usr/bin/xcrun with the same arguments, input and output; a devicectl call is noted in
// $NORACU_DEVICECTL_LOG and then waits until it is killed. With a simulator nothing should ever call devicectl.
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
if (argv[0] === "devicectl") {
  if (process.env.NORACU_DEVICECTL_LOG) appendFileSync(process.env.NORACU_DEVICECTL_LOG, JSON.stringify(argv) + "\n");
  setInterval(() => {}, 1 << 30);
} else {
  const r = spawnSync("/usr/bin/xcrun", argv, { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

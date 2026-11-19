<!-- SPDX-License-Identifier: MIT -->
# NoracuRunner — iOS runner for the XCUITest backend (protocol v1)

A minimal Xcode project that builds a single **UI test bundle** (no host app).
One long test (`NoracuRunnerUITests/NoracuRunner.swift`, method `testServe`) starts a
TCP line server on the address it is given and executes JSON commands, one per line,
on the main thread. The Mac side launches apps (`devicectl` / `simctl`) and talks to
this runner over the CoreDevice tunnel (device) or loopback (simulator).

## Build

```sh
xcodebuild build-for-testing -project ios-runner/NoracuRunner.xcodeproj -scheme NoracuRunner \
  -destination 'platform=iOS Simulator,id=<SIM_UDID>' -derivedDataPath /tmp/noracu-dd CODE_SIGNING_ALLOWED=NO
```

For a real device add `DEVELOPMENT_TEAM=<team> -allowProvisioningUpdates`
(the project itself leaves `DEVELOPMENT_TEAM` empty).

## Run

```sh
TEST_RUNNER_NORACU_TOKEN=<32 lowercase hex> TEST_RUNNER_NORACU_BIND=<ip> TEST_RUNNER_NORACU_PORT=<49152-65535> \
xcodebuild test-without-building -project ios-runner/NoracuRunner.xcodeproj -scheme NoracuRunner \
  -destination '<destination>' -derivedDataPath /tmp/noracu-dd \
  -only-testing:NoracuRunnerUITests/NoracuRunner/testServe
```

The runner prints `NORACU_RUNNER ready v=1 port=<port> build=<hash of these sources>` on
its own line when the listener is up (after a change here run `node scripts/gen-runner-build.mjs`), and `NORACU_RUNNER error bad_token|bad_bind|bad_port|bind_failed` (or `listener_failed` after the ready line)
on invalid start-up values. It ends on `quit` or after 12 hours.

## Protocol

UTF-8, one JSON object per line, request lines limited to 64 KiB.
Request `{"id":n,"token":"<hex>","op":"...","args":{...}}`; success
`{"id":n,"ok":true,"result":{...}}`; failure `{"id":n,"ok":false,"error":"<code>",
"message":"...","sent":false}`. Wrong token → `{"id":n,"ok":false,"error":"auth"}`
and the connection is closed (constant-time compare). Commands: `ping`, `app_state`,
`snapshot`, `tap`, `press`, `drag`, `type`, `keys`, `home`, `screenshot`, `quit`.
Coordinates are screen points, origin top-left. See `docs/ios-runner-protocol.md`
in the repository root for the full specification.

## Security notes

- The listener binds **only** the address given in `NORACU_BIND` (via
  `NWParameters.requiredLocalEndpoint`). Connections are accepted only from the
  same /64 (IPv6) or loopback; everything else is closed immediately.
- A per-start token (32 hex chars, passed as a test-runner environment variable)
  is required on every request and compared in constant time.
- The runner uses only public APIs (XCTest / XCUIAutomation / Network / Foundation),
  never touches the clipboard, never reads or writes files outside the test sandbox,
  and makes no outbound connections.
- The runner never launches or activates apps itself (launching is the Mac side's
  job via `devicectl`), never retries a gesture, and never taps on its own initiative.

## License

MIT — see `LICENSE` (same as the repository root).

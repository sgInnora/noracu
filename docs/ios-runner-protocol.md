# iOS runner protocol, version 1

Status: experimental. This describes the wire protocol between noracu on the Mac and the small UI-test
bundle ("runner") that noracu's XCUITest backend runs on an iPhone. The Mirroring backend does not use it.

## Roles

- **Runner** — a UI-test bundle on the phone. It is started by `xcodebuild test-without-building`, stays
  inside one long test, listens on one TCP address, and executes one command at a time on the main thread
  with XCUITest. The test is `NoracuRunnerUITests/NoracuRunner/testServe`. It must not be named `testRun`:
  XCTest has a property of that name, and a test so named is reported as passed without its body running.
- **Client** — `src/ios-xcuitest.js` on the Mac. It finds the device, starts the runner, sends commands and
  enforces time limits.

Launching an app and reading the lock state are **not** runner commands. The client does both with
`xcrun devicectl` (`device process launch`, `device info lockState`), so a busy app cannot stall them.

## Start-up

The client passes three values through `xcodebuild`'s `TEST_RUNNER_` environment prefix (the runner sees
them without the prefix):

| Variable | Meaning |
|---|---|
| `NORACU_TOKEN` | 32 lowercase hex characters (ASCII `0-9a-f`), new for every start. The runner refuses to start with anything else. |
| `NORACU_BIND` | The address to listen on: the device's own CoreDevice tunnel address (IPv6) for a physical device, `127.0.0.1` for a simulator. Required. |
| `NORACU_PORT` | TCP port, 49152–65535, chosen by the client. Required. |

The runner binds **only** `NORACU_BIND` (a required local endpoint). It does not listen on Wi-Fi or
cellular addresses. On a physical device it accepts a connection only when the peer address is in the same
/64 as `NORACU_BIND`; on a simulator only from loopback. The peer is checked before anything is read from
the connection.

When the listener is ready the runner prints exactly one line to standard output:

```
NORACU_RUNNER ready v=1 port=<port> build=<12 hex digits>
```

`build` names the sources the runner was built from: a hash of the Swift files and the project file, written
into `NoracuRunner.swift` by `scripts/gen-runner-build.mjs`. The client compares it with the same value in its
own copy of the sources and does not use a runner that names another build, or none: a build made by an older
noracu stays on the device until `ios-setup` is run again, and the first start after a rebuild was seen running
the previous build once (simulator, 2026-11-11) — so the client starts such a runner once more before it
reports `runner_version_mismatch`.

If it cannot start it prints `NORACU_RUNNER error <code>` (`bad_token`, `bad_bind`, `bad_port`,
`bind_failed`) and ends the test.

The runner ends when it receives `quit`, when the client's `xcodebuild` process is stopped, or after
12 hours.

## Framing

- UTF-8, one JSON object per line, lines end with `\n`. No pretty-printing.
- A request line is at most 64 KiB. A longer line closes the connection.
- Every request: `{"id": <integer>, "token": "<hex>", "op": "<name>", "args": { ... }}`
- Every answer echoes `id`:
  - success: `{"id": 1, "ok": true, "result": { ... }}`
  - refusal or failure: `{"id": 1, "ok": false, "error": "<code>", "message": "<one line>", "sent": false}`
- `sent` appears on failed input commands: `false` when no event was sent, `"unknown"` when the runner
  cannot tell. It never claims `true` on a failure.
- A request with a wrong or missing token gets `{"id": <id or 0>, "ok": false, "error": "auth"}` and the
  connection is closed. The token is compared in constant time. Lines that follow such a request in the
  same packet are not read; neither are lines that follow a `quit`.
- Commands run strictly one after another, in arrival order, whatever connection they came from.

## Coordinates

All points and frames are in screen points, origin at the top-left of the screen, the same space as
`XCUIScreen.main` — the frames in a `snapshot` answer can be used directly as `tap` targets.

## Commands

| op | args | result |
|---|---|---|
| `ping` | — | `{"v": 1, "uptime_ms": n, "served": n}` |
| `app_state` | `bundle_id` | `{"state": 0–4, "name": "unknown"/"notRunning"/"runningBackgroundSuspended"/"runningBackground"/"runningForeground"}` |
| `snapshot` | `bundle_id`, `max_nodes` (1–1000, default 400) | see below |
| `tap` | `bundle_id`, `x`, `y`, `count` (1–3, default 1) | `{"ms": n}` |
| `press` | `bundle_id`, `x`, `y`, `duration_ms` (100–5000) | `{"ms": n}` |
| `drag` | `bundle_id`, `from` `[x, y]`, `to` `[x, y]`, `hold_ms` (0–2000, default 50), `end_hold_ms` (0–2000, default 300), `velocity` (`slow`/`default`/`fast`, default `slow`) | `{"ms": n}` |
| `type` | `bundle_id`, `text` (1–2000 characters) | `{"ms": n}` |
| `keys` | `bundle_id`, `key` (`delete`/`return`), `count` (1–500, default 1) | `{"ms": n}` |
| `home` | — | `{"ms": n}` |
| `screenshot` | — | `{"png_base64": "...", "w": n, "h": n}` (`w`, `h`: the screen in points; the PNG is in pixels) |
| `front` | — | `{"home": true/false, "icons": n, "alerts": [[x, y, w, h], …], "alert_buttons": n}` — what SpringBoard itself shows: `home` is true when Home Screen icons are on screen; `alerts` are the frames of SpringBoard's alerts (a sheet is not counted), `alert_buttons` how many buttons they hold |
| `quit` | — | `{}`; the runner then ends |

`tap`, `press`, `drag`, `type` and `keys` take an optional `springboard_only` (boolean), read only when
`bundle_id` is `com.apple.springboard`. With `true` one thing is sent and nothing else: a single `tap` (no
`count` above 1) whose point lies on a button of one of SpringBoard's alerts. A sheet is not an alert. `press`,
`drag`, `type` and `keys` are refused — text goes wherever the keyboard focus is, which the public API does
not show, and a second Return would land on whatever the alert was covering. See Refusals. noracu's own Mac
side refuses those, and a `tap` with a `count` above 1, before it starts a runner — a starting runner puts its
app in front of what the iPhone was showing — so the runner's refusal is what any other client gets. Since
2026-11-12 noracu no longer sends `springboard_only`: while app rules are in force it refuses every input that
names `com.apple.springboard` on the Mac side, a single tap on an alert's button included.

An optional field must have the right type when it is present: a `count` of `"2"` is `invalid_args`, not the
default. `args` itself must be an object (`invalid_args` otherwise), and `id` a whole number: a missing `id`, or any
other value, is `invalid_args`, answered with `id` 0, and the command is not run.

`snapshot` result:

```
{"bundle_id": "...", "state": 4, "screen": {"w": 402, "h": 874},
 "nodes": [{"i": 0, "type": "button", "label": "...", "id": "...", "value": "...",
            "frame": [x, y, w, h], "enabled": true, "selected": false}],
 "truncated": false, "ms": 96}
```

- `nodes` is the app's element tree flattened in document order, keeping an element when its frame has a
  non-zero size, intersects the screen, and it either has a label or is an interactive type (button, cell,
  text field, secure text field, search field, text view, switch, slider, link, tab, key, menu item,
  segmented control, picker wheel, stepper, toggle).
- `type` is the element type's name in lowerCamelCase (`button`, `staticText`, `textField`, …).
- `value` is present only for text inputs, switches and sliders, at most 4000 characters (`value_truncated:
  true` when it was cut); a secure text field's value is never included. XCUITest reports an empty text
  field's placeholder as its value: the runner returns that text as `placeholder` and an empty `value`.
  `label` is at most 200 characters, `id` at most 80. A cell without a label of its own gets the labels
  inside it, joined with `, `.
- System alerts (permission prompts and the like) belong to `com.apple.springboard`, not to the app.

## Refusals

Input commands (`tap`, `press`, `drag`, `type`, `keys`) are refused before anything is sent when:

| error | when |
|---|---|
| `invalid_args` | a field is missing, of the wrong type, or out of range; a point is outside the screen |
| `app_not_running` | the app's state is `notRunning` or `unknown` |
| `app_not_foreground` | the app is not `runningForeground`. `com.apple.springboard` always reads `runningForeground`, so for it this check is skipped — unless the command carries `springboard_only: true`: then it is refused unless it is the one tap on an alert's button described above |
| `no_keyboard` | `type` or `keys` while the app shows no keyboard |

Other errors: `unknown_op`, `snapshot_failed`, `screenshot_failed`, `internal`, and `xctest_issue`: XCTest
recorded a failure while the command ran (the runner keeps `continueAfterFailure` on, so the test goes on).
The answer is then `ok: false` whatever the command itself answered; for an input command `sent` is `false`
when the command had refused without sending, `"unknown"` otherwise. A failure recorded between two commands
is reported by the next command other than `ping`: that command is not run and answers `xctest_issue` with
`sent: false`.

`selftest_issue` is a test hook: only a runner started with `NORACU_SELFTEST=1` in its environment answers
it. It records one XCTest failure — at once, or shortly after answering when called with `late: true`.

The runner never retries a gesture, never taps anything on its own, and does not read or write the
pasteboard.

## Time limits

The runner cannot interrupt an XCUITest call that is waiting for an app to become idle. The client gives
every command a hard time limit. When it passes for an input command, the client stops the runner (ending
`xcodebuild`), so the gesture cannot go out later, and reports delivery unknown without re-sending it. After
a read that timed out, it asks the runner for a sign of life before the next command and restarts it if
there is none. It also stops the runner after any answer of `xctest_issue`, whichever command got it: what state
the test session is in is then not known, and `ping` answers from the socket alone.

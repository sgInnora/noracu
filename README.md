# noracu

**A local MCP server that lets Claude, Cursor, or any MCP client operate macOS apps and a Playwright browser by `element_index` — and, experimentally, a real iPhone through Apple's iPhone Mirroring (OCR on the Mac, normalized taps). No API key; no telemetry from the server.**

[![CI](https://github.com/sgInnora/noracu/actions/workflows/ci.yml/badge.svg)](https://github.com/sgInnora/noracu/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/noracu.svg)](https://www.npmjs.com/package/noracu)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

中文说明见 [README.zh-CN.md](README.zh-CN.md)。

One stdio MCP server. The agent snapshots a tree, gets an indexed element list, then clicks or types by `element_index` instead of raw pixels — the same observe/act split on the Mac and in the browser. The experimental iPhone layer runs the same observe → act loop over OCR text and normalized coordinates.

![browser element_index demo](https://raw.githubusercontent.com/sgInnora/noracu/v0.1.0/docs/demo-browser.gif)

*`browser_snapshot` returns an indexed ARIA tree; `browser_click` acts by `element_index`. The Mac layer runs the same loop (`mac_ax_state` → `mac_click`). Highlight boxes are overlays from `demo/record-browser.mjs`, not a product feature. The iPhone layer is not in this demo.*

## What it does

One MCP server, three control surfaces:

| Layer | Tools | Drives | Status |
|---|---|---|---|
| **Mac** | 20 (`mac_*`) | macOS Accessibility API (`src/mac-ax.js`, JXA), cliclick, screencapture | stable |
| **Browser** | 12 (`browser_*`) | Playwright (persistent profile) | stable |
| **iPhone** | 14 (`phone_*`) | iPhone Mirroring via the bundled imctl driver (Python + pyobjc) | experimental |

The iPhone layer is experimental and ships with its driver (imctl, in `imctl/`). It needs Apple's iPhone Mirroring with the iPhone **locked and near the Mac**, and a python3 with pyobjc; it observes with OCR and acts on normalized coordinates rather than `element_index`. Without pyobjc, `phone_*` tools return a one-line `imctl unavailable` error with the install command, and the Mac and browser layers are unaffected. The observe/act vocabulary follows the action/observation split popularized by ChatGPT's computer-use, re-implemented on open local tooling.

## Why noracu

noracu is the local hands, not the model. Your MCP client (Claude Desktop, Claude Code, Cursor) decides what to do; this server only observes and acts on this machine.

- **The server runs entirely on your machine.** No cloud service, no API key, no telemetry, no postinstall scripts. Sole runtime dependency: Playwright. noracu makes no network calls of its own; the only automatic one is the one-time Chromium download on the first `browser_launch` (`NORACU_DISABLE_AUTO_INSTALL=1` turns that off). With `NORACU_ALLOW_CDP=1` it also talks to a DevTools port on 127.0.0.1 that it opened itself (`NORACU_ALLOW_CDP=any` for other loopback ports). The browser still fetches the pages you point it at, and your MCP client still sends tool results — screenshots, OCR text — to whatever model it uses.
- **Acts on semantics, not pixels.** Observation returns the accessibility tree (Mac, read directly through the macOS Accessibility API — about 0.15 s for a 500-element window on our test Mac) or ARIA tree (browser) as an indexed list — text, not screenshots. Actions reference `element_index`; indices expire after 30 s. On the Mac an index is backed by identity evidence (the window's ID, the child path, role, identifier, name) and the element is re-identified before every action; in the browser, tag/name/href/position are re-checked. A gone or changed element returns `element_no_longer_valid` instead of clicking the wrong thing. Screenshots are there when the tree is not enough.
- **Says what happened.** A Mac action uses the element's own accessibility action when it has one (press, select, set value, insert text — no pointer, no focus change, IME-safe text); a physical click is sent only after a hit test shows that the point reaches the element. Every input action result (Mac, browser and iPhone) states whether it was delivered (`delivered_verified` when a change was observed, `delivered_unverified`, `not_delivered`, or `unknown` when a step timed out or failed mid-action) and whether a retry is safe; Mac actions also name any sheet, dialog or menu they opened.
- **One loop, three surfaces.** Native Mac apps and a persistent-profile browser share the `element_index` protocol (observe a tree, act by index). The experimental iPhone layer runs the same observe → act loop on Apple's iPhone Mirroring, with OCR text and normalized coordinates, because the phone exposes no accessibility tree to the Mac.
- **Uses your real sessions.** Your logged-in browser profile, your Mac apps — not a hosted VM. Compared with cloud computer-use: neither is universally more reliable; they fail differently. noracu keeps the screen on your machine.
- **Off switches that are actually off.** `NORACU_READ_ONLY=1` (observation-only, default-deny), `NORACU_DISABLE_EVAL=1`, and `file://` blocked by default. See [Security](#security).
- **Verifiable.** End-to-end tests (`npm test`; the hardware-free ones run in CI on macos-latest), MIT; the server is `src/server.mjs` plus the Mac accessibility engine `src/mac-ax.js`.

**Not a good fit if** you need multiple browser tabs or sessions (single session for now), you're not on macOS (the Mac and iPhone layers are macOS-only; the browser layer is cross-platform), or you need a finished iPhone layer today (it ships, but experimental — and Apple does not offer iPhone Mirroring in the EU). If you only need browser automation, playwright-mcp has tab management and selector APIs that noracu lacks. If you need desktop apps on Windows or Linux, agent-desktop (Vercel Labs) covers macOS, Windows and Linux through each OS's accessibility API; noracu's desktop layer is macOS-only. noracu is for when one agent drives Mac apps, a browser and an iPhone from one server.

## Quickstart

First success is `mac_ax_state` (or a browser snapshot) — not a click, and not a `phone_*` tool. The biggest day-one failure is granting macOS permissions to `node` instead of to the host app; grants apply only after a full quit and reopen.

**1. Install** (Node ≥ 20; no postinstall script):

```bash
npm install noracu          # server at node_modules/noracu/src/server.mjs
brew install cliclick       # needed for physical Mac input (mac_key, mac_paste, mac_drag, and physical mac_click/mac_type)
```

Or from source: `git clone https://github.com/sgInnora/noracu.git && cd noracu && npm install && npm test` (add `NORACU_CI=1` to skip hardware-gated checks).

**2. Add to your MCP client — use an absolute path to `src/server.mjs`.** GUI apps launched from Finder/Dock do not inherit your shell `PATH`, so give an absolute path to the `node` binary as well (`which node`) — a bare `node`, `npx`, or `noracu` needs Node on the GUI `PATH` and otherwise fails with `ENOENT`.

Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`) / Cursor (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "noracu": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/ABSOLUTE/PATH/TO/noracu/src/server.mjs"]
    }
  }
}
```

Claude Code: `claude mcp add noracu -- /ABSOLUTE/PATH/TO/node /ABSOLUTE/PATH/TO/noracu/src/server.mjs`

Find your node path with `which node` (Apple Silicon: `/opt/homebrew/bin/node`; Intel: `/usr/local/bin/node`; nvm: the versioned path). Convenience, only if Node is already on the GUI `PATH`: `"command": "npx", "args": ["-y", "noracu"]`.

Then **quit the host app completely (including any menu-bar icon) and reopen it.** A loaded tool list means the transport works — it does not need any permission yet.

**3. Grant macOS permissions to the host app, not to `node`.** System Settings → Privacy & Security → **Accessibility** and **Screen Recording** (macOS 15: "Screen & System Audio Recording") → enable the host (Claude Desktop / Cursor / your terminal). noracu never appears here. Quit and reopen the host after granting.

**4. Verify.** Call `mac_status` — it reports whether the host has Accessibility and Screen Recording, and whether cliclick is found. Then, with Finder in front, call `mac_ax_state` (no args) — it returns an indexed accessibility tree; indices last 30 s. Browser smoke test (no Accessibility needed): `browser_launch` (first run downloads Chromium unless `NORACU_DISABLE_AUTO_INSTALL=1`) → `browser_navigate` → `browser_snapshot` → `browser_click` by index.

### Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `mac_*` fails with `permission_denied: Accessibility permission is missing…` (before 0.2: error **-1719**) | Accessibility not granted to the **host** app — grant it, then quit + reopen the host; `mac_status` shows the state |
| Screenshots come back all black | Screen Recording not granted to the host — grant it, then quit + reopen |
| `ENOENT` mentioning cliclick | `brew install cliclick` (or set `NORACU_CLICLICK`) |
| `spawn node` / `npx` `ENOENT` from a GUI host | use an absolute `node` path in the config — nvm/volta/homebrew shims are not on the GUI `PATH` |
| `browser_launch` hangs on first use | one-time Chromium download; or auto-install disabled (`NORACU_DISABLE_AUTO_INSTALL=1`) → run `npx playwright install chromium` |
| `phone_*` says `imctl unavailable: no python3 with pyobjc found` | install pyobjc for a python3 (`python3 -m pip install pyobjc-framework-Quartz pyobjc-framework-Vision pyobjc-framework-AppKit`; Homebrew python3 is the usual choice) or set `NORACU_PYTHON` — see [iPhone layer](#iphone-layer-experimental) |
| `phone_*` refused with `mirror_not_live: …` ("Connection Paused", "iPhone in Use", "not running") or `mirror_state_unknown: …` | the mirror is not running, paused, or its state could not be read — lock the iPhone, keep it near the Mac, check `phone_status`, and call `phone_launch` (it starts Mirroring and clicks Resume) |
| `phone_launch` says `mirror_setup_required` | iPhone Mirroring shows a setup or welcome screen (e.g. the first launch after a macOS upgrade) — finish it yourself in the iPhone Mirroring window; noracu never clicks through it |
| `imctl_timeout: phone … did not finish within …s` | the Mac is under heavy load or the system is stuck — the action may have partly run, so check `phone_status` / `phone_screenshot` before retrying (after `phone_open`, noracu goes back to the Home Screen); the server keeps answering other calls meanwhile |
| `input_busy: …` | an earlier phone or Mac action held the input queue for over 60 s (or `NORACU_PHONE_TIMEOUT_MS` + 15 s); the call did nothing — retry |
| `phone_open` returns app not found for an installed app | it only taps the label in Spotlight's Top Hit card — use the name exactly as the phone shows it under the icon (e.g. `拼多多`, not `Pinduoduo`). "Spotlight showed no Top Hit" on an installed app usually means the iPhone's language is not English: `phone_open` reads Spotlight's "Top Hit" label — set `NORACU_TOPHIT_LABELS` to the label your iPhone shows. `open_not_confirmed: … never showed up on the phone` means the pasted name did not arrive (a paste can take several seconds to reach the iPhone) — retry. `phone_open` leaves the app name on the clipboard |
| Typed text comes out re-spaced (e.g. "no ra cu") | it went in as keystrokes (`mac_type` with `mechanism: "physical"`, or a focused element that takes no accessibility text) while a CJK input method was active — use the default `mac_type` mechanism, or `mac_paste` |
| `element_no_longer_valid` | the snapshot is older than 30 s, or the element is gone, changed or in a window that closed — re-run `mac_ax_state` / `browser_snapshot` and use a fresh index |
| `occluded: … — on top: {…}` | a physical click would land on something else (another window, a sheet) — bring the target forward or close what covers it; nothing was sent |
| `ambiguous_window: … windows: […]` | the app has several windows and none is focused — pass `window` (index or title) or `window_id` from `mac_windows` |
| `policy_denied: "cmd-q" …` | `mac_key` refuses quit / log-out / lock / force-quit / delete-immediately / empty-Trash chords unless `force: true`; to quit an app use `mac_app` |

Node 18 is rejected at startup — use Node ≥ 20. Claude Desktop may start one noracu process per surface (e.g. chat and a second surface); they share the browser profile, so launch the browser from only one at a time.

Full worked examples: [docs/usage.md](docs/usage.md).

## iPhone layer (experimental)

noracu can operate a real iPhone through Apple's **iPhone Mirroring**. The agent observes with OCR on the Mac (`phone_screenshot`, `phone_ocr`, `phone_find`), acts at normalized 0–1 coordinates (`phone_tap`, `phone_swipe`, `phone_scroll`), types by pasting (`phone_type`) and opens apps by name (`phone_open`). This is not `element_index`: the phone exposes no accessibility tree to the Mac, so a tap lands where OCR placed the text. The driver (imctl, Python, MIT, about 3,500 lines) ships in `imctl/`.

**Apple's requirements** ([support.apple.com/120421](https://support.apple.com/120421)): a Mac with Apple silicon or a T2 chip on macOS 15 or later; an iPhone on iOS 18 or later with a passcode; both signed in to the same Apple Account with two-factor authentication; Bluetooth and Wi-Fi on; the Mac not sharing its internet connection or using AirPlay or Sidecar. **The iPhone must be locked and near the Mac** — unlocking it, or quitting iPhone Mirroring, ends the session. iPhone Mirroring is currently unavailable in the EU. One Mac and one iPhone at a time; camera and microphone are not mirrored.

**Unattended sessions:** in iPhone Mirroring → Settings, "Authenticate automatically" lets a session start without a password prompt. Trade-off: anyone who can use your unlocked Mac can then open your phone.

**Python:** the driver needs a python3 that imports pyobjc (Quartz, Vision, AppKit). Set `NORACU_PYTHON`, or noracu probes `/opt/homebrew/bin/python3`, `/usr/local/bin/python3`, `python3`, `/usr/bin/python3` once, on the first `phone_*` call. Apple's `/usr/bin/python3` usually lacks pyobjc; Homebrew's python3 plus `python3 -m pip install pyobjc-framework-Quartz pyobjc-framework-Vision pyobjc-framework-AppKit` is the common working setup.

**Mirror state:** `phone_status` reports `live` (the phone's screen is being streamed), `overlay` (the text iPhone Mirroring shows instead, e.g. "Connection Paused" or "iPhone in Use"), `paused` (that overlay offers a Resume button) and `setup` (a setup or welcome screen the user must finish — noracu never clicks it). Detection reads the window's structure and shape (the mirror is a tall or wide phone-shaped window; a setup screen is nearly square), not its text. While the mirror is not live, every phone input tool (`phone_tap`, `phone_longpress`, `phone_swipe`, `phone_scroll`, `phone_type`, `phone_key`, `phone_open`, `phone_home` and `phone_app_switcher`) refuses with `mirror_not_live` — without stealing focus when the mirror is paused or closed — instead of acting on the overlay, and refuses with `mirror_state_unknown` if the mirror state still cannot be determined (`phone_ocr` / `phone_find` start their output with a warning). The mirror pauses after inactivity; `phone_launch` brings it forward and clicks Resume.

**Privacy:** whatever the phone shows — notifications, messages, mail, one-time codes — becomes tool output that your MCP client sends to its model. Turn on a Focus, open a neutral app before you start, and begin with `NORACU_READ_ONLY=1` (`phone_status`, `phone_screenshot`, `phone_ocr` and `phone_find` stay allowed; all phone input is refused). iPhone notifications also reach the Mac once Mirroring is set up.

**First success:** `phone_status` → `phone_launch` if `live` is not `true` → `phone_screenshot` → `phone_ocr` → `phone_find` + `phone_tap`.

**Known limits:** a tap goes where OCR saw the text, so repeated or misread labels can be hit wrong (`phone_open` cannot tell an app from a contact or website that Spotlight's Top Hit shows under the same name); `phone_scroll` moves lists with trackpad-style scroll events (a vertical `phone_swipe` drag does not scroll a list — use it for gestures such as Home Screen paging); on one tested setup (iPhone 17 Pro Max on iOS 27.0.1, Mac on macOS 26.6.2) iPhone Mirroring draws the phone about 17% larger than its window at every View size, so the right column and bottom row are cut off and cannot be reached; moving the window between displays, changing the main display and relaunching made no difference, and the iOS 27 / macOS 26 version mismatch is the main suspect — check `phone_screenshot` if taps near the edges miss; `phone_open` types the app name into Spotlight and taps it only when Spotlight's Top Hit card shows exactly that name (web suggestions, websites and Settings rows of the same name are never tapped), otherwise returns to the Home Screen — it reads Spotlight's English "Top Hit" label, so on an iPhone set to another language it finds nothing until `NORACU_TOPHIT_LABELS` names that label; `phone_home` / `phone_app_switcher` use the iPhone Mirroring menu when live (working without python on English macOS, falling back to an `imctl` gesture only when those menu items are absent, and returning `menu_unknown` without a second gesture on timeout) and report only that the command was sent (`screen not verified`).

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `NORACU_READ_ONLY` | unset | `=1` observation-only: a default-deny allowlist of 18 observe + browser-lifecycle tools; every click/type/paste/key/eval tool is refused (`mac_clipboard_read`, `mac_notifications`, and `mac_wait` with `condition: "notification"` too; `mac_ax_state` / `mac_find` also skip `web_accessibility`) |
| `NORACU_DISABLE_EVAL` | unset | `=1` makes `browser_evaluate` (arbitrary JS) return an error when called (it stays listed) |
| `NORACU_ALLOW_FILE_URL` | unset | `=1` lets `browser_navigate` open `file://` URLs (blocked by default) |
| `NORACU_DISABLE_AUTO_INSTALL` | unset | `=1` skips the Chromium auto-install on first `browser_launch` |
| `NORACU_ALLOW_CDP` | unset | `=1` allows `mac_app` launch with `cdp_port` and `browser_launch` with `cdp_port` for ports opened by this `noracu` process (live PID and matching `webSocketDebuggerUrl`); `=any` also allows `browser_launch` to attach to any loopback DevTools port on 127.0.0.1 (always refused under `NORACU_READ_ONLY=1`) |
| `NORACU_TRACE` | unset | a file path: one JSON line per tool call (`{ts, tool, args, ms, error, code}` — argument names/sizes and error code prefix only, never argument text, result text, or error messages; opened `0600` with `O_NOFOLLOW`, refusing symlinks) |
| `NORACU_CLICLICK` | `/opt/homebrew/bin/cliclick` | cliclick binary path |
| `NORACU_PYTHON` | auto-probe | python3 used for the bundled iPhone driver; must import pyobjc (Quartz, Vision, AppKit). Unset → first working of `/opt/homebrew/bin/python3`, `/usr/local/bin/python3`, `python3`, `/usr/bin/python3` |
| `NORACU_IMCTL_DIR` | bundled `imctl/` | override the driver location (development only) |
| `NORACU_PHONE_TIMEOUT_MS` | 30000 (45000 for `phone_open` / `phone_type`) | time limit for each iPhone-layer step, 1000–600000 ms; on expiry the step is stopped and returns `imctl_timeout` |
| `NORACU_OCR_LANGUAGES` | `zh-Hans,en-US` | OCR languages for the iPhone screen, in priority order (comma-separated Vision language codes, e.g. `zh-Hant,en-US` or `en-US`; codes Vision does not list are skipped with a warning) |
| `NORACU_TOPHIT_LABELS` | `Top Hit` | the label of Spotlight's Top Hit section that `phone_open` looks for, comma-separated — set it to the label your iPhone shows when it is not set to English |

## Security

noracu runs with the privileges of your MCP client. It clicks, types, pastes, and drives a real browser on this machine — there is no sandbox and no remote approval prompt. Set these on the server entry, then quit the host completely and reopen it:

```json
"env": { "NORACU_READ_ONLY": "1", "NORACU_DISABLE_EVAL": "1" }
```

- **`NORACU_READ_ONLY=1`** is the safe first-run mode. It refuses every tool not on an 18-name allowlist (the observe tools plus standalone `browser_launch`/`browser_navigate`/`browser_close`; `browser_launch` with `cdp_port` is refused even when `NORACU_ALLOW_CDP` is set); every click, type, paste, and eval tool is denied, and so are `mac_clipboard_read`, `mac_notifications`, and `mac_wait` with `condition: "notification"`, while `mac_ax_state` and `mac_find` do not toggle `web_accessibility` on apps. `browser_navigate` is on the allowlist, so it can still load a URL.
- **`NORACU_DISABLE_EVAL=1`** makes `browser_evaluate` return an error when called (it stays listed in `tools/list`). Snapshot, click, and type still work.
- **`file://` is refused** unless `NORACU_ALLOW_FILE_URL=1`, so a browser agent can't read `~/Documents` by navigating to it. (The initial navigation URL is scheme-checked; redirects are not — see SECURITY.md.)
- **Focus guard:** pass `app` to `mac_paste` / `mac_key` (and `mac_type` when it sends keystrokes) and input is refused unless that app is frontmost. Omit `app` and the guard is off. `mac_type`'s default accessibility path writes into a named element or the app's focused element and sends no keystrokes at all; it never falls back to keystrokes when the focus is a button, list or sheet.
- **Stale-element protection:** an `element_index` is not a coordinate. It expires after 30 s, and on the Mac it is never reused by a later snapshot. A Mac element is re-identified inside the very window or open menu it was seen in (by window ID), at the same place in that window, under the same labelled ancestors and in the same table row; an element without a label or identifier must still be exactly where it was. A browser click re-checks tag/name/href/position. Otherwise `element_no_longer_valid`.
- **Hit test before physical clicks:** a Mac click or drag that has to use the pointer is sent only when the element at that point is the target — or, when accessibility cannot tell, when the topmost on-screen window there is that same window (by window ID, not covered by another window of the same app); otherwise `occluded`, with what is on top. A click at raw x,y goes out only when the topmost on-screen window at that point belongs to `app` (default: the frontmost app; the menu bar counts as the frontmost app's); `force: true` skips that check. Keystrokes typed after such a click go out only if the element's app is then frontmost.
- **Background windows:** semantic Mac actions also work on windows you are not looking at. That is the point (no stolen focus), but it means an agent can act where you do not see it — watch the results' `delivery` and keep high-stakes apps closed.
- **Guarded keys, menus and quits:** `mac_key` refuses quit / log-out / lock / force-quit / delete-immediately / empty-Trash chords unless `force: true`; `mac_menu_command` applies the same chord list to menu shortcuts and refuses Apple-menu items unless `force: true`. Neither `mac_app` nor `mac_menu_command` ever quits Finder, the Dock, loginwindow, other session processes or the MCP host itself; `force: true` is needed on `mac_app` to force-quit.
- **DevTools ports are opt-in:** `mac_app` / `browser_launch` with `cdp_port` need `NORACU_ALLOW_CDP=1` (`NORACU_ALLOW_CDP=any` to attach to a port `noracu` did not open itself; always refused under `NORACU_READ_ONLY=1`), bind to 127.0.0.1 only, canonicalize `.app` paths and refuse an app that is already running, and give Chrome-family browsers a separate `0700` profile under `~/.noracu/cdp-profiles`. While the port is open, any local process can control that app (127.0.0.1 has no per-user isolation).
- **Clipboard, password fields and notifications are private:** `mac_paste` puts the user's clipboard back (every item and type) and never copies an item a password manager marked concealed — it clears the clipboard after the paste instead; `mac_clipboard_read` never returns a concealed item; `mac_set_value` on a secure password field (`AXSecureTextField`) never echoes the value; `mac_notifications` returns notification text verbatim. `mac_clipboard_read`, `mac_notifications`, and `mac_wait` on notifications are outside read-only mode.
- **iPhone screen is model input:** `phone_screenshot` / `phone_ocr` / `phone_find` return whatever the phone shows — notifications, messages, one-time codes. Use a Focus and a neutral app, and start with `NORACU_READ_ONLY=1` (phone observation allowed, phone input refused). Phone input is also refused when the mirror is not live (`mirror_not_live`) or its state cannot be read (`mirror_state_unknown`).
- **Injection-safe JXA and stdin text:** the accessibility engine (`src/mac-ax.js`) is a static script that takes its whole request as JSON on stdin — parameters are data, never script source — and `mac_type` (default path), `mac_set_value`, `mac_paste`, and `phone_type` / `phone_find` / `phone_open` pass text on stdin so it does not appear in a process list (`imctl type` never echoes it either). Regression-tested.

These switches do not make observed content trustworthy. Screenshot text, accessibility names, and page content are untrusted input to your model — do not let them override the task. Full threat model and per-threat status: [SECURITY.md](SECURITY.md).

## Tools & docs

- Full tool reference: [docs/tools.md](docs/tools.md) (auto-generated from the running server)
- Usage walkthroughs: [docs/usage.md](docs/usage.md)
- Architecture: [docs/architecture.md](docs/architecture.md)

## Roadmap

- Browser: tab management (list / select / close)
- Act vocabulary (browser): `hover`, `set_value`, `wait_for`
- Measure the token cost of `skeleton` + `root` drill-down against full snapshots
- Open Notification Center's history when the menu-bar clock is not exposed to accessibility
- iPhone: `element_index` over OCR regions, re-checking the text before a tap

## Maintenance

Solo-maintained, no SLA. macOS 15+ for the Mac layer; the iPhone layer also needs Apple silicon or a T2 Mac, iOS 18+ and iPhone Mirroring (not available in the EU); the browser layer runs wherever Playwright does.

## License

MIT — see [LICENSE](LICENSE).

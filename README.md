# noracu

**A local MCP server that lets Claude, Cursor, or any MCP client operate macOS apps and a Playwright browser by `element_index` — and, experimentally, a real iPhone through Apple's iPhone Mirroring (OCR on the Mac, normalized taps). No API key; no telemetry from the server.**

[![CI](https://github.com/sgInnora/noracu/actions/workflows/ci.yml/badge.svg)](https://github.com/sgInnora/noracu/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/noracu.svg)](https://www.npmjs.com/package/noracu)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

中文说明见 [README.zh-CN.md](README.zh-CN.md)。

One stdio MCP server. The agent snapshots a tree, gets an indexed element list, then clicks or types by `element_index` instead of raw pixels — the same observe/act split on the Mac and in the browser. The experimental iPhone layer runs the same observe → act loop over OCR text and normalized coordinates.

![noracu 0.3.0 demo](https://github.com/sgInnora/noracu/releases/download/v0.3.0/noracu-demo.gif)

*noracu 0.3.0 in the person's own Chrome (`browser_launch` with `chrome: true`): it opens a tab of its own on the project's GitHub page, reads the star count from the page, and types it into a new note in Notes. The browser `element_index` loop is in the [v0.1.0 demo](https://raw.githubusercontent.com/sgInnora/noracu/v0.1.0/docs/demo-browser.gif).*

## What it does

One MCP server, three control surfaces:

| Layer | Tools | Drives | Status |
|---|---|---|---|
| **Mac** | 20 (`mac_*`) | macOS Accessibility API (`src/mac-ax.js`, JXA), cliclick, screencapture | stable |
| **Browser** | 13 (`browser_*`) | Playwright (its own persistent profile, or your own Chrome with `chrome: true`, experimental) | stable |
| **iPhone** | 14 (`phone_*`) | iPhone Mirroring via the bundled imctl driver (Python + pyobjc) | experimental |
| **iPhone**, XCUITest backend | 9 (`ios_*`, listed instead of `phone_*`) | a UI-test runner on the phone (`ios-runner/`), Xcode's `devicectl` | experimental, opt-in |

The iPhone layer is experimental, off by default (`NORACU_LAYERS=mac,browser,iphone` turns it on) and ships with its driver (imctl, in `imctl/`). It needs Apple's iPhone Mirroring with the iPhone **locked and near the Mac**, and a python3 with pyobjc; it observes with OCR and acts on normalized coordinates rather than `element_index`. Without pyobjc, `phone_*` tools return a one-line `imctl unavailable` error with the install command, and the Mac and browser layers are unaffected. (With the default `NORACU_LAYERS` the iPhone layer is off entirely: `phone_*` is not listed, and a call answers `unknown tool … the iphone layer is off`.) The observe/act vocabulary follows the action/observation split popularized by ChatGPT's computer-use, re-implemented on open local tooling.

A second iPhone backend is opt-in: with `NORACU_PHONE_BACKEND=xcuitest` the `phone_*` tools give way to nine `ios_*` tools that read the phone's own accessibility elements and act by `element_index`, through a small UI-test runner built with Xcode — see [XCUITest backend](#xcuitest-backend-experimental-opt-in).

## Why noracu

noracu is the local hands, not the model. Your MCP client (Claude Desktop, Claude Code, Cursor) decides what to do; this server only observes and acts on this machine.

- **The server runs entirely on your machine.** No cloud service, no API key, no telemetry, no postinstall scripts. Sole runtime dependency: Playwright. noracu makes no network calls of its own; the only automatic one is the one-time Chromium download on the first `browser_launch` (`NORACU_DISABLE_AUTO_INSTALL=1` turns that off). With `NORACU_ALLOW_CDP=1` it also talks to a DevTools port on 127.0.0.1 that it opened itself (`NORACU_ALLOW_CDP=any` for other loopback ports). The browser still fetches the pages you point it at, and your MCP client still sends tool results — screenshots, OCR text — to whatever model it uses.
- **Acts on semantics, not pixels.** Observation returns the accessibility tree (Mac, read directly through the macOS Accessibility API — about 0.15 s for a 500-element window on our test Mac) or ARIA tree (browser) as an indexed list — text, not screenshots. Actions reference `element_index`; indices expire after 30 s. On the Mac an index is backed by identity evidence (the window's ID, the child path, role, identifier, name) and the element is re-identified before every action; in the browser, tag/name/href/position are re-checked. A gone or changed element returns `element_no_longer_valid` instead of clicking the wrong thing. Screenshots are there when the tree is not enough.
- **Says what happened.** A Mac action uses the element's own accessibility action when it has one (press, select, set value, insert text — no pointer, no focus change, IME-safe text); a physical click is sent only after a hit test shows that the point reaches the element. Every input action result (Mac, browser and iPhone) states whether it was delivered (`delivered_verified` when a change was observed, `delivered_unverified`, `not_delivered`, or `unknown` when a step timed out or failed mid-action) and whether a retry is safe; Mac actions also name any sheet, dialog or menu they opened.
- **Shares the Mac with you.** Mac and iPhone input goes second to the person at the Mac: if the keyboard or mouse was used in the last 2 s (not by noracu), an input tool returns `user_active` and sends nothing, and after a physical click, drag, scroll or phone gesture the pointer goes back where it was, unless someone moved it in the meantime. Read-only tools and the browser layer are not held up. `NORACU_USER_IDLE_S=0` turns this off on a Mac dedicated to the agent.
- **One loop, three surfaces.** Native Mac apps and a persistent-profile browser share the `element_index` protocol (observe a tree, act by index). The experimental iPhone layer runs the same observe → act loop on Apple's iPhone Mirroring, with OCR text and normalized coordinates, because the phone exposes no accessibility tree to the Mac.
- **Uses your real sessions.** Your logged-in browser profile, your Mac apps — not a hosted VM. Compared with cloud computer-use: neither is universally more reliable; they fail differently. noracu keeps the screen on your machine.
- **Off switches that are actually off.** `NORACU_READ_ONLY=1` (observation-only, default-deny) and `NORACU_DISABLE_EVAL=1`; `browser_evaluate` (arbitrary JS) and `file://` are off by default. See [Security](#security).
- **Verifiable.** End-to-end tests (`npm test`; the hardware-free ones run in CI on macos-latest), MIT; the server is `src/server.mjs` plus the Mac accessibility engine `src/mac-ax.js`.

![The person at the Mac goes first](https://github.com/sgInnora/noracu/releases/download/v0.3.0/noracu-person-goes-first.gif)

*noracu types `#n` into a note once a second. While the mouse is in use, each call returns `user_active` and nothing is typed (the gaps in the numbers); once the mouse has been still for 2 s, typing carries on.*

**Not a good fit if** you need more than one browser session at a time (there is one session; `browser_tabs` lists, opens, selects and closes its tabs), you're not on macOS (the Mac and iPhone layers are macOS-only; the browser layer is cross-platform), or you need a finished iPhone layer today (it ships, but experimental — and Apple does not offer iPhone Mirroring in the EU). If you only need browser automation, playwright-mcp has selector APIs that noracu lacks. If you need desktop apps on Windows or Linux, agent-desktop (Vercel Labs) covers macOS, Windows and Linux through each OS's accessibility API; noracu's desktop layer is macOS-only. noracu is for when one agent drives Mac apps, a browser and an iPhone from one server.

## Quickstart

**One line, for Claude Code started from a terminal with Node ≥ 20 on its `PATH`:** `claude mcp add noracu -- npx -y noracu` — then grant the permissions in step 3. Claude Desktop and Cursor need the absolute paths of step 2.

First success is `mac_ax_state` (or a browser snapshot) — not a click, and not a `phone_*` tool. The biggest day-one failure is granting macOS permissions to `node` instead of to the host app; grants apply only after a full quit and reopen.

**1. Install** (Node ≥ 20; no postinstall script):

```bash
npm install noracu          # server at node_modules/noracu/src/server.mjs
brew install cliclick       # needed for physical Mac input (mac_key, mac_drag, and physical mac_click/mac_type)
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
| `phone_*` says `imctl unavailable: no python3 with pyobjc found` | install pyobjc for a python3 (`python3 -m pip install pyobjc-framework-Quartz pyobjc-framework-Vision pyobjc-framework-Cocoa`; Homebrew python3 is the usual choice) or set `NORACU_PYTHON` — see [iPhone layer](#iphone-layer-experimental) |
| `phone_*` refused with `mirror_not_live: …` ("Connection Paused", "iPhone in Use", "not running") or `mirror_state_unknown: …` | the mirror is not running, paused, or its state could not be read — lock the iPhone, keep it near the Mac, check `phone_status`, and call `phone_launch` (it starts Mirroring and clicks Resume) |
| `phone_launch` says `mirror_setup_required` | iPhone Mirroring shows a setup or welcome screen (e.g. the first launch after a macOS upgrade) — finish it yourself in the iPhone Mirroring window; noracu never clicks through it |
| `imctl_timeout: phone … did not finish within …s` | the Mac is under heavy load or the system is stuck — the action may have partly run, so check `phone_status` / `phone_screenshot` before retrying (after `phone_open`, noracu goes back to the Home Screen); the server keeps answering other calls meanwhile |
| `input_busy: …` | an earlier phone or Mac action held the input queue for over 60 s (or `NORACU_PHONE_TIMEOUT_MS` + 15 s); the call did nothing — retry |
| `user_active: …` | someone used this Mac's keyboard or mouse in the last 2 s — nothing was sent; retry after a pause. On a Mac nobody else uses, `NORACU_USER_IDLE_S=0` turns the check off |
| `phone_open` returns app not found for an installed app | it only taps the app's label in Spotlight's Top Hit card, or — where Spotlight shows its search field at the top and no Top Hit card — the label just under the field when the field completes the name as "<name> — Open" — use the name exactly as the phone shows it under the icon (e.g. `拼多多`, not `Pinduoduo`). "Spotlight showed no Top Hit" on an installed app usually means the iPhone's language is not English: `phone_open` reads Spotlight's "Top Hit" label — set `NORACU_TOPHIT_LABELS` to the label your iPhone shows (it covers the Top Hit label only; the "— Open" completion is read in English only). `open_not_confirmed: … never showed up on the phone` means the name did not show up in Spotlight after ⌘V: the paste may not have arrived (it can take several seconds) or the phone may have pasted its own older clipboard into the search field — retry; `phone_open` clears the field first. A one- or two-letter name such as `X` is often unreadable to OCR, so `phone_open` reports `open_not_confirmed` without tapping — open that app from its Home Screen icon (`phone_screenshot`, then `phone_tap`). `phone_open` leaves the app name on the clipboard |
| Typed text comes out re-spaced (e.g. "no ra cu") | it went in as keystrokes (`mac_type` with `mechanism: "physical"`, or a focused element that takes no accessibility text) while a CJK input method was active — use the default `mac_type` mechanism, or `mac_paste` |
| `element_no_longer_valid` | the snapshot is older than 30 s, or the element is gone, changed or in a window that closed — re-run `mac_ax_state` / `browser_snapshot` and use a fresh index |
| `occluded: … — on top: {…}` | a physical click would land on something else (another window, a sheet) — bring the target forward or close what covers it; nothing was sent |
| `ambiguous_window: … windows: […]` | the app has several windows and none is focused — pass `window` (index or title) or `window_id` from `mac_windows` |
| `policy_denied: "cmd-q" …` | `mac_key` refuses quit / log-out / lock / force-quit / delete-immediately / empty-Trash chords unless `force: true`; to quit an app use `mac_app` |

Node 18 is rejected at startup — use Node ≥ 20. Claude Desktop may start one noracu process per surface (e.g. chat and a second surface); they share the browser profile, so launch the browser from only one at a time.

Full worked examples: [docs/usage.md](docs/usage.md).

## iPhone layer (experimental)

noracu can operate a real iPhone through Apple's **iPhone Mirroring**. The layer is off by default: add `"env": { "NORACU_LAYERS": "mac,browser,iphone" }` to the server entry (or `iphone` alone for an entry that carries only the iPhone tools), then quit the host completely and reopen it. The agent observes with OCR on the Mac (`phone_screenshot`, `phone_ocr`, `phone_find`), acts at normalized 0–1 coordinates (`phone_tap`, `phone_swipe`, `phone_scroll`), types by pasting (`phone_type`) and opens apps by name (`phone_open`). This is not `element_index`: the phone exposes no accessibility tree to the Mac, so a tap lands where OCR placed the text. The driver (imctl, Python, MIT, about 3,500 lines) ships in `imctl/`.

**It takes the Mac's pointer and keyboard.** iPhone Mirroring is a Mac window, so every phone input goes through the Mac: iPhone Mirroring comes to the front, taps and swipes move the real pointer, and `phone_type` pastes with ⌘V. Do not use the Mac while a phone step runs — noracu refuses while the keyboard or mouse has been used within the last 2 s (`user_active`, nothing sent; stop using the Mac and retry) and puts the pointer back afterwards, but the window in front changes. The XCUITest backend below does not use the Mac's pointer or keyboard.

**Apple's requirements** ([support.apple.com/120421](https://support.apple.com/120421)): a Mac with Apple silicon or a T2 chip on macOS 15 or later; an iPhone on iOS 18 or later with a passcode; both signed in to the same Apple Account with two-factor authentication; Bluetooth and Wi-Fi on; the Mac not sharing its internet connection or using AirPlay or Sidecar. **The iPhone must be locked and near the Mac** — unlocking it, or quitting iPhone Mirroring, ends the session. iPhone Mirroring is currently unavailable in the EU. One Mac and one iPhone at a time; camera and microphone are not mirrored.

**Unattended sessions:** in iPhone Mirroring → Settings, "Authenticate automatically" lets a session start without a password prompt. Trade-off: anyone who can use your unlocked Mac can then open your phone.

**Python:** the driver needs a python3 that imports pyobjc (Quartz, Vision, AppKit). Set `NORACU_PYTHON`, or noracu probes `/opt/homebrew/bin/python3`, `/usr/local/bin/python3`, `python3`, `/usr/bin/python3` once, on the first `phone_*` call. Apple's `/usr/bin/python3` usually lacks pyobjc; Homebrew's python3 plus `python3 -m pip install pyobjc-framework-Quartz pyobjc-framework-Vision pyobjc-framework-Cocoa` is the common working setup.

**Mirror state:** `phone_status` reports `live` (the phone's screen is being streamed), `overlay` (the text iPhone Mirroring shows instead, e.g. "Connection Paused" or "iPhone in Use"), `paused` (that overlay offers a Resume button) and `setup` (a setup or welcome screen the user must finish — noracu never clicks it). Detection reads the window's structure and shape (the mirror is a tall or wide phone-shaped window; a setup screen is nearly square), not its text. While the mirror is not live, every phone input tool (`phone_tap`, `phone_longpress`, `phone_swipe`, `phone_scroll`, `phone_type`, `phone_key`, `phone_open`, `phone_home` and `phone_app_switcher`) refuses with `mirror_not_live` — without stealing focus when the mirror is paused or closed — instead of acting on the overlay, and refuses with `mirror_state_unknown` if the mirror state still cannot be determined (`phone_ocr` / `phone_find` start their output with a warning). The mirror pauses after inactivity; `phone_launch` brings it forward and clicks Resume.

**Privacy:** whatever the phone shows — notifications, messages, mail, one-time codes — becomes tool output that your MCP client sends to its model. Turn on a Focus, open a neutral app before you start, and begin with `NORACU_READ_ONLY=1` (`phone_status`, `phone_screenshot`, `phone_ocr` and `phone_find` stay allowed; all phone input is refused). iPhone notifications also reach the Mac once Mirroring is set up. Looking is not invisible to the phone either: in a device run (iPhone 17 Pro Max on iOS 27, Mac on macOS 27.2) LinkedIn and rednote each showed their after-screenshot share sheet one to four seconds after every capture of the mirror window, one more sheet per capture. Every tool that reads the screen captures it — `phone_screenshot`, `phone_ocr`, `phone_find`, any `expect` check, and the checks inside `phone_type`, `phone_open` and `phone_scroll` — and so does a phone input that first has to bring iPhone Mirroring to the front. Assume an app that logs screenshots, or tells the other person in a chat about them, does so on every capture (not tested).

**First success:** `phone_status` → `phone_launch` if `live` is not `true` → `phone_screenshot` → `phone_ocr` → `phone_find` + `phone_tap`.

**Known limits:** a tap goes where OCR saw the text, so repeated or misread labels can be hit wrong (`phone_open` cannot tell an app from a contact or website that Spotlight's Top Hit shows under the same name); `phone_scroll` moves lists with trackpad-style scroll events (a vertical `phone_swipe` drag does not scroll a list — use it for gestures such as Home Screen paging, started from the empty strip just above the Dock: a swipe that starts on an app icon picks the icon up and moves it; both points of a swipe are kept inside the phone screen, because iOS cancels a drag that starts or ends on the transparent window margin around it, and the result names any point that was moved; a tap or long press aimed at that margin — the strip above the screen holds the window's own controls — is refused with `out_of_screen`; the screen's edges are measured from one capture of the window and remembered per window size and macOS version in `~/Library/Caches/noracu/phone-screen-rect.json`, and a measurement taken while the pointer rests on that strip is not trusted, so until a clean one is made a point near the top of the window or along its other sides, where the margin may be, is refused for a tap or long press and moved inward for a swipe, and the result says so); on one tested setup (iPhone 17 Pro Max on iOS 27.0.1, Mac on macOS 26.6.2) iPhone Mirroring draws the phone about 17% larger than its window at every View size, so the right column and bottom row are cut off and cannot be reached; moving the window between displays, changing the main display and relaunching made no difference, and the iOS 27 / macOS 26 version mismatch is the main suspect — check `phone_screenshot` if taps near the edges miss; `phone_open` types the app name into Spotlight and taps it only when Spotlight's Top Hit card shows exactly that name — or, where Spotlight puts its search field at the top with no Top Hit card (seen on iOS 27), only when the field completes exactly that name as "<name> — Open" (web suggestions, websites and Settings rows of the same name are never tapped), otherwise returns to the Home Screen — it reads Spotlight's English "Top Hit" label, so on an iPhone set to another language it finds nothing until `NORACU_TOPHIT_LABELS` names that label (the top-field layout's "Open" completion is English only, and `NORACU_TOPHIT_LABELS` does not change it); `phone_home` / `phone_app_switcher` use the iPhone Mirroring menu when live (working without python on English macOS, falling back to an `imctl` gesture only when those menu items are absent, and returning `menu_unknown` without a second gesture on timeout) and report only that the command was sent (`screen not verified`); `phone_type` needs a Mac keyboard layout that keeps A and V where U.S. QWERTY has them (U.S., ABC and Pinyin do; French AZERTY and Dvorak do not) — otherwise it returns `keyboard_layout` and sends nothing; the phone reads the Mac clipboard through Universal Clipboard, which tells it about new content with a delay, so `phone_type` waits at least 1.5 s between writing the clipboard and ⌘V (and returns `focus_lost` without ⌘V if another app comes to the front meanwhile) — in a device run, a ⌘V sent about 0.5 s after the write once pasted the phone's own older clipboard (the previous paste) instead, and a paste can also stop after the phone's "Pasting from …" box; after `type_not_confirmed`, read the field before typing again.

### XCUITest backend (experimental, opt-in)

With the iPhone layer on (`NORACU_LAYERS` names `iphone`), set `NORACU_PHONE_BACKEND=xcuitest` and noracu lists nine `ios_*` tools in place of `phone_*`. They do not go through the iPhone Mirroring window: a small UI-test bundle (the "runner" — Swift, MIT, source in `ios-runner/`) runs on the iPhone and executes one command at a time. The agent reads the app's own accessibility elements (`ios_snapshot`) and acts on them by `element_index` (`ios_tap`, `ios_type`), in screen points instead of OCR positions. Apps are opened by bundle id (`ios_launch`); text is typed as keyboard input with no clipboard involved, and `ios_type` reports `delivered_verified` only when the field that took the text afterwards holds what it held before with the text added in one place (four characters or more).

**Requirements:** Xcode (the full app); an Apple developer team to sign the runner; an iPhone paired with this Mac with Developer Mode on — over a cable or the local network — or a booted simulator. **The iPhone must be unlocked** while these tools are used (the opposite of iPhone Mirroring, which needs it locked): a locked phone gets `device_locked`: no input, and no snapshot or screenshot either.

**Set-up, once per device:** `npx noracu ios-setup --team <TeamID>` builds the runner into `~/.noracu/ios-runner/<udid>` (add `--udid` when several iPhones are connected; a simulator needs only `--udid`). It is an explicit command — nothing is built on install — and the one step of this backend that goes online: Xcode signs the runner for your team and may create a development provisioning profile for it; an iPhone is registered in the team only with `--register-device`. Then start the server with `NORACU_PHONE_BACKEND=xcuitest`. After an upgrade of noracu, run the set-up again when a call answers `runner_version_mismatch`: a runner built from another version's sources is not used.

**First success:** `ios_status` → `ios_launch` (`com.apple.Preferences`) → `ios_snapshot` → `ios_tap` or `ios_type` by `element_index` → `ios_snapshot` again. The first call that needs the phone starts the runner (about 9 s on an iPhone 16 Pro; on a simulator about 2 s once it is warm, and close to half a minute right after it booted); an input call that had to start it sends nothing, because the runner's own app comes to the front — look with `ios_snapshot` first. The server stops the runner when it exits.

**How it differs from the Mirroring backend:** elements with an `element_index` instead of OCR text; an index is re-checked before it is used (`element_no_longer_valid` when the element moved, changed, or its app left the front) and ended by `ios_home` and `ios_launch`; apps are named by bundle id, and noracu knows which app is in front only for the app a call names. `NORACU_STOP_FILE`, `NORACU_DENY_APPS` and `NORACU_APPROVAL_FILE` apply — matched on the iOS bundle id; the default deny list names Mac apps only — terminal apps and IDEs with a built-in terminal — so no iOS app matches it by default — and when app rules (`NORACU_APPROVAL_FILE` or a custom `NORACU_DENY_APPS`) are active, input targeting the Home Screen (`com.apple.springboard`) is always refused, even if listed in `allow` (use `ios_launch` to open approved apps) — and `NORACU_USER_IDLE_S` does not, as these tools do not use the Mac's keyboard or mouse. While a system prompt (a permission alert) is up on the iPhone, input named for an app is not sent (`system_alert`); the person answers it on the phone.

**Privacy:** `ios_snapshot` and `ios_screenshot` return what the app shows — messages, notifications, one-time codes — to your MCP client and its model, as with the Mirroring backend. Under `NORACU_READ_ONLY=1` this backend answers `ios_status` only: all iPhone input is refused, and `ios_snapshot` / `ios_screenshot` return `runner_not_started`, because reading the screen needs the runner and starting it puts the runner's own app in front of whatever the iPhone shows.

**Tested with:** an iPhone 16 Pro on iOS 27.2 and an iPhone 17 Pro simulator on iOS 26.5, Xcode 27.2, in the Settings app and on the Home Screen. On the iPhone the lock check adds about 0.8 s to every input, and to a snapshot or screenshot taken more than a second after the last check. What was not tested is in the CHANGELOG's known issues; the risks of this backend are in [SECURITY.md](SECURITY.md).

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `NORACU_READ_ONLY` | unset | `=1` observation-only: a default-deny allowlist of observe + browser-lifecycle tools — 8 `mac_*`, 6 `browser_*` and, with the iPhone layer on, the 4 observing `phone_*` ones (under the XCUITest backend `ios_status`, `ios_snapshot` and `ios_screenshot` instead; `ios_snapshot` and `ios_screenshot` are refused with `runner_not_started`, since observation-only mode does not start the runner); every click/type/paste/key/eval tool is refused (`mac_clipboard_read`, `mac_notifications`, and `mac_wait` with `condition: "notification"` too; `mac_ax_state` / `mac_find` also skip `web_accessibility`) |
| `NORACU_ENABLE_EVAL` | unset | `=1` turns `browser_evaluate` (arbitrary JS in the page) on; unset, it returns `eval_disabled` when called (it stays listed) |
| `NORACU_DISABLE_EVAL` | unset | `=1` keeps `browser_evaluate` off even when `NORACU_ENABLE_EVAL=1` (kill switch) |
| `NORACU_ALLOW_FILE_URL` | unset | `=1` lets `browser_navigate` open `file://` URLs (blocked by default) |
| `NORACU_DISABLE_AUTO_INSTALL` | unset | `=1` skips the Chromium auto-install on first `browser_launch` |
| `NORACU_ALLOW_CHROME` | unset | `=1` lets `browser_launch` with `chrome: true` work in your own Chrome, with its sign-ins, through Chrome's remote-debugging switch (`chrome://inspect/#remote-debugging`, Chrome 144+; Chrome asks you to allow each connection). noracu opens a window of its own there and works only in the tabs it opens; refused under `NORACU_READ_ONLY=1` |
| `NORACU_CHROME_TABS` | unset (noracu's own tabs) | `all`: with `chrome: true`, your other Chrome tabs are listed too and can be selected, read and acted on (http(s) pages only); only noracu's own tabs are ever closed |
| `NORACU_CHROME_DIR` | `~/Library/Application Support/Google/Chrome` | the profile folder whose `DevToolsActivePort` file `chrome: true` reads (Chrome Beta, Canary or another Chromium-based browser) |
| `NORACU_ALLOW_CDP` | unset | `=1` allows `mac_app` launch with `cdp_port` and `browser_launch` with `cdp_port` for ports opened by this `noracu` process (live PID and matching `webSocketDebuggerUrl`); `=any` also allows `browser_launch` to attach to any loopback DevTools port on 127.0.0.1 (always refused under `NORACU_READ_ONLY=1`) |
| `NORACU_TRACE` | unset | a file path: one JSON line per tool call (`{ts, tool, args, ms, error, code}` — argument names/sizes and error code prefix only, never argument text, result text, or error messages; opened `0600` with `O_NOFOLLOW`, refusing symlinks) |
| `NORACU_CLICLICK` | `/opt/homebrew/bin/cliclick` | cliclick binary path |
| `NORACU_PYTHON` | auto-probe | python3 used for the bundled iPhone driver; must import pyobjc (Quartz, Vision, AppKit). Unset → first working of `/opt/homebrew/bin/python3`, `/usr/local/bin/python3`, `python3`, `/usr/bin/python3` |
| `NORACU_IMCTL_DIR` | bundled `imctl/` | override the driver location (development only) |
| `NORACU_PHONE_TIMEOUT_MS` | 30000 (45000 for `phone_open` / `phone_type`) | time limit for each iPhone-layer step, 1000–600000 ms; on expiry the step is stopped and returns `imctl_timeout` |
| `NORACU_OCR_LANGUAGES` | `zh-Hans,en-US` | OCR languages for the iPhone screen, in priority order (comma-separated Vision language codes, e.g. `zh-Hant,en-US` or `en-US`; codes Vision does not list are skipped with a warning) |
| `NORACU_TOPHIT_LABELS` | `Top Hit` | the label of Spotlight's Top Hit section that `phone_open` looks for, comma-separated — set it to the label your iPhone shows when it is not set to English |
| `NORACU_OCR_MIN_CONFIDENCE` | unset (off) | opt-in, experimental: a number above 0 and at most 1. With it, `phone_open` does not tap a Spotlight label the recognizer read with a lower confidence and answers `open_not_confirmed` with nothing tapped; a value that is set and is not such a number makes `phone_open` refuse (`invalid_args`, nothing sent). Set or not, `phone_open`'s result line names the confidence of the label it read, including when it then taps nothing |
| `NORACU_USER_IDLE_S` | `2` | seconds without keyboard or mouse input (other than noracu's own) before a Mac or iPhone input tool acts; sooner, it returns `user_active` and sends nothing. While it is not 0, the pointer also goes back where it was after physical clicks, drags, scrolls and phone gestures, unless someone moved it in the meantime. 0–60; `0` turns both off (a Mac dedicated to the agent); any other value falls back to 2. The `ios_*` tools do not wait: they do not use this Mac's keyboard or mouse |
| `NORACU_NO_BGPOST` | unset | `=1` turns off background input: physical clicks and named keys use the real pointer and the HID key path, as in 0.2.7 |
| `NORACU_PHONE_BACKEND` | `mirror` | `xcuitest` lists the `ios_*` tools (XCUITest backend, experimental) instead of `phone_*`; any other value falls back to `mirror` with a warning on stderr |
| `NORACU_IOS_UDID` | unset | the iPhone or simulator the XCUITest backend uses; needed when several iPhones are connected, and always for a simulator |
| `NORACU_IOS_RUNNER_DIR` | `~/.noracu/ios-runner` | where `noracu ios-setup` puts the runner build and the server looks for it |
| `NORACU_LAYERS` | unset (`mac,browser`) | comma-separated list of `mac`, `browser`, `iphone`: only those layers' tools are listed and callable — the experimental iPhone layer only when `iphone` is named (`NORACU_LAYERS=mac,browser,iphone`), and the `initialize` instructions name only them (e.g. `NORACU_LAYERS=iphone` for a client entry that carries the iPhone tools only); a name that is not one of the three stops the server at start |
| `NORACU_STOP_FILE` | unset | a file path: while that file exists, every input tool — Mac (`mac_*`), iPhone (`phone_*`, `ios_*`) and browser input (`browser_navigate`, `browser_click`, `browser_type`, `browser_fill`, `browser_press_key`, `browser_scroll`, `browser_evaluate`, `browser_tabs` new/close) — returns `user_stopped` and sends nothing; observation tools are not stopped |
| `NORACU_DENY_APPS` | the common terminal apps and IDEs with a built-in terminal | comma-separated bundle ids or app names (`*` and `?` wildcards) that never get input; the list adds to the default — blank keeps the default list, a list starting with `none` drops it (`none` alone: no deny list; `none,com.example.app`: only that app) |
| `NORACU_APPROVAL_FILE` | unset | a JSON file `{allow, ask, deny}` of bundle-id / app-name patterns, mode `0600`, owned by you; an app under `ask` or not listed gets `approval_required`; once it is set, a missing, malformed, symlinked, group-readable or foreign-owned file, or an unknown key, refuses all Mac and iPhone input (app rules do not apply to the browser layer) — as does setting it to a blank value, until removed or given a path; a blank `NORACU_STOP_FILE` refuses all input, browser input included |

## Security

noracu runs with the privileges of your MCP client. It clicks, types, pastes, and drives a real browser on this machine — there is no sandbox and no remote approval prompt. Set these on the server entry, then quit the host completely and reopen it:

```json
"env": { "NORACU_READ_ONLY": "1", "NORACU_DISABLE_EVAL": "1" }
```

- **Tool annotations are hints, not permissions.** Every tool reports the four MCP tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), set by what the tool does — see [docs/tools.md](docs/tools.md). A client may use them to decide what to confirm with you; they restrict nothing, and a client speaking the 2024-11-05 protocol noracu answers with may ignore them. They also do not mirror `NORACU_READ_ONLY=1`: `mac_clipboard_read` is read-only by behaviour yet refused there, and `browser_navigate` is allowed there yet not read-only.
- **`NORACU_READ_ONLY=1`** is the safe first-run mode. It refuses every tool not on an 18-name allowlist (the observe tools plus standalone `browser_launch`/`browser_navigate`/`browser_close`; `browser_launch` with `cdp_port` is refused even when `NORACU_ALLOW_CDP` is set); every click, type, paste, and eval tool is denied, and so are `mac_clipboard_read`, `mac_notifications`, and `mac_wait` with `condition: "notification"`, while `mac_ax_state` and `mac_find` do not toggle `web_accessibility` on apps. `browser_navigate` is on the allowlist, so it can still load a URL.
- **`browser_evaluate` is off by default.** It runs any script in the page, so it returns `eval_disabled` unless the server was started with `NORACU_ENABLE_EVAL=1`; `NORACU_DISABLE_EVAL=1` keeps it off even then. It stays listed in `tools/list`. Snapshot, click, and type still work.
- **`file://` is refused** unless `NORACU_ALLOW_FILE_URL=1`, so a browser agent can't read `~/Documents` by navigating to it. (The browser itself may follow a redirect during navigation, but every subsequent tool call and in-flight read/snapshot re-checks the active page's URL and refuses non-passing URLs — see SECURITY.md.)
- **Focus guard:** pass `app` to `mac_paste` / `mac_key` (and `mac_type` when it sends keystrokes) and input is refused unless that app is frontmost. Omit `app` and the guard is off. `mac_type`'s default accessibility path writes into a named element or the app's focused element and sends no keystrokes at all; it falls back to keystrokes only into a text view accessibility cannot write (a terminal), never when the focus is a button, list or sheet, and into an app that reports no focused element only when `app` names it (otherwise `no_focus`, nothing sent).
- **Stale-element protection:** an `element_index` is not a coordinate. It expires after 30 s, and on the Mac it is never reused by a later snapshot. A Mac element is re-identified inside the very window or open menu it was seen in (by window ID), at the same place in that window, under the same labelled ancestors and in the same table row; an element without a label or identifier must still be exactly where it was. An element read with `surface: "app"` is bound to its window's ID too, and a window without an ID (other than Finder's desktop) is refused with `policy_denied`, so a window closed and reopened with the same content never inherits old indexes. A browser click re-checks tag/name/href/position. Otherwise `element_no_longer_valid`.
- **Hit test before physical clicks:** a Mac click or drag that has to use the pointer is sent only when the element at that point is the target — or, when accessibility cannot tell, when the topmost on-screen window there is that same window (by window ID, not covered by another window of the same app); otherwise `occluded`, with what is on top. Right before the click is sent, the window on top at the point is checked again; afterwards the result is `delivered_verified` only if the element is still there, changed, and its own window is still on top at the point. A click at raw x,y goes out only when the topmost on-screen window at that point belongs to `app` (default: the frontmost app; the menu bar counts as the frontmost app's); `force: true` skips that check. Keystrokes typed after such a click go out only if the element's app is then frontmost.
- **Background windows:** semantic Mac actions also work on windows you are not looking at. That is the point (no stolen focus), but it means an agent can act where you do not see it — watch the results' `delivery` and keep high-stakes apps closed.
- **Background clicks and keys (bgpost):** under `mechanism: "auto"`, a physical click on a native app, and a named key for a native frontmost app, are posted straight to the app's process — the pointer does not move, and you may not see it happen. Web-engine apps (Chromium/Electron) and `mechanism: "physical"` use the real pointer; the result's `route` says which. A posted click is never re-sent another way: no visible change is reported as `delivered_unverified`, a timeout as `delivery=unknown`. `NORACU_NO_BGPOST=1` turns this off.
- **Stop, deny, approve:** while the file named by `NORACU_STOP_FILE` exists, every input tool returns `user_stopped` and sends nothing — Mac (`mac_*`), iPhone (`phone_*`, `ios_*`) and browser input (`browser_navigate`, `browser_click`, `browser_type`, `browser_fill`, `browser_press_key`, `browser_scroll`, `browser_evaluate`, `browser_tabs` new/close); observation tools are not stopped (`touch` it to stop, delete it to resume). `NORACU_DENY_APPS` lists apps that never get input — by default the common terminal apps (Terminal, iTerm2, WezTerm, Ghostty, Warp, Alacritty, kitty, Hyper) and the IDEs with a built-in terminal (VS Code, Cursor, Windsurf, Zed, JetBrains IDEs, Android Studio — their preview and nightly editions too; the name `Code` and `com.jetbrains.*` also catch any app named exactly Code and JetBrains Toolbox), so an agent cannot type into those shells (other apps that host a shell are not on it); a list of your own adds to it, and a list starting with `none` drops it. `NORACU_APPROVAL_FILE` (opt-in) names a `0600` JSON file `{ "allow": [...], "ask": [...], "deny": [...] }` of bundle-id or app-name patterns: an app under `ask` or not listed gets `approval_required`, and noracu never writes the file; once the variable is set, a missing or broken file refuses all Mac and iPhone input (the browser layer is not judged by app rules; the stop file stops it). An app whose bundle id cannot be read gets nothing while either rule is in force. Each check judges the app that receives the input — the element's app, the named app, or the app on top at an x,y point — and an app that cannot be identified gets nothing. These files stop the model, not other software running as you: see SECURITY.md.
- **Guarded keys, menus and quits:** `mac_key` refuses quit / log-out / lock / force-quit / delete-immediately / empty-Trash chords unless `force: true`; `mac_menu_command` applies the same chord list to menu shortcuts and refuses Apple-menu items unless `force: true`. Neither `mac_app` nor `mac_menu_command` ever quits Finder, the Dock, loginwindow, other session processes or the MCP host itself; `force: true` is needed on `mac_app` to force-quit.
- **Your own Chrome is opt-in:** `browser_launch` with `chrome: true` needs `NORACU_ALLOW_CHROME=1` and Chrome's own remote-debugging switch (`chrome://inspect/#remote-debugging`); Chrome asks you to allow each connection and shows a banner while it is open. noracu then opens a window of its own in your Chrome and lists, reads and acts only on the tabs it opened there (and tabs those open); noracu never lists, reads or acts on your other tabs unless you also set `NORACU_CHROME_TABS=all` (then your tabs on http(s) pages — never `file://` or browser pages, whatever `NORACU_ALLOW_FILE_URL` says — are listed and can be selected, read and acted on, but never closed or sent to a non-http(s) address; one becomes the active page only when selected and stops being it when it leaves http(s)); in noracu's own tabs the address rules (http(s) only; `file://` needs `NORACU_ALLOW_FILE_URL=1`) apply. Those tabs carry your sign-ins, so an agent working there acts as you on those sites; `browser_evaluate` never runs there. `browser_close` closes noracu's tabs and disconnects; noracu never quits Chrome. Refused under `NORACU_READ_ONLY=1`.
- **DevTools ports are opt-in:** `mac_app` / `browser_launch` with `cdp_port` need `NORACU_ALLOW_CDP=1` (`NORACU_ALLOW_CDP=any` to attach to a port `noracu` did not open itself; always refused under `NORACU_READ_ONLY=1`), bind to 127.0.0.1 only, canonicalize `.app` paths and refuse an app that is already running or that the app rules (deny list, approval file) rule out, and give Chrome-family browsers a separate `0700` profile under `~/.noracu/cdp-profiles`. While the port is open, any local process can control that app (127.0.0.1 has no per-user isolation).
- **Clipboard, password fields and notifications are private:** `mac_paste` puts the user's clipboard back (every item and type) and never copies an item a password manager marked concealed — it clears the clipboard after the paste instead; `mac_clipboard_read` never returns a concealed item; `mac_set_value` on a secure password field (`AXSecureTextField`) never echoes the value; `mac_notifications` returns notification text verbatim. `mac_clipboard_read`, `mac_notifications`, and `mac_wait` on notifications are outside read-only mode.
- **iPhone screen is model input:** `phone_screenshot` / `phone_ocr` / `phone_find` return whatever the phone shows — notifications, messages, one-time codes. Use a Focus and a neutral app, and start with `NORACU_READ_ONLY=1` (phone observation allowed, phone input refused). Phone input is also refused when the mirror is not live (`mirror_not_live`) or its state cannot be read (`mirror_state_unknown`).
- **Injection-safe JXA and stdin text:** the accessibility engine (`src/mac-ax.js`) is a static script that takes its whole request as JSON on stdin — parameters are data, never script source — and `mac_type` (default path), `mac_set_value`, `mac_paste`, and `phone_type` / `phone_find` / `phone_open` pass text on stdin so it does not appear in a process list (`imctl type` never echoes it either). Regression-tested.

**What it refuses by default** — a refused input sends nothing, and its error says so (`delivery=not_delivered, retry=safe`):

| Refused by default | Answer | To change it |
|---|---|---|
| Input into terminals and IDEs with a built-in terminal | `input_denied` | `NORACU_DENY_APPS` (a list starting with `none` drops the default) |
| `browser_evaluate` (any script in the page) | `eval_disabled` | `NORACU_ENABLE_EVAL=1` |
| `file://` pages in the browser | refused at the URL | `NORACU_ALLOW_FILE_URL=1` |
| DevTools ports (`cdp_port`) | refused | `NORACU_ALLOW_CDP=1` |
| Working in your own Chrome (`browser_launch` with `chrome: true`) | `policy_denied` | `NORACU_ALLOW_CHROME=1`, and Chrome's switch at `chrome://inspect/#remote-debugging` |
| The iPhone tools | not listed; a call answers `unknown tool … the iphone layer is off` | `NORACU_LAYERS=mac,browser,iphone` |
| Mac input and iPhone Mirroring input while you use the keyboard or mouse | `user_active` | `NORACU_USER_IDLE_S=0` |
| Quit, log-out, lock, force-quit, delete-immediately and empty-Trash chords; Apple-menu items | refused | `force: true` |
| Every input while the stop file exists — once you name one with `NORACU_STOP_FILE` | `user_stopped` | delete the file |

These switches do not make observed content trustworthy. Screenshot text, accessibility names, and page content are untrusted input to your model — do not let them override the task. Full threat model and per-threat status: [SECURITY.md](SECURITY.md).

## Tools & docs

- Full tool reference: [docs/tools.md](docs/tools.md) (auto-generated from the running server)
- Usage walkthroughs: [docs/usage.md](docs/usage.md)
- Architecture: [docs/architecture.md](docs/architecture.md)

## Roadmap

- Act vocabulary (browser): `hover`, `set_value`, `wait_for`
- Measure the token cost of `skeleton` + `root` drill-down against full snapshots
- Open Notification Center's history when the menu-bar clock is not exposed to accessibility
- iPhone: `element_index` over OCR regions, re-checking the text before a tap

## Maintenance

Solo-maintained, no SLA. macOS 15+ for the Mac layer; the iPhone layer also needs Apple silicon or a T2 Mac, iOS 18+ and iPhone Mirroring (not available in the EU); the browser layer runs wherever Playwright does.

## License

MIT — see [LICENSE](LICENSE).

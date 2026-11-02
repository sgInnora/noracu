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
| **Mac** | 9 (`mac_*`) | cliclick, screencapture, JXA System Events | stable |
| **Browser** | 12 (`browser_*`) | Playwright (persistent profile) | stable |
| **iPhone** | 14 (`phone_*`) | iPhone Mirroring via the bundled imctl driver (Python + pyobjc) | experimental |

The iPhone layer is experimental and ships with its driver (imctl, in `imctl/`). It needs Apple's iPhone Mirroring with the iPhone **locked and near the Mac**, and a python3 with pyobjc; it observes with OCR and acts on normalized coordinates rather than `element_index`. Without pyobjc, `phone_*` tools return a one-line `imctl unavailable` error with the install command, and the Mac and browser layers are unaffected. The observe/act vocabulary follows the action/observation split popularized by ChatGPT's computer-use, re-implemented on open local tooling.

## Why noracu

noracu is the local hands, not the model. Your MCP client (Claude Desktop, Claude Code, Cursor) decides what to do; this server only observes and acts on this machine.

- **The server runs entirely on your machine.** No cloud service, no API key, no telemetry, no postinstall scripts. Sole runtime dependency: Playwright. noracu makes no network calls of its own; the only automatic one is the one-time Chromium download on the first `browser_launch` (`NORACU_DISABLE_AUTO_INSTALL=1` turns that off). The browser still fetches the pages you point it at, and your MCP client still sends tool results — screenshots, OCR text — to whatever model it uses.
- **Acts on semantics, not pixels.** Observation returns the accessibility tree (Mac) or ARIA tree (browser) as an indexed list — text, not screenshots. Actions reference `element_index`; indices expire after 30 s, and clicks re-verify the target (tag/name/href/position in the browser, frontmost app on the Mac) before firing. A stale reference returns `element_no_longer_valid` instead of clicking the wrong thing. Screenshots are there when the tree is not enough.
- **One loop, three surfaces.** Native Mac apps and a persistent-profile browser share the `element_index` protocol (observe a tree, act by index). The experimental iPhone layer runs the same observe → act loop on Apple's iPhone Mirroring, with OCR text and normalized coordinates, because the phone exposes no accessibility tree to the Mac.
- **Uses your real sessions.** Your logged-in browser profile, your Mac apps — not a hosted VM. Compared with cloud computer-use: neither is universally more reliable; they fail differently. noracu keeps the screen on your machine.
- **Off switches that are actually off.** `NORACU_READ_ONLY=1` (observation-only, default-deny), `NORACU_DISABLE_EVAL=1`, and `file://` blocked by default. See [Security](#security).
- **Verifiable.** 39 end-to-end checks (`npm test`), CI on macos-latest, MIT, and the whole server is one file: `src/server.mjs`.

**Not a good fit if** you need multiple browser tabs or sessions (single session for now), you're not on macOS (the Mac and iPhone layers are macOS-only; the browser layer is cross-platform), or you need a finished iPhone layer today (it ships, but experimental — and Apple does not offer iPhone Mirroring in the EU). If you only need browser automation, playwright-mcp has tab management and selector APIs that noracu v0.1 lacks; noracu is for when one agent also has to leave the browser and drive Mac apps.

## Quickstart

First success is `mac_ax_state` (or a browser snapshot) — not a click, and not a `phone_*` tool. The biggest day-one failure is granting macOS permissions to `node` instead of to the host app; grants apply only after a full quit and reopen.

**1. Install** (Node ≥ 20; no postinstall script):

```bash
npm install noracu          # server at node_modules/noracu/src/server.mjs
brew install cliclick       # required for Mac input (mac_click/type/key/paste)
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

**4. Verify.** With Finder in front, call `mac_ax_state` (no args) — it returns an indexed accessibility tree; indices last 30 s. Browser smoke test (no Accessibility needed): `browser_launch` (first run downloads Chromium unless `NORACU_DISABLE_AUTO_INSTALL=1`) → `browser_navigate` → `browser_snapshot` → `browser_click` by index.

### Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `mac_*` fails with error **-1719** | Accessibility not granted to the **host** app — grant it, then quit + reopen the host |
| Screenshots come back all black | Screen Recording not granted to the host — grant it, then quit + reopen |
| `ENOENT` mentioning cliclick | `brew install cliclick` (or set `NORACU_CLICLICK`) |
| `spawn node` / `npx` `ENOENT` from a GUI host | use an absolute `node` path in the config — nvm/volta/homebrew shims are not on the GUI `PATH` |
| `browser_launch` hangs on first use | one-time Chromium download; or auto-install disabled (`NORACU_DISABLE_AUTO_INSTALL=1`) → run `npx playwright install chromium` |
| `phone_*` says `imctl unavailable: no python3 with pyobjc found` | install pyobjc for a python3 (`python3 -m pip install pyobjc-framework-Quartz pyobjc-framework-Vision pyobjc-framework-AppKit`; Homebrew python3 is the usual choice) or set `NORACU_PYTHON` — see [iPhone layer](#iphone-layer-experimental) |
| `phone_*` refused with `mirror_not_live: …` ("Connection Paused", "iPhone in Use") | the mirror is paused or the iPhone is unlocked — lock the iPhone, keep it near the Mac, then call `phone_launch` (it clicks Resume) |
| Typed text comes out re-spaced (e.g. "no ra cu") | a CJK input method is active — use `mac_paste` instead of `mac_type` |
| `element_no_longer_valid` | the snapshot is older than 30 s or the UI changed — re-run `mac_ax_state` / `browser_snapshot` and use a fresh index |

Node 18 is rejected at startup — use Node ≥ 20. Claude Desktop may start one noracu process per surface (e.g. chat and a second surface); they share the browser profile, so launch the browser from only one at a time.

Full worked examples: [docs/usage.md](docs/usage.md).

## iPhone layer (experimental)

noracu can operate a real iPhone through Apple's **iPhone Mirroring**. The agent observes with OCR on the Mac (`phone_screenshot`, `phone_ocr`, `phone_find`), acts at normalized 0–1 coordinates (`phone_tap`, `phone_swipe`, `phone_scroll`), types by pasting (`phone_type`) and opens apps by name (`phone_open`). This is not `element_index`: the phone exposes no accessibility tree to the Mac, so a tap lands where OCR placed the text. The driver (imctl, Python, MIT, about 1,000 lines) ships in `imctl/`.

**Apple's requirements** ([support.apple.com/120421](https://support.apple.com/120421)): a Mac with Apple silicon or a T2 chip on macOS 15 or later; an iPhone on iOS 18 or later with a passcode; both signed in to the same Apple Account with two-factor authentication; Bluetooth and Wi-Fi on; the Mac not sharing its internet connection or using AirPlay or Sidecar. **The iPhone must be locked and near the Mac** — unlocking it, or quitting iPhone Mirroring, ends the session. iPhone Mirroring is currently unavailable in the EU. One Mac and one iPhone at a time; camera and microphone are not mirrored.

**Unattended sessions:** in iPhone Mirroring → Settings, "Authenticate automatically" lets a session start without a password prompt. Trade-off: anyone who can use your unlocked Mac can then open your phone.

**Python:** the driver needs a python3 that imports pyobjc (Quartz, Vision, AppKit). Set `NORACU_PYTHON`, or noracu probes `/opt/homebrew/bin/python3`, `/usr/local/bin/python3`, `python3`, `/usr/bin/python3` once, on the first `phone_*` call. Apple's `/usr/bin/python3` usually lacks pyobjc; Homebrew's python3 plus `python3 -m pip install pyobjc-framework-Quartz pyobjc-framework-Vision pyobjc-framework-AppKit` is the common working setup.

**Mirror state:** `phone_status` reports `live` (the phone's screen is being streamed), `overlay` (the text iPhone Mirroring shows instead, e.g. "Connection Paused" or "iPhone in Use") and `paused` (that overlay offers a Resume button). Detection reads the window's structure, not its text. While the mirror is not live, `phone_tap`, `phone_longpress`, `phone_swipe`, `phone_scroll`, `phone_type`, `phone_key` and `phone_open` refuse with `mirror_not_live` instead of tapping the overlay, and `phone_ocr` / `phone_find` start their output with a warning. The mirror pauses after inactivity; `phone_launch` brings it forward and clicks Resume.

**Privacy:** whatever the phone shows — notifications, messages, mail, one-time codes — becomes tool output that your MCP client sends to its model. Turn on a Focus, open a neutral app before you start, and begin with `NORACU_READ_ONLY=1` (`phone_status`, `phone_screenshot`, `phone_ocr` and `phone_find` stay allowed; all phone input is refused). iPhone notifications also reach the Mac once Mirroring is set up.

**First success:** `phone_status` → `phone_launch` if `live` is not `true` → `phone_screenshot` → `phone_ocr` → `phone_find` + `phone_tap`.

**Known limits:** a tap goes where OCR saw the text, so repeated or misread labels can be hit wrong; `phone_scroll` moves lists with trackpad-style scroll events (a vertical `phone_swipe` drag does not scroll a list — use it for gestures such as Home Screen paging); on one tested setup (iPhone 17 Pro Max on iOS 27.0.1, Mac on macOS 26.6.2) iPhone Mirroring draws the phone about 17% larger than its window at every View size, so the right column and bottom row are cut off and cannot be reached; moving the window between displays, changing the main display and relaunching made no difference, and the iOS 27 / macOS 26 version mismatch is the main suspect — check `phone_screenshot` if taps near the edges miss; `phone_open` types the app name into Spotlight and taps an exact match, otherwise returns to the Home Screen; `phone_home` / `phone_app_switcher` use the iPhone Mirroring menu (English macOS) and work without python while connected.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `NORACU_READ_ONLY` | unset | `=1` observation-only: a default-deny allowlist of 12 observe + browser-lifecycle tools; every click/type/paste/key/eval tool is refused |
| `NORACU_DISABLE_EVAL` | unset | `=1` makes `browser_evaluate` (arbitrary JS) return an error when called (it stays listed) |
| `NORACU_ALLOW_FILE_URL` | unset | `=1` lets `browser_navigate` open `file://` URLs (blocked by default) |
| `NORACU_DISABLE_AUTO_INSTALL` | unset | `=1` skips the Chromium auto-install on first `browser_launch` |
| `NORACU_CLICLICK` | `/opt/homebrew/bin/cliclick` | cliclick binary path |
| `NORACU_PYTHON` | auto-probe | python3 used for the bundled iPhone driver; must import pyobjc (Quartz, Vision, AppKit). Unset → first working of `/opt/homebrew/bin/python3`, `/usr/local/bin/python3`, `python3`, `/usr/bin/python3` |
| `NORACU_IMCTL_DIR` | bundled `imctl/` | override the driver location (development only) |

## Security

noracu runs with the privileges of your MCP client. It clicks, types, pastes, and drives a real browser on this machine — there is no sandbox and no remote approval prompt. Set these on the server entry, then quit the host completely and reopen it:

```json
"env": { "NORACU_READ_ONLY": "1", "NORACU_DISABLE_EVAL": "1" }
```

- **`NORACU_READ_ONLY=1`** is the safe first-run mode. It refuses every tool not on a 12-name allowlist (the observe tools plus `browser_launch`/`browser_navigate`/`browser_close`); every click, type, paste, and eval tool is denied. `browser_navigate` is on the allowlist, so it can still load a URL.
- **`NORACU_DISABLE_EVAL=1`** makes `browser_evaluate` return an error when called (it stays listed in `tools/list`). Snapshot, click, and type still work.
- **`file://` is refused** unless `NORACU_ALLOW_FILE_URL=1`, so a browser agent can't read `~/Documents` by navigating to it. (The initial navigation URL is scheme-checked; redirects are not — see SECURITY.md.)
- **Focus guard:** pass `app` to `mac_type` / `mac_paste` / `mac_key` and input is refused unless that app is frontmost. Omit `app` and the guard is off.
- **Stale-element protection:** an `element_index` is not a coordinate. It expires after 30 s (`element_no_longer_valid`); a browser click re-checks tag/name/href/position, and a Mac click is refused if the frontmost app changed since the snapshot.
- **iPhone screen is model input:** `phone_screenshot` / `phone_ocr` / `phone_find` return whatever the phone shows — notifications, messages, one-time codes. Use a Focus and a neutral app, and start with `NORACU_READ_ONLY=1` (phone observation allowed, phone input refused). Phone input is also refused while the mirror is paused (`mirror_not_live`).
- **Injection-safe JXA:** string parameters are passed to `osascript` as argv data, never built into the script; the one numeric value (AX read depth) is clamped to 1–10 before use. Regression-tested.

These switches do not make observed content trustworthy. Screenshot text, accessibility names, and page content are untrusted input to your model — do not let them override the task. Full threat model and per-threat status: [SECURITY.md](SECURITY.md).

## Tools & docs

- Full tool reference: [docs/tools.md](docs/tools.md) (auto-generated from the running server)
- Usage walkthroughs: [docs/usage.md](docs/usage.md)
- Architecture: [docs/architecture.md](docs/architecture.md)

## Roadmap

- Browser: tab management (list / select / close)
- Act vocabulary (browser): `hover`, `set_value`, `wait_for`
- Snapshot diffing to cut token use — pending measurement
- iPhone: `element_index` over OCR regions, re-checking the text before a tap

## Maintenance

Solo-maintained, no SLA. macOS 15+ for the Mac layer; the iPhone layer also needs Apple silicon or a T2 Mac, iOS 18+ and iPhone Mirroring (not available in the EU); the browser layer runs wherever Playwright does.

## License

MIT — see [LICENSE](LICENSE).

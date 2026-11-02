# noracu

**Local, no-cloud MCP server for computer-use on macOS apps, a Playwright browser, and (experimentally) a mirrored iPhone — the agent reads an accessibility/ARIA tree and acts by `element_index`, not pixels. No API key, no telemetry.**

[![CI](https://github.com/sgInnora/noracu/actions/workflows/ci.yml/badge.svg)](https://github.com/sgInnora/noracu/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/noracu.svg)](https://www.npmjs.com/package/noracu)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

中文说明见 [README.zh-CN.md](README.zh-CN.md)。

One stdio MCP server. The agent snapshots a tree, gets an indexed element list, then clicks or types by `element_index` instead of raw pixels — the same observe/act split on the Mac and in the browser.

![browser element_index demo](https://raw.githubusercontent.com/sgInnora/noracu/v0.1.0/docs/demo-browser.gif)

*`browser_snapshot` returns an indexed ARIA tree; `browser_click` acts by `element_index`. The Mac layer runs the same loop (`mac_ax_state` → `mac_click`). Highlight boxes are overlays from `demo/record-browser.mjs`, not a product feature. The iPhone layer is not in this demo.*

## What it does

One MCP server, three control surfaces:

| Layer | Tools | Drives | Status |
|---|---|---|---|
| **Mac** | 9 (`mac_*`) | cliclick, screencapture, JXA System Events | stable |
| **Browser** | 12 (`browser_*`) | Playwright (persistent profile) | stable |
| **iPhone** | 14 (`phone_*`) | iPhone Mirroring via imctl (not public; 2 tools work without it) | experimental |

The iPhone layer is experimental and gated by imctl, a companion tool that is not yet public. Without imctl, most `phone_*` tools return a structured error; the Mac and browser layers are unaffected (`phone_home` / `phone_app_switcher` still work through the iPhone Mirroring menu when a phone is connected). The observe/act vocabulary follows the action/observation split popularized by ChatGPT's computer-use, re-implemented on open local tooling.

## Why noracu

noracu is the local hands, not the model. Your MCP client (Claude Desktop, Claude Code, Cursor) decides what to do; this server only observes and acts on this machine.

- **Runs entirely on your machine.** No cloud, no API key, no telemetry, no postinstall scripts. Sole runtime dependency: Playwright. noracu makes no network calls of its own; the only automatic one is the one-time Chromium download on the first `browser_launch` (`NORACU_DISABLE_AUTO_INSTALL=1` turns that off). The browser still fetches the pages you point it at.
- **Acts on semantics, not pixels.** Observation returns the accessibility tree (Mac) or ARIA tree (browser) as an indexed list — text, not screenshots. Actions reference `element_index`; indices expire after 30 s, and clicks re-verify the target (tag/name/href/position in the browser, frontmost app on the Mac) before firing. A stale reference returns `element_no_longer_valid` instead of clicking the wrong thing. Screenshots are there when the tree is not enough.
- **One protocol, three surfaces — not three scripts.** The same observe/act loop drives native Mac apps, a persistent-profile browser, and (experimentally) a mirrored iPhone. The pattern is identical across surfaces; only the tool names differ (`mac_*` vs `browser_*`).
- **Uses your real sessions.** Your logged-in browser profile, your Mac apps — not a hosted VM. Compared with cloud computer-use: neither is universally more reliable; they fail differently. noracu keeps the screen on your machine.
- **Off switches that are actually off.** `NORACU_READ_ONLY=1` (observation-only, default-deny), `NORACU_DISABLE_EVAL=1`, and `file://` blocked by default. See [Security](#security).
- **Verifiable.** 34 end-to-end checks (`npm test`), CI on macos-latest, MIT, and the whole server is one file: `src/server.mjs`.

**Not a good fit if** you need multiple browser tabs or sessions (single session for now), you're not on macOS (the Mac and iPhone layers are macOS-only; the browser layer is cross-platform), or you need the iPhone layer today. If you only need browser automation, playwright-mcp has tab management and selector APIs that noracu v0.1 lacks; noracu is for when one agent also has to leave the browser and drive Mac apps.

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
| `phone_*` says `imctl unavailable … missing Quartz` | expected — imctl is not public; ignore the phone tools (two menu tools still work, see below) |
| Typed text comes out re-spaced (e.g. "no ra cu") | a CJK input method is active — use `mac_paste` instead of `mac_type` |
| `element_no_longer_valid` | the snapshot is older than 30 s or the UI changed — re-run `mac_ax_state` / `browser_snapshot` and use a fresh index |

Node 18 is rejected at startup — use Node ≥ 20. Claude Desktop may start one noracu process per surface (e.g. chat and a second surface); they share the browser profile, so launch the browser from only one at a time.

Full worked examples: [docs/usage.md](docs/usage.md).

## iPhone layer (experimental)

The iPhone layer has 14 `phone_*` tools that drive iPhone Mirroring through **imctl**, a companion tool that is not yet public.

- **With imctl** installed and an iPhone mirrored to this Mac: all 14 tools are available.
- **Without imctl:** most `phone_*` tools return a structured `imctl unavailable` error. Two tools still work when the mirror is connected, because they go through the iPhone Mirroring menu: `phone_home` (Home Screen) and `phone_app_switcher` (App Switcher).

No `phone_*` tool runs without an active iPhone Mirroring session on this Mac. Tool names and behavior may change before imctl is released. Do not set `NORACU_IMCTL_DIR` unless you already have imctl from its author.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `NORACU_READ_ONLY` | unset | `=1` observation-only: a default-deny allowlist of 12 observe + browser-lifecycle tools; every click/type/paste/key/eval tool is refused |
| `NORACU_DISABLE_EVAL` | unset | `=1` makes `browser_evaluate` (arbitrary JS) return an error when called (it stays listed) |
| `NORACU_ALLOW_FILE_URL` | unset | `=1` lets `browser_navigate` open `file://` URLs (blocked by default) |
| `NORACU_DISABLE_AUTO_INSTALL` | unset | `=1` skips the Chromium auto-install on first `browser_launch` |
| `NORACU_CLICLICK` | `/opt/homebrew/bin/cliclick` | cliclick binary path |
| `NORACU_IMCTL_DIR` | sibling `../imctl` | imctl checkout location (do not set unless you have imctl) |

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

## Maintenance

Solo-maintained, no SLA. macOS 15+ for the Mac and iPhone layers; the browser layer runs wherever Playwright does.

## License

MIT — see [LICENSE](LICENSE).

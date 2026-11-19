# noracu

**A local MCP server that lets an MCP client (Claude Desktop, Claude Code, Cursor, …) operate macOS apps
and a browser by `element_index`, and says what each action did. No API key, no telemetry.**

[![CI](https://github.com/sgInnora/noracu/actions/workflows/ci.yml/badge.svg)](https://github.com/sgInnora/noracu/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/noracu.svg)](https://www.npmjs.com/package/noracu)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

中文说明见 [docs/README.zh-CN.md](docs/README.zh-CN.md)。

![noracu demo](https://github.com/sgInnora/noracu/releases/download/v0.3.0/noracu-demo.gif)

*In the person's own Chrome, noracu opens a tab, reads a number from the page and types it into a new note in Notes.
Working in your own Chrome is opt-in — `NORACU_ALLOW_CHROME=1` and Chrome's remote-debugging switch
([docs/usage.md](docs/usage.md), section 5b2); without them the browser layer uses a profile of its own.*

## What it does

| Layer | Tools | Drives | Status |
|---|---|---|---|
| **Mac** | 20 (`mac_*`) | the macOS Accessibility API, cliclick, screencapture | stable |
| **Browser** | 13 (`browser_*`) | Playwright — its own profile, or your Chrome (opt-in: `NORACU_ALLOW_CHROME=1` and Chrome's remote-debugging switch) | stable |
| **iPhone** (Mirroring) | 14 (`phone_*`) | Apple's iPhone Mirroring, OCR on the Mac | experimental, off by default |
| **iPhone** (XCUITest) | 9 (`ios_*`) | a UI-test runner on the phone, built with Xcode | experimental, off by default |

The agent takes a snapshot (an accessibility tree on the Mac, an ARIA tree in the browser), gets an indexed
list of elements, and acts on an `element_index`. Screenshots are there when the tree is not enough.

## Quickstart

**1. Install** (Node ≥ 20; no postinstall script), in a folder you keep:

```bash
npm install noracu          # the server is node_modules/noracu/src/server.mjs
brew install cliclick       # for physical Mac input (keys, drags, clicks that need the pointer)
npx noracu --doctor         # checks this machine and prints the configuration for your client
```

**2. Add it to your MCP client.** `--doctor` prints what to paste, with this machine's absolute paths: one
command for Claude Code, one JSON block for Claude Desktop and Cursor. Written by hand, it is the following.

Claude Code, started from a terminal with Node on its `PATH`:

```bash
claude mcp add noracu -- npx -y noracu
```

Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`) and Cursor
(`~/.cursor/mcp.json`) are started from the Dock and do not see your shell `PATH`, so give absolute paths
(`which node` prints the path of `node`):

```json
{
  "mcpServers": {
    "noracu": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/ABSOLUTE/PATH/TO/node_modules/noracu/src/server.mjs"]
    }
  }
}
```

Quit the client completely (menu-bar icon included) and open it again.

**3. Grant permissions to the client app, not to `node`.** System Settings → Privacy & Security →
**Accessibility** and **Screen Recording** (on macOS 15 and later: **Screen & System Audio Recording**) → turn
on Claude Desktop, Cursor or your terminal. Quit and reopen the client once more.

**4. Check.** Call `mac_status`: it says whether the client has both permissions and whether cliclick was
found. Then call `mac_ax_state` with Finder in front — an indexed tree comes back. That is the sign that it works;
a click comes after it. In the browser: `browser_launch` → `browser_navigate` → `browser_snapshot` →
`browser_click` with an `element_index`.

**5. Try it.** Three things to ask your client, each of which only reads:

- "Call noracu's `mac_status` and tell me what is missing."
- "With noracu, read the Finder window in front and list what is in it."
- "With noracu, open example.com in the browser and tell me the page's heading."

Something does not work? See [docs/troubleshooting.md](docs/troubleshooting.md). Still stuck, or an app that noracu
reads or operates badly? [Report a bug](https://github.com/sgInnora/noracu/issues/new?template=bug.yml) or [report an app](https://github.com/sgInnora/noracu/issues/new?template=app-report.yml) — neither needs a clone.

## How it behaves

- **Acts on elements, not pixels.** An `element_index` names an element of the last snapshot for 30 s. Before
  an action the element is identified again; one that is gone or changed answers `element_no_longer_valid`.
- **Says what happened.** Every input result carries `delivered_verified` (a change was seen),
  `delivered_unverified`, `not_delivered` or `unknown`, and whether a retry is safe.
- **The person at the Mac goes first.** If the keyboard or mouse was used in the last 2 s, Mac and iPhone
  input waits out the rest of those 2 s once; if they are still using it then, the call answers `user_active`
  and sends nothing. `NORACU_USER_IDLE_S=0` turns this off.
- **Switches that stay off.** `NORACU_READ_ONLY=1` allows observation and nothing else; while the file named
  by `NORACU_STOP_FILE` exists no input is sent; `NORACU_DENY_APPS` and `NORACU_APPROVAL_FILE` say which apps
  may receive input (terminals and IDEs are refused by default); running scripts in a page and `file://`
  pages are off by default.
- **Stays on this machine.** It uses the browser profile and the Mac apps you are signed in to. noracu makes
  no network calls of its own apart from Playwright's one-time Chromium download. Your client still sends
  what the tools return — text, screenshots — to the model it uses.

![The person at the Mac goes first](https://github.com/sgInnora/noracu/releases/download/v0.3.0/noracu-person-goes-first.gif)

*While the mouse is in use each call answers `user_active` and nothing is typed; 2 s after it stops, typing goes on.*

## What it does not protect against

- **Deceptive content.** Text on screen, accessibility names and page content reach your model as they are.
  noracu does not detect a fake dialog or a prompt injection; what the model does with them is decided in the
  client. Start with `NORACU_READ_ONLY=1`, and keep the client's approval prompts on for input tools.
- **There is no sandbox.** noracu acts with the privileges of your MCP client, in your logged-in apps.
- **App rules judge input.** The deny list and the approval file do not stop `mac_app` from launching,
  activating or quitting a listed app, or `mac_window` from moving its windows.
- **Electron and Chromium apps** do not take background clicks, so a physical click there moves the pointer.
  Their pages can be driven through a DevTools port instead (`cdp_port`, see [docs/usage.md](docs/usage.md)).
- **The iPhone layers are experimental**, with limits of their own — see [docs/iphone.md](docs/iphone.md).

The full list of defaults, switches and known gaps is in [SECURITY.md](SECURITY.md). What is known not to work —
an app's windows on another Space cannot be read, for one — and what was changed without a new run on a real
machine is in [docs/known-issues.md](docs/known-issues.md).

## Non-goals

- No model inside: noracu observes and acts, your MCP client decides.
- The Mac layer is for macOS; there is no Windows or Linux desktop layer.
- No hosted service, and no claims about other tools that were not measured.
- No arbitrary code execution unless you switch it on (`NORACU_ENABLE_EVAL=1`).

## Docs

- [docs/usage.md](docs/usage.md) — walkthroughs for each layer, environment variables, error reference
- [docs/tools.md](docs/tools.md) — every tool and its arguments (generated from the running server)
- [docs/troubleshooting.md](docs/troubleshooting.md) — install and permission problems
- [docs/iphone.md](docs/iphone.md) — the two iPhone backends: setup, requirements, limits
- [docs/known-issues.md](docs/known-issues.md) — what does not work, and what has not been re-tested on a real machine
- [docs/apps.md](docs/apps.md) — the apps noracu was run against, and how to report one more
- [docs/architecture.md](docs/architecture.md) — how the server, the Mac engine and the drivers fit together
- [SECURITY.md](SECURITY.md) — what noracu can reach, defaults and switches, threat model, reporting

## Roadmap

- Act vocabulary (browser): `hover`, `set_value`, `wait_for`
- Smaller results: a default snapshot of a Finder window is about 24 KB and `skeleton` saves nothing there
  (measured 2026-11-17, macOS 27.2) — frames on request and shorter action lists come first
- Reading an app's windows on another Space without moving the person's desktop there
- Open Notification Center's history when the menu-bar clock is not exposed to accessibility
- iPhone: `element_index` over OCR regions, re-checking the text before a tap

## Maintenance

Solo-maintained, no SLA. macOS 15+ for the Mac layer; the iPhone Mirroring layer also needs Apple silicon or
a T2 Mac, iOS 18+ and iPhone Mirroring (not available in the EU); the browser layer runs wherever Playwright
does. It is device-tested only on Apple silicon Macs running macOS 27
([docs/known-issues.md](docs/known-issues.md) says what that leaves untested). Bug reports with the tool name and the
steps are the most useful thing you can send — the [issue forms](https://github.com/sgInnora/noracu/issues/new/choose)
ask for exactly that.

## License

MIT — see [LICENSE](LICENSE).

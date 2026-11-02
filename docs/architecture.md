# noracu Architecture

> A unified three-layer computer-use control plane — Mac / Browser / iPhone — behind a single MCP server (stdio JSON-RPC 2.0).

## Design principles

1. **Observe/act separation**:
   - Observe: `ax_state` (Accessibility/ARIA tree, token-cheap) or `screenshot` (visual), chosen per step
   - Act: click / drag / scroll / key / type / paste / evaluate, by coordinates or element reference
2. **Local-first**: no cloud, no API key — every capability comes from local tools
3. **Layer autonomy**: each layer is largely independent; a missing dependency (e.g. imctl) disables only that layer. The one deliberate cross-layer path is the iPhone layer's Home / App Switcher, which prefer the iPhone Mirroring menu (driven through the Mac layer) and fall back to imctl gestures.

The observe/act vocabulary follows the action/observation split popularized by ChatGPT's computer-use, re-implemented on open local tooling.

## Layer implementations

### Mac layer (9 tools)

| Tool | Implementation |
|---|---|
| `mac_screenshot` | `screencapture -x` (region crop via `-R`; returns scale + logical-size + `screen:'main'` metadata) |
| `mac_ax_state` | `osascript` JXA → System Events AX tree (role/title/frame, depth control 1-10) |
| `mac_click/drag/scroll` | `cliclick` (c:/dd:dm:du:/sc:); click takes `[x,y]` or `element_index`, drag is index-only (`from_index`/`to_index`) — indexes come from the most recent `mac_ax_state` (TTL 30s; stale references raise `element_no_longer_valid`, as does a frontmost-app change since the snapshot) |
| `mac_key` | `cliclick` — human key names parsed to an arg sequence: a chord like `cmd-shift-v` → `kd:cmd,shift t:v ku:cmd,shift`, a named key like `return` → `kp:return` |
| `mac_type` | `cliclick t:<text>` (literal text) |
| `mac_paste` | `pbcopy` writes the clipboard, then `cliclick kd:cmd t:v ku:cmd` (⌘V), then the previous clipboard is restored |
| `mac_menu_command` | JXA traverses the target app's menu bar → `click` on the menu item (localization-safe) |

`mac_key` / `mac_type` / `mac_paste` accept an optional `app`: when set, the tool verifies that app is frontmost before synthesizing input and returns `focus_lost` (sending nothing) if it is not.

### Browser layer (12 tools)

A single persistent Playwright 1.58 session (one browser, one context), held in a `Map` keyed by `browser_id` that carries one active entry at a time:

- Session: `browser_launch` (headless optional) → `browser_navigate` → `browser_close`; `browser_snapshot` accepts an optional `browser_id`, but only one session is live at a time (true multi-session `browser_id` + `tab_id` is a roadmap item)
- Observe: `browser_snapshot` (`page.ariaSnapshot()` ARIA tree YAML + list of interactive element indices), `browser_screenshot` (fullPage / format png|jpeg / quality / clip; returns DPR + viewport metadata)
- Act: `browser_click` (element_index / selector / xy; element_index clicks run a tag/name/href/position TOCTOU check first), `browser_fill`, `browser_press_key`, `browser_type`, `browser_scroll`, `browser_evaluate`
- Read: `browser_read` (page text, optional selector)

### iPhone layer (14 tools)

The bundled imctl driver (`imctl/`, Python) runs as a subprocess (`<python3> -m imctl.cli`, PYTHONPATH = `imctl/src`, no bytecode written). The interpreter is `NORACU_PYTHON` or the first of `/opt/homebrew/bin/python3`, `/usr/local/bin/python3`, `python3`, `/usr/bin/python3` that imports pyobjc (Quartz, Vision, AppKit); probed once, lazily, on the first `phone_*` call. **Experimental**: when no such python exists, tools return a structured one-line `imctl unavailable` error with the install command rather than crashing the server (`phone_home`/`phone_app_switcher` still work via the iPhone Mirroring menu).

- Observe: `phone_ocr` (coordinates + text), `phone_screenshot` (captures the Mirroring window by CGWindow id, so a covered window still yields its own pixels; region capture is the fallback), `phone_find` (locates text)
- Act: `phone_tap/longpress/swipe` (normalized 0-1 coordinates), `phone_home` / `phone_app_switcher` (iPhone Mirroring menu first, imctl gesture fallback), `phone_scroll`, `phone_type` (clipboard-based, IME-safe), `phone_key`
- Session: `phone_status` (running, window, window_id, onscreen, frontmost, paused), `phone_launch` (ensure running + frontmost, clicks Resume when the session shows "Connection Paused"), `phone_open` (Spotlight + OCR + tap)

## Configuration

| Environment variable | Default | Description |
|---|---|---|
| `NORACU_PYTHON` | auto-probe (see iPhone layer) | python3 that runs the bundled driver; must import pyobjc |
| `NORACU_IMCTL_DIR` | bundled `imctl/` (`src/../imctl`) | override the driver location (development only) |
| `NORACU_CLICLICK` | `/opt/homebrew/bin/cliclick` | path to cliclick |
| `NORACU_READ_ONLY` | unset (full control) | `=1` observation-only mode: a default-deny allowlist of 12 tools — the observe tools (`mac_screenshot`, `mac_ax_state`, `browser_snapshot`, `browser_screenshot`, `browser_read`, `phone_status`, `phone_screenshot`, `phone_ocr`, `phone_find`) plus browser session lifecycle (`browser_launch`, `browser_navigate`, `browser_close`). `browser_navigate` still issues a page-load request. All input-synthesis tools (click/drag/type/key/paste/tap/swipe/evaluate/…) are rejected |
| `NORACU_DISABLE_EVAL` | unset (enabled) | `=1` makes `browser_evaluate` return an error on every call (kill switch for arbitrary JS execution; it stays listed) |
| `NORACU_DISABLE_AUTO_INSTALL` | unset (auto-install) | `=1` stops `browser_launch` from auto-running `playwright install chromium` on a clean machine; returns an error prompting a manual install instead |
| `NORACU_ALLOW_FILE_URL` | unset (blocked) | `=1` permits `browser_navigate` to open `file://` URLs (blocked by default to avoid local-file exfiltration via the browser layer) |

## Known limitations (v0.1)

- Mac-layer actions spawn subprocesses (cliclick/osascript); per-action latency is tens of milliseconds (subprocess spawn; not benchmarked in this release) — a resident FFI process could cut it (see roadmap)
- No axState diffing (every observation is a full snapshot)
- Single browser session (no tab-level management)
- The iPhone layer requires iPhone Mirroring to be online and the phone unlocked; OCR accuracy depends on screen content; `paused` detection reads the English "Connection Paused" label
- macOS-only (Mac/iPhone layers); the Browser layer is cross-platform

## Roadmap (v2 candidates)

- ~~element_index coordinate system~~ (landed in v0.1.0, both Mac and Browser layers); next: monotonic index reuse across snapshots (prerequisite for diffing)
- axState diffing (incremental observation, saves tokens)
- Browser tool gaps (select_text/set_value/hover/wait_for…) + tab management
- koffi FFI resident process (direct CGEvent/AXUIElement calls)
- Multi-session architecture (browser_id + tab_id)
- Security hardening: sensitive-app foreground detection, action audit log

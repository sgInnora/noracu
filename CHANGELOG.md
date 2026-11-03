# Changelog

## [0.1.3] — 2026-11-04

### Fixed
- `phone_open` is far more reliable: it opens Spotlight from the Home Screen
  using Spotlight's own shortcut (trying once more if the phone ignores it),
  clears the field and re-reads results, matches very short app names such as
  "X", and confirms the app actually came to the foreground — tapping the app
  icon when tapping its name does nothing.
- One- and two-letter names such as "X" no longer run past the 30-second tool
  limit: short labels are read with a fast multi-scale OCR pass instead of slow
  strip-by-strip reads. `phone_find` and the `expect` guard find them too.
- `phone_open` no longer taps the wrong result when OCR momentarily misses a
  short app name. In testing, opening "X" could open a web search instead while
  reporting success.
- `phone_type` keeps the typed text on the clipboard until the phone shows it
  (verified by OCR) and only then restores your previous clipboard; it also
  restores the clipboard if an error happens before the paste. For a single
  character the restore also happens when the phone shows the paste several
  seconds late — and never before. Nothing is pasted if another app or device
  (Universal Clipboard) changes the clipboard just before the paste. Adds a
  `replace` option to overwrite an existing field.
- `phone_scroll` validates its distance (in screen-heights) and reports when
  nothing on screen moved.
- `phone_launch` reports whether the mirror is actually live, and says so when
  the session is still paused.
- Moving the pointer over the iPhone Mirroring window no longer looks like a
  paused session, and resuming a paused session never clicks the window's own
  close or minimize buttons.
- Screenshots never silently fall back to grabbing an arbitrary screen region;
  a capture failure is reported as unconfirmed instead of acting on the wrong
  pixels. After bringing iPhone Mirroring to the front, noracu waits for a real
  frame instead of failing on a blank transition frame.
- Before every input event, noracu asks macOS afresh whether iPhone Mirroring
  is still the frontmost window, and sends nothing otherwise.

### Security
- Phone screenshots taken for OCR were written to the shared temp directory,
  readable by other local users, and never deleted. They now go to an
  owner-only directory and are deleted as soon as they have been read. If you
  ran an earlier version, delete leftover `imctl_*.png` files from your temp
  directory (for example `/tmp`).

### Added
- Optional `expect` guard on phone input tools: nothing is sent unless the
  expected text is currently on screen.
- The server reports when its running process is older than the files on disk,
  so a stale server is visible to the client.

### Known issues
- Unchanged from 0.1.2: on iPhone 17 Pro Max + macOS 26, iPhone Mirroring draws
  the phone larger than its window; the right column and bottom row stay out of
  reach. Still under investigation.
- A single character typed with `phone_type` that leaves no new character on
  screen (for example replacing "X" with "X") cannot be confirmed; the clipboard
  then keeps the typed character rather than risk pasting your previous
  clipboard into the phone.

## [0.1.2] — 2026-11-02

### Fixed
- Docs: the iPhone must be **locked** and near the Mac — unlocking it ends
  iPhone Mirroring (Apple). The 0.1.1 README, usage guide, architecture notes
  and release notes said the opposite.
- `phone_type` sends a real Command-V chord. Before, iPhone Mirroring received
  a plain "v" and the text was never pasted.
- `phone_scroll` uses trackpad-style scroll events (continuous, with
  began/changed/ended phases). It used a mouse drag, which iPhone Mirroring
  does not turn into a list scroll, so lists never moved. `phone_swipe` stays
  a drag for gestures such as Home Screen paging.
- `phone_open` opens Spotlight through iPhone Mirroring's own shortcut instead
  of a swipe that could put the Home Screen into edit (jiggle) mode; it taps
  only an exact app-name match above the search field and returns to the Home
  Screen when nothing matches.
- Phone input (`phone_tap`, `phone_longpress`, `phone_swipe`, `phone_scroll`,
  `phone_type`, `phone_key`, `phone_open`) is refused with `mirror_not_live`
  while iPhone Mirroring shows an overlay ("Connection Paused", "iPhone in
  Use", …) instead of landing on the overlay; `phone_ocr` / `phone_find` start
  with a warning in that state.

### Known issue
- On one tested setup (iPhone 17 Pro Max, macOS 26) iPhone Mirroring draws the
  phone larger than its window at every View size; the right column and bottom
  row are cut off, so noracu cannot see or tap them. Under investigation.

### Added
- `phone_status` reports `live` and `overlay`, read from the window's
  structure rather than its language; `paused` now means "an overlay with a
  Resume button is shown", and `resume` clicks that button only when it is the
  single control.
- Apple's iPhone Mirroring requirements (Apple silicon or T2, macOS 15+,
  iOS 18+ with a passcode, same Apple Account with two-factor authentication,
  not available in the EU), the "Authenticate automatically" trade-off, and
  privacy guidance in the README, usage guide, architecture notes and SECURITY.
- MCP Registry metadata: `mcpName` `io.github.sgInnora/noracu` in package.json
  and `server.json`.
- `demo/record-phone.py` (repo only, not in the npm package) reproduces the
  iPhone demo.

## [0.1.1] — 2026-11-02

### Added
- **iPhone driver bundled.** imctl (the Python driver behind the 14 `phone_*`
  tools) now ships inside the npm package at `imctl/` (MIT, ~1,000 lines).
  No companion checkout is needed; `NORACU_IMCTL_DIR` still overrides the
  location for development. The layer stays EXPERIMENTAL.
- `NORACU_PYTHON`: pick the python3 that runs imctl. Without it, noracu
  probes `/opt/homebrew/bin/python3`, `/usr/local/bin/python3`, `python3`
  and `/usr/bin/python3` for one that imports pyobjc (Quartz, Vision,
  AppKit) — probed once, lazily, on the first `phone_*` call. When none
  qualifies the tool returns one actionable line with the `pip install`
  command.
- `phone_status` now reports `window_id`, `onscreen`, `frontmost` and
  `paused` (true when the Mirroring window shows "Connection Paused").
- `phone_launch` resumes a paused session (clicks Resume) after bringing the
  window to the front. imctl gains `screenshot [PATH]` and `resume`
  commands.
- e2e: 35 checks (new CI-safe guard that the bundled imctl is present).

### Fixed
- `phone_screenshot` / `phone_ocr` / `phone_find` captured whatever was on
  screen at the window's rectangle, so a covered or background Mirroring
  window produced screenshots and OCR of other apps. Capture is now by
  CGWindow id (`screencapture -l`), which returns the window's own pixels
  even when it is covered; region capture remains as a fallback.
- imctl no longer writes `__pycache__` into the package directory
  (`PYTHONDONTWRITEBYTECODE`).

### Notes
- Mac and browser layers are unchanged.
- The iPhone layer needs macOS 15+, iPhone Mirroring connected, and a
  python3 with pyobjc; Apple's `/usr/bin/python3` usually lacks pyobjc.

## [0.1.0] — 2026-11-02

### Added
- **Mac layer (9 tools)**: `mac_screenshot` (region crop; returns main-display
  scale + logical size), `mac_ax_state` (JXA Accessibility tree with element
  indices + frames), `mac_click` (dual-mode: `[x,y]` or `element_index`),
  `mac_drag` (index-only: `from_index`/`to_index`), `mac_scroll`, `mac_key`,
  `mac_type`, `mac_paste`, `mac_menu_command` (localized-safe menu bar
  traversal).
- **Browser layer (12 tools)**: Playwright session model — `browser_launch` /
  `navigate` / `snapshot` (ARIA) / `screenshot` (format/quality/clip + DPR
  metadata) / `click` / `fill` / `press_key` / `type` / `scroll` / `read` /
  `evaluate` / `close`.
- **iPhone layer (14 tools)**: iPhone Mirroring driver (imctl) — `phone_status`
  / `launch` / `screenshot` / `ocr` / `find` / `tap` / `longpress` / `swipe`
  / `home` / `app_switcher` / `scroll` / `type` / `key` / `open`.
- **Security**: argv-parameterized JXA (string params never in script source), `validateArgs`
  on every tool call, `NORACU_DISABLE_EVAL` kill switch,
  `NORACU_READ_ONLY=1` observation mode (default-deny allowlist),
  `file://` navigation blocked by default (`NORACU_ALLOW_FILE_URL=1`
  opt-in), injection regression tests.
- **CI**: GitHub Actions (macos-latest) with `NORACU_CI` e2e mode.
- **Docs**: English and Chinese READMEs, architecture, a usage guide, and an auto-generated tool reference; SECURITY.md with per-threat status.
- Focus guard: `mac_type` / `mac_paste` / `mac_key` accept `app` and refuse to type when that app is not frontmost; `mac_ax_state` reports `ax_empty` instead of an empty tree.
- `mac_key` accepts human key names (cmd-shift-v, esc, return, arrow-up) with validation.

### Security
- Fixed JXA injection in `mac_ax_state` / `mac_menu_command` (static script
  + `osascript` argv — parameters are data, never script source).
- `mac_paste` restores the previous text clipboard after pasting
  (non-text clipboard contents are not preserved).
- element_index cache is never overwritten by an empty AX snapshot.
- `mac_paste` and modifier chords in `mac_key` now use cliclick key-down/up sequences (previously failed on `kp:cmd-v`).

### Notes
- macOS 15+ required for Mac/iPhone layers; Browser layer is cross-platform.
- imctl was a companion checkout in 0.1.0 (sibling directory or `NORACU_IMCTL_DIR`);
  phone tools degrade gracefully when absent. Bundled since 0.1.1.
- Tool descriptions are English; every JSON-schema property is single-typed
  (no union/`oneOf`) for reliable LLM tool-calling across clients.
- `mac_click` / `mac_drag` refuse an `element_index` when a different app is
  frontmost than the one the snapshot came from (prevents clicking the wrong
  window within the 30s cache window).
- iPhone-layer failures (imctl missing, Mirroring window not frontmost) are reported as tool errors instead of plain text.
- When imctl's python3 lacks pyobjc, `phone_*` returns a one-line "imctl unavailable" message instead of a raw Python traceback.
- `mac_ax_state` retries once after ~350ms when the tree is empty, so an app just brought to the front (whose windows haven't attached to the AX tree yet) isn't falsely reported as `ax_empty`.
- `browser_launch` reports a clean "profile in use" error when another noracu instance holds the persistent browser profile, instead of crashing.
- `phone_home` / `phone_app_switcher` use the iPhone Mirroring menu (Home Screen / App Switcher) first — reliable without the window being frontmost and without imctl — and fall back to imctl gestures on a non-English menu or when the mirror is not connected.

History note: the repository history was reset before this release; earlier unpublished `noracu-mcp` versions are superseded.

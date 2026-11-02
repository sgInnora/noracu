# Changelog

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
- imctl is a companion checkout (sibling directory or `NORACU_IMCTL_DIR`);
  phone tools degrade gracefully when absent.
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

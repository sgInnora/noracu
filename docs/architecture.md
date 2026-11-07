# noracu Architecture

> A unified three-layer computer-use control plane — Mac / Browser / iPhone — behind a single MCP server (stdio JSON-RPC 2.0).

## Design principles

1. **Observe/act separation**:
   - Observe: `ax_state` (Accessibility/ARIA tree) or `screenshot` (visual), chosen per step
   - Act: click / drag / scroll / key / type / paste / evaluate, by element reference (or coordinates where supported; `mac_drag` takes `from_index` / `to_index` only)
2. **Local-first**: no cloud, no API key — every capability comes from local tools
3. **Layer autonomy**: each layer is largely independent; a missing dependency (e.g. imctl) disables only that layer. The one deliberate cross-layer path is the iPhone layer's Home / App Switcher, which prefer the iPhone Mirroring menu (driven through the Mac layer) and fall back to imctl gestures.

The observe/act vocabulary follows the action/observation split popularized by ChatGPT's computer-use, re-implemented on open local tooling.

## Layer implementations

### Mac layer (20 tools)

Accessibility goes through `src/mac-ax.js`, a static JXA script run as `osascript -l JavaScript src/mac-ax.js` with one JSON request on stdin and one JSON reply on stdout. It calls the Accessibility C API (`AXUIElementCopyMultipleAttributeValues`, `AXUIElementPerformAction`, `AXUIElementSetAttributeValue`, `AXUIElementCopyElementAtPosition`, …) through the Objective-C bridge instead of System Events: a Finder window of about 500 elements reads in about 0.15 s on our test Mac. Each call is a short-lived process run asynchronously under a timer, like the iPhone driver, so a hung app cannot freeze the server.

| Tool | Implementation |
|---|---|
| `mac_ax_state` | engine `snapshot`: walks a window (or `surface`: menu bar, open menu, sheet, alert, dialog, popover, focused element, whole app) to a logical depth (layout wrappers without content do not count and are hidden by `compact`); `interactive` keeps actionable elements; `skeleton` maps 3 levels with `children_count`, `root` drills into one element and extends the same snapshot. Chromium/Electron apps get `AXManualAccessibility` switched on when read unless `web_accessibility: false` or `NORACU_READ_ONLY=1` (never `AXEnhancedUserInterface`, which alters window behaviour). When the app refuses it (Google Chrome: -25205), a window is searched for an `AXWebArea` (≤1.5 s): found → `exposed` (pages are in the tree anyway, e.g. Chrome started with `--force-renderer-accessibility`), else `unsupported`, and the server adds `web_accessibility_hint` |
| `mac_find` / `mac_get` | engine `find` (role / title / value / text / AXIdentifier, substring or exact; honours `web_accessibility` like `mac_ax_state`) / `get` (one element, live: full value, states, actions, settable attributes) |
| `mac_click` | element_index: the element's own action (`AXPress` / `AXConfirm` / `AXPick` / `AXOpen`, `AXShowMenu` for right-click, or selecting a row) when it has one; otherwise `cliclick` at its center after a system-wide hit test — or, when inconclusive, confirming the topmost on-screen window there is that same window by CGWindowID (`occluded` otherwise; refused when the element's window has no CGWindowID, except Finder's desktop). Right before `cliclick`, engine `frontmost` with `at` re-checks that the element's window is still on top; after the click, `observe_after` with `physical` reports `delivered_verified` only when the element is still there, changed, and `cgTopAt` still finds its window at the point. `NORACU_TEST_PHYSICAL_GAP_MS` (test hook) waits between that re-check and the click. Raw x,y: `cliclick` only when engine `frontmost` with `at` reports the topmost on-screen window there belongs to `app` (default: the frontmost app; the Window Server menu bar strip, layer 24, counts as the frontmost app's) — `occluded` otherwise, `force: true` skips the check |
| `mac_type` | `AXSelectedText` (insert at the caret) or `AXValue` (`replace`) on element_index or the focused element; keystrokes (`cliclick t:`) only when accessibility reports no focus or a text view it cannot write |
| `mac_set_value` | by role: `AXValue` for text (never read back or echoed on `AXSecureTextField`), sliders, combo boxes; `AXPress` for toggles (only when the state differs); `AXExpanded` / `AXDisclosing`; `AXSelected`; pop-up and menu buttons open their menu, press the one matching option, or close it again |
| `mac_scroll` | no index: wheel event at the frontmost window; scroll area: wheel event at its center (hit-tested); other element: `AXScrollToVisible` |
| `mac_drag` | `cliclick` dd/dm/du between `from_index` and `to_index` (no raw coordinates); both ends are re-identified and hit-tested |
| `mac_key` | named keys (return, esc, tab, space, delete, arrows, home/end, page keys, F1–F16), with or without modifiers: engine `key` — `CGEventPost` at the HID tap from a HID-state source, each modifier pressed and released (flags-changed events) around the key, flags always set explicitly, and any modifier the call pressed that the system still reports held released once more; character chords (`cmd-c`): `cliclick` kd/t/ku. Quit / log-out / lock / force-quit / delete-immediately / empty-Trash chords need `force` |
| `mac_paste` | one engine call (`opPaste`): focus guard, clipboard items copied aside in-process, text written (transient), ⌘V posted as key code 9 with the ⌘ modifier (refused under a Dvorak layout), restore after evidence or a 1 s hold, guarded by the change count |
| `mac_menu_command` | engine `menu`: `AXPress` on the item found by title or `Menu > Item` path in the app's own menu bar; Apple-menu items and refused shortcut chords need `force`, and session processes or the MCP host are never quit |
| `mac_wait` | engine `wait`: polls a window / text / element / menu / sheet / app / notification condition (`notification` refused under `NORACU_READ_ONLY=1`) every 250 ms inside one process |
| `mac_app` | `open` for launch / activate; `NSRunningApplication` hide / unhide / terminate / forceTerminate; quit is verified by the pid ending. `cdp_port`: `open -n -a … --args --remote-debugging-port=… --remote-debugging-address=127.0.0.1` |
| `mac_window` | `AXRaise` / `AXMain` / `AXMinimized` / `AXPosition` / `AXSize` / `AXFullScreen` on the window found by CGWindowID or app + index/title |
| `mac_status` / `mac_apps` / `mac_windows` | `AXIsProcessTrusted`, `NSWorkspace`, `NSScreen`, `CGWindowListCopyWindowInfo` (titles from accessibility when Screen Recording is missing) |
| `mac_screenshot` | `screencapture -x` (main display, `-D` display, `-l` one window by CGWindowID, `-R` region) |
| `mac_clipboard_read` | `NSPasteboard`: file URLs, PNG/TIFF image, or text; `org.nspasteboard.ConcealedType` items are withheld |
| `mac_notifications` | the Notification Center process's `AXNotificationCenter*` groups: id (`AXIdentifier`), app, title, subtitle, body, named actions, `center_opened` / `center_was_open` (`open_center: true` skips clicking the clock when positive panel evidence shows it is already open; absent or invalidated `-25202` targets return `notification_not_found`) |

**Element identity.** An AXUIElement cannot outlive the engine process, so each `element_index` stores evidence: pid, the container (a window by its CGWindowID from `_AXUIElementGetWindow`, an open menu by its frame, the menu bar, or the app), the child-index path, a fingerprint (role, subrole, AXIdentifier, stable name — a label, never the value), the frame relative to the container, the labels of its ancestors (window-level titles such as a web page's are left out because they change with content; digits are ignored), the child count at every level of its path (shape), and an item key — the first texts under the element itself or its nearest ancestor that has any, never the container nor a web area, toolbar, scroll area or split group (static text, link labels, and a text field's value only when a cell or row lies between that ancestor and the field, i.e. table content such as Finder's name column — a form field's value is what gets typed, not identity; never button titles). An item key that two look-alikes would share (rows that only climb to the same section heading) is not recorded: it tells nothing apart. Uniqueness is counted over every element the walk visited, also those a filtered or interactive-only snapshot does not show; a walk that stopped early or was drilled into part of the container cannot know it, so its elements count as duplicated. An action follows the path and checks all of it; the shape may differ only when the element's own item (itself or its parent) vouches for it, and digits in a unique element's item are ignored (counters, relative times). A labelled element whose path no longer leads to it may be found by search: a unique one only near where it was (64 px), under the same ancestors and in the same item; a duplicated one only by its item key (so a re-sorted list resolves to the same item, and a look-alike that arrived after the snapshot is not taken for it); an unlabelled element is never searched for. Path steps fetch one child by index instead of whole child lists. No container, no match or several matches is `element_no_longer_valid` — never a look-alike. A search never enters the menu bar unless the element was seen there (a closed menu's items can still be pressed). Indexes are unique for the life of the server (one counter across snapshots) and last 30 s; `snapshot_id` is optional and must match the index. Known limits: in an open context menu, an identical menu opened at the same place for another row cannot be told apart; a status word that changes inside an element's item ("Saving…" → "Saved", a validation message) makes the index stale — take a new snapshot; a unique element whose whole item is replaced in place by one that differs only in digits ("Invoice 12" → "Invoice 13") is not told apart.

**Delivery.** Accessibility return codes do not prove an effect (Finder returns success for an action that does not exist), so actions read the element and its app before and after: value, selection, state, focus, windows, sheets, open menus, frontmost app. A change is `delivered_verified`; none is `delivered_unverified`; refusals before anything was sent are `not_delivered` with `retry=safe`; an app that did not answer is `unknown` with `retry=unsafe`.

`mac_key` / `mac_paste` (and `mac_type` when it sends keystrokes) accept an optional `app`: when set, the tool verifies that app is frontmost before synthesizing input and returns `focus_lost` (sending nothing) if it is not.

### Browser layer (12 tools)

A single persistent Playwright 1.58 session (one browser, one context), held in a `Map` keyed by `browser_id` that carries one active entry at a time:

- Session: `browser_launch` (headless optional) → `browser_navigate` → `browser_close`; `browser_snapshot` accepts an optional `browser_id`, but only one session is live at a time (true multi-session `browser_id` + `tab_id` is a roadmap item)
- Observe: `browser_snapshot` (`page.ariaSnapshot()` ARIA tree YAML + list of interactive element indices), `browser_screenshot` (fullPage / format png|jpeg / quality / clip; returns DPR + viewport metadata)
- Act: `browser_click` (element_index / selector / xy; element_index clicks run a tag/name/href/position TOCTOU check first), `browser_fill`, `browser_press_key`, `browser_type`, `browser_scroll`, `browser_evaluate`
- Read: `browser_read` (page text, optional selector)

### iPhone layer (14 tools)

The bundled imctl driver (`imctl/`, Python) runs as a subprocess (`<python3> -m imctl.cli`, PYTHONPATH = `imctl/src`, no bytecode written). The interpreter is `NORACU_PYTHON` or the first of `/opt/homebrew/bin/python3`, `/usr/local/bin/python3`, `python3`, `/usr/bin/python3` that imports pyobjc (Quartz, Vision, AppKit); probed once, lazily, on the first `phone_*` call. **Experimental**: when no such python exists, tools return a structured one-line `imctl unavailable` error with the install command rather than crashing the server (`phone_home`/`phone_app_switcher` still work via the iPhone Mirroring menu on English macOS while the mirror is live; non-English macOS falls back to `imctl`).

- Observe: `phone_ocr` (coordinates + text), `phone_screenshot` (captures the Mirroring window by CGWindow id, so a covered window still yields its own pixels; never a screen-region capture — `capture_failed` instead), `phone_find` (locates text; text passed on stdin)
- Act: `phone_tap/longpress/swipe` (normalized 0-1 coordinates), `phone_home` / `phone_app_switcher` (iPhone Mirroring menu by bundle id first, imctl gesture fallback when the English menu item is absent), `phone_scroll`, `phone_type` (clipboard-based via stdin, IME-safe, never echoes typed text), `phone_key`
- Session: `phone_status` (running, window, window_id, onscreen, frontmost, live, overlay, paused, setup — read from the window's AX structure and shape: a live mirror is one empty AXHostingView group; an overlay such as "Connection Paused" or "iPhone in Use" adds static text and a button; a setup screen sits in a nearly square window), `phone_launch` (ensure running + frontmost, clicks the single Resume button of a paused overlay, refuses setup screens with `mirror_setup_required`), `phone_open` (Spotlight via the iPhone Mirroring shortcut, paste the name via stdin, tap only an exact OCR label inside Spotlight's "Top Hit" card, reading `NORACU_TOPHIT_LABELS`; otherwise back to the Home Screen)
- Safety: while the mirror is not live or its state cannot be confirmed, every phone input tool (`phone_tap`, `phone_longpress`, `phone_swipe`, `phone_scroll`, `phone_type`, `phone_key`, `phone_open`, `phone_home`, `phone_app_switcher`, plus CLI `imctl page`) fails closed with `mirror_not_live` or `mirror_state_unknown` without stealing focus when paused or closed; `phone_ocr` / `phone_find` prefix a warning. The phone layer has no `element_index`: OCR coordinates are normalized to the window, and nothing re-verifies the target before a tap (optional `expect` checks pre-action OCR text).

## Concurrency and lifecycle

- **Child processes.** Every subprocess (the accessibility engine, imctl, cliclick, screencapture, `open`, `ps`, the Chromium installer) runs asynchronously under its own timer and in its own process group; on expiry the group gets SIGTERM, then SIGKILL after 1.5 s. Nothing blocks the event loop, so `ping` and `tools/list` are answered while a call runs.
- **Input queue.** `phone_*` and Mac input tools go through one FIFO queue (they share the real mouse, keyboard, clipboard and windows). A queued call that the client cancelled, or that waited longer than 60 s (or `NORACU_PHONE_TIMEOUT_MS` + 15 s), is dropped without acting (`input_busy`). `mac_clipboard_read`, `mac_notifications` and every `phone_*` tool (reads included: they capture the mirroring window) stay in the queue.
- **Observations.** `mac_ax_state`, `mac_find`, `mac_get`, `mac_windows`, `mac_apps`, `mac_screenshot`, `mac_status` and `mac_wait` do not join the queue: each waits for the inputs queued before it to finish (or returns `input_busy` past the queue limit), then runs, so it sees their effect and later inputs are not held up behind it.
- **Shutdown.** When the client closes stdin, or on SIGTERM / SIGINT / SIGHUP: no new calls, queued calls are dropped, no new child process starts, children get SIGTERM then SIGKILL, browsers (also one still starting) are closed (a CDP attachment only disconnects), and the process exits within 3 s.

## Configuration

| Environment variable | Default | Description |
|---|---|---|
| `NORACU_PYTHON` | auto-probe (see iPhone layer) | python3 that runs the bundled driver; must import pyobjc |
| `NORACU_IMCTL_DIR` | bundled `imctl/` (`src/../imctl`) | override the driver location (development only) |
| `NORACU_CLICLICK` | `/opt/homebrew/bin/cliclick` | path to cliclick |
| `NORACU_READ_ONLY` | unset (full control) | `=1` observation-only mode: a default-deny allowlist of 18 tools — the observe tools (`mac_screenshot`, `mac_ax_state`, `mac_find`, `mac_get`, `mac_status`, `mac_apps`, `mac_windows`, `mac_wait` except `condition: "notification"`, `browser_snapshot`, `browser_screenshot`, `browser_read`, `phone_status`, `phone_screenshot`, `phone_ocr`, `phone_find`) plus standalone browser session lifecycle (`browser_launch`, `browser_navigate`, `browser_close`; `mac_ax_state` / `mac_find` skip `web_accessibility`). `browser_navigate` still issues a page-load request. All input-synthesis tools (click/drag/type/key/paste/tap/swipe/evaluate/…) plus `mac_clipboard_read` and `mac_notifications` are rejected |
| `NORACU_DISABLE_EVAL` | unset (enabled) | `=1` makes `browser_evaluate` return an error on every call (kill switch for arbitrary JS execution; it stays listed) |
| `NORACU_DISABLE_AUTO_INSTALL` | unset (auto-install) | `=1` stops `browser_launch` from auto-running `playwright install chromium` on a clean machine; returns an error prompting a manual install instead |
| `NORACU_ALLOW_FILE_URL` | unset (blocked) | `=1` permits `browser_navigate` to open `file://` URLs (blocked by default to avoid local-file exfiltration via the browser layer) |
| `NORACU_ALLOW_CDP` | unset (blocked) | `=1` permits `mac_app` launch with `cdp_port` and `browser_launch` with `cdp_port` for a port this process opened (live PID, matching `webSocketDebuggerUrl`; Playwright `connectOverCDP` to 127.0.0.1); `=any` also lets `browser_launch` attach to any loopback DevTools port; refused under `NORACU_READ_ONLY=1`; `browser_close` then only disconnects |
| `NORACU_PHONE_TIMEOUT_MS` | 30000 (45000 for `phone_open` / `phone_type`) | time limit for each iPhone-layer step, 1000–600000 ms (`imctl_timeout` on expiry) |
| `NORACU_OCR_LANGUAGES` | `zh-Hans,en-US` | comma-separated Vision OCR language codes for the iPhone screen, in priority order |
| `NORACU_TOPHIT_LABELS` | `Top Hit` | comma-separated Spotlight Top Hit section label(s) that `phone_open` looks for |
| `NORACU_TRACE` | unset | file path for a JSON-lines call log (`{ts, tool, args, ms, error, code}` — argument names/sizes and error code prefix only, never argument text, result text, or error messages; opened `0600` with `O_NOFOLLOW`, refusing symlinks) |

## Known limitations (v0.2)

- Every Mac-layer call starts a short-lived `osascript` (and `cliclick` for physical input); reads take roughly 0.1–0.2 s on our test Mac, an action with its before/after check 0.3–0.8 s. A resident engine process could keep elements alive between calls and cut this further
- Notification Center's history is listed only while it is open; opening it needs the menu-bar clock, which accessibility does not expose on every macOS version
- No snapshot diffing; `skeleton` + `root` drill-down and `interactive` keep observations small instead
- Single browser session with one active tab and no tab switching: a tab the page opens itself (`window.open`, `target=_blank`) is not followed; another tab becomes active only after the active one closes
- The iPhone layer requires iPhone Mirroring to be online, with the iPhone locked and near the Mac (unlocking ends mirroring; Apple: unavailable in the EU); OCR accuracy depends on screen content; `phone_open` reads Spotlight's English "Top Hit" label unless `NORACU_TOPHIT_LABELS` is set
- macOS-only (Mac/iPhone layers); the Browser layer is cross-platform

## Roadmap (v2 candidates)

- ~~element_index coordinate system~~ (v0.1.0) and ~~one index counter across snapshots~~ (v0.2.0); next: snapshot diffing
- Physical clicks performed inside the engine process right after the hit test (closes the short gap between the check and the click)
- A simpler identity model to compare against the current one on the same tests (no digit folding in item keys)
- axState diffing (incremental observation, saves tokens)
- Browser tool gaps (select_text/set_value/hover/wait_for…) + tab management
- A resident accessibility engine (one long-lived process instead of one per call; true element handles between calls)
- Multi-session architecture (browser_id + tab_id)
- Security hardening: sensitive-app foreground detection, action audit log

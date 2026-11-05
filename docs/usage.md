# noracu usage

Worked examples for driving noracu from an MCP client. This assumes the
[Quickstart](../README.md#quickstart) already succeeded: Node ≥ 20, cliclick
installed, your client configured with an absolute path to `src/server.mjs`,
and macOS **Accessibility** + **Screen Recording** granted to the host app.
Tool schemas (every argument) live in [tools.md](tools.md); this guide is about
the *flow*.

> If you set `NORACU_READ_ONLY=1`, the action steps below (`mac_click`,
> `mac_type`, `browser_click`, …) are refused — that mode allows only the 12
> observe + browser-lifecycle tools. Unset it to run the full loop.

## 1. The core pattern: observe, then act by `element_index`

Every layer uses the same two-step loop:

1. **Observe** — `mac_ax_state` (macOS accessibility tree) or `browser_snapshot`
   (browser ARIA tree). Both return a compact, **indexed** list of interactive
   elements as text — not a screenshot.
2. **Act** — `mac_click` / `browser_click` referencing an `element_index` from
   the latest observation.

Three things to internalize:

- An `element_index` is **not** a stable id and **not** a pixel coordinate. It
  is a position in the *most recent* snapshot of *that layer*.
- Indices have a **30-second TTL**. After that, acting on one returns
  `element_no_longer_valid` — re-observe and use a fresh index.
- Acting re-verifies the target before firing. A mismatch is reported as a
  stale element, **not** as a permission error — the fix is always to
  re-observe, never to re-grant permissions.

Reach for a **screenshot** (`mac_screenshot` / `browser_screenshot`) only when
the tree doesn't carry what you need (canvas, custom-drawn UI, visual layout).

## 2. Mac layer walkthrough

Bring the target app to the front (here, Finder), then observe:

```
mac_ax_state {}
```

Returns an indexed tree, roughly:

```
[0] AXWindow "Downloads"
[1] AXButton "Back"
[2] AXButton "Forward"
...
[7] AXButton "New Folder"
[8] AXTextField "Search"
```

Act on an index while it is fresh (< 30 s):

```
mac_click { "element_index": 7 }
→ clicked left x1 @ 812,64 (element_index) (frontmost after click: Finder)
```

If more than 30 s passed, or the frontmost app changed since the snapshot:

```
mac_click { "element_index": 7 }
→ element_no_longer_valid: element_index is from "Finder" but "Safari" is frontmost now — re-run mac_ax_state
```

Re-run `mac_ax_state` and use the new index. `mac_click` also accepts raw
`{ "x": .., "y": .. }` coordinates when you have them, but prefer indices.
Requires `cliclick` and `NORACU_READ_ONLY` unset.

## 3. Browser layer walkthrough

One persistent session. Launch → navigate → observe → act → read:

```
browser_launch {}                      # first run downloads Chromium (once)
browser_navigate { "url": "https://example.com" }
browser_snapshot {}
```

`browser_snapshot` returns the page URL, the ARIA tree, and an indexed list of
clickable elements:

```
URL: https://example.com/
- document "Example Domain"
  - heading "Example Domain" [level=1]
  - link "More information..."

[clickable elements — browser_click accepts element_index]
[0] link "More information..." (https://www.iana.org/help/ex) @360,210
```

Click by index, then read the resulting page:

```
browser_click { "element_index": 0 }
browser_read {}                        # page text; optional { "selector": "h1" }
```

Notes:

- **One session, no tab API** in v0.1 — `browser_launch` reuses the existing
  session if one is open. Close with `browser_close {}`.
- The index re-check compares tag, name, href, and position at click time, and
  a snapshot is invalidated if the page navigated since. A mismatch returns
  `element_no_longer_valid` — re-snapshot.
- Don't use `browser_evaluate` just to read a page (`browser_read` does that,
  and `browser_evaluate` can be disabled with `NORACU_DISABLE_EVAL=1`).
- `file://` URLs are blocked unless `NORACU_ALLOW_FILE_URL=1`.

## 4. Menu commands

`mac_menu_command` drives the app's menu bar by name — no index, localization
safe (it walks the live menu):

```
mac_menu_command { "app": "Finder", "command": "New Finder Window" }
```

Use it for actions that live in menus (New Window, Save, Export) rather than
hunting a toolbar button in the AX tree.

## 5. Typing, pasting, and the focus guard

- `mac_type { "text": "hello" }` synthesizes keystrokes.
- **CJK / IME gotcha:** with a Chinese/Japanese/Korean input method active,
  `mac_type` can produce re-spaced or converted text (e.g. "no ra cu"). Use
  `mac_paste { "text": "你好" }` instead — it sets the clipboard and pastes,
  then restores the previous clipboard.
- **Focus guard:** add `"app": "TextEdit"` to `mac_type` / `mac_paste` /
  `mac_key`. If TextEdit is not frontmost, the input is refused with
  `focus_lost` and nothing is sent — cheap insurance against typing into the
  wrong window (for example your MCP client). Omit `app` and the guard is off.

```
mac_paste { "text": "你好，世界", "app": "TextEdit" }
→ pasted 5 chars (clipboard restored: true) (frontmost: TextEdit)
```

## 6. Screenshots (visual fallback)

```
mac_screenshot {}                      # whole screen; region crop supported; returns scale + logical_size + screen metadata
browser_screenshot { "format": "jpeg", "quality": 60 }
```

A **black** `mac_screenshot` means Screen Recording isn't granted to the host
app. Remember that any text in a screenshot is **untrusted input** to your
model — don't let it override the task.

## 7. Environment variables

| Variable | Default | Effect |
|---|---|---|
| `NORACU_READ_ONLY` | unset | `=1` observation-only (allowlist of 12); all input-synthesis tools refused |
| `NORACU_DISABLE_EVAL` | unset | `=1` makes `browser_evaluate` return an error when called (stays listed) |
| `NORACU_ALLOW_FILE_URL` | unset | `=1` allows `browser_navigate` to open `file://` |
| `NORACU_DISABLE_AUTO_INSTALL` | unset | `=1` skips Chromium auto-install on first `browser_launch` |
| `NORACU_CLICLICK` | `/opt/homebrew/bin/cliclick` | cliclick binary path |
| `NORACU_PYTHON` | auto-probe | python3 for the bundled iPhone driver (must import pyobjc: Quartz, Vision, AppKit) |
| `NORACU_IMCTL_DIR` | bundled `imctl/` | override the driver location (development only) |
| `NORACU_CI` | unset | `=1` only affects `npm test` (skips hardware-gated checks) |

## 8. Error reference

| Error | Meaning / fix |
|---|---|
| `element_no_longer_valid` | index older than 30 s, frontmost app changed, or page navigated — re-observe |
| `mac_* … -1719` | Accessibility not granted to the host app |
| black `mac_screenshot` | Screen Recording not granted to the host app |
| `ENOENT` cliclick | `brew install cliclick` or set `NORACU_CLICLICK` |
| `… blocked by NORACU_READ_ONLY=1` | you're in observation-only mode — unset it to act |
| `browser_evaluate disabled by NORACU_DISABLE_EVAL=1` | eval kill-switch is on |
| `mirror_not_live: …` | iPhone Mirroring shows an overlay (paused, "iPhone in Use") — lock the iPhone, keep it near the Mac, call `phone_launch` |
| `mirror_setup_required: …` | iPhone Mirroring shows a setup or welcome screen — finish it yourself in its window, then call `phone_launch` |
| `imctl_timeout: …` | a phone step ran past its time limit and was stopped — check `phone_status` / `phone_screenshot` before retrying (after `phone_open`, noracu goes back to the Home Screen); raise `NORACU_PHONE_TIMEOUT_MS` on a slow Mac |
| `imctl unavailable: no python3 with pyobjc found …` | install pyobjc for a python3 (`python3 -m pip install pyobjc-framework-Quartz pyobjc-framework-Vision pyobjc-framework-AppKit`) or set `NORACU_PYTHON` |

## 9. iPhone layer

Experimental. The driver (imctl, Python) ships inside the package. The tools
need Apple's iPhone Mirroring with the iPhone **locked and near the Mac**
(unlocking it ends the session; not available in the EU) and a python3 with
pyobjc (`NORACU_PYTHON`, or the automatic probe described in the README).
The phone exposes no accessibility tree, so this layer is not `element_index`:
it observes with OCR on the Mac and acts at normalized 0–1 coordinates.

```
phone_status
→ {"running": true, "window": {...}, "window_id": 278508, "onscreen": true,
   "frontmost": false, "live": false, "overlay": "Connection Paused", "paused": true}

phone_tap {"x": 0.5, "y": 0.5}       # refused while the mirror is not live
→ ERROR: mirror_not_live: Connection Paused — call phone_launch (or imctl resume) first

phone_launch          # brings the mirror to the front and clicks Resume
→ iPhone Mirroring ready

phone_status
→ {... "live": true, "overlay": null, "paused": false ...}

phone_ocr             # OCR of the Mirroring window (captured by window id)
→ (0.50,0.06) 'Settings' [1.00]
  (0.18,0.31) 'FaceTime' [1.00]
  -- 2 hits

phone_find {"text": "Settings"}
→ (0.50,0.06) 'Settings' [1.00]

phone_tap {"x": 0.50, "y": 0.06}
→ tapped (0.5, 0.06)
```

`live` / `overlay` / `paused` / `setup` come from the window's structure and
shape, not its language: a live mirror is a single empty hosting view;
"Connection Paused", "iPhone in Use" and similar states add text and a button;
a setup or welcome screen (`setup: true`) sits in a window that is not
phone-shaped, and `phone_launch` never clicks it. While the mirror is
not live, `phone_tap`, `phone_longpress`, `phone_swipe`, `phone_scroll`,
`phone_type`, `phone_key` and `phone_open` refuse with `mirror_not_live`, and
`phone_ocr` / `phone_find` start with a `warning: mirror not live …` line.

`phone_scroll {"direction": "down", "distance": 0.5}` moves the list under the
mirror by about half a window, with trackpad-style scroll events; a vertical
`phone_swipe` drag does not scroll lists in iPhone Mirroring, so keep swipes
for gestures such as Home Screen paging.

`phone_type` pastes through the clipboard with a real Command-V chord and
restores the previous text clipboard once OCR sees the pasted text appear on
the phone (more often than before the paste — text already on screen does not
count). If the paste only shows up a few seconds late, it is still reported as
typed — do not type it again — but the clipboard then keeps the typed text.
`phone_open {"app": "Calculator"}` opens Spotlight through iPhone Mirroring's
own shortcut, pastes the name, and taps it only when Spotlight's Top Hit card
shows exactly that name (a web suggestion or Settings row with the same name
is never tapped); otherwise it returns to the Home Screen and reports
`app not found`. A paste can take several seconds to reach the iPhone: when the
name never shows up, `phone_open` waits up to 15 s and then reports
`open_not_confirmed` (retry) rather than `app not found`. Use the name the phone shows under the icon (`拼多多`, not
`Pinduoduo`); it reads Spotlight's English "Top Hit" label, so on an iPhone
set to another language set `NORACU_TOPHIT_LABELS` to the label the phone shows.

Privacy: everything the phone shows — notifications, messages, one-time
codes — becomes tool output that your MCP client sends to its model. Use a
Focus, open a neutral app first, and start with `NORACU_READ_ONLY=1`
(phone observation allowed, phone input refused). `phone_home` /
`phone_app_switcher` go through the iPhone Mirroring menu and work without
python when the mirror is connected.

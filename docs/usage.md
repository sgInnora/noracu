# noracu usage

Worked examples for driving noracu from an MCP client. This assumes the
[Quickstart](../README.md#quickstart) already succeeded: Node ≥ 20, cliclick
installed, your client configured with an absolute path to `src/server.mjs`,
and macOS **Accessibility** + **Screen Recording** (called **Screen & System Audio
Recording** on macOS 15 and later) granted to the host app.
Tool schemas (every argument) live in [tools.md](tools.md); this guide is about
the *flow*.

If the client does not start the server, run `node node_modules/noracu/src/server.mjs doctor` in a terminal
(`noracu doctor` where the package's bin is on your `PATH`). It prints the client configuration with absolute
paths, and says whether Node, cliclick and Playwright's Chromium are where the server will look; `--json`
gives the same as JSON. It cannot see the macOS permissions — those belong to the host app — so for them
ask the client to call `mac_status`.

> If you set `NORACU_READ_ONLY=1`, the action steps below (`mac_click`,
> `mac_type`, `browser_click`, …) are refused, along with `mac_clipboard_read`,
> `mac_notifications`, and `mac_wait` on `condition: "notification"` — that mode
> allows only the observe + browser-lifecycle tools (and skips toggling
> `web_accessibility` on apps). Unset it to run the full loop.

## 1. The core pattern: observe, then act by `element_index`

Every layer uses the same two-step loop:

1. **Observe** — `mac_ax_state` (macOS accessibility tree; `mac_find` when you
   know what you are looking for) or `browser_snapshot` (browser ARIA tree).
   Both return a compact, **indexed** list of elements as text — not a
   screenshot.
2. **Act** — `mac_click` / `browser_click` referencing an `element_index` from
   the latest observation.

Three things to internalize:

- An `element_index` is **not** a pixel coordinate. On the Mac it is unique for
  the life of the server — every snapshot continues the same counter, so an index
  never names an element of a later snapshot. In the browser it is a position in
  the most recent `browser_snapshot`.
- Indices have a **30-second TTL**. After that, acting on one returns
  `element_no_longer_valid` — re-observe and use a fresh index.
- Acting re-verifies the target before firing. A mismatch is reported as a
  stale element, **not** as a permission error — the fix is always to
  re-observe, never to re-grant permissions.

Reach for a **screenshot** (`mac_screenshot` / `browser_screenshot`) only when
the tree doesn't carry what you need (canvas, custom-drawn UI, visual layout).

## 2. Mac layer walkthrough

Observe the app (the frontmost one when `app` is omitted). `interactive: true`
keeps only what can be acted on:

```
mac_ax_state { "app": "TextEdit", "interactive": true }
```

```json
{"app":"TextEdit","pid":9373,"snapshot_id":"s4","surface":"window",
 "window":{"title":"notes","frame":[309,103,586,488],"window_id":25647},
 "complete":true,"truncated":false,"elements":[
  {"i":1,"d":2,"role":"AXTextArea","value":"line one","states":["focused"],"actions":["showmenu"],"frame":[309,203,586,382]},
  {"i":3,"d":2,"role":"AXCheckBox","subrole":"AXSegment","title":"bold","value":0,"actions":["press"],"frame":[317,144,22,20]},
  {"i":18,"d":2,"role":"AXPopUpButton","title":"line spacing","value":"1.0","actions":["showmenu","press"],"frame":[...]}]}
```

`i` is the `element_index`, `d` the depth. Act while it is fresh (< 30 s):

```
mac_click { "element_index": 3 }
→ clicked element_index 3 (AXCheckBox "bold") via semantic AXPress — delivery=delivered_verified, retry=unsafe (changed: value)
```

The element was pressed through accessibility: no pointer movement, no focus
change. An element without such an action (a text area) gets a physical click,
but only after a hit test:

```
mac_click { "element_index": 1 }
→ clicked left x1 on element_index 1 (AXTextArea) @ 602,394 via physical click — delivery=delivered_verified, retry=unsafe (changed: selection)
mac_click { "element_index": 1 }        # a sheet now covers the text area
→ occluded: something else is on top of the element at 602,394 … — on top: {"role":"AXStaticText","app":"TextEdit"} (delivery=not_delivered, retry=safe)
```

**Read `delivery` and `retry`.** Every input action (Mac, browser and iPhone)
states both. `delivered_verified`: a change was observed.
`delivered_unverified`: the call succeeded but nothing observable changed — read
the state (`mac_get`, `mac_ax_state`) before acting again. `not_delivered` with
`retry=safe`: nothing was sent. `unknown` with `retry=unsafe`: the call timed
out or failed mid-action — inspect the state first. Only repeat an action when
`retry=safe`.

Set values by role instead of clicking around (`AXSecureTextField` returns
`(secure field — value not shown)` and never echoes the value):

```
mac_set_value { "element_index": 3, "value": "true" }      # checkbox: nothing is sent if already on
mac_set_value { "element_index": 18, "value": "1.5" }      # pop-up: opens it, picks the one matching option
mac_type { "element_index": 1, "text": "你好 noracu" }       # inserted at the caret, IME-safe, clipboard untouched
mac_get { "element_index": 1 }                             # full value, states, settable attributes
```

When the window closed or the element changed:

```
mac_click { "element_index": 3 }
→ element_no_longer_valid: the element's window is gone (STALE_REF/window_absent) — re-run mac_ax_state (delivery=not_delivered, retry=safe)
```

Dense apps (Electron, Slack, VS Code): map shallowly, then drill into one region —
the drill extends the same snapshot:

```
mac_ax_state { "app": "Slack", "skeleton": true, "interactive": true }   # branches show children_count
mac_ax_state { "root": 12 }                                               # only that subtree
mac_find { "app": "Slack", "role": "button", "title": "Send", "exact": true }
```

A skeleton is for finding where to drill. An element whose row it did not read in full — the row's texts
are below where it stopped — is refused for actions (`element_no_longer_valid`, `row_unread`): nothing in it
tells that row's button from the same button of another row. Drill into the row with `root`, then act.

Several windows and none focused gives `ambiguous_window` with the list; pass
`window` (index or title) or `window_id` from `mac_windows`. `surface` reads an
open `menu`, `menubar`, `sheet`, `alert`, `dialog`, `popover` or the `focused`
element only. `mac_click` also accepts raw `{ "x": .., "y": .. }`, but prefer
indices.

## 3. Browser layer walkthrough

One persistent session. Launch → navigate → observe → act → read:

```
browser_launch {}                      # first run downloads Chromium (once; browser_installing while it does)
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

- **One session, no tab API** in v0.2 — `browser_launch` reuses the existing
  session if one is open, and a tab the page opens itself (`window.open`,
  `target=_blank`) is not switched to. `browser_tabs {}` lists the tabs and `browser_tabs {"action":"select","tab_id":"t2"}` switches to one; Close with `browser_close {}`.
- **The active page is an http(s) page**, or a tab still on the blank page that
  `browser_launch` or `browser_tabs` opened it on (`file://` with
  `NORACU_ALLOW_FILE_URL=1`). When it comes to show anything else — a blob the
  page made, Chromium's page for a load that failed, a blank page after another
  page — the page tools return `active_page_not_allowed`: `browser_navigate`
  takes the tab to a page again, and `browser_tabs` can open or select another.
  When no open tab may be the active page they return `no_active_page`.
- The index re-check compares tag, name, href, and position at click time, and
  a snapshot is invalidated if the page navigated since. A mismatch returns
  `element_no_longer_valid` — re-snapshot.
- `browser_snapshot` returns `page_changed`, and nothing of the page, when the
  page navigated while the snapshot was being taken (another address, a
  fragment, a reload, `history.pushState`) — call it again. `browser_read`
  without a selector does the same. With a selector it returns its text (a
  read that waits for a selector goes on across the page's own move to the
  next page), under a first line that says the page navigated and gives both
  addresses. `browser_evaluate` and `browser_screenshot` hand their result
  over with a note that the page navigated.
- Don't use `browser_evaluate` just to read a page (`browser_read` does that,
  and `browser_evaluate` is off unless the server runs with `NORACU_ENABLE_EVAL=1`;
  `NORACU_DISABLE_EVAL=1` keeps it off, and it never runs in a `chrome: true` session).
- `file://` URLs are blocked unless `NORACU_ALLOW_FILE_URL=1`.

## 4. Menu commands

`mac_menu_command` presses the item in the app's own menu bar through
accessibility — no pointer, and the app need not be frontmost. Give the title the
app shows (it must be unique) or a path (Apple-menu items and items whose
shortcut is one of the guarded chords require `force: true`; quitting session
processes or the MCP host is always refused):

```
mac_menu_command { "app": "TextEdit", "command": "Edit > Select All" }
→ ran "Edit > Select All" in TextEdit via semantic AXPress — delivery=delivered_verified, retry=unsafe (changed: selection)
```

## 5. Typing, pasting, and the focus guard

- `mac_type { "text": "hello" }` inserts into the frontmost app's focused
  element through accessibility (`AXSelectedText`): IME-safe, the clipboard is
  untouched, and the value is read back. With `element_index` it targets that
  element (also in a background window); `replace: true` sets the whole value.
- Keystrokes are the fallback only into a text view accessibility cannot write
  (a terminal). When the frontmost app reports no focused element at all,
  `mac_type` sends keystrokes only if `app` names that app; without `app` it
  returns `no_focus` and sends nothing. Keystrokes are not IME-safe;
  `mechanism: "physical"` forces them. The result names the app it typed into.
- `mac_paste { "text": "你好" }` copies the clipboard aside, writes the text, sends
  ⌘V, and puts every previous item back once the paste shows (else after 1 s) —
  unless something else wrote to the clipboard meanwhile. A concealed
  (password-manager) item is not copied; the clipboard is cleared instead.
  `mac_type` does not touch the clipboard at all.
- **Focus guard:** add `"app": "TextEdit"` to `mac_paste` / `mac_key` (and to
  `mac_type` when it sends keystrokes). If TextEdit is not frontmost, the input
  is refused with `focus_lost` and nothing is sent.
- `mac_key` refuses `cmd-q`, `alt-cmd-q`, `cmd-shift-q`, `cmd-alt-esc`,
  `ctrl-cmd-q`, `cmd-alt-delete`, `cmd-shift-delete` and similar unless
  `"force": true`.

```
mac_type { "text": "你好，世界", "app": "TextEdit" }
→ typed 5 chars into the focused element of "TextEdit" via semantic AXSelectedText — delivery=delivered_verified, retry=unsafe
```

## 5b. Waiting, apps, windows, clipboard, notifications

```
mac_wait { "condition": "sheet", "app": "TextEdit", "timeout_ms": 5000 }   # instead of sleeping
mac_wait { "condition": "element", "element_index": 7, "predicate": "enabled" }
mac_app { "action": "launch", "app": "Calculator" }                        # background unless "activate": true
mac_app { "action": "quit", "app": "Calculator" }                          # verified by the process ending
mac_windows { "app": "TextEdit" }                                          # ids, titles, bounds, displays
mac_window { "action": "resize", "window_id": 25647, "width": 800, "height": 600 }
mac_screenshot { "window_id": 25647 }                                      # one window, also when covered
mac_clipboard_read {}                                                      # text, file paths, or an image
mac_notifications {}                                                       # banners/alerts on screen; open_center:true reports center_opened / center_was_open
mac_notifications { "action": "dismiss", "id": "BC2BF929-…" }              # notification_not_found if gone
```

## 5b2. Your own Chrome, with its sign-ins

With `NORACU_ALLOW_CHROME=1` on the server and Chrome's remote-debugging
switch on (`chrome://inspect/#remote-debugging`, Chrome 144+), the browser
tools work in the Chrome you use. Chrome asks you to allow the connection.
noracu opens a window of its own and works only in the tabs it opens there;
your other tabs are not listed, read or touched. With `NORACU_CHROME_TABS=all`
your http(s) tabs are listed too (`noracu_tab: false`) and `browser_tabs` `select`
makes one the active page (nothing else does); noracu still closes only its own tabs. `browser_evaluate` never runs in this session,
even with `NORACU_ENABLE_EVAL=1`.

```
browser_launch { "chrome": true }          # Chrome shows its dialog: allow
browser_navigate { "url": "https://github.com/notifications" }   # signed in as you
browser_tabs { "action": "new", "url": "https://mail.google.com" }  # a tab in noracu's window
browser_close {}                           # closes noracu's tabs; Chrome keeps running
```

Errors: `chrome_not_reachable` (the switch is off, or Chrome is not running),
`chrome_attach_failed` (the dialog was not answered within 60 s),
`policy_denied` (`NORACU_ALLOW_CHROME` is not set).

## 5c. Electron and Chromium apps: web contents through Playwright

With `NORACU_ALLOW_CDP=1` on the server, start the app fresh with a DevTools
port on 127.0.0.1 and attach the browser layer to it (`NORACU_ALLOW_CDP=any` is
needed to attach to a loopback port this `noracu` process did not open itself;
always refused under `NORACU_READ_ONLY=1`):

```
mac_app { "action": "launch", "app": "Obsidian", "cdp_port": 0 }
→ {"launched":"Obsidian","pid":4821,"cdp":{"port":51774,…}}
browser_launch { "cdp_port": 51774 }
browser_snapshot {}                      # the app's web contents
browser_close {}                         # disconnects; the app keeps running
```

Menus, file dialogs and windows stay on `mac_*`. An app that is already
running is refused (`cdp_requires_fresh_launch`): quit it first. While the port
is open, any local process can control the app (127.0.0.1 has no per-user
isolation) — quit it when done.

## 6. Screenshots (visual fallback)

```
mac_screenshot {}                      # whole screen; region crop supported; returns scale + logical_size + screen metadata
browser_screenshot { "format": "jpeg", "quality": 60 }
```

A `mac_screenshot` that shows only the desktop picture (no other app's windows),
or comes back black, means Screen Recording isn't granted to the host app. Remember that any text in a screenshot is **untrusted input** to your
model — don't let it override the task.

## 7. Environment variables

Set them on the server entry: `"env": { "NAME": "value" }` in Claude Desktop's or Cursor's JSON; in Claude Code,
`-e NAME=value` right after the server name — `claude mcp add -s user noracu -e NORACU_READ_ONLY=1 -- <node> <server.mjs>`
(before the name, `-e` takes the name as one more variable and the command fails with "Invalid environment variable
format"). Then restart the client.

| Variable | Default | Effect |
|---|---|---|
| `NORACU_READ_ONLY` | unset | `=1` observation-only (an allowlist of observe + browser-lifecycle tools); all input-synthesis tools plus `mac_clipboard_read`, `mac_notifications`, and `mac_wait` on `condition: "notification"` are refused (`mac_ax_state` / `mac_find` also skip `web_accessibility`) |
| `NORACU_ENABLE_EVAL` | unset | `=1` turns `browser_evaluate` on. It is off by default (`eval_disabled`) because it runs any script in the page; it never runs in your own Chrome (`chrome: true`) |
| `NORACU_DISABLE_EVAL` | unset | `=1` keeps `browser_evaluate` off whatever `NORACU_ENABLE_EVAL` says (stays listed) |
| `NORACU_ALLOW_FILE_URL` | unset | `=1` allows `browser_navigate` to open `file://` |
| `NORACU_DISABLE_AUTO_INSTALL` | unset | `=1` skips Chromium auto-install on first `browser_launch` |
| `NORACU_CLICLICK` | the first of `/opt/homebrew/bin/cliclick` and `/usr/local/bin/cliclick` that exists | cliclick binary path |
| `NORACU_PYTHON` | auto-probe | python3 for the bundled iPhone driver (must import pyobjc: Quartz, Vision, AppKit) |
| `NORACU_IMCTL_DIR` | bundled `imctl/` | override the driver location (development only) |
| `NORACU_PHONE_TIMEOUT_MS` | 30000 (45000 for `phone_open` / `phone_type`) | time limit for each iPhone-layer step, 1000–600000 ms (`imctl_timeout` on expiry) |
| `NORACU_OCR_LANGUAGES` | `zh-Hans,en-US` | comma-separated Vision OCR language codes for the iPhone screen, in priority order |
| `NORACU_TOPHIT_LABELS` | `Top Hit` | comma-separated Spotlight Top Hit section label(s) that `phone_open` looks for |
| `NORACU_OCR_MIN_CONFIDENCE` | unset (off) | opt-in, experimental: a number above 0 and at most 1. With it, `phone_open` does not tap a Spotlight label the recognizer read with a lower confidence and answers `open_not_confirmed` with nothing tapped; a value that is set and is not such a number makes `phone_open` refuse (`invalid_args`, nothing sent). Set or not, `phone_open`'s result line names the confidence of the label it tapped |
| `NORACU_ALLOW_CHROME` | unset | `=1` lets `browser_launch` with `chrome: true` work in your own Chrome (see 5b2); refused under `NORACU_READ_ONLY=1` |
| `NORACU_CHROME_TABS` | unset | `all`: with `chrome: true`, your other tabs are listed and can be selected, read and acted on (never closed) |
| `NORACU_CHROME_DIR` | `~/Library/Application Support/Google/Chrome` | profile folder whose `DevToolsActivePort` `chrome: true` reads |
| `NORACU_ALLOW_CDP` | unset | `=1` allows `mac_app` launch with `cdp_port` and `browser_launch` with `cdp_port` for ports opened by this `noracu` process (`=any` for external loopback ports; refused under `NORACU_READ_ONLY=1`) |
| `NORACU_TRACE` | unset | file path for a JSON-lines call log (`{ts, tool, args, ms, error, code}` — argument names/sizes and error code prefix only, never result or error text; opened `0600` with `O_NOFOLLOW`; a call the client cancelled is logged with code `cancelled`, or `cancelled_queued` if it was still waiting in the input queue) |
| `NORACU_USER_IDLE_S` | `2` | seconds without the person's keyboard or mouse input before a Mac or iPhone Mirroring (`phone_*`) input tool acts (the `ios_*` tools do not wait: they do not use this Mac's keyboard or mouse); a call that comes sooner waits out the rest once and answers `user_active` if they are still using it; also puts the pointer back after pointer actions; `0` turns both off |
| `NORACU_NO_BGPOST` | unset | `=1` turns off background input (physical clicks and named keys use the real pointer and the HID key path) |
| `NORACU_STOP_FILE` | unset | file path: while it exists, every input tool — Mac, iPhone and the browser's input tools (navigate, click, type, fill, press_key, scroll, evaluate, `browser_tabs` new/close) — returns `user_stopped` and sends nothing; set but blank, it refuses all input |
| `NORACU_DENY_APPS` | the common terminal apps and IDEs with a built-in terminal | comma-separated bundle ids / app names (`*`, `?`) that never get input; a list of your own adds to the default, blank keeps the default, a list starting with `none` drops it |
| `NORACU_APPROVAL_FILE` | unset | `0600` JSON `{allow, ask, deny}` of bundle-id / app-name patterns, judged on the app that receives the input; `ask` or unlisted → `approval_required`; an `allow` entry that names an app exactly (its bundle id or name, no `*` or `?`) lets that app through the default deny list — `NORACU_DENY_APPS` entries still win; a broken file refuses all Mac and iPhone input (app rules do not judge the browser layer) |
| `NORACU_LAYERS` | unset (`mac,browser`) | comma-separated `mac`, `browser`, `iphone`: only those layers' tools are listed and callable (the experimental iPhone layer only when `iphone` is named); a call to a tool of a layer that is off says how to turn it on; a name that is not one of the three stops the server at start |
| `NORACU_PHONE_BACKEND` | `mirror` | with the iPhone layer on: `xcuitest` lists the nine `ios_*` tools (section 10) in place of `phone_*`; any other value falls back to `mirror` with a warning on stderr |
| `NORACU_IOS_UDID` | unset | XCUITest backend: the device (or booted simulator) to use; needed when several iPhones are connected (`device_ambiguous` lists them) |
| `NORACU_IOS_RUNNER_DIR` | `~/.noracu/ios-runner` | XCUITest backend: where `npx noracu ios-setup` builds the runner and where the server looks for it |
| `NORACU_CI` | unset | `=1` only affects `npm test` (skips hardware-gated checks) |

## 8. Error reference

| Error | Meaning / fix |
|---|---|
| `element_no_longer_valid` | index older than 30 s, the element is gone or changed, its window closed, or the page navigated — re-observe |
| `permission_denied: Accessibility permission is missing…` | Accessibility not granted to the host app (`mac_status` shows it) |
| `occluded: … on top: {…}` | a physical click would land on something else (including another window of the same app); nothing was sent |
| `ambiguous_window: …` | several windows, none focused — pass `window` or `window_id` |
| `not_actionable: …` | the element is disabled, off screen, or its window is minimized |
| `not_confirmed: …` | the action ran but the read-back does not show the expected result — check `delivery` / `retry` before repeating |
| `focus_lost: …` / `focus_unknown: …` | the focus guard (`app`) could not confirm that app is frontmost — bring it forward before sending keystrokes or paste |
| `no_focus: …` | `mac_type` without `element_index` or `app`, and the frontmost app reports no focused element — keystrokes would go wherever macOS routes them, so nothing was sent; pass `element_index`, or `app` to type into that app anyway |
| `policy_denied: …` | a guarded key chord or menu item without `force`, a protected process, or a DevTools port without `NORACU_ALLOW_CDP=1` |
| `clipboard_remote: …` / `clipboard_too_large: …` | `mac_paste` refused Universal Clipboard content or a clipboard over 64 MB unless `force: true` |
| `notification_not_found: …` | `mac_notifications` dismiss/act target id or index is no longer on screen or no longer matches `expected_app` / `expected_title` |
| `input_busy: …` | an earlier phone or Mac action held the input queue past its wait limit; nothing was sent — retry |
| `ax_timeout: …` | the target app did not answer accessibility calls in time (busy or hung) |
| `mac_screenshot` shows only the desktop picture, or is black | Screen Recording not granted to the host app |
| `ENOENT` cliclick | `brew install cliclick` or set `NORACU_CLICLICK` |
| `… blocked by NORACU_READ_ONLY=1` | you're in observation-only mode — unset it to act |
| `browser_evaluate disabled by NORACU_DISABLE_EVAL=1` | eval kill-switch is on |
| `mirror_not_live: …` | iPhone Mirroring is closed or shows an overlay (paused, "iPhone in Use") — lock the iPhone, keep it near the Mac, call `phone_launch` |
| `mirror_state_unknown: …` | iPhone Mirroring's state could not be confirmed even after bringing it forward — check `phone_status` before acting |
| `mirror_setup_required: …` | iPhone Mirroring shows a setup or welcome screen — finish it yourself in its window, then call `phone_launch` |
| `menu_unknown: …` | `phone_home` or `phone_app_switcher` menu command timed out (`delivery=unknown, retry=unsafe`) — inspect `phone_screenshot` before retrying |
| `imctl_timeout: …` | a phone step ran past its time limit and was stopped — check `phone_status` / `phone_screenshot` before retrying (after `phone_open`, noracu goes back to the Home Screen); raise `NORACU_PHONE_TIMEOUT_MS` on a slow Mac |
| `imctl unavailable: no python3 with pyobjc found …` | install pyobjc for a python3 (`python3 -m pip install pyobjc-framework-Quartz pyobjc-framework-Vision pyobjc-framework-Cocoa`) or set `NORACU_PYTHON` |
| `ax_empty: …` | the app has no window that accessibility can read from the desktop in view. The message says which case it is: the window server lists windows of the app off screen — on another Space, minimized, or the app is hidden (`mac_windows` with `include_offscreen: true` lists them; `mac_app` `activate` brings the app forward and may switch the person's desktop to it) — or the app has no window open. A window on another Space cannot be read |
| `ambiguous_app: …` | two or more running apps share that name or bundle id; nothing was done — name the one you mean as `pid:<number>` (the message and `mac_apps` list the pids) |
| `app_not_found: …` | no running app has that name or bundle id — `mac_apps` lists what runs; `mac_app` with `launch` starts one |
| `app_unresponsive: …` | the app did not answer accessibility in time (busy or hung) |
| `surface_absent: …` | the `surface` asked for is not there: no menu is open, or the app exposes no menu bar |
| `invalid_args: …` | an argument is missing, of the wrong type or out of range, or two that exclude each other were given; nothing was sent — the message names the argument |
| `action_not_supported: …` | the element does not support that action — for text: it takes text only by rewriting its whole value, or no key of the keyboard layout types a character; nothing was sent |
| `action_failed: …` | accessibility or cliclick reported an error for an action that may already have gone out — read `delivery` / `retry`, and observe before repeating |
| `activate_failed: …` | macOS did not bring the app forward |
| `ax_error: …` | the accessibility engine gave no readable answer — call again; if it stays, report it with the message |
| `display_unknown: …` | `mac_screenshot` named a display that is not there (`mac_windows` lists the displays), or the displays could not be read; nothing was captured |
| `no_window: …` | `mac_scroll` without `element_index`: the frontmost app has no window on screen — pass an `element_index` |
| `user_active: …` | the person used the keyboard or mouse in the last `NORACU_USER_IDLE_S` seconds (2 by default), and again while noracu waited out the rest of that time once; nothing was sent — call again once they have stopped |
| `user_stopped: …` | the file named by `NORACU_STOP_FILE` exists; no input is sent until the person removes it |
| `approval_required: …` | `NORACU_APPROVAL_FILE` lists the app under `ask` or not at all; nothing was sent, and it stays so until the person adds the app to `allow` |
| `approval_file_error` / `approval_file_insecure` / `approval_file_owner` / `stop_check_error` | `NORACU_APPROVAL_FILE` or `NORACU_STOP_FILE` is set but blank, cannot be read, is not mode `0600` or is not owned by this user — Mac and iPhone input is refused until the person fixes it (fail closed) |
| `internal_error: …` | an input tool failed in a way noracu did not plan for; what it had sent by then is not known (`delivery=unknown, retry=unsafe`) — observe before acting again, and report it with the message |
| `server_shutting_down: …` | the server is closing; nothing was done |
| `eval_disabled: …` | `browser_evaluate` is off by default — start the server with `NORACU_ENABLE_EVAL=1`; it never runs in your own Chrome (`chrome: true`) |
| `browser_installing: …` | the first `browser_launch` on this Mac: Playwright's Chromium is being downloaded, which can take minutes, so the call answered after 20 s while the download goes on — call `browser_launch` again in a minute (a download that failed is reported by that call) |
| `invalid_element_index: …` | the `element_index` is not in the last `browser_snapshot` — take a new one |
| `navigate_failed: …` | the navigation ended in an error after it had started (`delivery=unknown`) — `browser_snapshot` shows where the page is now |
| `tab_not_found` / `tab_is_last` / `tab_not_owned` / `tab_not_selectable` | `browser_tabs`: no open tab has that `tab_id` (list them again); the only open tab is not closed (`browser_close` ends the session); only a tab opened with `browser_tabs` is closed; only a tab on an http(s) page can be selected |
| `cdp_port_in_use` / `cdp_connect_failed` | the DevTools port is taken (pass another, or `0` for a free one), or nothing answers DevTools on it |
| `cdp_session_active` / `chrome_session_active` | a session attached to a DevTools port, or to your own Chrome, is open — `browser_close` it before launching the standalone browser |
| `chrome_disconnected: …` | the connection to your own Chrome ended; tabs noracu opened there may still be open, and noracu did not quit Chrome |
| `imctl_error: …` / `imctl_output_overflow: …` | the bundled iPhone driver failed, or printed more than 10 MB and was stopped — the step may have partly run; check `phone_status` / `phone_screenshot` before retrying |
| `expect_not_found: …` | the text given as `expect` is not on the phone's screen; nothing was sent |
| `out_of_screen: …` | the point is on the iPhone Mirroring window's margin, not on the phone's screen — or the screen's edges could not be told; nothing was sent |
| `spotlight_unavailable: …` | `phone_open` could not open Spotlight (the Home Screen was not reached, the menu command failed, or the screen did not change); the Home Screen command or the Spotlight gesture may have gone out — `phone_screenshot` before retrying |
| `scroll_no_effect: …` | the phone's screen did not change after the scroll (the end of the list, or nothing there scrolls) |
| `keyboard_layout: …` | no key of the Mac's keyboard layout types a character the step needs; nothing was sent |
| `capture_failed: …` | the iPhone Mirroring window (or, on the XCUITest backend, the phone) gave no image — no other kind of capture is used in its place |

## 9. iPhone layer

Experimental and off by default: `NORACU_LAYERS=mac,browser,iphone` turns it on
(section 7). The driver (imctl, Python) ships inside the package. The tools
need Apple's iPhone Mirroring with the iPhone **locked and near the Mac**
(unlocking it ends the session; not available in the EU) and a python3 with
pyobjc (`NORACU_PYTHON`, or the automatic probe described in the README).
The phone exposes no accessibility tree, so this layer is not `element_index`:
it observes with OCR on the Mac and acts at normalized 0–1 coordinates.

```
phone_status
→ {"running": true, "window": {...}, "window_id": 278508, "onscreen": true,
   "frontmost": false, "live": false, "overlay": "Connection Paused", "paused": true, "setup": false}

phone_tap {"x": 0.5, "y": 0.5}       # refused while the mirror is not live
→ ERROR: mirror_not_live: Connection Paused — call phone_launch (or imctl resume) first (delivery=not_delivered, retry=safe)

phone_launch          # brings the mirror to the front and clicks Resume
→ iPhone Mirroring ready (delivery=delivered_unverified, retry=safe)

phone_status
→ {... "live": true, "overlay": null, "paused": false, "setup": false ...}

phone_ocr             # OCR of the Mirroring window (captured by window id)
→ (0.50,0.06) 'Settings' [1.00]
  (0.18,0.31) 'FaceTime' [1.00]
  -- 2 hits

phone_find {"text": "Settings"}
→ (0.50,0.06) 'Settings' [1.00]

phone_tap {"x": 0.50, "y": 0.06}
→ tapped (0.5, 0.06) (delivery=delivered_unverified, retry=unsafe)
```

`live` / `overlay` / `paused` / `setup` come from the window's structure and
shape, not its language: a live mirror is a single empty hosting view;
"Connection Paused", "iPhone in Use" and similar states add text and a button;
a setup or welcome screen (`setup: true`) sits in a window that is not
phone-shaped, and `phone_launch` never clicks it. While the mirror is
not live, every phone input tool (`phone_tap`, `phone_longpress`, `phone_swipe`,
`phone_scroll`, `phone_type`, `phone_key`, `phone_open`, `phone_home` and
`phone_app_switcher`) refuses with `mirror_not_live` (or `mirror_state_unknown`
when the state cannot be read), and `phone_ocr` / `phone_find` start with a
`warning: mirror not live …` line.

`phone_scroll {"direction": "down", "distance": 0.5}` moves the list under the
mirror by about half a window, with trackpad-style scroll events; a vertical
`phone_swipe` drag does not scroll lists in iPhone Mirroring, so keep swipes
for gestures such as Home Screen paging. Start a page swipe in the empty strip
just above the Dock (y about 0.80): the mirror delivers a drag as pointer
input, and one that starts on an app icon picks the icon up and moves it — it
can rearrange the Home Screen or drop the icon on another one and make a folder.

`phone_type` pastes through the clipboard with a real Command-V chord (never
echoing the typed text), saving every clipboard item and type, clearing
concealed or transient items instead of copying, and restoring the clipboard
once OCR sees the pasted text appear on the phone at a spot where it was not
before the paste, below the strip at the top where the status bar and
notification banners are drawn (text already on screen, or the same words in a
banner, do not count); only that sighting makes the result
`delivered_verified`. Universal Clipboard or >64 MB items are not copied and
leave the typed text on the clipboard. A text shorter than four characters
(spaces and case aside) is never confirmed and never restores the clipboard. If
the text only shows up a few seconds late (reported as typed but
`delivered_unverified` — OCR cannot tell the paste from a line that repeats it,
such as a search result, so read the field before typing again) or the call
ends in `type_not_confirmed`, the clipboard also keeps the typed text.
`phone_open {"app": "Calculator"}` opens Spotlight through iPhone Mirroring's
own shortcut, pastes the name, and taps it only when Spotlight's Top Hit card
shows exactly that name (a web suggestion or Settings row with the same name
is never tapped); otherwise it returns to the Home Screen and reports
`app not found` (`delivery=delivered_unverified, retry=safe`). A paste can take
several seconds to reach the iPhone: when the
name never shows up, `phone_open` waits up to 15 s and then reports
`open_not_confirmed` (retry) rather than `app not found`. OCR rarely reads a
one- or two-letter name such as `X`, in the Top Hit card or the search field,
so for those `phone_open` does not wait the 15 s: it reports `open_not_confirmed`
and taps nothing — open such an app from its Home Screen icon
(`phone_screenshot`, then `phone_tap`). Use the name the phone shows under the icon (`拼多多`, not
`Pinduoduo`); it reads Spotlight's English "Top Hit" label, so on an iPhone
set to another language set `NORACU_TOPHIT_LABELS` to the label the phone shows.

Privacy: everything the phone shows — notifications, messages, one-time
codes — becomes tool output that your MCP client sends to its model. Use a
Focus, open a neutral app first, and start with `NORACU_READ_ONLY=1`
(phone observation allowed, phone input refused). `phone_home` /
`phone_app_switcher` go through the iPhone Mirroring menu while the mirror is
live — working without python/pyobjc on English macOS, refusing when paused or
closed, returning `menu_unknown` without a fallback swipe on timeout, and
falling back to `imctl` when the English menu item is absent on non-English
macOS.

## 10. iPhone: the XCUITest backend

Experimental and opt-in (`NORACU_PHONE_BACKEND=xcuitest`, with the iPhone layer on); the `ios_*` tools then
replace `phone_*`. Requirements and the one-time `npx noracu ios-setup` are in the
README. The iPhone must be unlocked.

```
ios_status                                  → device, locked?, runner built?, runner running?
ios_launch   { bundle_id: "com.apple.Preferences" }   → in front (delivered_verified)
ios_snapshot { interactive: true }          → elements: [{ i, type, label, value, frame }]
ios_type     { element_index: 12, text: "wifi" }      → verified when a field shows the text
ios_tap      { element_index: 31 }          → sent; look again
ios_snapshot                                → the new screen, new indexes
ios_home                                    → Home Screen; earlier indexes end
```

- Indexes last 30 s and are unique across snapshots. Before one is used the app
  is read again; `element_no_longer_valid` means the element moved, changed, or
  its app left the front — take a new `ios_snapshot`. An app that has just come
  to the front may still be filling in its rows: snapshot again after a moment.
- `bundle_id` defaults to the app of the last call (`ios_launch` sets it;
  `ios_home` sets it to `com.apple.springboard`).
- Coordinates (`ios_tap` x,y, `ios_swipe` from/to, element frames, the size
  `ios_screenshot` reports) are screen points.
- Scroll with `ios_swipe` (a list moves a little less than the finger); press
  return or delete with `ios_key`; a long press is `ios_tap` with `duration_ms`.

| Error | Meaning / fix |
|---|---|
| `ios_setup_required` | no runner build for this device — run the `npx noracu ios-setup …` command it names |
| `device_not_found` / `device_ambiguous` | no connected iPhone, or several: connect and unlock one, or set `NORACU_IOS_UDID` |
| `device_locked` / `lock_unknown` | the iPhone is locked, or its lock state could not be read — nothing was sent or read; unlock it |
| `input_denied: … while app rules are in force` | app rules are set (`NORACU_APPROVAL_FILE` or `NORACU_DENY_APPS`): no input that names `com.apple.springboard` is sent — not even one tap on a button of a system prompt (answer those on the phone). It is refused before a runner is started, so the refusal changes nothing on the phone. Open apps with `ios_launch`, go home with `ios_home` |
| `home_not_confirmed` | Home was pressed but the app is still in front — after 3 s, or when its state was last read before a read failed (the result says which); look with `ios_screenshot` |
| `runner_not_started` | `NORACU_READ_ONLY=1` is set: observation-only mode does not start the runner (starting it puts the runner's app in front on the iPhone) — unset it to read the screen |
| `xctest_issue` | XCTest reported a failure while the command ran, or after an earlier one had answered. The test session is ended either way and the next call starts a new one. For an input that may have gone out the delivery is unknown; a command that was not run says `delivery=not_delivered`. Look with `ios_snapshot` before acting again |
| `app_not_running` / `app_not_foreground` | the app is not in front — `ios_launch` it first; nothing was sent |
| `system_overlay` | the iPhone is showing something of its own over the app (Control Center pulled down, or the Home Screen while an app is still coming forward) while the app still reports that it is in front, so a tap would land on that instead — nothing was sent. Look again with `ios_snapshot` in a moment; if it is still there, `ios_home` closes it but leaves the app for the Home Screen (`ios_launch` brings the app back) |
| `no_keyboard` | no keyboard is up — tap a text field, or give `ios_type` an `element_index` |
| `type_not_confirmed` | the text was typed but the field that took it does not hold its old value with the text put in at one place (autocorrection or completion changed it, the field hides its value, part of the text was lost, or the text went to another field) — read the field before typing again |
| `launch_not_confirmed` | the app was started but is not in front after 10 s (a system prompt may cover it), or its state could not be read to the end of that wait — the result says which; `ios_screenshot` |
| `launch_failed` | `devicectl` / `simctl` refused (not installed, wrong bundle id) — nothing was sent |
| `ios_timeout` | the phone did not answer in time — delivery unknown, never re-sent; look before acting again |
| `runner_start_failed` / `runner_start_timeout` / `runner_version_mismatch` | the runner did not start (the message says why) — a version mismatch means the runner on the device was built by another noracu version (it names its build, and so does the message): run `ios-setup` again; `the runner that was stopped has not exited yet` means the last test session is still ending: try again in a moment |
| `runner_restarted` | the runner started during this call, which puts its own app in front — the screen the points or the focus were meant for is gone; nothing was sent, look again (`ios_snapshot`) before acting |
| `runner_unreachable` / `runner_busy` | the runner stopped or its connection closed (the next call that asks for the iPhone starts it), or another runner call is still in flight; nothing was sent |
| `device_not_ready` | the simulator is not booted, or the iPhone is not paired, has Developer Mode off, or has no tunnel to this Mac — the message says which |
| `devicectl_failed` / `devicectl_timeout` / `simctl_failed` / `simctl_timeout` | Xcode's device tool (`devicectl` for an iPhone, `simctl` for a simulator) failed or gave no answer in time — the message quotes it |
| `not_a_text_field` | `ios_type` was given an `element_index` that is not a text field; nothing was typed |

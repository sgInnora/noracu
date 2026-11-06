# Changelog

## [0.2.3] — 2026-11-06

### Tests
- The local test suite also closes and reopens a window under a window-level
  `element_index` (the default surface) and checks that `mac_get` and a
  physical `mac_click` both return `element_no_longer_valid`, with no click
  sent.

## [0.2.2] — 2026-11-06

### Fixed
- A physical click (`mac_click` on an element without a semantic action, or
  with `mechanism: "physical"`) is no longer reported as `delivered_verified`
  when something else happened between the hit test and the click. Right before
  sending, the window on top at the point is checked again; anything that came
  on top since refuses the click (`occluded`, nothing sent). After the click,
  `delivered_verified` needs the element to still be there, to have changed,
  and its own window to still be on top at the click point; a vanished element
  or another window there gives `delivered_unverified` with a note. `mac_drag`
  re-checks both ends the same way. Found on a device run that covers, moves
  or closes the target in that gap: 0.2.1 reported all three as
  `delivered_verified`; this version reports them as `delivered_unverified`,
  and an undisturbed click is still `delivered_verified`.

### Security
- An `element_index` read with `surface: "app"` (or `mac_find` with
  `surface: "app"`) is bound to the CGWindowID of the window it was in: a
  window closed and reopened with the same name, text and position gives
  `element_no_longer_valid`.
- An element in a window that has no CGWindowID is refused with
  `policy_denied` instead of being matched by title and frame, since a closed
  and reopened window could not be told apart. Finder's desktop (the only such
  window seen on the test Mac) is exempt. `mac_ax_state` and `mac_find` mark
  such a window with `window_identity: "unverifiable"` and a hint. A physical
  click whose hit test is inconclusive and whose window has no CGWindowID is
  refused (`occluded`).

### Tests
- `NORACU_TEST_PHYSICAL_GAP_MS` (test hook, never set in normal use) waits
  between the last check and the click and reports it on stderr. The local test
  suite uses it to cover, move and close the target in that gap, and to close
  and reopen a window under an app-level index.

## [0.2.1] — 2026-11-06

### Fixed
- `mac_click` at raw x,y no longer lands on whatever covers the point. Before
  sending, it checks that the topmost on-screen window there belongs to the new
  optional `app` (default: the frontmost app; the menu bar counts as the
  frontmost app's). Otherwise it returns `occluded`, naming the owner and
  window layer of what covers the point, and sends nothing. `force: true`
  skips the check. `app` and `force` are refused together with
  `element_index`, which is already re-identified and hit-tested.
- `mac_key` Return now works in Chrome's address bar. Named keys (return, esc,
  tab, space, delete, arrows, home/end, page keys, F1–F16) are sent as HID
  key events by the accessibility engine instead of by cliclick: Chrome's
  address bar ignored cliclick 5.1's Return. With modifiers, each modifier is
  pressed and released around the key, so no modifier is left held
  afterwards. Chords on a character key (`cmd-c`) still go through cliclick.
  Tested on macOS 27.2 with a separate Chrome instance: the address bar
  navigated, and arrow-down, cmd-arrow-up, esc, return and shift-tab arrived
  with the right key and modifiers; no modifier was held afterwards.
- `web_accessibility` in `mac_ax_state` and `mac_find` results now says what
  the window holds. Google Chrome refuses `AXManualAccessibility`, so 0.2.0
  reported `unsupported` even when Chrome's pages were readable (Chrome
  started with `--force-renderer-accessibility`). In that case it now reports
  `exposed`. When the app refuses and no web content is found, it reports
  `unsupported` with a `web_accessibility_hint`: use the `browser_*` tools, or
  restart Chrome with `--force-renderer-accessibility` and read again. `mac_find` now reports
  `web_accessibility` too.

## [0.2.0] — 2026-11-06

### Added
- The Mac layer reads and acts through a new accessibility engine,
  `src/mac-ax.js`: a static JXA script that calls the macOS Accessibility API
  (`AXUIElement*`) directly instead of going through System Events. Reading a
  Finder window of about 500 elements took about 0.15 s on the test Mac
  (macOS 27.2), so the default depth is now 12 instead of 3. Requests reach it
  as JSON on stdin, never in argv.
- `mac_ax_state` takes `interactive` (only actionable elements), `compact`
  (default true: skips empty layout wrappers), `skeleton` plus `root` (map a
  dense app shallowly, then drill into one element; the drill extends the same
  snapshot), `surface` (`window`, `menubar`, `menu`, `sheet`, `alert`,
  `dialog`, `popover`, `focused`, `app`), `window` (index or title) and
  `max_nodes`. Each element carries `d` (depth), `states` and `actions`; the
  result carries `snapshot_id` and `complete`. Several windows and none focused
  is `ambiguous_window` with the list, instead of reading an arbitrary one.
- Electron and Chromium apps get their web accessibility tree switched on
  (`AXManualAccessibility` only — never `AXEnhancedUserInterface`, which alters
  window behaviour) when read unless `web_accessibility: false` or
  `NORACU_READ_ONLY=1`; `mac_ax_state` and `mac_find` take `web_accessibility`
  and report the outcome.
- New tools: `mac_find` (search by role, title, value, text or AXIdentifier),
  `mac_get` (read one element live: full value, states, actions, settable
  attributes), `mac_status` (Accessibility and Screen Recording permission,
  cliclick, displays), `mac_apps` (running apps) and `mac_windows` (windows
  with CGWindowID and bounds, plus displays). All five are observation tools
  and are allowed under `NORACU_READ_ONLY=1`.

- `mac_click` with an `element_index` uses the element's own accessibility
  action when it has one (press, show menu, select): no pointer movement, no
  focus change, and it works on windows in the background. Without one it
  clicks physically, but only after a hit test shows that the point reaches the
  element; otherwise it returns `occluded` with what is on top and sends
  nothing. `mechanism` (`auto`, `semantic`, `physical`) forces one path; a
  semantic attempt that fails is reported, not retried physically.
- Every Mac action result says whether it was delivered
  (`delivered_verified` when a change was observed, `delivered_unverified`,
  `not_delivered`, `unknown`) and whether a retry is safe, and names sheets,
  dialogs or menus it opened. The engine reads the element and its app again
  after acting, because accessibility return codes alone do not prove an
  effect (Finder reports success for an action that does not exist).
- `mac_type` inserts text through accessibility (`AXSelectedText` at the
  caret, or the whole value with `replace: true`) into an `element_index` or
  the focused element: IME-safe, the clipboard is untouched, it works in a
  background app, and the value is read back. It falls back to keystrokes only
  when accessibility reports no focused element or the focus is a text view it
  cannot write (such as a terminal); a focused button, list or sheet gets no
  keystrokes.
- New tool `mac_set_value`: text fields, checkboxes, switches and radio
  buttons (idempotent: nothing is sent when the state already matches),
  disclosure triangles and expandable rows, selectable rows, cells and tabs,
  pop-up and menu buttons and combo boxes (picks exactly one matching option,
  else closes the menu again and lists the options), sliders and steppers.
- `mac_scroll` takes an `element_index`: a scroll area is scrolled at its own
  center (and the result says when the position did not change); any other
  element is scrolled into view.
- `mac_key` refuses chords that quit, log out, lock, force-quit, delete
  immediately or empty the Trash (`cmd-q`, `alt-cmd-q`, `cmd-shift-q`,
  `cmd-alt-esc`, `ctrl-cmd-q`, `alt-cmd-delete`, `cmd-shift-delete`, …) unless
  `force: true`.

- New tool `mac_wait`: waits for a window, text, an element state, a menu, a
  sheet or dialog, an app starting or ending, or a new notification, polling
  accessibility inside one process instead of sleeping; on timeout it returns
  what it last saw.
- New tool `mac_app`: launch (attaches to a running instance; starts in the
  background unless `activate`; waits for a window), activate, hide, unhide,
  quit. Quit is verified by the process ending; a save dialog that keeps the app
  running is reported, and `force: true` force-quits. Finder, the Dock,
  loginwindow and other session processes, and the MCP host itself, are never
  quit.
- `mac_app` launch with `cdp_port` (needs `NORACU_ALLOW_CDP=1`) starts a
  Chromium or Electron app fresh with a DevTools port on 127.0.0.1, and
  `browser_launch` with `cdp_port` attaches Playwright to it, so `browser_*`
  drive its web contents while menus, dialogs and windows stay on `mac_*`.
  `browser_close` then only disconnects. Chrome-family browsers get a profile
  of their own under `~/.noracu/cdp-profiles/` (Chrome refuses remote debugging
  on the default profile); an Electron app keeps its own data. An app that is
  already running is refused rather than quit.
- New tool `mac_window`: focus, raise, minimize, restore, move, resize,
  maximize (the display's visible area), fullscreen, exit fullscreen — by
  CGWindowID from `mac_windows` or by app + window; verified by reading the
  window again.
- `mac_screenshot` captures one window (`window_id`, also when covered) or a
  given display (`display`).
- New tool `mac_clipboard_read`: file paths, an image, or text (capped).
  An item marked concealed by a password manager
  (`org.nspasteboard.ConcealedType`) is never returned.
- New tool `mac_notifications`: lists banners, alerts and an open Notification
  Center (id, app, title, subtitle, body, actions, plus `center_opened` and
  `center_was_open` when `open_center: true`), and dismisses or acts on one by
  its non-empty id (`notification_not_found` when gone), or by index plus a
  non-empty expected app or title that is re-checked.
- `mac_ax_state` and `mac_find` take `window_id`.

- `mac_menu_command` presses the item through the accessibility engine, by
  title or by a `Menu > Item` path, without the app being frontmost, and
  reports delivery; an unknown item is now an error. `phone_home` and
  `phone_app_switcher` use the same path for the iPhone Mirroring menu.
- `initialize` returns `instructions`: the observe → act → verify loop and the
  delivery / retry rules, for clients that show them to the model.
- `NORACU_TRACE=<file>` writes one JSON line per tool call (`{ts, tool, args,
  ms, error, code}`): tool, argument names and sizes (never their text),
  duration, error flag and error code prefix — never result text or error
  messages — opening the file `0600` with `O_NOFOLLOW` so a symlink is refused.

### Changed
- An element is re-identified only inside the window it was seen in, by that
  window's CGWindowID: an index from a window that has since closed is
  `element_no_longer_valid`, even when another window of the app looks the
  same.
- `mac_click` / `mac_drag` with an index no longer require the snapshot's app
  to be frontmost; the element is re-identified and, for a physical click,
  hit-tested instead.
- An `element_index` is backed by identity evidence instead of a stored point:
  process, container (window by CGWindowID, open menu, menu bar or app), child
  path, role, subrole, AXIdentifier, label (never the value), frame relative to
  the container, the labels of its ancestors, the child count along its path,
  and the texts of its item (static text and link labels under it or its
  nearest ancestor below the page, toolbar or pane level; a text field's value
  only when it is table content such as a file name; an item that two
  look-alikes share is not used). An element found at its path must agree on
  all of it (the child counts may differ only when its own item vouches for
  it); a labelled element may be found by search only near where it was and in
  the same item (a re-sorted list resolves to the same item; a look-alike that
  arrived since is not taken for it), an unlabelled one never. Digits in a
  unique element's item are ignored, so a character counter next to Send does
  not invalidate it. A drilled (`root`) snapshot or a filtered `mac_find` cannot know
  whether an element is unique, so its elements are checked as look-alikes. So
  a row inserted above, a closed panel or a closed pop-up menu gives
  `element_no_longer_valid`, never a look-alike (a search no longer enters the
  menu bar, whose closed items can still be pressed).
- Mac `element_index` values are unique for the life of the server: every
  snapshot continues one counter, so an index from an earlier snapshot keeps
  naming its own element after a later `mac_find` or `mac_ax_state`.
  `snapshot_id` is optional and must match the index. A drill (`root`) numbers
  the children from where the root is now.
- `mac_ax_state` / `mac_find` with `window_id` alone read that window's app;
  `mac_find` `text` with `exact:true` matches the label or the value as a whole
  string, and `id` is a substring match unless
  `exact:true`, as documented.
- A window or root that does not answer accessibility is `app_unresponsive`, not
  an empty tree reported as complete.
- Physical clicks fail closed: when the accessibility hit test is inconclusive (an
  error, nothing there, or only a container of the element), the click is sent
  only if the topmost on-screen window at the point belongs to the element's
  app; otherwise `occluded` / `not_actionable`, nothing sent.
- `mac_drag` with indexes re-identifies and hit-tests the drop target as well as
  the start point.
- The focus guard (`app` on `mac_key`, `mac_paste`, `mac_type`) compares
  processes, so a bundle id or `.app` path works; it reads the frontmost app
  through the accessibility engine instead of System Events (no Automation
  prompt, no blocking call). `mac_type` with `mechanism: "physical"` and an
  `element_index` types only if the click left the element's app in front.
- cliclick runs asynchronously under a timer; a cliclick that fails after it
  started is reported `action_failed` with `delivery=unknown, retry=unsafe`
  (only a cliclick that never started is `not_delivered`).
- The stale-server note also fires when `src/mac-ax.js` changed on disk.
- `NORACU_READ_ONLY=1` allows 18 tools (the six new Mac observation tools,
  `mac_wait` included, except `mac_wait` with `condition: "notification"` is
  refused and `mac_ax_state` / `mac_find` do not enable `web_accessibility` on
  apps); `mac_clipboard_read` and `mac_notifications` stay outside it.
- `tools/list` emits a `required` array derived from non-optional arguments on
  every tool that has any, and every tool checks its arguments (types, ranges,
  allowed values, string lengths) before anything runs.
- Accessibility failures read `permission_denied: …` instead of the raw
  AppleScript error -1719.

### Fixed
- The server never blocks on a child process any more: screenshots, scroll
  wheel events, `open`, `ps` and the Chromium download run asynchronously under
  a timer, so `ping`, `tools/list` and other calls keep being answered while
  one runs. Two `browser_launch` calls during a first-run Chromium download
  share one download.
- Observation tools (`mac_ax_state`, `mac_find`, `mac_get`, `mac_windows`,
  `mac_apps`, `mac_screenshot`, `mac_status`) and `mac_wait` no longer join
  the input queue: they wait only for the inputs queued before them, so they
  see the state after those inputs, and later inputs are not held up behind
  them; if those inputs keep the queue busy past the queue limit they return
  `input_busy` instead of reading too early. `mac_wait`'s timeout starts after
  that wait.
- The server stops when the client closes its stdin instead of lingering, and
  on SIGTERM / SIGINT / SIGHUP shuts down in order: queued calls are dropped
  without acting, no new child process starts (a fallback step cannot act),
  child processes get SIGTERM then SIGKILL after 1.5 s, browsers — also one
  still starting — are closed, and it exits within 3 s. Two `browser_launch`
  calls at once share one launch.
- A line that is not JSON gets a JSON-RPC parse error (-32700) and a batch
  gets -32600 ("batch is not supported") instead of no answer.
- With `NORACU_PHONE_TIMEOUT_MS` above 45 s, a queued call waits as long as
  the longest phone call ahead of it before giving up with `input_busy`.
- An accessibility call to an app that does not answer gives up after 3 s for
  every element, not only for the app element.
- Accessibility engine timeouts report `delivery=unknown, retry=unsafe` on
  every mutating operation (`mac_click`, `mac_set_value`, `mac_type`,
  `mac_menu_command`, `mac_window`, `mac_app`, `mac_scroll` into view, and
  mutating `mac_notifications` actions), while observation timeouts omit
  delivery fields because nothing was sent.
- Outer accessibility engine process timeouts include a 12 s margin above
  `timeout_ms` so the engine is not killed while waiting for an element to
  become actionable and settle.
- Action verification ignores environment-only shifts (`frontmost`,
  `focusedWindow`, `focus`) unless an element or surface property also changed,
  reporting `delivered_unverified` instead of `delivered_verified`.
- Post-action observation after a physical click or wheel scroll counts an
  element as `gone` only when the element, window or app is actually absent;
  unresponsive or failed reads report `delivered_unverified` with a note
  instead.
- Wheel scrolling on an element verifies delivery solely from `vscroll` /
  `hscroll` changes, and notes an unchanged scroll position only when that
  scroll check is unverified.
- Accessibility writes and steps that already executed never report
  `not_delivered` / `retry=safe`: `mac_type` and `mac_set_value` look for the
  value to change for about 0.4 s before returning `not_confirmed`
  (`delivery=delivered_unverified, retry=unsafe`); a caret that moved while the
  value reads the same is `delivered_unverified`, never verified; partial slider/stepper loops
  report `delivered_unverified` with the step count completed, and `mac_window`
  `maximize` reports `delivered_unverified` if moving succeeded before resizing
  failed.
- `mac_window` `focus` reports `delivered_verified` only when the app is
  frontmost and the target window itself reads focused or main.
- `mac_set_value` treats mixed-state checkboxes as neither on nor off, pressing
  up to twice until the requested state is reached instead of answering
  "already off".
- Pop-up and menu-button option matching in `mac_set_value` drops substring
  matching (so `"One"` never picks `"None"`), matching exact, case-insensitive,
  then normalized titles (collapsed whitespace and trailing ellipsis stripped).
- `mac_wait` fails immediately with `app_not_found` on `window_gone`,
  `text_gone`, `menu_closed` and `sheet_gone` when the app is not running at the
  first check, keeps polling on `text_gone` when window selection is ambiguous,
  and counts `element` `gone` as met only on absent-target errors rather than a
  hung app.
- `mac_key` states `delivery=delivered_unverified, retry=unsafe` in its result
  text, and `mac_menu_command` documents that items reading disabled in closed
  menus are still pressed and judged by before/after observation.
- `phone_home` and `phone_app_switcher` require the iPhone Mirroring menu item
  to be enabled (`require_enabled`), refuse with `mirror_not_live` when the
  mirror is paused or not running, return `menu_unknown`
  (`delivery=unknown, retry=unsafe`) without falling back to a swipe when the
  menu call times out, and fall back to the `imctl` gesture only when the
  English menu item is absent. Success output states only that the command or
  gesture was `sent` (`screen not verified`), never that the phone is on the
  Home Screen.
- Non-import Python tracebacks from `imctl` are reported as
  `imctl_error: <last line>` instead of `imctl unavailable` (kept for missing
  Python or `pyobjc`), and `phone_longpress` passes `--duration` cleanly while
  `imctl longpress` accepts both optional positional and `--duration` syntax.
- Every `imctl` press/release pair (`tap`, `long_press`, `swipe`,
  `app_switcher`, `scroll_trackpad` phase end, `press_key`, `clear_text`, and
  Command chords) posts its release event in `finally:` so an exception or
  `SIGTERM` never leaves a mouse button, key, `⌘` or trackpad scroll phase held
  down.

- Physical clicks and drags on a display left of or above the main one go to
  the right place: cliclick reads a bare negative coordinate as relative to
  the pointer, so negative coordinates are now written absolute (`=-N`).
- When the accessibility hit test is inconclusive, a physical click is also
  refused when another window of the same app (a floating panel, another
  document) is on top at the point; the Dock's own platter counts as covering,
  only its full-display overlay lets clicks through.
- `mac_drag` takes `from_index` / `to_index` only (an undocumented coordinate
  form skipped both hit tests); `mac_type` with `element_index` and `app`
  refuses when the element belongs to another app.
- Results state delivery where they did not: refusals before anything is sent
  (validation, focus guard, unknown or expired index, read-only mode,
  `input_busy`, stopping) say `delivery=not_delivered, retry=safe`; an engine
  that crashed or answered garbage during an action says `delivery=unknown`;
  a failed scroll wheel says `unknown` unless the script never started;
  `mac_window` is verified only by the state asked for (minimized, position,
  size, full screen…), and a pop-up option only when the control shows it;
  `mac_app` launch of a running app with `activate: true` reports the
  activation; `phone_*` input results state delivery and retry too (a refusal
  such as `mirror_not_live` or `expect_not_found` sent nothing; a timeout,
  `type_not_confirmed`, `open_not_confirmed`, `capture_failed` or `focus_lost`
  may have acted).
- `phone_home` / `phone_app_switcher` find iPhone Mirroring by bundle id, so a
  non-English macOS (where the app's name is localized) still gets the menu
  command or the gesture fallback instead of `mirror_not_live`.
- Phone input refuses when the mirror stops being live while it is brought
  forward from another Space, and reports `mirror_state_unknown` instead of a
  Python traceback when bringing it forward times out. A long swipe and the app
  switcher's hold stop (and release the button) when the mirror loses focus;
  an invalid long-press or swipe duration sends nothing.
- A `phone_open` stopped by SIGTERM no longer runs its own trip to the Home
  Screen (it brought the mirror forward and sent a Cmd chord while the server
  may be stopping); after a timeout the server goes Home through the menu.
- `phone_launch` results state delivery; a call refused because the server is
  stopping, or `phone_type` refused because the clipboard changed before
  anything was typed, says `delivery=not_delivered`.
- `browser_click` by `element_index` no longer falls back to a synthetic
  JavaScript `click()` when Playwright's actionability checks fail: a covered,
  disabled or detached element returns `occluded`, `not_actionable` or
  `element_no_longer_valid` (`delivery=not_delivered, retry=safe`).
- Each browser session keeps the tab it is driving as the active page instead
  of taking the last tab: a tab the page opens itself (`window.open`,
  `target=_blank`) is never switched to (another tab becomes active only after
  the active one closes), and an `element_index` used on a different tab, even
  one at the same URL, returns `element_no_longer_valid`. When attaching over
  CDP the session picks a context with non-`devtools://` pages; a standalone
  `browser_launch` is refused while a CDP session is open instead of reusing
  the attached app; a browser or app that closes or disconnects on its own is
  forgotten.
- `browser_snapshot` names `<input>`, `<textarea>` and `<select>` fields from
  ARIA labels, `<label>`, `placeholder`, the value of button-type inputs, the
  selected option, `name` and `type` (text a user or agent typed is never part
  of a name), and reports truncation — with how many interactive elements were
  left out — past 100; `browser_scroll` accepts `up|down|left|right`, wheels at
  the viewport center and reports the `scrollX`/`scrollY` change (or
  `"did not move"`); `browser_navigate` includes the HTTP status (or
  `"no response"` for same-document navigations); `browser_screenshot` over CDP
  uses CSS pixels; every browser call runs under a time limit; `browser_type`
  takes at most 2000 characters (use `browser_fill` for longer values), so its
  time limit always covers the typing; every `browser_*` input tool (`click`,
  `fill`, `type`, `press_key`, `scroll`, `navigate`, `evaluate`) states
  `delivery=…, retry=…` in its success and error text.
- `phone_open` that ends in "app not found" says
  `delivery=delivered_unverified` (it had already gone Home and searched
  Spotlight); a screen capture that fails while checking `expect` says nothing
  was sent; an `expect` value that starts with `-` reaches the iPhone driver as
  one `--expect=…` argument and is never read as an option; an invalid
  long-press or swipe duration is refused before iPhone Mirroring is brought
  forward.
- `mac_window` `focus` / `raise`: when `AXRaise` fails after the window was
  already unminimized or made main, the result follows the state asked for
  instead of reporting `not_delivered`; a physical Mac click whose element does
  not report its window id is checked against its window's (or the snapshot
  window's) id, so another window of the same app on top is still `occluded`.
- A physical Mac click on an element that reports no window of its own is
  checked against the window found through its parents, also when it came
  from an app-wide snapshot; `mac_app` launch resolves `~/…` and symlinked
  `.app` paths for every launch, not only with `cdp_port`; `browser_launch`
  refusals before anything starts (profile in use, Chromium missing) say
  `delivery=not_delivered, retry=safe`.
- `phone_type` no longer reports `typed` when only the picture changed after
  the paste (a selection highlight or a results list redraw) and OCR never
  saw the text: it keeps watching for the text and otherwise reports
  `type_not_confirmed`; a one-character paste that OCR cannot read back says
  `delivery=delivered_unverified` (device run 2026-11-06, macOS 27.2,
  iOS 27).
- `mac_notifications` with `open_center: true` checks positive evidence that
  Notification Center's panel is already open (the menu-bar clock reads selected
  or a Notification Center panel element is present; desktop widgets do not
  count) before clicking the clock, reporting `center_was_open` when
  already open and `center_opened` when opened by the call; empty `id`,
  `expected_app` or `expected_title` strings fail validation; a notification
  that is no longer there returns `notification_not_found`
  (`delivery=not_delivered, retry=safe`), while other accessibility errors keep
  their delivery state and note when the notification is no longer on screen.

### Security
- `mac_set_value` on an `AXSecureTextField` never reads back or echoes the
  value (`(secure field — value not shown)`), `imctl type` reports character
  count instead of echoing typed text, and `NORACU_TRACE` omits result previews
  and error messages (recording only `code`) and opens the trace file `0600`
  with `O_NOFOLLOW`.
- `phone_type`, `phone_find` and `phone_open` pass their text to imctl on
  stdin instead of in the process arguments, where every local user could read
  it while the call ran.
- `imctl` `_require_live` (now also guarding `imctl home`, `imctl app-switcher`,
  and `imctl verify`) probes the mirror overlay before activating iPhone
  Mirroring so a paused or closed mirror refuses (`mirror_not_live`) without
  stealing focus, retries once after bringing the window forward when the state
  is unknown, and fails closed with `mirror_state_unknown` instead of sending
  blind input; `gestures.app_switcher` also verifies that iPhone Mirroring is
  frontmost before mouse-down.
- `phone_*` argument validation and `imctl` argv hygiene: `phone_key` validates
  allowed key names, `phone_swipe` validates normalized `[0, 1]` coordinates and
  `ms` (`50–5000`), `phone_longpress` validates `duration`, `phone_find`
  (`≤ 200`) and `phone_type` (`≤ 2000`) enforce per-tool text limits, and
  `phone_find`, `phone_open` and `phone_key` pass `--` before positional values
  so leading `-` strings are never parsed as `imctl` options.
- `mac_paste` no longer loses non-text clipboard contents or re-publishes a
  password manager's concealed item: the whole paste runs in one engine call
  that copies every clipboard item and type aside, writes the text marked
  transient, sends ⌘V only if the clipboard and the frontmost app (by process)
  are unchanged, and puts the items back once the paste shows in the same
  focused element (held at least 0.3 s; else after a 1 s hold) and only if
  nothing else wrote to the clipboard meanwhile; a concealed item (on any of
  the clipboard's items) is not copied and the clipboard is cleared instead.
  When the ⌘V keystroke may not have completed, the clipboard is not put back
  (a late paste can only repeat the text) and ⌘ is released. Universal Clipboard content or more than 64 MB is refused
  unless `force: true`. The result reports what happened to the clipboard
  (`restored: true`, `cleared (previous_concealed)`, `false (changed_externally)`, …).
- `mac_clipboard_read` withholds the whole clipboard when any of its items is
  marked concealed (not only the first).
- `mac_key` treats an uppercase ASCII letter in a chord as adding `shift`
  (matching how `cliclick` types it, so `alt-cmd-Q` is recognized as
  `alt-cmd-shift-q` log-out) and ignores an `fn-` prefix when checking refused
  chords; `alt-cmd-q` (Quit and Close All Windows) and `alt-cmd-delete` (Finder
  Delete Immediately) are now refused unless `force: true`.
- `mac_menu_command` applies the same refused-chord list to menu shortcuts and
  refuses items under the Apple menu (Sleep, Lock Screen, Log Out, Restart,
  Shut Down, Force Quit) unless `force: true`; quitting the MCP host process or
  a macOS session process (Finder, Dock, loginwindow, …) is always refused.
- `mac_app` force-quit re-checks the target PID's start time before its
  `SIGKILL` fallback so a reused PID is never signalled, and walks up to 32
  ancestor processes when identifying the MCP host.
- CDP isolation and directory permissions: `browser_launch` with `cdp_port` is
  refused under `NORACU_READ_ONLY=1` even when `NORACU_ALLOW_CDP=1` is set
  (before any network access); `mac_app` launch with `cdp_port` canonicalizes
  `.app` paths (`realpath`, trailing slash stripped) before checking whether the
  app is running, creates `~/.noracu` and `~/.noracu/cdp-profiles` (plus
  `browser-profile`) with mode `0700`, and records `{ pid, wsUrl }` in memory so
  `browser_launch` with `NORACU_ALLOW_CDP=1` attaches only when the port was
  opened by this `noracu` process, its PID is still alive and `/json/version`'s
  `webSocketDebuggerUrl` matches (attaching to any other loopback port requires
  `NORACU_ALLOW_CDP=any`).

## [0.1.4] — 2026-11-05

### Fixed
- `phone_open` only taps an exact label inside Spotlight's Top Hit card. A web
  suggestion, website or Settings row with the same name could be tapped
  before: in testing, opening "Pinduoduo" opened a Chrome search and reported
  success. A name the Top Hit card does not show now returns app not found —
  use the label the phone shows under the icon (e.g. `拼多多`). The error says
  whether a Top Hit was seen at all. `phone_open` reads Spotlight's English
  "Top Hit" label; for an iPhone set to another language, set
  `NORACU_TOPHIT_LABELS` to the label it shows. When tapping the label
  does nothing, the icon is tapped only above where the label is now, not where
  it was a moment earlier. `phone_open` also keeps its own time budget and goes
  back to the Home Screen when it runs out, or when it is stopped or hits its
  time limit, instead of leaving Spotlight open, and says so when it could not
  get back.
- OCR reads Chinese. Vision ran English-first and returned almost no Chinese
  text, so Chinese app names, `phone_find` and `expect` checks failed; Chinese
  and English are now both read. `NORACU_OCR_LANGUAGES` sets other languages
  (unsupported codes are skipped).
- `phone_launch` never clicks through a setup or welcome screen. After a
  macOS 27 upgrade, iPhone Mirroring's welcome screen was reported as a paused
  session, `phone_launch` said to lock the iPhone, and a lone button there
  would have been clicked as if it were Resume. noracu now reports
  `mirror_setup_required` and leaves the screen to you, and `phone_status` adds
  a `setup` field. A paused mirror is still resumed in portrait or landscape.
- A stuck iPhone-layer subprocess can no longer freeze the server. iPhone
  commands, including the menu commands behind `phone_home` and
  `phone_app_switcher`, now run asynchronously under a time limit: on expiry
  the command and everything it started are stopped, the call returns
  `imctl_timeout` at once, and other requests — including `ping` — keep being
  answered. `phone_open` and `phone_type` get 45 seconds (was 30);
  `NORACU_PHONE_TIMEOUT_MS` sets another limit. A slow first check for the
  iPhone driver's Python no longer disables the iPhone layer until restart.
- Phone and Mac actions run one at a time, in the order they arrive, even when
  an MCP client sends tool calls in parallel, so taps, typing and the clipboard
  of two calls never interleave. A queued action the client cancels, or one that
  waited more than 60 seconds (`input_busy`), is dropped without acting, and the
  server stops its iPhone-layer processes when it exits.
- `phone_type` keeps watching up to 15 more seconds for a paste that lands late
  before reporting `type_not_confirmed`, and then says to read the screen before
  retrying: retrying after a late paste typed the text twice. The text must be
  seen in two consecutive screen reads.
- `phone_type` no longer reports `typed` while the iPhone is still fetching a
  slow paste: the "Pasting from …" box the phone shows meanwhile was taken for
  the text arriving. While that box shows, the paste does not count; the
  15-second check above then confirms it from the text itself, or the result is
  `type_not_confirmed`. The box is recognized on an iPhone set to English.
- A paste can reach the iPhone seconds after it was sent (from 1.5 s to more
  than 10 s on the test device). When `phone_open` does not see the name arrive,
  it keeps reading Spotlight for up to 15 seconds, and if the name never shows up
  it reports `open_not_confirmed` (retry) instead of app not found.
- `phone_open` right after another successful `phone_open` no longer fails. On
  iOS 27, going Home from an app that was opened from Spotlight lands back in
  Spotlight, and the Spotlight command then closed it, so the name was pasted
  onto the Home Screen.
- `phone_screenshot` deletes its temporary image on every path, including
  timeouts.

### Security
- `phone_type` no longer gives your clipboard back just because the typed text
  was already somewhere on the screen (for example a search-history entry with
  the same words). It now counts the text before pasting and restores your
  clipboard only when two screen reads afterwards both show it more often; until
  then the clipboard keeps the typed text. Before, a paste that the phone read
  late could have pasted your original clipboard contents instead.
- `phone_open` no longer gives your clipboard back after pasting the app name:
  the name can reach the iPhone seconds after it was sent, and a restore before
  then could paste your previous clipboard into Spotlight. The clipboard keeps
  the app name.
- `phone_type` never gives your clipboard back while the iPhone still shows its
  "Pasting from …" box: a paste is still on its way then and could fetch your
  restored clipboard. The words in that box never count as the typed text.

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

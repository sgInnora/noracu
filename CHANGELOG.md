# Changelog

## [0.3.1] — 2026-11-19

Fixes and stricter checks on top of 0.3.0; no tool was added or removed. The
ten that matter most:

- **A call whose text holds U+2028 or U+2029 is answered.** In 0.3.0 such a
  call never got an answer.
- **An app name that two running apps share is not resolved to one of them.**
  The answer is `ambiguous_app` with the pids; name the one you mean as
  `pid:<number>`.
- **The client's Stop reaches a call that is already running**, and
  `browser_type` stops when the stop file appears.
- **Keystrokes and pastes wait for the person at the Mac right before they go
  out**, not only when the call starts.
- **An `element_index` stays with its row.** A number that names an item is
  part of its identity, and two look-alike buttons in one list row stay tied to
  that row.
- **iPhone (XCUITest): nothing is sent while Control Center covers the app**,
  and input named for the Home Screen is not sent into an app that is still in
  front.
- **iPhone (Mirroring): no old picture of a minimized mirror.**
  `phone_screenshot`, `phone_ocr` and `phone_find` answer `capture_failed`
  instead.
- **`initialize` answers in the protocol revision the client asked for**
  (2024-11-05, 2025-06-18 or 2025-11-25).
- **`ax_empty` says when an app's windows are off screen** — on another Space,
  minimized or hidden — and what to do next. Windows on another Space still
  cannot be read.
- **Docs:** a short README that starts with `npx noracu --doctor`, a page of
  known issues, the apps noracu was run against, and an error reference that
  names every code.

Several results also claim less than before: `mac_scroll`, `browser_fill` and
`browser_scroll` report success only for what was seen, and `mac_wait` no
longer reports something gone while the app is not answering.

**Upgrading with the XCUITest backend:** the runner changed in this version.
`ios_*` answers `runner_version_mismatch` until the runner is built again with
`npx noracu ios-setup` (the same flags as the first time).

### Added
- **`noracu doctor`.** Run in a terminal, it prints the client configuration
  with the absolute paths of `node` and the server filled in (a GUI client does
  not inherit the shell's `PATH`), and says whether Node, cliclick and
  Playwright's Chromium are where the server will look; `--json` gives the same
  as JSON. It reads this machine only and sends nothing. `noracu --help` and
  `--version` exist too, and a server started by hand in a terminal says that
  it is waiting for a client. `noracu --doctor` is the same command. It exits 1
  when something the configured layers need is missing (Node 20; macOS for the
  Mac and iPhone layers; cliclick for the Mac layer) or a setting in the shell
  is one the server would refuse (`NORACU_LAYERS`) or
  replace (`NORACU_PHONE_BACKEND`) — such a setting is left out of the printed
  configuration, and a valid `NORACU_PHONE_BACKEND` goes into it. It ends with
  one line of versions and findings to paste into an issue, with no path or
  user name in it.
- `phone_type` and `phone_open`: a clipboard that could not be put back is
  reported on every path that ends the call — a capture or window error before
  ⌘V as well as a lost focus — and the report says which case it is: the
  clipboard may be empty (it was cleared, then refused the write), or it still
  holds the typed text (what it held could not be saved: another device's
  clipboard, or one too large).
- **`mac_ax_state` with `skeleton` (or a snapshot cut short by `depth` or
  `max_nodes`): an element of a row whose texts were not read is refused for
  actions.** Nothing in such a snapshot told the row's control from the same
  control of another row of the same shape that took its place, so an action
  could land on the other row. The answer is `element_no_longer_valid`
  (`row_unread`) and says to drill into the row with `root` or take a fuller
  snapshot. Reading the element (`mac_get`, `mac_wait`) and drilling into it
  work as before.
- **A key of the person's that is less than 2 s old is waited out once.** Mac
  and iPhone Mirroring input answered `user_active` at once when the keyboard or
  mouse had been used in the last `NORACU_USER_IDLE_S` seconds — often the
  Return that sent the request, so the first call of a quick client failed. The
  call now waits out the rest of that time, reads it again, and goes ahead when
  nothing more came from the person; when something did, it answers
  `user_active` as before, saying that it waited. Nothing is sent during the
  wait, and a stop file made during it still stops the input.
- **An approval file can let one app of the default deny list through.** An
  `allow` entry of `NORACU_APPROVAL_FILE` that names a terminal or IDE exactly —
  its bundle id or its name, without `*` or `?` — now lets that app receive
  input; before, the default deny list won and the only way out was dropping
  the whole list. A wildcard entry does not open it, the file's own `deny` wins,
  and so does every entry of `NORACU_DENY_APPS`. The refusal says how the
  person can let an app through.
- `mac_click` and the other `element_index` actions: a number is a reading that
  may change in place (a time span, a percentage, a count) only when nothing is
  glued to its front — no letter or digit, no currency sign, no 第 — and a
  one-letter unit has nothing glued after it. "$12m" → "$15m", "Order 104s-2" →
  "Order 105s-2" and "第3天" → "第4天" are other items now. And a snapshot that
  lists only some elements (`mac_find`, `interactive`) and left out a
  look-alike in the same row as a listed one no longer tells them apart by the
  texts of that row: the element is not looked for elsewhere when it moved.
- **cliclick on an Intel Mac.** Without `NORACU_CLICLICK` the server runs
  `/opt/homebrew/bin/cliclick` or, when that is not there, `/usr/local/bin/cliclick`
  — where Homebrew installs it on an Intel Mac. It looked only in the first.

### Security
- `ios_*` input (XCUITest backend) reads the lock again right before it goes
  out when its last "unlocked" answer is older than a second, and looks at the
  stop file again last — right before the command is written to the runner,
  after any connection it first had to open. The reads made just before an
  input (what the iPhone shows over the app, that lock read, a new connection)
  can take seconds after the first checks, and a stop file made or a lock in
  that time did not stop the input.
- `ios_launch` looks at the stop file again right before devicectl or simctl
  starts. Its gate can start the runner and read the lock, which takes seconds
  after the input queue looked at the stop file, and the launch — with
  `terminate_existing`, the stop of the running app too — went out after a stop
  file made in that time.
- `mac_app` launch with `cdp_port` records the DevTools port as the app's
  only when the process listening on it is the launched app (or one of its
  child processes) and `/json/version` names a websocket on that port. Any
  answer on the port was recorded, so a local process that took the port
  first could later be attached to as the app. Otherwise the result says the
  endpoint is not the app's own, with `cdp: null`.
- The default deny list names Tabby (`org.tabby`), Rio
  (`com.raphaelamorim.rio`) and Wave (`dev.commandline.waveterm`) by bundle
  id too. They were on it by name only, which a renamed or localized app name
  did not match.
- On the Mac, input to an app whose name cannot be read is refused while a
  rule that names apps by name is in force (the default deny list has some).
  Such an app was let through when its bundle id matched no rule, as if the
  rules that name apps had been checked. iPhone apps are matched on their
  bundle id, as before.
- `NORACU_APPROVAL_FILE`: a file that is not valid JSON is refused without
  quoting a piece of it (the parser's message, passed on to the agent, did),
  and a file over 64 KB is refused before it is read. Input stays refused
  (fail closed) in both cases, as before.
- `phone_*` ⌘ chords (paste, select all, the app switcher): the iPhone
  Mirroring window is checked to be in front again between ⌘ down and the
  key. If another app came forward in those 30 ms, ⌘ is released and the key
  is not sent — it would have been a ⌘ shortcut in that app.
- iOS runner (XCUITest backend; rebuild the runner after upgrading): when
  SpringBoard's frame could not be read, the runner found "no Home Screen
  icon, no system alert" against the empty frame, and `ios_type` / `ios_key`
  were let through without the alert check. Such a frame now counts as
  unreadable: input that needs the check is refused (`system_alert` /
  `app_not_foreground`), as when SpringBoard cannot be read at all.
- `imctl verify` (a command-line check of the iPhone driver, not a tool)
  wrote two screenshots of the phone to paths from `tempfile.mktemp`, and
  took them as a capture of the screen region under the mirror window. It
  now reads the window's own pixels and hashes them in memory.
- **An app name that two running apps share is no longer resolved to one of them.** `app` took the first
  match — the active one when there was one — so input, a menu command or Quit could go to another copy than
  the one meant. Every tool that takes `app` now answers `ambiguous_app`, lists the pids and which of them is
  frontmost, and does nothing; `app: "pid:<number>"` names one (`mac_apps` lists them). A helper process of
  the same name is not counted, nor one started from the same `.app` bundle. `mac_app` `activate` with
  `pid:<number>` brings that very process forward (`open -a` picked a copy itself), and `mac_windows` takes
  `app` the same way — a word that names no app exactly still filters the window owners' names.
- `phone_open`: the words "Top Hit" count as Spotlight's card header only in the top part of the screen. A
  line reading "Top Hit" further down — in a list or a page — was taken for the header, and the name under it
  for the app to tap.
- `phone_type` and `phone_open`: when the Mac's clipboard refuses to take back what it held before the paste,
  the result says so (it said the clipboard had been put back).
- **`phone_screenshot`, `phone_ocr` and `phone_find` do not return an old picture of a minimized mirror.**
  A capture by window id succeeds for a minimized iPhone Mirroring window — with the picture the window had
  when it went away (seen on a device: a full-size PNG, no error) — and these read-only tools passed it on as
  the phone's screen. A window that is not on screen (hidden, minimized or on another Space) now answers
  `capture_failed` and says so; the input tools already refused it.
- **`mac_click` and the other `element_index` actions: a number that names an item is part of its identity.**
  A unique element's item ignored every digit, so a row replaced in place by one that differed only in a
  number ("Invoice 12" → "Invoice 13") was taken for the same row, and its button was pressed. Now only a
  number that reads as a clock time or a duration, a percentage, a time span with its unit ("5 min ago"), an
  explicit count ("3 unread", "12 items") or a count against a fixed total ("12/280") may change in place;
  any other changed number answers `element_no_longer_valid` — take a new snapshot.
- **`ios_tap`, `ios_swipe` and `ios_type` named for the Home Screen are not sent into an app.**
  `com.apple.springboard` always reports itself in front, so after `ios_home` an input without a `bundle_id`
  went out even when another app had come forward since (a call, the person opening one) — and landed in that
  app. noracu now looks at SpringBoard first: with no Home Screen icon showing, only one tap on a button of a
  system alert is sent; anything else answers `app_not_foreground` and nothing goes out. Seen on a device: the
  Home Screen's pages, Today View and the App Library show icons; an app or Spotlight in front shows none.
  While the app the session last launched, acted on or read in front still reads as in front, the same rule
  holds without looking for icons — one can stay on screen for a moment after an app came forward, and Control
  Center over an app shows them too — also after a call that named the Home Screen in between. When that app's
  state cannot be read, nothing is sent.
- **`mac_menu_command`: Quit is refused for a protected app even when the
  menu item has no shortcut and no AppKit action.** Quit was recognised only by
  ⌘Q / ⌥⌘Q or its AppKit action, so a menu built another way let "Quit <App>"
  through for the MCP host and the session apps. The title counts now ("Quit",
  "Quit …", "Exit", "Exit <app>"), and an item directly in the application menu
  with neither a shortcut nor an identifier is refused for those apps.
- `noracu ios-setup`: a build that fails because this Mac's keychain is locked no longer says "unlock the
  iPhone".
- `noracu ios-setup --bundle-prefix`: a prefix that ends in a dot or has two dots in a row is refused
  before the build instead of producing a bundle identifier Xcode rejects.
- `noracu ios-setup`: when something else ends xcodebuild with a signal, the message says so instead of
  "could not be run — is Xcode installed?".
- `mac_windows` without Screen Recording permission: two windows of one app at the same position each get
  their own title (the second one was left untitled and the first got the second's).
- `mac_windows`: `titles_from_screen_recording` is true only when the window server gave a non-empty title
  for another process's window (this process's own windows and empty titles made it true).
- `mac_ax_state`: `depth` must be a whole number (a fraction such as 2.5 was accepted).
- `phone_*`: when the iPhone Mirroring driver is stopped for printing more than 10 MB, the error now says
  that the action may have partly run and to look before retrying, as the timeout error does.
- `phone_*`: when the python that was picked lacks a pyobjc module, the install command in the error names
  that python instead of `python3`, which may be a different one.
- **`phone_open` taps nothing when the app's row is gone at the re-read.** The row found in Spotlight's Top
  Hit card is read again half a second later; when that read did not show the name, the first position was
  tapped anyway — onto whatever had moved there — and another app that opened was reported as opened. One
  more read is made now, and without the name in the card nothing is tapped (`open_not_confirmed`). The
  same holds when the row moved between those two reads: the read after that must still show the name, or
  nothing is tapped.
- `phone_type`: the phone's "Pasting from …" box is recognised when its two words are read as two hits of
  one line in swapped order (it was missed then, and a paste still on its way could be taken as done).
- `phone_type`: the words of the "Pasting from …" box are left out of the count of the typed text also when
  the box was read as two hits (a Mac named "M5pro" made "pro" look typed).
- `phone_scroll`: the frontmost app is checked again after the short pause that follows the pointer move,
  before the first wheel event (the first check came after the fifth: an app that came to the front in that
  pause got the start of the scroll).
- `phone_type` with a text of two or three characters: a paste that was not confirmed is reported as
  `type_not_confirmed` at once. It used to be watched for 15 more seconds, and the same two or three letters
  showing up anywhere ("in" inside "Sign in") were reported as "the text showed up late".
- `phone_longpress`: a hold longer than a second looks at the frontmost app again every second; when another
  app has come to the front the button is let go at once and the call fails with `focus_lost`, instead of
  the button staying down for the rest of the hold (up to 10 s) under whatever is done next.
- `NORACU_TRACE`: a call that is refused before the tool runs — an unknown tool, a tool outside
  `NORACU_READ_ONLY`'s list, invalid arguments, a browser input tool while the stop file exists — gets its line
  too, with the code `unknown_tool`, `read_only`, `invalid_args` or `user_stopped` (such calls left no line).
  The name of an unknown tool is the caller's text and is not written: its line has `unknown(<length>)`.
- **A tool call whose text holds U+2028 or U+2029 is answered.** The server read its input with a line reader that
  also ends a line at those two characters, and JSON leaves them as they are inside a string: such a call (a
  `mac_type` or `browser_type` of text copied from a web page, say) was cut in two, answered with parse errors
  that carried no id, and never answered under its own — the client waited until its own timeout. A message
  now ends at a line feed only.
- `phone_open`: an app name with a line break, a tab or another control character is refused before anything
  is sent (the name is pasted into Spotlight as it is).
- `phone_key` and the clearing of a field before `phone_open` types: a key pressed by itself no longer picks
  up a modifier that is held on the Mac's keyboard at that moment (with ⌘ down, Delete went out as ⌘Delete).
- `mac_set_value` on a pop-up: when no option matches and the menu that was opened for it does not close
  again, the result says the menu may still be open (`delivery=unknown`) instead of "opened and closed again,
  retry is safe".
- **A list item's texts identify it however deep they sit.** The snapshot collected an item's texts only four
  levels below it, while the check before an action read them at any depth. A row whose texts were deeper
  (common in web content) had no item key, so a list that was re-sorted or recycled could send a stale
  `element_index` to another row's look-alike button; a row with texts on both sides of that line never
  matched again (`element_no_longer_valid` on an unchanged window). Both sides read the same texts now.
- **Two unlabelled look-alike buttons in one list row stay tied to their row.** Both read the same row
  texts, and a key that two look-alikes share was dropped as telling nothing apart — which left such
  buttons identified by their place alone, so a list recycled in place sent a stale `element_index` to the
  same button of another row. The key is kept now and must still match when the element is found at its
  old place; it is only never used to pick one look-alike over another.
- `mac_ax_state` with `skeleton: true`: an element of such an outline is no longer taken to be the only one
  of its kind (the outline stops three levels down and has not seen what lies below), so after it is gone
  its `element_index` does not move to a same-named control deeper in the window.
- A look-alike control that moved is followed by its row's texts only when the whole window could be read.
  When part of it did not answer, the one match that was read is accepted only where the element was (it
  was accepted anywhere, though the real one may sit in the part that was not read).
- `mac_ax_state` / `mac_find` with `surface: "app"`: an element inside a window that has no window ID is
  refused for `element_index` actions (`policy_denied`), as it already was when that window was read by
  itself, and the result carries `window_identity: "unverifiable"`. Such an element used to skip the check
  that it is still in the window it was seen in.
- `mac_menu_command`: a change in the focused element counts as the command's effect (`delivered_verified`)
  only when the keyboard and mouse were not used since the item was pressed. A selection the person moved in
  that moment was taken for the command's effect.
- **An element that had to be waited for is checked again before it is acted on.** A disabled control is
  waited for (up to 30 s); a list can re-use the same accessibility element for another row in that time, and
  the click, value or press then went to that row. After a wait the element is looked up once more and the
  action is refused (`element_no_longer_valid`) when it is no longer the one that was asked for.
- **The client's Stop reaches a call that is already running.** `notifications/cancelled` was honoured only for
  a call still waiting in the input queue. For a call whose tool had started it was ignored: a `browser_type` of
  a long text went on typing for up to 40 s after the client had given the call up, and the result was sent
  anyway. A cancelled call is no longer answered, and `browser_type` stops at the character it is on.
- **`browser_type` stops when the stop file appears.** `NORACU_STOP_FILE` was looked at before the call
  only; a long text went on being typed after the person had put the file there. It is looked at before
  each character now, and the result says how much had gone out.
- `browser_click`: when the click made the page navigate, the result says so and where the tab is now (as
  `browser_fill` and `browser_scroll` do) — the snapshot's `element_index` values are gone with the page.
- `browser_snapshot`: the clickable-elements list does not go into shadow roots or frames; it now says so
  when the page has any ("not listed: what is inside 1 shadow root(s)…"), instead of reading as a full list.
- **A physical click on a Finder desktop icon is refused while a window covers the icon.** The desktop is
  below every window; with one of Finder's own windows over the icon and an inconclusive hit test the click
  went ahead and landed on that window. Any window at the point now refuses it (`OCCLUDED`).
- `ios_launch`: a launch that timed out, or failed after `terminate_existing` may have stopped the app, ends
  the `element_index` values read before it, as a launch that worked does.
- **`ios_*` input is not sent while Control Center covers the app.** With
  Control Center pulled down, the app still reports that it is in front and
  reads as usual, but a tap went to Control Center — on one of its controls it
  would have switched it. Taps, swipes, keys and text now answer
  `system_overlay` and send nothing while the iPhone shows something of its
  own over the app. No runner rebuild is needed.
- **A session attached over a DevTools port (`NORACU_ALLOW_CDP`) never takes a
  DevTools window as its active page.** When the app's own pages were closed,
  or none was open at attach, the first page left could be a DevTools window;
  keys sent to it go into its console and run as script, which
  `browser_evaluate` needs `NORACU_ENABLE_EVAL` for. Such a window is not
  counted as a tab and is not read or acted on. The same holds for the DevTools
  front end that a DevTools port serves over http, in every kind of session:
  the browser tools do not navigate to it, nor to any address on a DevTools
  port this server opened or is attached to.
- **`browser_tabs` list does not return the title of a page the tools do not
  read.** A tab that went to such a page (a `blob:` page a site made, a local
  file a person opened in it) was listed with its title, which is page
  content, and its whole address. It is now listed with `not_read:true`, no
  title, and the first 60 characters of the address.

### Changed
- `mac_ax_state` with `window` as a title: when no window has exactly that
  title and one contains it (in any case), the answer reads that window, as
  before, and now says so — `window.title_match: "partial"`.
- The first `browser_launch` on a Mac without Playwright's Chromium no
  longer holds its answer for the whole download, which can take minutes —
  longer than a client waits. After 20 s it answers `browser_installing`
  while the download goes on; `browser_launch` again takes the browser once it
  is there, and reports a download that failed in the meantime.
- `mac_screenshot` says when Screen Recording looks not granted to the app
  that runs noracu (no other app's window title can be read):
  `screen_recording_note` in its meta says the image then holds the desktop
  picture and that app's own windows only, and where to turn the permission
  on. Once seen granted, it is not checked again.
- **The client's Stop reaches `mac_wait` and `phone_type`.** When the client
  cancels a call (`notifications/cancelled`, e.g. its Stop button), a running
  `mac_wait` ends its accessibility wait and a running `phone_type` ends imctl
  at once, as a timeout does: `phone_type` puts the clipboard back only if the
  paste had not gone out yet. Neither call is answered, as before. With
  `NORACU_TRACE`, a cancelled call is logged as an error with code
  `cancelled`, or `cancelled_queued` if it was still waiting in the input
  queue (such a call had no line before).
- A physical click refused because the element's window has no window ID no
  longer says to use "mechanism auto" — under `auto` a click is physical only
  when the element has no accessibility action, so that advice led back to the
  same refusal. It names `mechanism: "semantic"` for an element that has an
  action, and bringing the window forward otherwise.
- **`ax_empty` says when an app's windows are off screen.** An app whose windows
  are all on another Space (or minimized, or hidden) gave the same `ax_empty` as
  an app with no window at all. The answer now says how many of the app's windows
  the window server lists off screen, points to `mac_windows` with
  `include_offscreen: true`, and says that `mac_app` `activate` may move the
  person's desktop to that app; an app with no window open says so. Windows on
  another Space still cannot be read.
- `ios_launch`, `ios_home`, `ios_type` and input by `element_index`: a read made inside the call — whether the app
  came to the front or left it, the text fields around the typed text, the element read again before the input —
  no longer starts the runner when it has stopped meanwhile. A runner that starts puts its own app in front of the
  screen the call is about; the result now says what could not be read, and the next call that asks for the
  iPhone starts the runner.
- **`initialize` answers in the protocol revision the client asked for** —
  2024-11-05, 2025-06-18 or 2025-11-25 (it always answered 2024-11-05). A
  client that asks for 2025-03-26 gets 2024-11-05, because that revision
  requires a server to accept JSON-RPC batches and noracu does not; any other
  version gets 2025-11-25.
- **Keystrokes and pastes wait for the person at the Mac right before they go
  out, as clicks do.** `mac_key`, the keystrokes of `mac_type`, `mac_paste` and
  the wheel event of `mac_scroll` on an element had only the check made when the
  call left the queue. When `mac_type` clicks first and the person takes over
  before the keystrokes, the result says that the click went out
  (`delivery=unknown, retry=unsafe`).
- **`browser_fill` requires `value`.** A call without it (the text passed under
  another name, say) used to empty the field and report `delivered_verified`.
  An empty string still clears the field when it is given.
- **The README is short now.** What it does, the quickstart, how it behaves, what it does not protect against,
  non-goals and links. Troubleshooting moved to `docs/troubleshooting.md`, the iPhone setup, requirements and
  known limits to `docs/iphone.md`, the list of defaults and switches to `SECURITY.md`; the environment
  variables were already in `docs/usage.md`. The Chinese README follows the same outline.
- **The Chinese README is at `docs/README.zh-CN.md`.** npm takes a package's
  page from a README file in the package folder and showed the Chinese one for
  0.3.0; the folder now holds `README.md` only, and the pack check enforces it.
- **Bug reports no longer need a clone.** The issue form asks for the tool and
  the text it returned; `npm test` output is optional, and there is a short
  form for an app or site that noracu handles badly.

### Fixed
- With the Dock set to hide and show automatically, a Dock that has popped up
  now counts as covering what is under it, so a physical click there is
  refused (`occluded`) instead of landing on a Dock icon. macOS keeps no strip
  for such a Dock; noracu now reads where its tiles are drawn.
- The `system_overlay` refusal (XCUITest backend) no longer says that what
  covers the app is Control Center, which it cannot tell; it says to look again
  in a moment, and that `ios_home` would leave the app for the Home Screen.
- `mac_type` with `element_index` and an `app` name that two running copies
  share types into the element when its process is one of them. It answered
  `ambiguous_app`, although the index already names the process.
- `mac_wait` `app_running` / `app_gone` with an app name that several running
  copies share: the app counts as running, so `app_gone` waits until none is
  left. Both answered `ambiguous_app`.
- `mac_notifications` finds the menu-bar clock (which opens Notification
  Center's history) by its accessibility identifier, or an item named exactly
  "Clock". Any menu-bar extra whose name contained "clock", such as a timer,
  could be taken for it.
- `mac_window` raise says `delivered_verified` only when the window became its
  app's main window and is not minimized. Any change to the window counted,
  so a raise that only took the window out of the Dock was reported as
  verified.
- A window whose attributes the app did not answer for is never the window a
  Mac snapshot picks by default (it read as an untitled window that was not
  minimized), and window lists in errors mark it `unreadable`.
- An input tool that fails in a way noracu did not plan for (an exception)
  answers `internal_error: … (delivery=unknown, retry=unsafe)`. It answered
  the bare exception text, with nothing about what had been sent.
- `mac_scroll` on an element looks once more, right before the wheel event,
  at what is on top at the element's point, as a click does. A window that
  came up there since the hit test is no longer scrolled (`occluded`, nothing
  sent).
- A physical click or drag made while the pointer's position could not be
  read went out and left the pointer where the click put it, without saying
  so. The result now says the pointer was not put back.
- A `phone_*` input whose driver could not import its modules (pyobjc
  missing) sent nothing; it no longer counts as noracu's own input of that
  moment, so the person's keyboard or mouse use then still makes the next
  input wait for them first (`user_active` if they go on).
- `mac_type` with `element_index` and an `app` the element does not belong to
  is refused before anything is written. The check ran only before physical
  keystrokes; through accessibility (the default) the text went into the
  element whatever app was named.
- `mac_set_value` on a pop-up menu: when the press on the option did not
  answer and the control already showed that option before, the result was
  `delivered_verified`. It is now `delivered_unverified`, with a note.
- `mac_ax_state` / `mac_find`: `web_accessibility: "unsupported"` (the window
  holds no web content the app exposes) is said only after the whole window
  was looked through. A window too large to look through in time answers
  `"unknown"`, with the same hint.
- XCUITest backend: stopping a runner whose `xcodebuild` had already exited
  no longer signals its process group (TERM, then KILL 3 s later). By then
  that pid could belong to another process.
- XCUITest backend: a call to the runner that was in flight when the
  connection was closed (the runner stopped, the server shutting down) is
  answered at once; it waited for its own timeout, up to 30 s.
- XCUITest backend: the size limit on the runner's answers held only for an
  answer still waiting for its newline; a whole line over the limit was read.
  Both now end the connection (`runner_protocol`).
- `mac_ax_state` with `surface: dialog` or `alert`, for an app with several
  windows and none focused: a dialog that is a window of its own is read when
  it is the only one, instead of answering `ambiguous_window` before looking.
- `mac_ax_state` and the tools that pick a window: an app whose window list
  did not answer (busy or hung) is reported as `app_unresponsive`. It was
  reported as having no window open, or its windows being minimized or on
  another Space.
- `ios_home` looks at `NORACU_STOP_FILE` again right before the press: the
  read of the app's state before it can take up to 10 s after the input
  queue's own check, and a stop file made meanwhile did not stop the press.
- `noracu ios-setup` with `NORACU_IOS_RUNNER_DIR` set to a folder that is
  already there no longer changes that folder's mode to `0700`; the device
  folder it makes inside is still private.
- `mac_app` `unhide`: when the app's hidden state could not be read
  afterwards, it was taken for "not hidden" and the call reported
  `delivered_verified`. An unread state now gives `delivered_unverified`
  (and `hidden: null`); `hide` likewise.
- `phone_find` prefers a label that reads exactly the text: "X" finds the app
  X, not the "Xcode" listed above it. A label that only contains the text
  still stands in when none reads it exactly.
- `phone_type` with `replace: true` that a clipboard change stopped before
  the paste said "nothing was typed"; it now adds that ⌘A had already
  selected the field's text.
- `phone_open`: when Spotlight could not be opened, the answer is
  `spotlight_unavailable: …`, which says the steps before it may have gone
  out. It was an uncoded line that a warning from the driver could hide.
- `phone_open`: a capture that failed partway through answered only "could
  not capture the iPhone Mirroring window". It now says the steps before it
  may have gone out and Spotlight may still be open, and to look before
  retrying.
- `phone_*` input: when iPhone Mirroring quit while noracu brought it forward,
  the answer said its state was unknown (`mirror_state_unknown`); it now says
  it is not running, as when it was not running to begin with. Nothing is sent
  either way.
- `phone_swipe` / `phone_scroll`: "a swipe moved clear of the window's margin
  and left shorter than about 10 pt is a press, not sent" is measured in the
  mirror window's own size; it assumed the 280 × 620 pt window it was first
  measured on.
- `phone_type` of a single character: a sighting in the banner strip at the
  top of the screen, where a notification can carry the character, no longer
  confirms it, as it already did not for a longer text.
- iOS runner: a listener still waiting for the network (the device tunnel
  coming up) is waited for, instead of ending the start at once with
  `bind_failed`; when it never comes up, `bind_failed` names every state it
  went through. A listener that goes away after the runner is up ends the
  runner (`listener_failed`) instead of leaving it running for 12 hours with
  nothing listening.
- iOS runner (XCUITest backend; rebuild the runner after upgrading — `noracu
  ios-setup`): a bind address that parses but is not one the runner listens on
  (`0.0.0.0`, `::`, a Wi-Fi address) is reported as `bad_bind`; it was
  `bad_port`.
- `phone_*`: an x or y of 1.0 is the mirror window's last point, not the
  first point past its edge.
- `phone_open`: when OCR misread a letter of the app's name in Spotlight's
  search field, Spotlight was taken for gone after the tap, and the app could
  be reported as opened while Spotlight still showed. The field is now matched
  as its echo is (a letter off still counts from 6 characters, two from 14).
- `mac_ax_state` with `root` and any of `app`, `window`, `window_id` or
  `surface` is refused. A `root` is an element of an earlier snapshot and
  names its app and window; the others were not looked at.
- `mac_window` with a `window_id` and an `app` that does not own that window
  is refused (`invalid_args`, nothing done). Before, the `window_id` won and
  the `app` was not looked at.
- `phone_*`: when iPhone Mirroring lists another of its standard windows (a
  near-square one, such as a settings or welcome window) ahead of the phone's,
  reading the window's position, checking for an overlay and clicking Resume
  use the window shaped like a phone. Before, they used the first one listed.
- `phone_*` input: while the pointer rests on the mirror window's top edge, an
  empty group in the window is no longer taken for the window's toolbar. It
  may be an overlay that has not drawn its content yet, so the mirror does not
  read as live and nothing is sent (`mirror_not_live`).
- A `tools/call` under a request id that another call is still using is refused with a JSON-RPC error. It took
  over the first call's entry, so a cancellation meant for one could stop the other. The refusal comes before
  anything else is answered for that call — a tool this server does not have, arguments that do not validate,
  the stop file — so no tool result goes out under the id before the first call's.
- A request of more than about 4 million characters on one line is dropped unread and answered with an error
  (`request too large`); before, the server kept whatever a client sent without a line end.
- `phone_open` and `phone_type` report `delivered_verified` only for the driver's own confirmed result
  ("opened '<app>'", "typed <n> chars"). Any other line the driver ends successfully with was verified unless
  it matched a list of known "not confirmed" wordings; it is `delivered_unverified` now.
- `mac_click` with both `element_index` and `x`,`y`, and `browser_click` with more than one of `element_index`,
  `selector` and `xy`, are refused (`invalid_args`): one was used and the other dropped without a word. A
  `snapshot_id` given to `mac_click`, `mac_scroll` or `mac_type` without an `element_index` is refused as well —
  it was ignored.
- `browser_navigate`: when the server answers with an error status (404, 500 …) the result says that an error
  page loaded, next to the status code. The navigation itself is still reported as delivered.
- **`mac_wait` no longer reports something gone while the app is not
  answering.** An app that did not answer in time read as having no windows, no
  sheet, no open menu and no text, so `window_gone`, `sheet_gone`, `menu_closed`
  and `text_gone` were met at once. The wait now goes on until the app can be
  read. `value_equals` and `value_contains` are no longer met by an element
  that has no value.
- **`mac_ax_state` of a window that closed as the snapshot started is an
  error** (`element_no_longer_valid`), not an empty tree marked complete.
- **`mac_scroll` says an element was scrolled into view only when it is.** The
  accessibility action returning success was reported as "scrolled into view"
  without looking; what can be seen of the element (cut by its window and by
  scroll areas above it) is now read afterwards.
- **After `mac_scroll` on an element, the next input is not refused as
  `user_active`.** The wheel event was not recorded as noracu's own.
- **`mac_scroll` reports `delivery=not_delivered, retry=safe` when the wheel
  script could not be started** (it said `unknown`). A script that did start
  and failed is still `unknown`.
- **`browser_fill` does not report `delivered_verified` from a page it did not
  fill.** When the fill made the page navigate, the value read back could be
  that of a field on the next page. The result now says that the page navigated
  and is `delivered_unverified`.
- **`browser_type` stops when its time runs out.** Typing that outlasted its
  time (a page answering each key slowly) returned an error while the rest of
  the text kept arriving, into whatever had the focus by then. The remaining
  characters are no longer sent, and the error says how many went out. Typing
  also stops when the tab turns into a page noracu does not act on.
- **`browser_scroll` reports `delivered_verified` only when the page moved the
  way that was asked.** Any change of the scroll position counted — also one
  the other way, or the jump to the top that a navigation brings.
- **A physical click on a menu item is not sent when its menu closed in
  between.** For an element with no window of its own, the check made right
  before the click only looked at which app owned the window on top, so the
  click could land on the app's own window under the menu, or on the desktop.
  The window on top must now be the one it was at the hit test. Physical clicks
  on menu bar items, which were always refused as covered, go out.
- **`ios_type` with `element_index` takes a text field only.** Given the index
  of a button or a row it pressed that element and then typed into whatever
  held the keyboard. It now answers `not_a_text_field` and sends nothing.
- **Releasing a stuck modifier no longer clears the modifiers the person is
  holding.** The extra release after a key chord went to every modifier of the
  chord with all flags cleared; it now goes only to a modifier that is still
  set and keeps the other flags.
- **A press that did nothing is not `delivered_verified` because another
  window's title changed.** For an action on an element, the app's window list
  counts as evidence only when a window opened, closed or changed kind, or when
  the element's own window's title changed.
- **An app that stops answering before an action is reported as
  `app_unresponsive`**, not as a vanished element; an app that has exited is
  still a vanished element.
- **`mac_paste` without the Accessibility permission returns the permission
  error** before the clipboard is touched, instead of `delivered_unverified`.
- **`browser_snapshot` lists controls nested deeper than 20 elements.** The walk
  behind the clickable-element list stopped 20 levels under `<body>` without
  saying so; it now goes 64 deep and says when a page is deeper than that.
- **iPhone (XCUITest): a refusal for a system prompt says how to see it.**
  When input is not sent because a system prompt is up (`system_alert`), the
  message now also says to look at it with `ios_screenshot`, so the client can
  tell the person what the prompt asks before they answer it on the phone.

### Docs
- Tool descriptions: `browser_click` takes exactly one of `element_index`,
  `selector` or `xy`; an `app` argument takes `pid:<n>` too, and
  `ambiguous_app` says to pick one that way (the server's instructions and
  `mac_ax_state`); `snapshot_id` goes only with `element_index`; `root` goes
  alone. The `mac_click`, `browser_tabs` and `mac_ax_state` descriptions are
  shorter; the tools work as before.
- The Screen Recording permission is called **Screen & System Audio
  Recording** on macOS 15 and later (录屏与系统录音 in Chinese); the README,
  its Chinese version, usage and troubleshooting say so. A screenshot taken
  without it shows the desktop picture without other apps' windows, or comes
  back black; the docs said only black.

- `docs/iphone.md` names the paste prompt iOS shows when an app reads the
  clipboard: while it is up, `ios_*` input answers `system_alert`.
- README: the quickstart starts with `npx noracu --doctor`, lists three
  read-only things to try and links the issue forms; the first picture's caption
  and the Browser row say what working in your own Chrome needs; it says that
  noracu is device-tested only on Apple silicon Macs running macOS 27.
  `docs/README.zh-CN.md` follows.
- **`docs/known-issues.md`** (new): where noracu was tested and where not (one
  Apple silicon Mac on macOS 27.2; no Intel Mac, no macOS 15 or 26), limits such
  as windows on another Space, what is known and not fixed in this version, and
  what was changed without a new run on a real machine.
- **`docs/apps.md`** (new): the apps noracu was run against, each with what was
  exercised and the record of it, and how to report one more app with the issue
  form — no clone needed. `CONTRIBUTING.md` starts with the same.
- `docs/iphone.md`: a Live Activity in the Dynamic Island was checked — it does
  not get input refused.
- `server.json` declares eight of the environment variables (observation-only
  mode, the layers, the stop and approval files, the deny list, the idle wait,
  the two opt-in switches), so a registry page can show them.
- **The error reference names every code.** `docs/usage.md` listed about half of
  the codes an answer can open with; `ambiguous_app`, `user_active`,
  `eval_disabled`, the `browser_tabs` and DevTools-port refusals, the approval
  and stop-file errors and the XCUITest runner's codes were not in it. They are
  now, each with what it means and what to do next, and a test
  (`test/docs-codes-unit.mjs`, part of `npm test`) fails when the source can
  answer a code the reference does not name.
- `docs/usage.md`: the environment table has rows for `NORACU_ENABLE_EVAL`,
  `NORACU_PHONE_BACKEND`, `NORACU_IOS_UDID` and `NORACU_IOS_RUNNER_DIR`.
- `docs/architecture.md` no longer names an old Playwright version, counts the
  21 tools of observation-only mode (it said 18, without the `ios_*` ones) and
  says that `browser_tabs` selects tabs (it said there was no tab switching).

## [0.3.0] — 2026-11-15

Background input, a stop switch and per-app input rules, and clicks by
screenshot pixels.

### Added
- **Background input (bgpost).** Under `mechanism: "auto"`, a physical click
  on a native app, and a named key for a native frontmost app, are posted
  straight to the app's process (`CGEventPostToPid`): the pointer does not
  move and the app need not be in front. Web-engine apps (Chromium/Electron,
  whose event loops drop such events) and `mechanism: "physical"` use the
  real pointer; every result's `route` says which path delivered. A posted
  click is never re-sent another way: no visible change is reported as
  `delivered_unverified` with a note, a timeout as `delivery=unknown`. Double
  and triple clicks carry their click count. `NORACU_NO_BGPOST=1` turns the
  layer off.
- **Your own Chrome (opt-in).** `browser_launch` with `chrome: true` works
  in the Chrome you use, with its sign-ins, through Chrome's own
  remote-debugging switch (`chrome://inspect/#remote-debugging`, Chrome
  144+); Chrome asks you to allow each connection. It needs
  `NORACU_ALLOW_CHROME=1`. noracu opens a window of its own there, in the
  background, and lists, reads and acts only on the tabs it opened (and
  tabs those open); `browser_tabs` `new` opens a tab in that window. Your
  other tabs are never touched unless `NORACU_CHROME_TABS=all` is also
  set: then your tabs on http(s) pages are listed and can be selected, read
  and acted on (never `file://`, whatever `NORACU_ALLOW_FILE_URL` says; never
  closed or sent to another kind of address; one becomes the active page only
  when selected and stops being it when it leaves http(s)). `browser_evaluate` never runs there. `browser_close` closes
  noracu's tabs and disconnects. `NORACU_CHROME_DIR` points at another
  profile folder (Chrome Beta, Canary, another Chromium-based browser). `mac_status`
  reports whether it is allowed.
- **Stop switch.** While the file named by `NORACU_STOP_FILE` exists, every
  input tool — Mac and iPhone (semantic actions included) and the browser's
  input tools (navigate, click, type, fill, press_key, scroll, evaluate,
  `browser_tabs` new/close) — returns `user_stopped` and sends nothing. It is
  checked when a call leaves the input queue and again right before events go
  out. A set but blank `NORACU_STOP_FILE` refuses all input, and a set but blank
  `NORACU_APPROVAL_FILE` all Mac and iPhone input, until it is removed or given a path.
- **Per-app input rules.** `NORACU_DENY_APPS` names apps that never get
  input; by default the common terminal apps (Terminal, iTerm2, WezTerm,
  Ghostty, Warp, Alacritty, kitty, Hyper) and the IDEs with a built-in
  terminal (VS Code, Cursor, Windsurf, Zed, JetBrains IDEs, Android Studio,
  with their preview and nightly editions), by bundle id and by name, so an
  agent cannot type into those shells. A list of your own adds to it; a list
  that starts with `none` drops it (`none` alone: no deny list). Warp Preview,
  Tabby, Rio and Wave are on it too. The name `Code`
  and `com.jetbrains.*` are broad on purpose: they also deny any app named
  exactly Code, and JetBrains Toolbox. `NORACU_APPROVAL_FILE` (opt-in) names a `0600`
  JSON file `{allow, ask, deny}` of bundle-id or app-name patterns: an app
  under `ask`, or not listed, gets `approval_required` and nothing is sent;
  noracu never writes the file; once the variable is set, a missing,
  malformed, symlinked, group-readable or foreign-owned file, an unknown key
  or an empty pattern refuses all input. An app whose bundle id cannot be
  read gets nothing while either rule is in force. Both are judged
  on the app that receives the input — the element's app, both ends of a
  drag, the named app, or the app on top at an x,y point — and an app that
  cannot be identified gets nothing.
- **Clicks by screenshot pixels.** A `mac_screenshot` of one window returns a
  `screenshot_id` (valid 30 s); `mac_click` takes `screenshot_id` + `x,y` in
  that image's pixels for targets accessibility cannot name (canvas, custom
  drawing). The point is the window's origin plus the pixels at the scale of
  the window's own display; the window's position and size are re-checked
  first, and a window that moved, resized or was rebuilt is refused as
  `stale`; pixels outside the image are refused.
- **iPhone: an XCUITest backend (experimental, opt-in).** With
  `NORACU_PHONE_BACKEND=xcuitest` the `phone_*` tools are replaced by nine
  `ios_*` tools that drive the phone itself instead of the iPhone Mirroring
  window: a small UI-test bundle (the "runner", source in `ios-runner/`,
  protocol in `docs/ios-runner-protocol.md`) runs on the iPhone and executes
  one command at a time. `ios_snapshot` returns an app's accessibility
  elements with an `element_index` (unique across snapshots, valid 30 s);
  `ios_tap` and `ios_type` read the app again before acting and return
  `element_no_longer_valid` when the element moved, changed, or its app left
  the front; `ios_home` and `ios_launch` end earlier indexes. `ios_type`
  types as keyboard input — no clipboard — and is `delivered_verified` only
  when the field that took the text (the one tapped, or the only one of its
  kind whose value changed) afterwards holds its old value with the text put
  in at one place, for text of four characters or more (`type_not_confirmed`
  when the fields were read and do not show that; `delivered_unverified`
  when the two reads cannot settle it: the fields could not be read, are not
  the same ones in both reads, several changed at once and one of those
  gained the text, or no field changed and an empty one has the text as
  its placeholder); `ios_launch` opens an app by bundle id through
  `devicectl`.
  Coordinates are screen points. Every input first passes the stop file, the
  per-app rules (matched on the iOS bundle id) and a lock check: a locked
  iPhone, or one whose lock state cannot be read, gets nothing — and is not
  read either (no snapshot, no screenshot); the lock is read again before
  any command sent to the runner more than a second after the last
  unlocked answer. While an approval file or a `NORACU_DENY_APPS` of your
  own is set, no input that names `com.apple.springboard` is sent — not
  even one tap on a button of a system prompt; it is `input_denied`: sent
  by screen coordinates it would land on whichever app is in front, a tap
  on a Home Screen icon would open an app the rules were not asked about
  (apps are opened with `ios_launch`; `ios_home` still goes out), and text
  goes wherever the keyboard focus is. The refusal comes before a runner is
  started, so it changes nothing on the phone. An input the
  runner does not answer in time ends the runner, so the gesture cannot go
  out later; a failure XCTest records during a gesture is reported as
  `xctest_issue`, never as sent, and ends the runner too. The runner
  listens only on the device's own CoreDevice tunnel address (`127.0.0.1` on
  a simulator), accepts only its peer on that tunnel, and requires a token
  made new at every start. Needs Xcode, a developer team, a paired iPhone
  with Developer Mode (cable or local network) or a booted simulator, and one
  build per device: `npx noracu ios-setup --team <TeamID>` — an explicit
  command, never run on install. The iPhone must stay unlocked. The Mirroring
  backend remains the default and is unchanged. Under `NORACU_READ_ONLY=1` the
  backend answers `ios_status` only and never starts the runner: `ios_snapshot`
  and `ios_screenshot` return `runner_not_started`. `noracu ios-setup` stops a
  build that has not finished in 15 minutes and says so. A runner that was
  stopped is given up to 4 seconds to exit before the next one starts —
  while it is still there, every call says so instead of starting a second
  one — and `devicectl` calls still running end with the server. The runner
  names the sources it was built from when it starts, and one built from
  other sources than the installed noracu's — an older build left on the
  phone — is not used: `runner_version_mismatch`, run `ios-setup` again
  (the start is tried once more first: the first start after a rebuild was
  seen running the previous build).
- **`mac_drag` timing:** `hold_ms` (0–2000) holds after mouse-down before the
  move; `step_ms` (1–500) moves in steps of about 20 points. A drag whose
  waits add up to more than 10 s is refused, and a drag that fails midway
  sends a mouse-up so the button is not left held.
- **`permission_pending`:** when the Accessibility grant is missing,
  `mac_status` returns a structured object to poll, naming the settings pane.
- **`NORACU_LAYERS`:** a comma-separated list of `mac`, `browser`, `iphone`
  narrows what a server offers: a tool of a layer that is left out is
  neither listed nor callable, and the `initialize` instructions name only
  the listed tools — for instance `NORACU_LAYERS=iphone` for a client entry
  that carries the iPhone tools only. Unset or blank lists the Mac and
  browser layers (see Changed). A name that is not one of the three stops
  the server at start (exit code 2) instead of falling back. A call to a
  tool of a layer that is off says which layer and how to turn it on.
- **iPhone Mirroring: reading confidence.** `phone_open`'s result line names
  the confidence (0–1) the recognizer gave the label it tapped; `phone_ocr`
  and `phone_find` end each line with it, as before, and now say so.
  Opt-in, off by default: with `NORACU_OCR_MIN_CONFIDENCE` set to a number
  above 0 and at most 1, `phone_open` does not tap a label read below it and
  answers `open_not_confirmed` with nothing tapped; a value that is set and
  is not such a number makes `phone_open` refuse (`invalid_args`) rather
  than run without the check. While it is unset, what
  is tapped does not change.
- **`browser_tabs`.** One tool for the tabs of the browser session: `list`
  (the default), `new` (optionally with a url), `select` and `close`, by a
  `tab_id` that stays the same while the tab lives. The active page changes
  only when asked: a tab the page itself opens is listed and not followed.
  `select` takes only a tab on an http(s) page, or one still on the blank
  page that `browser_launch` or `browser_tabs` opened it on (`file://` with
  `NORACU_ALLOW_FILE_URL=1`; `tab_not_selectable` otherwise): a tab someone
  opened on a local file or a browser page, a blank tab that a page opened
  (it can read that page), and a tab that shows a blank page after it has
  loaded something, are listed (url and title), not read.
  `close` only closes a tab `browser_tabs` opened (`tab_not_owned`
  otherwise) and never the last open tab. A tab whose page does not answer
  is listed with `title: null`. Not available under `NORACU_READ_ONLY=1`.

### Changed
- **Breaking:** the experimental iPhone layer is off by default. With
  `NORACU_LAYERS` unset the server lists the Mac and browser tools only;
  `NORACU_LAYERS=mac,browser,iphone` gives the 0.2.7 set (and is needed for
  the `ios_*` tools of `NORACU_PHONE_BACKEND=xcuitest`). A server started
  with `NORACU_PHONE_BACKEND` but without the iPhone layer says so on
  stderr.
- **Breaking:** `browser_evaluate` is off by default. It runs any script in
  the page, so it returns `eval_disabled` and runs nothing unless the server
  was started with `NORACU_ENABLE_EVAL=1`. `NORACU_DISABLE_EVAL=1` still
  turns it off and wins over `NORACU_ENABLE_EVAL`. The tool stays listed;
  `mac_status` reports whether it is on.
- Terminal apps and IDEs with a built-in terminal get no input by default
  (see `NORACU_DENY_APPS` above); set `NORACU_DENY_APPS=none` for the 0.2.7
  behaviour.
- `mechanism: "physical"` on `mac_click` always uses the real pointer.
- `mac_status` reports `bgpost`, `stop_file`, `approval_file` and
  `deny_apps`.
- `phone_tap` and `phone_longpress` refuse a point on the iPhone Mirroring
  window's transparent margin — the strip above the phone screen, which
  holds the window's own controls, and the thin edge around it — with
  `out_of_screen`; nothing is sent. While the screen's edges are not known
  (see Fixed), a point where the margin may be — near the top of the window
  or along its other sides — is refused as well, and a tap that goes out
  says the edges were not known. When nothing is remembered and the window's
  image cannot be read, or the window is gone by the time its edges are
  looked up, a tap or long press is refused with `capture_failed`, as a
  swipe is.
- The note that a server process is older than the files on disk now looks
  at every source file in `src/` — it used to look at `server.mjs` and
  `mac-ax.js` only — and names the files that changed. A file put back to
  its earlier content does not count.

### Fixed

- **Deep code audit, 2026-11-14.**
  - The stop file, a cancelled request and a server shutdown are checked
    again right before an input runs: after the read of the time since the
    last keyboard or mouse event, and after waiting for an earlier phone
    command to end. A stop file made, or a cancel sent, during those seconds
    now stops the input; before, it went out.
  - `mac_click` with `count` 2 or 3 through cliclick sends one double or
    triple click (cliclick `dc:` / `tc:`); before, it sent separate single
    clicks, which apps do not take for a double click.
  - `mac_screenshot` with `display` uses that display's own scale for
    `scale` and `logical_size`; before, it used the main display's, which
    is wrong next to a screen of another scale.
  - `mac_app` launch with `cdp_port` asks the app rules first: an app the
    deny list or the approval file rules out (Cursor is on the default list)
    is not launched with a DevTools port, because the browser tools that
    would drive it are not judged by app rules. An app that is not running is
    named by its bundle on disk.
  - Semantic actions: an element that cannot be read after the action (the
    app did not answer in time) no longer counts as gone, so it is not
    reported `delivered_verified`; only an element that is really gone
    is evidence.
  - `mac_set_value` on a checkbox, radio button or switch waits up to 1 s for
    the control to show a new state before deciding on a second press (and
    again after a second press, for a mixed checkbox); a
    control that showed its new state late was pressed twice, which undid
    the first press. One that never changes is reported `NOT_CONFIRMED` and
    not pressed again.
  - Typing into a secure (password) field that takes text only by rewriting
    its whole value is refused unless the field is known to be empty;
    before, what was already typed there was replaced by the new text.
  - App rules match the bundle id and app name without surrounding spaces,
    as the check before them reads them; a FIFO named by
    `NORACU_APPROVAL_FILE` is refused at once (not a regular file) instead
    of blocking the server until something writes to it.
  - Browser: when a persistent profile opens but no page can be made in it,
    noracu closes it again, so the profile lock does not stay held.
  - `phone_open` after a timeout: the Home Screen tidy-up is skipped while
    the stop file exists, and the result says the Home Screen command was
    sent; it no longer says the phone was returned to the Home Screen, which
    was not checked.
  - When a result's first text block is JSON (a screenshot's metadata,
    `mac_status`), the note that the server is older than its files on disk
    now comes in a text block of its own after it; before, it was put in
    front of the JSON, which then no longer parsed.
- **Formal pre-release review, 2026-11-13.**
  - iPhone, XCUITest backend: no input goes to an app while a system alert (a
    permission prompt) is up, or while SpringBoard cannot be read
    (`system_alert`, nothing sent); the runner listens only on loopback or the
    CoreDevice tunnel's unique-local address; `ios_home` says the app left the
    front only when it was read in front before the press and in the background
    after it; input never starts a runner, and a runner that had to start
    during a call refuses that call's input (`runner_restarted`); an app's state
    on a locked phone is not taken as an answer; secure text fields are
    reported as `secureTextField`.
  - The person at the Mac goes first: only keyboard and mouse events noracu
    posts through the HID system count as its own, so an AXPress, a set_value
    or a background post no longer hides a key the person pressed meanwhile.
  - App rules: a pid that was not read is refused instead of judging the
    frontmost app; an app with no name, or with no bundle id while a rule is in
    force, gets nothing; `mac_click` with `screenshot_id` and `app` needs the
    screenshot's window to be that app's, and the window is read again right
    before the click (`stale` if it moved).
  - Background posting refuses a missing, fractional or out-of-range pid, key
    or point instead of turning it into 0; a posted click carries no modifier
    someone holds; Safari, Firefox and Arc take the real pointer.
  - Browser: `browser_tabs` new reports the tab's real address, and says
    `delivered_unverified` (a blank tab may be left) or `active_page_not_allowed`
    instead of verified when it did not see it; closing in your Chrome waits for
    the disconnect and counts only tabs noracu's close reached; a session with
    no tab left answers `no_active_page` with what to do.
- **Second review and the device run of 2026-11-14** (iPhone 16 Pro, iOS 27.2.1).
  - iPhone, XCUITest backend: taps, long presses and drags go out without
    XCTest's wait for the app to go idle — with a context menu up (a
    long-pressed note in Notes), a tap went out in about a second instead of
    timing out unsent after 20 s; a runner that ends while the iPhone turns on
    UI automation (seen right after an iOS update) says to unlock the iPhone and
    check Settings › Developer › Enable UI Automation; an input whose runner
    went away after the element was read answers `runner_unreachable`.
  - `noracu ios-setup` removes a build made for another `--bundle-prefix`
    before building, and fails instead of reporting "Built" when the build
    still names a runner under another prefix; when no runner bundle id can
    be read back from the build, "Built" comes with a line saying the prefix
    was not checked.
  - `system_alert` says a system prompt is up on the iPhone only when the
    runner saw one; when SpringBoard could not be read, the answer says
    noracu could not tell, and still sends nothing.
  - iPhone Mirroring: a swipe whose end was moved off the mirror window's
    margin and that is left shorter than about 10 pt is refused
    (`out_of_screen`) instead of landing as a tap; a phone input that imctl
    refused before sending anything no longer counts as noracu's own keyboard
    or mouse event, so the person's input of that moment is not taken for it.
  - `mac_screenshot` with `display` and `region`: `region` is in the screen
    points `mac_windows` reports (not relative to the display), and a region
    outside the display named is refused instead of returning another
    display's pixels.
- Playwright is held at 1.65.x (`~1.65.1`; it was `^1.58.0`), the version this
  release was tested with, so a fresh install gets the Playwright the tests
  ran on rather than any later 1.x. With 1.65.1, `browser_launch` with
  `cdp_port` was tried against Chrome for Testing 156 and 159, and with
  `chrome: true` against 159 (2026-11-14).
- Browser: when the active tab closes, the tab that takes over is the first
  open one that shows an http(s) page — or is still on the blank page
  that `browser_launch` or `browser_tabs` opened it on (`file://` with
  `NORACU_ALLOW_FILE_URL=1`). Before, it was the first open tab whatever it
  showed: in a headed session that could be a tab someone had opened on a
  local file, and `browser_read` then returned the file. When no such tab
  is open the page tools return `no_active_page`; `browser_tabs` still
  works and can open or select one. The tab that already is the active
  page is held to the same rule on every call: once it shows something
  else — a blob the page made, Chromium's page for a load that failed, a
  blank page after another page, a local file opened in it by hand — the
  page tools return
  `active_page_not_allowed` and the tab stays the active page;
  `browser_navigate` takes it to an http(s) page again, and `browser_tabs`
  can open or select another. (After a load that failed, `browser_read`
  used to return the empty text of Chromium's error page and
  `browser_screenshot` a picture of it.) What `browser_read`,
  `browser_snapshot`, `browser_screenshot` or `browser_evaluate` got back —
  a result or an error — is dropped as well when the page stopped passing,
  or went through a page that does not pass, while they worked; and
  `browser_snapshot`, whose tree, element list and address are read one
  after the other, returns `page_changed` when the page navigated in
  between — to another address, by a fragment, a reload or
  `history.pushState`. `browser_read` does the same without a selector;
  with one it hands its text over under a first line that says the page
  navigated and gives both addresses; a script's result and a screenshot
  are handed over with a note that says so. An `element_index` is not used
  after the page navigated, a reload of the same address included. The
  session's first tab is Chromium's own: noracu sends it to `about:blank`
  itself at launch and empties `window.name` before it counts as that
  blank page, and any navigation it reports afterwards ends that; when
  the tab does not count, `browser_launch` says so in its result.
  A session attached to an app with `cdp_port` keeps that app's own
  pages, whatever they show.
- Before a physical click or drag the person-goes-first check is made a
  second time, right before the pointer is taken: someone who started using
  the keyboard or mouse after the call left the queue keeps the pointer —
  `user_active`, nothing is sent. The check used to be made once, when the
  call left the queue.
- A Mac or iPhone input call that sent nothing — refused with
  `delivery=not_delivered` — no longer counts as noracu's own last input.
  Before, the person's keyboard or mouse event of that moment could be taken
  for noracu's own, and the next call went ahead instead of returning
  `user_active`.
- `phone_swipe` keeps both points inside the phone screen. The iPhone
  Mirroring window has a transparent margin around the screen (a strip
  above it and a thin edge on the other sides: x 0.029–0.971, y 0.061–0.987
  of a 280×620 pt window in a device run on macOS 27.2), and iOS cancels a
  drag that starts or ends there. An App Switcher card swiped up to y 0.03
  stayed put (no pixel changed) while the same swipe ending at y 0.12 closed
  it, and a share sheet dragged down to y 0.995 stayed open; `phone_swipe`
  reported `swiped` each time. The screen's edges are now read from the
  window's own pixels (from their transparency, so a black app edge still
  counts as screen); a point on the margin is moved 0.01 inside the edge and
  the result names it. The edges are measured once per window size and
  macOS version and remembered in
  `~/Library/Caches/noracu/phone-screen-rect.json`, because phone apps treat
  every capture of the mirror window as a screenshot (see Known issues). A
  measurement that shows no strip above the screen — what the capture gives
  while the pointer rests on that strip — is neither used nor remembered:
  both points are then kept clear of where the margin may be, and the
  result says so. A swipe whose two points would become one point once
  moved inside — a press, not a swipe — is refused with `out_of_screen`.
  When nothing is
  remembered and the window's image cannot be read, or the window is gone
  by the time its edges are looked up, the swipe is refused with
  `capture_failed` and nothing is sent.

### Known issues
- XCUITest backend: what was run, and what was not. Run: iPhone 16 Pro on
  iOS 27.2 (paired; over the local network through the CoreDevice tunnel,
  and with the cable connected, which `devicectl` reports as a wired
  transport) and an iPhone 17 Pro simulator on iOS 26.5, Xcode 27.2, in the
  Settings app and on the Home Screen — every `ios_*` tool through the MCP
  server. Measured on the
  iPhone: the first call that needs the phone takes about 9 s (the runner
  starts); each input then takes about 0.8 s more than on the simulator,
  because the lock check asks `devicectl` every time; a list dragged 150 pt
  moved 136–140 pt. A locked iPhone was run twice: `ios_status` reports it,
  `ios_home`, `ios_launch`, `ios_snapshot` and `ios_screenshot` return
  `device_locked`, and the runner is not started. Not run: a phone that
  locks while the runner is up, a tap into a system prompt on a real
  iPhone (on the simulator only), apps that ask for a login, a phone with
  Wi-Fi off, and iPhone models or iOS versions other than the two above. An
  app that has just come to the front keeps filling in its rows for a
  second or two, so an index from a
  snapshot taken in that moment can come back as `element_no_longer_valid`.
- iPhone Mirroring margin. While the phone screen's edges are not known
  (the pointer resting on the strip above the screen when the window is
  measured), a point is sent only when it is clear of a band along the
  window's edges: the top 8 % of its height or 48 pt, whichever is more;
  4 % of its width or 12 pt at each side; 2 % or 12 pt at the bottom. The
  bands were sized from one window: 280×620 pt on macOS 27.2, where the
  strip is 38 pt and the side margins 8 pt. A window whose strip is taller
  than its band would let a tap near the top reach the window's own
  controls while the edges are not known. Not run: other window sizes, and
  this path on a real mirror window (unit tests only).
- Phone apps see a capture of the iPhone Mirroring window as a screenshot.
  In a device run (iPhone 17 Pro Max on iOS 27, Mac on macOS 27.2) LinkedIn
  and rednote each showed their after-screenshot share sheet 1–4 s after
  every capture, one more sheet per capture. Every tool that reads the
  screen captures it: `phone_screenshot`, `phone_ocr`, `phone_find`, any
  `expect` check, the checks inside `phone_type`, `phone_open` and
  `phone_scroll`, and a phone input that first has to bring iPhone Mirroring
  to the front. Ruled out: a stray tap (the sheets appeared in a run that
  sent no input) and the capture method (`CGWindowListCreateImage` and
  `screencapture -l` both raised them). X and the Home Screen showed no
  reaction. Not tested: other apps, and whether an app that reports
  screenshots to someone else does so here. See SECURITY.md, threat 21.

## [0.2.7] — 2026-11-08

### Changed
- The person at the Mac goes first. Before a Mac or iPhone input tool acts,
  noracu reads how long ago the Mac's keyboard or mouse was last used; when
  that was less than 2 s ago and not noracu's own input, the call returns
  `user_active` and sends nothing (`delivery=not_delivered, retry=safe`) —
  retry after a pause. Read-only tools (screenshots, accessibility reads,
  `phone_status`, OCR) and the browser layer are not held up. After a
  physical Mac click, drag or scroll, and after a phone gesture, the pointer
  goes back where it was — moved back without an event, and only while it
  is still where noracu left it, so a pointer someone moved meanwhile stays
  where they put it. `NORACU_USER_IDLE_S` sets the wait (default 2, 0 to
  60); `0` turns both off, for a Mac dedicated to the agent. `mac_status`
  reports the value as `user_idle_s`. macOS keeps one idle time, and
  noracu's own events reset it too (measured on macOS 27.2), so an event
  counts as the person's only when it came after noracu's previous input
  had ended: a key pressed or mouse moved while that input was running is
  not seen, and the check runs once, before the call acts.

### Fixed
- `phone_type` (and the name `phone_open` types into Spotlight) waits at
  least 1.5 s between writing the Mac clipboard and sending ⌘V. iPhone
  Mirroring pastes through Universal Clipboard, which tells the phone
  about new clipboard content with a delay. In a device run (macOS 27.2),
  once in about 30 pastes, a ⌘V sent about 0.5 s after the write pasted
  the text the Mac clipboard held before the write instead of the new
  text. The 1.5 s is a judgement, not a measured delay: it is meant to let
  the new text reach the phone first and does not rule the race out, and
  it does not help when the phone shows "Pasting from …" and then pastes
  nothing, which was also seen. `type_not_confirmed` now says the field
  may hold the phone's older clipboard, so read it before typing again,
  and `phone_open`'s `open_not_confirmed` no longer says the name was
  pasted. A clipboard change during the wait still stops the paste before
  ⌘V. The screen count that decides whether the paste showed up (and
  whether your clipboard is put back) is now read after the wait, right
  before ⌘V, so text that appears during the wait cannot pass for the
  paste. Each `phone_type` and `phone_open` call takes about 1.5 s longer.
- If another app (or another Space) comes to the front during that wait,
  ⌘V is called off — checked right after the wait, before any screen read,
  and again right before ⌘V — instead of bringing iPhone Mirroring back to
  the front, and your clipboard is put back unless something else copied
  meanwhile: `phone_type` returns `focus_lost` saying nothing was sent
  (or, with `replace`, that only the select-all went out), and
  `phone_open` returns `focus_lost` without going back to the Home Screen,
  which would also bring iPhone Mirroring forward (Spotlight may stay
  open). When another app or device writes the clipboard before ⌘V,
  `phone_open` now goes back to the Home Screen and says the name was not
  pasted, instead of ending with an input error. `phone_type` results that
  OCR cannot confirm (a text of one to three characters, or one seen only
  in the top strip) now say the field may hold the phone's older
  clipboard, and the phone's "Pasting from …" box also counts when OCR
  splits it over two lines.
- `phone_open` opens apps again on iPhones whose Spotlight puts the search
  field at the top and shows no "Top Hit" card (iOS 27's "Search or Ask").
  There every `phone_open` failed with `open_not_confirmed: … never showed
  up on the phone` although the name had been pasted (0.2.6 too). It now
  reads the field, which shows the query completed as "<name> — Open", and
  taps the exact label just under the field (above the first section
  header) only when that completion names exactly this app; any other
  completion, or none, is `app not found` with nothing tapped. In a device
  run (iOS 27, macOS 27.2): Calculator 2/2 and Clock 2/2 back to back
  opened, an unknown name returned `app not found`. The "Open" completion
  is read in English only; `NORACU_TOPHIT_LABELS` covers the Top Hit
  label, not this word.
- The iPhone layer no longer loses the mirror window while the phone's
  keyboard is composing (for example a Pinyin letter that is still
  underlined). iPhone Mirroring then shows a small candidate-bar window
  (397×28 in a device run on macOS 27.2), and the window lookup took that
  one: `phone_status` reported its size with `live: null`, and `phone_key`,
  `phone_tap` and the other inputs returned `mirror_state_unknown` and sent
  nothing — so even the `delete` that ends the composition could not go
  out. The bounds, overlay and Resume lookups now use the iPhone Mirroring
  window itself (the first standard window, found by its position in the
  window list on every call) and fall back to the old lookup only when
  there is none. A failed bounds read is retried once after 0.3 s (a read
  sends nothing to the phone): during a connection blip System Events
  briefly could not find the window.

### Docs
- SECURITY.md threat 18 (clipboard on the phone path) now describes the
  wait before ⌘V and the `focus_lost` call-off, and lists what remains: an
  early ⌘V can still paste the phone's own older clipboard, an older
  clipboard that contains the typed text can pass for the paste, and the
  "Pasting from" box is recognized only in English.
- README (both languages): `open_not_confirmed: … never showed up` no
  longer reads as "the name did not arrive" only, and the known limits
  describe the top-field Spotlight.

## [0.2.6] — 2026-11-07

### Changed
- `mac_type` without `element_index` or `app` no longer sends keystrokes
  when the frontmost app reports no focused element: it returns `no_focus`
  and sends nothing. Before, the keystrokes went wherever macOS routed them
  and the result said "into the focused element". Pass
  `element_index`, or `app` to type into that app anyway. A text view
  accessibility cannot write (a terminal) still gets keystrokes as before.
- `mac_type` results name the app: "into the focused element of "Notes"",
  "into "Notes" (it reports no focused element)", or, for
  `mechanism:"physical"` without `app`, the frontmost app.
- `mac_clipboard_read` marks Universal Clipboard content (copied on another
  device) with `remote: true` and a note that reading it makes macOS fetch
  it from that device. The content is still returned.

### Fixed
- `mac_scroll`'s refusals (`occluded`, `focus_unknown`) no longer tell you to
  pass `force:true` or `app` — `mac_scroll` takes neither. They point at
  `element_index` instead. Before, a window center under another window or
  the Dock came back with click advice.
- `mac_key` with `cmd` or `ctrl` and a character key (`cmd-c`, `cmd-v`,
  `cmd-z`) goes out on the key that types that character in the current
  keyboard layout, and `mac_paste`'s ⌘V does the same. Before, `mac_key`
  sent these chords through cliclick (`kd:cmd t:v ku:cmd`), the sequence
  that in a device test (macOS 27.2, Pinyin input source) typed a plain "v"
  instead of pasting; and `mac_paste` refused Dvorak layouts, while on
  other layouts that move V (Workman) it sent ⌘ with the key where V sits
  on U.S. keyboards. When no key in the layout types the character, the
  call returns `not_delivered` with `keyboard_layout` and nothing is sent.
  A plain character, or one with only `shift` / `alt`, is still typed
  through cliclick.
- `phone_type` checks the Mac's keyboard layout before it sends ⌘V (and,
  with `replace`, ⌘A) to iPhone Mirroring. When the key the chord is sent
  from types another character — French AZERTY has Q where ⌘A is sent from,
  Dvorak has K where ⌘V is — it returns `keyboard_layout`
  (`not_delivered`, `retry=safe`), sends nothing and leaves the clipboard
  alone. Before, these chords went out from U.S. key codes whatever the
  layout. The Spotlight shortcut `phone_open` uses falls back to clicking
  the View menu item in that case. A layout that cannot be read is treated
  as before.
- `phone_type` says why a paste whose screen change it saw is not confirmed,
  when the reason is known: a text of fewer than four characters (spaces and
  case aside) is never confirmed by OCR, and a text OCR saw appear only in
  the strip at the top of the screen cannot be told from a notification
  banner. Both come back at once as `delivered_unverified`. Before, both
  went on to the extra late-paste check of up to 15 s, which could then
  report that the text "showed up late".
- `browser_snapshot` says when it cut the ARIA snapshot (`[aria snapshot
  truncated: showing N of M chars …]`) and when it could not list the
  clickable elements (`[clickable elements unavailable: … — retry
  browser_snapshot …]`). Before, both were silent, and an empty list read
  as a page with nothing to click. `browser_read` and `browser_evaluate` end
  cut text with `[truncated: showing N of M chars]`.

### Known issues
- The keyboard-layout handling in `mac_key`, `mac_paste` and `phone_type`
  was tried on a device only with the U.S. layout and the Pinyin input
  source (macOS 27.2). AZERTY, Dvorak and Workman are covered by unit tests
  that stand in for the layout lookup, not by a device run.

## [0.2.5] — 2026-11-07

### Changed
- `phone_scroll` that changed the screen is reported `delivered_unverified`
  instead of `delivered_verified`: a changed screen is all it sees, and a
  notification or an animation changes the screen too. Take
  `phone_screenshot` to see where the list is. `scroll_no_effect` is
  unchanged.
- `phone_type` is `delivered_verified` only when OCR sees the typed text at a
  spot where it was not before the paste, below the strip at the top where the
  status bar and notification banners are drawn. A rise in how often the text
  shows anywhere on screen (a banner carrying the same words, a label
  elsewhere) no longer confirms the paste, and no longer licenses putting the
  user's clipboard back. Text that shows up only after the 2.5 s window is
  `delivered_unverified`, and the result no longer says the paste landed: in
  a device test a second paste of the same text into the Settings search
  field was "seen late" while the field still showed the text once. The
  clipboard keeps the typed text. One character that OCR saw appear is
  `delivered_unverified` and no longer puts the user's clipboard back. A text
  of two or three characters (spaces and case aside) is never confirmed by a
  sighting — "in" is part of "Sign in" — so it is `delivered_unverified` and
  leaves the typed text on the clipboard.
- `mac_scroll` without `element_index` scrolls at the center of the
  frontmost app's front window on screen, and only when that app's window is
  on top at that point — otherwise it reports `occluded` (or `no_window`) and
  scrolls nothing. Before, the pointer went to the first window System Events
  named, or stayed wherever it was when that lookup failed.
- `phone_open` taps nothing when Spotlight's Top Hit card shows the app name
  at two or more different spots: it reports `open_not_confirmed` and goes
  back to the Home Screen. Before, it tapped the topmost one.

### Fixed
- `mac_paste` sends ⌘V as the V key (key code 9) with ⌘ held, posted by the
  accessibility engine, instead of cliclick's `kd:cmd t:v ku:cmd`. On macOS
  27.2 with the Pinyin keyboard layout, cliclick's version reached TextEdit as
  nothing, or as a plain "v" typed into the document, so `mac_paste` reported
  `delivered_unverified` and the text was never pasted. Under a Dvorak layout,
  where key code 9 is K, `mac_paste` now refuses (`not_delivered`) instead of
  sending ⌘K; "Dvorak - QWERTY ⌘" layouts are fine. `mac_paste` no longer needs
  cliclick.
- A point under the Dock no longer counts as the window behind it. On macOS
  27.2 (the version tested) the Dock is one full-display window that lets
  clicks through, and the check of which window is on top skipped it, so
  `mac_scroll` without `element_index` scrolled a window whose center was
  under the Dock, and a `mac_click` at x,y there would have been sent. The
  strip each display keeps for the Dock (its whole width, the gaps beside the
  icons included) now counts as covered by the Dock: `occluded`, nothing
  sent. The same check guards physical clicks and drags on an element.
- While a notification banner shows, a point away from it is no longer
  `occluded` by Notification Center. On macOS 27.2 Notification Center then
  keeps a full-display window above everything, and every raw click, drag or
  scroll anywhere on the screen was refused until the banner left. Now only
  the banner's or alert's own frame (read through accessibility, plus a small
  margin) counts as covered; when those frames cannot be read, or the
  notification list is open, the whole screen still counts as covered.

### Docs
- SECURITY.md opens with what noracu hands to your model and what it can
  reach — text returned to the model, the clipboard, privacy-consent and
  authorization dialogs, secrets an app displays, browser cookies, the iPhone
  Mirroring session — with who receives each and what noracu does and does
  not do, plus its boundaries: macOS permissions belong to the host app,
  noracu does not constrain the host's own shell, and tool annotations
  restrict nothing. New threat 18 covers the clipboard on the phone path: the
  iPhone fetches a paste late, so `phone_type` puts the clipboard back only on
  screen evidence. The iPhone Mirroring row notes that the mirror delivers
  pointer input, not touches (Apple TN3210), so swiping in from the left edge
  to go back does nothing through it.

## [0.2.4] — 2026-11-07

### Changed
- A text write counts as `delivered_verified` only when the field changed into
  exactly what the write should leave: for `mac_set_value`, the value given
  (line endings unified, leading and trailing white space ignored); for
  `mac_type`, the text over the selection that was there, the old value plus
  the text, or — with `replace` — the text itself; for `mac_paste`, the
  focused field's value becoming the text pasted over the selection that was
  there. A field that merely contains the text somewhere no longer counts:
  the text may have been there before. When the insertion point cannot be read, a changed value that shows
  the text is `delivered_unverified` (`insertion_point_unreadable`), and one
  that shows it elsewhere is `delivered_unverified` (`not_at_insertion_point`).
- `mac_set_value` with the value the field already shows, and `mac_type` with
  `replace` and the text already there, send nothing and report
  `not_delivered` (`already`, retry safe).
- A paste over a selection that already held the same text leaves the value
  unchanged and is `delivered_unverified` (`value_unchanged`): a moved caret
  is no proof that ⌘V was handled.
- `mac_type` into a field that takes text only by rewriting its whole value
  refuses (`not_delivered`) when that value cannot be read, instead of
  replacing what is there with the text.

### Fixed
- `phone_open` finds Spotlight's search field where iOS 27 now draws it. The
  field floats about a fifth of the way up from the bottom on some screens
  (it was looked for only at the very bottom), and a long name may differ
  from what OCR reads there by a letter or two. A name the Top Hit card does
  not show is reported as `app not found` again, instead of
  `open_not_confirmed: … never showed up on the phone` after a 15 s wait
  (on the test iPhone, iOS 27: about 9–11 s per call, down from about 26 s).
- `phone_open` with a one- or two-letter name such as `X` no longer runs into
  its time limit (about 31 s, reported as "the Mac may be under heavy load").
  It reports `open_not_confirmed` instead (about 15 s on the test iPhone): OCR
  could not read the name, nothing was tapped, and the app may still be
  installed — open it from its Home Screen icon.
- The pyobjc install command in the `imctl unavailable …` message and in the
  READMEs named a package that does not exist on PyPI
  (`pyobjc-framework-AppKit`), so pip stopped without installing anything.
  It now names `pyobjc-framework-Cocoa`, which provides AppKit; the iPhone
  driver's own `pyproject.toml` had the same wrong dependency.
- Home Screen page swipes from the iPhone driver (`imctl page left|right`)
  start in the empty strip just above the Dock instead of the middle of the
  screen. iPhone Mirroring delivers a drag as pointer input, so a swipe that
  starts on an app icon picks the icon up: on the test iPhone two such swipes
  dropped an icon on another one and made a folder. `phone_swipe`'s
  description and the READMEs now say where to start a page swipe.
- `mac_set_value` with an empty or blank value on a numeric field (a stepper
  or a number field) wrote the number 0, and counted a field already at 0 as
  set. Only a written-out decimal number is compared and written as a number
  now; anything else is sent as text.

### Added
- Every tool reports the four MCP tool annotations — `readOnlyHint`,
  `destructiveHint`, `idempotentHint`, `openWorldHint` — set by what the tool
  does (`docs/tools.md` lists them). They are hints for the client, not
  permissions: `NORACU_READ_ONLY=1` is unchanged and still decides what is
  refused. `browser_launch`, `browser_fill`, `phone_launch` and `phone_home`
  are marked not idempotent until measured otherwise.

### Tests
- The iPhone driver's smoke tests run all 48 cases when run as a script
  (`npm run test:imctl`); a hand-kept list ran 28 of them. CI installs pyobjc
  and runs them.
- The local "gap" cases (a window covers, moves away from or closes over the
  target between the hit test and a physical click) count only an attempt
  whose click was actually sent: a click refused before sending is repeated
  (up to 5 attempts), any `delivered_verified` fails at once, and every
  attempt's full result is printed. A local case that this Mac cannot run —
  the notification banner case while a Focus mode holds banners back — is
  reported as not run instead of passed or failed.

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

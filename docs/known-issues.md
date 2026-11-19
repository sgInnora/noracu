# Known issues

What noracu is known not to do, what is known to be wrong and not fixed in this version, and what it was and
was not tested on. Security limits and defaults are in [SECURITY.md](../SECURITY.md); the limits of the two
iPhone backends are in [iphone.md](iphone.md).

## Where it was tested

| Layer | Tested on | Not tested |
|---|---|---|
| Mac | one Apple silicon Mac on macOS 27.2 — the whole test suite, with real apps and windows, before each release | Intel Macs; macOS 15 and 26. Only the part of the suite that needs no desktop runs elsewhere (GitHub's macOS runner) |
| Browser | Playwright's Chromium, and Google Chrome 157 as your own Chrome (`chrome: true`), on that Mac | other Chromium browsers; other Chrome versions |
| iPhone (XCUITest) | an iPhone 16 Pro on iOS 27.2 and 27.2.1; an iPhone 17 Pro simulator on iOS 26.5; Xcode 27.2 | other iPhones and iOS versions |
| iPhone (Mirroring) | an iPhone 17 Pro Max mirrored to that Mac | other pairs of Mac and iPhone |

A change is covered by a test that fails on the code before it. Where that test uses no real window and no
real phone, and no run on a real machine has covered the change since, the change is listed below under
"Changed, not re-tested on a real machine" until such a run has been made.

## Limits

- **Windows on another Space cannot be read.** Accessibility lists none of an app's windows that are on
  another desktop. `mac_ax_state` and the tools that pick a window answer `ax_empty` and say how many of the
  app's windows are off screen; `mac_windows` with `include_offscreen: true` lists them, without telling a
  window on another Space from a minimized one. `mac_app` with `activate` brings the app forward, and macOS
  may then move the person's desktop to it — on a Mac shared with a person, ask first. Seen on macOS 27.2.
- **A large window with a number that keeps changing.** When a snapshot did not read the whole window — more
  elements than `max_nodes` (400 by default), a `skeleton`, a `root` drill-down, or `mac_find` — an element
  is found again only if the texts around it are exactly what they were. A control next to a running clock
  or a counter then answers `element_no_longer_valid` every time. Raise `max_nodes` until the snapshot says
  `complete: true`: in a complete snapshot an ordinary change of a number does not make an element stale.
  An element of a row whose texts such a snapshot did not reach at all is refused for actions
  (`element_no_longer_valid`, `row_unread`): drill into the row with `root`, then act.
- **A page that changes its own address.** In the browser an `element_index` is refused
  (`element_no_longer_valid`) after any navigation of the page, including one the page makes itself by
  changing its query or fragment. On a page that does this while you work, take the snapshot again right
  before the action.
- **Results are large.** A default snapshot of a Finder window is about 24 KB, and `interactive` and
  `skeleton` do not make it smaller there (a flat window whose every row takes an action). `mac_apps` lists
  menu-bar and background apps too — about 15 KB on a Mac that runs a hundred of them; `filter` narrows it.
  Measured 2026-11-17 on macOS 27.2.
- **Electron and Chromium apps** take no background click, so a physical click there moves the pointer; see
  the README.

## Known and not fixed in this version

Mac and browser:

- `browser_navigate` that ends on a page the tools do not read — a `blob:` page the site made itself —
  still returns its address and title, and reports the navigation as verified.
- Your own Chrome (`chrome: true`): when the connection ends and the end could not be confirmed, a tab that
  noracu opens afterwards can be reported as already closed when the connection drops again, although it
  may still be open. The condition has not been produced in a test.
- Your own Chrome: when attaching fails after noracu's window was opened, that window is reported closed
  unless Chrome says that closing failed. Chrome has always said so in tests.

iPhone, Mirroring backend:

- `phone_open` clears Spotlight's search field with a fixed short wait. When the field is not cleared in
  time the name is typed after the old query, no result matches and the call fails; it does not tap a wrong
  result.
- `phone_open` where Spotlight shows its field at the top: if text recognition reads the magnifier as a
  letter, the app name does not match and the call fails; it does not tap a wrong result. Not seen on the
  test phone.
- `phone_type` of a single character: text that newly appears elsewhere on the screen at that moment (a
  notification banner) can be read as the typed character. Such a result is never reported as verified.

## Changed, not re-tested on a real machine

- Intel Macs: without `NORACU_CLICLICK` the server now also looks for cliclick under `/usr/local/bin`, where
  Homebrew puts it on an Intel Mac. No Intel Mac has run it.
- iPhone, XCUITest backend: right before an input goes out, the lock is read again when its last answer is older
  than a second and the stop file is looked at again, last; `ios_launch` looks at the stop file again right
  before the launch. Run against a simulated runner only.
- iPhone, Mirroring backend: `phone_open` taps nothing when the app's row in Spotlight moved between two reads
  and the read after that no longer shows the name. Run against scripted screen reads only.
- `noracu doctor` on a system other than macOS, with `NORACU_LAYERS=browser`: macOS and cliclick are no longer
  listed as missing. Run with a stand-in for the system only.

## Reporting one more

[Report a bug](https://github.com/sgInnora/noracu/issues/new?template=bug.yml) with the tool name and the
steps, or [report an app or site](https://github.com/sgInnora/noracu/issues/new?template=app-report.yml)
that noracu reads or operates badly. Neither needs a clone.

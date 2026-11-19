# Apps noracu was run against

Only what there is a record of: a test in this repository that drives the real app, or a run on the test
machines whose result was written down. "Run against" means the listed things worked there on that date; it
does not mean every control of the app works. An app that is not listed has not been tried, which says
nothing about whether it works.

Tried one yourself? [Report an app or site](https://github.com/sgInnora/noracu/issues/new?template=app-report.yml)
— the form asks which app, which tool and what you saw, and it needs no clone. Reports of apps that work are
as useful as reports of apps that do not.

## Mac (Apple silicon, macOS 27.2)

| App | What was exercised | Record |
|---|---|---|
| TextEdit | snapshots (`mac_ax_state`, `mac_find`) and the `element_index` actions the suite runs on them, `mac_paste`, menu commands, `mac_wait`, window operations (`mac_window`, `mac_windows`) | `test/e2e.mjs` (the part that needs a desktop), run before each release — last on 2026-11-17 |
| Finder | `mac_find`, `mac_app`; a snapshot of 189 elements | `test/e2e.mjs`; a read-only run on 2026-11-17 |
| Notes | typing a number read from a web page into a new note | the demo recording of 2026-11-13 |
| Google Chrome 157 | as your own Chrome (`chrome: true`): opening a tab, reading the page, `browser_tabs`. Through the Mac layer Chrome refuses web accessibility, so its pages are read through the browser layer | the demo recording of 2026-11-13; device runs of 2026-11-13 and 2026-11-14 |
| Claude (an Electron app) | a physical click on a menu-bar item | device run of 2026-11-16 |
| iTerm2 | snapshots only — terminals are on the default deny list, so no input is sent to them | a read-only run on 2026-11-17 |
| Notification Center | waiting for a notification to arrive (`mac_wait`) | `test/e2e.mjs` |

## iPhone

| App | Backend | What was exercised | Record |
|---|---|---|---|
| Settings | XCUITest (iPhone 16 Pro, iOS 27.2 and 27.2.1) | launching, snapshots, input by `element_index`, going Home; that everything is refused while the phone is locked | `test/ios-live.mjs` (19 checks), last on 2026-11-15; the locked phone on 2026-11-14 |
| Notes, Reminders, Files | XCUITest (iPhone 16 Pro) | finding and tapping across apps, long Chinese text | a trial of ten runs on 2026-11-13 |
| Settings | Mirroring (iPhone 17 Pro Max) | `phone_open` through Spotlight, taps, `phone_type`, scrolling | device runs for 0.2.4 to 0.2.7 |

## Known not to work well

- Any app whose windows are all on another Space: they cannot be read ([known-issues.md](known-issues.md)).
- Google Chrome through the Mac layer: it refuses web accessibility, so `mac_ax_state` shows its window
  chrome but not the page — use the browser layer.
- On the iPhone, a temporary input box that an app shows over its page (a comment box): see the limits in
  [iphone.md](iphone.md).

# Troubleshooting

Install, permission and first-run problems. For what each error means, see the error reference in [usage.md](usage.md#8-error-reference).

| Symptom | Cause / fix |
|---|---|
| `mac_*` fails with `permission_denied: Accessibility permission is missing…` (before 0.2: error **-1719**) | Accessibility not granted to the **host** app — grant it, then quit + reopen the host; `mac_status` shows the state |
| Screenshots show only the desktop picture (no other app's windows), or come back black | Screen Recording (Screen & System Audio Recording on macOS 15 and later) not granted to the host — grant it, then quit + reopen |
| `ENOENT` mentioning cliclick | `brew install cliclick` (or set `NORACU_CLICLICK`) |
| `spawn node` / `npx` `ENOENT` from a GUI host | use an absolute `node` path in the config — nvm/volta/homebrew shims are not on the GUI `PATH` |
| `claude mcp add` fails with `Invalid environment variable format: noracu, …` | `-e` came before the server name and took the name as one more variable — put the `-e` options after it: `claude mcp add -s user noracu -e NAME=value -- …` |
| `claude mcp add` refuses because a server named `noracu` already exists | an earlier install left its entry — remove it first with `claude mcp remove noracu` (add `-s user` if it was added for all your projects), then add the new one; in Claude Desktop's or Cursor's JSON, change the path in `args` |
| `browser_launch` answers `browser_installing` on first use | the one-time Chromium download is under way — call it again in a minute; with auto-install disabled (`NORACU_DISABLE_AUTO_INSTALL=1`) run `npx playwright install chromium` |
| `phone_*` says `imctl unavailable: no python3 with pyobjc found` | install pyobjc for a python3 (`python3 -m pip install pyobjc-framework-Quartz pyobjc-framework-Vision pyobjc-framework-Cocoa`; Homebrew python3 is the usual choice) or set `NORACU_PYTHON` — see [iPhone layer](iphone.md) |
| `phone_*` refused with `mirror_not_live: …` ("Connection Paused", "iPhone in Use", "not running") or `mirror_state_unknown: …` | the mirror is not running, paused, or its state could not be read — lock the iPhone, keep it near the Mac, check `phone_status`, and call `phone_launch` (it starts Mirroring and clicks Resume) |
| `phone_launch` says `mirror_setup_required` | iPhone Mirroring shows a setup or welcome screen (e.g. the first launch after a macOS upgrade) — finish it yourself in the iPhone Mirroring window; noracu never clicks through it |
| `imctl_timeout: phone … did not finish within …s` | the Mac is under heavy load or the system is stuck — the action may have partly run, so check `phone_status` / `phone_screenshot` before retrying (after `phone_open`, noracu goes back to the Home Screen); the server keeps answering other calls meanwhile |
| `input_busy: …` | an earlier phone or Mac action held the input queue for over 60 s (or `NORACU_PHONE_TIMEOUT_MS` + 15 s); the call did nothing — retry |
| `user_active: …` | someone used this Mac's keyboard or mouse in the last 2 s, and again while noracu waited out the rest of the 2 s — nothing was sent; retry after a pause. On a Mac nobody else uses, `NORACU_USER_IDLE_S=0` turns the check off |
| `phone_open` returns app not found for an installed app | it only taps the app's label in Spotlight's Top Hit card, or — where Spotlight shows its search field at the top and no Top Hit card — the label just under the field when the field completes the name as "<name> — Open" — use the name exactly as the phone shows it under the icon (e.g. `拼多多`, not `Pinduoduo`). "Spotlight showed no Top Hit" on an installed app usually means the iPhone's language is not English: `phone_open` reads Spotlight's "Top Hit" label — set `NORACU_TOPHIT_LABELS` to the label your iPhone shows (it covers the Top Hit label only; the "— Open" completion is read in English only). `open_not_confirmed: … never showed up on the phone` means the name did not show up in Spotlight after ⌘V: the paste may not have arrived (it can take several seconds) or the phone may have pasted its own older clipboard into the search field — retry; `phone_open` clears the field first. A one- or two-letter name such as `X` is often unreadable to OCR, so `phone_open` reports `open_not_confirmed` without tapping — open that app from its Home Screen icon (`phone_screenshot`, then `phone_tap`). `phone_open` leaves the app name on the clipboard |
| Typed text comes out re-spaced (e.g. "no ra cu") | it went in as keystrokes (`mac_type` with `mechanism: "physical"`, or a focused element that takes no accessibility text) while a CJK input method was active — use the default `mac_type` mechanism, or `mac_paste` |
| `element_no_longer_valid` | the snapshot is older than 30 s, or the element is gone, changed or in a window that closed — re-run `mac_ax_state` / `browser_snapshot` and use a fresh index |
| `occluded: … — on top: {…}` | a physical click would land on something else (another window, a sheet) — bring the target forward or close what covers it; nothing was sent |
| `ambiguous_window: … windows: […]` | the app has several windows and none is focused — pass `window` (index or title) or `window_id` from `mac_windows` |
| `policy_denied: "cmd-q" …` | `mac_key` refuses quit / log-out / lock / force-quit / delete-immediately / empty-Trash chords unless `force: true`; to quit an app use `mac_app` |

Node 18 is rejected at startup — use Node ≥ 20. Claude Desktop may start one noracu process per surface (e.g. chat and a second surface); they share the browser profile, so launch the browser from only one at a time.

Full worked examples: [docs/usage.md](usage.md).

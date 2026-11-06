# imctl — Control your iPhone from macOS

> Ships inside [noracu](https://github.com/sgInnora/noracu) (`imctl/`) as the driver behind its
> `phone_*` MCP tools; it also works standalone from this directory.

`imctl` drives the **iPhone Mirroring** app on macOS (Sequoia and later)
from the command line: tap, swipe, type, OCR the screen, and open apps —
all locally, no network, no API keys.

```
$ imctl status
$ imctl tap 0.5 0.5
$ imctl home
$ imctl type "hello"
$ imctl ocr
(0.50,0.06) 'Settings'
(0.18,0.31) 'FaceTime'
...
$ imctl open Photos
```

## How it works

```
┌────────────┐   CGEvent (HID tap)   ┌───────────────────┐
│   imctl    │ ────────────────────▶ │ iPhone Mirroring  │
│            │                       │  (video stream)   │
│  Vision ◀──┼─── screencapture ─────│                   │
│   OCR      │                       └─────────┬─────────┘
└────────────┘                                 │ Continuity
                                               ▼
                                          ┌─────────┐
                                          │ iPhone  │
                                          └─────────┘
```

- **Input** — synthesized CoreGraphics mouse/keyboard events posted to
  the HID event tap. iPhone Mirroring translates them into touches.
- **Vision** — the macOS Vision framework runs OCR locally on a
  window screenshot (captured by CGWindow id, so it is the window's own
  pixels even when covered) and returns text with normalized coordinates.
- **Verification** — `imctl verify` compares downsampled pixel hashes
  (`capture_hash`) before and after a gesture; `scroll`, `type` and `open`
  verify using luma frame diffs (`mean_abs_diff`) and/or Vision OCR; `tap`,
  `longpress`, `swipe`, `home` and `app-switcher` do not verify post-action
  screen changes (optional `--expect` checks on-screen OCR text before acting).

## Why these specific parameters

Every constant in `input.py` is backed by empirical testing against
the mirroring gesture recognizer:

| Parameter | Value | Why |
|-----------|-------|-----|
| tap down-up interval | 50 ms | shorter intervals are sometimes dropped |
| swipe steps | 20 | single-shot drags are **not** recognized as swipes |
| initial nudge | 3 px | disambiguates swipe from icon long-press-drag |
| swipe curve | quadratic ease-in-out | stays inside the recognizer's velocity window |
| home gesture start | 0.90 height | higher start points are treated as in-app scrolls; the bottom ~7% (0.95) is macOS window chrome where events do not reach the phone |
| text input | clipboard + Cmd+V | direct keystroke synthesis breaks under CJK IMEs |

## Requirements

- macOS 15 (Sequoia) or later with **iPhone Mirroring** configured
  (iPhone signed into the same Apple Account, Bluetooth + Wi-Fi on)
- Python 3.10+ with pyobjc: `python3 -m pip install pyobjc-framework-Quartz pyobjc-framework-Vision pyobjc-framework-AppKit`
  (Apple's `/usr/bin/python3` usually lacks it; Homebrew's `python3` is the common working choice)
- **Accessibility** and **Screen Recording** permissions granted to
  your terminal app (System Settings → Privacy & Security)

## Install

```bash
cd imctl
pip install -e .          # or: pip install -e ".[pyobjc]" if pyobjc missing
imctl status
```

## Commands

| Command | Description |
|---------|-------------|
| `status` | session + window info (JSON: running, window, window_id, onscreen, frontmost, live, overlay, paused, setup) |
| `screenshot [PATH]` | capture the mirroring window to PNG by window id (works when covered) |
| `resume` | click Resume when the window shows Connection Paused (never on a setup or welcome screen) |
| `launch` | ensure mirroring is running and frontmost; resumes a paused session, never clicks a setup screen (`mirror_setup_required`) |
| `tap X Y [--expect TEXT]` | tap at normalized coords (0-1) |
| `longpress X Y [D] [--duration D] [--expect TEXT]` | long-press (default 0.8s) |
| `swipe FX FY TX TY [--ms MS] [--expect TEXT]` | eased swipe between two points |
| `home` | send home gesture (bottom-edge swipe up; requires live mirror; screen not verified) |
| `app-switcher` | send app-switcher gesture (swipe up and hold; requires live mirror; screen not verified) |
| `scroll up/down [D] [--expect TEXT]` | scroll by normalized distance |
| `page left/right` | home-screen paging |
| `type [--replace] [--expect TEXT] TEXT\|-` | type text via clipboard (IME-safe; `-` reads stdin; never echoes typed text) |
| `key [--expect TEXT] K` | return / delete / up / down / left / right |
| `ocr` | OCR the screen with coordinates |
| `find [--exact] TEXT\|-` | locate text on screen (`-` reads stdin) |
| `open APP\|-` | open an app via Spotlight + OCR + tap (`-` reads stdin; only an exact label inside the Top Hit card) |
| `verify ACTION` | run a gesture and verify the screen changed |

## Python API

```python
from imctl import gestures, input, vision

gestures.launch()
gestures.home()

input.tap(0.5, 0.5)
input.swipe(0.5, 0.8, 0.5, 0.2)
input.type_text("hello")

hits = vision.read_screen()
for h in hits:
    print(h.nx, h.ny, h.text)
```

## Design notes

**Dynamic window tracking.** Window bounds are re-resolved before every
gesture — the window can move, close, or be re-created between actions.
A cached position means tapping the wrong screen region.

**Observe → act → re-observe.** `verify.verify_action()` implements the
observe → act → re-observe discipline: an action is only considered
successful when the screen content actually changed. Dropped events are
common enough with synthesized input that silent failure is the default
assumption.

**Local-only.** No telemetry, no network calls, no API keys. OCR runs
through the Vision framework on-device.

## Limitations

- The iPhone must stay **locked** and near the Mac — iPhone Mirroring only
  runs while the phone is locked, and unlocking it ends the session. The
  mirror pauses after inactivity; `status` reports `paused` and `resume`
  clicks Resume. iPhone Mirroring is unavailable in the EU (Apple).
- Drag-and-drop between Mac and iPhone is not supported.
- Multi-display setups: the window is located by AX query, so it works
  on any display, but coordinates are always screen-global.

## License

MIT — see [LICENSE](LICENSE).

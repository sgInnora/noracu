"""imctl CLI — control iPhone Mirroring from the command line.

Usage:
    imctl status                    # session + window info
    imctl tap 0.5 0.5               # tap center
    imctl longpress 0.5 0.5 1.0     # long-press center for 1s
    imctl swipe 0.5 0.8 0.5 0.2     # swipe up
    imctl home                      # home gesture
    imctl app-switcher              # app switcher
    imctl scroll down 0.5           # scroll down half a screen
    imctl page left                 # next home page
    imctl type "hello world"        # type text (clipboard-based)
    imctl key return                # press a key
    imctl ocr                       # OCR the screen
    imctl find "Settings"           # find text on screen
    imctl open "Photos"             # open app via Spotlight
    imctl verify home               # run a gesture with verification
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import sys
import tempfile

from . import gestures, input, verify, vision
from .vision import CaptureError
from .window import WindowError, ensure_frontmost, get_overlay

# F31: every phone input command starts in _require_live(), which first brings
# the mirror to the front — switching Spaces if needed and waiting for a real
# frame — so the expect OCR and scroll baseline that follow read the phone, not
# another Space or a transition frame. Module-level so tests can swap it.
_bring_front = ensure_frontmost

# F25: one line, one exit code for every capture failure. The pixels a check
# needed are not the phone's — report that, never guess from whatever
# another window happened to show inside the region.
_CAPTURE_FAILED_LINE = (
    "capture_failed: could not capture the iPhone Mirroring window "
    "(it may be hidden, minimized or on another Space); no image was returned"
)


def _capture_failed() -> int:
    """Print the F25 capture-failure line; exit code 7."""
    print(_CAPTURE_FAILED_LINE, file=sys.stderr)
    return 7


def _require_live() -> int | None:
    """Refuse phone input while the mirror shows an overlay instead of the phone stream.

    Returns exit code 3 after printing a `mirror_not_live:` line when the mirror is
    verifiably not live; returns None (allow) when live or unknown (fail-open).
    F31: brings the mirror to the front first (see _bring_front).
    """
    _bring_front()
    overlay = get_overlay()
    if overlay["live"] is False:
        label = overlay["overlay"] or "overlay shown"
        print(
            f"mirror_not_live: {label} — call phone_launch (or imctl resume) first",
            file=sys.stderr,
        )
        return 3
    return None


def _require_expect(args, read_screen=None, read_sweep=None) -> int | None:
    """Refuse input when the --expect anchor text is not on screen.

    Between two phone_* calls the iPhone foreground can change (the user
    picked up the phone, tapped a notification); the mirror cannot report
    the phone's foreground app identity, so an OCR text anchor is the
    only available guard — the iPhone-side counterpart of mac_key's app
    focus guard. Returns None when no --expect was passed or the text is
    on screen; returns exit code 5 after printing an ``expect_not_found:``
    line when it is not, in which case nothing is sent. A capture failure
    refuses the same way with ``capture_failed:`` and exit code 7 — an
    unreadable screen is not a match, so nothing is sent then either.
    """
    expect = getattr(args, "expect", None)
    if expect is None:
        return None
    if read_screen is None:
        read_screen = vision.read_screen
        if read_sweep is None:
            def read_sweep():
                return vision.read_screen(language_correction=False, sweep=True)
    try:
        hits = read_screen()
        if (read_sweep is not None and verify.is_short_text(expect)
                and not verify.screen_contains(expect, hits)):
            # F27: a one- or two-character anchor (the app "X") can be invisible
            # to the default OCR pass; read again with the sweep before refusing.
            hits = read_sweep()
    except (WindowError, CaptureError):
        # F25: an unreadable screen is not a match — refuse exactly like
        # expect_not_found; nothing is sent.
        return _capture_failed()
    if verify.screen_contains(expect, hits):
        return None
    print(
        f"expect_not_found: {expect!r} is not on screen; nothing was sent",
        file=sys.stderr,
    )
    return 5


def _warn_if_not_live() -> None:
    """Print a heads-up before ocr/find output when the mirror is not live.

    The captured pixels then show the overlay (paused/connecting notice), not the phone.
    """
    overlay = get_overlay()
    if overlay["live"] is False:
        print(
            f"warning: mirror not live (overlay: {overlay['overlay'] or 'unknown'}) — "
            "the text below comes from the overlay, not the phone; call phone_launch"
        )


def _cmd_status(_args) -> int:
    print(json.dumps(gestures.status(), indent=2))
    return 0


def _cmd_tap(args) -> int:
    guard = _require_live()
    if guard is not None:
        return guard
    guard = _require_expect(args)
    if guard is not None:
        return guard
    input.tap(args.x, args.y)
    print(f"tapped ({args.x}, {args.y})")
    return 0


def _cmd_longpress(args) -> int:
    guard = _require_live()
    if guard is not None:
        return guard
    guard = _require_expect(args)
    if guard is not None:
        return guard
    input.long_press(args.x, args.y, args.duration)
    print(f"long-pressed ({args.x}, {args.y}) for {args.duration}s")
    return 0


def _cmd_swipe(args) -> int:
    guard = _require_live()
    if guard is not None:
        return guard
    guard = _require_expect(args)
    if guard is not None:
        return guard
    input.swipe(args.fx, args.fy, args.tx, args.ty, args.ms)
    print(f"swiped ({args.fx},{args.fy}) -> ({args.tx},{args.ty})")
    return 0


def _cmd_home(_args) -> int:
    gestures.home()
    print("home gesture sent")
    return 0


def _cmd_app_switcher(_args) -> int:
    gestures.app_switcher()
    print("app switcher opened")
    return 0


def _cmd_scroll(args) -> int:
    guard = _require_live()
    if guard is not None:
        return guard
    guard = _require_expect(args)
    if guard is not None:
        return guard
    try:
        moved = gestures.scroll_checked(args.direction, args.distance)
    except ValueError:
        print(
            "phone_scroll: distance is in window heights, "
            "0 < distance <= 3 (default 0.5)",
            file=sys.stderr,
        )
        return 2
    except (WindowError, CaptureError):
        return _capture_failed()
    if not moved:
        print(
            "scroll_no_effect: the screen did not change (end of the list, "
            "or the view under the cursor does not scroll)",
            file=sys.stderr,
        )
        return 4
    print(f"scrolled {args.direction} {args.distance}")
    return 0


def _cmd_page(args) -> int:
    guard = _require_live()
    if guard is not None:
        return guard
    if args.direction == "left":
        gestures.page_left()
    else:
        gestures.page_right()
    print(f"paged {args.direction}")
    return 0


def _cmd_type(args) -> int:
    guard = _require_live()
    if guard is not None:
        return guard
    guard = _require_expect(args)
    if guard is not None:
        return guard
    if input.type_text(args.text, replace=args.replace):
        print(f"typed {args.text!r}")
        return 0
    print(
        "type_not_confirmed: the paste did not show on screen within 2.5s; "
        "the clipboard still holds the typed text and your previous clipboard "
        "was not restored",
        file=sys.stderr,
    )
    return 4


def _cmd_key(args) -> int:
    guard = _require_live()
    if guard is not None:
        return guard
    guard = _require_expect(args)
    if guard is not None:
        return guard
    input.press_key(args.key)
    print(f"pressed {args.key}")
    return 0


def _cmd_ocr(_args) -> int:
    _warn_if_not_live()
    try:
        hits = gestures.read_text()
    except (WindowError, CaptureError):
        return _capture_failed()
    for h in hits:
        print(h)
    print(f"-- {len(hits)} hits")
    return 0


def _cmd_find(args) -> int:
    _warn_if_not_live()
    try:
        hit = vision.find(args.text, exact=args.exact)
    except (WindowError, CaptureError):
        return _capture_failed()
    if hit is None:
        print(f"not found: {args.text!r}", file=sys.stderr)
        return 1
    print(hit)
    return 0


def _cmd_open(args) -> int:
    guard = _require_live()
    if guard is not None:
        return guard
    # Open Spotlight here (not inside open_app) so a failure can be
    # reported as its own condition instead of a bogus "app not found".
    try:
        # F34: one retry — on the device the Spotlight command was once
        # ignored right after an app closed. Each try starts from the Home
        # Screen, so a second try cannot toggle an open Spotlight shut.
        if not (gestures.open_spotlight_checked()
                or gestures.open_spotlight_checked()):
            result = "spotlight_unavailable"
        else:
            result = gestures.open_app(args.app, spotlight_open=True)
    except (WindowError, CaptureError):
        # F25: the Spotlight gate and the result matching both read the
        # mirroring window's pixels; without them nothing about the
        # phone is known — refuse rather than guess.
        return _capture_failed()
    if result == "opened":
        print(f"opened {args.app!r}")
        return 0
    if result == "not_found":
        print(f"app not found: {args.app!r}")
        return 1
    if result == "spotlight_unavailable":
        print("spotlight unavailable (could not reach the Home Screen, the menu command failed, or the screen did not change)")
        return 1
    # "not_confirmed" (F24): the row — and possibly the Top Hit icon —
    # was tapped but the app never verifiably opened; the phone is
    # back on the Home Screen.
    print(f"open_not_confirmed: tapped {args.app!r} in Spotlight but the app did not open; back on the Home Screen", file=sys.stderr)
    return 4


def _cmd_verify(args) -> int:
    actions = {
        "home": gestures.home,
        "app-switcher": gestures.app_switcher,
        "page-left": gestures.page_left,
        "page-right": gestures.page_right,
    }
    if args.action not in actions:
        print(f"unknown action: {args.action}", file=sys.stderr)
        return 2
    ok = verify.verify_action(actions[args.action])
    print("screen changed: yes" if ok else "screen changed: NO (action may have been dropped)")
    return 0 if ok else 1


def _cmd_launch(_args) -> int:
    live = gestures.launch()
    if live is False:
        # F29: never report "ready" while the overlay is still up.
        print(
            "mirror_not_live: iPhone Mirroring is still paused — lock the iPhone, keep it "
            "near the Mac, then call phone_launch again",
            file=sys.stderr,
        )
        return 3
    print("iPhone Mirroring ready" if live else "iPhone Mirroring launched (stream state unknown)")
    return 0


def _cmd_screenshot(args) -> int:
    path = args.path
    if path is None:
        # A screenshot asked for outlives this process: an owner-only (0600)
        # file in the temp directory, unlike the OCR frames, which are
        # deleted once read.
        fd, path = tempfile.mkstemp(prefix="imctl_screenshot_", suffix=".png")
        os.close(fd)
    try:
        path = vision.capture_window(path)
    except (WindowError, CaptureError):
        if args.path is None:
            try:
                os.remove(path)  # the empty placeholder made above
            except OSError:
                pass
        return _capture_failed()
    print(path)
    return 0


def _cmd_resume(_args) -> int:
    ok = gestures.resume()
    print("resumed" if ok else "still paused (lock the iPhone, keep it near the Mac, then retry)")
    return 0 if ok else 1


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="imctl",
        description="Control iPhone Mirroring on macOS from the CLI",
    )
    sub = p.add_subparsers(dest="command", required=True)

    sub.add_parser("status", help="show session status").set_defaults(func=_cmd_status)
    sp = sub.add_parser("screenshot", help="capture the mirroring window to PNG (by window id, works when covered)")
    sp.add_argument("path", nargs="?", default=None)
    sp.set_defaults(func=_cmd_screenshot)
    sub.add_parser("resume", help="click Resume when the session is paused").set_defaults(func=_cmd_resume)
    sub.add_parser("launch", help="ensure mirroring is running and frontmost").set_defaults(func=_cmd_launch)

    sp = sub.add_parser("tap", help="tap at normalized coords")
    sp.add_argument("x", type=float)
    sp.add_argument("y", type=float)
    sp.add_argument("--expect", help="refuse to act unless this text is on screen (OCR)")
    sp.set_defaults(func=_cmd_tap)

    sp = sub.add_parser("longpress", help="long-press at normalized coords")
    sp.add_argument("x", type=float)
    sp.add_argument("y", type=float)
    sp.add_argument("--duration", type=float, default=0.8)
    sp.add_argument("--expect", help="refuse to act unless this text is on screen (OCR)")
    sp.set_defaults(func=_cmd_longpress)

    sp = sub.add_parser("swipe", help="swipe between two normalized points")
    sp.add_argument("fx", type=float)
    sp.add_argument("fy", type=float)
    sp.add_argument("tx", type=float)
    sp.add_argument("ty", type=float)
    sp.add_argument("--ms", type=int, default=300)
    sp.add_argument("--expect", help="refuse to act unless this text is on screen (OCR)")
    sp.set_defaults(func=_cmd_swipe)

    sub.add_parser("home", help="home gesture").set_defaults(func=_cmd_home)
    sub.add_parser("app-switcher", help="open app switcher").set_defaults(func=_cmd_app_switcher)

    sp = sub.add_parser("scroll", help="scroll up/down")
    sp.add_argument("direction", choices=["up", "down"])
    sp.add_argument("distance", type=float, nargs="?", default=0.5)
    sp.add_argument("--expect", help="refuse to act unless this text is on screen (OCR)")
    sp.set_defaults(func=_cmd_scroll)

    sp = sub.add_parser("page", help="page left/right on home screen")
    sp.add_argument("direction", choices=["left", "right"])
    sp.set_defaults(func=_cmd_page)

    sp = sub.add_parser("type", help="type text (clipboard-based, IME-safe)")
    sp.add_argument("text")
    sp.add_argument("--replace", action="store_true",
                    help="select all in the focused field first, then overwrite it")
    sp.add_argument("--expect", help="refuse to act unless this text is on screen (OCR)")
    sp.set_defaults(func=_cmd_type)

    sp = sub.add_parser("key", help="press a key (return/delete/up/down/left/right)")
    sp.add_argument("key")
    sp.add_argument("--expect", help="refuse to act unless this text is on screen (OCR)")
    sp.set_defaults(func=_cmd_key)

    sub.add_parser("ocr", help="OCR the screen").set_defaults(func=_cmd_ocr)

    sp = sub.add_parser("find", help="find text on screen")
    sp.add_argument("text")
    sp.add_argument("--exact", action="store_true")
    sp.set_defaults(func=_cmd_find)

    sp = sub.add_parser("open", help="open an app via Spotlight")
    sp.add_argument("app")
    sp.set_defaults(func=_cmd_open)

    sp = sub.add_parser("verify", help="run a gesture and verify the screen changed")
    sp.add_argument("action", choices=["home", "app-switcher", "page-left", "page-right"])
    sp.set_defaults(func=_cmd_verify)

    return p


def _on_sigterm(signum, _frame):
    # The server ends a call that runs past its time limit with SIGTERM. As
    # SystemExit it unwinds normally: OCR frames are deleted, and a paste
    # that never went out puts the clipboard back (type_text decides).
    raise SystemExit(128 + signum)


def main(argv: list[str] | None = None) -> int:
    signal.signal(signal.SIGTERM, _on_sigterm)
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except input.FocusLost:
        # F26: the frontmost check failed right before an event — either
        # nothing was sent at all, or (mid-scroll) nothing further was.
        print(
            "focus_lost: iPhone Mirroring is not the frontmost app; "
            "nothing (or nothing further) was sent",
            file=sys.stderr,
        )
        return 6
    except WindowError as exc:
        print(f"window error: {exc}", file=sys.stderr)
        return 3
    except input.InputError as exc:
        print(f"input error: {exc}", file=sys.stderr)
        return 4


if __name__ == "__main__":
    sys.exit(main())

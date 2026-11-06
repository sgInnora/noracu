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
import math
import os
import signal
import sys
import tempfile
import time

from . import gestures, input, verify, vision
from .vision import CaptureError
import subprocess

from .window import WindowError, ensure_frontmost, get_overlay, is_frontmost

# F31 / R13 §3: every phone input command starts in _require_live(), which probes
# get_overlay() first so a paused or stopped mirror refuses without stealing focus,
# then brings the mirror to the front (switching Spaces if needed and waiting for a
# real frame) before any capture or input. Module-level callables so tests can swap them.
_bring_front = ensure_frontmost
_is_front = is_frontmost
sleep = time.sleep

_MIRROR_NOT_RUNNING_LINE = (
    "mirror_not_live: iPhone Mirroring is not running — call phone_launch first"
)
_MIRROR_STATE_UNKNOWN_LINE = (
    "mirror_state_unknown: could not tell whether iPhone Mirroring is live — "
    "nothing was sent; retry, or call phone_status"
)

# F25: one line, one exit code for every capture failure. The pixels a check
# needed are not the phone's — report that, never guess from whatever
# another window happened to show inside the region.
_CAPTURE_FAILED_LINE = (
    "capture_failed: could not capture the iPhone Mirroring window "
    "(it may be hidden, minimized or on another Space); no image was returned"
)


# R19: the same failure while checking --expect, before the first event
_CAPTURE_FAILED_EXPECT_LINE = (
    "capture_failed: could not capture the iPhone Mirroring window to check --expect "
    "(it may be hidden, minimized or on another Space); no image was returned, so nothing was sent"
)


def _capture_failed() -> int:
    """Print the F25 capture-failure line; exit code 7."""
    print(_CAPTURE_FAILED_LINE, file=sys.stderr)
    return 7


def _mirror_not_live(overlay: dict) -> int:
    label = overlay.get("overlay") or "overlay shown"
    print(
        f"mirror_not_live: {label} — call phone_launch (or imctl resume) first",
        file=sys.stderr,
    )
    return 3


def _require_live() -> int | None:
    """Refuse phone input unless iPhone Mirroring is verifiably live (fail-closed).

    Probes get_overlay() first to avoid stealing focus when the mirror is paused or off:
      - reason in ("not_running", "no_window") -> mirror_not_live (exit 3), no _bring_front
      - live is False -> mirror_not_live (exit 3), no _bring_front
      - live is True  -> _bring_front() (F31), then allow (None)
      - live is None  -> _bring_front(), sleep(0.4), probe again:
        True -> allow; False -> mirror_not_live; still None -> mirror_state_unknown (exit 3).
    """
    overlay = get_overlay()
    if overlay.get("reason") in ("not_running", "no_window"):
        print(_MIRROR_NOT_RUNNING_LINE, file=sys.stderr)
        return 3
    if overlay["live"] is False:
        return _mirror_not_live(overlay)
    if overlay["live"] is True:
        # R18: bringing it forward can take a Space switch; the mirror may stop being live meanwhile
        # (the iPhone was picked up) — so when it was not in front, look again afterwards
        try:
            was_front = _is_front()
        except Exception:
            was_front = False
        try:
            _bring_front()
        except (WindowError, subprocess.TimeoutExpired):
            print(_MIRROR_STATE_UNKNOWN_LINE, file=sys.stderr)
            return 3
        if was_front:
            return None
        overlay = get_overlay()
        if overlay["live"] is True:
            return None
        if overlay["live"] is False:
            return _mirror_not_live(overlay)
        print(_MIRROR_STATE_UNKNOWN_LINE, file=sys.stderr)
        return 3
    try:
        _bring_front()
    except (WindowError, subprocess.TimeoutExpired):
        again = get_overlay()
        if again.get("reason") in ("not_running", "no_window"):
            print(_MIRROR_NOT_RUNNING_LINE, file=sys.stderr)
            return 3
        print(_MIRROR_STATE_UNKNOWN_LINE, file=sys.stderr)
        return 3
    sleep(0.4)
    overlay = get_overlay()
    if overlay.get("reason") in ("not_running", "no_window"):
        print(_MIRROR_NOT_RUNNING_LINE, file=sys.stderr)
        return 3
    if overlay["live"] is True:
        return None
    if overlay["live"] is False:
        return _mirror_not_live(overlay)
    print(_MIRROR_STATE_UNKNOWN_LINE, file=sys.stderr)
    return 3


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
        # expect_not_found; nothing is sent (R19: and the line says so).
        print(_CAPTURE_FAILED_EXPECT_LINE, file=sys.stderr)
        return 7
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


def _invalid_duration(exc: ValueError) -> int:
    print(f"invalid_args: {exc}; nothing was sent", file=sys.stderr)
    return 2


def _cmd_longpress(args) -> int:
    # R19: a bad duration is refused before the mirror is brought forward
    try:
        input._check_duration(_longpress_duration(args), 0.01, 10, "long-press duration (s)")
    except ValueError as exc:
        return _invalid_duration(exc)
    guard = _require_live()
    if guard is not None:
        return guard
    guard = _require_expect(args)
    if guard is not None:
        return guard
    duration = _longpress_duration(args)
    input.long_press(args.x, args.y, duration)
    print(f"long-pressed ({args.x}, {args.y}) for {duration}s")
    return 0


def _longpress_duration(args) -> float:
    opt = getattr(args, "duration_opt", None)
    pos = getattr(args, "duration", None)
    return opt if opt is not None else pos if pos is not None else 0.8


def _cmd_swipe(args) -> int:
    try:
        input._check_duration(args.ms, *input.SWIPE_MS_RANGE, "swipe duration (ms)")
    except ValueError as exc:
        return _invalid_duration(exc)
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
    guard = _require_live()
    if guard is not None:
        return guard
    gestures.home()
    print("home gesture sent")
    return 0


def _cmd_app_switcher(_args) -> int:
    guard = _require_live()
    if guard is not None:
        return guard
    gestures.app_switcher()
    print("app switcher gesture sent")
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
    report = {}
    if input.type_text(args.text, replace=args.replace, report=report):
        if report.get("seen", True):
            print(f"typed {len(args.text)} chars")
            return 0
        if _late_paste_probe(args.text) is None:
            # one character: OCR cannot read it back, only the picture changed
            print(f"typed {len(args.text)} chars (the screen changed after the paste, but "
                  "OCR cannot read this text back — check the field; the clipboard still "
                  "holds the typed text)")
            return 0
        # device run 2026-11-06: only the picture changed (a selection highlight, a
        # results list redraw) and OCR never saw the text — watch for it like an
        # unconfirmed paste instead of reporting it typed
    count_before = report.get("count_before")
    late = _watch_late_paste(args.text, baseline=count_before)
    if late is not None:
        # F38: the paste did land, just late — report it so the caller does not
        # retype it. The clipboard is deliberately NOT restored here: type_text()
        # restores only under its own checks (a rise seen inside its window, the
        # minimum hold, an untouched changeCount); after the fact, leaving the
        # typed text on the clipboard is the choice that can never hand the phone
        # the user's original clipboard (possibly a password).
        print(f"typed {len(args.text)} chars (the paste showed up late, during an extra "
              f"{late:.0f}s check after the 2.5s confirmation window; the clipboard "
              "still holds the typed text)")
        return 0
    watched = (f" or a further {LATE_PASTE_WATCH_S:.0f}s check"
               if _late_paste_probe(args.text) else
               " (one-character text cannot be confirmed by OCR afterwards)")
    if args.replace and count_before:
        # F41: the text was on screen before the paste, and a field replaced with
        # the same text shows no change at all
        advice = ("the text was already on screen before this paste, and replacing a "
                  "field with the same text shows no change — read the screen "
                  "(phone_ocr / phone_screenshot): if the field shows the text, it "
                  "holds it")
    else:
        advice = ("it may still land: read the screen (phone_ocr / phone_screenshot) "
                  "before typing again, or retype with replace=true")
    print(
        "type_not_confirmed: the paste did not show on screen within the 2.5s "
        f"confirmation window{watched} — {advice}; the clipboard still holds the "
        "typed text and your previous clipboard was not restored",
        file=sys.stderr,
    )
    return 4


# F38 (2026-11-05 real-device): a paste reported unconfirmed after 2.5 s showed up a
# few seconds later, and the caller's retry typed the text twice ("… case … case").
# Before type_not_confirmed, keep watching — read-only, no second Cmd+V — for up to
# this long.
# F42: on the device a paste reached the phone up to more than 10 s after Cmd+V.
LATE_PASTE_WATCH_S = 15.0  # needs two consecutive sightings ~1 s apart


def _late_paste_probe(text):
    """The OCR probe for ``text``, or None when OCR cannot confirm it (< 2 chars)."""
    return verify.text_probe(text)


def _watch_late_paste(text, *, baseline=None, read_screen=None, sleep=time.sleep,
                      clock=time.monotonic, watch_s=LATE_PASTE_WATCH_S):
    """Seconds into the watch until ``text`` showed up on screen, or None.

    Read-only: it never pastes again. ``baseline`` is type_text()'s pre-paste
    count of the text's probe (F41); the paste counts as arrived once the count
    is above it in TWO consecutive readable frames (one OCR misread is not
    enough). Without a baseline (type_text() could not read the screen before
    the paste) the watch's own first two readable frames set it — the higher
    count, as in type_text(): text already on screen elsewhere is then never
    taken for the paste, at the price of missing a paste that landed before
    those frames (reported unconfirmed — the caller is told to read the
    screen before typing again). Text too short for a probe is
    not watched at all (None at once). A capture failure breaks the run of
    sightings (F25), never counts as one. ``read_screen``, ``sleep`` and
    ``clock`` are injectable for tests.
    """
    if _late_paste_probe(text) is None:
        return None
    if read_screen is None:
        read_screen = vision.read_screen
    floor = baseline
    floor_reads = []  # without a baseline: the counts of the first two readable frames
    t0 = clock()
    run = 0
    # a first sighting always gets its confirming read, even past the window,
    # and that read follows after a short pause rather than the usual second
    while clock() - t0 < watch_s or run == 1:
        try:
            hits = read_screen()
        except Exception as exc:
            if not verify.is_capture_error(exc):
                raise
            hits = None
        if hits is None:
            run = 0
        else:
            seen = verify.probe_count(text, hits)
            if floor is None:
                floor_reads.append(seen)  # no pre-paste count: these frames set the floor
                if len(floor_reads) == 2:
                    floor = max(floor_reads)
            elif seen > floor:
                run += 1
                if run >= 2:
                    return clock() - t0
            else:
                run = 0
        sleep(0.4 if run == 1 else 1.0)
    return None


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


def _open_deadline_kwargs(now=time.time) -> dict:
    """open_app's time budget from NORACU_OPEN_DEADLINE_EPOCH, an absolute time the
    server sets well before its own timeout (counted from the spawn, so start-up
    and opening Spotlight are inside it). {} → open_app's default."""
    try:
        epoch = float(os.environ.get("NORACU_OPEN_DEADLINE_EPOCH", ""))
    except ValueError:
        return {}
    if not math.isfinite(epoch) or epoch <= 0:  # NaN, inf or nonsense
        return {}
    # already past → 0: open_app goes back to the Home Screen without clearing or typing
    return {"deadline_s": max(0.0, epoch - now())}


def _cmd_open(args) -> int:
    guard = _require_live()
    if guard is not None:
        return guard
    # Open Spotlight here (not inside open_app) so a failure can be
    # reported as its own condition instead of a bogus "app not found".
    # Stopped from outside (SIGTERM → SystemExit): no tidy-up trip of its own. Going Home from here
    # would bring the mirror forward and send a Cmd chord while the server may be stopping (and a
    # SIGKILL 1.5 s later could leave Cmd held); after a timeout the server returns the phone to the
    # Home Screen itself through the mirror's menu (no focus change, no chord).
    return _open_and_report(args)


def _open_and_report(args) -> int:
    tidy = {}  # open_app records whether its trip back to the Home Screen worked
    try:
        # F34: one retry — on the device the Spotlight command was once
        # ignored right after an app closed. Each try goes Home first; when Home
        # lands back in Spotlight (iOS 27, F43) the gate reports it open instead
        # of toggling it shut.
        if not (gestures.open_spotlight_checked()
                or gestures.open_spotlight_checked()):
            result = "spotlight_unavailable"
        else:
            result = gestures.open_app(args.app, spotlight_open=True, report=tidy,
                                       **_open_deadline_kwargs())
    except (WindowError, CaptureError):
        # F25: the Spotlight gate and the result matching both read the
        # mirroring window's pixels; without them nothing about the
        # phone is known — refuse rather than guess.
        return _capture_failed()
    if result == "opened":
        print(f"opened {args.app!r}")
        return 0
    # every unsuccessful path ends with a trip back to the Home Screen; say so only
    # when it worked
    home_note = ("back on the Home Screen" if tidy.get("home") else
                 "could not go back to the Home Screen — Spotlight may still be open")
    # the app-not-found lines mention the Home Screen only when the trip back failed
    stuck = "" if tidy.get("home") else f"; {home_note}"
    if result == "not_found":
        print(f"app not found: {args.app!r} (Spotlight's Top Hit did not show exactly "
              f"this name — use the name the phone shows under the app icon){stuck}")
        return 1
    if result == "no_top_hit":
        if os.environ.get("NORACU_TOPHIT_LABELS", "").strip():
            print(f"app not found: {args.app!r} (Spotlight showed no Top Hit labelled "
                  f"{', '.join(repr(x) for x in gestures.TOP_HIT_LABELS)} — no app by that "
                  f"name, or NORACU_TOPHIT_LABELS does not match your iPhone's label){stuck}")
        else:
            print(f"app not found: {args.app!r} (Spotlight showed no Top Hit — no app by that "
                  "name, or the iPhone is not set to English: phone_open reads Spotlight's "
                  f"\"Top Hit\" label; set NORACU_TOPHIT_LABELS to the label your iPhone shows){stuck}")
        return 1
    if result == "deadline":
        print(f"open_not_confirmed: ran out of time opening {args.app!r} (the Mac may be "
              f"under heavy load); {home_note}", file=sys.stderr)
        return 4
    if result == "not_typed":
        print(f"open_not_confirmed: the name {args.app!r} was pasted into Spotlight but never "
              "showed up on the phone (a paste can take several seconds to reach the iPhone, "
              "or be lost; an iPhone not set to English also needs NORACU_TOPHIT_LABELS) — "
              f"nothing was tapped; {home_note}; retry phone_open", file=sys.stderr)
        return 4
    if result == "spotlight_unavailable":
        print("spotlight unavailable (could not reach the Home Screen, the menu command failed, or the screen did not change)")
        return 1
    # "not_confirmed" (F24): the row — and possibly the Top Hit icon —
    # was tapped but the app never verifiably opened; the phone is
    # back on the Home Screen.
    print(f"open_not_confirmed: tapped {args.app!r} in Spotlight but the app did not open; {home_note}", file=sys.stderr)
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
    guard = _require_live()
    if guard is not None:
        return guard
    ok = verify.verify_action(actions[args.action])
    print("screen changed: yes" if ok else "screen changed: NO (action may have been dropped)")
    return 0 if ok else 1


def _cmd_launch(_args) -> int:
    live = gestures.launch()
    if live is False:
        # F29: never report "ready" while the overlay is still up.
        from .window import is_setup_screen

        if is_setup_screen():
            # F37: a welcome / setup screen is the user's to finish; nothing was clicked.
            print(
                "mirror_setup_required: iPhone Mirroring is showing a setup or welcome "
                "screen (its window is not phone-shaped) — finish it in the iPhone "
                "Mirroring window yourself (noracu never clicks through setup screens), "
                "then call phone_launch again",
                file=sys.stderr,
            )
            return 3
        print(
            "mirror_not_live: iPhone Mirroring is not live yet — if it shows a paused "
            "notice, lock the iPhone and keep it near the Mac; if it is reconnecting, wait "
            "a few seconds and check phone_status; then call phone_launch again",
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
    # positional (older callers) or --duration; argparse would let the positional's default overwrite
    # the option, so they land in separate fields and _cmd_longpress picks one
    sp.add_argument("duration", nargs="?", type=float, default=None)
    sp.add_argument("--duration", dest="duration_opt", type=float, default=None)
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


def _stdin_values(args) -> None:
    # type / find / open take their text as "-" to read it from stdin: text in argv is visible to every
    # local user in the process list while imctl runs
    for field in ("text", "app"):
        if getattr(args, field, None) == "-" and getattr(args, "command", None) in ("type", "find", "open"):
            setattr(args, field, sys.stdin.read())


def main(argv: list[str] | None = None) -> int:
    signal.signal(signal.SIGTERM, _on_sigterm)
    parser = build_parser()
    args = parser.parse_args(argv)
    _stdin_values(args)
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

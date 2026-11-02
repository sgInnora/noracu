"""Smoke tests — no iPhone required.

These validate argument parsing, window math, and the ease curve.
They do NOT synthesize input events (that requires a live mirroring
session and Accessibility permissions).
"""

import math
import subprocess
import sys

sys.path.insert(0, "src")

from imctl.window import WindowBounds, parse_overlay
from imctl.input import _ease_in_out
from imctl.cli import build_parser


def test_denormalize():
    b = WindowBounds(x=100, y=200, width=300, height=600)
    assert b.denormalize(0, 0) == (100, 200)
    assert b.denormalize(1, 1) == (400, 800)
    assert b.denormalize(0.5, 0.5) == (250, 500)
    try:
        b.denormalize(1.5, 0.5)
        assert False, "should reject out-of-range"
    except ValueError:
        pass


def test_center():
    b = WindowBounds(x=0, y=0, width=326, height=720)
    assert b.center == (163, 360)


def test_ease_curve():
    assert _ease_in_out(0.0) == 0.0
    assert _ease_in_out(1.0) == 1.0
    assert abs(_ease_in_out(0.5) - 0.5) < 1e-9
    # monotonic non-decreasing
    prev = 0.0
    for i in range(1, 101):
        v = _ease_in_out(i / 100)
        assert v >= prev - 1e-12
        prev = v


def test_parser_builds():
    p = build_parser()
    args = p.parse_args(["tap", "0.5", "0.5"])
    assert args.command == "tap" and args.x == 0.5
    args = p.parse_args(["swipe", "0.5", "0.8", "0.5", "0.2", "--ms", "250"])
    assert args.ms == 250
    args = p.parse_args(["type", "hello world"])
    assert args.text == "hello world"


def test_parse_overlay():
    # live: group 1 has no children (script returns an empty string)
    assert parse_overlay("") == {"live": True, "overlay": None, "buttons": 0}
    # paused: image + static text + button under group 1
    raw = "image\t\nstatic text\tConnection Paused\nbutton\t\n"
    assert parse_overlay(raw) == {
        "live": False,
        "overlay": "Connection Paused",
        "buttons": 1,
    }
    # transitional: only a static text (e.g. "Connecting to iPhone …"), no button
    raw = "static text\tConnecting to iPhone\n"
    assert parse_overlay(raw) == {
        "live": False,
        "overlay": "Connecting to iPhone",
        "buttons": 0,
    }
    # unknown states: no window / no group / unparseable output
    assert parse_overlay("NO_WINDOW") == {"live": None, "overlay": None, "buttons": 0}
    assert parse_overlay("NO_GROUP") == {"live": None, "overlay": None, "buttons": 0}
    assert parse_overlay("garbage without tabs") == {
        "live": None,
        "overlay": None,
        "buttons": 0,
    }
    # multiple static texts are joined with " / "
    raw = "static text\tOne\nstatic text\tTwo\n"
    assert parse_overlay(raw) == {"live": False, "overlay": "One / Two", "buttons": 0}


def test_choose_app_hit():
    from imctl.gestures import choose_app_hit
    from imctl.vision import OCRHit

    def hit(text, ny, nx=0.5, confidence=0.9):
        return OCRHit(text=text, nx=nx, ny=ny, confidence=confidence)

    # ① the typed query echoes in the bottom search field (ny≈0.95) —
    #    only a result row above it (ny<0.88) counts; topmost row wins.
    hits = [hit("Calculator", 0.95), hit("Calculator", 0.30), hit("Calculator", 0.50)]
    assert choose_app_hit(hits, "Calculator").ny == 0.30
    # ② only the search field matches → nothing to tap
    assert choose_app_hit([hit("Calculator", 0.95)], "Calculator") is None
    # ③ case and surrounding whitespace don't matter
    assert choose_app_hit([hit(" calculator ", 0.40)], "Calculator").ny == 0.40
    assert choose_app_hit([hit("Calculator", 0.40)], "  CALCULATOR ").ny == 0.40
    # ④ partial matches are not the app
    assert choose_app_hit([hit("Calculator Pro", 0.30)], "Calculator") is None
    # no hits at all
    assert choose_app_hit([], "Calculator") is None


def test_scroll_steps():
    from imctl.input import scroll_steps
    d = scroll_steps(-432, 24)
    assert len(d) == 24 and sum(d) == -432
    assert all(-19 <= x <= -17 for x in d)
    assert sum(scroll_steps(100.4, 7)) == 100 and len(scroll_steps(10, 2)) == 4


if __name__ == "__main__":
    test_denormalize()
    test_center()
    test_ease_curve()
    test_parser_builds()
    test_parse_overlay()
    test_choose_app_hit()
    test_scroll_steps()
    print("all smoke tests passed")

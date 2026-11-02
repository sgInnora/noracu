"""Smoke tests — no iPhone required.

These validate argument parsing, window math, and the ease curve.
They do NOT synthesize input events (that requires a live mirroring
session and Accessibility permissions).
"""

import math
import subprocess
import sys

sys.path.insert(0, "src")

from imctl.window import WindowBounds
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


if __name__ == "__main__":
    test_denormalize()
    test_center()
    test_ease_curve()
    test_parser_builds()
    print("all smoke tests passed")

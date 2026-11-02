"""Pixel-level action verification.

Each gesture is followed by a screenshot hash comparison to confirm the
screen actually changed. This closes the loop: an action that reports
success but leaves the screen identical is a dropped event, and callers
should retry or re-observe — the same observe-act-re-observe discipline
that OpenAI's Computer Use enforces with its revision mechanism.
"""

from __future__ import annotations

import hashlib
import subprocess
import tempfile
from dataclasses import dataclass

from .window import get_bounds


@dataclass(frozen=True)
class ScreenState:
    """A fingerprint of the mirroring window content."""

    md5: str
    width: int
    height: int


def capture_hash() -> ScreenState:
    """Capture the window and return a content fingerprint.

    The hash is computed over a downsampled copy: full-resolution
    hashes are sensitive to video-stream noise (compression flicker)
    even when nothing meaningful changed.
    """
    b = get_bounds()
    raw = tempfile.mktemp(prefix="imctl_verify_", suffix=".png")
    small = tempfile.mktemp(prefix="imctl_verify_s_", suffix=".png")
    try:
        subprocess.run(
            ["screencapture", "-x", f"-R{b.x},{b.y},{b.width},{b.height}", raw],
            check=True,
            timeout=10,
        )
        # Downsample to ~163x360 (half window) to suppress stream noise.
        subprocess.run(
            ["sips", "-z", "360", "163", raw, "--out", small],
            check=True,
            capture_output=True,
            timeout=10,
        )
        with open(small, "rb") as f:
            digest = hashlib.md5(f.read()).hexdigest()
        return ScreenState(md5=digest, width=b.width, height=b.height)
    finally:
        subprocess.run(["rm", "-f", raw, small], capture_output=True)


def changed(before: ScreenState, after: ScreenState) -> bool:
    """True if the screen content differs between two states."""
    return before.md5 != after.md5


def verify_action(action, *args, settle_s: float = 1.5, **kwargs) -> bool:
    """Run an action and report whether the screen changed.

    Usage:
        ok = verify_action(gestures.home)
    Returns True if the screen content changed after the action.
    """
    before = capture_hash()
    action(*args, **kwargs)
    import time

    time.sleep(settle_s)
    after = capture_hash()
    return changed(before, after)

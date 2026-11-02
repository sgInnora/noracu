"""High-level gestures composed from the input engine.

These map to standard iOS interactions. Coordinates are normalized
(0-1) within the mirroring window. Gesture start points were chosen to
match iOS conventions (e.g. home swipe starts at the very bottom edge).
"""

from __future__ import annotations

from . import input as inp
from . import vision
from .window import ensure_running, get_bounds


class GestureError(RuntimeError):
    """Raised when a composed gesture cannot complete."""


def home() -> None:
    """Swipe up from near the bottom edge: go to the home screen.

    Starts at 0.90 height: the bottom ~7% of the mirroring window is
    macOS window chrome (rounded corners / resize area), not the video
    surface — events there never reach the phone. 0.90 is the lowest
    point that reliably lands on the iOS home-indicator zone.
    """
    inp.swipe(0.5, 0.90, 0.5, 0.10, duration_ms=300)


def app_switcher() -> None:
    """Swipe up and hold: open the app switcher."""
    b = get_bounds()
    from Quartz import (
        CGEventCreateMouseEvent, CGEventPost, CGEventSourceCreate,
        kCGEventLeftMouseDown, kCGEventLeftMouseUp, kCGEventLeftMouseDragged,
        kCGEventSourceStateHIDSystemState, kCGHIDEventTap, kCGMouseButtonLeft,
    )
    import time

    x0, y0 = b.denormalize(0.5, 0.90)
    x1, y1 = b.denormalize(0.5, 0.45)
    src = CGEventSourceCreate(kCGEventSourceStateHIDSystemState)

    def ev(kind, x, y):
        CGEventPost(kCGHIDEventTap,
                    CGEventCreateMouseEvent(src, kind, (x, y), kCGMouseButtonLeft))

    ev(kCGEventLeftMouseDown, x0, y0)
    time.sleep(0.02)
    # Eased drag to mid-screen.
    steps = 15
    for i in range(1, steps + 1):
        t = i / steps
        e = t * t * (3 - 2 * t)  # smoothstep
        ev(kCGEventLeftMouseDragged, x0 + (x1 - x0) * e, y0 + (y1 - y0) * e)
        time.sleep(0.016)
    time.sleep(0.55)  # hold to trigger the switcher
    ev(kCGEventLeftMouseUp, x1, y1)


def scroll_down(distance: float = 0.5) -> None:
    """Scroll content down (swipe up) by a normalized distance."""
    start = min(0.9, 0.4 + distance / 2)
    inp.swipe(0.5, start, 0.5, start - distance, duration_ms=300)


def scroll_up(distance: float = 0.5) -> None:
    """Scroll content up (swipe down) by a normalized distance."""
    start = max(0.1, 0.6 - distance / 2)
    inp.swipe(0.5, start, 0.5, start + distance, duration_ms=300)


def page_left() -> None:
    """Swipe right-to-left: go to the next home-screen page."""
    inp.swipe(0.8, 0.5, 0.2, 0.5, duration_ms=280)


def page_right() -> None:
    """Swipe left-to-right: go to the previous home-screen page."""
    inp.swipe(0.2, 0.5, 0.8, 0.5, duration_ms=280)


def pull_down_search() -> None:
    """Swipe down from mid-screen: open Spotlight search."""
    inp.swipe(0.5, 0.25, 0.5, 0.75, duration_ms=280)


def open_app(name: str) -> bool:
    """Open an app by name via Spotlight + OCR + tap.

    Returns True if the app name was found on screen after typing.
    """
    pull_down_search()
    import time

    time.sleep(1.0)
    inp.type_text(name)
    time.sleep(1.5)  # wait for Spotlight results

    hit = vision.find(name)
    if hit is None:
        return False
    inp.tap(hit.nx, hit.ny)
    time.sleep(1.0)
    return True


def read_text() -> list:
    """OCR the current screen; returns vision.OCRHit list."""
    return vision.read_screen()


def status() -> dict:
    """Return a status dict for the mirroring session.

    Keys: running; and when running: window {x,y,w,h} (AX bounds), window_id, onscreen, frontmost,
    live (True/False/null — is the phone stream up), overlay (text shown over the stream when not
    live, e.g. a paused/connecting notice), paused (True/False, or null when the state is unknown).
    """
    from .window import (
        get_overlay, get_window_info, is_frontmost, is_paused, is_running,
    )

    running = is_running()
    info = {"running": running}
    if running:
        try:
            b = get_bounds()
            info["window"] = {"x": b.x, "y": b.y, "w": b.width, "h": b.height}
        except Exception as exc:
            info["window_error"] = str(exc)
        wi = get_window_info()
        if wi:
            info["window_id"] = wi["id"]
            info["onscreen"] = wi["onscreen"]
        info["frontmost"] = is_frontmost()
        overlay = get_overlay()
        info["live"] = overlay["live"]
        info["overlay"] = overlay["overlay"]
        info["paused"] = is_paused(overlay)
    return info


def resume() -> bool:
    """Resume a paused mirroring session (clicks Resume). Returns True when not paused afterwards."""
    from .window import resume as _resume

    return _resume()


def launch() -> None:
    """Ensure iPhone Mirroring is running, frontmost, and not paused."""
    ensure_running()
    from .window import ensure_frontmost, resume as _resume

    ensure_frontmost()
    _resume()

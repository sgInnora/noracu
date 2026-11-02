"""High-level gestures composed from the input engine.

These map to standard iOS interactions. Coordinates are normalized
(0-1) within the mirroring window. Gesture start points were chosen to
match iOS conventions (e.g. home swipe starts at the very bottom edge).

Phone-level actions that the mirroring app exposes as menu commands
(Spotlight, Home Screen) are triggered through those menus rather than
synthesized touch gestures — see the menu-command section below.
"""

from __future__ import annotations

import subprocess
import time

from . import input as inp
from . import vision
from .window import WindowError, ensure_frontmost, ensure_running, get_bounds


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


# Wheel pixels per window point of list movement, measured on iPhone Mirroring
# (Settings list, 524 pt window: between 1.1 and 1.6 px/pt across runs).
_SCROLL_PX_PER_PT = 1.3


def scroll_down(distance: float = 0.5) -> None:
    """Reveal content further down a list by about `distance` window heights.

    Uses trackpad-style scroll events; a vertical mouse drag does not scroll
    lists in iPhone Mirroring (F16). Swipes stay for gestures such as paging.
    """
    b = get_bounds()
    inp.scroll_trackpad(-distance * b.height * _SCROLL_PX_PER_PT, bounds=b)


def scroll_up(distance: float = 0.5) -> None:
    """Reveal content further up a list by about `distance` window heights."""
    b = get_bounds()
    inp.scroll_trackpad(distance * b.height * _SCROLL_PX_PER_PT, bounds=b)


def page_left() -> None:
    """Swipe right-to-left: go to the next home-screen page."""
    inp.swipe(0.8, 0.5, 0.2, 0.5, duration_ms=280)


def page_right() -> None:
    """Swipe left-to-right: go to the previous home-screen page."""
    inp.swipe(0.2, 0.5, 0.8, 0.5, duration_ms=280)


def pull_down_search() -> None:
    """Swipe down from mid-screen (DEPRECATED — never use for Spotlight).

    F13: iOS sometimes reads this swipe as an icon long-press-drag, which
    drops the home screen into edit (jiggle) mode — a stray tap on a "−"
    badge there offers to DELETE apps. open_spotlight() replaces it.
    Kept only as a raw gesture primitive; nothing in imctl calls it.
    """
    inp.swipe(0.5, 0.25, 0.5, 0.75, duration_ms=280)


# --- iPhone Mirroring menu commands -----------------------------------------
#
# The View menu of iPhone Mirroring exposes phone-level actions (Home
# Screen, App Switcher, Spotlight) as real menu commands, which iOS
# cannot misread as touch gestures. We trigger them by keyboard shortcut
# when one is readable — language-independent, because the shortcut
# character (AXMenuItemCmdChar), not the localized menu title, drives
# it — and fall back to clicking the English menu item.

# Static AppleScript only (invariant 1): script text is fixed; the menu
# item name travels as an osascript argument, never interpolated.
_MENU_SHORTCUT_SCRIPT = '''
on run(argv)
    tell application "System Events"
        tell process "iPhone Mirroring"
            set cc to ""
            set cm to ""
            try
                set cc to (value of attribute "AXMenuItemCmdChar" of menu item (item 1 of argv) of menu 1 of menu bar item "View" of menu bar 1) as text
            end try
            try
                set cm to (value of attribute "AXMenuItemCmdModifiers" of menu item (item 1 of argv) of menu 1 of menu bar item "View" of menu bar 1) as text
            end try
            return cc & "," & cm
        end tell
    end tell
end run
'''

_CLICK_MENU_ITEM_SCRIPT = '''
on run(argv)
    tell application "System Events"
        tell process "iPhone Mirroring"
            click menu item (item 1 of argv) of menu 1 of menu bar item "View" of menu bar 1
        end tell
    end tell
end run
'''


def _run_osascript(script: str, args: list[str] | None = None) -> str:
    """Run a static AppleScript; runtime values go through argv only."""
    cmd = ["osascript", "-e", script]
    if args:
        cmd += ["--"] + args
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
    if result.returncode != 0:
        raise GestureError(f"osascript failed: {result.stderr.strip()}")
    return result.stdout.strip()


def _view_menu_shortcut(item: str) -> tuple[str, int] | None:
    """Read a View menu item's shortcut — read-only, never clicks.

    Returns (cmdChar, cmdModifiers), or None when unreadable.
    AXMenuItemCmdModifiers uses the Carbon menu-modifier bits: 0 means
    the Command key alone (Spotlight is Cmd+3 here), 1 adds Shift,
    8 means no key equivalent at all.
    """
    try:
        raw = _run_osascript(_MENU_SHORTCUT_SCRIPT, [item])
    except (GestureError, OSError, subprocess.TimeoutExpired):
        return None
    char, sep, mods = raw.partition(",")
    if not sep:
        return None
    try:
        return char, int(mods.strip())
    except ValueError:  # "missing value" / empty — no usable shortcut
        return None


def _run_view_menu_command(item: str) -> bool:
    """Trigger a View menu command of iPhone Mirroring.

    Primary: the item's shortcut as a real Command chord (works on any
    UI language). Fallback: clicking the English menu item. Returns
    False when neither path works (app not running, localized menus…).
    """
    shortcut = _view_menu_shortcut(item)
    if shortcut is not None:
        char, mods = shortcut
        keycode = inp.keycode_for_char(char) if mods == 0 else None
        if keycode is not None:
            try:
                ensure_frontmost()
                inp._cmd_chord(keycode)
                return True
            except (inp.InputError, WindowError):
                pass  # fall through to clicking the menu item
    try:
        ensure_frontmost()
        _run_osascript(_CLICK_MENU_ITEM_SCRIPT, [item])
        return True
    except (GestureError, OSError, subprocess.TimeoutExpired, WindowError):
        return False


def open_spotlight() -> bool:
    """Open the phone's Spotlight search (View ▸ Spotlight).

    Never a swipe: the old pull-down could be misread by iOS as a
    long-press-drag that triggers home-screen edit mode (F13).
    """
    return _run_view_menu_command("Spotlight")


def choose_app_hit(hits: list, name: str) -> vision.OCRHit | None:
    """Pick the Spotlight result row for ``name`` from OCR hits.

    iOS 26 draws the Spotlight search field at the BOTTOM of the screen
    (ny ≈ 0.95) and echoes the typed query inside it, so a plain text
    match finds the field itself. A result row must:
      - equal ``name`` case-insensitively after stripping whitespace, and
      - lie above the bottom search-field zone (ny < 0.88).
    When several rows match, the topmost (smallest ny) wins. Returns
    None when nothing qualifies.
    """
    want = name.strip().lower()
    best = None
    for hit in hits:
        if hit.text.strip().lower() != want:
            continue
        if hit.ny >= 0.88:
            continue  # the search field echoing the query
        if best is None or hit.ny < best.ny:
            best = hit
    return best


def open_app(name: str, *, spotlight_open: bool = False) -> bool:
    """Open an app by name: Spotlight → type → OCR → tap the result row.

    ``spotlight_open`` lets a caller that already ran open_spotlight()
    itself (to tell "spotlight unavailable" apart from "app not found")
    skip the internal call. Returns True when a row matching ``name``
    was tapped; False when Spotlight could not be opened or no row
    matched (after returning to the home screen).

    The top hit is never opened with Return — it may belong to a
    different app than the requested one.
    """
    if not spotlight_open and not open_spotlight():
        return False
    time.sleep(1.0)
    inp.type_text(name)
    time.sleep(1.5)  # wait for Spotlight results

    hit = choose_app_hit(vision.read_screen(), name)
    if hit is None:
        # Leave the phone tidy: back to the home screen (View ▸ Home Screen).
        _run_view_menu_command("Home Screen")
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

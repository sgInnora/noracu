"""CGEvent input engine for iPhone Mirroring.

All input is delivered as synthesized CoreGraphics events posted to the
HID event tap. The iPhone Mirroring app translates these into touch
events on the phone.

Empirically-validated parameters (see project README for the test
methodology):

- TAP_INTERVAL_S = 0.05  — minimum down/up interval that the mirroring
  gesture recognizer registers reliably. Faster taps are sometimes
  dropped.
- SWIPE_STEPS = 20      — number of interpolated drag points. A single
  dd/dm/du drag (e.g. via cliclick) is NOT recognized as a swipe by
  iPhone Mirroring; stepped drags are.
- SWIPE_NUDGE_PX = 3    — an initial small movement right after
  mouse-down. Without it, the recognizer sometimes classifies the
  gesture as an icon long-press-drag instead of a scroll swipe.
- Ease-in-out curve     — quadratic ease matches how a human finger
  decelerates, which keeps the gesture inside the recognizer's
  velocity window.
"""

from __future__ import annotations

import time

from Quartz import (
    CGEventCreateMouseEvent,
    CGEventPost,
    CGEventSetIntegerValueField,
    CGEventSourceCreate,
    kCGEventLeftMouseDown,
    kCGEventLeftMouseUp,
    kCGEventLeftMouseDragged,
    kCGEventSourceStateHIDSystemState,
    kCGHIDEventTap,
    kCGMouseButtonLeft,
    kCGEventFlagMaskCommand,
    CGEventCreateKeyboardEvent,
    CGEventSetFlags,
)

from .window import WindowBounds, ensure_frontmost, get_bounds

TAP_INTERVAL_S = 0.05
LONG_PRESS_S = 0.8
SWIPE_STEPS = 20
SWIPE_NUDGE_PX = 3
SWIPE_DEFAULT_MS = 300


class InputError(RuntimeError):
    """Raised when a synthesized input event cannot be delivered."""


def _source():
    return CGEventSourceCreate(kCGEventSourceStateHIDSystemState)


def _mouse_event(kind: int, x: float, y: float, source) -> None:
    event = CGEventCreateMouseEvent(
        source, kind, (x, y), kCGMouseButtonLeft
    )
    if event is None:
        raise InputError(f"CGEventCreateMouseEvent returned None for {kind}")
    CGEventPost(kCGHIDEventTap, event)


def _key_event(keycode: int, down: bool, source) -> None:
    event = CGEventCreateKeyboardEvent(source, keycode, down)
    if event is None:
        raise InputError(f"CGEventCreateKeyboardEvent returned None for {keycode}")
    CGEventPost(kCGHIDEventTap, event)


# --- Pointer primitives ---------------------------------------------------


def tap(nx: float = 0.5, ny: float = 0.5, bounds: WindowBounds | None = None) -> None:
    """Tap at normalized coordinates (0-1) within the mirroring window."""
    ensure_frontmost()
    b = bounds or get_bounds()
    x, y = b.denormalize(nx, ny)
    src = _source()
    _mouse_event(kCGEventLeftMouseDown, x, y, src)
    time.sleep(TAP_INTERVAL_S)
    _mouse_event(kCGEventLeftMouseUp, x, y, src)


def long_press(nx: float = 0.5, ny: float = 0.5, duration_s: float = LONG_PRESS_S,
               bounds: WindowBounds | None = None) -> None:
    """Press and hold at normalized coordinates."""
    ensure_frontmost()
    b = bounds or get_bounds()
    x, y = b.denormalize(nx, ny)
    src = _source()
    _mouse_event(kCGEventLeftMouseDown, x, y, src)
    time.sleep(duration_s)
    _mouse_event(kCGEventLeftMouseUp, x, y, src)


def _ease_in_out(t: float) -> float:
    """Quadratic ease-in-out: slow start, fast middle, slow end."""
    if t < 0.5:
        return 2.0 * t * t
    return 1.0 - ((-2.0 * t + 2.0) ** 2) / 2.0


def swipe(from_x: float, from_y: float, to_x: float, to_y: float,
          duration_ms: int = SWIPE_DEFAULT_MS,
          bounds: WindowBounds | None = None) -> None:
    """Swipe between two normalized points with eased interpolation.

    The gesture is: mouse-down, 3px nudge, 20 eased drag steps,
    mouse-up. This is the shape iPhone Mirroring's recognizer accepts.
    """
    ensure_frontmost()
    b = bounds or get_bounds()
    x0, y0 = b.denormalize(from_x, from_y)
    x1, y1 = b.denormalize(to_x, to_y)

    src = _source()
    step_delay = (duration_ms / 1000.0) / SWIPE_STEPS

    _mouse_event(kCGEventLeftMouseDown, x0, y0, src)
    time.sleep(0.02)

    # Initial nudge: disambiguates swipe from long-press-drag.
    dx = 1 if x1 >= x0 else -1
    dy = 1 if y1 >= y0 else -1
    _mouse_event(kCGEventLeftMouseDragged, x0 + dx * SWIPE_NUDGE_PX,
                 y0 + dy * SWIPE_NUDGE_PX, src)
    time.sleep(0.01)

    for i in range(1, SWIPE_STEPS + 1):
        t = i / SWIPE_STEPS
        e = _ease_in_out(t)
        cx = x0 + (x1 - x0) * e
        cy = y0 + (y1 - y0) * e
        _mouse_event(kCGEventLeftMouseDragged, cx, cy, src)
        time.sleep(step_delay)

    _mouse_event(kCGEventLeftMouseUp, x1, y1, src)


def scroll(dy_pixels: int, nx: float = 0.5, ny: float = 0.5,
           bounds: WindowBounds | None = None) -> None:
    """Scroll vertically at a position. Positive dy scrolls up."""
    from Quartz import CGEventCreateScrollWheelEvent

    ensure_frontmost()
    b = bounds or get_bounds()
    x, y = b.denormalize(nx, ny)
    src = _source()
    # Axis 1 = vertical; pixel units; negative = scroll down (content up).
    event = CGEventCreateScrollWheelEvent(
        src, kCGScrollEventUnitPixel, 1, dy_pixels
    )
    if event is None:
        raise InputError("CGEventCreateScrollWheelEvent returned None")
    CGEventPost(kCGHIDEventTap, event)


# --- Keyboard primitives ----------------------------------------------------

# macOS virtual keycodes used by this module.
_VK_RETURN = 36
_VK_DELETE = 51
_VK_ARROW_KEYS = {"up": 126, "down": 125, "left": 123, "right": 124}
_VK_V = 9
_VK_A = 0
_VK_COMMAND = 55

# ANSI keycodes for digits and letters — the characters a menu-item
# shortcut can use as its command char (AXMenuItemCmdChar). Translates
# a shortcut such as Cmd+3 into a keycode for _cmd_chord().
_ANSI_KEYCODES = {
    "0": 29, "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22,
    "7": 26, "8": 28, "9": 25,
    "a": 0, "b": 11, "c": 8, "d": 2, "e": 14, "f": 3, "g": 5, "h": 4,
    "i": 34, "j": 38, "k": 40, "l": 37, "m": 46, "n": 45, "o": 31,
    "p": 35, "q": 12, "r": 15, "s": 1, "t": 17, "u": 32, "v": 9,
    "w": 13, "x": 7, "y": 16, "z": 6,
}


def keycode_for_char(char: str) -> int | None:
    """ANSI virtual keycode for a single digit/letter, else None."""
    if len(char) != 1:
        return None
    return _ANSI_KEYCODES.get(char.lower())


def _cmd_chord(keycode: int) -> None:
    """Send a real Command chord: ⌘ down → key down → key up → ⌘ up.

    iPhone Mirroring forwards the *state* of the physical modifier
    keys, not the per-event flag bits: a target-key event that merely
    carries kCGEventFlagMaskCommand arrives on the phone as an
    unmodified keystroke (F14 — a "Cmd+V" paste typed a literal "v").
    The chord therefore presses the Command key itself, keeps the
    flag set on every event, and releases Command last. ~30ms between
    steps, all events from one shared source.
    """
    ensure_frontmost()
    src = _source()

    def post(code: int, down: bool, flags: int) -> None:
        event = CGEventCreateKeyboardEvent(src, code, down)
        if event is None:
            raise InputError(f"CGEventCreateKeyboardEvent returned None for {code}")
        CGEventSetFlags(event, flags)
        CGEventPost(kCGHIDEventTap, event)

    post(_VK_COMMAND, True, kCGEventFlagMaskCommand)
    time.sleep(0.03)
    post(keycode, True, kCGEventFlagMaskCommand)
    time.sleep(0.03)
    post(keycode, False, kCGEventFlagMaskCommand)
    time.sleep(0.03)
    post(_VK_COMMAND, False, 0)


def press_key(key: str) -> None:
    """Press a single key: 'return', 'delete', 'up', 'down', 'left', 'right'."""
    ensure_frontmost()
    keymap = {"return": _VK_RETURN, "delete": _VK_DELETE, **_VK_ARROW_KEYS}
    if key not in keymap:
        raise InputError(f"unsupported key: {key!r} (supported: {sorted(keymap)})")
    src = _source()
    _key_event(keymap[key], True, src)
    time.sleep(0.02)
    _key_event(keymap[key], False, src)


def type_text(text: str) -> None:
    """Type text via clipboard paste (IME-safe).

    Direct CGEvent keystroke synthesis breaks under CJK IMEs and is
    slow for long strings. Instead we:
      1. save the user's pasteboard,
      2. write the text,
      3. Cmd+V into the focused field,
      4. restore the pasteboard.

    Requires the calling terminal to have Accessibility permission
    (same as every other imctl input).
    """
    from AppKit import NSPasteboard

    ensure_frontmost()
    pb = NSPasteboard.generalPasteboard()
    saved = pb.dataForType_("public.utf8-plain-text")
    saved_change = pb.changeCount()

    try:
        pb.clearContents()
        pb.setString_forType_(text, "public.utf8-plain-text")
        time.sleep(0.05)

        _cmd_chord(_VK_V)  # real ⌘ chord — flags alone reach the phone as "v" (F14)
        time.sleep(0.15)  # let the paste land before restoring
    finally:
        # Restore the user's clipboard only if nothing else changed it.
        if pb.changeCount() == saved_change + 1:
            pb.clearContents()
            if saved is not None:
                pb.setData_forType_(saved, "public.utf8-plain-text")


def clear_text() -> None:
    """Select-all and delete in the focused field."""
    ensure_frontmost()
    _cmd_chord(_VK_A)  # Cmd+A — real chord, same reason as type_text
    time.sleep(0.05)
    src = _source()
    _key_event(_VK_DELETE, True, src)
    time.sleep(0.02)
    _key_event(_VK_DELETE, False, src)

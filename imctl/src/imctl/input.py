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

import math
import time

from Quartz import (
    CGEventCreateMouseEvent,
    CGEventPost,
    CGEventSetIntegerValueField,
    CGEventSourceCreate,
    kCGEventLeftMouseDown,
    kCGEventLeftMouseUp,
    kCGEventLeftMouseDragged,
    kCGEventMouseMoved,
    kCGEventSourceStateHIDSystemState,
    kCGHIDEventTap,
    kCGMouseButtonLeft,
    kCGEventFlagMaskCommand,
    CGEventCreateKeyboardEvent,
    CGEventSetFlags,
)

from . import window
from .window import WindowBounds, ensure_frontmost, get_bounds

TAP_INTERVAL_S = 0.05
LONG_PRESS_S = 0.8
SWIPE_STEPS = 20
SWIPE_NUDGE_PX = 3
SWIPE_DEFAULT_MS = 300


class InputError(RuntimeError):
    """Raised when a synthesized input event cannot be delivered."""


class FocusLost(InputError):
    """Raised when iPhone Mirroring stopped being the frontmost app (F26).

    The frontmost check runs right before every synthesized event; a
    keystroke landing in whatever app took the foreground in the meantime
    (a Cmd+V pasted into a terminal, a Return running a command) is the
    failure this prevents.
    """


# F26: consulted right before every synthesized event. Module-level so
# tests can swap it; window.is_frontmost asks System Events afresh on
# every call (F30: an in-process NSWorkspace answer is a stale snapshot).
_focus_check = window.is_frontmost


def _require_focus() -> None:
    """Refuse to send any event unless iPhone Mirroring is still frontmost (F26)."""
    if not _focus_check():
        raise FocusLost("iPhone Mirroring is not the frontmost app")


def _source():
    return CGEventSourceCreate(kCGEventSourceStateHIDSystemState)


def scroll_steps(total_px: float, steps: int = 24) -> list[int]:
    """Split a scroll distance (wheel pixels) into per-event integer deltas that sum to it."""
    steps = max(4, int(steps))
    target = int(round(total_px))
    out: list[int] = []
    for i in range(1, steps + 1):
        out.append(int(round(target * i / steps)) - sum(out))
    return out


def scroll_trackpad(total_px: float, nx: float = 0.5, ny: float = 0.6,
                    bounds: WindowBounds | None = None) -> None:
    """Scroll like a two-finger trackpad swipe: continuous wheel events with phases.

    iPhone Mirroring turns these into a touch scroll of the list under the cursor
    (F16: a mouse drag scrolls nothing in a list, and a bare wheel event without a
    phase is ignored). Negative total_px moves the content up, revealing what is
    below. The cursor is moved over the mirror first, because scroll events go to
    the window under the cursor.
    """
    ensure_frontmost()
    b = bounds or get_bounds()
    x, y = b.denormalize(nx, ny)
    src = _source()
    _require_focus()  # F26: before the first event
    _mouse_event(kCGEventMouseMoved, x, y, src)
    time.sleep(0.12)
    deltas = scroll_steps(total_px)
    last = len(deltas) - 1
    sent = 1  # events posted so far (the mouse-moved above)
    began = False
    ended = False
    try:
        for i, d in enumerate(deltas):
            if sent % 6 == 0:
                _require_focus()  # F26: every 6 events; drop the rest on focus loss
            phase = 1 if i == 0 else (4 if i == last else 2)
            _scroll_event(src, d, x, y, phase)
            if phase == 1:
                began = True
            elif phase == 4:
                ended = True
            sent += 1
            time.sleep(0.016)
    finally:
        if began and not ended:
            _scroll_event(src, 0, x, y, 4)


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


def _scroll_event(source, delta: int, x: float | None = None, y: float | None = None,
                  phase: int | None = None) -> None:
    """Post one pixel-unit vertical scroll-wheel event.

    scroll_trackpad passes the cursor position and the NSEvent phase
    (continuous gesture; 1 = began, 2 = changed, 4 = ended); scroll()
    posts a bare wheel event with neither.
    """
    from Quartz import (CGEventCreateScrollWheelEvent, CGEventSetLocation,
                        kCGScrollEventUnitPixel, kCGScrollWheelEventIsContinuous,
                        kCGScrollWheelEventScrollPhase)

    event = CGEventCreateScrollWheelEvent(source, kCGScrollEventUnitPixel, 1, delta)
    if event is None:
        raise InputError("CGEventCreateScrollWheelEvent returned None")
    if x is not None:
        CGEventSetLocation(event, (x, y))
    if phase is not None:
        CGEventSetIntegerValueField(event, kCGScrollWheelEventIsContinuous, 1)
        CGEventSetIntegerValueField(event, kCGScrollWheelEventScrollPhase, phase)
    CGEventPost(kCGHIDEventTap, event)


# --- Pointer primitives ---------------------------------------------------


def tap(nx: float = 0.5, ny: float = 0.5, bounds: WindowBounds | None = None) -> None:
    """Tap at normalized coordinates (0-1) within the mirroring window."""
    ensure_frontmost()
    b = bounds or get_bounds()
    x, y = b.denormalize(nx, ny)
    src = _source()
    _require_focus()  # F26: before the first event
    _mouse_event(kCGEventLeftMouseDown, x, y, src)
    try:
        time.sleep(TAP_INTERVAL_S)
    finally:
        _mouse_event(kCGEventLeftMouseUp, x, y, src)


SWIPE_MS_RANGE = (50, 5000)


def _check_duration(value: float, lo: float, hi: float, what: str) -> None:
    # before any event: an invalid duration must not turn into a real press (math.isfinite: no nan/inf;
    # bool is an int subclass in Python, so it is refused by name)
    if not (isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(value) and lo <= value <= hi):
        raise ValueError(f"{what} must be between {lo} and {hi}")


def long_press(nx: float = 0.5, ny: float = 0.5, duration_s: float = LONG_PRESS_S,
               bounds: WindowBounds | None = None) -> None:
    """Press and hold at normalized coordinates."""
    _check_duration(duration_s, 0.01, 10, "long-press duration (s)")
    ensure_frontmost()
    b = bounds or get_bounds()
    x, y = b.denormalize(nx, ny)
    src = _source()
    _require_focus()  # F26: before the press-down
    _mouse_event(kCGEventLeftMouseDown, x, y, src)
    try:
        time.sleep(duration_s)
    finally:
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
    _check_duration(duration_ms, *SWIPE_MS_RANGE, "swipe duration (ms)")
    ensure_frontmost()
    b = bounds or get_bounds()
    x0, y0 = b.denormalize(from_x, from_y)
    x1, y1 = b.denormalize(to_x, to_y)

    src = _source()
    step_delay = (duration_ms / 1000.0) / SWIPE_STEPS

    _require_focus()  # F26: before the first event
    cx, cy = x0, y0
    _mouse_event(kCGEventLeftMouseDown, cx, cy, src)
    try:
        time.sleep(0.02)

        # Initial nudge: disambiguates swipe from long-press-drag.
        dx = 1 if x1 >= x0 else -1
        dy = 1 if y1 >= y0 else -1
        nx, ny = x0 + dx * SWIPE_NUDGE_PX, y0 + dy * SWIPE_NUDGE_PX
        _mouse_event(kCGEventLeftMouseDragged, nx, ny, src)
        cx, cy = nx, ny
        time.sleep(0.01)

        for i in range(1, SWIPE_STEPS + 1):
            if i % 5 == 0:
                _require_focus()  # R18: a long swipe stops (and releases) when the mirror loses focus
            t = i / SWIPE_STEPS
            e = _ease_in_out(t)
            nx = x0 + (x1 - x0) * e
            ny = y0 + (y1 - y0) * e
            _mouse_event(kCGEventLeftMouseDragged, nx, ny, src)
            cx, cy = nx, ny
            time.sleep(step_delay)
    finally:
        _mouse_event(kCGEventLeftMouseUp, cx, cy, src)


def scroll(dy_pixels: int, nx: float = 0.5, ny: float = 0.5,
           bounds: WindowBounds | None = None) -> None:
    """Scroll vertically at a position. Positive dy scrolls up."""
    ensure_frontmost()
    b = bounds or get_bounds()
    x, y = b.denormalize(nx, ny)
    src = _source()
    _require_focus()  # F26: before the only event
    # Axis 1 = vertical; pixel units; negative = scroll down (content up).
    _scroll_event(src, dy_pixels)


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


_ANSI_CHARS = {code: char for char, code in _ANSI_KEYCODES.items()}


def keycode_for_char(char: str) -> int | None:
    """ANSI virtual keycode for a single digit/letter, else None."""
    if len(char) != 1:
        return None
    return _ANSI_KEYCODES.get(char.lower())


class KeyboardLayoutMismatch(InputError):
    """The Mac's keyboard layout does not put the chord's character on its key.

    Command chords are sent from ANSI key codes; iPhone Mirroring (a Mac
    app) reads its own key equivalents through the Mac's layout first. On
    French AZERTY key code 0 is "q": a ⌘A select-all would arrive as ⌘Q.
    Raised before anything is posted (review 0.2.6 #5).
    """


def _layout_char(keycode: int) -> str | None:
    """What the Mac's current keyboard layout types on ``keycode`` with ⌘ held.

    The event is created, never posted; AppKit translates it through the
    current input source. None when it cannot be read — the chord then goes
    out as it did before this check.
    """
    try:
        from AppKit import NSEvent

        event = CGEventCreateKeyboardEvent(_source(), keycode, True)
        if event is None:
            return None
        CGEventSetFlags(event, kCGEventFlagMaskCommand)
        ns = NSEvent.eventWithCGEvent_(event)
        chars = ns.charactersIgnoringModifiers() if ns is not None else None
        return str(chars) if chars else None
    except Exception:
        return None


# Module-level so tests can swap it (like _focus_check).
_layout_check = _layout_char


def check_chord_layout(keycode: int) -> None:
    """Refuse a ⌘ chord whose ANSI key types another character in the Mac's layout."""
    expect = _ANSI_CHARS.get(keycode)
    if expect is None:
        return
    got = _layout_check(keycode)
    if got is None or got.lower() == expect:
        return
    raise KeyboardLayoutMismatch(
        f'the Mac keyboard layout types "{got}" on the key that ⌘{expect.upper()} is sent from '
        f"(key code {keycode}), so iPhone Mirroring would get ⌘{got.upper()} — nothing was sent; "
        "switch the Mac to a QWERTY-style input source (U.S., ABC, Pinyin) and retry")


def _cmd_chord(keycode: int, before_key=None) -> None:
    """Send a real Command chord: ⌘ down → key down → key up → ⌘ up.

    iPhone Mirroring forwards the *state* of the physical modifier
    keys, not the per-event flag bits: a target-key event that merely
    carries kCGEventFlagMaskCommand arrives on the phone as an
    unmodified keystroke (F14 — a "Cmd+V" paste typed a literal "v").
    The chord therefore presses the Command key itself, keeps the
    flag set on every event, and releases Command last. ~30ms between
    steps, all events from one shared source.

    ``before_key`` runs after the focus checks, right before the first
    event: the caller's last chance to call the chord off by raising —
    nothing is posted then (F35).
    """
    check_chord_layout(keycode)  # review 0.2.6 #5: before anything is sent
    ensure_frontmost()
    _require_focus()  # F26: before the chord's first event
    if before_key is not None:
        before_key()
    src = _source()

    def post(code: int, down: bool, flags: int) -> None:
        event = CGEventCreateKeyboardEvent(src, code, down)
        if event is None:
            raise InputError(f"CGEventCreateKeyboardEvent returned None for {code}")
        CGEventSetFlags(event, flags)
        CGEventPost(kCGHIDEventTap, event)

    post(_VK_COMMAND, True, kCGEventFlagMaskCommand)
    try:
        time.sleep(0.03)
        post(keycode, True, kCGEventFlagMaskCommand)
        try:
            time.sleep(0.03)
        finally:
            post(keycode, False, kCGEventFlagMaskCommand)
        time.sleep(0.03)
    finally:
        post(_VK_COMMAND, False, 0)


def press_key(key: str) -> None:
    """Press a single key: 'return', 'delete', 'up', 'down', 'left', 'right'."""
    ensure_frontmost()
    keymap = {"return": _VK_RETURN, "delete": _VK_DELETE, **_VK_ARROW_KEYS}
    if key not in keymap:
        raise InputError(f"unsupported key: {key!r} (supported: {sorted(keymap)})")
    src = _source()
    _require_focus()  # F26: before the key-down
    _key_event(keymap[key], True, src)
    try:
        time.sleep(0.02)
    finally:
        _key_event(keymap[key], False, src)


class ClipboardChanged(InputError):
    """Raised when something else wrote the pasteboard between type_text()'s
    own write and Cmd+V (F35): another app, or Universal Clipboard bringing
    a copy over from another device. Cmd+V would paste THEIR content into
    the phone, so nothing is sent and their newer content is left alone.
    """


# The user's clipboard is copied aside whole (every item, every type) and put back the same way. Items a
# password manager marks concealed (nspasteboard.org) or an app marks transient are never copied: putting
# the clipboard "back" means clearing it. Universal Clipboard content (reading it would fetch it from
# the other device), promised files and clipboards over the size limit are not copied either: the
# clipboard keeps the typed text. Our own write is not marked transient — iPhone Mirroring reads the
# Mac pasteboard, and the marker's effect on that path is unproven.
_CONCEALED = "org.nspasteboard.ConcealedType"
_TRANSIENT = "org.nspasteboard.TransientType"
_REMOTE = "com.apple.is-remote-clipboard"
_SAVE_LIMIT = 64 * 1024 * 1024


def _new_item():
    from AppKit import NSPasteboardItem
    return NSPasteboardItem.alloc().init()


def save_pasteboard(pasteboard, limit: int = _SAVE_LIMIT):
    """Snapshot ``pasteboard`` for restore_pasteboard(): ``(kind, items)``.

    kind "items": items is [[(type, data), ...], ...]; "concealed" /
    "transient": not copied (restore clears); "empty"; "remote" /
    "too_large": not copied (restore leaves the clipboard as it is).
    A pasteboard object without ``types()`` (a text-only stand-in) is
    saved as ("text", data of public.utf8-plain-text).
    """
    if getattr(pasteboard, "types", None) is None:
        return ("text", pasteboard.dataForType_("public.utf8-plain-text"))
    # types() lists only the first item's types: it tells a remote clipboard before any item is
    # touched; every item's own types are then read (without data) for concealed / transient marks
    types = [str(t) for t in (pasteboard.types() or [])]
    if _REMOTE in types:
        return ("remote", None)
    items_ = list(pasteboard.pasteboardItems() or [])
    for it in items_:
        types += [str(t) for t in (it.types() or [])]
    if _CONCEALED in types:
        return ("concealed", None)
    if _TRANSIENT in types:
        return ("transient", None)
    promised = any(t.startswith("com.apple.pasteboard.promised-file") for t in types)
    if _REMOTE in types or (promised and "public.file-url" not in types):
        return ("remote", None)
    if not types:
        return ("empty", None)
    items, total = [], 0
    for it in items_:
        rec = []
        for t in (it.types() or []):
            d = it.dataForType_(t)
            if d is None:
                continue
            total += int(d.length()) if hasattr(d, "length") else len(d)
            if total > limit:
                return ("too_large", None)
            rec.append((str(t), d))
        if rec:
            items.append(rec)
    if not items:
        # a provider that answers only at the pasteboard level
        return ("text", pasteboard.dataForType_("public.utf8-plain-text"))
    return ("items", items)


def restore_pasteboard(pasteboard, saved) -> bool:
    """Put a save_pasteboard() snapshot back (the caller checked the
    changeCount). Returns False when it cannot be put back ("remote",
    "too_large"): then the clipboard is left holding the typed text.
    Raw text data (bytes or None, the older snapshot) is accepted too."""
    if not isinstance(saved, tuple):
        saved = ("text", saved)
    kind, data = saved
    if kind in ("remote", "too_large"):
        return False
    pasteboard.clearContents()
    if kind == "text":
        if data is not None:
            pasteboard.setData_forType_(data, "public.utf8-plain-text")
    elif kind == "items" and data:
        objs = []
        for rec in data:
            it = _new_item()
            for t, d in rec:
                it.setData_forType_(d, t)
            objs.append(it)
        pasteboard.writeObjects_(objs)
    return True


class PendingRestore:
    """A clipboard restore type_text() could not license itself (F33).

    Holds the user's saved clipboard after a one-character paste whose
    checks did not see the character arrive in time — on the device the
    paste once showed up 8-10 s after Cmd+V. offer() takes later screen
    reads and hands each to ``confirm`` (type_text uses a fresh
    verify.RepeatedSighting: the same new position in two separate reads
    against the still pre-paste baseline); once it confirms, the user's
    clipboard goes back, under the same changeCount rule as type_text().
    Nothing else restores it.

    Since review R38 (Andy's call, 2026-11-07) type_text() creates none: a
    one-character paste never puts the clipboard back. The class stays for
    its own tests and for open_app's offer loop, which still takes any
    PendingRestore an injected type_text hands over.
    """

    def __init__(self, pasteboard, saved, saved_change, confirm, *, sent_at,
                 clock=time.monotonic, min_hold_s: float = 0.3):
        self._pasteboard = pasteboard
        self._saved = saved
        self._saved_change = saved_change
        self._confirm = confirm
        self._sent_at = sent_at
        self._clock = clock
        self._min_hold_s = min_hold_s
        self.done = False

    def offer(self, hits) -> bool:
        """Hand ``hits`` to the evidence; restore once it confirms.

        Returns True only on the call that put the user's clipboard back.
        """
        if self.done or not self._confirm(hits):
            return False
        if self._clock() - self._sent_at < self._min_hold_s:
            return False
        self.done = True
        if self._pasteboard.changeCount() != self._saved_change + 1:
            return False  # something else wrote the pasteboard: never restore
        return restore_pasteboard(self._pasteboard, self._saved)


def type_text(text: str, *, replace: bool = False, pasteboard=None,
              chord=None, before_check=None, ocr_check=None, hud_check=None,
              sleep=time.sleep, clock=time.monotonic,
              timeout_s: float = 2.5, poll_s: float = 0.15,
              min_hold_s: float = 0.3, pending: list | None = None,
              report: dict | None = None, restore: bool = True) -> bool:
    """Type text via clipboard paste (IME-safe), confirmed on screen.

    Direct CGEvent keystroke synthesis breaks under CJK IMEs and is
    slow for long strings. Instead we:
      1. save the user's pasteboard,
      2. write the text,
      3. Cmd+V into the focused field,
      4. wait until the paste is visible on screen,
      5. only then restore the pasteboard.

    Step 4 yields two SEPARATE judgments (F18, tightened in G26b):

    ``landed`` — did the paste show up? This decides the return
    value. The whole-window luma frame diff is the fast path; when
    it never fires within ``timeout_s``, a single OCR probe is the
    fallback. Either one confirms the paste (the frame diff not
    while the phone shows its paste-progress box — F44 below).

    ``restore_ok`` — may the user's clipboard be restored? ONLY an
    OCR hit grants this. The frame diff merely proves "the picture
    changed": a notification banner sliding in, a page animation, a
    redraw near the cursor all trip it without our text being on
    screen. iPhone Mirroring reads the Mac pasteboard
    asynchronously some time AFTER the Cmd+V keystroke, so
    restoring on the frame diff alone could hand a late read the
    user's original clipboard (possibly a password or private
    text). When OCR does not see the text (too short, cropped,
    low contrast) the tool still returns True but the clipboard is
    left holding ``text``: we prefer the user's clipboard holding
    the typed text over any chance of the user's original clipboard
    being pasted into the phone.

    The restore therefore happens only when the text has four or more
    characters (spaces and case aside), the paste landed, OCR
    saw the text, at least ``min_hold_s`` has passed since Cmd+V
    (the phone's asynchronous read must see the paste first), and
    the changeCount shows nothing else touched the pasteboard.

    Errors: anything that raises before the Cmd+V chord posts its
    first event (a lost focus, a capture error, ClipboardChanged)
    means the phone never received a paste, so the user's clipboard
    is restored (same changeCount rule) and the original exception
    is re-raised. From the chord's last check on, the phone may read
    the pasteboard at any moment, so the clipboard is NEVER restored
    after an error there and the original exception is re-raised.

    Capture failures are not errors (F25): when changed() or
    ocr_check() cannot get the mirroring window's pixels (window
    offscreen, blank transition frame, capture by id failed), that
    poll counts as "no change" and the OCR probe as "not seen" —
    the result can only be False (type_not_confirmed), never a
    false confirmation read off another window.

    Returns True when the paste was confirmed; False when neither
    check passed within ``timeout_s`` — then the clipboard still
    holds ``text`` and the user's previous clipboard is NOT
    restored.

    ``replace=True`` sends Cmd+A before the paste, replacing the
    focused field's content. Like clear_text() (F17), Cmd+A targets
    whatever field currently has focus on the phone: if the focus is
    not the intended input, this overwrites content elsewhere. Use it
    only when the caller has established the focus (e.g. guarded by
    a preceding expect/verify step).

    F41: for text of two or more characters the default OCR check used to
    ask only "is the text on screen?" — so text that was already there (a
    search-history chip with the same query, an older message) licensed a
    restore at once, and a paste that the phone read late could then paste
    the user's ORIGINAL clipboard. The default checks now count the text's
    probe before the pasteboard write — the higher of two reads 0.3 s
    apart, so a read that misses an occurrence cannot fake a rise — and
    license a restore only when the count RISES over it, in two reads 0.3 s
    apart. Without a pre-paste count (a read failed) OCR never licenses a
    restore for such text, and the paste can only be confirmed by the
    frame diff. ``report`` (a dict), when given, receives that pre-paste
    count as ``count_before`` (None: unknown), for a caller that keeps
    watching after a False result.

    ``restore=False``: once Cmd+V may be on its way the user's clipboard is
    never put back — no restore here and no PendingRestore — and it keeps
    ``text``; only an error before Cmd+V still restores it. open_app uses
    this (F42): a paste can reach the phone more than 10 s late, and
    Spotlight can show the name in its own suggestions before that, so a
    licensed restore could still paste the user's clipboard into the search.

    F44: a paste the phone is slow to fetch puts up its "Pasting from <Mac>…"
    progress box, and that box alone moves the frame diff. So when the frame
    diff fired but OCR did not see the text, ``hud_check`` (one more screen
    read) looks for the box: while it shows, the paste is still on its way —
    not landed, the result is False and the caller's late watch takes over. A
    capture failure there keeps the frame diff's verdict. ``hud_check`` is
    injectable; by default it reads the screen only with the real frame diff
    (an injected ``before_check`` gets no real read here). The default OCR
    checks never license a restore from a read that shows the box — a paste,
    this one or an earlier one, is still on its way and could fetch the
    restored clipboard — and the box's own words never count as the text.

    ``pending`` (F33): kept for callers that pass one, but nothing is
    appended to it any more. A one-character paste used to hand over a
    PendingRestore for a later restore on evidence; since Andy's call
    (2026-11-07, review R38) a one-character paste never puts the user's
    clipboard back, here or later — like a text of two or three
    characters, it leaves the clipboard holding ``text``.

    Requires the calling terminal to have Accessibility permission
    (same as every other imctl input).
    """
    from AppKit import NSPasteboard

    from . import verify, vision

    # review 0.2.6 #5: both chords are checked against the Mac's keyboard layout before anything is
    # sent, the mirror is brought forward or the clipboard is touched (the chord checks again itself)
    if replace:
        check_chord_layout(_VK_A)
    check_chord_layout(_VK_V)
    ensure_frontmost()
    if chord is None:
        chord = _cmd_chord
    if pasteboard is None:
        pasteboard = NSPasteboard.generalPasteboard()
    # F27: a single character is invisible to the default OCR probe
    # (screen_shows_text never matches it) and may already be on screen, so
    # the default checks wait for a still screen, read it with the
    # minimumTextHeight sweep before Cmd+V, and confirm the paste only when
    # the character shows up at the same NEW position in two separate
    # reads, looking for up to 4 s (the paste can land while Spotlight
    # redraws its results; the field echo blinks with the cursor). A screen
    # that never holds still gets no baseline and so no such sighting. Since
    # review R38 the sighting never licenses a restore: the clipboard keeps
    # holding ``text``.
    single = verify.is_short_text(text, limit=1)
    sweep_before = [None]
    # F41: the probe count of a 2+ character text before the paste (None = unknown)
    multi = not single and verify.text_probe(text) is not None
    count_before = [None]
    # 0.2.5: where the probe showed before the paste (None = unknown → no confirmation)
    spots_before = [None]
    strip_before = [[]]  # and inside the banner strip (review 0.2.6 #7: explains, never confirms)
    # review 0.2.6 #7: why OCR could not confirm a paste the frame diff saw — "too_short" (fewer
    # than VERIFY_MIN_PROBE characters, never confirmed) or "strip_only" (the text appeared only in
    # the banner strip at the top, where a field cannot be told from a banner)
    unverifiable = [None]
    if multi and len(verify.text_probe(text)) < verify.VERIFY_MIN_PROBE:
        unverifiable[0] = "too_short"

    def sweep_read():
        return vision.read_screen(language_correction=False, sweep=True)

    pre_read = single and before_check is None
    pre_count = multi and ocr_check is None
    if hud_check is None:
        if before_check is None:
            def hud_check() -> bool:
                # F44: one more look for the phone's paste-progress box (a
                # sweep for a single character, like every read of it)
                return verify.shows_paste_hud(sweep_read() if single else vision.read_screen())
        else:
            def hud_check() -> bool:
                # an injected frame diff (tests) gets no real screen read here
                return False
    if before_check is None:
        def before_check():
            # Baseline luma is captured here, right before Cmd+V, so the
            # paste itself is the change we look for.
            baseline = verify.window_luma()

            def changed() -> bool:
                return (
                    verify.mean_abs_diff(baseline, verify.window_luma())
                    >= verify.TYPE_MIN_DIFF
                )

            return changed
    if ocr_check is None:
        def ocr_check() -> bool:
            if single:
                if sweep_before[0] is None:
                    return False
                evidence = verify.RepeatedSighting(text, sweep_before[0])
                deadline = clock() + 4.0
                while True:
                    hits = sweep_read()
                    # F44: a read showing the paste-progress box is no evidence —
                    # a paste is still on its way, and a restore now could hand it
                    # the user's clipboard
                    if not verify.shows_paste_hud(hits) and evidence.add(hits):
                        return True
                    if clock() >= deadline:
                        return False
                    sleep(0.3)
            if multi:
                # F41: only a rise over the pre-paste count is the paste, and it
                # must show in two reads (one misread is no license to restore)
                if count_before[0] is None:
                    return False
                for i in range(2):
                    if i:
                        sleep(0.3)
                    hits = vision.read_screen()
                    # F44: no license while the paste-progress box shows — a paste
                    # (this one or an earlier one) is still on its way
                    if (verify.shows_paste_hud(hits)
                            or verify.probe_count(text, hits) <= count_before[0]
                            or spots_before[0] is None
                            or not verify.has_new_spot(spots_before[0], verify.probe_spots(text, hits))):
                        if (unverifiable[0] is None and not verify.shows_paste_hud(hits)
                                and verify.probe_count(text, hits) > count_before[0]
                                and verify.has_new_spot(strip_before[0], verify.strip_spots(text, hits))):
                            unverifiable[0] = "strip_only"
                        return False
                return True
            return verify.screen_shows_text(text, vision.read_screen)

    sent = [False]  # True from the moment a Cmd+V may be on its way
    saved = None
    saved_change = None
    try:
        if replace:
            chord(_VK_A)  # select the focused field's content first (see docstring)
            sleep(0.05)

        if pre_read:
            # F27: the pre-paste sweep for a single character, taken on a
            # still screen only (a mid-transition read could miss a label
            # that is already there and later pass it off as the paste).
            # It runs before the pasteboard write so the stretch between our
            # write and Cmd+V (F35) stays short.
            try:
                if verify.wait_still(sleep=sleep, clock=clock):
                    sweep_before[0] = sweep_read()
            except Exception as exc:
                if not verify.is_capture_error(exc):
                    raise
                sweep_before[0] = None

        if pre_count:
            # F41: count the text before the paste — the higher of two reads
            # 0.3 s apart (a redraw or the select-all highlight can hide an
            # occurrence from one read). A capture failure in either leaves it
            # unknown: then OCR can never license a restore for this paste.
            try:
                r1 = vision.read_screen()
                first = verify.probe_count(text, r1)
                sleep(0.3)
                r2 = vision.read_screen()
                count_before[0] = max(first, verify.probe_count(text, r2))
                # both reads: a spot either one saw is not new after the paste
                spots_before[0] = verify.probe_spots(text, r1) + verify.probe_spots(text, r2)
                strip_before[0] = verify.strip_spots(text, r1) + verify.strip_spots(text, r2)
            except Exception as exc:
                if not verify.is_capture_error(exc):
                    raise
                count_before[0] = None
                spots_before[0] = None
        if report is not None:
            report["count_before"] = count_before[0]

        # the change count first: a copy that lands while the clipboard is being saved must not be
        # overwritten by our write
        saved_change = pasteboard.changeCount()
        saved = save_pasteboard(pasteboard)
        if pasteboard.changeCount() != saved_change:
            saved_change = None  # nothing of ours to undo
            raise ClipboardChanged(
                "another app or device changed the clipboard while it was being saved; "
                "nothing was typed and the clipboard was left as it is")

        pasteboard.clearContents()
        pasteboard.setString_forType_(text, "public.utf8-plain-text")
        sleep(0.05)

        changed = before_check()

        def last_check():
            # F35: the last look at the pasteboard, after the chord's focus
            # round-trips and right before its first event: anything else
            # that wrote it since our own write would be pasted instead.
            if pasteboard.changeCount() != saved_change + 1:
                raise ClipboardChanged(
                    "another app or device changed the clipboard before the "
                    "paste; nothing was typed and the clipboard was left as it is")
            # From here on a paste may be on its way: an error from now on
            # must never put the user's clipboard back.
            sent[0] = True

        # real ⌘ chord — flags alone reach the phone as "v" (F14)
        chord(_VK_V, before_key=last_check)
        t0 = clock()

        # landed: did the paste show up on screen? (decides the return
        # value; the frame diff is only the fast path, never a restore
        # license)
        landed = False
        while clock() - t0 < timeout_s:
            sleep(poll_s)
            try:
                if changed():
                    landed = True
                    break
            except Exception as exc:
                # F25: a capture failure is "no change observed this
                # round", never proof of change — keep polling. Other
                # errors still propagate (after Cmd+V: no restore).
                if not verify.is_capture_error(exc):
                    raise

        # restore_ok: only OCR seeing the pasted text licenses a
        # restore. When the frame-diff window timed out, this same
        # probe is also the confirmation — one call covers both, and
        # its result is reused rather than re-checked. A capture
        # failure counts as "not seen" (F25): the paste stays
        # unconfirmed rather than trusting another window's pixels.
        try:
            restore_ok = ocr_check()
        except Exception as exc:
            if not verify.is_capture_error(exc):
                raise
            restore_ok = False
        if landed and not restore_ok:
            # F44: the frame diff fired but OCR did not see the text. If the
            # phone shows its "Pasting from …" progress box, the box was the
            # change and the paste is still on its way: not landed. A capture
            # failure tells nothing either way and keeps the frame diff's
            # verdict; any other error propagates (after Cmd+V: no restore).
            try:
                if hud_check():
                    landed = False
            except Exception as exc:
                if not verify.is_capture_error(exc):
                    raise
        if not landed:
            landed = restore_ok
        if report is not None:
            # device run 2026-11-06: the frame diff alone (no OCR sighting) once
            # confirmed a paste that never reached the field — the caller must
            # not report such a paste as verified
            report["seen"] = bool(restore_ok)
            if not restore_ok and unverifiable[0] is not None:
                report["unverifiable"] = unverifiable[0]

        if not landed:
            # F18 invariant: never restore unconfirmed — a late paste
            # must at worst repeat `text`, never the user's own clipboard.
            return False

        # Andy's call (2026-11-07, review R38): one character seen on screen
        # confirms the paste but never licenses a restore — like a text of two or
        # three characters (VERIFY_MIN_PROBE), it keeps the clipboard holding `text`.
        if restore_ok and restore and not single:
            # Hold the paste long enough for the asynchronous
            # pasteboard read before putting the user's data back.
            elapsed = clock() - t0
            if elapsed < min_hold_s:
                sleep(min_hold_s - elapsed)
            # Restore the user's clipboard only if nothing else changed it.
            if pasteboard.changeCount() == saved_change + 1:
                restore_pasteboard(pasteboard, saved)
        # else: landed but OCR is blind to it (short/cropped text), a single
        # character, or the caller keeps the clipboard (restore=False): success,
        # but the clipboard keeps `text` — see the docstring's tradeoff.
        return True
    except BaseException:
        # Before Cmd+V the phone never got a paste command, so the
        # user's clipboard can safely go back (changeCount rule).
        # After Cmd+V a late asynchronous read may still happen — never
        # restore then. Either way the original exception propagates.
        if not sent[0] and saved_change is not None:
            if pasteboard.changeCount() == saved_change + 1:
                restore_pasteboard(pasteboard, saved)
        raise


def clear_text() -> None:
    """Select-all and delete in the focused field."""
    check_chord_layout(_VK_A)  # review 0.2.6 #5: before the mirror is brought forward
    ensure_frontmost()
    _cmd_chord(_VK_A)  # Cmd+A — real chord, same reason as type_text
    time.sleep(0.05)
    src = _source()
    _require_focus()  # F26: re-check between Cmd+A and Delete
    _key_event(_VK_DELETE, True, src)
    try:
        time.sleep(0.02)
    finally:
        _key_event(_VK_DELETE, False, src)

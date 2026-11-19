"""Window management for the iPhone Mirroring app.

Resolves the iPhone Mirroring window bounds dynamically before every
gesture. The window can be moved, minimized, or closed between actions,
so callers must never cache bounds across gestures.

Uses System Events (AppleScript) rather than the raw AX C API: it is
the most reliable way to enumerate windows of another process and
survives permission quirks better than direct AXUIElement calls.
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass

APP_NAME = "iPhone Mirroring"
PROCESS_NAME = "iPhone Mirroring"


class WindowError(RuntimeError):
    """Raised when the iPhone Mirroring window cannot be found or used."""


@dataclass(frozen=True)
class WindowBounds:
    x: int
    y: int
    width: int
    height: int

    @property
    def center(self) -> tuple[int, int]:
        return (self.x + self.width // 2, self.y + self.height // 2)

    def denormalize(self, nx: float, ny: float) -> tuple[int, int]:
        """Convert normalized (0-1) coordinates to screen coordinates.

        The window covers x .. x + width - 1: 1.0 (and anything that rounds past it) is its last point,
        not the first point outside it.
        """
        if not (0.0 <= nx <= 1.0 and 0.0 <= ny <= 1.0):
            raise ValueError(f"normalized coords out of range: ({nx}, {ny})")
        return (
            min(round(self.x + nx * self.width), self.x + max(self.width, 1) - 1),
            min(round(self.y + ny * self.height), self.y + max(self.height, 1) - 1),
        )


# Device run 2026-11-07: while the phone's keyboard is composing (a Pinyin "x" with its underline),
# iPhone Mirroring adds a 397x28 AXDialog window — the candidate bar — and System Events lists it as
# window 1, ahead of the phone (AXStandardWindow). Every script that reads the mirror window starts
# with this static block: mi is the index of the first standard window shaped like a phone (as
# is_phone_shaped: PHONE_MIN_SHORT_SIDE, PHONE_MIN_ASPECT), else of the first standard window, else 1 as
# before — review 2026-11-17: another standard window of the process (one near square: a settings or
# welcome window) can be listed ahead of the phone. Fixed text joined into the scripts below — no runtime
# value is interpolated (invariant 1).
# Device run 2026-11-08 03:44: the first version kept `contents of cand`, which System Events turns
# into a reference BY NAME (window "iPhone Mirroring"); during a connection blip that name did not
# resolve and `position of` failed with -1728. The index is re-read on every call, like window 1 was.
_PICK_WINDOW = '''
        set cands to {}
        repeat with i from 1 to (count of windows)
            set sr to ""
            set wh to {0, 0}
            try
                set sr to (subrole of window i) as text
            end try
            try
                set wh to size of window i
            end try
            set end of cands to {sr, item 1 of wh, item 2 of wh}
        end repeat
        set mi to my pickWindow(cands)
'''
# the choice itself, a handler at the top of each script: {subrole, width, height} per window → an index
_PICK_HANDLER = '''
on pickWindow(cands)
    set firstStd to 0
    repeat with i from 1 to (count of cands)
        set c to item i of cands
        if (item 1 of c) is "AXStandardWindow" then
            if firstStd is 0 then set firstStd to i
            set w to (item 2 of c) as real
            set h to (item 3 of c) as real
            set shortSide to w
            set longSide to h
            if w > h then
                set shortSide to h
                set longSide to w
            end if
            if shortSide >= 120 and longSide >= 1.7 * shortSide then return i
        end if
    end repeat
    if firstStd > 0 then return firstStd
    return 1
end pickWindow
'''

_GET_BOUNDS_SCRIPT = _PICK_HANDLER + '''
tell application "System Events"
    tell process "iPhone Mirroring"
        set winCount to count of windows
        if winCount is 0 then return "NO_WINDOW"
''' + _PICK_WINDOW + '''
        set {x, y} to position of window mi
        set {w, h} to size of window mi
        return (x as text) & "," & (y as text) & "," & (w as text) & "," & (h as text)
    end tell
end tell
'''

_FRONTMOST_SCRIPT = '''
tell application "System Events"
    tell process "iPhone Mirroring"
        return frontmost as text
    end tell
end tell
'''


def _run_osascript(script: str, *, strip: bool = True, timeout: float = 10) -> str:
    result = subprocess.run(
        ["osascript", "-e", script],
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if result.returncode != 0:
        raise WindowError(f"osascript failed: {result.stderr.strip()}")
    return result.stdout.strip() if strip else result.stdout


def is_running() -> bool:
    """Return True if the iPhone Mirroring process is alive."""
    result = subprocess.run(
        ["pgrep", "-x", PROCESS_NAME], capture_output=True
    )
    return result.returncode == 0


def ensure_running() -> None:
    """Launch iPhone Mirroring if it is not running."""
    if is_running():
        return
    subprocess.run(
        ["open", "-a", APP_NAME], check=True, timeout=15
    )
    import time

    for _ in range(20):  # wait up to ~10s for the process
        if is_running():
            break
        time.sleep(0.5)
    else:
        raise WindowError("iPhone Mirroring did not start within 10s")


def ensure_frontmost(timeout: float = 10) -> None:
    """Bring the iPhone Mirroring window to the front.

    CGEvents are delivered to the frontmost app; if another window
    covers the mirroring window, taps would land on the wrong target.
    When the app had to be activated (possibly switching Spaces), wait
    until the window yields a real frame before returning, so the caller's
    next capture is not a transition frame refused as capture_failed.
    ``timeout`` bounds each osascript run (a tidy-up passes a short one).
    """
    if _run_osascript(_FRONTMOST_SCRIPT, timeout=timeout) == "true":
        return
    subprocess.run(
        ["osascript", "-e", f'tell application "{APP_NAME}" to activate'],
        capture_output=True,
        timeout=timeout,
    )
    import time

    time.sleep(0.4)  # let the window server settle
    if _run_osascript(_FRONTMOST_SCRIPT, timeout=timeout) != "true":
        raise WindowError("could not bring iPhone Mirroring to front")
    _wait_capturable()


def _wait_capturable(timeout_s: float = 2.0, poll_s: float = 0.2) -> bool:
    """Poll until the mirror window gives a valid frame; best effort.

    Uses verify.window_luma(), which refuses off-screen windows and blank
    transition frames. Returns True once a frame passes, False after
    ``timeout_s`` — it never raises: a caller whose own capture still fails
    reports capture_failed as before.
    """
    import time

    from . import verify  # runtime import: verify imports this module

    deadline = time.monotonic() + timeout_s
    while True:
        try:
            verify.window_luma()
            return True
        except Exception:
            if time.monotonic() >= deadline:
                return False
            time.sleep(poll_s)


def get_bounds() -> WindowBounds:
    """Return current bounds of the mirroring window.

    Raises WindowError if the app is not running or has no window
    (e.g. the window was closed but the process lives on).
    """
    try:
        out = _run_osascript(_GET_BOUNDS_SCRIPT)
    except WindowError:
        # device run 2026-11-08 03:44: System Events lost the window for a moment during a
        # connection blip (-1728). A read sends nothing to the phone, so one retry is safe.
        import time

        time.sleep(0.3)
        out = _run_osascript(_GET_BOUNDS_SCRIPT)
    if out == "NO_WINDOW":
        # Window closed but process alive: re-activate to restore it.
        subprocess.run(
            ["osascript", "-e", f'tell application "{APP_NAME}" to activate'],
            capture_output=True,
            timeout=10,
        )
        import time

        time.sleep(1.0)
        out = _run_osascript(_GET_BOUNDS_SCRIPT)
        if out == "NO_WINDOW":
            raise WindowError(
                "iPhone Mirroring window not found (app running, no window)"
            )
    try:
        x, y, w, h = (int(v) for v in out.split(","))
    except ValueError as exc:
        raise WindowError(f"unexpected bounds format: {out!r}") from exc
    if w <= 0 or h <= 0:
        raise WindowError(f"degenerate window size: {w}x{h}")
    return WindowBounds(x=x, y=y, width=w, height=h)


# Language-independent mirror-state probe. When the mirroring session is live, the mirror window (window mi, see _PICK_WINDOW) contains a
# single group (the AXHostingView) with no children; when an overlay is shown (paused, connecting,
# "iPhone in use", …) that group gains child elements (image / static text / button). Overlay text
# is localized, so the decision never matches on text — only on structure (child count, classes).
# Labels can span multiple lines and nameless elements coerce to the literal "missing value";
# both are normalized so one element = exactly one `<class>\t<label>\t<subrole>\t<child classes>`
# line (tabs inside labels are collapsed too). The subrole and, for groups, the classes of
# their children let parse_overlay_ex tell the window's own hover controls (close / minimize /
# zoom buttons and the small toolbar group) apart from a real overlay.
_OVERLAY_SCRIPT = _PICK_HANDLER + '''
on collapseBreaks(s)
    set tid to AppleScript's text item delimiters
    set AppleScript's text item delimiters to linefeed
    set parts to text items of s
    set AppleScript's text item delimiters to " "
    set s to parts as text
    set AppleScript's text item delimiters to return
    set parts to text items of s
    set AppleScript's text item delimiters to " "
    set s to parts as text
    set AppleScript's text item delimiters to tab
    set parts to text items of s
    set AppleScript's text item delimiters to " "
    set s to parts as text
    set AppleScript's text item delimiters to tid
    return s
end collapseBreaks

tell application "System Events"
    tell process "iPhone Mirroring"
        set winCount to count of windows
        if winCount is 0 then return "NO_WINDOW"
''' + _PICK_WINDOW + '''
        tell window mi
            if not (exists group 1) then return "NO_GROUP"
            set els to UI elements of group 1
            if (count of els) is 0 then return ""
            set out to ""
            repeat with e in els
                set c to (class of e) as text
                set lbl to ""
                try
                    set n to (name of e) as text
                    if n is not "missing value" then set lbl to n
                end try
                if lbl is "" then
                    try
                        set v to (value of e) as text
                        if v is not "missing value" then set lbl to v
                    end try
                end if
                set sr to ""
                try
                    set sr to (subrole of e) as text
                    if sr is "missing value" then set sr to ""
                end try
                set kids to ""
                if c is "group" then
                    try
                        repeat with k in (UI elements of e)
                            set kids to kids & ((class of k) as text) & ","
                        end repeat
                    end try
                end if
                set out to out & c & tab & (my collapseBreaks(lbl)) & tab & sr & tab & kids & linefeed
            end repeat
            return out
        end tell
    end tell
end tell
'''

# Clicks the Resume control of the paused overlay. Only ever invoked after _OVERLAY_SCRIPT
# reported exactly one overlay button under group 1 (static script, no interpolated
# parameters). "button 1 of group 1" was the window's Close button whenever the
# pointer rested on the window, so window controls are skipped by AX subrole and the
# click happens only when exactly one other button remains; prints CLICKED or SKIP.
_CLICK_RESUME_SCRIPT = _PICK_HANDLER + '''
tell application "System Events"
    tell process "iPhone Mirroring"
''' + _PICK_WINDOW + '''
        tell window mi
            set target to missing value
            set n to 0
            repeat with b in (buttons of group 1)
                set sr to ""
                try
                    set sr to (subrole of b) as text
                end try
                if sr is not "AXCloseButton" and sr is not "AXMinimizeButton" and sr is not "AXZoomButton" and sr is not "AXFullScreenButton" then
                    set n to n + 1
                    set target to contents of b
                end if
            end repeat
            if n is not 1 then return "SKIP"
            click target
            return "CLICKED"
        end tell
    end tell
end tell
'''


def get_window_info() -> dict | None:
    """Return the mirroring window's CGWindow record: {"id", "x", "y", "w", "h", "onscreen"}.

    Uses Quartz (pyobjc). Prefers the window literally named "iPhone Mirroring"; otherwise the largest
    normal-layer window of the process. Returns None when nothing qualifies. The id is what
    ``screencapture -l`` needs to capture the window's own pixels even when other windows cover it.
    """
    try:
        import Quartz  # type: ignore
    except ImportError:
        return None
    opts = Quartz.kCGWindowListOptionAll | Quartz.kCGWindowListExcludeDesktopElements
    best = None
    for w in Quartz.CGWindowListCopyWindowInfo(opts, Quartz.kCGNullWindowID) or []:
        if w.get("kCGWindowOwnerName") != PROCESS_NAME or w.get("kCGWindowLayer", 0) != 0:
            continue
        b = w.get("kCGWindowBounds") or {}
        rec = {
            "id": int(w["kCGWindowNumber"]),
            "x": int(b.get("X", 0)),
            "y": int(b.get("Y", 0)),
            "w": int(b.get("Width", 0)),
            "h": int(b.get("Height", 0)),
            "onscreen": bool(w.get("kCGWindowIsOnscreen", False)),
        }
        if rec["w"] < 50 or rec["h"] < 50:
            continue
        if w.get("kCGWindowName") == APP_NAME:
            return rec
        if best is None or rec["w"] * rec["h"] > best["w"] * best["h"]:
            best = rec
    return best


def is_frontmost() -> bool:
    """True when iPhone Mirroring is the frontmost application, asked fresh on every call.

    This runs right before synthesized input events. The in-process
    NSWorkspace.frontmostApplication() query used before is a snapshot in a process
    without a run loop (imctl's case) — after Finder came to the front it still answered
    "iPhone Mirroring", so the re-checks inside one operation could never fire. System
    Events reads the live process list (about 0.1 s per osascript call). Any failure
    counts as not frontmost, so input is refused rather than sent blind.
    """
    try:
        return _run_osascript(_FRONTMOST_SCRIPT) == "true"
    except (WindowError, subprocess.TimeoutExpired, OSError):
        return False


# Controls iPhone Mirroring adds to group 1 while the pointer rests on its window
# (the title-bar buttons), identified by AX subrole — never by localized text.
_CHROME_SUBROLES = frozenset(
    {"AXCloseButton", "AXMinimizeButton", "AXZoomButton", "AXFullScreenButton"}
)


def parse_overlay_ex(raw: str) -> tuple[dict, bool]:
    """Parse _OVERLAY_SCRIPT output into ({"live", "overlay", "buttons"}, hover).

    Rules (structure only, never localized text):
      - "" (group 1 has no children)            -> live=True,  overlay=None, buttons=0
      - child lines "<class>\\t<label>[\\t<subrole>\\t<child classes>]"
                                                -> live=False, overlay=static texts joined
                                                   with " / " (None when no text),
                                                   buttons=button count
      - "NO_WINDOW" / "NO_GROUP" / unparseable  -> live=None,  overlay=None, buttons=0

    While the pointer rests on the mirror window, group 1 also holds the window's own
    title-bar buttons (subroles AXCloseButton / AXMinimizeButton / AXZoomButton) and a small
    toolbar (a group whose children are only buttons; an empty group is not it). hover is True when those buttons are
    present; they and the toolbar group — one group, the first such — are not an overlay and
    are never counted. Without them the rules above apply unchanged: any other child, a second
    group of buttons or a second empty group included, still means not live.
    """
    unknown = {"live": None, "overlay": None, "buttons": 0}
    if raw is None:
        return unknown, False
    if raw.strip() in ("NO_WINDOW", "NO_GROUP"):
        return unknown, False
    # Keep lines as-is (a trailing tab is significant: "button\t" means a nameless button);
    # only filter out blank lines.
    lines = [ln for ln in raw.split("\n") if ln.strip()]
    if not lines:
        return {"live": True, "overlay": None, "buttons": 0}, False
    elements = []
    for ln in lines:
        parts = ln.split("\t", 1)
        if len(parts) != 2:
            return unknown, False  # unexpected format -> unknown, never guess
        cls, rest = parts[0].strip(), parts[1]
        if rest.count("\t") >= 2:  # current script: label, subrole, child classes
            label, subrole, kids = rest.rsplit("\t", 2)
        else:  # two-field form (label only)
            label, subrole, kids = rest, "", ""
        child_classes = [k.strip() for k in kids.split(",") if k.strip()]
        elements.append((cls, label.strip(), subrole.strip(), child_classes))
    hover = any(c == "button" and s in _CHROME_SUBROLES for c, _, s, _ in elements)
    rest_els = [e for e in elements if not (e[0] == "button" and e[2] in _CHROME_SUBROLES)]
    if hover:
        # The hover toolbar: one group holding only buttons. There is one of it: a second such group is
        # something else, stays, and the window does not read as live. An empty group is not taken for it
        # (all() of nothing is True): it may be an overlay that has not drawn its content yet, and a window
        # that is not known to be live gets no input.
        kept, toolbar = [], False
        for e in rest_els:
            if not toolbar and e[0] == "group" and e[3] and all(k == "button" for k in e[3]):
                toolbar = True
                continue
            kept.append(e)
        rest_els = kept
    if not rest_els:
        return {"live": True, "overlay": None, "buttons": 0}, hover
    buttons = sum(1 for e in rest_els if e[0] == "button")
    texts = [e[1] for e in rest_els if e[0] == "static text" and e[1]]
    return {
        "live": False,
        "overlay": " / ".join(texts) if texts else None,
        "buttons": buttons,
    }, hover


def parse_overlay(raw: str) -> dict:
    """Parse _OVERLAY_SCRIPT output into {"live", "overlay", "buttons"} (see parse_overlay_ex)."""
    return parse_overlay_ex(raw)[0]


def overlay_snapshot() -> tuple[dict, bool]:
    """(overlay state, hover) from one probe; the state is what get_overlay() returns.

    Fail-open at the probe layer: any osascript failure (app not running, AX hiccup,
    timeout) returns live=None so callers can decide; this never raises. When the app
    is not running or has no window on any Space, ``reason`` is set ("not_running" or
    "no_window") so _require_live() can report that without activating the app.
    """
    try:
        # strip=False: a trailing "<class>\t" line (nameless button) must keep its tab —
        # str.strip() would eat it and make the last line unparseable.
        raw = _run_osascript(_OVERLAY_SCRIPT, strip=False)
    except Exception:
        if not is_running():
            return {"live": None, "overlay": None, "buttons": 0, "reason": "not_running"}, False
        return {"live": None, "overlay": None, "buttons": 0}, False
    state, hover = parse_overlay_ex(raw)
    if raw.strip() == "NO_WINDOW" and get_window_info() is None:
        state = {**state, "reason": "no_window"}
    return state, hover


def get_overlay() -> dict:
    """Return the current overlay state: {"live", "overlay", "buttons"} (fail-open)."""
    return overlay_snapshot()[0]


# 2026-11-05, macOS 27.2: the first launch after the macOS upgrade showed a welcome
# screen ("iPhone on Your Mac …") in a 640×660 window. Its button made it look like the paused
# overlay: phone_status reported paused=true, phone_launch told the user to lock the iPhone, and
# resume() clicks an overlay's lone button as if it were Resume. The mirror window itself — live
# or paused — is phone-shaped: elongated, portrait (measured 236×524, 329×727, 354×781 — about
# 2.2:1) or, for an app that rotates, landscape. A setup, welcome or permission screen is close to
# square, so a click is only ever sent on an elongated window. 1.7 keeps the 16:9 iPhone SE
# (≈1.78) in and a wide dialog (e.g. 800×520 ≈ 1.54) out. Geometry, not text: language-
# independent like the rest of the overlay probe.
PHONE_MIN_ASPECT = 1.7
# The short side of a phone's picture: the keyboard's candidate bar (397x28, an AXDialog window of the same
# process) is elongated too, and is the window the scripts fall back to when no standard window is listed.
PHONE_MIN_SHORT_SIDE = 120


def is_phone_shaped(bounds: WindowBounds | None = None) -> bool | None:
    """True when the mirror window is elongated like a phone, portrait or landscape.

    The long side must be at least PHONE_MIN_ASPECT times the short side, and the short side
    at least PHONE_MIN_SHORT_SIDE: a strip such as the keyboard's candidate bar is not a phone.
    None when the bounds cannot be read.
    """
    try:
        b = bounds if bounds is not None else get_bounds()
    except Exception:
        return None
    if b.width <= 0 or b.height <= 0:
        return None  # degenerate bounds say nothing about the shape
    long_side, short_side = max(b.width, b.height), min(b.width, b.height)
    return short_side >= PHONE_MIN_SHORT_SIDE and long_side >= PHONE_MIN_ASPECT * short_side


def is_setup_screen(overlay: dict | None = None,
                    bounds: WindowBounds | None = None) -> bool:
    """True when an overlay is up in a window that is not phone-shaped.

    Such a screen (first-run welcome, setup, permission prompt) is the user's to
    finish: resume() never clicks it and phone_launch says so. Unknown bounds → False.
    """
    if overlay is None:
        overlay = get_overlay()
    return overlay["live"] is False and is_phone_shaped(bounds) is False


def is_paused(overlay: dict | None = None) -> bool | None:
    """True when the overlay shows a Resume control; False when live; None when unknown.

    Language-independent: derived from the overlay structure (live flag + button count),
    not from localized text such as "Connection Paused". Accepts a pre-fetched overlay
    dict (as returned by get_overlay) so status can report one consistent snapshot.
    """
    if overlay is None:
        overlay = get_overlay()
    if overlay["live"] is False and overlay["buttons"] >= 1:
        return True
    if overlay["live"] is True:
        return False
    return None


def _move_pointer_off_window() -> bool:
    """Move the pointer just outside the mirror window (a move, never a click).

    With the pointer on the window its title-bar buttons share group 1 with
    the overlay; moving off hides them before resume() reads and clicks. Picks the
    first point beside the window that lies on an active display. Best effort:
    returns False when Quartz is unavailable or nothing qualifies.
    """
    try:
        import Quartz  # type: ignore

        b = get_bounds()
        err, ids, count = Quartz.CGGetActiveDisplayList(16, None, None)
        if err:
            return False
        rects = [Quartz.CGDisplayBounds(d) for d in list(ids)[:count]]
        candidates = [
            (b.x - 24, b.y + b.height / 2),
            (b.x + b.width + 24, b.y + b.height / 2),
            (b.x + b.width / 2, b.y + b.height + 24),
            (b.x + b.width / 2, b.y - 24),
        ]
        for x, y in candidates:
            for r in rects:
                if (r.origin.x <= x < r.origin.x + r.size.width
                        and r.origin.y <= y < r.origin.y + r.size.height):
                    ev = Quartz.CGEventCreateMouseEvent(
                        None, Quartz.kCGEventMouseMoved, (x, y), Quartz.kCGMouseButtonLeft
                    )
                    Quartz.CGEventPost(Quartz.kCGHIDEventTap, ev)
                    from . import pointer
                    pointer.moved_to(x, y)  # 0.2.7: the CLI puts the pointer back after the command
                    return True
    except Exception:
        return False
    return False


def resume() -> bool:
    """Click the Resume control when the session is paused (language-independent).

    Live already -> True. When the pointer rests on the window its title-bar
    buttons appear in the same AX group, so the pointer is first moved off the window
    and the state read again; window controls are never counted or clicked. Paused
    overlay with exactly one other button -> click it, then poll up to ~6 s (0.5 s
    interval) until the stream is live again. Anything else (several buttons, none,
    unknown state) -> do not click, return False. The iPhone must be locked and near
    the Mac for the stream to come back.
    """
    import time

    overlay, hover = overlay_snapshot()
    if hover:
        _move_pointer_off_window()
        time.sleep(0.6)
        overlay, hover = overlay_snapshot()
    if overlay["live"] is True:
        return True
    if overlay["live"] is not False or overlay["buttons"] != 1:
        return False
    if is_phone_shaped() is not True:
        # A button in a window that is not phone-shaped belongs to a setup /
        # welcome / permission screen — never ours to click. Unknown bounds: no click either.
        return False
    try:
        clicked = _run_osascript(_CLICK_RESUME_SCRIPT)
    except (WindowError, subprocess.TimeoutExpired):
        return False
    if clicked != "CLICKED":
        return False
    for _ in range(12):  # up to ~6 s for the stream to come back
        time.sleep(0.5)
        if get_overlay()["live"] is True:
            return True
    return False

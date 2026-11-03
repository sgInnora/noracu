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
        """Convert normalized (0-1) coordinates to screen coordinates."""
        if not (0.0 <= nx <= 1.0 and 0.0 <= ny <= 1.0):
            raise ValueError(f"normalized coords out of range: ({nx}, {ny})")
        return (
            round(self.x + nx * self.width),
            round(self.y + ny * self.height),
        )


_GET_BOUNDS_SCRIPT = '''
tell application "System Events"
    tell process "iPhone Mirroring"
        set winCount to count of windows
        if winCount is 0 then return "NO_WINDOW"
        set {x, y} to position of window 1
        set {w, h} to size of window 1
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


def _run_osascript(script: str, *, strip: bool = True) -> str:
    result = subprocess.run(
        ["osascript", "-e", script],
        capture_output=True,
        text=True,
        timeout=10,
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


def ensure_frontmost() -> None:
    """Bring the iPhone Mirroring window to the front.

    CGEvents are delivered to the frontmost app; if another window
    covers the mirroring window, taps would land on the wrong target.
    F31: when the app had to be activated (possibly switching Spaces), wait
    until the window yields a real frame before returning, so the caller's
    next capture is not a transition frame refused as capture_failed.
    """
    if _run_osascript(_FRONTMOST_SCRIPT) == "true":
        return
    subprocess.run(
        ["osascript", "-e", f'tell application "{APP_NAME}" to activate'],
        capture_output=True,
        timeout=10,
    )
    import time

    time.sleep(0.4)  # let the window server settle
    if _run_osascript(_FRONTMOST_SCRIPT) != "true":
        raise WindowError("could not bring iPhone Mirroring to front")
    _wait_capturable()


def _wait_capturable(timeout_s: float = 2.0, poll_s: float = 0.2) -> bool:
    """Poll until the mirror window gives a valid frame (F31); best effort.

    Uses verify.window_luma(), which refuses off-screen windows and blank
    transition frames (F25). Returns True once a frame passes, False after
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


# Language-independent mirror-state probe. When the mirroring session is live, window 1 contains a
# single group (the AXHostingView) with no children; when an overlay is shown (paused, connecting,
# "iPhone in use", …) that group gains child elements (image / static text / button). Overlay text
# is localized, so the decision never matches on text — only on structure (child count, classes).
# Labels can span multiple lines and nameless elements coerce to the literal "missing value";
# both are normalized so one element = exactly one `<class>\t<label>\t<subrole>\t<child classes>`
# line (tabs inside labels are collapsed too). F28: the subrole and, for groups, the classes of
# their children let parse_overlay_ex tell the window's own hover controls (close / minimize /
# zoom buttons and the small toolbar group) apart from a real overlay.
_OVERLAY_SCRIPT = '''
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
        tell window 1
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
# parameters). F29: "button 1 of group 1" was the window's Close button whenever the
# pointer rested on the window, so window controls are skipped by AX subrole and the
# click happens only when exactly one other button remains; prints CLICKED or SKIP.
_CLICK_RESUME_SCRIPT = '''
tell application "System Events"
    tell process "iPhone Mirroring"
        tell window 1
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

    F26 runs this right before synthesized input events. F30: the in-process
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


# F28: controls iPhone Mirroring adds to group 1 while the pointer rests on its window
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

    F28: while the pointer rests on the mirror window, group 1 also holds the window's own
    title-bar buttons (subroles AXCloseButton / AXMinimizeButton / AXZoomButton) and a small
    toolbar (a group whose children are only buttons). hover is True when those buttons are
    present; they and the toolbar group are not an overlay and are never counted. Without
    them the rules above apply unchanged: any other child still means not live.
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
        # The hover toolbar: a group holding only buttons (or nothing yet, mid-animation).
        rest_els = [
            e for e in rest_els if not (e[0] == "group" and all(k == "button" for k in e[3]))
        ]
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

    Fail-open: any osascript failure (app not running, AX hiccup, timeout) returns
    live=None so callers can decide; this never raises.
    """
    try:
        # strip=False: a trailing "<class>\t" line (nameless button) must keep its tab —
        # str.strip() would eat it and make the last line unparseable.
        raw = _run_osascript(_OVERLAY_SCRIPT, strip=False)
    except Exception:
        return {"live": None, "overlay": None, "buttons": 0}, False
    return parse_overlay_ex(raw)


def get_overlay() -> dict:
    """Return the current overlay state: {"live", "overlay", "buttons"} (fail-open)."""
    return overlay_snapshot()[0]


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

    F28/F29: with the pointer on the window its title-bar buttons share group 1 with
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
                    return True
    except Exception:
        return False
    return False


def resume() -> bool:
    """Click the Resume control when the session is paused (language-independent).

    Live already -> True. F28/F29: when the pointer rests on the window its title-bar
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

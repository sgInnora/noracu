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
# both are normalized so one element = exactly one `<class>\t<label>` line.
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
                set out to out & c & tab & (my collapseBreaks(lbl)) & linefeed
            end repeat
            return out
        end tell
    end tell
end tell
'''

# Clicks the Resume control of the paused overlay. Only ever invoked after _OVERLAY_SCRIPT
# reported exactly one button under group 1 (static script, no interpolated parameters).
_CLICK_RESUME_SCRIPT = '''
tell application "System Events"
    tell process "iPhone Mirroring"
        tell window 1
            click button 1 of group 1
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
    """True when iPhone Mirroring is the frontmost application."""
    try:
        return _run_osascript(_FRONTMOST_SCRIPT) == "true"
    except WindowError:
        return False


def parse_overlay(raw: str) -> dict:
    """Parse _OVERLAY_SCRIPT output into {"live", "overlay", "buttons"}.

    Rules (structure only, never localized text):
      - "" (group 1 has no children)          -> live=True,  overlay=None, buttons=0
      - child lines "<class>\t<name-or-value>"  -> live=False, overlay=static texts joined with " / "
                                                   (None when no text), buttons=button count
      - "NO_WINDOW" / "NO_GROUP" / unparseable -> live=None,  overlay=None, buttons=0
    """
    unknown = {"live": None, "overlay": None, "buttons": 0}
    if raw is None:
        return unknown
    if raw.strip() in ("NO_WINDOW", "NO_GROUP"):
        return unknown
    # Keep lines as-is (a trailing tab is significant: "button\t" means a nameless button);
    # only filter out blank lines.
    lines = [ln for ln in raw.split("\n") if ln.strip()]
    if not lines:
        return {"live": True, "overlay": None, "buttons": 0}
    buttons = 0
    texts: list[str] = []
    for ln in lines:
        parts = ln.split("\t", 1)
        if len(parts) != 2:
            return unknown  # unexpected format -> unknown, never guess
        cls, label = parts[0].strip(), parts[1].strip()
        if cls == "button":
            buttons += 1
        elif cls == "static text" and label:
            texts.append(label)
    return {
        "live": False,
        "overlay": " / ".join(texts) if texts else None,
        "buttons": buttons,
    }


def get_overlay() -> dict:
    """Return the current overlay state: {"live", "overlay", "buttons"}.

    Fail-open: any osascript failure (app not running, AX hiccup, timeout) returns
    live=None so callers can decide; this never raises.
    """
    try:
        # strip=False: a trailing "<class>\t" line (nameless button) must keep its tab —
        # str.strip() would eat it and make the last line unparseable.
        raw = _run_osascript(_OVERLAY_SCRIPT, strip=False)
    except Exception:
        return {"live": None, "overlay": None, "buttons": 0}
    return parse_overlay(raw)


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


def resume() -> bool:
    """Click the Resume control when the session is paused (language-independent).

    Live already -> True. Paused overlay with exactly one button -> click it, then poll up
    to ~6 s (0.5 s interval) until the stream is live again. Anything else (multiple
    buttons, no button, unknown state) -> do not click, return False. The phone may still
    ask for Face ID / passcode on its own screen; that part cannot be automated from the Mac.
    """
    import time

    overlay = get_overlay()
    if overlay["live"] is True:
        return True
    if overlay["live"] is not False or overlay["buttons"] != 1:
        return False
    try:
        _run_osascript(_CLICK_RESUME_SCRIPT)
    except WindowError:
        return False
    for _ in range(12):  # up to ~6 s for the stream to come back
        time.sleep(0.5)
        if get_overlay()["live"] is True:
            return True
    return False

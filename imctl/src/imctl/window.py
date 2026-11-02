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


def _run_osascript(script: str) -> str:
    result = subprocess.run(
        ["osascript", "-e", script],
        capture_output=True,
        text=True,
        timeout=10,
    )
    if result.returncode != 0:
        raise WindowError(f"osascript failed: {result.stderr.strip()}")
    return result.stdout.strip()


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


_PAUSED_SCRIPT = '''
tell application "System Events"
    tell process "iPhone Mirroring"
        tell window 1
            return (exists (static text "Connection Paused" of group 1)) as text
        end tell
    end tell
end tell
'''

_RESUME_SCRIPT = '''
tell application "System Events"
    tell process "iPhone Mirroring"
        tell window 1
            if exists (static text "Connection Paused" of group 1) then
                click button 1 of group 1
                return "clicked"
            end if
            return "not-paused"
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


def is_paused() -> bool | None:
    """True when the window shows "Connection Paused"; None when that cannot be read (e.g. localized UI)."""
    try:
        return _run_osascript(_PAUSED_SCRIPT) == "true"
    except WindowError:
        return None


def resume() -> bool:
    """Click the Resume control when the session is paused.

    Returns True when the session is not paused afterwards (or was never paused). The phone may still
    ask for Face ID / passcode on its own screen; that part cannot be automated from the Mac.
    """
    import time

    try:
        out = _run_osascript(_RESUME_SCRIPT)
    except WindowError:
        return False
    if out == "not-paused":
        return True
    for _ in range(10):  # up to ~5 s for the stream to come back
        time.sleep(0.5)
        if is_paused() is False:
            return True
    return False

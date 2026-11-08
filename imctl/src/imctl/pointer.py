"""Put the Mac pointer back after a phone gesture (0.2.7, a Mac shared with a person).

A tap, swipe, long press or scroll moves the real pointer onto the mirror
window (a mouse event with a location moves it). When the Mac is shared
(NORACU_USER_IDLE_S is not 0 — the same variable and rule as the noracu
server), the CLI remembers where the pointer was before a command and, after
it, warps it back — only when the pointer is still where noracu's own last
event left it: if someone moved it meanwhile, it stays where they put it.
A warp posts no event (the person's idle time is not reset by it).
"""

from __future__ import annotations

import os
import re
import time

_home = None  # where the pointer was before the command (None: not tracking)
_last = None  # where noracu's last mouse event put it (None: no mouse event yet)


def enabled() -> bool:
    """Off only for a plain zero ("0", "0.0"), like the server; unset or unreadable means on."""
    raw = os.environ.get("NORACU_USER_IDLE_S", "").strip()
    return not re.fullmatch(r"0+(\.0+)?", raw)


def _where():
    try:
        import Quartz  # type: ignore

        ev = Quartz.CGEventCreate(None)
        if ev is None:
            return None
        p = Quartz.CGEventGetLocation(ev)
        return (float(p.x), float(p.y))
    except Exception:
        return None


def _warp(p) -> None:
    import Quartz  # type: ignore

    Quartz.CGWarpMouseCursorPosition(p)
    Quartz.CGAssociateMouseAndMouseCursorPosition(True)


def remember() -> None:
    """Called once before a command runs."""
    global _home, _last
    _last = None
    _home = _where() if enabled() else None


def moved_to(x: float, y: float) -> None:
    """Called after every mouse event noracu posts."""
    global _last
    _last = (float(x), float(y))


def restore() -> bool:
    """Called once after a command (also after an error). True when the pointer was put back."""
    global _home, _last
    home, last = _home, _last
    _home = _last = None
    if home is None or last is None:
        return False
    def still_ours() -> bool:
        now = _where()
        return now is not None and abs(now[0] - last[0]) <= 2 and abs(now[1] - last[1]) <= 2

    if not still_ours():
        return False  # someone moved it: leave it where they put it
    try:
        time.sleep(0.1)  # let the last posted events reach the mirror before the pointer leaves it
        if not still_ours():
            return False  # moved during that wait
        _warp(home)
        return True
    except Exception:
        return False

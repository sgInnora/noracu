"""Where the phone screen sits inside the iPhone Mirroring window, remembered per window size.

Device run 2026-11-10 (macOS 27.2, window 280x620 pt): the phone screen does not fill the mirror
window. Around it is a transparent margin — a strip above the screen, where the window's own
controls show while the pointer rests there, and a thin edge on the other sides (the screen spans
x 0.0286-0.9714, y 0.0613-0.9871). A click on that margin never reaches the phone, and iOS cancels a
drag that starts or ends on it.

verify.screen_rect() finds the screen from one capture of the window. Two things were learned about
that capture on the same day:

- The phone's apps see a capture of the mirror window as a screenshot: LinkedIn and rednote each
  raised their after-screenshot share sheet 1-4 s after every one. So the edges are measured once
  per window size and macOS version and remembered in a small file, not measured before every
  gesture.
- While the pointer rests on the strip above the screen the window draws its controls there, the
  strip reads as solid and the measurement comes back as the whole window. Such a measurement is
  not trusted and never remembered.

The file holds window sizes, the macOS version, the four edges and two timestamps — nothing from
the phone. It is best-effort: when it cannot be read or written, the edges are measured again.

While no trusted measurement is at hand, fallback() says where a point is certainly clear of the margin:
a tap or long press outside that part of the window is refused and a swipe's points are moved into it.
"""

from __future__ import annotations

import json
import os
import platform
import time
from pathlib import Path

VERSION = 1
MIN_TOP = 0.02  # a trusted measurement shows a strip above the screen at least this tall (window units)
MAX_TOP = 0.25
MIN_SPAN = 0.5  # and a screen at least half the window wide and tall
UNTRUSTED_TTL_S = 600  # after an untrusted measurement a tap or long press does not measure again this long
MAX_SIZES = 16

# While the edges are not known (no trusted measurement), a point this close to the window's sides may be on the
# margin. Each band is the larger of a share of the window and a length in points: the one device measurement
# (280x620 pt window: 38 pt above the screen, 8 pt on the other sides) does not say whether another window size
# scales the margin or keeps it. Wider than what was measured, on purpose.
FALLBACK_TOP = (0.08, 48.0)     # (share of the height, points)
FALLBACK_SIDE = (0.04, 12.0)    # (share of the width, points)
FALLBACK_BOTTOM = (0.02, 12.0)


def cache_file() -> Path:
    return Path.home() / "Library" / "Caches" / "noracu" / "phone-screen-rect.json"


def key(width, height) -> str:
    """One entry per window size and macOS version (an update can redraw the window's frame)."""
    return f"{int(round(width))}x{int(round(height))}@{platform.mac_ver()[0] or 'unknown'}"


def _edges(rect):
    try:
        x0, y0, x1, y1 = (float(v) for v in rect)
    except (TypeError, ValueError):
        return None
    if any(v != v for v in (x0, y0, x1, y1)):  # nan
        return None
    return (x0, y0, x1, y1)


def trusted(rect) -> bool:
    """True for a measurement that shows the strip above the screen and a screen of plausible size.

    (0, 0, 1, 1) — what the capture gives while the pointer rests on that strip — is not trusted,
    and neither is anything with no strip above it: without one there is no telling the phone
    screen from the window's own controls.
    """
    e = _edges(rect)
    if e is None:
        return False
    x0, y0, x1, y1 = e
    return (0.0 <= x0 < x1 <= 1.0 and MIN_TOP <= y0 <= MAX_TOP and y0 < y1 <= 1.0
            and x1 - x0 >= MIN_SPAN and y1 - y0 >= MIN_SPAN)


def contains(rect, x: float, y: float) -> bool:
    x0, y0, x1, y1 = rect
    return x0 <= x <= x1 and y0 <= y <= y1


def fallback(width=None, height=None):
    """The part of the window a point must be in to be sent while the screen's edges are not known:
    (x0, y0, x1, y1), the window less a band at the top (where its own controls are) and along the other sides.
    ``width`` / ``height`` are the window's size in points; without them the bands are shares of the window.
    None when the window is too small to have such a part (the bands are never made thinner to fit)."""
    def band(spec, size):
        share, points = spec
        try:
            size = float(size)
        except (TypeError, ValueError):
            size = 0.0
        return max(share, points / size) if size > 0 else share

    side, top, bottom = band(FALLBACK_SIDE, width), band(FALLBACK_TOP, height), band(FALLBACK_BOTTOM, height)
    if 2 * side >= 1.0 or top + bottom >= 1.0:
        return None  # a window this small has no part that is certainly clear of its margin
    return (side, top, 1.0 - side, 1.0 - bottom)


def _load(path) -> dict:
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict) or data.get("version") != VERSION:
        return {}
    sizes = data.get("sizes")
    return {k: v for k, v in sizes.items() if isinstance(k, str) and isinstance(v, dict)} if isinstance(sizes, dict) else {}


def _save(path, sizes: dict) -> None:
    try:
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        if len(sizes) > MAX_SIZES:  # keep the most recently written entries
            # a time that is not a number (null in a file written by hand or cut short) counts as the oldest
            num = lambda v: v if isinstance(v, (int, float)) and not isinstance(v, bool) else 0
            newest = sorted(sizes, key=lambda k: max(num(sizes[k].get("measured_at")), num(sizes[k].get("untrusted_at"))))
            sizes = {k: sizes[k] for k in newest[-MAX_SIZES:]}
        tmp = p.with_name(f"{p.name}.{os.getpid()}.tmp")
        tmp.write_text(json.dumps({"version": VERSION, "sizes": sizes}, indent=1) + "\n", encoding="utf-8")
        os.replace(tmp, p)
    except OSError:
        pass  # best-effort: without the file the next call measures again


def remembered(k: str, path=None):
    """The trusted edges remembered for the window size named by ``k``, else None. Never captures."""
    rect = _load(path or cache_file()).get(k, {}).get("rect")
    return _edges(rect) if trusted(rect) else None


def resolve(k: str, measure, *, retry_untrusted: bool, now: float | None = None, path=None):
    """Return (rect, how) for the window size named by ``k``.

    how is "remembered" (from the file, no capture), "measured" (one capture, trusted, now
    remembered), "untrusted" (one capture that could not be trusted; rect is None and nothing is
    remembered but the time) or "not_measured" (rect is None: an untrusted measurement was made less
    than UNTRUSTED_TTL_S ago and ``retry_untrusted`` is False). ``measure()`` runs at most once and
    its exceptions pass through; the caller decides what a failed capture means.
    """
    path = path or cache_file()
    now = time.time() if now is None else now
    sizes = _load(path)
    entry = sizes.get(k, {})
    if trusted(entry.get("rect")):
        return _edges(entry["rect"]), "remembered"
    seen = entry.get("untrusted_at")
    if (not retry_untrusted and isinstance(seen, (int, float)) and not isinstance(seen, bool)
            and 0 <= now - seen < UNTRUSTED_TTL_S):
        return None, "not_measured"
    rect = measure()
    if trusted(rect):
        edges = tuple(round(v, 4) for v in _edges(rect))
        sizes[k] = {"rect": list(edges), "measured_at": int(now)}
        _save(path, sizes)
        return edges, "measured"
    sizes[k] = {"untrusted_at": int(now)}
    _save(path, sizes)
    return None, "untrusted"

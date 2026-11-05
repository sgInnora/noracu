"""Pixel-level action verification.

Each gesture is followed by a screenshot hash comparison to confirm the
screen actually changed. This closes the loop: an action that reports
success but leaves the screen identical is a dropped event, and callers
should retry or re-observe — the same observe-act-re-observe discipline
that OpenAI's Computer Use enforces with its revision mechanism.
"""

from __future__ import annotations

import hashlib
import subprocess
import tempfile
import unicodedata
from dataclasses import dataclass

from .vision import CaptureError
from .window import WindowError, get_bounds, get_window_info


@dataclass(frozen=True)
class ScreenState:
    """A fingerprint of the mirroring window content."""

    md5: str
    width: int
    height: int


def capture_hash() -> ScreenState:
    """Capture the window and return a content fingerprint.

    The hash is computed over a downsampled copy: full-resolution
    hashes are sensitive to video-stream noise (compression flicker)
    even when nothing meaningful changed.
    """
    b = get_bounds()
    raw = tempfile.mktemp(prefix="imctl_verify_", suffix=".png")
    small = tempfile.mktemp(prefix="imctl_verify_s_", suffix=".png")
    try:
        subprocess.run(
            ["screencapture", "-x", f"-R{b.x},{b.y},{b.width},{b.height}", raw],
            check=True,
            timeout=10,
        )
        # Downsample to ~163x360 (half window) to suppress stream noise.
        subprocess.run(
            ["sips", "-z", "360", "163", raw, "--out", small],
            check=True,
            capture_output=True,
            timeout=10,
        )
        with open(small, "rb") as f:
            digest = hashlib.md5(f.read()).hexdigest()
        return ScreenState(md5=digest, width=b.width, height=b.height)
    finally:
        subprocess.run(["rm", "-f", raw, small], capture_output=True)


def changed(before: ScreenState, after: ScreenState) -> bool:
    """True if the screen content differs between two states."""
    return before.md5 != after.md5


def verify_action(action, *args, settle_s: float = 1.5, **kwargs) -> bool:
    """Run an action and report whether the screen changed.

    Usage:
        ok = verify_action(gestures.home)
    Returns True if the screen content changed after the action.
    """
    before = capture_hash()
    action(*args, **kwargs)
    import time

    time.sleep(settle_s)
    after = capture_hash()
    return changed(before, after)


def _capture_window_image(window_id: int):
    """CGWindowListCreateImage for one window id (injectable in tests).

    Reads the window's own pixels — valid even when other windows cover
    it. Module-level so tests can substitute a synthetic image instead
    of touching the real screen.
    """
    import Quartz

    return Quartz.CGWindowListCreateImage(
        Quartz.CGRectNull,
        Quartz.kCGWindowListOptionIncludingWindow,
        window_id,
        (Quartz.kCGWindowImageBoundsIgnoreFraming
         | Quartz.kCGWindowImageNominalResolution),
    )


def window_luma(size: tuple[int, int] = (36, 78)) -> bytes:
    """Capture the mirroring window as a small grayscale luma map.

    Reads the window's own pixels with CGWindowListCreateImage — valid
    even when other windows cover it — and renders them into an 8-bit
    gray bitmap whose backing store is a Python bytearray. No temp
    files, no sips, no subprocess (unlike capture_hash). Returns
    ``w*h`` bytes, one gray level (0-255) per pixel. Raises WindowError
    when the window cannot be found, is not on screen (hidden,
    minimized or on another Space), its image cannot be captured, or
    the frame is a near-single gray level: during window transitions
    CGWindowListCreateImage can hand back a blank/transparent frame,
    and a frame diff against it "confirms" changes that never happened
    on the phone (F25).
    """
    import Quartz

    w, h = size
    if w <= 0 or h <= 0:
        raise ValueError(f"size must be positive, got {size!r}")
    wi = get_window_info()
    if not wi:
        raise WindowError("iPhone Mirroring window not found")
    if not wi.get("onscreen", False):
        raise WindowError(
            "the mirroring window is not on screen "
            "(hidden, minimized or on another Space)"
        )
    import time

    img = None
    for attempt in range(3):
        img = _capture_window_image(wi["id"])
        if img is not None:
            buf = bytearray(w * h)  # bitmap backing store; never resized while ctx lives
            ctx = Quartz.CGBitmapContextCreate(
                buf, w, h, 8, w,
                Quartz.CGColorSpaceCreateDeviceGray(),
                Quartz.kCGImageAlphaNone,
            )
            if ctx is None:
                raise WindowError("CGBitmapContextCreate failed")
            Quartz.CGContextDrawImage(ctx, Quartz.CGRectMake(0, 0, w, h), img)
            luma = bytes(buf)
            if max(luma) - min(luma) >= 4:
                return luma
        # F31: a transition can hand back no image or a blank frame for a
        # moment; look again shortly. Only a real frame is ever accepted (F25).
        if attempt < 2:
            time.sleep(0.12)
    if img is None:
        raise WindowError("could not capture the mirroring window image")
    raise WindowError("the mirroring window frame is blank (a window transition)")


def is_capture_error(exc: BaseException) -> bool:
    """True when ``exc`` means the pixels a check needed are not the phone's.

    F25: WindowError (window missing, offscreen, or a blank/transparent
    frame) and CaptureError (screencapture by window id failed) both
    mean a verification could not observe the screen — every check that
    depends on a capture must count that as "unconfirmed", never as
    success.
    """
    return isinstance(exc, (WindowError, CaptureError))


def mean_abs_diff(a: bytes, b: bytes) -> float:
    """Mean absolute per-byte difference between two luma maps (0-255).

    Pure function — no capture, no I/O. Raises ValueError when the
    buffers are empty or of different lengths.
    """
    if not a or len(a) != len(b):
        raise ValueError("buffers must be non-empty and of equal length")
    return sum(abs(x - y) for x, y in zip(a, b)) / len(a)


# 待真机标定：粘贴后整窗 luma 帧差下限（type_text 确认粘贴已上屏的快路径阈值）。
TYPE_MIN_DIFF = 0.5


def text_probe(text: str) -> str | None:
    """The OCR probe for ``text`` (screen_shows_text's rule: the first ≤12
    characters after NFKC, lowercasing and whitespace removal), or None when
    it is shorter than 2 characters — too short for OCR to confirm."""
    probe = _compact(text)[:12]
    return probe if len(probe) >= 2 else None


def probe_count(text: str, hits) -> int | None:
    """How many times ``text``'s probe occurs in the joined OCR ``hits``;
    None when the text is too short for a probe. The phone's "Pasting from …"
    box is left out (F44): its words are never the typed text, even when the
    probe is a piece of them ("from", "pro" in a Mac named "M5pro")."""
    probe = text_probe(text)
    if probe is None:
        return None
    return _compact("".join(getattr(hit, "text", hit) for hit in hits
                            if not _is_paste_hud(hit))).count(probe)


# F44 (2026-11-05 real device, load ~25): when the phone is slow to fetch a paste
# it shows a "Pasting from <Mac name>…" progress box mid-screen. That box alone
# moves the whole-window frame diff past TYPE_MIN_DIFF while the text has not
# arrived, and type_text() reported such pastes as typed. English UI only: an
# iPhone in another language shows the box in that language, unrecognized here.
PASTE_HUD_PROBE = "pastingfrom"


def _is_paste_hud(hit) -> bool:
    return PASTE_HUD_PROBE in _compact(getattr(hit, "text", hit))


def shows_paste_hud(hits) -> bool:
    """True when one OCR hit reads like the phone's "Pasting from …" progress
    box (compared like probes: NFKC, lowercase, whitespace removed). While it
    shows, a paste is still on its way to the phone."""
    return any(_is_paste_hud(hit) for hit in hits)


def screen_shows_text(text: str, read_screen) -> bool:
    """Report whether the OCR'd screen shows ``text`` (probe match).

    The probe is the first min(12, len) characters of ``text`` after
    NFKC normalization, lowercasing, and whitespace removal; the OCR
    hits are normalized the same way and joined into one haystack.
    OCR is too unreliable for single characters, so a probe shorter
    than 2 characters always returns False.
    """

    def norm(s: str) -> str:
        return "".join(
            ch for ch in unicodedata.normalize("NFKC", s).lower() if not ch.isspace()
        )

    probe = norm(text)[:12]
    if len(probe) < 2:
        return False
    haystack = norm("".join(getattr(hit, "text", hit) for hit in read_screen()))
    return probe in haystack


def _compact(s: str) -> str:
    """NFKC, lowercase, whitespace removed."""
    return "".join(
        ch for ch in unicodedata.normalize("NFKC", s).lower() if not ch.isspace()
    )


def is_short_text(text: str, limit: int = 2) -> bool:
    """True when ``text`` normalizes to 1..``limit`` characters (F27).

    Such texts are OCR-fragile: Vision's full-frame pass can skip an isolated
    one- or two-character label entirely, so callers add a pass with
    vision.ocr_sweep().
    """
    return 0 < len(_compact(text)) <= limit


def _fold_label(s: str) -> str:
    """Exact-reading key for a short label (F27).

    NFKC, lowercase, whitespace removed, trailing ".,:;" dropped, and "×"
    folded to "x" — the readings Vision gives the one-letter app "X" — so
    "X", "x", "×", "X." and full-width "Ｘ" share one key while "Xcode" or
    "Box" never match it.
    """
    return _compact(s).rstrip(".,:;").replace("×", "x")


def new_text_positions(text: str, before, after, eps: float = 0.03) -> list:
    """Centres of hits in ``after`` reading exactly ``text`` where ``before`` had none (F27).

    Same matching as new_text_occurrences(); returns the (nx, ny) of each
    such hit instead of their count.
    """
    want = _fold_label(text)
    if not want:
        return []
    olds = [h for h in before if _fold_label(h.text) == want]
    return [
        (h.nx, h.ny) for h in after
        if _fold_label(h.text) == want
        and not any(abs(h.nx - o.nx) <= eps and abs(h.ny - o.ny) <= eps for o in olds)
    ]


class RepeatedSighting:
    """Evidence that a typed single character really arrived (F27/F33, review).

    One read showing the character at a new position is not enough: a
    label the baseline read missed, a banner, a list still moving or a
    "×" glyph can all pose as it. add() takes one read at a time and
    returns True once the SAME new position (within ``eps``) has shown up
    in two separate reads.
    """

    def __init__(self, text: str, before, eps: float = 0.03):
        self._text, self._before, self._eps = text, before, eps
        self._seen: list = []

    def add(self, hits) -> bool:
        new = new_text_positions(self._text, self._before, hits, self._eps)
        eps = self._eps
        repeated = any(abs(p[0] - q[0]) <= eps and abs(p[1] - q[1]) <= eps
                       for p in new for q in self._seen)
        self._seen.extend(new)
        return repeated


def wait_still(luma=None, *, sleep=None, clock=None, timeout_s: float = 1.5,
               poll_s: float = 0.15) -> bool:
    """Wait until two consecutive frames differ by less than TYPE_MIN_DIFF.

    True once the screen is still; False when it kept moving for
    ``timeout_s`` (an animation, a video). Capture errors propagate.
    """
    import time as _time

    luma = luma or window_luma
    sleep = sleep or _time.sleep
    clock = clock or _time.monotonic
    deadline = clock() + timeout_s
    prev = luma()
    while True:
        sleep(poll_s)
        cur = luma()
        if mean_abs_diff(prev, cur) < TYPE_MIN_DIFF:
            return True
        if clock() >= deadline:
            return False
        prev = cur


def new_text_occurrences(text: str, before, after, eps: float = 0.03) -> int:
    """Hits in ``after`` reading exactly ``text`` where ``before`` had none (F27).

    A hit counts when no matching hit in ``before`` lay within ``eps`` (in
    both axes) of it: evidence that a typed single character showed up even
    when an identical label was already on screen. Comparing positions rather
    than totals keeps a blinking text cursor — which makes the echo in a
    search field come and go between reads — from hiding the new result.
    """
    return len(new_text_positions(text, before, after, eps))


def screen_contains(expect: str, hits) -> bool:
    """Report whether the OCR'd screen contains ``expect`` (guard match).

    The hit texts are joined in reading order with single spaces; both
    the joined text and ``expect`` are NFKC-normalized, lowercased, and
    have whitespace runs collapsed to one space, so case, full-width
    characters, and whitespace differences do not matter, and a phrase
    split across two OCR fragments ("Replying" + "to") still matches.
    An ``expect`` that normalizes to empty never matches.
    """

    def norm(s: str) -> str:
        return " ".join(unicodedata.normalize("NFKC", s).lower().split())

    needle = norm(expect)
    if not needle:
        return False
    haystack = norm(" ".join(getattr(hit, "text", hit) for hit in hits))
    return needle in haystack

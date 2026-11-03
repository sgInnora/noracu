"""Local OCR via the macOS Vision framework.

Runs VNRecognizeTextRequest on a screenshot of the mirroring window
and returns text with normalized (0-1) coordinates, ready to feed into
input.tap(). Everything runs locally — no network, no API keys.

Coordinate convention: Vision returns bottom-left-origin bounding
boxes; we convert to top-left-origin (screen convention) and normalize
to the window size so results map directly onto tap(nx, ny).
"""

from __future__ import annotations

import atexit
import os
import shutil
import subprocess
import tempfile
import time
from dataclasses import dataclass

from .window import get_window_info


class OCRError(RuntimeError):
    """Raised when OCR fails."""


class CaptureError(Exception):
    """Raised when the mirroring window cannot be captured by window id (F25)."""


# Injectable so tests can drive capture_window() without ever running a
# real screencapture: this is the only place one is executed.
_run = subprocess.run


@dataclass(frozen=True)
class OCRHit:
    text: str
    nx: float  # normalized x of the text center (0-1)
    ny: float  # normalized y of the text center (0-1)
    confidence: float

    def __str__(self) -> str:
        return f"({self.nx:.2f},{self.ny:.2f}) {self.text!r} [{self.confidence:.2f}]"


def _capture_by_id(path: str) -> bool:
    """One ``screencapture -l`` attempt; True when a non-empty PNG landed.

    The window id is resolved fresh on every call, so the retry in
    capture_window() can pick up a window that was mid-transition
    (Space switch, un-minimize) on the first look.
    """
    info = get_window_info()
    if info is None:
        return False
    try:
        # A normal capture takes 0.1-1.2 s; on a loaded Mac one hung for
        # ~10 s, and with the retry that alone ate most of the server's
        # 30 s budget (2026-11-04). A hung attempt now fails after 4 s.
        r = _run(
            ["screencapture", "-x", "-o", "-l", str(info["id"]), path],
            capture_output=True,
            timeout=4,
        )
    except (OSError, subprocess.TimeoutExpired):
        # A missing or hung screencapture is a failed attempt, not a
        # crash: it takes the same retry-then-CaptureError path as a
        # nonzero return code, so callers report the capture as failed
        # instead of dying with a raw traceback (F25).
        return False
    return r.returncode == 0 and os.path.exists(path) and os.path.getsize(path) > 0


_FRAME_DIR: str | None = None


def _frame_path() -> str:
    """A new PNG path in this process's private temp directory.

    Mirror frames show whatever the phone shows (messages, notes, one-time
    codes). They used to land in the shared temp directory as world-readable
    files nothing deleted; now they go to an owner-only (0700) directory made
    once per process with mkdtemp and removed at exit, and read_screen() and
    find() delete each frame as soon as it has been read.
    """
    global _FRAME_DIR
    if _FRAME_DIR is None or not os.path.isdir(_FRAME_DIR):
        _FRAME_DIR = tempfile.mkdtemp(prefix="imctl_")
        atexit.register(shutil.rmtree, _FRAME_DIR, True)
    fd, path = tempfile.mkstemp(prefix="frame_", suffix=".png", dir=_FRAME_DIR)
    os.close(fd)
    return path


def discard_frame(path: str) -> None:
    """Delete a frame file; one that is already gone is fine."""
    try:
        os.remove(path)
    except OSError:
        pass


def capture_window(path: str | None = None) -> str:
    """Screenshot the mirroring window to a PNG file; returns the path.

    Captures by CGWindow id (``screencapture -l``) so the image is the window's own content even when
    other windows cover it or it is not frontmost. There is deliberately NO fallback to a screen-region
    capture of the AX bounds: a region capture returns whatever windows happen to sit inside those
    bounds — during a real session it once returned another app's sidebar, and every consumer (OCR,
    expect guards, paste confirmation) would have trusted those pixels as the phone (F25). When the
    window id cannot be resolved, or screencapture fails (nonzero exit, missing or hung binary) or
    writes nothing, one retry follows after 0.2 s (the window may be mid-transition); a second
    failure raises CaptureError so callers report the capture as failed instead of acting on
    another window's pixels.
    """
    owned = path is None
    if owned:
        path = _frame_path()
    if _capture_by_id(path):
        return path
    time.sleep(0.2)
    if _capture_by_id(path):
        return path
    if owned:
        discard_frame(path)
    raise CaptureError("could not capture the iPhone Mirroring window by id")


def ocr(image_path: str, languages: tuple[str, ...] = ("en-US", "zh-Hans"),
        language_correction: bool = True) -> list[OCRHit]:
    """Run Vision OCR on an image; return hits sorted reading-order.

    Uses the pyobjc Vision bindings (no subprocess Swift compile).
    ``language_correction`` feeds setUsesLanguageCorrection_: keep the
    default for prose, but pass False to read single-character labels
    (e.g. the app "X") — language correction often drops or rewrites
    those into other characters.
    """
    try:
        import Vision
        from Foundation import NSURL
        from Quartz import (
            CGImageSourceCreateWithURL,
            CGImageSourceCreateImageAtIndex,
            CGImageGetWidth,
            CGImageGetHeight,
        )
    except ImportError as exc:  # pragma: no cover
        raise OCRError(f"pyobjc frameworks missing: {exc}") from exc

    url = NSURL.fileURLWithPath_(image_path)
    src = CGImageSourceCreateWithURL(url, None)
    if src is None:
        raise OCRError(f"cannot open image: {image_path}")
    cg_image = CGImageSourceCreateImageAtIndex(src, 0, None)
    if cg_image is None:
        raise OCRError(f"cannot decode image: {image_path}")

    request = Vision.VNRecognizeTextRequest.alloc().init()
    request.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
    if hasattr(request, "setRecognitionLanguages_"):
        request.setRecognitionLanguages_(list(languages))
    request.setUsesLanguageCorrection_(language_correction)

    handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(
        cg_image, None
    )
    ok = handler.performRequests_error_([request], None)
    if not ok:
        raise OCRError("VNImageRequestHandler.performRequests failed")

    results = request.results() or []
    hits: list[OCRHit] = []
    for obs in results:
        cand = obs.topCandidates_(1)
        if not cand:
            continue
        cand = cand[0]
        box = obs.boundingBox()  # bottom-left origin, normalized
        cx = box.origin.x + box.size.width / 2
        cy_top = 1.0 - (box.origin.y + box.size.height / 2)  # flip to top-left
        hits.append(
            OCRHit(
                text=str(cand.string()),
                nx=cx,
                ny=cy_top,
                confidence=float(cand.confidence()),
            )
        )

    # Reading order: group by row (within 3% height), then left-to-right.
    hits.sort(key=lambda h: (round(h.ny / 0.03), h.nx))
    return hits


def dedupe_hits(hits: list[OCRHit], eps: float = 0.02) -> list[OCRHit]:
    """Collapse hits with the same text whose centres lie within ``eps``.

    The passes of ocr_sweep() read most labels several times; the most
    confident reading is kept.
    """
    kept: list[OCRHit] = []
    for hit in sorted(hits, key=lambda h: -h.confidence):
        if any(k.text == hit.text and abs(k.nx - hit.nx) <= eps
               and abs(k.ny - hit.ny) <= eps for k in kept):
            continue
        kept.append(hit)
    return kept


# F27 (2026-11-04): at Vision's default working scale the full-frame pass never
# reports an isolated single glyph (the app "X": its icon label, the Spotlight
# query echo). minimumTextHeight sets that working scale, and at these values
# the same full frame does report it. On 172 recorded mirror frames this sweep
# found all but 2 of the 56 "X" positions that reading the frame in overlapping
# strips found, plus 45 the strips missed (the Spotlight Top Hit label among
# them), at ~0.1 s per height instead of ~4 s for one strip read — fast enough
# that phone_open "X" stays well inside the server's 30 s limit.
SWEEP_MIN_TEXT_HEIGHTS = (0.018, 0.02, 0.022, 0.025, 0.03)


def ocr_sweep(image_path: str, languages: tuple[str, ...] = ("en-US", "zh-Hans"),
              language_correction: bool = False,
              heights: tuple[float, ...] = SWEEP_MIN_TEXT_HEIGHTS) -> list[OCRHit]:
    """Full-frame OCR once per minimumTextHeight in ``heights``; merged hits (F27).

    Finds isolated one- or two-character labels that ocr() at Vision's default
    scale skips. Hits are de-duplicated across heights (same text, centres
    within 0.02) and returned in reading order.
    """
    try:
        import Vision
        from Foundation import NSURL
        from Quartz import CGImageSourceCreateImageAtIndex, CGImageSourceCreateWithURL
    except ImportError as exc:  # pragma: no cover
        raise OCRError(f"pyobjc frameworks missing: {exc}") from exc

    src = CGImageSourceCreateWithURL(NSURL.fileURLWithPath_(image_path), None)
    if src is None:
        raise OCRError(f"cannot open image: {image_path}")
    cg_image = CGImageSourceCreateImageAtIndex(src, 0, None)
    if cg_image is None:
        raise OCRError(f"cannot decode image: {image_path}")

    hits: list[OCRHit] = []
    for min_height in heights:
        request = Vision.VNRecognizeTextRequest.alloc().init()
        request.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
        if hasattr(request, "setRecognitionLanguages_"):
            request.setRecognitionLanguages_(list(languages))
        request.setUsesLanguageCorrection_(language_correction)
        request.setMinimumTextHeight_(min_height)
        handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(
            cg_image, None)
        if not handler.performRequests_error_([request], None):
            raise OCRError("VNImageRequestHandler.performRequests failed")
        for obs in request.results() or []:
            cand = obs.topCandidates_(1)
            if not cand:
                continue
            cand = cand[0]
            box = obs.boundingBox()  # bottom-left origin, normalized
            hits.append(OCRHit(
                text=str(cand.string()),
                nx=box.origin.x + box.size.width / 2,
                ny=1.0 - (box.origin.y + box.size.height / 2),
                confidence=float(cand.confidence()),
            ))
    hits = dedupe_hits(hits)
    hits.sort(key=lambda h: (round(h.ny / 0.03), h.nx))
    return hits


def find(text: str, image_path: str | None = None,
         exact: bool = False) -> OCRHit | None:
    """Find the first OCR hit matching text; returns None if absent.

    A one- or two-character ``text`` the default pass misses is looked for
    again with ocr_sweep() (F27). A frame this captured itself is deleted
    after reading; a caller's ``image_path`` is left alone.
    """
    def first(hits):
        for hit in hits:
            if (hit.text == text) if exact else (text in hit.text):
                return hit
        return None

    owned = image_path is None
    path = image_path or capture_window()
    try:
        hit = first(ocr(path))
        if hit is None and 0 < len("".join(text.split())) <= 2:
            hit = first(ocr_sweep(path))
        return hit
    finally:
        if owned:
            discard_frame(path)


def read_screen(language_correction: bool = True, sweep: bool = False,
                also_sweep: bool = False) -> list[OCRHit]:
    """Convenience: capture + OCR the current mirroring window.

    ``language_correction`` is passed through to ocr(); see there.
    ``sweep=True`` reads with ocr_sweep() instead (F27). ``also_sweep=True``
    reads the same frame with both and merges the hits, so a short label
    the default pass skips is still there (F32). The frame is deleted once
    it has been read.
    """
    path = capture_window()
    try:
        if sweep:
            return ocr_sweep(path, language_correction=language_correction)
        hits = ocr(path, language_correction=language_correction)
        if also_sweep:
            hits = dedupe_hits(hits + ocr_sweep(path))
            hits.sort(key=lambda h: (round(h.ny / 0.03), h.nx))
        return hits
    finally:
        discard_frame(path)

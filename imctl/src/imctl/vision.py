"""Local OCR via the macOS Vision framework.

Runs VNRecognizeTextRequest on a screenshot of the mirroring window
and returns text with normalized (0-1) coordinates, ready to feed into
input.tap(). Everything runs locally — no network, no API keys.

Coordinate convention: Vision returns bottom-left-origin bounding
boxes; we convert to top-left-origin (screen convention) and normalize
to the window size so results map directly onto tap(nx, ny).
"""

from __future__ import annotations

import os
import subprocess
import tempfile
from dataclasses import dataclass

from .window import get_bounds, get_window_info


class OCRError(RuntimeError):
    """Raised when OCR fails."""


@dataclass(frozen=True)
class OCRHit:
    text: str
    nx: float  # normalized x of the text center (0-1)
    ny: float  # normalized y of the text center (0-1)
    confidence: float

    def __str__(self) -> str:
        return f"({self.nx:.2f},{self.ny:.2f}) {self.text!r} [{self.confidence:.2f}]"


def capture_window(path: str | None = None) -> str:
    """Screenshot the mirroring window to a PNG file; returns the path.

    Captures by CGWindow id (``screencapture -l``) so the image is the window's own content even when
    other windows cover it or it is not frontmost. Falls back to a screen-region capture of the AX bounds
    when the window id cannot be resolved.
    """
    if path is None:
        path = tempfile.mktemp(prefix="imctl_", suffix=".png")
    info = get_window_info()
    if info is not None:
        r = subprocess.run(
            ["screencapture", "-x", "-o", "-l", str(info["id"]), path],
            capture_output=True,
            timeout=10,
        )
        if r.returncode == 0 and os.path.exists(path) and os.path.getsize(path) > 0:
            return path
    b = get_bounds()
    subprocess.run(
        ["screencapture", "-x", f"-R{b.x},{b.y},{b.width},{b.height}", path],
        check=True,
        timeout=10,
    )
    return path


def ocr(image_path: str, languages: tuple[str, ...] = ("en-US", "zh-Hans")) -> list[OCRHit]:
    """Run Vision OCR on an image; return hits sorted reading-order.

    Uses the pyobjc Vision bindings (no subprocess Swift compile).
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
    request.setUsesLanguageCorrection_(True)

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


def find(text: str, image_path: str | None = None,
         exact: bool = False) -> OCRHit | None:
    """Find the first OCR hit matching text; returns None if absent."""
    path = image_path or capture_window()
    for hit in ocr(path):
        if (hit.text == text) if exact else (text in hit.text):
            return hit
    return None


def read_screen() -> list[OCRHit]:
    """Convenience: capture + OCR the current mirroring window."""
    return ocr(capture_window())

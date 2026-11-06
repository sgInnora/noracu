"""imctl — Control your iPhone from macOS via iPhone Mirroring.

A CLI tool that drives the iPhone Mirroring app on macOS with
CGEvent input, Vision OCR, and pixel-level verification.

Architecture:

- window.py  — AX-based dynamic window tracking (never assume position)
- input.py   — CGEvent engine: tap / long-press / swipe / scroll / key
- vision.py  — macOS Vision framework OCR with normalized coordinates
- verify.py  — pixel-hash diff to confirm actions took effect
- gestures.py — composed high-level gestures (home, app switcher, ...)
- cli.py     — argparse CLI entry point

Key design decisions (each backed by empirical testing):

1. Swipe uses 20-step ease-in-out interpolation with an initial 3px
   nudge. Single-shot drags are dropped by iPhone Mirroring's gesture
   recognizer; stepped drags are recognized reliably.
2. Text input goes through the clipboard (Cmd+V) to bypass IME
   interference, restoring the user's clipboard afterwards.
3. Tap uses a 50ms down-up interval (empirically the minimum that
   iPhone Mirroring registers reliably).
4. OCR runs locally via the Vision framework — no network, no API
   keys, and returns normalized (0-1) coordinates ready for tap().
5. Every window lookup is dynamic: the window may move or close
   between actions, so we re-resolve bounds before each gesture.
"""

__version__ = "0.2.0"
__all__ = ["cli", "window", "input", "vision", "verify", "gestures"]

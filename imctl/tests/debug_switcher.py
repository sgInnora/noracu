"""Debug script for app_switcher gesture tuning."""
import sys
sys.path.insert(0, "src")

import time
from imctl.window import get_bounds, ensure_frontmost
from imctl.input import _source, _ease_in_out
from imctl import verify
from Quartz import (
    CGEventCreateMouseEvent, CGEventPost,
    kCGEventLeftMouseDown, kCGEventLeftMouseUp, kCGEventLeftMouseDragged,
    kCGHIDEventTap, kCGMouseButtonLeft,
)


def app_switcher_v2(hold_s: float, drag_ms: int, steps: int = 30):
    b = get_bounds()
    x0, y0 = b.denormalize(0.5, 0.90)
    x1, y1 = b.denormalize(0.5, 0.45)
    src = _source()

    def ev(kind, x, y):
        CGEventPost(
            kCGHIDEventTap,
            CGEventCreateMouseEvent(src, kind, (x, y), kCGMouseButtonLeft),
        )

    ev(kCGEventLeftMouseDown, x0, y0)
    time.sleep(0.05)
    step_delay = (drag_ms / 1000.0) / steps
    for i in range(1, steps + 1):
        t = i / steps
        e = _ease_in_out(t)
        ev(kCGEventLeftMouseDragged, x0 + (x1 - x0) * e, y0 + (y1 - y0) * e)
        time.sleep(step_delay)
    time.sleep(hold_s)
    ev(kCGEventLeftMouseUp, x1, y1)


if __name__ == "__main__":
    ensure_frontmost()
    hold = float(sys.argv[1]) if len(sys.argv) > 1 else 1.0
    drag_ms = int(sys.argv[2]) if len(sys.argv) > 2 else 600
    ok = verify.verify_action(
        lambda: app_switcher_v2(hold, drag_ms), settle_s=2.5
    )
    print(f"app_switcher(hold={hold}s, drag={drag_ms}ms):", "OK" if ok else "FAIL")

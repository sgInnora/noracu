"""High-level gestures composed from the input engine.

These map to standard iOS interactions. Coordinates are normalized
(0-1) within the mirroring window. Gesture start points were chosen to
match iOS conventions (e.g. home swipe starts at the very bottom edge).

Phone-level actions that the mirroring app exposes as menu commands
(Spotlight, Home Screen) are triggered through those menus rather than
synthesized touch gestures — see the menu-command section below.
"""

from __future__ import annotations

import math
import subprocess
import time
import unicodedata

from . import input as inp
from . import verify
from . import vision
from .window import WindowError, ensure_frontmost, ensure_running, get_bounds


class GestureError(RuntimeError):
    """Raised when a composed gesture cannot complete."""


def home() -> None:
    """Swipe up from near the bottom edge: go to the home screen.

    Starts at 0.90 height: the bottom ~7% of the mirroring window is
    macOS window chrome (rounded corners / resize area), not the video
    surface — events there never reach the phone. 0.90 is the lowest
    point that reliably lands on the iOS home-indicator zone.
    """
    inp.swipe(0.5, 0.90, 0.5, 0.10, duration_ms=300)


def app_switcher() -> None:
    """Swipe up and hold: open the app switcher."""
    b = get_bounds()
    from Quartz import (
        CGEventCreateMouseEvent, CGEventPost, CGEventSourceCreate,
        kCGEventLeftMouseDown, kCGEventLeftMouseUp, kCGEventLeftMouseDragged,
        kCGEventSourceStateHIDSystemState, kCGHIDEventTap, kCGMouseButtonLeft,
    )
    import time

    x0, y0 = b.denormalize(0.5, 0.90)
    x1, y1 = b.denormalize(0.5, 0.45)
    src = CGEventSourceCreate(kCGEventSourceStateHIDSystemState)

    def ev(kind, x, y):
        CGEventPost(kCGHIDEventTap,
                    CGEventCreateMouseEvent(src, kind, (x, y), kCGMouseButtonLeft))

    ev(kCGEventLeftMouseDown, x0, y0)
    time.sleep(0.02)
    # Eased drag to mid-screen.
    steps = 15
    for i in range(1, steps + 1):
        t = i / steps
        e = t * t * (3 - 2 * t)  # smoothstep
        ev(kCGEventLeftMouseDragged, x0 + (x1 - x0) * e, y0 + (y1 - y0) * e)
        time.sleep(0.016)
    time.sleep(0.55)  # hold to trigger the switcher
    ev(kCGEventLeftMouseUp, x1, y1)


# Wheel pixels per window point of list movement, measured on iPhone Mirroring
# (Settings list, 524 pt window: between 1.1 and 1.6 px/pt across runs).
_SCROLL_PX_PER_PT = 1.3


def scroll_down(distance: float = 0.5) -> None:
    """Reveal content further down a list by about `distance` window heights.

    Uses trackpad-style scroll events; a vertical mouse drag does not scroll
    lists in iPhone Mirroring (F16). Swipes stay for gestures such as paging.
    """
    b = get_bounds()
    inp.scroll_trackpad(-distance * b.height * _SCROLL_PX_PER_PT, bounds=b)


def scroll_up(distance: float = 0.5) -> None:
    """Reveal content further up a list by about `distance` window heights."""
    b = get_bounds()
    inp.scroll_trackpad(distance * b.height * _SCROLL_PX_PER_PT, bounds=b)


# 待真机标定：一次 0.5 窗口高度滚动的整窗 luma 帧差下限。
SCROLL_MIN_DIFF = 2.0


def scroll_checked(direction, distance=0.5, *, luma=None, scroller=None,
                   sleep=time.sleep, settle_s=0.6) -> bool:
    """Scroll by `distance` window heights and confirm the screen moved (F20).

    `direction` is "up" or "down"; `distance` is in window heights and
    must satisfy 0 < distance <= 3. Both are validated before anything
    is captured or sent: the 0.1.1 tool description named no unit, so
    callers passed pixels (150-600) and a 600-window-height scroll was
    silently accepted as success.

    The scroll itself is the existing scroll_down/scroll_up trackpad
    events. A list already at its end, or a view that does not scroll,
    leaves the screen unchanged — this gate compares the mirroring
    window's luma before/after and reports that as False instead of
    success.

    `luma` (default verify.window_luma), `scroller` (default:
    scroll_down/scroll_up by direction) and `sleep` are injectable so
    tests can drive this without a phone.

    Returns True when the screen changed by at least SCROLL_MIN_DIFF.

    Capture failures are never swallowed (F25): a WindowError or
    CaptureError from the luma captures propagates to the caller (the
    CLI reports capture_failed) — an unreadable screen is not evidence
    that the scroll had no effect.
    """
    if direction not in ("up", "down"):
        raise ValueError(f"direction must be 'up' or 'down', got {direction!r}")
    if (not isinstance(distance, (int, float)) or isinstance(distance, bool)
            or not 0 < distance <= 3 or not math.isfinite(distance)):
        raise ValueError(
            "distance is in window heights, 0 < distance <= 3 (default 0.5); "
            f"got {distance!r}"
        )
    if luma is None:
        luma = verify.window_luma
    if scroller is None:
        scroller = lambda d, dist: (scroll_down if d == "down" else scroll_up)(dist)
    before = luma()
    scroller(direction, distance)
    sleep(settle_s)
    after = luma()
    return verify.mean_abs_diff(before, after) >= SCROLL_MIN_DIFF


def page_left() -> None:
    """Swipe right-to-left: go to the next home-screen page."""
    inp.swipe(0.8, 0.5, 0.2, 0.5, duration_ms=280)


def page_right() -> None:
    """Swipe left-to-right: go to the previous home-screen page."""
    inp.swipe(0.2, 0.5, 0.8, 0.5, duration_ms=280)


def pull_down_search() -> None:
    """Swipe down from mid-screen (DEPRECATED — never use for Spotlight).

    F13: iOS sometimes reads this swipe as an icon long-press-drag, which
    drops the home screen into edit (jiggle) mode — a stray tap on a "−"
    badge there offers to DELETE apps. open_spotlight() replaces it.
    Kept only as a raw gesture primitive; nothing in imctl calls it.
    """
    inp.swipe(0.5, 0.25, 0.5, 0.75, duration_ms=280)


# --- iPhone Mirroring menu commands -----------------------------------------
#
# The View menu of iPhone Mirroring exposes phone-level actions (Home
# Screen, App Switcher, Spotlight) as real menu commands, which iOS
# cannot misread as touch gestures. We trigger them by keyboard shortcut
# when one is readable — language-independent, because the shortcut
# character (AXMenuItemCmdChar), not the localized menu title, drives
# it — and fall back to clicking the English menu item.

# Static AppleScript only (invariant 1): script text is fixed; the menu
# item name travels as an osascript argument, never interpolated.
_MENU_SHORTCUT_SCRIPT = '''
on run(argv)
    tell application "System Events"
        tell process "iPhone Mirroring"
            set cc to ""
            set cm to ""
            try
                set cc to (value of attribute "AXMenuItemCmdChar" of menu item (item 1 of argv) of menu 1 of menu bar item "View" of menu bar 1) as text
            end try
            try
                set cm to (value of attribute "AXMenuItemCmdModifiers" of menu item (item 1 of argv) of menu 1 of menu bar item "View" of menu bar 1) as text
            end try
            return cc & "," & cm
        end tell
    end tell
end run
'''

_CLICK_MENU_ITEM_SCRIPT = '''
on run(argv)
    tell application "System Events"
        tell process "iPhone Mirroring"
            click menu item (item 1 of argv) of menu 1 of menu bar item "View" of menu bar 1
        end tell
    end tell
end run
'''


def _run_osascript(script: str, args: list[str] | None = None) -> str:
    """Run a static AppleScript; runtime values go through argv only."""
    cmd = ["osascript", "-e", script]
    if args:
        cmd += ["--"] + args
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
    if result.returncode != 0:
        raise GestureError(f"osascript failed: {result.stderr.strip()}")
    return result.stdout.strip()


def _view_menu_shortcut(item: str) -> tuple[str, int] | None:
    """Read a View menu item's shortcut — read-only, never clicks.

    Returns (cmdChar, cmdModifiers), or None when unreadable.
    AXMenuItemCmdModifiers uses the Carbon menu-modifier bits: 0 means
    the Command key alone (Spotlight is Cmd+3 here), 1 adds Shift,
    8 means no key equivalent at all.
    """
    try:
        raw = _run_osascript(_MENU_SHORTCUT_SCRIPT, [item])
    except (GestureError, OSError, subprocess.TimeoutExpired):
        return None
    char, sep, mods = raw.partition(",")
    if not sep:
        return None
    try:
        return char, int(mods.strip())
    except ValueError:  # "missing value" / empty — no usable shortcut
        return None


def _run_view_menu_command(item: str) -> bool:
    """Trigger a View menu command of iPhone Mirroring.

    Primary: the item's shortcut as a real Command chord (works on any
    UI language). Fallback: clicking the English menu item. Returns
    False when neither path works (app not running, localized menus…).
    """
    shortcut = _view_menu_shortcut(item)
    if shortcut is not None:
        char, mods = shortcut
        keycode = inp.keycode_for_char(char) if mods == 0 else None
        if keycode is not None:
            try:
                ensure_frontmost()
                inp._cmd_chord(keycode)
                return True
            except (inp.InputError, WindowError):
                pass  # fall through to clicking the menu item
    try:
        ensure_frontmost()
        _run_osascript(_CLICK_MENU_ITEM_SCRIPT, [item])
        return True
    except (GestureError, OSError, subprocess.TimeoutExpired, WindowError):
        return False


def open_spotlight() -> bool:
    """Open the phone's Spotlight search (View ▸ Spotlight).

    Never a swipe: the old pull-down could be misread by iOS as a
    long-press-drag that triggers home-screen edit mode (F13).
    """
    return _run_view_menu_command("Spotlight")


# Minimum mean-abs-luma diff (0-255 scale, verify.mean_abs_diff) for
# "Spotlight actually opened". Pending on-device calibration of the
# single "Home Screen → Spotlight" frame diff — the gate below always
# starts from the home screen, so that is the only scenario to
# calibrate.
SPOTLIGHT_MIN_DIFF = 6.0


def open_spotlight_checked(settle_s=1.0, *, luma=None, sleep=time.sleep, opener=None, home=None, home_settle_s=0.8) -> bool:
    """Go to the Home Screen, open Spotlight, and confirm it (F17 guard).

    Two layers of protection, in order:

    ① Home Screen first (View ▸ Home Screen). The home screen has no
    app input field, so even if every later step fails, the caller's
    clear_text() (Cmd+A + Delete) cannot delete user content. It also
    avoids re-sending the Spotlight command when Spotlight is already
    open: if that command is a toggle, it would close Spotlight, and
    the large screen change would fool layer ② into reporting success
    while the keystrokes land in the app underneath.

    ② A visible-change gate. open_spotlight() returning True only
    means the View ▸ Spotlight menu command was dispatched — not that
    Spotlight appeared on the phone. This gate compares the mirroring
    window's luma before and after the menu command and reports
    success only when the screen changed by at least
    SPOTLIGHT_MIN_DIFF (calibrated for the single home-screen →
    Spotlight transition).

    ``luma`` (default verify.window_luma), ``sleep``, ``opener``
    (default open_spotlight) and ``home`` (default: View ▸ Home
    Screen) are injectable so tests can drive this without a phone.
    """
    if luma is None:
        luma = verify.window_luma
    if opener is None:
        opener = open_spotlight
    if home is None:
        home = lambda: _run_view_menu_command("Home Screen")
    if not home():
        return False
    sleep(home_settle_s)
    before = luma()
    if not opener():
        return False
    sleep(settle_s)
    after = luma()
    return verify.mean_abs_diff(before, after) >= SPOTLIGHT_MIN_DIFF


# OCR look-alikes: characters Vision misreads a Latin letter as (the
# one-letter app "X" comes back as a multiplication sign, a Cyrillic
# ha, …). Only characters that get misread AS a Latin letter belong
# here — this is deliberately NOT a general transliteration table.
_LABEL_LOOKALIKES = {
    "×": "x",  # multiplication sign
    "х": "x",  # Cyrillic small letter ha (U+0445)
    "Х": "x",  # Cyrillic capital letter ha (U+0425)
}


def _norm_label(s: str) -> str:
    """Normalize an app label (or query) for exact comparison.

    NFKC (folds full-width "Ｘ" to "X") → strip → drop trailing
    punctuation OCR appends to labels ("X.") → lowercase → map the
    look-alike characters above to the Latin letter they get
    misread as. Lets very short names like "X" match what Vision
    actually returns without ever falling back to substring
    matching.
    """
    s = unicodedata.normalize("NFKC", s).strip()
    s = s.rstrip(".:·•,")
    s = s.lower()
    return "".join(_LABEL_LOOKALIKES.get(ch, ch) for ch in s)


def choose_app_hit(hits: list, name: str) -> vision.OCRHit | None:
    """Pick the Spotlight result row for ``name`` from OCR hits.

    iOS 26 draws the Spotlight search field at the BOTTOM of the screen
    (ny ≈ 0.95) and echoes the typed query inside it, so a plain text
    match finds the field itself. A result row must:
      - equal ``name`` after _norm_label() on BOTH sides (NFKC, strip,
        trailing-punctuation drop, lowercase, OCR look-alike folding —
        so the one-letter app "X" still matches labels Vision reads as
        "x", "×", "X." or full-width "Ｘ"), and
      - lie above the bottom search-field zone (ny < 0.88).
    The comparison stays EXACT — substring/prefix matching is
    forbidden: "X" must never hit "Xcode" or "X Corp". When several
    rows match, the topmost (smallest ny) wins. Returns None when
    nothing qualifies.
    """
    want = _norm_label(name)
    best = None
    for hit in hits:
        if _norm_label(hit.text) != want:
            continue
        if hit.ny >= 0.88:
            continue  # the search field echoing the query
        if best is None or hit.ny < best.ny:
            best = hit
    return best


def find_app_hit(read_screen, name, attempts=2, delay_s=1.0, sleep=time.sleep):
    """Read the screen up to ``attempts`` times for a Spotlight result row.

    Each pass calls ``read_screen()`` for OCR hits and hands them to
    choose_app_hit(); a match returns immediately. Between passes we
    wait ``delay_s`` — Spotlight results can lag the keystrokes, so a
    single read races them (F17). No sleep after the last pass. Returns
    None when no pass matches. ``read_screen`` and ``sleep`` are
    injectable so tests can drive this without a phone.

    Very short names (``_norm_label(name)`` ≤ 2 chars, e.g. "X") get one
    extra read per pass, with ``read_screen(language_correction=False)``:
    Vision's language correction tends to drop or rewrite
    single-character labels, and they are recognized more reliably
    without it. F27: Vision's full-frame pass can also skip such a label
    entirely (the app "X" on 2026-11-04), so a short name that both
    reads miss gets a third read with the minimumTextHeight sweep —
    ``read_screen(language_correction=False, sweep=True)``. The match
    stays exact either way. Long names keep the exact original
    read/sleep sequence.
    """
    short = len(_norm_label(name)) <= 2
    for i in range(attempts):
        hit = choose_app_hit(read_screen(), name)
        if hit is not None:
            return hit
        if short:
            hit = choose_app_hit(read_screen(language_correction=False), name)
            if hit is not None:
                return hit
            hit = choose_app_hit(
                read_screen(language_correction=False, sweep=True), name)
            if hit is not None:
                return hit
        if i + 1 < attempts:
            sleep(delay_s)
    return None


# 2026-11-03 在 iPhone 17 Pro Max 镜像上实测：Spotlight「Top Hit」卡片里
# App 图标中心在文字标签中心上方 0.052（标签中心 0.27 → 图标中心
# 0.218，单位为窗口高度比例）。
SPOTLIGHT_ICON_ABOVE_LABEL = 0.052

# 待真机标定：打开 App 前后整窗 luma 帧差下限。
OPEN_MIN_DIFF = 12.0


def _tophit_header(hits):
    """The OCR hit for the Spotlight "Top Hit" card header, or None.

    Matched exactly after _norm_label (case-folding, trailing
    punctuation), so a list row that merely contains the words can
    never pose as the card header.
    """
    want = _norm_label("Top Hit")
    for hit in hits:
        if _norm_label(hit.text) == want:
            return hit
    return None


def _tap_and_confirm_open(nx, ny, *, luma, sleep, tap, read_screen):
    """Tap (nx, ny) and confirm the app actually opened (F24 ②).

    One luma frame before the tap, one after a 1.0s settle, then one
    OCR read. The tap counts as opened only when BOTH hold: the
    whole-window frame diff reached OPEN_MIN_DIFF (the screen
    visibly left Spotlight — a dead tap leaves it nearly identical)
    and the "Top Hit" header is gone from the OCR read (a large
    diff alone can be the results list reflowing under a dead tap).
    Returns (opened, hits); ``hits`` is the post-tap OCR read, handed
    back so the caller can search it for the Top Hit header without
    reading the screen a second time.
    """
    before = luma()
    tap(nx, ny)
    sleep(1.0)
    after = luma()
    hits = read_screen()
    opened = (verify.mean_abs_diff(before, after) >= OPEN_MIN_DIFF
              and _tophit_header(hits) is None)
    return opened, hits


def open_app(name: str, *, spotlight_open: bool = False,
             read_screen=None, luma=None, sleep=time.sleep, tap=None,
             home=None, clear_text=None, type_text=None) -> str:
    """Open an app by name: Spotlight → clear → type → OCR → tap → CONFIRM.

    ``spotlight_open`` lets a caller that already ran
    open_spotlight_checked() itself (to tell "spotlight unavailable"
    apart from "app not found") skip the internal call and go
    straight to clear → type.

    Spotlight is opened through open_spotlight_checked(), which
    first returns to the Home Screen and only then opens Spotlight,
    and reports success only when the screen visibly changed: if the
    menu command silently failed, clear_text() (Cmd+A + Delete) would
    land in whatever focused text field the frontmost app shows (a
    note body, a message draft…) and wipe it — so on a failed gate
    this does nothing at all: no clearing, no typing, no taps (F17
    safety gate).

    The search field is cleared (Cmd+A + Delete) before typing: iOS
    keeps the previous Spotlight query, so the new name would be
    appended to it and no result row would match (F17). Results are
    then read up to twice (find_app_hit) because they can lag the
    keystrokes.

    The top hit is never opened with Return — it may belong to a
    different app than the requested one.

    F24 (2026-11-03 real-device retest): a tapped row is not an
    opened app. On iOS 27 Spotlight the OCR hit can be the Top Hit
    card's label UNDER the app icon, and tapping that label text
    does nothing — the screen stays on Spotlight while the caller
    was told "opened". So after find_app_hit matches a row:

    ① stability — wait 0.5s, re-read, re-pick with choose_app_hit.
    When the row moved by more than 0.02 the results were still
    reflowing: the second read wins, with at most one more read
    (still moving → the last read is authoritative).
    ② tap the row, then confirm via _tap_and_confirm_open (frame
    diff ≥ OPEN_MIN_DIFF and the "Top Hit" header gone).
    ③ when that tap did nothing and the hit sits inside the Top Hit
    card — the "Top Hit" header above the hit, less than 0.15 away —
    tap the icon SPOTLIGHT_ICON_ABOVE_LABEL above the label and
    confirm the same way. Any other hit gets NO second tap: an
    upward offset there could land on a different app's row.
    ④ still nothing confirmed → back to the Home Screen (View ▸
    Home Screen), reported as not_confirmed.

    A capture failure after the hit is found (WindowError /
    CaptureError, F25) counts as unconfirmed — no further taps.

    Returns "opened"; "not_found" (no row matched; back on the Home
    Screen); "not_confirmed" (row — and possibly the Top Hit icon —
    tapped but the app never verifiably opened; back on the Home
    Screen); or "spotlight_unavailable" (Spotlight could not be
    opened; nothing was typed or tapped).

    ``read_screen`` (default vision.read_screen), ``luma`` (default
    verify.window_luma), ``sleep``, ``tap`` (default inp.tap),
    ``home`` (default View ▸ Home Screen), ``clear_text`` and
    ``type_text`` are injectable so tests can drive this without a
    phone.
    """
    if read_screen is None:
        read_screen = vision.read_screen
    if luma is None:
        luma = verify.window_luma
    if tap is None:
        tap = inp.tap
    if home is None:
        home = lambda: _run_view_menu_command("Home Screen")
    if clear_text is None:
        clear_text = inp.clear_text
    pending: list = []
    if type_text is None:
        def type_text(text):
            return inp.type_text(text, pending=pending)
    raw_read = read_screen

    def read_screen(**kwargs):
        # F33: every later read is also evidence for a clipboard restore
        # type_text could not license in time (a paste that landed late).
        hits = raw_read(**kwargs)
        for restore in pending:
            restore.offer(hits)
        return hits

    short = len(_norm_label(name)) <= 2

    def reread():
        # F32: the default pass alone keeps missing a one-letter label, and
        # a missed row looked like a moved row — the tap then went to a
        # different row ("X" opened a Chrome search). Short names read the
        # same frame with the sweep too.
        return read_screen(also_sweep=True) if short else read_screen()

    # F34: one retry — on the device the Spotlight command was once ignored
    # right after an app closed. Each try starts from the Home Screen, so a
    # second try cannot toggle an open Spotlight shut.
    if not spotlight_open and not (open_spotlight_checked()
                                   or open_spotlight_checked()):
        return "spotlight_unavailable"
    clear_text()  # iOS kept the last query; new input would append (F17)
    sleep(0.3)
    typed = type_text(name)
    sleep(1.5)  # wait for Spotlight results

    # F33: a paste type_text did not see arrive may still be on its way (on
    # the device it once showed up 8-10 s after Cmd+V): one more read pass.
    hit = find_app_hit(read_screen, name, attempts=3 if typed is False else 2,
                       sleep=sleep)
    if hit is None:
        # Leave the phone tidy: back to the home screen (View ▸ Home Screen).
        home()
        return "not_found"

    try:
        # ① the Spotlight results can still be reflowing when
        # find_app_hit returns; re-read after 0.5s and re-pick.
        sleep(0.5)
        again = choose_app_hit(reread(), name)
        if again is not None:
            if math.hypot(again.nx - hit.nx, again.ny - hit.ny) > 0.02:
                # the row moved: the second read wins, with at most
                # one more read — still moving → the last one wins
                hit = again
                once_more = choose_app_hit(reread(), name)
                if (once_more is not None
                        and math.hypot(once_more.nx - hit.nx,
                                       once_more.ny - hit.ny) > 0.02):
                    hit = once_more
            # else: the two reads agree — the first hit stands

        # ② tap the row (the label inside the Top Hit card) and confirm
        opened, hits = _tap_and_confirm_open(
            hit.nx, hit.ny, luma=luma, sleep=sleep, tap=tap,
            read_screen=read_screen)
        if opened:
            return "opened"

        # ③ the label tap did nothing and the hit sits inside the Top
        # Hit card → tap the icon above the label. Anywhere else, no
        # second tap: an upward offset could hit another app's row.
        header = _tophit_header(hits)
        if (header is not None and header.ny < hit.ny
                and hit.ny - header.ny < 0.15):
            opened, _ = _tap_and_confirm_open(
                hit.nx, hit.ny - SPOTLIGHT_ICON_ABOVE_LABEL,
                luma=luma, sleep=sleep, tap=tap, read_screen=read_screen)
            if opened:
                return "opened"
    except Exception as exc:
        if not verify.is_capture_error(exc):
            raise
        # F25: an unreadable screen is not evidence the app opened —
        # no further taps; wrap up unconfirmed below.

    # ④ leave the phone tidy and say the taps were not confirmed
    home()
    return "not_confirmed"


def read_text() -> list:
    """OCR the current screen; returns vision.OCRHit list."""
    return vision.read_screen()


def status() -> dict:
    """Return a status dict for the mirroring session.

    Keys: running; and when running: window {x,y,w,h} (AX bounds), window_id, onscreen, frontmost,
    live (True/False/null — is the phone stream up), overlay (text shown over the stream when not
    live, e.g. a paused/connecting notice), paused (True/False, or null when the state is unknown).
    """
    from .window import (
        get_overlay, get_window_info, is_frontmost, is_paused, is_running,
    )

    running = is_running()
    info = {"running": running}
    if running:
        try:
            b = get_bounds()
            info["window"] = {"x": b.x, "y": b.y, "w": b.width, "h": b.height}
        except Exception as exc:
            info["window_error"] = str(exc)
        wi = get_window_info()
        if wi:
            info["window_id"] = wi["id"]
            info["onscreen"] = wi["onscreen"]
        info["frontmost"] = is_frontmost()
        overlay = get_overlay()
        info["live"] = overlay["live"]
        info["overlay"] = overlay["overlay"]
        info["paused"] = is_paused(overlay)
    return info


def resume() -> bool:
    """Resume a paused mirroring session (clicks Resume). Returns True when not paused afterwards."""
    from .window import resume as _resume

    return _resume()


def launch() -> bool | None:
    """Ensure iPhone Mirroring is running, frontmost, and not paused.

    Returns the stream state afterwards: True live, False still paused or connecting,
    None unknown. F29: resume()'s result used to be dropped, so phone_launch reported
    "ready" while the overlay was still up.
    """
    ensure_running()
    from .window import ensure_frontmost, get_overlay, resume as _resume

    ensure_frontmost()
    if _resume():
        return True
    return get_overlay()["live"]

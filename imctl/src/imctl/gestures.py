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
import os
import re
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
    """Swipe up and hold: send the app-switcher gesture."""
    ensure_frontmost()
    b = get_bounds()
    x0, y0 = b.denormalize(0.5, 0.90)
    x1, y1 = b.denormalize(0.5, 0.45)
    src = inp._source()
    inp._require_focus()  # F26 / R13 §3: before mouse-down
    cx, cy = x0, y0
    inp._mouse_event(inp.kCGEventLeftMouseDown, cx, cy, src)
    try:
        time.sleep(0.02)
        # Eased drag to mid-screen.
        steps = 15
        for i in range(1, steps + 1):
            t = i / steps
            e = t * t * (3 - 2 * t)  # smoothstep
            nx, ny = x0 + (x1 - x0) * e, y0 + (y1 - y0) * e
            inp._mouse_event(inp.kCGEventLeftMouseDragged, nx, ny, src)
            cx, cy = nx, ny
            time.sleep(0.016)
        inp._require_focus()  # R18: before the hold, the mirror must still be in front
        time.sleep(0.55)  # hold to trigger the switcher
    finally:
        inp._mouse_event(inp.kCGEventLeftMouseUp, cx, cy, src)


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


# F45 (device run 2026-11-07): iPhone Mirroring turns a mouse drag into pointer input, and a
# pointer drag that starts on an app icon picks the icon up at once. A page swipe at mid-height
# starts on an icon row: twice it carried an icon onto another one and made a folder (and left the
# Home Screen in edit mode, where every icon shows a "−" delete badge). Page swipes start in the
# empty strip between the last icon row and the Dock, where the page dots are; five swipes there
# paged without picking anything up.
PAGE_SWIPE_NY = 0.80
PAGE_SWIPE_FROM_NX = 0.9
PAGE_SWIPE_TO_NX = 0.1


def page_left() -> None:
    """Swipe right-to-left: go to the next home-screen page (from the strip above the Dock, F45)."""
    inp.swipe(PAGE_SWIPE_FROM_NX, PAGE_SWIPE_NY, PAGE_SWIPE_TO_NX, PAGE_SWIPE_NY, duration_ms=280)


def page_right() -> None:
    """Swipe left-to-right: go to the previous home-screen page (from the strip above the Dock, F45)."""
    inp.swipe(PAGE_SWIPE_TO_NX, PAGE_SWIPE_NY, PAGE_SWIPE_FROM_NX, PAGE_SWIPE_NY, duration_ms=280)


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


def _run_osascript(script: str, args: list[str] | None = None, timeout: float = 10) -> str:
    """Run a static AppleScript; runtime values go through argv only."""
    cmd = ["osascript", "-e", script]
    if args:
        cmd += ["--"] + args
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if result.returncode != 0:
        raise GestureError(f"osascript failed: {result.stderr.strip()}")
    return result.stdout.strip()


def _view_menu_shortcut(item: str, timeout: float = 10) -> tuple[str, int] | None:
    """Read a View menu item's shortcut — read-only, never clicks.

    Returns (cmdChar, cmdModifiers), or None when unreadable.
    AXMenuItemCmdModifiers uses the Carbon menu-modifier bits: 0 means
    the Command key alone (Spotlight is Cmd+3 here), 1 adds Shift,
    8 means no key equivalent at all.
    """
    try:
        raw = _run_osascript(_MENU_SHORTCUT_SCRIPT, [item], timeout=timeout)
    except (GestureError, OSError, subprocess.TimeoutExpired):
        return None
    char, sep, mods = raw.partition(",")
    if not sep:
        return None
    try:
        return char, int(mods.strip())
    except ValueError:  # "missing value" / empty — no usable shortcut
        return None


def _run_view_menu_command(item: str, timeout: float = 10) -> bool:
    """Trigger a View menu command of iPhone Mirroring.

    Primary: the item's shortcut as a real Command chord (works on any
    UI language). Fallback: clicking the English menu item. Returns
    False when neither path works (app not running, localized menus…).
    ``timeout`` bounds each osascript run it makes, including those that
    bring the mirror to the front.
    """
    shortcut = _view_menu_shortcut(item, timeout=timeout)
    if shortcut is not None:
        char, mods = shortcut
        keycode = inp.keycode_for_char(char) if mods == 0 else None
        if keycode is not None:
            try:
                ensure_frontmost(timeout=timeout)
                inp._cmd_chord(keycode)
                return True
            except (inp.InputError, WindowError, OSError, subprocess.TimeoutExpired):
                pass  # fall through to clicking the menu item
    try:
        ensure_frontmost(timeout=timeout)
        _run_osascript(_CLICK_MENU_ITEM_SCRIPT, [item], timeout=timeout)
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


def open_spotlight_checked(settle_s=1.0, *, luma=None, sleep=time.sleep, opener=None, home=None,
                           home_settle_s=0.8, read_screen=None) -> bool:
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

    ③ F43 (2026-11-05 real-device, iOS 27): going Home from an app that
    was opened from Spotlight lands back IN Spotlight, with the previous
    query and its Top Hit card. The Spotlight command then closed it, and
    that big change fooled layer ② into "opened" while the paste went to
    the Home Screen (every phone_open right after a successful one
    failed). When Home itself brought up a Top Hit card (none was on
    screen before it), Spotlight is already open: it is reported as open
    and no toggle is sent (the caller clears the old query first). A card
    that was there before Home may be another app's (Safari shows one) with
    Home ignored, so then — and when a read fails — layer ② decides. Known limit: a previous query
    without a Top Hit card (no results) is not recognized, and the toggle
    still closes that Spotlight.

    ``luma`` (default verify.window_luma), ``sleep``, ``opener``
    (default open_spotlight), ``home`` (default: View ▸ Home Screen)
    and ``read_screen`` (default vision.read_screen) are injectable so
    tests can drive this without a phone.
    """
    if luma is None:
        luma = verify.window_luma
    if read_screen is None:
        read_screen = vision.read_screen
    if opener is None:
        opener = open_spotlight
    if home is None:
        home = lambda: _run_view_menu_command("Home Screen")

    def card():
        # a Top Hit card header near the top of the window (Spotlight's sits at ny ≈ 0.14; a
        # "Top Hit" line far down is no evidence), "none", or "unreadable"
        try:
            header = _tophit_header(read_screen())
        except Exception as exc:
            if not verify.is_capture_error(exc):
                raise
            return "unreadable"
        return "card" if header is not None and header.ny < SPOTLIGHT_HEADER_MAX_NY else "none"

    before_home = card()
    if not home():
        return False
    sleep(home_settle_s)
    # F43: Home itself brought up a Top Hit card — Spotlight with the previous query: do not
    # toggle it shut. A card that was already there before Home may be another app's own
    # (Safari shows one too) with Home ignored; then, and when unsure, the gate below decides.
    if before_home == "none" and card() == "card":
        return True
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


# open_spotlight_checked() takes a Top Hit header only this high up the window as proof that
# Spotlight is open (the header measured at ny ≈ 0.14).
SPOTLIGHT_HEADER_MAX_NY = 0.3

# Spotlight's search field is in the bottom part of the window (ny >= SEARCH_FIELD_NY) and echoes
# the typed query. choose_app_hit never takes a label there; open_app reads that echo as the proof
# that a late paste has reached the phone (F42). 2026-11-06 device run (macOS 27.2 / iOS 27): the
# field is not always at the very bottom — it sat at ny ≈ 0.93 on one screen and floated at
# ny ≈ 0.82 on others ("Q Search" read at 0.821 before typing, the query at 0.821–0.823 after),
# where the old 0.88 bound never saw it: every unmatched name waited out the late-paste reads and
# was reported as never typed, and "X" ran out of time. The Top Hit card stays above 0.3.
SEARCH_FIELD_NY = 0.78

# The field echo is only evidence that the paste arrived — it never picks what is tapped — so a
# long name may differ from it by an OCR slip or two (seen on the device: "Zaxwv" and "Zqxw" for
# "Zqxwv"). Short names stay exact.
ECHO_FUZZY_MIN_LEN = 6      # names this long tolerate one edit …
ECHO_FUZZY_TWO_LEN = 14     # … and this long, two


def _edit_distance(a: str, b: str, limit: int) -> int:
    """Levenshtein distance between a and b, or limit + 1 once it is certain to exceed limit."""
    if abs(len(a) - len(b)) > limit:
        return limit + 1
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        if min(cur) > limit:
            return limit + 1
        prev = cur
    return prev[-1]


def _echo_matches(got: str, want: str) -> bool:
    """The field text ``got`` shows the query ``want`` (both _norm_label'ed)."""
    if got == want:
        return True
    edits = (1 if len(want) >= ECHO_FUZZY_MIN_LEN else 0) + (1 if len(want) >= ECHO_FUZZY_TWO_LEN else 0)
    return edits > 0 and _edit_distance(got, want, edits) <= edits


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


# Two matching labels closer than this in both axes are one label read twice (choose_app_hit, Y6).
SAME_SPOT_EPS = 0.03


def choose_app_hit(hits: list, name: str, ambiguous: list | None = None) -> vision.OCRHit | None:
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
    forbidden: "X" must never hit "Xcode" or "X Corp". Returns None
    when nothing qualifies.

    Y6 (review R37, 2026-11-07): when labels that match sit at two or
    more different spots inside the card (more than SAME_SPOT_EPS apart
    in either axis), nothing says which one is the app, so none is
    chosen: the result is None and, when the caller passes a list as
    ``ambiguous``, True is appended to it. Matches at one spot (the same
    label read twice) are one label; the topmost of them is returned.

    F35 (2026-11-05 real-device): an exact label is not an app. The
    query "Pinduoduo" matched a Chrome *suggestion* row of that name
    (the app's own Top Hit label reads 拼多多), the tap opened a web
    search, and the open was reported as confirmed. Only a row INSIDE
    the Top Hit card counts now: below the "Top Hit" header and at
    most TOP_HIT_CARD_SPAN under it — the same geometry the icon
    fallback in open_app() already relies on. No header, or no exact
    label inside the card → None: "not found" beats opening the
    wrong thing. Suggestion, website and Settings deep-link rows of
    the same name are never candidates.
    """
    want = _norm_label(name)
    header = _tophit_header(hits)
    if header is None:
        return None
    found = []
    for hit in hits:
        if _norm_label(hit.text) != want:
            continue
        if hit.ny >= SEARCH_FIELD_NY:
            continue  # the search field echoing the query
        if not header.ny < hit.ny <= header.ny + TOP_HIT_CARD_SPAN:
            continue  # outside the Top Hit card (F35)
        found.append(hit)
    if not found:
        return None
    best = min(found, key=lambda h: h.ny)
    if any(abs(h.nx - best.nx) > SAME_SPOT_EPS or abs(h.ny - best.ny) > SAME_SPOT_EPS for h in found):
        if ambiguous is not None:
            ambiguous.append(True)
        return None  # Y6: several labels of the same name are never tapped
    return best


def find_app_hit(read_screen, name, attempts=2, delay_s=1.0, sleep=time.sleep,
                 deadline=None, clock=time.monotonic, ambiguous=None):
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
    reads miss gets a third read that adds the minimumTextHeight sweep
    to the default pass on the same frame —
    ``read_screen(language_correction=False, also_sweep=True)`` (F35:
    the Top Hit header must be in the same read as the label). The match
    stays exact either way. Long names keep the exact original
    read/sleep sequence. ``deadline`` (a ``clock()`` value) is checked
    before every read; once reached, no further read happens.
    ``ambiguous`` is handed to every choose_app_hit() call (Y6).
    """
    short = len(_norm_label(name)) <= 2

    def expired():
        return deadline is not None and clock() >= deadline

    reads = [{}]
    if short:
        # F35: the sweep finds the one-letter label, but choose_app_hit also
        # needs the "Top Hit" header from the SAME frame — the last read uses
        # both the default pass and the sweep (also_sweep), not the sweep alone.
        reads += [{"language_correction": False},
                  {"language_correction": False, "also_sweep": True}]
    for i in range(attempts):
        if i:
            if expired():
                return None
            sleep(delay_s)
        for kwargs in reads:
            if expired():
                return None  # out of time before this read (open_app reports it)
            hit = choose_app_hit(read_screen(**kwargs), name, ambiguous)
            if hit is not None:
                return hit
    return None


# 2026-11-03 在 iPhone 17 Pro Max 镜像上实测：Spotlight「Top Hit」卡片里
# App 图标中心在文字标签中心上方 0.052（标签中心 0.27 → 图标中心
# 0.218，单位为窗口高度比例）。
SPOTLIGHT_ICON_ABOVE_LABEL = 0.052

# Top Hit 卡片的纵向范围：卡片内的行在 "Top Hit" 标题下方、且距标题不超过这个
# 窗高比例。2026-11-05（macOS 27.2 / iOS 27）实测：标题 0.136，卡片内标签 0.24，
# 下一个分区标题 "Suggestions" 0.294，第一条建议行 0.336 —— 0.15 落在卡片与
# 建议区之间。choose_app_hit()（F35）与 open_app() 的图标兜底共用这一个值。
TOP_HIT_CARD_SPAN = 0.15

# 待真机标定：打开 App 前后整窗 luma 帧差下限。
OPEN_MIN_DIFF = 12.0

# open_app's own time budget (seconds). The server stops `open` at 45 s from outside; a run
# that is killed there can leave Spotlight open with the name typed in. open_app checks this
# budget before every read pass and tap and, once it is spent, goes back to the Home Screen
# and reports "deadline" instead (F39).
OPEN_DEADLINE_S = 38.0

# F42 (2026-11-05 real-device): a paste reached the phone anywhere from 1.5 s to more than 10 s
# after Cmd+V — the text travels to the iPhone only when it pastes. When type_text did not see
# the paste arrive, open_app keeps reading Spotlight, one pass a second, for up to this long
# (within its budget). Once the search field shows the name, the query is in, and one more pass
# is enough — a Top Hit card alone may still be the previous query's.
OPEN_LATE_PASTE_S = 15.0   # a later device run under load saw ~15 s from Cmd+V to the echo
OPEN_LATE_PASTE_PASSES = 30   # a cap for injected clocks; the time limit normally ends it first
# A one- or two-letter name almost never shows as an echo (2026-11-06 device run: "X" in the
# field in 2 of 24 reads, its Top Hit label in none), so waiting for one only ran phone_open into
# its time limit. Short names get this much late reading — at least one full pass — and then
# open_app reports "short_unreadable" instead of not_found / not_typed, which it cannot tell apart.
OPEN_LATE_SHORT_S = 4.0


# The Spotlight "Top Hit" section label phone_open looks for. English by default;
# NORACU_TOPHIT_LABELS (comma-separated) supplies the label of an iPhone set to another
# language, exactly as the phone shows it (no unverified translations built in).
def _tophit_labels(raw):
    # ASCII and full-width commas, and the ideographic enumeration comma
    parts = re.split(r"[,，、]", raw or "")
    labels = tuple(_norm_label(x) for x in parts if x.strip())
    return labels or (_norm_label("Top Hit"),)


TOP_HIT_LABELS = _tophit_labels(os.environ.get("NORACU_TOPHIT_LABELS"))


def _field_echo(hits, name) -> bool:
    """True when the search field shows ``name`` (F42).

    The field is the bottom zone (ny >= SEARCH_FIELD_NY); OCR may read the
    magnifier glyph in front of the text as a "Q". Compared after
    _norm_label; a name of ECHO_FUZZY_MIN_LEN characters or more tolerates
    one OCR slip (two from ECHO_FUZZY_TWO_LEN) — this only says the paste
    arrived, it never decides a tap.
    """
    want = _norm_label(name)
    for hit in hits:
        if hit.ny < SEARCH_FIELD_NY:
            continue
        got = _norm_label(hit.text)
        # the magnifier glyph may come back as "Q", "Q." or "Q:" in front of the text
        if _echo_matches(got, want) or _echo_matches(re.sub(r"^q[\s.,:;·•]*", "", got, count=1), want):
            return True
    return False


def _tophit_header(hits):
    """The OCR hit for the Spotlight "Top Hit" card header, or None.

    Matched exactly after _norm_label (case-folding, trailing
    punctuation) against TOP_HIT_LABELS, so a list row that merely
    contains the words can never pose as the card header. Several
    matches → the first in reading order (the topmost).
    """
    for hit in hits:
        if _norm_label(hit.text) in TOP_HIT_LABELS:
            return hit
    return None


# open_app's tidy-up trip to the Home Screen must fit inside the time the server leaves after
# its deadline (two 10 s osascript runs did not), so it uses shorter ones.
TIDY_OSASCRIPT_TIMEOUT_S = 4.0


def home_via_menu(timeout: float = TIDY_OSASCRIPT_TIMEOUT_S) -> bool:
    """View ▸ Home Screen in iPhone Mirroring (what open_app uses to tidy up)."""
    return _run_view_menu_command("Home Screen", timeout=timeout)


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
             home=None, clear_text=None, type_text=None,
             clock=time.monotonic, deadline_s: float | None = OPEN_DEADLINE_S,
             report: dict | None = None) -> str:
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
    keystrokes — or, when type_text did not see the paste arrive, once a
    second for up to OPEN_LATE_PASTE_S (F42): once the search field shows
    the name, one more pass.

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
    ③ when that tap did nothing and the post-tap read still shows the
    exact label inside the Top Hit card (choose_app_hit, F35), tap the
    icon SPOTLIGHT_ICON_ABOVE_LABEL above THAT label and confirm the
    same way. Otherwise NO second tap: an upward offset from a stale
    position could land on a different app's row.
    ④ still nothing confirmed → back to the Home Screen (View ▸
    Home Screen), reported as not_confirmed.

    A capture failure after the hit is found (WindowError /
    CaptureError, F25) counts as unconfirmed — no further taps.

    Returns "opened"; "not_found" (a Top Hit card was seen, but never
    with exactly this name; back on the Home Screen); "no_top_hit" (no
    read showed Spotlight's "Top Hit" header at all — no such app, or a
    non-English iPhone; back on the Home Screen); "not_confirmed" (row
    — and possibly the Top Hit icon — tapped but the app never
    verifiably opened; back on the Home Screen); "not_typed" (type_text
    did not see the paste arrive and the search field never showed the
    name during the late-paste reads either — the name may never have
    reached the phone, so this is no evidence the app is missing; back on
    the Home Screen);
    "short_unreadable" (a one- or two-letter name that no read matched
    within OPEN_LATE_SHORT_S of late reading: OCR misses such text in the
    Top Hit card and the search field alike, so whether it was typed or
    the app exists is unknown — nothing was tapped; back on the Home Screen);
    "deadline" (the OPEN_DEADLINE_S budget ran out before a tap; back on
    the Home Screen); "ambiguous" (Y6: the Top Hit card showed the name at
    two or more spots and no read showed it at one — nothing was tapped;
    back on the Home Screen); or "spotlight_unavailable" (Spotlight could
    not be opened; nothing was typed or tapped).

    ``read_screen`` (default vision.read_screen), ``luma`` (default
    verify.window_luma), ``sleep``, ``tap`` (default inp.tap),
    ``home`` (default View ▸ Home Screen), ``clear_text`` and
    ``type_text`` are injectable so tests can drive this without a
    phone. ``report`` (a dict), when given, receives ``home``: whether
    the last trip back to the Home Screen worked.
    """
    if read_screen is None:
        read_screen = vision.read_screen
    if luma is None:
        luma = verify.window_luma
    if tap is None:
        tap = inp.tap
    if home is None:
        home = home_via_menu

    def tidy():
        # back to the Home Screen; the caller learns whether that worked
        ok = bool(home())
        if report is not None:
            report["home"] = ok
        return ok

    if clear_text is None:
        clear_text = inp.clear_text
    pending: list = []
    if type_text is None:
        def type_text(text):
            # F42: never give the clipboard back here — the name can reach the phone more
            # than 10 s after Cmd+V, and Spotlight can show it in its own suggestions before
            # that; a restore in between would paste the user's clipboard into the search
            return inp.type_text(text, pending=pending, restore=False)
    raw_read = read_screen
    deadline = None if deadline_s is None else clock() + deadline_s
    saw_top_hit = [False]
    saw_echo = [False]
    ambiguous: list = []  # Y6: a read showed the name at two or more spots in the card

    def read_screen(**kwargs):
        # F33: every later read is also evidence for a clipboard restore an
        # injected type_text may have handed over (the default never does: F42).
        hits = raw_read(**kwargs)
        for restore in pending:
            restore.offer(hits)
        if _tophit_header(hits) is not None:
            saw_top_hit[0] = True  # tells "not_found" apart from "no_top_hit"
        if _field_echo(hits, name):
            saw_echo[0] = True  # F42: the name is in the search field — the paste arrived
        return hits

    def out_of_time():
        return deadline is not None and clock() >= deadline

    short = len(_norm_label(name)) <= 2

    def reread():
        # F32: the default pass alone keeps missing a one-letter label, and
        # a missed row looked like a moved row — the tap then went to a
        # different row ("X" opened a Chrome search). Short names read the
        # same frame with the sweep too.
        return read_screen(also_sweep=True) if short else read_screen()

    # F34: one retry — on the device the Spotlight command was once ignored
    # right after an app closed. Each try goes Home first; when Home lands back in
    # Spotlight (iOS 27, F43) the gate reports it open instead of toggling it shut.
    if not spotlight_open and not (open_spotlight_checked()
                                   or open_spotlight_checked()):
        return "spotlight_unavailable"
    if out_of_time():
        # the budget was spent before anything was typed (a tiny
        # NORACU_PHONE_TIMEOUT_MS, or a slow start) — do not clear or type at all
        tidy()
        return "deadline"
    clear_text()  # iOS kept the last query; new input would append (F17)
    sleep(0.3)
    typed = type_text(name)
    sleep(1.5)  # wait for Spotlight results
    hit = None
    if typed is not False:
        hit = find_app_hit(read_screen, name, attempts=2, sleep=sleep,
                           deadline=deadline, clock=clock, ambiguous=ambiguous)
    if hit is None and not saw_echo[0]:
        # F33/F42: the name is not in the search field yet — the paste may still be on its
        # way, whether type_text missed it or took another change for it (a clear that
        # landed late redraws the results: seen on the device after a back-to-back open)
        limit = clock() + (OPEN_LATE_SHORT_S if short else OPEN_LATE_PASTE_S)
        if deadline is not None:
            limit = min(limit, deadline)
        echo_passes = 0
        for i in range(OPEN_LATE_PASTE_PASSES):
            # the pass right after the first echo still runs past the limit (the results
            # trail the query by a moment), but never past the open budget
            confirming = echo_passes == 1
            if i:
                stop_at = deadline if confirming else limit
                if stop_at is not None and clock() >= stop_at:
                    break
                sleep(1.0)
            hit = find_app_hit(read_screen, name, attempts=1, sleep=sleep,
                               deadline=deadline if confirming else limit, clock=clock,
                               ambiguous=ambiguous)
            if hit is not None:
                break
            # only the search field showing the name proves the paste arrived — a Top Hit
            # card may still be the previous query's; once it is in, one more pass
            if saw_echo[0]:
                echo_passes += 1
                if echo_passes >= 2:
                    break
    if hit is None:
        # Leave the phone tidy: back to the home screen (View ▸ Home Screen).
        tidy()
        if out_of_time():
            return "deadline"
        if ambiguous:
            return "ambiguous"  # Y6: the card showed the name at more than one spot
        if short:
            # OCR misses one- and two-letter text in the card and in the field alike: neither
            # "not typed" nor "not found" is known — say that instead (2026-11-06 device run)
            return "short_unreadable"
        if not saw_echo[0]:
            return "not_typed"  # F42: the name never showed up in the search field
        return "not_found" if saw_top_hit[0] else "no_top_hit"

    try:
        if out_of_time():
            tidy()
            return "deadline"
        # ① the Spotlight results can still be reflowing when
        # find_app_hit returns; re-read after 0.5s and re-pick.
        sleep(0.5)
        split: list = []
        again = choose_app_hit(reread(), name, split)
        if split:
            # Y6: this read shows the name at two or more spots — tap none of them
            tidy()
            return "ambiguous"
        if again is not None:
            if math.hypot(again.nx - hit.nx, again.ny - hit.ny) > 0.02:
                # the row moved: the second read wins, with at most
                # one more read — still moving → the last one wins
                hit = again
                once_more = choose_app_hit(reread(), name, split)
                if split:
                    tidy()
                    return "ambiguous"
                if (once_more is not None
                        and math.hypot(once_more.nx - hit.nx,
                                       once_more.ny - hit.ny) > 0.02):
                    hit = once_more
            # else: the two reads agree — the first hit stands

        if out_of_time():
            tidy()
            return "deadline"
        # ② tap the row (the label inside the Top Hit card) and confirm.
        # The post-tap read uses reread(): for a short name it also sweeps,
        # so ③ can find the label again (F32/F35).
        opened, hits = _tap_and_confirm_open(
            hit.nx, hit.ny, luma=luma, sleep=sleep, tap=tap,
            read_screen=reread)
        if opened:
            return "opened"

        # ③ the label tap did nothing → tap the icon above the label, but
        # only where the post-tap read shows that label inside the Top Hit
        # card NOW (choose_app_hit, F35) — never the first read's position:
        # the results may have changed. No such label → no second tap.
        again = choose_app_hit(hits, name)
        if again is not None and not out_of_time():
            opened, _ = _tap_and_confirm_open(
                again.nx, again.ny - SPOTLIGHT_ICON_ABOVE_LABEL,
                luma=luma, sleep=sleep, tap=tap, read_screen=reread)
            if opened:
                return "opened"
    except Exception as exc:
        if not verify.is_capture_error(exc):
            raise
        # F25: an unreadable screen is not evidence the app opened —
        # no further taps; wrap up unconfirmed below.

    # ④ leave the phone tidy and say the taps were not confirmed
    tidy()
    return "not_confirmed"


def read_text() -> list:
    """OCR the current screen; returns vision.OCRHit list."""
    return vision.read_screen()


def status() -> dict:
    """Return a status dict for the mirroring session.

    Keys: running; and when running: window {x,y,w,h} (AX bounds), window_id, onscreen, frontmost,
    live (True/False/null — is the phone stream up), overlay (text shown over the stream when not
    live, e.g. a paused/connecting notice), paused (True/False, or null when the state is unknown),
    setup (True when the overlay is a setup / welcome screen the user must finish — F37; then
    paused is False: there is no Resume control to press).
    """
    from .window import (
        get_overlay, get_window_info, is_frontmost, is_paused, is_running,
        is_setup_screen,
    )

    running = is_running()
    info = {"running": running}
    if running:
        b = None
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
        setup = b is not None and is_setup_screen(overlay, b)
        info["paused"] = False if setup else is_paused(overlay)
        info["setup"] = setup
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

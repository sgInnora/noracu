"""Smoke tests — no iPhone required.

These validate argument parsing, window math, and the ease curve.
They do NOT synthesize input events (that requires a live mirroring
session and Accessibility permissions).
"""

import math
import subprocess
import sys

sys.path.insert(0, "src")

from imctl.window import WindowBounds, parse_overlay
from imctl.input import _ease_in_out
from imctl.cli import build_parser


def test_denormalize():
    b = WindowBounds(x=100, y=200, width=300, height=600)
    assert b.denormalize(0, 0) == (100, 200)
    assert b.denormalize(1, 1) == (400, 800)
    assert b.denormalize(0.5, 0.5) == (250, 500)
    try:
        b.denormalize(1.5, 0.5)
        assert False, "should reject out-of-range"
    except ValueError:
        pass


def test_center():
    b = WindowBounds(x=0, y=0, width=326, height=720)
    assert b.center == (163, 360)


def test_ease_curve():
    assert _ease_in_out(0.0) == 0.0
    assert _ease_in_out(1.0) == 1.0
    assert abs(_ease_in_out(0.5) - 0.5) < 1e-9
    # monotonic non-decreasing
    prev = 0.0
    for i in range(1, 101):
        v = _ease_in_out(i / 100)
        assert v >= prev - 1e-12
        prev = v


def test_parser_builds():
    p = build_parser()
    args = p.parse_args(["tap", "0.5", "0.5"])
    assert args.command == "tap" and args.x == 0.5
    args = p.parse_args(["swipe", "0.5", "0.8", "0.5", "0.2", "--ms", "250"])
    assert args.ms == 250
    args = p.parse_args(["type", "hello world"])
    assert args.text == "hello world"


def test_parse_overlay():
    # live: group 1 has no children (script returns an empty string)
    assert parse_overlay("") == {"live": True, "overlay": None, "buttons": 0}
    # paused: image + static text + button under group 1
    raw = "image\t\nstatic text\tConnection Paused\nbutton\t\n"
    assert parse_overlay(raw) == {
        "live": False,
        "overlay": "Connection Paused",
        "buttons": 1,
    }
    # transitional: only a static text (e.g. "Connecting to iPhone …"), no button
    raw = "static text\tConnecting to iPhone\n"
    assert parse_overlay(raw) == {
        "live": False,
        "overlay": "Connecting to iPhone",
        "buttons": 0,
    }
    # unknown states: no window / no group / unparseable output
    assert parse_overlay("NO_WINDOW") == {"live": None, "overlay": None, "buttons": 0}
    assert parse_overlay("NO_GROUP") == {"live": None, "overlay": None, "buttons": 0}
    assert parse_overlay("garbage without tabs") == {
        "live": None,
        "overlay": None,
        "buttons": 0,
    }
    # multiple static texts are joined with " / "
    raw = "static text\tOne\nstatic text\tTwo\n"
    assert parse_overlay(raw) == {"live": False, "overlay": "One / Two", "buttons": 0}


def test_choose_app_hit():
    from imctl.gestures import choose_app_hit
    from imctl.vision import OCRHit

    def hit(text, ny, nx=0.5, confidence=0.9):
        return OCRHit(text=text, nx=nx, ny=ny, confidence=confidence)

    # F35: every candidate must sit inside the Top Hit card — below the
    # header, at most TOP_HIT_CARD_SPAN under it. TOP is that header here
    # (0.26 → the card reaches 0.41).
    TOP = hit("Top Hit", 0.26)

    # ① the typed query echoes in the bottom search field (ny≈0.95) —
    #    only a result row above it (ny<0.88) counts; topmost row wins.
    hits = [TOP, hit("Calculator", 0.95), hit("Calculator", 0.30), hit("Calculator", 0.40)]
    assert choose_app_hit(hits, "Calculator").ny == 0.30
    # ② only the search field matches → nothing to tap
    assert choose_app_hit([TOP, hit("Calculator", 0.95)], "Calculator") is None
    # ③ case and surrounding whitespace don't matter
    assert choose_app_hit([TOP, hit(" calculator ", 0.40)], "Calculator").ny == 0.40
    assert choose_app_hit([TOP, hit("Calculator", 0.40)], "  CALCULATOR ").ny == 0.40
    # ④ partial matches are not the app
    assert choose_app_hit([TOP, hit("Calculator Pro", 0.30)], "Calculator") is None
    # no hits at all
    assert choose_app_hit([], "Calculator") is None


def test_choose_app_hit_top_hit_card_only():
    """F35: only an exact label INSIDE the Top Hit card is a candidate.

    The fixture is the 2026-11-05 14:23 real-device Spotlight frame for
    the query "Pinduoduo" (positions from the 660×1440 screenshot): the
    app's own Top Hit label reads 拼多多, a Chrome suggestion row reads
    "Pinduoduo", and the Settings section has a 拼多多 deep-link row.
    0.1.3 picked the suggestion row, tapped it and reported "opened".
    """
    from imctl.gestures import TOP_HIT_CARD_SPAN, choose_app_hit
    from imctl.vision import OCRHit

    P = lambda t, x, y: OCRHit(text=t, nx=x / 660, ny=y / 1440, confidence=1.0)
    frame = [P("Top Hit", 75, 194), P("拼多多", 111, 347), P("Suggestions", 102, 424),
             P("Pinduoduo", 156, 488), P("Settings", 81, 564), P("拼多多", 185, 643),
             P("Apps", 175, 674), P("Pinduoduo", 190, 1194)]
    # the suggestion row of the same name is never the app
    assert choose_app_hit(frame, "Pinduoduo") is None
    # the app's own label inside the card is
    assert round(choose_app_hit(frame, "拼多多").ny, 3) == round(347 / 1440, 3)
    # if the in-card label is missed, the Settings deep link is NOT a fallback
    no_label = [h for h in frame if not (h.text == "拼多多" and h.ny < 0.3)]
    assert choose_app_hit(no_label, "拼多多") is None
    # no "Top Hit" header at all → nothing qualifies
    assert choose_app_hit([h for h in frame if h.text != "Top Hit"], "拼多多") is None

    # the card edge is inclusive; just past it is outside
    def hit(text, ny):
        return OCRHit(text=text, nx=0.2, ny=ny, confidence=0.9)
    head = hit("Top Hit", 0.20)
    assert choose_app_hit([head, hit("Notes", 0.20 + TOP_HIT_CARD_SPAN)], "Notes") is not None
    assert choose_app_hit([head, hit("Notes", 0.20 + TOP_HIT_CARD_SPAN + 0.01)], "Notes") is None
    # a label level with or above the header is not inside the card
    assert choose_app_hit([head, hit("Notes", 0.20)], "Notes") is None
    assert choose_app_hit([head, hit("Notes", 0.15)], "Notes") is None


def test_ocr_default_languages_chinese_first():
    """F36: Chinese first — English-first OCR returned no Chinese at all."""
    import inspect

    from imctl import vision

    assert vision.DEFAULT_OCR_LANGUAGES == ("zh-Hans", "en-US")
    for fn in (vision.ocr, vision.ocr_sweep):
        assert inspect.signature(fn).parameters["languages"].default == vision.OCR_LANGUAGES
    # NORACU_OCR_LANGUAGES override: comma-separated, blanks ignored, empty → default
    assert vision._ocr_languages(None) == ("zh-Hans", "en-US")
    assert vision._ocr_languages("") == ("zh-Hans", "en-US")
    assert vision._ocr_languages(" , ") == ("zh-Hans", "en-US")
    assert vision._ocr_languages("zh-Hant, en-US") == ("zh-Hant", "en-US")
    assert vision._ocr_languages("en-US") == ("en-US",)


def test_find_app_hit():
    from imctl.gestures import find_app_hit
    from imctl.vision import OCRHit

    def hit(text, ny, nx=0.5, confidence=0.9):
        return OCRHit(text=text, nx=nx, ny=ny, confidence=confidence)

    sleeps = []

    def fake_sleep(s):
        sleeps.append(s)

    def make_read(screens):
        """read_screen stub: returns each screen once, records its calls.

        A second read beyond the scripted screens raises IndexError,
        so an over-read fails the test loudly.
        """
        calls = []

        def read():
            calls.append(1)
            return screens[len(calls) - 1]

        read.calls = calls
        return read

    TOP = hit("Top Hit", 0.26)  # F35: rows count only inside the Top Hit card

    # ① first read already has the row → returned at once, no sleep
    sleeps.clear()
    read = make_read([[TOP, hit("Calculator", 0.30)]])
    assert find_app_hit(read, "Calculator", sleep=fake_sleep).ny == 0.30
    assert len(read.calls) == 1 and sleeps == []

    # ② first read empty, second has the row → exactly one 1.0s sleep
    sleeps.clear()
    read = make_read([[], [TOP, hit("Calculator", 0.40)]])
    assert find_app_hit(read, "Calculator", sleep=fake_sleep).ny == 0.40
    assert len(read.calls) == 2 and sleeps == [1.0]

    # ③ only the bottom search field echoes the query (ny=0.95) →
    #    None after two reads, one sleep between them
    sleeps.clear()
    read = make_read([[TOP, hit("Calculator", 0.95)], [TOP, hit("Calculator", 0.95)]])
    assert find_app_hit(read, "Calculator", sleep=fake_sleep) is None
    assert len(read.calls) == 2 and sleeps == [1.0]

    # ④ attempts=1 → a single read, no sleep even on a miss
    sleeps.clear()
    read = make_read([[]])
    assert find_app_hit(read, "Calculator", attempts=1, sleep=fake_sleep) is None
    assert len(read.calls) == 1 and sleeps == []


def test_short_app_names():
    from imctl.gestures import choose_app_hit, find_app_hit
    from imctl.vision import OCRHit

    def hit(text, ny, nx=0.5, confidence=0.9):
        return OCRHit(text=text, nx=nx, ny=ny, confidence=confidence)

    # ① the one-letter app "X": every label OCR actually returns for
    #    it matches after _norm_label — still an EXACT match, never a
    #    substring/prefix one.
    TOP = hit("Top Hit", 0.26)  # F35: rows count only inside the Top Hit card
    for label in ("X", "x", "×", "X.", "Ｘ"):
        assert choose_app_hit([TOP, hit(label, 0.30)], "X").ny == 0.30, label
    # apps whose names merely contain or start with "x" don't match
    for other in ("Xcode", "X Corp", "Box"):
        assert choose_app_hit([TOP, hit(other, 0.30)], "X") is None, other
    # the search field echoing "X" at the bottom still doesn't count
    assert choose_app_hit([TOP, hit("X", 0.95)], "X") is None
    # several matching rows → the topmost (smallest ny) wins
    hits = [TOP, hit("X", 0.50), hit("×", 0.30), hit("X.", 0.40)]
    assert choose_app_hit(hits, "X").ny == 0.30

    # ② find_app_hit: short names get a second, language-correction-off
    #    read in the same pass when the default read misses.
    sleeps = []

    def fake_sleep(s):
        sleeps.append(s)

    def make_read(screens):
        """read_screen stub: returns each scripted screen once and
        records the language_correction value of each call ("default"
        when the kwarg is absent). A read beyond the script raises
        IndexError so an over-read fails the test loudly."""
        calls = []

        def read(**kwargs):
            calls.append(kwargs.get("language_correction", "default"))
            return screens[len(calls) - 1]

        read.calls = calls
        return read

    # first read (correction on) misses, second (correction off) has
    # the row → hit, exactly those two calls, no sleep
    sleeps.clear()
    read = make_read([[], [TOP, hit("×", 0.30)]])
    assert find_app_hit(read, "X", sleep=fake_sleep).ny == 0.30
    assert read.calls == ["default", False] and sleeps == []

    # long names: read_screen never receives language_correction=False
    # and the read/sleep sequence matches the original behavior
    sleeps.clear()
    read = make_read([[], [TOP, hit("Settings", 0.40)]])
    assert find_app_hit(read, "Settings", sleep=fake_sleep).ny == 0.40
    assert read.calls == ["default", "default"] and sleeps == [1.0]


def test_mean_abs_diff():
    from imctl.verify import mean_abs_diff

    # identical buffers → 0.0
    assert mean_abs_diff(b"\x00\x10\x20", b"\x00\x10\x20") == 0.0
    # |0-10| + |10-10| + |20-0| = 30 over 3 bytes → 10.0
    assert mean_abs_diff(bytes([0, 10, 20]), bytes([10, 10, 0])) == 10.0
    # different lengths or empty → ValueError
    for a, b in [(b"\x00", b"\x00\x00"), (b"\x00\x00", b"\x00"), (b"", b""), (b"", b"\x00")]:
        try:
            mean_abs_diff(a, b)
            assert False, "should raise ValueError"
        except ValueError:
            pass


def test_open_spotlight_checked():
    from imctl.gestures import SPOTLIGHT_MIN_DIFF, open_spotlight_checked

    def run(frames, opener_result, home_result=True, settle_s=1.0, home_settle_s=0.8):
        """Drive open_spotlight_checked with fake luma/sleep/opener/home.

        ``frames`` is the scripted sequence of luma captures; an extra
        call pops past the end and raises IndexError, failing loudly.
        ``order`` records the interleaving of home/luma/opener calls so
        tests can assert home ran exactly once, before the first luma.
        """
        sleeps, order = [], []

        def luma():
            order.append("luma")
            return frames.pop(0)

        def opener():
            order.append("opener")
            return opener_result

        def home():
            order.append("home")
            return home_result

        ok = open_spotlight_checked(
            settle_s, luma=luma, sleep=sleeps.append, opener=opener,
            home=home, home_settle_s=home_settle_s, read_screen=lambda: [],
        )
        return ok, sleeps, order

    def frame(total_diff, size=100):
        """A ``size``-byte frame whose mean-abs diff vs all-zeros is
        total_diff/size. ``total_diff`` is spread as evenly as possible
        across the bytes (divmod), so the threshold-edge frames below
        track SPOTLIGHT_MIN_DIFF instead of hard-coding 6.0.
        """
        q, r = divmod(total_diff, size)
        return bytes([q + 1] * r + [q] * (size - r))

    # F43: Home itself brought up a Top Hit card (none before it): Spotlight is open with
    # the previous query — no luma, no toggle
    from imctl.vision import CaptureError, OCRHit
    CARD = [OCRHit(text="Top Hit", nx=0.1, ny=0.14, confidence=1.0)]
    calls = []
    reads = [[], CARD]
    ok = open_spotlight_checked(1.0, luma=lambda: calls.append("luma"), sleep=lambda s: None,
                                opener=lambda: calls.append("opener"), home=lambda: True,
                                read_screen=lambda: reads.pop(0))
    assert ok is True and calls == [] and reads == []
    #    a card that was already there before Home (another app's, Home ignored), or a
    #    "Top Hit" line low in the window, is no proof: the old gate runs
    for screens, left in (([CARD, CARD], 1),   # a card before Home: no second read needed
                          ([[], [OCRHit(text="Top Hit", nx=0.1, ny=0.6, confidence=1.0)]], 0)):
        frames3 = [b"\x00" * 100, bytes([200] * 100)]
        ok = open_spotlight_checked(1.0, luma=lambda: frames3.pop(0), sleep=lambda s: None,
                                    opener=lambda: True, home=lambda: True,
                                    read_screen=lambda: screens.pop(0))
        assert ok is True and frames3 == [] and len(screens) == left

    def unreadable():
        raise CaptureError("blank frame")
    frames2 = [b"\x00" * 100, bytes([200] * 100)]
    ok = open_spotlight_checked(1.0, luma=lambda: frames2.pop(0), sleep=lambda s: None,
                                opener=lambda: True, home=lambda: True, read_screen=unreadable)
    assert ok is True and frames2 == []

    # ⓪ home fails → False; nothing else happens at all (no sleep, no
    # luma, no opener — an extra scripted frame would raise IndexError)
    ok, sleeps, order = run([], False, home_result=False)
    assert ok is False and sleeps == [] and order == ["home"]

    # ① opener fails → False; only the home settle sleep, luma read
    # exactly once (before), home exactly once and before that luma
    ok, sleeps, order = run([b"\x00" * 10], False)
    assert ok is False and sleeps == [0.8]
    assert order == ["home", "luma", "opener"]
    assert order.count("home") == 1 and order.index("home") < order.index("luma")

    # ② identical frames → False; full sleep sequence [home_settle_s, settle_s]
    ok, sleeps, order = run([b"\x0a" * 10, b"\x0a" * 10], True, settle_s=0.5, home_settle_s=0.25)
    assert ok is False and sleeps == [0.25, 0.5]
    assert order == ["home", "luma", "opener", "luma"]
    assert order.count("home") == 1 and order.index("home") < order.index("luma")

    # ③ diff far above the threshold (all 0 → all 50) → True
    ok, sleeps, order = run([b"\x00" * 10, b"\x32" * 10], True)
    assert ok is True and sleeps == [0.8, 1.0]
    assert order == ["home", "luma", "opener", "luma"]

    # ④ diff just below the threshold → False (frames derived from the
    # constant: mean (round(T*100)-1)/100 < T)
    below = frame(round(SPOTLIGHT_MIN_DIFF * 100) - 1)
    ok, sleeps, order = run([b"\x00" * 100, below], True)
    assert ok is False and sleeps == [0.8, 1.0]
    assert order == ["home", "luma", "opener", "luma"]

    # the pass edge is inclusive: exactly SPOTLIGHT_MIN_DIFF → True
    exact = frame(round(SPOTLIGHT_MIN_DIFF * 100))
    ok, sleeps, order = run([b"\x00" * 100, exact], True)
    assert ok is True and sleeps == [0.8, 1.0]
    assert order == ["home", "luma", "opener", "luma"]


def test_open_app_confirm():
    """F24: open_app confirms the app actually opened before reporting it.

    Fully injected — no phone, no clipboard, no real taps: read_screen,
    luma, sleep, tap, home, clear_text and type_text are all fakes. The
    threshold-edge luma frames are derived from OPEN_MIN_DIFF (G25c
    style), never hard-coded. Positions mirror the 2026-11-03 real-device
    retest: the Top Hit card label at (0.18, 0.27), its icon 0.052 above.
    """
    import contextlib
    import io
    from types import SimpleNamespace

    from imctl.gestures import (OPEN_MIN_DIFF, SPOTLIGHT_ICON_ABOVE_LABEL,
                                open_app)
    from imctl.vision import CaptureError, OCRHit
    from imctl import cli

    def hit(text, ny, nx=0.5, confidence=0.9):
        return OCRHit(text=text, nx=nx, ny=ny, confidence=confidence)

    def frame(total_diff, size=100):
        """A ``size``-byte frame whose mean-abs diff vs all-zeros is
        total_diff/size (G25c: the threshold-edge frames below track
        OPEN_MIN_DIFF instead of hard-coding 12.0)."""
        q, r = divmod(total_diff, size)
        return bytes([q + 1] * r + [q] * (size - r))

    ZEROS = b"\x00" * 100
    OPENED = frame(round(OPEN_MIN_DIFF * 100))        # diff == OPEN_MIN_DIFF
    UNCHANGED = frame(round(OPEN_MIN_DIFF * 100) - 1)  # just below it

    LABEL = hit("X", 0.27, nx=0.18)          # the Top Hit card label (F24)
    HEADER = hit("Top Hit", 0.16, nx=0.18)   # the card header above it
    ICON = (0.18, 0.27 - SPOTLIGHT_ICON_ABOVE_LABEL)

    def run(name="X", screens=(), lumas=(), spotlight_open=True):
        """Drive open_app with every collaborator faked.

        ``screens`` / ``lumas`` script the OCR reads and luma captures
        (an Exception instance in a script raises instead of returning);
        a read beyond the script raises IndexError, so an over-read
        fails the test loudly. Returns (result, taps, homes, sleeps,
        typed, cleared)."""
        taps, homes, sleeps, typed, cleared = [], [], [], [], []

        def read(**kwargs):
            item = screens.pop(0)
            if isinstance(item, Exception):
                raise item
            return item

        def luma():
            item = lumas.pop(0)
            if isinstance(item, Exception):
                raise item
            return item

        def tap(nx, ny):
            taps.append((nx, ny))

        def home():
            homes.append(1)
            return True

        result = open_app(
            name, spotlight_open=spotlight_open, read_screen=read,
            luma=luma, sleep=sleeps.append, tap=tap, home=home,
            clear_text=lambda: cleared.append(1),
            type_text=typed.append)
        return result, taps, homes, sleeps, typed, cleared

    # ① the label tap opens the app: frame diff ≥ OPEN_MIN_DIFF and the
    #    "Top Hit" header is gone → "opened", exactly ONE tap, at the
    #    label; nothing else happens (no home, no icon tap)
    # F35: the reads before the tap must show the Top Hit header — only a
    # label inside that card is a candidate (CARD = header + label).
    CARD = [HEADER, LABEL]
    res, taps, homes, sleeps, typed, cleared = run(
        screens=[CARD, CARD, []], lumas=[ZEROS, OPENED])
    assert res == "opened"
    assert taps == [(0.18, 0.27)]
    assert homes == [] and typed == ["X"] and cleared == [1]
    assert sleeps == [0.3, 1.5, 0.5, 1.0]

    # ② the label tap does nothing, the hit sits inside the Top Hit card
    #    (header above, < 0.15 away) → second tap at the icon position,
    #    confirmed → "opened"
    res, taps, homes, sleeps, *_ = run(
        screens=[CARD, CARD, [HEADER, LABEL], []],
        lumas=[ZEROS, UNCHANGED, ZEROS, OPENED])
    assert res == "opened"
    assert taps == [(0.18, 0.27), ICON]
    assert homes == []
    assert sleeps == [0.3, 1.5, 0.5, 1.0, 1.0]

    # ③ the label tap does nothing and the read AFTER that tap does not
    #    show the hit inside the Top Hit card → NO second tap, back on
    #    the Home Screen, "not_confirmed". Three ways to be outside the
    #    card in that read: no header at all, the header below the hit,
    #    or the header too far above (> TOP_HIT_CARD_SPAN away).
    for after in ([LABEL],                                 # no header
                  [LABEL, hit("Top Hit", 0.35, nx=0.18)],  # header below
                  [hit("Top Hit", 0.05, nx=0.18), LABEL]):  # > span above
        res, taps, homes, *_ = run(
            screens=[CARD, CARD, after], lumas=[ZEROS, UNCHANGED])
        assert res == "not_confirmed"
        assert taps == [(0.18, 0.27)]  # the label tap only
        assert homes == [1]

    # ④ both taps do nothing → back on the Home Screen, "not_confirmed",
    #    exactly two taps (label, then icon)
    res, taps, homes, *_ = run(
        screens=[CARD, CARD, [HEADER, LABEL], [HEADER, LABEL]],
        lumas=[ZEROS, UNCHANGED, ZEROS, UNCHANGED])
    assert res == "not_confirmed"
    assert taps == [(0.18, 0.27), ICON]
    assert homes == [1]

    # ⑤ stability: the row moved between the two reads → the SECOND
    #    position is tapped (the third read agrees → it stands). Both
    #    positions stay inside the Top Hit card (header 0.16, span 0.15).
    moved = hit("X", 0.29, nx=0.30)
    res, taps, *_ = run(
        screens=[CARD, [HEADER, moved], [HEADER, moved], []],
        lumas=[ZEROS, OPENED])
    assert res == "opened"
    assert taps == [(0.30, 0.29)]

    #    …and when the third read moves again, the LAST one wins
    moved2 = hit("X", 0.30, nx=0.35)
    res, taps, *_ = run(
        screens=[CARD, [HEADER, moved], [HEADER, moved2], []],
        lumas=[ZEROS, OPENED])
    assert res == "opened"
    assert taps == [(0.35, 0.30)]

    #    F35: a "moved" row OUTSIDE the card (a suggestion row of the same
    #    name) is no candidate at all — the first, in-card hit stands
    stray = hit("X", 0.40, nx=0.30)
    res, taps, *_ = run(
        screens=[CARD, [HEADER, stray], []], lumas=[ZEROS, OPENED])
    assert res == "opened"
    assert taps == [(0.18, 0.27)]

    # ⑥ a capture failure after the hit is found → "not_confirmed", no
    #    additional taps (the icon tap never happens)
    boom = CaptureError("could not capture the iPhone Mirroring window by id")
    res, taps, homes, *_ = run(
        screens=[CARD, CARD], lumas=[ZEROS, boom])
    assert res == "not_confirmed"
    assert taps == [(0.18, 0.27)]  # the label tap only — never the icon
    assert homes == [1]

    #    …also when the stability read itself fails: nothing is tapped
    res, taps, homes, *_ = run(screens=[CARD, boom], lumas=[])
    assert res == "not_confirmed"
    assert taps == []
    assert homes == [1]

    # ⑦ no row ever matches → "not_found", back on the Home Screen,
    #    nothing tapped (a long name whose query the search field shows: exactly
    #    two find_app_hit reads — F42: with the name in the field, no late reads)
    ECHO_P = hit("Photos", 0.93)
    res, taps, homes, sleeps, *_ = run(
        name="Photos", screens=[[ECHO_P], [ECHO_P]], lumas=[])
    assert res == "no_top_hit"  # F35: no read showed a Top Hit header at all
    assert taps == [] and homes == [1]
    assert sleeps == [0.3, 1.5, 1.0]  # find_app_hit's between-passes delay
    #    a Top Hit card that never shows exactly this name → not_found
    res, taps, homes, *_ = run(
        name="Photos", screens=[[HEADER, hit("Photo Booth", 0.27), ECHO_P]] * 2, lumas=[])
    assert res == "not_found" and taps == [] and homes == [1]

    # ⑧ ③ re-locates the label in the post-tap read; when that read
    #    shows the label somewhere else in the card, the icon above the NEW
    #    position is tapped, not one computed from the stale first read
    shifted = hit("X", 0.30, nx=0.25)
    res, taps, *_ = run(
        screens=[CARD, CARD, [HEADER, shifted], []],
        lumas=[ZEROS, UNCHANGED, ZEROS, OPENED])
    assert res == "opened"
    assert taps == [(0.18, 0.27), (0.25, 0.30 - SPOTLIGHT_ICON_ABOVE_LABEL)]

    # ⑨ the time budget — once spent, no further pass and no tap;
    #    back on the Home Screen, "deadline"
    t = [0.0]

    def slow_read(**kwargs):
        t[0] += 20.0  # every read takes 20 s
        return []

    homes = []
    res = open_app("Photos", spotlight_open=True, read_screen=slow_read,
                   luma=lambda: ZEROS, sleep=lambda s: None,
                   tap=lambda x, y: (_ for _ in ()).throw(AssertionError("no tap")),
                   home=lambda: homes.append(1) or True,
                   clear_text=lambda: None, type_text=lambda text: True,
                   clock=lambda: t[0], deadline_s=30.0)
    assert res == "deadline" and homes == [1]
    #    the budget is checked before EVERY read, not only between
    #    passes — a short name's second read takes it past 30 s, so no third read
    t[0] = 0.0
    reads_x = []

    def slow_read_x(**kwargs):
        reads_x.append(kwargs)
        t[0] += 20.0
        return []

    homes = []
    res = open_app("X", spotlight_open=True, read_screen=slow_read_x,
                   luma=lambda: ZEROS, sleep=lambda s: None,
                   tap=lambda x, y: (_ for _ in ()).throw(AssertionError("no tap")),
                   home=lambda: homes.append(1) or True,
                   clear_text=lambda: None, type_text=lambda text: True,
                   clock=lambda: t[0], deadline_s=30.0)
    assert res == "deadline" and homes == [1] and len(reads_x) == 2
    #    a hit found but the budget already spent → no tap either
    t[0] = 0.0

    def late_hit(**kwargs):
        t[0] += 31.0
        return CARD

    homes = []
    res = open_app("X", spotlight_open=True, read_screen=late_hit,
                   luma=lambda: ZEROS, sleep=lambda s: None,
                   tap=lambda x, y: (_ for _ in ()).throw(AssertionError("no tap")),
                   home=lambda: homes.append(1) or True,
                   clear_text=lambda: None, type_text=lambda text: True,
                   clock=lambda: t[0], deadline_s=30.0)
    assert res == "deadline" and homes == [1]

    # ── CLI mapping: _cmd_open turns the result strings into lines and
    #    exit codes (spotlight gate + open_app both mocked; no phone) ──
    p = build_parser()
    real_live, real_gestures = cli._require_live, cli.gestures
    cli._require_live = lambda: None
    try:
        # the Spotlight gate fails → its own line, exit 1 (unchanged)
        cli.gestures = SimpleNamespace(open_spotlight_checked=lambda: False)
        args = p.parse_args(["open", "X"])
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            assert cli._cmd_open(args) == 1
        assert "spotlight unavailable" in out.getvalue()

        # result → (exact line, exit code); not_confirmed goes to stderr
        for result, code, line, to_stderr in (
            ("opened", 0, "opened 'X'", False),
            ("not_found", 1, "app not found: 'X' (Spotlight's Top Hit did not show "
             "exactly this name — use the name the phone shows under the app icon)", False),
            ("no_top_hit", 1, "app not found: 'X' (Spotlight showed no Top Hit — no app "
             "by that name, or the iPhone is not set to English: phone_open reads "
             "Spotlight's \"Top Hit\" label; set NORACU_TOPHIT_LABELS to the label your "
             "iPhone shows)", False),
            ("deadline", 4, "open_not_confirmed: ran out of time opening 'X' (the Mac "
             "may be under heavy load); back on the Home Screen", True),
            ("not_confirmed", 4,
             "open_not_confirmed: tapped 'X' in Spotlight but the app "
             "did not open; back on the Home Screen", True),
            ("not_typed", 4,
             "open_not_confirmed: the name 'X' was pasted into Spotlight but never showed "
             "up on the phone (a paste can take several seconds to reach the iPhone, or be "
             "lost; an iPhone not set to English also needs NORACU_TOPHIT_LABELS) — nothing "
             "was tapped; back on the Home Screen; retry phone_open", True),
        ):
            cli.gestures = SimpleNamespace(
                open_spotlight_checked=lambda: True,
                open_app=lambda name, spotlight_open=True, report=None, **kw:
                    (report.update(home=True) if report is not None else None) or result)
            args = p.parse_args(["open", "X"])
            out, err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                assert cli._cmd_open(args) == code
            assert (err.getvalue() if to_stderr else out.getvalue()).strip() == line

        # the trip back to the Home Screen failed: the message must not claim it
        for result, code in (("deadline", 4), ("not_confirmed", 4), ("not_typed", 4),
                             ("not_found", 1), ("no_top_hit", 1)):
            cli.gestures = SimpleNamespace(
                open_spotlight_checked=lambda: True,
                open_app=lambda name, spotlight_open=True, report=None, **kw:
                    report.update(home=False) or result)
            out, err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                assert cli._cmd_open(p.parse_args(["open", "X"])) == code
            text = out.getvalue() + err.getvalue()
            assert "could not go back to the Home Screen — Spotlight may still be open" in text
            assert "back on the Home Screen" not in text
    finally:
        cli._require_live = real_live
        cli.gestures = real_gestures


def test_type_text_confirm():
    """type_text flow with an injected pasteboard/chord/clock — no real input.

    Covers the F18 invariant and its G26b tightening: the return
    value (``landed``) and the clipboard restore (``restore_ok``)
    are separate judgments — only OCR seeing the pasted text
    licenses a restore, never the frame diff alone — and an error
    before Cmd+V restores the user's clipboard while an error after
    Cmd+V never does.
    """
    import imctl.input as input_module
    from imctl.input import _VK_A, _VK_V, type_text
    from imctl.verify import screen_shows_text

    class FakePasteboard:
        """Records writes; models NSPasteboard changeCount semantics
        (clearContents bumps the count once; setString/setData do not)."""

        def __init__(self, log, data=b"orig", count=7):
            self._log = log
            self.data = data
            self.count = count

        def dataForType_(self, _t):
            return self.data

        def changeCount(self):
            return self.count

        def clearContents(self):
            self._log.append(("pb", "clear"))
            self.count += 1
            self.data = None

        def setString_forType_(self, s, _t):
            self._log.append(("pb", "setString", s))
            self.data = s.encode()

        def setData_forType_(self, d, _t):
            self._log.append(("pb", "setData", d))
            self.data = d

    state = {}  # fakes of the last run(), for asserting on runs that raise

    def run(text="hello world", *, replace=False, polls=(), ocr=False,
            bump_on_poll=False, before_check=None, raise_on_poll=None,
            hud=None):
        """Drive type_text with fakes; returns (ok, pb, events, v_elapsed,
        ocr_calls). ``hud`` scripts hud_check() (None: not injected; an
        Exception instance raises); its calls land in state["hud_calls"].

        ``polls`` scripts the return values of changed() (an exhausted
        script reads as False). ``bump_on_poll`` makes each poll bump
        the pasteboard's changeCount first, simulating another app
        touching the clipboard between our write and the restore.
        ``before_check`` replaces the injected before_check (used to
        raise before Cmd+V). ``raise_on_poll`` makes changed() raise
        RuntimeError on that 0-based poll instead of returning (used
        to raise after Cmd+V). ``v_elapsed`` is the fake-clock time
        from the Cmd+V chord to the return (None when Cmd+V never
        went out); ``ocr_calls`` counts ocr_check() invocations.
        """
        events = []
        pb = FakePasteboard(events)
        now = [1000.0]
        v_at = [None]
        ocr_calls = []

        def chord(keycode, before_key=None):
            if before_key is not None:
                before_key()
            events.append(("chord", keycode))
            if keycode == _VK_V:
                v_at[0] = now[0]

        def sleep(s):
            events.append(("sleep", s))
            now[0] += s

        def clock():
            return now[0]

        script = list(polls)
        poll_no = [0]

        def scripted_before_check():
            def changed():
                if bump_on_poll:
                    pb.count += 1
                if raise_on_poll is not None and poll_no[0] == raise_on_poll:
                    raise RuntimeError("changed() exploded")
                ret = script.pop(0) if script else False
                poll_no[0] += 1
                return ret

            return changed

        def ocr_check():
            ocr_calls.append(1)
            return ocr

        hud_calls = []

        def hud_check():
            hud_calls.append(1)
            if isinstance(hud, Exception):
                raise hud
            return hud

        state["pb"], state["events"], state["hud_calls"] = pb, events, hud_calls
        ok = type_text(text, replace=replace, pasteboard=pb, chord=chord,
                       before_check=before_check or scripted_before_check,
                       ocr_check=ocr_check,
                       hud_check=None if hud is None else hud_check,
                       sleep=sleep, clock=clock)
        v_elapsed = None if v_at[0] is None else now[0] - v_at[0]
        return ok, pb, events, v_elapsed, len(ocr_calls)

    def chords(events):
        return [e[1] for e in events if e[0] == "chord"]

    def pb_ops(events):
        return [e[1] for e in events if e[0] == "pb"]

    def sleep_after_v(events):
        v = next(i for i, e in enumerate(events) if e == ("chord", _VK_V))
        return sum(e[1] for e in events[v + 1:] if e[0] == "sleep")

    # type_text calls ensure_frontmost() directly (no injection point in
    # its signature), so the module attribute is swapped for a no-op —
    # the test must never run osascript or touch the real clipboard.
    frontmost_calls = []
    real_frontmost = input_module.ensure_frontmost
    input_module.ensure_frontmost = lambda: frontmost_calls.append(1)
    try:
        # ① frame diff confirms AND OCR sees the text → True; only ⌘V;
        # the clipboard is restored to the original data; ≥ min_hold_s of
        # sleep after ⌘V; exactly one OCR probe.
        ok, pb, events, _, ocr_calls = run(polls=[True], ocr=True)
        assert ok is True
        assert chords(events) == [_VK_V]
        assert pb_ops(events) == ["clear", "setString", "clear", "setData"]
        assert pb.data == b"orig" and pb.count == 9
        assert sleep_after_v(events) >= 0.3
        assert ocr_calls == 1

        # ①b frame diff confirms but OCR never sees the text (short or
        # cropped text) → still True (the paste landed), but NO restore:
        # the clipboard keeps the typed text, so a late asynchronous
        # read can only ever repeat it (G26b).
        ok, pb, events, _, ocr_calls = run(polls=[True], ocr=False)
        assert ok is True
        assert pb_ops(events) == ["clear", "setString"]
        assert pb.data == b"hello world" and pb.count == 8
        assert ocr_calls == 1

        # ①c (F44) frame diff fires, OCR does not see the text, and the
        # phone shows its "Pasting from …" progress box: the box was the
        # change, the paste is still on its way → False, no restore (the
        # clipboard keeps the typed text); the box is looked for once.
        from imctl.vision import CaptureError
        ok, pb, events, _, ocr_calls = run(polls=[True], ocr=False, hud=True)
        assert ok is False
        assert pb_ops(events) == ["clear", "setString"]
        assert pb.data == b"hello world" and pb.count == 8
        assert ocr_calls == 1 and state["hud_calls"] == [1]
        #    no progress box → landed, as in ①b; a capture failure while
        #    looking tells nothing and keeps that verdict
        ok, pb, events, _, _ = run(polls=[True], ocr=False, hud=False)
        assert ok is True and pb.data == b"hello world"
        assert state["hud_calls"] == [1]
        ok, pb, events, _, _ = run(polls=[True], ocr=False,
                                   hud=CaptureError("blank"))
        assert ok is True and pb.data == b"hello world"
        #    any other error from the look propagates, and after ⌘V the
        #    clipboard is never restored
        try:
            run(polls=[True], ocr=False, hud=RuntimeError("ocr exploded"))
        except RuntimeError:
            pass
        else:
            raise AssertionError("a non-capture error from hud_check must propagate")
        assert state["pb"].data == b"hello world"
        #    OCR saw the text, or the frame diff never fired: no look at all
        for polls, seen in (([True], True), ([False], True), ([False], False)):
            run(polls=polls, ocr=seen, hud=True)
            assert state["hud_calls"] == []

        # ② frame diff never fires, OCR confirms → True, restored; the
        # fallback OCR probe doubles as the restore license — called
        # once, its result reused (G26b).
        ok, pb, events, _, ocr_calls = run(polls=[False], ocr=True)
        assert ok is True
        assert chords(events) == [_VK_V]
        assert pb_ops(events) == ["clear", "setString", "clear", "setData"]
        assert pb.data == b"orig"
        assert ocr_calls == 1

        # ③ neither check confirms → False; the clipboard still holds
        # the typed text (no restore writes); fake-clock time from ⌘V
        # stays within timeout_s + one poll.
        ok, pb, events, v_elapsed, ocr_calls = run(polls=[False], ocr=False)
        assert ok is False
        assert pb_ops(events) == ["clear", "setString"]
        assert pb.data == b"hello world"
        assert v_elapsed <= 2.5 + 0.15
        assert ocr_calls == 1

        # ④ replace=True → ⌘A then ⌘V, and ⌘A precedes the clipboard write.
        ok, pb, events, _, _ = run(replace=True, polls=[True], ocr=True)
        assert ok is True
        assert chords(events) == [_VK_A, _VK_V]
        a_idx = events.index(("chord", _VK_A))
        first_write = next(i for i, e in enumerate(events) if e[0] == "pb")
        assert a_idx < first_write

        # ⑤ OCR sees the text, but someone else changed the pasteboard
        # meanwhile → no restore (existing changeCount rule).
        ok, pb, events, _, _ = run(polls=[True], bump_on_poll=True, ocr=True)
        assert ok is True
        assert pb_ops(events) == ["clear", "setString"]
        assert pb.data == b"hello world"

        # ⑥ before_check raises BEFORE Cmd+V (e.g. the baseline grab
        # fails) → the exception propagates; the phone never received
        # a paste, so the user's clipboard is restored; no ⌘V was ever
        # sent (G26b).
        def exploding_before_check():
            raise RuntimeError("baseline grab failed")

        try:
            run(before_check=exploding_before_check)
            raise AssertionError("expected RuntimeError")
        except RuntimeError as exc:
            assert "baseline grab failed" in str(exc)
        pb, events = state["pb"], state["events"]
        assert chords(events) == []
        assert pb_ops(events) == ["clear", "setString", "clear", "setData"]
        assert pb.data == b"orig" and pb.count == 9

        # ⑦ changed() raises AFTER Cmd+V → the exception propagates and
        # the clipboard is NOT restored: the phone may still read the
        # pasteboard asynchronously (G26b).
        try:
            run(raise_on_poll=0)
            raise AssertionError("expected RuntimeError")
        except RuntimeError as exc:
            assert "changed() exploded" in str(exc)
        pb, events = state["pb"], state["events"]
        assert chords(events) == [_VK_V]
        assert pb_ops(events) == ["clear", "setString"]
        assert pb.data == b"hello world" and pb.count == 8

        # ⑧ screen_shows_text: probe normalization (case, whitespace,
        # NFKC), the 12-char probe cap, and single-character text.
        from types import SimpleNamespace

        def hits(*texts):
            return [SimpleNamespace(text=t) for t in texts]

        assert screen_shows_text("Hello  World", lambda: hits("search: HELLO world")) is True
        assert screen_shows_text("Ｈｅｌｌｏ", lambda: hits("hello!")) is True  # NFKC folds full-width
        assert screen_shows_text("abcdefghijklmnop", lambda: hits("…abcdefghijkl…")) is True  # probe capped at 12
        assert screen_shows_text("abcdefghijklmnop", lambda: hits("…ghijklmnop…")) is False
        assert screen_shows_text("hello world", lambda: hits("goodbye")) is False
        assert screen_shows_text("x", lambda: hits("xxx")) is False  # probe < 2 chars
        assert screen_shows_text("hello", lambda: []) is False

        assert len(frontmost_calls) == 15  # one per run() above, never the real one
    finally:
        input_module.ensure_frontmost = real_frontmost


def test_scroll_steps():
    from imctl.input import scroll_steps
    d = scroll_steps(-432, 24)
    assert len(d) == 24 and sum(d) == -432
    assert all(-19 <= x <= -17 for x in d)
    assert sum(scroll_steps(100.4, 7)) == 100 and len(scroll_steps(10, 2)) == 4


def test_scroll_checked():
    from imctl.gestures import SCROLL_MIN_DIFF, scroll_checked

    def frame(total_diff, size=100):
        """A ``size``-byte frame whose mean-abs diff vs all-zeros is
        total_diff/size, spread as evenly as possible (divmod), so the
        threshold-edge frames below track SCROLL_MIN_DIFF instead of
        hard-coding 2.0 (same trick as test_open_spotlight_checked).
        """
        q, r = divmod(total_diff, size)
        return bytes([q + 1] * r + [q] * (size - r))

    def run(frames, direction="down", distance=0.5):
        """Drive scroll_checked with scripted luma frames; returns
        (ok, calls, sleeps). An extra luma call pops past the end of
        the script and raises IndexError, failing loudly.
        """
        calls, sleeps = [], []
        script = list(frames)

        def luma():
            return script.pop(0)

        def scroller(d, dist):
            calls.append((d, dist))

        ok = scroll_checked(direction, distance, luma=luma, scroller=scroller,
                             sleep=sleeps.append, settle_s=0.6)
        return ok, calls, sleeps

    zeros = bytes(100)

    # ① diff at the threshold (pass edge is inclusive) → True; the
    # scroller got (direction, distance); sleep sequence == [settle_s]
    ok, calls, sleeps = run([zeros, frame(round(SCROLL_MIN_DIFF * 100))])
    assert ok is True
    assert calls == [("down", 0.5)]
    assert sleeps == [0.6]

    # direction/distance pass through to the scroller untouched
    ok, calls, sleeps = run([zeros, frame(round(SCROLL_MIN_DIFF * 100))], "up", 1.5)
    assert ok is True and calls == [("up", 1.5)] and sleeps == [0.6]

    # ② one byte below the threshold → False
    ok, calls, sleeps = run([zeros, frame(round(SCROLL_MIN_DIFF * 100) - 1)])
    assert ok is False
    assert calls == [("down", 0.5)] and sleeps == [0.6]

    # ③ invalid distance → ValueError before any capture or event.
    # luma/scroller/sleep raise AssertionError (not ValueError) when
    # called, so a missing check fails the test instead of passing it.
    def boom(*_a):
        raise AssertionError("validation must reject before any call")

    for bad in (0, -1, 3.01, float("nan"), 600):
        try:
            scroll_checked("down", bad, luma=boom, scroller=boom, sleep=boom)
            assert False, f"distance={bad!r} should raise ValueError"
        except ValueError:
            pass

    # ④ invalid direction → ValueError, nothing runs
    try:
        scroll_checked("left", 0.5, luma=boom, scroller=boom, sleep=boom)
        assert False, "direction='left' should raise ValueError"
    except ValueError:
        pass


def test_expect_guard():
    """F22: --expect refuses input unless the anchor text is on screen."""
    import contextlib
    import io
    from types import SimpleNamespace

    from imctl import cli
    from imctl.verify import screen_contains

    def hits(*texts):
        return [SimpleNamespace(text=t) for t in texts]

    # ── screen_contains: both sides are NFKC + lowercase + collapsed ──
    assert screen_contains("Replying to", hits("Replying to")) is True
    assert screen_contains("replying to", hits("REPLYING TO")) is True  # case
    assert screen_contains("Ｒｅｐｌｙｉｎｇ ｔｏ", hits("Replying to")) is True  # NFKC full-width
    assert screen_contains("Replying  to", hits("Replying\tto")) is True  # whitespace runs
    # a phrase split across two OCR fragments still matches
    assert screen_contains("Replying to", hits("Replying", "to")) is True
    assert screen_contains("Replying to", hits("Replying", "from")) is False
    # empty (or whitespace-only) expect never matches
    assert screen_contains("", hits("anything")) is False
    assert screen_contains("   ", hits("anything")) is False

    # ── _require_expect ──
    p = build_parser()

    # no --expect → None, and the screen is never read
    reads = []

    def read_screen():
        reads.append(1)
        return hits("Home Screen")

    args = p.parse_args(["tap", "0.5", "0.5"])
    assert cli._require_expect(args, read_screen=read_screen) is None
    assert reads == []

    # --expect and the text is on screen → None
    args = p.parse_args(["tap", "0.5", "0.5", "--expect", "Replying to"])
    assert cli._require_expect(args, read_screen=lambda: hits("Replying", "to")) is None

    # --expect and the text is absent → 5 + expect_not_found on stderr
    args = p.parse_args(["tap", "0.5", "0.5", "--expect", "Replying to"])
    err = io.StringIO()
    with contextlib.redirect_stderr(err):
        assert cli._require_expect(args, read_screen=lambda: hits("Home Screen")) == 5
    assert "expect_not_found:" in err.getvalue()

    # ── guard failure blocks the input that follows it ──
    # Chosen approach: run the real _cmd_tap with its collaborators patched
    # (_require_live → allow, cli.input → recorder, cli.vision → OCR source)
    # so the production code path — guard before input — is what gets tested;
    # no events are synthesized. (The alternative, extracting a separate
    # guard+action helper, would test a copy of the wiring instead.)
    sent = []

    class InputRecorder:
        def tap(self, x, y):
            sent.append(("tap", x, y))

    real_live, real_input, real_vision = cli._require_live, cli.input, cli.vision
    cli._require_live = lambda: None
    cli.input = InputRecorder()
    cli.vision = SimpleNamespace(read_screen=lambda: hits("Home Screen"))
    try:
        # anchor absent → exit 5 and input.tap is never called
        args = p.parse_args(["tap", "0.5", "0.5", "--expect", "Replying to"])
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            assert cli._cmd_tap(args) == 5
        assert sent == []
        assert "expect_not_found:" in err.getvalue()

        # anchor on screen → the tap goes through
        args = p.parse_args(["tap", "0.5", "0.5", "--expect", "Home Screen"])
        assert cli._cmd_tap(args) == 0
        assert sent == [("tap", 0.5, 0.5)]
    finally:
        cli._require_live = real_live
        cli.input = real_input
        cli.vision = real_vision

    # ── argparse: phone_type's free text after `--` is never an option ──
    args = p.parse_args(["type", "--", "--replace"])
    assert args.text == "--replace" and args.replace is False
    args = p.parse_args(["type", "--replace", "--expect", "Home Screen", "--", "--replace"])
    assert args.text == "--replace" and args.replace is True
    assert args.expect == "Home Screen"


def test_capture_integrity():
    """F25: a capture only ever returns the mirroring window's own pixels.

    capture_window never falls back to a screen region and raises
    CaptureError after one retry; window_luma refuses offscreen windows
    and blank frames; type_text counts capture failures as
    "unconfirmed"; the expect guard refuses with capture_failed and
    sends nothing. Everything is injected — no screencapture subprocess,
    no CGWindowListCreateImage, no app activation, no real clipboard.
    """
    import contextlib
    import io
    import os
    import shutil
    import subprocess
    import tempfile
    from types import SimpleNamespace

    import imctl.input as input_module
    import imctl.verify as verify
    import imctl.vision as vision
    from imctl import cli
    from imctl.input import _VK_V, type_text
    from imctl.verify import is_capture_error
    from imctl.vision import CaptureError
    from imctl.window import WindowError

    # ── is_capture_error: the F25 predicate ──
    assert is_capture_error(WindowError("no window")) is True
    assert is_capture_error(CaptureError("no pixels")) is True
    assert is_capture_error(RuntimeError("unrelated")) is False
    assert is_capture_error(ValueError("unrelated")) is False

    # ── capture_window: window id only, one retry, then CaptureError ──
    real_run, real_info = vision._run, vision.get_window_info
    tmpdir = tempfile.mkdtemp(prefix="imctl_test_f25_")
    try:
        path = os.path.join(tmpdir, "win.png")

        def drive(results, infos=None):
            """Run capture_window with a scripted _run (True = a non-empty
            PNG appears at `path`, False = the attempt fails); returns
            (value-or-exception, recorded argv list). A scripted _run call
            past the end of `results` raises IndexError, failing loudly."""
            cmds = []

            def fake_run(argv, **_kw):
                cmds.append(list(argv))
                ok = results.pop(0)
                if ok:
                    with open(path, "wb") as f:
                        f.write(b"png")
                return SimpleNamespace(returncode=0 if ok else 1)

            vision._run = fake_run
            vision.get_window_info = (
                infos if infos is not None
                else (lambda: {"id": 4242, "onscreen": True})
            )
            try:
                return vision.capture_window(path), cmds
            except CaptureError as exc:
                return exc, cmds
            finally:
                if os.path.exists(path):
                    os.unlink(path)

        # first attempt fails, retry succeeds → the path; exactly two
        # screencapture calls, both by window id — no -R anywhere.
        value, cmds = drive([False, True])
        assert value == path
        assert cmds == [["screencapture", "-x", "-o", "-l", "4242", path]] * 2
        assert not [a for cmd in cmds for a in cmd if str(a).startswith("-R")]

        # both attempts fail → CaptureError, still no -R
        value, cmds = drive([False, False])
        assert isinstance(value, CaptureError)
        assert len(cmds) == 2
        assert not [a for cmd in cmds for a in cmd if str(a).startswith("-R")]

        # window id unresolvable on both looks → CaptureError, and
        # screencapture is never even invoked
        value, cmds = drive([], infos=lambda: None)
        assert isinstance(value, CaptureError)
        assert cmds == []

        # the retry re-resolves the window id: unavailable, then there
        looks = [None, {"id": 77, "onscreen": True}]
        value, cmds = drive([True], infos=lambda: looks.pop(0))
        assert value == path
        assert cmds == [["screencapture", "-x", "-o", "-l", "77", path]]

        # a hung or missing screencapture is a failed attempt, not a
        # crash: retry once, then CaptureError — still no -R
        hung_cmds = []

        def raising_run(argv, **_kw):
            hung_cmds.append(list(argv))
            raise subprocess.TimeoutExpired(argv[0], 10)

        vision._run = raising_run
        vision.get_window_info = lambda: {"id": 4242, "onscreen": True}
        try:
            vision.capture_window(path)
            assert False, "a hung screencapture must raise CaptureError"
        except CaptureError:
            pass
        assert len(hung_cmds) == 2
        assert not [a for cmd in hung_cmds for a in cmd if str(a).startswith("-R")]
    finally:
        vision._run = real_run
        vision.get_window_info = real_info
        shutil.rmtree(tmpdir, ignore_errors=True)

    # ── window_luma: offscreen and blank frames are WindowErrors ──
    real_v_info, real_cg_img = verify.get_window_info, verify._capture_window_image
    try:
        def boom(*_a, **_k):
            raise AssertionError("no capture may happen for an offscreen window")

        verify.get_window_info = lambda: {"id": 4242, "onscreen": False}
        verify._capture_window_image = boom
        try:
            verify.window_luma()
            assert False, "an offscreen window must raise WindowError"
        except WindowError:
            pass

        def gray_image(levels):
            """A real in-memory CGImage with the given 8-bit gray rows —
            bitmap work only, no screen is involved."""
            import Quartz
            h, w = len(levels), len(levels[0])
            buf = bytearray(b for row in levels for b in row)
            ctx = Quartz.CGBitmapContextCreate(
                buf, w, h, 8, w,
                Quartz.CGColorSpaceCreateDeviceGray(),
                Quartz.kCGImageAlphaNone,
            )
            return Quartz.CGBitmapContextCreateImage(ctx)

        verify.get_window_info = lambda: {"id": 4242, "onscreen": True}

        # a single-gray-level frame (blank/transparent window) → WindowError
        verify._capture_window_image = lambda _wid: gray_image([[128] * 8] * 8)
        try:
            verify.window_luma()
            assert False, "a blank frame must raise WindowError"
        except WindowError:
            pass

        # a content frame still passes: full-size bytes come back and the
        # spread is what the image drew (not blank)
        rows = [[(x * 32) % 256 for x in range(8)] for _ in range(8)]
        verify._capture_window_image = lambda _wid: gray_image(rows)
        luma = verify.window_luma()
        assert len(luma) == 36 * 78
        assert max(luma) - min(luma) >= 4
    finally:
        verify.get_window_info = real_v_info
        verify._capture_window_image = real_cg_img

    # ── type_text: capture failures are "unconfirmed", never success ──
    class FakePasteboard:
        """Records writes; models NSPasteboard changeCount semantics
        (clearContents bumps the count once; setString/setData do not)."""

        def __init__(self):
            self.data = b"orig"
            self.count = 7

        def dataForType_(self, _t):
            return self.data

        def changeCount(self):
            return self.count

        def clearContents(self):
            self.count += 1
            self.data = None

        def setString_forType_(self, s, _t):
            self.data = s.encode()

        def setData_forType_(self, d, _t):
            self.data = d

    events = []
    pb = FakePasteboard()
    now = [1000.0]

    def chord(keycode, before_key=None):
        if before_key is not None:
            before_key()
        events.append(("chord", keycode))

    def sleep(s):
        now[0] += s

    def clock():
        return now[0]

    def before_check():
        def changed():
            events.append(("changed",))
            raise WindowError("the mirroring window is not on screen")

        return changed

    def ocr_check():
        events.append(("ocr",))
        raise CaptureError("could not capture the iPhone Mirroring window by id")

    real_frontmost = input_module.ensure_frontmost
    input_module.ensure_frontmost = lambda: None
    try:
        ok = type_text("capture me", pasteboard=pb, chord=chord,
                       before_check=before_check, ocr_check=ocr_check,
                       sleep=sleep, clock=clock)
        assert ok is False
        # only the ⌘V chord went out; every poll failed to capture and
        # counted as "no change"; the OCR probe failed to capture and
        # counted as "not seen"
        assert [e for e in events if e[0] == "chord"] == [("chord", _VK_V)]
        assert events.count(("changed",)) >= 1
        assert events.count(("ocr",)) == 1
        # the clipboard still holds the typed text — never restored (G26b)
        assert pb.data == b"capture me"
        assert pb.count == 8
    finally:
        input_module.ensure_frontmost = real_frontmost

    # ── _require_expect: a capture failure refuses with capture_failed ──
    p = build_parser()

    def read_screen_boom(*_a, **_k):
        raise CaptureError("could not capture the iPhone Mirroring window by id")

    args = p.parse_args(["tap", "0.5", "0.5", "--expect", "Replying to"])
    err = io.StringIO()
    with contextlib.redirect_stderr(err):
        assert cli._require_expect(args, read_screen=read_screen_boom) == 7
    assert "capture_failed:" in err.getvalue()
    assert "no image was returned" in err.getvalue()

    # and the input behind the guard is never called (same patching
    # approach as test_expect_guard: real _cmd_tap / _cmd_screenshot
    # code paths, faked collaborators, no events synthesized)
    sent = []

    class InputRecorder:
        def tap(self, x, y):
            sent.append((x, y))

    real_live, real_input, real_vision = cli._require_live, cli.input, cli.vision
    cli._require_live = lambda: None
    cli.input = InputRecorder()
    cli.vision = SimpleNamespace(read_screen=read_screen_boom,
                                capture_window=read_screen_boom)
    try:
        args = p.parse_args(["tap", "0.5", "0.5", "--expect", "Replying to"])
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            assert cli._cmd_tap(args) == 7
        assert sent == []
        assert "capture_failed:" in err.getvalue()

        args = p.parse_args(["screenshot"])
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            assert cli._cmd_screenshot(args) == 7
        assert "capture_failed:" in err.getvalue()

        # the remaining capturing subcommands take the same exit-7 path:
        # ocr / find (read_screen family), scroll (luma), open (spotlight
        # gate + result matching) — all with injected collaborators
        real_warn, real_gestures = cli._warn_if_not_live, cli.gestures
        cli._warn_if_not_live = lambda: None
        cli.gestures = SimpleNamespace(read_text=read_screen_boom)
        try:
            args = p.parse_args(["ocr"])
            err = io.StringIO()
            with contextlib.redirect_stderr(err):
                assert cli._cmd_ocr(args) == 7
            assert "capture_failed:" in err.getvalue()
        finally:
            cli._warn_if_not_live = real_warn
            cli.gestures = real_gestures

        cli.vision = SimpleNamespace(find=read_screen_boom)
        try:
            args = p.parse_args(["find", "Settings"])
            err = io.StringIO()
            with contextlib.redirect_stderr(err):
                assert cli._cmd_find(args) == 7
            assert "capture_failed:" in err.getvalue()
        finally:
            cli.vision = real_vision

        cli.gestures = SimpleNamespace(
            scroll_checked=lambda *_a, **_k: (_ for _ in ()).throw(
                WindowError("the mirroring window is not on screen")),
            open_spotlight_checked=lambda: (_ for _ in ()).throw(
                CaptureError("could not capture the iPhone Mirroring window by id")),
        )
        try:
            args = p.parse_args(["scroll", "down", "0.5"])
            err = io.StringIO()
            with contextlib.redirect_stderr(err):
                assert cli._cmd_scroll(args) == 7
            assert "capture_failed:" in err.getvalue()

            args = p.parse_args(["open", "Photos"])
            err = io.StringIO()
            with contextlib.redirect_stderr(err):
                assert cli._cmd_open(args) == 7
            assert "capture_failed:" in err.getvalue()
        finally:
            cli.gestures = real_gestures
    finally:
        cli._require_live = real_live
        cli.input = real_input
        cli.vision = real_vision


def test_focus_guard():
    """F26: every input event is preceded by a frontmost check; focus loss sends nothing.

    _focus_check, the event senders, ensure_frontmost and sleep are all
    patched with recorders — no osascript, no CGEventPost, no real
    clipboard. FocusLost must escape before ANY event is recorded.
    """
    import contextlib
    import io
    from types import SimpleNamespace

    import imctl.input as input_module
    from imctl import cli
    from imctl.input import (
        FocusLost, _VK_V, _cmd_chord, clear_text, long_press, press_key,
        scroll_trackpad, swipe, tap, type_text,
    )
    from imctl.window import WindowBounds

    bounds = WindowBounds(0, 0, 100, 100)
    events = []     # every posted event, in order
    focus = [True]  # scripted frontmost answer for _focus_check
    flip_at = [None]  # event count at which the user switches apps

    def note(ev):
        events.append(ev)
        if flip_at[0] is not None and len(events) >= flip_at[0]:
            focus[0] = False

    saved = {}

    def patch(name, value):
        saved[name] = getattr(input_module, name)
        setattr(input_module, name, value)

    patch("_focus_check", lambda: focus[0])
    patch("ensure_frontmost", lambda: None)
    patch("get_bounds", lambda: bounds)
    patch("_source", lambda: "src")
    patch("_mouse_event", lambda kind, x, y, source: note(("mouse", kind)))
    patch("_key_event", lambda keycode, down, source: note(("key", keycode, down)))
    patch("_scroll_event", lambda source, delta, x=None, y=None, phase=None:
          note(("scroll", delta, phase)))
    patch("CGEventCreateKeyboardEvent", lambda src, code, down: ("kb", code, down))
    patch("CGEventSetFlags", lambda event, flags: None)
    patch("CGEventPost", lambda tap, event: note(("post", event)))
    patch("time", SimpleNamespace(sleep=lambda s: None))

    try:
        # ── focus already lost → every sender refuses before ANY event ──
        focus[0] = False
        for call in (
            lambda: tap(0.5, 0.5),
            lambda: long_press(0.5, 0.5),
            lambda: swipe(0.5, 0.8, 0.5, 0.2),
            lambda: scroll_trackpad(-500),
            lambda: press_key("return"),
            clear_text,
            lambda: _cmd_chord(_VK_V),
        ):
            events.clear()
            try:
                call()
                raise AssertionError("expected FocusLost")
            except FocusLost:
                pass
            assert events == [], f"events leaked: {events}"

        # sanity: with focus held the guard must not block the normal path
        focus[0] = True
        events.clear()
        tap(0.5, 0.5)
        assert len(events) == 2  # mouse-down + mouse-up

        # ── scroll_trackpad: re-check every 6 events, close phase 1 with phase 4 ──
        # The user switches away once 6 events have gone out; the next scheduled
        # check drops the remaining deltas and finally: posts only the 0-px phase-4 end.
        events.clear()
        focus[0] = True
        flip_at[0] = 6
        try:
            scroll_trackpad(-500)
            raise AssertionError("expected FocusLost")
        except FocusLost:
            pass
        assert len(events) == 7, events
        assert events[0][0] == "mouse"  # the positioning move
        assert all(e[0] == "scroll" and e[1] != 0 for e in events[1:6])
        assert events[6] == ("scroll", 0, 4)
        flip_at[0] = None

        # ── clear_text: focus lost between Cmd+A and Delete ──
        # The Cmd+A chord completes (4 posts), the Delete never goes out.
        events.clear()
        focus[0] = True
        flip_at[0] = 4
        try:
            clear_text()
            raise AssertionError("expected FocusLost")
        except FocusLost:
            pass
        posts = [e for e in events if e[0] == "post"]
        assert len(posts) == 4  # Cmd chord: Cmd down, A down, A up, Cmd up
        assert not [e for e in events if e[0] == "key"]  # no Delete
        flip_at[0] = None

        # ── type_text: focus lost BEFORE Cmd+V ──
        # G26b: the exception branch restores the user's clipboard (sent
        # is still False) and no Cmd+V was ever recorded.
        class FakePasteboard:
            """Models NSPasteboard changeCount semantics (clearContents bumps
            the count once; setString/setData do not)."""

            def __init__(self):
                self.data = b"orig"
                self.count = 7
                self.ops = []

            def dataForType_(self, _t):
                return self.data

            def changeCount(self):
                return self.count

            def clearContents(self):
                self.ops.append("clear")
                self.count += 1
                self.data = None

            def setString_forType_(self, s, _t):
                self.ops.append("setString")
                self.data = s.encode()

            def setData_forType_(self, d, _t):
                self.ops.append("setData")
                self.data = d

        def guarded_chord(keycode, before_key=None):
            # exactly what the real _cmd_chord does since F26 / F35
            input_module._require_focus()
            if before_key is not None:
                before_key()
            events.append(("chord", keycode))

        now = [1000.0]

        def fake_sleep(s):
            now[0] += s

        pb = FakePasteboard()
        events.clear()
        focus[0] = False
        try:
            type_text("hello world", pasteboard=pb, chord=guarded_chord,
                      before_check=lambda: (lambda: True),
                      ocr_check=lambda: True,
                      sleep=fake_sleep, clock=lambda: now[0])
            raise AssertionError("expected FocusLost")
        except FocusLost:
            pass
        assert ("chord", _VK_V) not in events
        assert pb.ops == ["clear", "setString", "clear", "setData"]
        assert pb.data == b"orig" and pb.count == 9

        # ── type_text: focus lost AFTER Cmd+V (during polling) ──
        # The paste is already out; the run finishes per G26b/G31 —
        # OCR confirms, the clipboard is restored, True is returned.
        pb = FakePasteboard()
        events.clear()
        focus[0] = True

        def chord_then_lose_focus(keycode, before_key=None):
            if before_key is not None:
                before_key()
            events.append(("chord", keycode))
            if keycode == _VK_V:
                focus[0] = False  # the user switches away mid-poll

        ok = type_text("hello world", pasteboard=pb, chord=chord_then_lose_focus,
                       before_check=lambda: (lambda: True),
                       ocr_check=lambda: True,
                       sleep=fake_sleep, clock=lambda: now[0])
        assert ok is True
        assert [e for e in events if e[0] == "chord"] == [("chord", _VK_V)]
        assert pb.ops == ["clear", "setString", "clear", "setData"]
        assert pb.data == b"orig"
    finally:
        for name, value in saved.items():
            setattr(input_module, name, value)

    # ── cli: FocusLost → exit 6 with the focus_lost: line ──
    real_live = cli._require_live
    real_tap = input_module.tap
    cli._require_live = lambda: None

    def refusing_tap(x, y):
        raise FocusLost("iPhone Mirroring is not the frontmost app")

    input_module.tap = refusing_tap
    try:
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            assert cli.main(["tap", "0.5", "0.5"]) == 6
        assert "focus_lost:" in err.getvalue()
        assert "nothing (or nothing further) was sent" in err.getvalue()
    finally:
        cli._require_live = real_live
        input_module.tap = real_tap


def test_overlay_hover_controls():
    """F28: the window's own hover controls are not an overlay (device capture, 2026-11-04)."""
    from imctl.window import is_paused, parse_overlay_ex

    # pointer near the top of the window: close / minimize / zoom + toolbar group — still live
    hover_live = ("button\t\tAXCloseButton\t\nbutton\t\tAXMinimizeButton\t\n"
                  "button\t\tAXZoomButton\t\ngroup\t\tAXHostingView\tbutton,button,\n\n")
    assert parse_overlay_ex(hover_live) == ({"live": True, "overlay": None, "buttons": 0}, True)
    assert parse_overlay(hover_live) == {"live": True, "overlay": None, "buttons": 0}
    assert is_paused(parse_overlay(hover_live)) is False
    # toolbar group still empty mid-animation: not an overlay while hovering either
    hover_empty = "button\t\tAXCloseButton\t\ngroup\t\tAXHostingView\t\n"
    assert parse_overlay_ex(hover_empty)[0]["live"] is True
    # hovering over a real paused overlay: window controls ignored, the overlay still found
    hover_paused = ("button\t\tAXCloseButton\t\nbutton\t\tAXMinimizeButton\t\n"
                    "button\t\tAXZoomButton\t\nimage\t\t\t\n"
                    "static text\tConnection Paused\t\t\nbutton\tResume\t\t\n")
    assert parse_overlay_ex(hover_paused) == (
        {"live": False, "overlay": "Connection Paused", "buttons": 1}, True)
    # no window controls: rules unchanged — any child, even a button-only group, means not live
    no_hover_group = "group\t\tAXHostingView\tbutton,button,\n"
    assert parse_overlay_ex(no_hover_group) == (
        {"live": False, "overlay": None, "buttons": 0}, False)
    # four-field lines without window controls read like the two-field form
    paused4 = "image\t\t\t\nstatic text\tConnection Paused\t\t\nbutton\t\t\t\n"
    assert parse_overlay(paused4) == {"live": False, "overlay": "Connection Paused", "buttons": 1}


def test_resume_never_clicks_window_controls():
    """F29: resume() moves the pointer off first and clicks only a lone overlay button;
    launch() / phone_launch never report ready while the overlay is up."""
    import contextlib
    import io
    import time as time_module

    from imctl import cli, gestures, window

    saved = {}

    def patch(mod, name, value):
        if (mod, name) not in saved:
            saved[(mod, name)] = getattr(mod, name)
        setattr(mod, name, value)

    moves, scripts, snaps, clicks, after = [], [], [], [], []

    def fake_osa(script, strip=True):
        scripts.append(script)
        return clicks.pop(0)

    paused = {"live": False, "overlay": "Connection Paused", "buttons": 1}
    live = {"live": True, "overlay": None, "buttons": 0}
    try:
        patch(time_module, "sleep", lambda s: None)
        patch(window, "_move_pointer_off_window", lambda: moves.append(1) or True)
        patch(window, "overlay_snapshot", lambda: snaps.pop(0))
        patch(window, "_run_osascript", fake_osa)
        patch(window, "get_overlay",
              lambda: after.pop(0) if after else {"live": False, "overlay": None, "buttons": 1})
        # F37: the mirror window is phone-shaped (measured 329×727 on macOS 27.2)
        PHONE = window.WindowBounds(x=0, y=0, width=329, height=727)
        bounds = {"b": PHONE}
        patch(window, "get_bounds", lambda: bounds["b"])

        # hover over a paused overlay: pointer moved off, state re-read, lone button clicked
        snaps[:] = [(paused, True), (paused, False)]
        clicks[:] = ["CLICKED"]
        after[:] = [live]
        assert window.resume() is True
        assert moves == [1] and scripts == [window._CLICK_RESUME_SCRIPT]

        # already live, no hover: no move, no click
        moves.clear(); scripts.clear()
        snaps[:] = [(live, False)]
        assert window.resume() is True
        assert moves == [] and scripts == []

        # several overlay buttons: never click
        snaps[:] = [({"live": False, "overlay": None, "buttons": 3}, False)]
        assert window.resume() is False and scripts == []

        # unknown state: never click
        snaps[:] = [({"live": None, "overlay": None, "buttons": 0}, False)]
        assert window.resume() is False and scripts == []

        # the click script found no lone button (SKIP): not resumed
        snaps[:] = [(paused, False)]
        clicks[:] = ["SKIP"]
        assert window.resume() is False and scripts == [window._CLICK_RESUME_SCRIPT]

        # F37: one button in a window that is NOT phone-shaped (the macOS 27
        # first-run welcome screen: 640×660) → never clicked
        scripts.clear()
        welcome = {"live": False, "overlay": "iPhone on Your Mac / Stay up to date", "buttons": 1}
        bounds["b"] = window.WindowBounds(x=0, y=0, width=640, height=660)
        snaps[:] = [(welcome, False)]
        assert window.resume() is False and scripts == []
        assert window.is_setup_screen(welcome) is True
        assert window.is_phone_shaped() is False
        #    …but a landscape mirror (an app that rotates) is phone-shaped too:
        #    its paused overlay IS resumed
        bounds["b"] = window.WindowBounds(x=0, y=0, width=727, height=329)
        assert window.is_phone_shaped() is True
        snaps[:] = [(paused, False)]
        clicks[:] = ["CLICKED"]
        after[:] = [live]
        assert window.resume() is True and scripts == [window._CLICK_RESUME_SCRIPT]
        scripts.clear()
        #    …and bounds that cannot be read mean no click
        def no_bounds():
            raise window.WindowError("no window")
        patch(window, "get_bounds", no_bounds)
        snaps[:] = [(paused, False)]
        assert window.resume() is False and scripts == []
        assert window.is_phone_shaped() is None and window.is_setup_screen(paused) is False
        patch(window, "get_bounds", lambda: bounds["b"])
        bounds["b"] = PHONE
        assert window.is_setup_screen(paused) is False
        assert window.is_setup_screen(live) is False

        # launch() returns the stream state instead of dropping resume()'s answer
        patch(gestures, "ensure_running", lambda: None)
        patch(window, "ensure_frontmost", lambda: None)
        patch(window, "resume", lambda: False)
        patch(window, "get_overlay", lambda: {"live": False, "overlay": None, "buttons": 1})
        assert gestures.launch() is False
        patch(window, "get_overlay", lambda: {"live": None, "overlay": None, "buttons": 0})
        assert gestures.launch() is None
        patch(window, "resume", lambda: True)
        assert gestures.launch() is True

        # phone_launch: mirror_not_live + exit 3 when still paused; ready only when live
        patch(gestures, "launch", lambda: False)
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            assert cli._cmd_launch(None) == 3
        assert "mirror_not_live:" in err.getvalue()
        #    F37: a setup / welcome screen → mirror_setup_required (still exit 3),
        #    and the message never tells the user to lock the iPhone
        bounds["b"] = window.WindowBounds(x=0, y=0, width=640, height=660)
        patch(window, "get_overlay", lambda: {"live": False, "overlay": "iPhone on Your Mac", "buttons": 1})
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            assert cli._cmd_launch(None) == 3
        assert err.getvalue().startswith("mirror_setup_required:")
        assert "lock the iPhone" not in err.getvalue()
        bounds["b"] = PHONE
        for state, text in ((True, "iPhone Mirroring ready"), (None, "stream state unknown")):
            patch(gestures, "launch", lambda s=state: s)
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                assert cli._cmd_launch(None) == 0
            assert text in out.getvalue()
    finally:
        for (mod, name), value in saved.items():
            setattr(mod, name, value)


def test_is_frontmost_fresh():
    """F30: every is_frontmost() call asks System Events again — no in-process snapshot."""
    import subprocess as sp

    import imctl.input as input_module
    from imctl import window

    real = window._run_osascript
    answers = ["true", "false", "true"]
    calls = []

    def fake(script, strip=True):
        calls.append(script)
        return answers.pop(0)

    def failing(script, strip=True):
        raise window.WindowError("osascript failed")

    def slow(script, strip=True):
        raise sp.TimeoutExpired(cmd="osascript", timeout=10)

    try:
        window._run_osascript = fake
        assert [window.is_frontmost() for _ in range(3)] == [True, False, True]
        assert calls == [window._FRONTMOST_SCRIPT] * 3
        window._run_osascript = failing
        assert window.is_frontmost() is False
        window._run_osascript = slow
        assert window.is_frontmost() is False
        # F26 consults exactly this function before every event
        assert input_module._focus_check is window.is_frontmost
    finally:
        window._run_osascript = real


def test_sweep_ocr_helpers():
    """F27: de-duplication behind ocr_sweep() and the short-text helpers."""
    from imctl.verify import is_short_text, new_text_occurrences
    from imctl.vision import SWEEP_MIN_TEXT_HEIGHTS, OCRHit, dedupe_hits

    assert SWEEP_MIN_TEXT_HEIGHTS and all(0 < h < 0.1 for h in SWEEP_MIN_TEXT_HEIGHTS)
    # same text within eps collapses to the most confident reading
    a = OCRHit(text="X", nx=0.45, ny=0.50, confidence=0.6)
    b = OCRHit(text="X", nx=0.451, ny=0.505, confidence=0.9)
    c = OCRHit(text="Notes", nx=0.45, ny=0.50, confidence=0.9)
    kept = dedupe_hits([a, b, c])
    assert len(kept) == 2 and b in kept and c in kept
    # new_text_occurrences: exact readings of "X" (look-alikes too, never
    # "Xcode" / "Box") at positions where no "X" was before
    after = [OCRHit(t, 0.1 * i, 0.5, 1.0)
             for i, t in enumerate(("X", "x", "×", "X.", "Ｘ", "Xcode", "Box"))]
    assert new_text_occurrences("X", [], after) == 5
    assert new_text_occurrences("X", after, after) == 0
    old = [OCRHit("X", 0.19, 0.27, 1.0)]       # a Siri-suggestion label (device, 2026-11-04)
    moved = [OCRHit("X", 0.18, 0.38, 1.0)]     # the result row for the query, elsewhere
    assert new_text_occurrences("X", old, old + moved) == 1
    assert new_text_occurrences("X", old, [OCRHit("X", 0.20, 0.28, 1.0)]) == 0  # within eps
    assert new_text_occurrences("", [], after) == 0
    for t in ("X", "ok", " X "):
        assert is_short_text(t), t
    for t in ("abc", "", "   "):
        assert not is_short_text(t), t
    assert is_short_text("X", limit=1) and not is_short_text("ok", limit=1)


def test_short_names_sweep_pass():
    """F27: a short name both default reads miss gets a sweep read; the
    expect guard does the same for a short anchor; long ones never do."""
    import argparse
    import contextlib
    import io

    from imctl import cli
    from imctl.gestures import find_app_hit
    from imctl.vision import OCRHit

    def hit(text, ny, nx=0.5):
        return OCRHit(text=text, nx=nx, ny=ny, confidence=0.9)

    def make_read(screens):
        calls = []

        def read(**kwargs):
            calls.append((kwargs.get("language_correction", "default"),
                          kwargs.get("sweep", False) or kwargs.get("also_sweep", False)))
            return screens[len(calls) - 1]

        read.calls = calls
        return read

    TOP = hit("Top Hit", 0.26)  # F35: rows count only inside the Top Hit card
    read = make_read([[], [], [TOP, hit("X", 0.30)]])
    assert find_app_hit(read, "X", sleep=lambda s: None).ny == 0.30
    assert read.calls == [("default", False), (False, False), (False, True)]
    # long names: never a sweep read
    read = make_read([[], [TOP, hit("Settings", 0.40)]])
    assert find_app_hit(read, "Settings", sleep=lambda s: None).ny == 0.40
    assert all(not sweep for _, sweep in read.calls)

    sweep_calls = []

    def read_sweep(screen):
        def read():
            sweep_calls.append(1)
            return screen
        return read

    args = argparse.Namespace(expect="X")
    # the default read misses the one-letter anchor, the sweep finds it: allowed
    assert cli._require_expect(args, read_screen=lambda: [hit("Notes", 0.5)],
                               read_sweep=read_sweep([hit("X", 0.5)])) is None
    assert sweep_calls == [1]
    # found by the default read: no sweep read at all
    sweep_calls.clear()
    assert cli._require_expect(args, read_screen=lambda: [hit("X", 0.5)],
                               read_sweep=read_sweep([])) is None
    assert sweep_calls == []
    # missing in both: refused, nothing sent
    err = io.StringIO()
    with contextlib.redirect_stderr(err):
        assert cli._require_expect(args, read_screen=lambda: [],
                                   read_sweep=read_sweep([])) == 5
    assert "expect_not_found:" in err.getvalue()
    # a long anchor never triggers the sweep read
    sweep_calls.clear()
    with contextlib.redirect_stderr(io.StringIO()):
        assert cli._require_expect(argparse.Namespace(expect="Replying to"),
                                   read_screen=lambda: [],
                                   read_sweep=read_sweep([hit("Replying to", .5)])) == 5
    assert sweep_calls == []


def test_type_single_char_restore():
    """F27 (+ review): typing one character restores the clipboard only when
    the SAME new position shows up in two separate sweep reads against a
    baseline read on a still screen; otherwise the clipboard keeps the
    typed text (the F18 tradeoff, unchanged)."""
    import imctl.input as input_module
    from imctl import verify, vision
    from imctl.input import type_text
    from imctl.vision import OCRHit

    class Pasteboard:
        def __init__(self):
            self.data, self.count = b"orig", 7

        def dataForType_(self, _t):
            return self.data

        def changeCount(self):
            return self.count

        def clearContents(self):
            self.count += 1
            self.data = None

        def setString_forType_(self, s, _t):
            self.data = s.encode()

        def setData_forType_(self, d, _t):
            self.data = d

    def X(nx, ny=0.5):
        return OCRHit(text="X", nx=nx, ny=ny, confidence=1.0)

    saved = {}

    def patch(mod, name, value):
        if (mod, name) not in saved:
            saved[(mod, name)] = getattr(mod, name)
        setattr(mod, name, value)

    def run(sweep_reads, still=True):
        # two equal frames (the screen holds still), the Cmd+V baseline, then
        # every later frame differs; or a screen that never holds still
        frames = [b"\x00" * 8] * 3
        flip = [0]

        def luma():
            if not still:
                flip[0] ^= 1
                return bytes([255 * flip[0]]) * 8
            return frames.pop(0) if frames else b"\xff" * 8

        reads = list(sweep_reads)

        def read_screen(language_correction=True, sweep=False):
            assert sweep and language_correction is False
            r = reads.pop(0) if reads else [X(0.2)]
            if isinstance(r, Exception):
                raise r
            return r

        patch(verify, "window_luma", luma)
        patch(vision, "read_screen", read_screen)
        now = [0.0]

        def sleep(s):
            now[0] += s

        pb = Pasteboard()
        ok = type_text("X", pasteboard=pb, chord=lambda k, before_key=None: before_key and before_key(), sleep=sleep,
                       clock=lambda: now[0])
        return ok, pb, reads

    try:
        patch(input_module, "ensure_frontmost", lambda: None)
        # one "X" before (an app label); the pasted one shows up elsewhere, in
        # two separate reads at the same spot: restored
        ok, pb, left = run([[X(0.2)], [X(0.2), X(0.6)], [X(0.2), X(0.6)]])
        assert ok and pb.data == b"orig" and left == []
        # only later reads show it (mid-transition frame, echo blinking)
        ok, pb, left = run([[X(0.2)], [X(0.2)], [X(0.2), X(0.18, 0.38)],
                            [X(0.2), X(0.18, 0.38)]])
        assert ok and pb.data == b"orig" and left == []
        # seen once only (a banner, a flaky read): never restored
        ok, pb, left = run([[X(0.2)], [X(0.2), X(0.6)], [X(0.2)]])
        assert ok and pb.data == b"X" and left == []
        # two reads, two different spots (a list still moving): never restored
        ok, pb, left = run([[X(0.2)], [X(0.2), X(0.6)], [X(0.2), X(0.7)]])
        assert ok and pb.data == b"X" and left == []
        # nothing new for 4 s: landed, but the clipboard keeps the typed text
        ok, pb, left = run([[X(0.2)], [X(0.2)], [X(0.2)]])
        assert ok and pb.data == b"X" and left == []
        # the baseline sweep read could not capture: never restored; the only
        # further read is the F44 look for the paste-progress box (a sweep)
        ok, pb, left = run([verify.WindowError("blank"), [X(0.2), X(0.6)]])
        assert ok and pb.data == b"X" and len(left) == 0
        # the screen never held still: no baseline read, no restore; again only
        # the F44 look reads the screen
        ok, pb, left = run([[X(0.2)], [X(0.2), X(0.6)], [X(0.2), X(0.6)]], still=False)
        assert ok and pb.data == b"X" and len(left) == 2
        # (F44) the phone shows its "Pasting from …" box after the frame diff
        # fired and nothing new was seen: the paste is still on its way → False,
        # never restored
        box = [OCRHit(text="Pasting from “M5pro”…", nx=0.5, ny=0.47, confidence=1.0)]
        ok, pb, left = run([verify.WindowError("blank"), box])
        assert ok is False and pb.data == b"X" and left == []
        #    the character at a new spot in two reads that also show the box (an
        #    earlier paste still in flight): no evidence, never restored
        ok, pb, left = run([[X(0.2)], [X(0.2), X(0.6)] + box, [X(0.2), X(0.6)] + box])
        assert ok and pb.data == b"X" and left == []
    finally:
        for (mod, name), value in saved.items():
            setattr(mod, name, value)


def test_frames_private_and_deleted():
    """Mirror frames go to an owner-only directory and are deleted once read;
    find() looks for a short text the default pass misses with the sweep (F27)."""
    import os
    import stat
    import tempfile
    from types import SimpleNamespace

    from imctl import vision
    from imctl.vision import CaptureError, OCRError, OCRHit

    real = (vision._run, vision.get_window_info, vision.ocr, vision.ocr_sweep)
    frames, sweeps = [], []

    def fake_run(argv, **_kw):
        with open(argv[-1], "wb") as f:
            f.write(b"png")
        frames.append(argv[-1])
        return SimpleNamespace(returncode=0)

    def fake_sweep(path, **_kw):
        sweeps.append(path)
        return [OCRHit("X", 0.45, 0.5, 1.0)]

    caller_dir = tempfile.mkdtemp(prefix="imctl_test_frames_")
    try:
        vision._run = fake_run
        vision.get_window_info = lambda: {"id": 4242, "onscreen": True}
        vision.ocr = lambda path, **_kw: []
        vision.ocr_sweep = fake_sweep

        assert vision.read_screen() == []
        private = os.path.dirname(frames[-1])
        assert stat.S_IMODE(os.stat(private).st_mode) == 0o700
        assert not os.path.exists(frames[-1])  # deleted once read
        assert vision.read_screen(sweep=True)[0].text == "X"
        assert not os.path.exists(frames[-1])

        def boom(path, **_kw):
            raise OCRError("decode failed")

        vision.ocr = boom
        try:
            vision.read_screen()
            assert False, "the OCR error must propagate"
        except OCRError:
            pass
        assert not os.path.exists(frames[-1])  # deleted on errors too
        vision.ocr = lambda path, **_kw: []

        # find(): the default pass misses "X", the sweep finds it; frame deleted
        sweeps.clear()
        hit = vision.find("X")
        assert hit is not None and hit.text == "X" and len(sweeps) == 1
        assert not os.path.exists(frames[-1])
        # a long text never triggers the sweep
        sweeps.clear()
        assert vision.find("Settings") is None and sweeps == []
        # a caller's own image is read, never deleted
        own = os.path.join(caller_dir, "mine.png")
        with open(own, "wb") as f:
            f.write(b"png")
        assert vision.find("X", image_path=own) is not None and os.path.exists(own)

        # a failed capture leaves no file behind
        vision._run = lambda argv, **_kw: SimpleNamespace(returncode=1)
        left = set(os.listdir(private))
        try:
            vision.capture_window()
            assert False, "a failed capture must raise CaptureError"
        except CaptureError:
            pass
        assert set(os.listdir(private)) == left
    finally:
        vision._run, vision.get_window_info, vision.ocr, vision.ocr_sweep = real
        for name in os.listdir(caller_dir):
            os.unlink(os.path.join(caller_dir, name))
        os.rmdir(caller_dir)


def test_open_app_short_rows_and_deferred_restore():
    """F32-F34 (2026-11-04 device stress run): short names re-read with the
    sweep too, so a missed top row is not mistaken for a moved row; a
    one-character paste the checks did not see is restored later, only on
    evidence; the Spotlight gate gets exactly one retry."""
    import argparse
    import contextlib
    import io
    from types import SimpleNamespace

    import imctl.input as input_module
    from imctl import cli, gestures, verify, vision
    from imctl.gestures import OPEN_MIN_DIFF, open_app
    from imctl.input import PendingRestore, type_text
    from imctl.vision import OCRHit

    def hit(text, ny, nx=0.18):
        return OCRHit(text=text, nx=nx, ny=ny, confidence=0.9)

    TOP = hit("X", 0.27)          # the Top Hit label
    SUGG = hit("X", 0.386)        # the Chrome web suggestion below it
    ZEROS = b"\x00" * 100
    OPENED = bytes([int(OPEN_MIN_DIFF) + 1] * 100)

    def run(name, screens):
        calls, taps = [], []

        def read(**kwargs):
            calls.append(kwargs)
            return screens.pop(0)

        lumas = [ZEROS, OPENED]
        res = open_app(name, spotlight_open=True, read_screen=read,
                       luma=lambda: lumas.pop(0), sleep=lambda s: None,
                       tap=lambda x, y: taps.append((x, y)), home=lambda: True,
                       clear_text=lambda: None, type_text=lambda t: True)
        return res, calls, taps

    HEADER = hit("Top Hit", 0.16)  # F35: the Top Hit card header above TOP

    # F32: the stability re-read of a short name also sweeps; it sees both
    # rows, the top one stays the target
    res, calls, taps = run("X", [[HEADER, TOP], [HEADER, TOP, SUGG], []])
    assert res == "opened" and taps == [(0.18, 0.27)]
    assert calls[1] == {"also_sweep": True}
    # long names keep the plain re-read
    res, calls, taps = run("Photos", [[HEADER, hit("Photos", 0.27)],
                                      [HEADER, hit("Photos", 0.27)], []])
    assert res == "opened" and calls[1] == {}
    # F35: when only the Chrome suggestion row of the same name is read (the
    # Top Hit label missed in every pass), nothing is tapped: not_found
    res, calls, taps = run("X", [[HEADER, SUGG, hit("X", 0.93)]] * 9)  # the field shows "X"
    assert res == "not_found" and taps == []

    class Pasteboard:
        def __init__(self):
            self.data, self.count = b"orig", 7

        def dataForType_(self, _t):
            return self.data

        def changeCount(self):
            return self.count

        def clearContents(self):
            self.count += 1
            self.data = None

        def setString_forType_(self, s, _t):
            self.data = s.encode()

        def setData_forType_(self, d, _t):
            self.data = d

    def written(*texts):
        pb = Pasteboard()
        for t in texts:
            pb.clearContents()
            pb.setString_forType_(t, "public.utf8-plain-text")
        return pb

    def X(nx, ny=0.5):
        return OCRHit(text="X", nx=nx, ny=ny, confidence=1.0)

    # F33: PendingRestore on its own — restores once its evidence confirms
    pb = written("X")
    pr = PendingRestore(pb, b"orig", 7, verify.RepeatedSighting("X", [X(0.2)]).add,
                        sent_at=0.0, clock=lambda: 10.0)
    assert pr.offer([X(0.2)]) is False and pb.data == b"X"   # nothing new
    assert pr.offer([X(0.6)]) is False and pb.data == b"X"   # seen once
    assert pr.offer([X(0.7)]) is False and pb.data == b"X"   # another spot
    assert pr.offer([X(0.6)]) is True and pb.data == b"orig"  # same spot again
    assert pr.done and pr.offer([X(0.6)]) is False
    # something else wrote the pasteboard meanwhile: never restored
    pb = written("X", "a later copy")
    pr = PendingRestore(pb, b"orig", 7, lambda hits: True, sent_at=0.0, clock=lambda: 10.0)
    pr.offer([])
    assert pr.offer([]) is False and pb.data == b"a later copy" and pr.done
    # never before min_hold_s after Cmd+V
    pb, t = written("X"), [0.1]
    pr = PendingRestore(pb, b"orig", 7, lambda hits: True, sent_at=0.0,
                        clock=lambda: t[0], min_hold_s=0.3)
    assert pr.offer([]) is False and pr.offer([]) is False and not pr.done
    t[0] = 0.5
    assert pr.offer([]) is True and pb.data == b"orig"

    # RepeatedSighting / new_text_positions on their own
    ev = verify.RepeatedSighting("X", [X(0.2)])
    assert verify.new_text_positions("X", [X(0.2)], [X(0.2), X(0.6), X(0.21)]) == [(0.6, 0.5)]
    assert ev.add([X(0.6)]) is False and ev.add([X(0.62)]) is True   # within eps
    assert verify.RepeatedSighting("X", []).add([X(0.6), X(0.6)]) is False  # one read

    # type_text hands one over for a single character its checks did not
    # license; a longer text never gets one
    saved = {}

    def patch(mod, name, value):
        saved.setdefault((mod, name), getattr(mod, name))
        setattr(mod, name, value)

    try:
        patch(input_module, "ensure_frontmost", lambda: None)
        frames = [b"\x00" * 8] * 3   # still, still, Cmd+V baseline; then changed
        patch(verify, "window_luma", lambda: frames.pop(0) if frames else b"\xff" * 8)
        patch(vision, "read_screen", lambda language_correction=True, sweep=False: [X(0.2)])
        now = [0.0]

        def sleep(s):
            now[0] += s

        pb, pending = Pasteboard(), []
        assert type_text("X", pasteboard=pb, chord=lambda k, before_key=None: before_key and before_key(), sleep=sleep,
                         clock=lambda: now[0], pending=pending)
        assert pb.data == b"X" and len(pending) == 1
        assert pending[0].offer([X(0.2)]) is False            # nothing new
        assert pending[0].offer([X(0.2), X(0.6)]) is False    # first read of evidence
        assert pending[0].offer([X(0.6)]) is True and pb.data == b"orig"

        #    (F44) reads that show the phone's "Pasting from …" box are no evidence:
        #    a paste is still on its way
        frames[:] = [b"\x00" * 8] * 3
        pb, pending = Pasteboard(), []
        assert type_text("X", pasteboard=pb, chord=lambda k, before_key=None: before_key and before_key(), sleep=sleep,
                         clock=lambda: now[0], pending=pending)
        box = OCRHit(text="Pasting from “M5pro”…", nx=0.5, ny=0.47, confidence=1.0)
        assert pending[0].offer([X(0.2), X(0.6), box]) is False
        assert pending[0].offer([X(0.2), X(0.6), box]) is False and pb.data == b"X"
        assert pending[0].offer([X(0.6)]) is False            # first box-free read of evidence
        assert pending[0].offer([X(0.6)]) is True and pb.data == b"orig"

        frames[:] = [b"\x00" * 8] * 3
        patch(vision, "read_screen", lambda language_correction=True, sweep=False: [])
        pb, pending = Pasteboard(), []
        type_text("abc", pasteboard=pb, chord=lambda k, before_key=None: before_key and before_key(), sleep=sleep,
                  clock=lambda: now[0], pending=pending)
        assert pending == [] and pb.data == b"abc"

        # open_app offers every read it makes to what type_text handed over
        offers = []

        class Pending:
            def offer(self, hits):
                offers.append(hits)

        typed_kw = {}

        def fake_type(text, pending=None, **kw):
            typed_kw.update(kw)
            pending.append(Pending())
            return True

        patch(gestures.inp, "type_text", fake_type)
        screens, lumas = [[HEADER, TOP], [HEADER, TOP, SUGG], []], [ZEROS, OPENED]
        res = open_app("X", spotlight_open=True,
                       read_screen=lambda **kw: screens.pop(0),
                       luma=lambda: lumas.pop(0), sleep=lambda s: None,
                       tap=lambda x, y: None, home=lambda: True,
                       clear_text=lambda: None)
        assert res == "opened" and len(offers) == 3
        assert typed_kw == {"restore": False}  # F42: open_app never restores the clipboard
    finally:
        for (mod, name), value in saved.items():
            setattr(mod, name, value)

    # F34: the CLI's Spotlight gate is retried exactly once
    real_live, real_gestures = cli._require_live, cli.gestures
    cli._require_live = lambda: None
    try:
        gate = []

        def flaky():
            gate.append(1)
            return len(gate) == 2

        cli.gestures = SimpleNamespace(open_spotlight_checked=flaky,
                                       open_app=lambda name, spotlight_open=True, **kw: "opened")
        with contextlib.redirect_stdout(io.StringIO()):
            assert cli._cmd_open(argparse.Namespace(app="X")) == 0
        assert len(gate) == 2
        gate.clear()
        cli.gestures = SimpleNamespace(open_spotlight_checked=lambda: gate.append(1) or False)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            assert cli._cmd_open(argparse.Namespace(app="X")) == 1
        assert len(gate) == 2 and "spotlight unavailable" in out.getvalue()
    finally:
        cli._require_live, cli.gestures = real_live, real_gestures


def test_clipboard_race_and_late_paste():
    """F35: nothing is pasted when something else wrote the pasteboard after
    type_text's own write (another app, Universal Clipboard), and their
    content is left alone; the one-character pre-read runs before that
    write. F33: open_app gives a paste type_text did not see a third pass."""
    import imctl.input as input_module
    from imctl import verify, vision
    from imctl.gestures import OPEN_MIN_DIFF, open_app
    from imctl.input import ClipboardChanged, type_text
    from imctl.vision import OCRHit

    log = []

    class Pasteboard:
        def __init__(self, remote):
            self.data, self.count, self.remote = b"orig", 7, remote

        def dataForType_(self, _t):
            return self.data

        def changeCount(self):
            return self.count

        def clearContents(self):
            log.append("clear")
            self.count += 1
            self.data = None

        def setString_forType_(self, s, _t):
            log.append("write")
            self.data = s.encode()
            if self.remote:  # another device's copy lands right after ours
                self.count += 1
                self.data = b"from another device"

        def setData_forType_(self, d, _t):
            self.data = d

    saved = {}

    def patch(mod, name, value):
        saved.setdefault((mod, name), getattr(mod, name))
        setattr(mod, name, value)

    try:
        patch(input_module, "ensure_frontmost", lambda: None)
        patch(verify, "window_luma", lambda: b"\x00" * 8)

        def read(language_correction=True, sweep=False):
            log.append("sweep")
            return []

        patch(vision, "read_screen", read)
        for text in ("X", "hello"):
            log.clear()
            chords, pb = [], Pasteboard(remote=True)
            try:
                type_text(text, pasteboard=pb,
                          chord=lambda k, before_key=None: (before_key and before_key(),
                                                            chords.append(k)),
                          sleep=lambda s: None, clock=lambda: 0.0)
                assert False, "a changed clipboard must stop the paste"
            except ClipboardChanged:
                pass
            assert chords == [] and pb.data == b"from another device"
            # the pre-paste read (a sweep for "X"; F41: a plain count for "hello")
            # happened before our write
            assert log.index("sweep") < log.index("write")
    finally:
        for (mod, name), value in saved.items():
            setattr(mod, name, value)

    # F33: an unseen paste gets a third find pass; a seen one keeps two.
    # F35: the reads that find the row show the Top Hit header above it.
    HEADER = OCRHit(text="Top Hit", nx=0.18, ny=0.16, confidence=0.9)
    LABEL = OCRHit(text="X", nx=0.18, ny=0.27, confidence=0.9)
    TOP = [HEADER, LABEL]  # one OCR read of the Top Hit card
    OPENED = bytes([int(OPEN_MIN_DIFF) + 1] * 100)

    def run(typed, screens):
        lumas, homes = [b"\x00" * 100, OPENED], []
        res = open_app("X", spotlight_open=True,
                       read_screen=lambda **kw: screens.pop(0),
                       luma=lambda: lumas.pop(0), sleep=lambda s: None,
                       tap=lambda x, y: None, home=lambda: homes.append(1) or True,
                       clear_text=lambda: None, type_text=lambda t: typed)
        return res, screens, homes

    # passes 1 and 2 read nothing (3 reads each for a short name); pass 3 finds it
    res, left, homes = run(False, [[]] * 6 + [TOP, TOP, []])
    assert res == "opened" and left == [] and homes == []
    #    F42: a paste type_text took as seen, while the search field does not show the
    #    name yet, gets the late reads too (a clear that landed late can fake the change)
    res, left, homes = run(True, [[]] * 6 + [TOP, TOP, []])
    assert res == "opened" and left == [] and homes == []

    # F42: an unseen paste may reach the phone more than 10 s later — keep reading, one pass
    # a second, for up to OPEN_LATE_PASTE_S (fake clock: only the sleeps move it)
    from imctl.gestures import OPEN_LATE_PASTE_S
    SHOPEE = [HEADER, OCRHit(text="Shopee", nx=0.18, ny=0.27, confidence=0.9)]
    OTHER = [HEADER, OCRHit(text="Shopee Partner", nx=0.18, ny=0.27, confidence=0.9)]

    def run_late(screens, deadline_s=None):
        now, lumas, homes = [0.0], [b"\x00" * 100, OPENED], []

        def sleep(s):
            now[0] += s
        res = open_app("Shopee", spotlight_open=True,
                       read_screen=lambda **kw: screens.pop(0),
                       luma=lambda: lumas.pop(0), sleep=sleep,
                       tap=lambda x, y: None, home=lambda: homes.append(1) or True,
                       clear_text=lambda: None, type_text=lambda t: False,
                       clock=lambda: now[0], deadline_s=deadline_s)
        return res, screens, homes, now[0]

    #    the paste shows up on the 9th read (~8 s on) → still opened
    res, left, homes, _ = run_late([[]] * 8 + [SHOPEE, SHOPEE, []])
    assert res == "opened" and left == [] and homes == []
    #    nothing ever: reads stop at the time limit, not before → not_typed (the name may
    #    never have reached the phone: no evidence the app is missing)
    screens = [[]] * 30
    res, left, homes, t = run_late(screens)
    assert res == "not_typed" and homes == [1]
    assert len(screens) == 30 - int(OPEN_LATE_PASTE_S) and t >= OPEN_LATE_PASTE_S
    #    the search field shows the name (the paste is in) and the Top Hit card lacks it:
    #    one more pass, then stop → not_found
    ECHO = OCRHit(text="Shopee", nx=0.3, ny=0.93, confidence=0.9)
    res, left, homes, t = run_late([[], OTHER + [ECHO], OTHER + [ECHO]] + [OTHER] * 10)
    assert res == "not_found" and len(left) == 10 and homes == [1]
    #    a Top Hit card but never the name in the field (e.g. the previous query's card):
    #    no early stop — read to the time limit → not_typed
    res, left, homes, t = run_late([OTHER] * 30)
    assert res == "not_typed" and t >= OPEN_LATE_PASTE_S and homes == [1]
    #    the name in the field but no Top Hit header the reader knows (another language):
    #    no_top_hit, which points at NORACU_TOPHIT_LABELS
    res, left, homes, t = run_late([[ECHO], [ECHO]] + [[ECHO]] * 10)
    assert res == "no_top_hit" and len(left) == 10 and homes == [1]
    #    the echo shows up on the last read before the time limit: the confirming pass still
    #    runs past the limit (within the open budget) and finds the Top Hit
    n_before = int(OPEN_LATE_PASTE_S) - 1
    res, left, homes, t = run_late([[]] * n_before + [[ECHO], SHOPEE, SHOPEE, []], deadline_s=60.0)
    assert res == "opened" and left == [] and homes == []
    #    … but never past the open budget
    res, left, homes, t = run_late([[]] * n_before + [[ECHO], SHOPEE, SHOPEE, []],
                                   deadline_s=1.8 + OPEN_LATE_PASTE_S - 0.5)
    assert res == "deadline" and homes == [1]
    #    the field echo: exact, bottom zone only, a "Q" for the magnifier glyph tolerated
    from imctl.gestures import _field_echo
    assert _field_echo([ECHO], "shopee") and _field_echo([OCRHit(text="Q Shopee", nx=0.3,
                                                                  ny=0.93, confidence=0.9)], "Shopee")
    assert not _field_echo([OCRHit(text="Shopee", nx=0.3, ny=0.5, confidence=0.9)], "Shopee")
    assert not _field_echo([OCRHit(text="Q Search", nx=0.3, ny=0.93, confidence=0.9)], "Shopee")
    assert not _field_echo([OCRHit(text="Shopee Partner", nx=0.3, ny=0.93, confidence=0.9)], "Shopee")
    assert _field_echo([OCRHit(text="Q.拼多多", nx=0.3, ny=0.93, confidence=0.9)], "拼多多")  # seen on the device
    assert _field_echo([OCRHit(text="Q: QQ", nx=0.3, ny=0.93, confidence=0.9)], "QQ")
    #    the open budget still wins over the late-paste wait
    res, left, homes, _ = run_late([[]] * 30, deadline_s=5.0)
    assert res == "deadline" and homes == [1]


def test_screenshot_default_path_and_sigterm():
    """Review follow-ups: a screenshot taken without a path outlives the
    process as an owner-only file (unlike OCR frames); a failed one leaves
    nothing behind; SIGTERM becomes SystemExit so cleanup runs."""
    import argparse
    import contextlib
    import io
    import os
    import signal
    import stat
    from types import SimpleNamespace

    from imctl import cli
    from imctl.vision import CaptureError

    real_vision, real_mkstemp = cli.vision, cli.tempfile.mkstemp
    real_handler = signal.getsignal(signal.SIGTERM)
    made = []

    def recording_mkstemp(*a, **k):
        fd, path = real_mkstemp(*a, **k)
        made.append(path)
        return fd, path

    def capture(path=None):
        assert path is not None
        with open(path, "wb") as f:
            f.write(b"png")
        return path

    def boom(path=None):
        raise CaptureError("could not capture the iPhone Mirroring window by id")

    try:
        cli.tempfile.mkstemp = recording_mkstemp
        cli.vision = SimpleNamespace(capture_window=capture)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            assert cli._cmd_screenshot(argparse.Namespace(path=None)) == 0
        path = out.getvalue().strip()
        assert path == made[-1] and os.path.exists(path)
        assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
        os.unlink(path)

        cli.vision = SimpleNamespace(capture_window=boom)
        with contextlib.redirect_stderr(io.StringIO()):
            assert cli._cmd_screenshot(argparse.Namespace(path=None)) == 7
        assert not os.path.exists(made[-1])  # the empty placeholder is gone

        try:
            cli._on_sigterm(signal.SIGTERM, None)
            assert False, "SIGTERM must become SystemExit"
        except SystemExit as exc:
            assert exc.code == 128 + signal.SIGTERM
        cli.vision = SimpleNamespace(capture_window=capture)
        target = made[-1] + ".main.png"
        with contextlib.redirect_stdout(io.StringIO()):
            assert cli.main(["screenshot", target]) == 0
        assert signal.getsignal(signal.SIGTERM) is cli._on_sigterm
        os.unlink(target)
    finally:
        cli.vision, cli.tempfile.mkstemp = real_vision, real_mkstemp
        signal.signal(signal.SIGTERM, real_handler)


def test_bring_front_waits_for_a_frame():
    """F31: activating the mirror waits for a real frame; input commands
    bring it to the front before any other check."""
    import time as time_module

    from imctl import cli, verify, window

    saved = {}

    def patch(mod, name, value):
        if (mod, name) not in saved:
            saved[(mod, name)] = getattr(mod, name)
        setattr(mod, name, value)

    answers, frames, activations = [], [], []

    def luma():
        r = frames.pop(0)
        if isinstance(r, Exception):
            raise r
        return r

    try:
        patch(window, "_run_osascript", lambda script, strip=True, timeout=10: answers.pop(0))
        patch(window.subprocess, "run", lambda *a, **k: activations.append(1))
        patch(time_module, "sleep", lambda s: None)
        patch(verify, "window_luma", luma)
        # already frontmost: return at once — no activation, no frame wait
        answers[:] = ["true"]
        window.ensure_frontmost()
        assert activations == [] and answers == []
        # had to activate: two transition frames refused, then a real one
        answers[:] = ["false", "true"]
        frames[:] = [window.WindowError("blank"), window.WindowError("off"), b"\x01\x02"]
        window.ensure_frontmost()
        assert activations == [1] and frames == []
        # activation that does not take still raises
        answers[:] = ["false", "false"]
        try:
            window.ensure_frontmost()
            raise AssertionError("expected WindowError")
        except window.WindowError:
            pass
        # _require_live probes get_overlay first, then brings a live mirror to the front
        order = []
        patch(cli, "_is_front", lambda: True)  # already in front: no second probe (R18)
        patch(cli, "_bring_front", lambda: order.append("front"))
        patch(cli, "get_overlay",
              lambda: order.append("overlay") or {"live": True, "overlay": None, "buttons": 0})
        assert cli._require_live() is None and order == ["overlay", "front"]
    finally:
        for (mod, name), value in saved.items():
            setattr(mod, name, value)


if __name__ == "__main__":
    test_denormalize()
    test_center()
    test_ease_curve()
    test_parser_builds()
    test_parse_overlay()
    test_choose_app_hit()
    test_find_app_hit()
    test_short_app_names()
    test_mean_abs_diff()
    test_open_spotlight_checked()
    test_open_app_confirm()
    test_type_text_confirm()
    test_scroll_steps()
    test_scroll_checked()
    test_expect_guard()
    test_capture_integrity()
    test_focus_guard()
    test_overlay_hover_controls()
    test_resume_never_clicks_window_controls()
    test_is_frontmost_fresh()
    test_sweep_ocr_helpers()
    test_short_names_sweep_pass()
    test_type_single_char_restore()
    test_frames_private_and_deleted()
    test_open_app_short_rows_and_deferred_restore()
    test_clipboard_race_and_late_paste()
    test_screenshot_default_path_and_sigterm()
    test_bring_front_waits_for_a_frame()
    print("all smoke tests passed")


def test_watch_late_paste_and_type_messages():
    """F38: a paste unconfirmed at 2.5 s is watched (read-only) a little longer.

    Seen later → "typed … (landed late …)", exit 0, no second paste; never
    seen → type_not_confirmed that tells the caller to read the screen before
    retyping; a capture failure during the watch is "not seen", never "seen".
    """
    import argparse
    import contextlib
    import io

    from imctl import cli
    from imctl.vision import CaptureError, OCRHit

    def hits(*texts):
        return [OCRHit(text=t, nx=0.5, ny=0.1 + i * 0.05, confidence=0.9)
                for i, t in enumerate(texts)]

    now = [0.0]

    def sleep(s):
        now[0] += s

    def clock():
        return now[0]

    # type_text's pre-paste count (0 here) is the baseline; the text counts once it is
    # seen in TWO consecutive frames — first seen on the third read → confirmed on the 4th
    screens = [hits("Search"), hits("Search"), hits("iPhone 17 Pro Max case"),
               hits("iPhone 17 Pro Max case")]
    now[0] = 0.0
    late = cli._watch_late_paste("iPhone 17 Pro Max case", baseline=0,
                                 read_screen=lambda: screens.pop(0), sleep=sleep, clock=clock)
    assert late == 2.4 and screens == []  # the confirming read follows 0.4 s after the first

    #    a paste that already shows on the watch's FIRST frame is not swallowed
    now[0] = 0.0
    assert cli._watch_late_paste("hello", baseline=0, read_screen=lambda: hits("hello"),
                                 sleep=sleep, clock=clock) == 0.4

    #    a first sighting at the very end still gets its confirming read
    screens_end = [hits("x"), hits("hello"), hits("hello")]
    now[0] = 0.0
    assert cli._watch_late_paste("hello", baseline=0, read_screen=lambda: screens_end.pop(0),
                                 sleep=sleep, clock=clock, watch_s=1.2) == 1.4

    # never seen → None after the watch window, no read beyond it
    reads = []
    now[0] = 0.0
    assert cli._watch_late_paste("hello", baseline=0,
                                 read_screen=lambda: reads.append(1) or hits("x"),
                                 sleep=sleep, clock=clock, watch_s=3.0) is None
    assert len(reads) == 3

    #    one OCR blip is not enough: seen, not seen, seen, not seen … → None
    blips = [hits("hello"), hits("x")] * 6
    now[0] = 0.0
    assert cli._watch_late_paste("hello", baseline=0, read_screen=lambda: blips.pop(0),
                                 sleep=sleep, clock=clock, watch_s=8.0) is None

    # F44: the words of the phone's "Pasting from …" box never count as the text ("pro"
    #    is in "M5pro"); once the box is gone and the text shows twice, it counts
    box = "Pasting from “M5pro”…"
    seq = [hits(box), hits(box), hits(box), hits("pro"), hits("pro")]
    now[0] = 0.0
    late = cli._watch_late_paste("pro", baseline=0, read_screen=lambda: seq.pop(0),
                                 sleep=sleep, clock=clock)
    assert round(late, 6) == 3.4 and seq == []

    # F41: with type_text's pre-paste count as the baseline, text that was already
    # on screen (count 1 before the paste) only counts once it occurs MORE often
    now[0] = 0.0
    assert cli._watch_late_paste("hello", baseline=1, read_screen=lambda: hits("say hello"),
                                 sleep=sleep, clock=clock) is None
    screens2 = [hits("say hello"), hits("say hello", "hello"), hits("say hello", "hello")]
    now[0] = 0.0
    assert cli._watch_late_paste("hello", baseline=1, read_screen=lambda: screens2.pop(0),
                                 sleep=sleep, clock=clock) == 1.4

    # no pre-paste count (type_text could not read the screen): the watch's first readable
    # frame is the floor, so text already on screen is never taken for the paste …
    now[0] = 0.0
    assert cli._watch_late_paste("hello", read_screen=lambda: hits("say hello"),
                                 sleep=sleep, clock=clock) is None
    now[0] = 0.0
    assert cli._watch_late_paste("hello", read_screen=lambda: hits("hello"),
                                 sleep=sleep, clock=clock) is None
    #    … but a paste that shows up after those frames still counts (two sightings); the
    #    floor is the higher count of the first two readable frames, and an unreadable frame
    #    is not one of them
    seq3 = [CaptureError("blank"), hits("say hello"), hits("say hello"),
            hits("say hello", "hello"), hits("say hello", "hello")]

    def reads3():
        item = seq3.pop(0)
        if isinstance(item, Exception):
            raise item
        return item
    now[0] = 0.0
    assert round(cli._watch_late_paste("hello", read_screen=reads3, sleep=sleep,
                                       clock=clock), 6) == 3.4 and seq3 == []
    #    one floor frame under-counting (an occurrence missed) cannot fake a rise
    seq4 = [hits("x"), hits("say hello"), hits("say hello"), hits("say hello")] + [hits("say hello")] * 20

    def reads4():
        return seq4.pop(0)
    now[0] = 0.0
    assert cli._watch_late_paste("hello", read_screen=reads4, sleep=sleep, clock=clock) is None

    # capture failures are "not seen" and break the run; other errors propagate
    def flaky():
        raise CaptureError("could not capture the iPhone Mirroring window by id")
    now[0] = 0.0
    assert cli._watch_late_paste("hello", read_screen=flaky, sleep=sleep, clock=clock,
                                 watch_s=2.0) is None
    seq = [hits("hello"), CaptureError("blank frame"), hits("hello"), hits("hello")]

    def broken_run():
        item = seq.pop(0)
        if isinstance(item, Exception):
            raise item
        return item
    now[0] = 0.0
    assert round(cli._watch_late_paste("hello", baseline=0, read_screen=broken_run,
                                       sleep=sleep, clock=clock), 6) == 1.8
    def broken():
        raise RuntimeError("boom")
    now[0] = 0.0
    try:
        cli._watch_late_paste("hello", read_screen=broken, sleep=sleep, clock=clock)
        assert False, "a non-capture error must propagate"
    except RuntimeError:
        pass

    # one-character text is not watched at all: None at once, no read, no wait
    now[0] = 0.0
    assert cli._watch_late_paste("X", read_screen=lambda: 1 / 0, sleep=sleep,
                                 clock=clock) is None
    assert now[0] == 0.0

    # _cmd_type wiring: unconfirmed + seen late → exit 0, "landed late"
    real = (cli._require_live, cli._require_expect, cli.input.type_text, cli._watch_late_paste)
    try:
        cli._require_live = lambda: None
        cli._require_expect = lambda args: None
        seen_baseline = []

        def unconfirmed(text, replace=False, report=None):
            report["count_before"] = 1  # F41: type_text reports its pre-paste count
            return False
        cli.input.type_text = unconfirmed
        args = argparse.Namespace(text="hello world", replace=False, expect=None)
        cli._watch_late_paste = lambda text, baseline=None: seen_baseline.append(baseline) or 2.0
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            assert cli._cmd_type(args) == 0
        assert "showed up late" in out.getvalue() and "extra 2s check" in out.getvalue()
        #    never seen → exit 4 with the read-before-retyping advice
        assert seen_baseline == [1]  # the watch got type_text's baseline
        cli._watch_late_paste = lambda text, baseline=None: None
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            assert cli._cmd_type(args) == 4
        msg = err.getvalue()
        assert msg.startswith("type_not_confirmed:") and "before typing again" in msg
        assert "replace=true" in msg and "a further 15s check" in msg
        #    replace=true over text that was already on screen: say why nothing changed
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            assert cli._cmd_type(argparse.Namespace(text="hello world", replace=True,
                                                    expect=None)) == 4
        assert "already on screen before this paste" in err.getvalue()
        assert "retype with replace=true" not in err.getvalue()
        #    one character: the message does not claim a watch that never ran
        args1 = argparse.Namespace(text="X", replace=False, expect=None)
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            assert cli._cmd_type(args1) == 4
        assert "cannot be confirmed by OCR afterwards" in err.getvalue()
        assert "further" not in err.getvalue()
    finally:
        (cli._require_live, cli._require_expect, cli.input.type_text,
         cli._watch_late_paste) = real


def test_status_reports_setup_screen():
    """F37: status() says setup=true (and paused=false) for a welcome screen."""
    from imctl import gestures, window

    saved = {}

    def patch(mod, name, value):
        if (mod, name) not in saved:
            saved[(mod, name)] = getattr(mod, name)
        setattr(mod, name, value)

    try:
        patch(window, "is_running", lambda: True)
        patch(window, "get_window_info", lambda: {"id": 546, "onscreen": True})
        patch(window, "is_frontmost", lambda: True)
        welcome = {"live": False, "overlay": "iPhone on Your Mac", "buttons": 1}
        paused = {"live": False, "overlay": "Connection Paused", "buttons": 1}
        for overlay, b, setup, paused_flag in (
                (welcome, window.WindowBounds(x=0, y=0, width=640, height=660), True, False),
                (paused, window.WindowBounds(x=0, y=0, width=329, height=727), False, True)):
            patch(window, "get_overlay", lambda o=overlay: o)
            patch(window, "get_bounds", lambda bb=b: bb)
            patch(gestures, "get_bounds", lambda bb=b: bb)
            info = gestures.status()
            assert info["setup"] is setup and info["paused"] is paused_flag, info
    finally:
        for (mod, name), value in saved.items():
            setattr(mod, name, value)


def test_open_deadline_from_env():
    """The server passes an absolute deadline, NORACU_OPEN_DEADLINE_EPOCH."""
    import os

    from imctl import cli

    saved = os.environ.get("NORACU_OPEN_DEADLINE_EPOCH")
    try:
        now = lambda: 1000.0
        for raw, want in (("1038", {"deadline_s": 38.0}), ("1002.5", {"deadline_s": 2.5}),
                          ("999", {"deadline_s": 0.0}),   # already past → no budget at all
                          ("", {}), ("abc", {}), ("nan", {}), ("0", {}), ("-3", {})):
            os.environ["NORACU_OPEN_DEADLINE_EPOCH"] = raw
            assert cli._open_deadline_kwargs(now=now) == want, raw
        del os.environ["NORACU_OPEN_DEADLINE_EPOCH"]
        assert cli._open_deadline_kwargs(now=now) == {}
    finally:
        if saved is None:
            os.environ.pop("NORACU_OPEN_DEADLINE_EPOCH", None)
        else:
            os.environ["NORACU_OPEN_DEADLINE_EPOCH"] = saved


def test_open_stopped_goes_home():
    """A SIGTERM (SystemExit) during open propagates without a Home trip of its own (R18: that trip
    brought the mirror forward and sent a Cmd chord while the server may be stopping; after a timeout
    the server returns the phone to the Home Screen through the mirror's menu)."""
    import argparse
    from types import SimpleNamespace

    from imctl import cli

    homes = []

    def stopped(name, spotlight_open=True, **kw):
        raise SystemExit(143)

    real_live, real_gestures = cli._require_live, cli.gestures
    try:
        cli._require_live = lambda: None
        cli.gestures = SimpleNamespace(open_spotlight_checked=lambda: True, open_app=stopped,
                                       home_via_menu=lambda: homes.append(1) or True)
        try:
            cli._cmd_open(argparse.Namespace(app="Shopee"))
            assert False, "SystemExit must propagate"
        except SystemExit:
            pass
        assert homes == []
    finally:
        cli._require_live, cli.gestures = real_live, real_gestures


def test_tophit_labels():
    """NORACU_TOPHIT_LABELS supplies the Top Hit label of a non-English iPhone."""
    from imctl import gestures
    from imctl.vision import OCRHit

    assert gestures._tophit_labels(None) == ("top hit",)
    assert gestures._tophit_labels(" , ") == ("top hit",)
    assert gestures._tophit_labels("Top Hit, 最佳搜索结果") == ("top hit", "最佳搜索结果")
    saved = gestures.TOP_HIT_LABELS
    try:
        gestures.TOP_HIT_LABELS = gestures._tophit_labels("最佳搜索结果")
        frame = [OCRHit(text="最佳搜索结果", nx=0.2, ny=0.14, confidence=1.0),
                 OCRHit(text="拼多多", nx=0.17, ny=0.24, confidence=1.0)]
        assert gestures.choose_app_hit(frame, "拼多多").ny == 0.24
        # the English label no longer counts once a custom list is set
        eng = [OCRHit(text="Top Hit", nx=0.2, ny=0.14, confidence=1.0), frame[1]]
        assert gestures.choose_app_hit(eng, "拼多多") is None
    finally:
        gestures.TOP_HIT_LABELS = saved


def test_phone_shape_rules():
    """F37: elongated (≥ 1.7:1) either way is phone-shaped; near-square
    or a wide dialog is not; degenerate bounds say nothing."""
    from imctl import window

    B = window.WindowBounds
    assert window.is_phone_shaped(B(x=0, y=0, width=329, height=727)) is True   # portrait mirror
    assert window.is_phone_shaped(B(x=0, y=0, width=727, height=329)) is True   # landscape mirror
    assert window.is_phone_shaped(B(x=0, y=0, width=640, height=660)) is False  # welcome screen
    assert window.is_phone_shaped(B(x=0, y=0, width=400, height=680)) is True   # exactly 1.7
    assert window.is_phone_shaped(B(x=0, y=0, width=400, height=679)) is False
    assert window.is_phone_shaped(B(x=0, y=0, width=750, height=1334)) is True  # iPhone SE 16:9
    assert window.is_phone_shaped(B(x=0, y=0, width=800, height=520)) is False  # a wide dialog
    assert window.is_phone_shaped(B(x=0, y=0, width=0, height=660)) is None
    assert window.is_phone_shaped(B(x=0, y=0, width=640, height=0)) is None
    off = {"live": False, "overlay": "x", "buttons": 1}
    assert window.is_setup_screen(off, B(x=0, y=0, width=640, height=660)) is True
    assert window.is_setup_screen(off, B(x=0, y=0, width=0, height=0)) is False
    assert window.is_setup_screen({"live": True, "overlay": None, "buttons": 0},
                                  B(x=0, y=0, width=640, height=660)) is False
    assert window.is_setup_screen({"live": None, "overlay": None, "buttons": 0},
                                  B(x=0, y=0, width=640, height=660)) is False


def test_type_text_restore_needs_a_rise():
    """F41: for text of 2+ characters the default OCR check counts the text before
    the paste (the higher of two reads) and licenses a restore only on a RISE over
    that count, seen in two reads.

    Text already on screen (e.g. a search-history chip with the same query) used to
    license an immediate restore; a paste read late by the phone could then paste
    the user's ORIGINAL clipboard. Fully injected: pasteboard, chord, clock, frame
    diff and the screen reads.
    """
    from imctl import input as input_module, verify, vision
    from imctl.input import type_text
    from imctl.vision import CaptureError, OCRHit

    class Pasteboard:
        def __init__(self):
            self.data, self.count = b"orig", 7

        def dataForType_(self, _t):
            return self.data

        def changeCount(self):
            return self.count

        def clearContents(self):
            self.count += 1
            self.data = None

        def setString_forType_(self, s, _t):
            self.data = s.encode()

        def setData_forType_(self, d, _t):
            self.data = d

    def hits(*texts):
        return [OCRHit(text=t, nx=0.5, ny=0.1 + i * 0.05, confidence=0.9) for i, t in enumerate(texts)]

    def run(screens, *, frame_changes=False, restore=True, text="iPhone 17 Pro Max case"):
        """screens: what each vision.read_screen() call returns (an Exception raises)."""
        now = [0.0]
        reads = []

        def read(**kwargs):
            item = screens.pop(0)
            reads.append(kwargs)
            if isinstance(item, Exception):
                raise item
            return item

        real_read, real_front = vision.read_screen, input_module.ensure_frontmost
        vision.read_screen = read
        input_module.ensure_frontmost = lambda: None
        try:
            pb, report = Pasteboard(), {}
            ok = type_text(text, pasteboard=pb,
                           chord=lambda k, before_key=None: before_key and before_key(),
                           before_check=lambda: (lambda: frame_changes),
                           sleep=lambda s: now.__setitem__(0, now[0] + s),
                           clock=lambda: now[0], report=report, restore=restore)
        finally:
            vision.read_screen, input_module.ensure_frontmost = real_read, real_front
        return ok, pb, report, reads

    chip = "iPhone 17 Pro Max case"           # the same text, already on screen
    # ① already on screen before (count 1 in both pre-reads), still 1 after, no frame
    #    change: not confirmed, and the user's clipboard is NOT restored (it keeps the text)
    screens = [hits(chip), hits(chip), hits(chip)]
    ok, pb, report, reads = run(screens)
    assert ok is False and pb.data == chip.encode() and {k: v for k, v in report.items() if k != "seen"} == {"count_before": 1}
    assert screens == []  # two pre-reads; the first post-read already shows no rise
    #    …same, but the frame changed: landed, yet still no restore (no rise)
    ok, pb, report, _ = run([hits(chip), hits(chip), hits(chip)], frame_changes=True)
    assert ok is True and pb.data == chip.encode()
    # ② 0 before → 1 after, in two post-reads: the paste is seen → confirmed and restored
    screens = [hits("Search"), hits("Search"), hits(chip), hits(chip)]
    ok, pb, report, _ = run(screens)
    assert ok is True and pb.data == b"orig" and {k: v for k, v in report.items() if k != "seen"} == {"count_before": 0}
    assert screens == []
    #    1 before → 2 after: a rise over the chip → restored
    ok, pb, _, _ = run([hits(chip), hits(chip), hits(chip, chip), hits(chip, chip)])
    assert ok is True and pb.data == b"orig"
    # ③ a pre-paste read fails: count unknown → OCR never licenses a restore
    ok, pb, report, _ = run([CaptureError("blank"), hits(chip)])
    assert ok is False and pb.data == chip.encode() and {k: v for k, v in report.items() if k != "seen"} == {"count_before": None}
    ok, pb, report, _ = run([hits(chip), CaptureError("blank"), hits(chip)])
    assert ok is False and pb.data == chip.encode() and {k: v for k, v in report.items() if k != "seen"} == {"count_before": None}
    ok, pb, report, _ = run([CaptureError("blank"), hits(chip)], frame_changes=True)
    assert ok is True and pb.data == chip.encode()
    # ④ one pre-read misses the chip (a redraw): the count is the higher one, so the
    #    chip alone after the paste is no rise → no restore
    ok, pb, report, _ = run([hits("Search"), hits(chip), hits(chip)])
    assert ok is False and pb.data == chip.encode() and {k: v for k, v in report.items() if k != "seen"} == {"count_before": 1}
    # ⑤ a rise in only one post-read (an OCR blip) licenses nothing
    ok, pb, report, _ = run([hits("Search"), hits("Search"), hits(chip), hits("Search")])
    assert ok is False and pb.data == chip.encode() and {k: v for k, v in report.items() if k != "seen"} == {"count_before": 0}
    # ⑥ restore=False (open_app): a confirmed paste still never gives the clipboard back
    ok, pb, _, _ = run([hits("Search"), hits("Search"), hits(chip), hits(chip)], restore=False)
    assert ok is True and pb.data == chip.encode()
    # ⑦ (F44) the phone's "Pasting from …" box: its words never count as the text ("pro"
    #    is in "M5pro"), and while it shows nothing licenses a restore — a paste is still
    #    on its way and could fetch the restored clipboard
    box = "Pasting from “M5pro”…"
    ok, pb, report, _ = run([hits("Search"), hits("Search"), hits(box), hits(box)], text="pro")
    assert ok is False and pb.data == b"pro" and {k: v for k, v in report.items() if k != "seen"} == {"count_before": 0}
    #    the text itself rises while a box still shows (an earlier paste in flight): no restore
    ok, pb, _, _ = run([hits("Search"), hits("Search"), hits(chip, box), hits(chip, box)],
                       frame_changes=True)
    assert ok is True and pb.data == chip.encode()
    assert verify.probe_count("pro", hits(box)) == 0
    assert verify.probe_count("pro", hits("pro", box)) == 1
    # the probe helpers
    assert verify.text_probe("X") is None and verify.text_probe("ab") == "ab"
    assert verify.probe_count("hello", hits("say hello", "hello")) == 2
    assert verify.probe_count("X", hits("X")) is None


def test_paste_hud_probe():
    """F44: the phone's "Pasting from …" progress box is recognized in one OCR hit
    (any case, spacing or quotes around the Mac's name); nothing else counts."""
    from imctl import verify
    from imctl.vision import OCRHit

    def hits(*texts):
        return [OCRHit(text=t, nx=0.5, ny=0.4 + i * 0.05, confidence=0.9) for i, t in enumerate(texts)]

    assert verify.shows_paste_hud(hits("Pasting from “M5pro”..."))
    assert verify.shows_paste_hud(hits("Suggestions", "PASTING  FROM M5pro…", "Cancel"))
    assert verify.shows_paste_hud(["Pasting from x"])  # plain strings work too
    assert not verify.shows_paste_hud(hits("Cut", "Copy", "Paste", "noracu test 123"))
    assert not verify.shows_paste_hud(hits("Pasting", "from M5pro"))  # never joined across hits
    assert not verify.shows_paste_hud([])


def test_open_budget_spent_before_typing():
    """With the budget already spent, open_app neither clears nor types."""
    from imctl.gestures import open_app

    t = [100.0]
    calls = []
    res = open_app("Shopee", spotlight_open=True, read_screen=lambda **kw: [],
                   luma=lambda: b"\x00" * 10, sleep=lambda s: None,
                   tap=lambda x, y: calls.append("tap"),
                   home=lambda: calls.append("home") or True,
                   clear_text=lambda: calls.append("clear"),
                   type_text=lambda text: calls.append("type") or True,
                   clock=lambda: t[0], deadline_s=-1.0)
    assert res == "deadline" and calls == ["home"]
    # the caller learns whether the trip back to the Home Screen worked
    for went_home in (True, False):
        rep = {}
        res = open_app("Shopee", spotlight_open=True, read_screen=lambda **kw: [],
                       luma=lambda: b"\x00" * 10, sleep=lambda s: None,
                       tap=lambda x, y: None, home=lambda: went_home,
                       clear_text=lambda: None, type_text=lambda text: True,
                       clock=lambda: t[0], deadline_s=-1.0, report=rep)
        assert res == "deadline" and rep == {"home": went_home}


def test_open_app_keeps_the_clipboard():
    """F42: open_app's paste never gives the clipboard back (type_text restore=False)."""
    from imctl import gestures

    seen = {}
    real = gestures.inp.type_text
    try:
        gestures.inp.type_text = lambda text, **kw: seen.update(kw) or True
        res = gestures.open_app("Shopee", spotlight_open=True, read_screen=lambda **kw: [],
                                luma=lambda: b"\x00" * 10, sleep=lambda s: None,
                                tap=lambda x, y: None, home=lambda: True,
                                clear_text=lambda: None, deadline_s=None)
    finally:
        gestures.inp.type_text = real
    assert res == "not_typed" and seen.get("restore") is False  # the field never showed it


def test_home_via_menu_uses_short_timeouts():
    """The tidy-up Home bounds every osascript run — bringing the mirror to the front
    included — to TIDY_OSASCRIPT_TIMEOUT_S, and a frontmost check that times out falls
    through to the menu click instead of raising."""
    import subprocess

    from imctl import gestures

    seen = []
    real = (gestures._run_osascript, gestures.ensure_frontmost, gestures._view_menu_shortcut,
            gestures.inp._cmd_chord)
    try:
        def fake(script, args=None, timeout=10):
            seen.append(timeout)
            raise gestures.GestureError("no menu")
        gestures._run_osascript = fake
        gestures.ensure_frontmost = lambda timeout=10: seen.append(timeout)
        assert gestures.home_via_menu() is False
        assert len(seen) == 3  # shortcut read, frontmost, menu click
        assert all(x == gestures.TIDY_OSASCRIPT_TIMEOUT_S for x in seen)
        assert gestures.TIDY_OSASCRIPT_TIMEOUT_S <= 4.0

        front = []

        def flaky_front(timeout=10):
            front.append(timeout)
            if len(front) == 1:
                raise subprocess.TimeoutExpired(cmd="osascript", timeout=timeout)

        def no_chord(keycode):
            raise AssertionError("no chord after a failed frontmost check")
        gestures._view_menu_shortcut = lambda item, timeout=10: ("1", 0)
        gestures.inp._cmd_chord = no_chord
        gestures.ensure_frontmost = flaky_front
        gestures._run_osascript = lambda script, args=None, timeout=10: ""
        assert gestures.home_via_menu() is True
        assert front == [gestures.TIDY_OSASCRIPT_TIMEOUT_S] * 2
    finally:
        (gestures._run_osascript, gestures.ensure_frontmost, gestures._view_menu_shortcut,
         gestures.inp._cmd_chord) = real


def test_no_top_hit_message_with_custom_labels():
    """With NORACU_TOPHIT_LABELS set, the message names those labels."""
    import argparse
    import contextlib
    import io
    import os
    from types import SimpleNamespace

    from imctl import cli

    saved_env = os.environ.get("NORACU_TOPHIT_LABELS")
    real_live, real_gestures = cli._require_live, cli.gestures
    try:
        os.environ["NORACU_TOPHIT_LABELS"] = "最佳搜索结果"
        cli._require_live = lambda: None
        cli.gestures = SimpleNamespace(open_spotlight_checked=lambda: True,
                                       open_app=lambda name, spotlight_open=True, **kw: "no_top_hit",
                                       TOP_HIT_LABELS=("最佳搜索结果",),
                                       home_via_menu=lambda: True)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            assert cli._cmd_open(argparse.Namespace(app="拼多多")) == 1
        assert "'最佳搜索结果'" in out.getvalue() and "not set to English" not in out.getvalue()
    finally:
        if saved_env is None:
            os.environ.pop("NORACU_TOPHIT_LABELS", None)
        else:
            os.environ["NORACU_TOPHIT_LABELS"] = saved_env
        cli._require_live, cli.gestures = real_live, real_gestures


def test_type_text_restores_every_clipboard_item():
    """R13 §2: the user's clipboard goes back whole (every item and type);
    a concealed or transient item is never copied — the clipboard is
    cleared instead; Universal Clipboard content is not read and the
    clipboard keeps the typed text. Restores still need the on-screen
    evidence (injected here as ocr_check → True)."""
    import imctl.input as input_module
    from imctl.input import type_text

    class Item:
        def __init__(self, rec):
            self.rec = dict(rec)

        def types(self):
            return list(self.rec)

        def dataForType_(self, t):
            return self.rec.get(t)

        def setData_forType_(self, d, t):
            self.rec[t] = d

    class RichPasteboard:
        """Item-level fake of NSPasteboard: types() is the first item's."""

        def __init__(self, items, extra_types=()):
            self.items = [Item(r) for r in items]
            self.extra = list(extra_types)
            self.count = 7
            self.reads = 0

        def types(self):
            first = self.items[0].types() if self.items else []
            return first + self.extra

        def pasteboardItems(self):
            self.reads += 1
            return list(self.items)

        def dataForType_(self, t):
            return self.items[0].rec.get(t) if self.items else None

        def changeCount(self):
            return self.count

        def clearContents(self):
            self.count += 1
            self.items, self.extra = [], []

        def setString_forType_(self, s, t):
            self.items = [Item({t: s.encode()})]

        def setData_forType_(self, d, t):
            self.items = [Item({t: d})]

        def writeObjects_(self, objs):
            self.items = list(objs)
            return True

    def drive(pb):
        now = [1000.0]

        def chord(keycode, before_key=None):
            if before_key is not None:
                before_key()

        def sleep(s):
            now[0] += s

        def before_check():
            return lambda: True

        return type_text("hi there", pasteboard=pb, chord=chord, before_check=before_check,
                         ocr_check=lambda: True, hud_check=lambda: False,
                         sleep=sleep, clock=lambda: now[0])

    real_frontmost, real_new_item = input_module.ensure_frontmost, input_module._new_item
    input_module.ensure_frontmost = lambda: None
    input_module._new_item = lambda: Item({})
    try:
        # two items with several types each: all of it comes back
        orig = [{"public.utf8-plain-text": b"a", "public.html": b"<b>a</b>"}, {"public.file-url": b"file:///x"}]
        pb = RichPasteboard(orig)
        assert drive(pb) is True
        assert [i.rec for i in pb.items] == orig

        # a password manager's concealed item: never copied, cleared afterwards
        pb = RichPasteboard([{"public.utf8-plain-text": b"s3cret", "org.nspasteboard.ConcealedType": b""}])
        assert drive(pb) is True
        assert pb.items == []  # its items' types were read (to find the mark), never their data

        # R15: a concealed mark on the SECOND item (types() shows only the first item's)
        pb = RichPasteboard([{"public.utf8-plain-text": b"x"}, {"public.utf8-plain-text": b"s3cret", "org.nspasteboard.ConcealedType": b""}])
        assert drive(pb) is True
        assert pb.items == []

        # Universal Clipboard: not read, and the clipboard keeps the typed text
        pb = RichPasteboard([{"public.utf8-plain-text": b"from phone"}], extra_types=["com.apple.is-remote-clipboard"])
        assert drive(pb) is True
        assert pb.reads == 0
        assert [i.rec for i in pb.items] == [{"public.utf8-plain-text": b"hi there"}]

        # R15: a copy that lands while the clipboard is being saved is not overwritten
        class RacingPasteboard(RichPasteboard):
            def pasteboardItems(self):
                self.count += 1  # another app writes during the save
                return super().pasteboardItems()

        from imctl.input import ClipboardChanged
        pb = RacingPasteboard([{"public.utf8-plain-text": b"theirs"}])
        try:
            drive(pb)
            raise AssertionError("expected ClipboardChanged")
        except ClipboardChanged:
            pass
        assert [i.rec for i in pb.items] == [{"public.utf8-plain-text": b"theirs"}]
    finally:
        input_module.ensure_frontmost, input_module._new_item = real_frontmost, real_new_item


def test_iphone_gates_t06():
    """R13 §3 (t06): fail-closed _require_live without needless focus theft,
    _cmd_home / _cmd_app_switcher gated by _require_live, app_switcher + input
    down/up release in finally:, and `--` before free-text CLI positionals."""
    import contextlib
    import io
    from types import SimpleNamespace

    import imctl.input as input_module
    from imctl import cli, gestures, window
    from imctl.input import (
        FocusLost, _VK_COMMAND, _VK_DELETE, _VK_RETURN, _VK_V,
        _cmd_chord, clear_text, kCGEventLeftMouseDown, kCGEventLeftMouseDragged,
        kCGEventLeftMouseUp, long_press, press_key, swipe, tap,
    )
    from imctl.window import WindowBounds, WindowError

    saved = {}

    def patch(mod, name, value):
        if (mod, name) not in saved:
            saved[(mod, name)] = getattr(mod, name)
        setattr(mod, name, value)

    try:
        # ── 1. _require_live ──
        fronts, sleeps, overlays = [], [], []
        patch(cli, "_is_front", lambda: True)  # the R18 re-probe after a Space switch is tested separately
        patch(cli, "_bring_front", lambda: fronts.append(1))
        patch(cli, "sleep", lambda s: sleeps.append(s))
        patch(cli, "get_overlay", lambda: overlays.pop(0))

        # live False → 3 and _bring_front never called
        overlays[:] = [{"live": False, "overlay": "Connection Paused", "buttons": 1}]
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            assert cli._require_live() == 3
        assert fronts == [] and sleeps == []
        assert "mirror_not_live: Connection Paused" in err.getvalue()

        # live True → None and _bring_front called
        overlays[:] = [{"live": True, "overlay": None, "buttons": 0}]
        assert cli._require_live() is None
        assert fronts == [1] and sleeps == []

        # None then True → _bring_front, sleep 0.4 s, probe again → None
        fronts.clear(); sleeps.clear()
        overlays[:] = [
            {"live": None, "overlay": None, "buttons": 0},
            {"live": True, "overlay": None, "buttons": 0},
        ]
        assert cli._require_live() is None
        assert fronts == [1] and sleeps == [0.4] and overlays == []

        # None then False → 3 with mirror_not_live
        fronts.clear(); sleeps.clear()
        overlays[:] = [
            {"live": None, "overlay": None, "buttons": 0},
            {"live": False, "overlay": "iPhone in Use", "buttons": 0},
        ]
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            assert cli._require_live() == 3
        assert fronts == [1] and sleeps == [0.4]
        assert "mirror_not_live: iPhone in Use" in err.getvalue()

        # None then None → 3 with mirror_state_unknown on stderr
        fronts.clear(); sleeps.clear()
        overlays[:] = [
            {"live": None, "overlay": None, "buttons": 0},
            {"live": None, "overlay": None, "buttons": 0},
        ]
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            assert cli._require_live() == 3
        assert fronts == [1] and sleeps == [0.4]
        assert err.getvalue().strip().startswith("mirror_state_unknown:")
        assert "nothing was sent; retry, or call phone_status" in err.getvalue()

        # not running / no window at all → mirror_not_live without _bring_front
        for reason in ("not_running", "no_window"):
            fronts.clear(); sleeps.clear()
            overlays[:] = [{"live": None, "overlay": None, "buttons": 0, "reason": reason}]
            err = io.StringIO()
            with contextlib.redirect_stderr(err):
                assert cli._require_live() == 3
            assert fronts == [] and sleeps == []
            assert (err.getvalue().strip()
                    == "mirror_not_live: iPhone Mirroring is not running — call phone_launch first")

        # overlay_snapshot marks not_running / no_window only when no window exists anywhere
        patch(window, "_run_osascript", lambda *a, **k: (_ for _ in ()).throw(WindowError("no proc")))
        patch(window, "is_running", lambda: False)
        assert window.overlay_snapshot()[0].get("reason") == "not_running"
        patch(window, "is_running", lambda: True)
        assert "reason" not in window.overlay_snapshot()[0]
        patch(window, "_run_osascript", lambda *a, **k: "NO_WINDOW")
        patch(window, "get_window_info", lambda: None)
        assert window.overlay_snapshot()[0].get("reason") == "no_window"
        patch(window, "get_window_info", lambda: {"id": 9, "onscreen": False})
        assert "reason" not in window.overlay_snapshot()[0]

        # ── 2. _cmd_home & _cmd_app_switcher call _require_live() first ──
        gest_calls = []
        patch(cli, "gestures", SimpleNamespace(
            home=lambda: gest_calls.append("home"),
            app_switcher=lambda: gest_calls.append("app-switcher"),
        ))
        overlays[:] = [{"live": False, "overlay": "Connection Paused", "buttons": 1}]
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            assert cli._cmd_home(None) == 3
        assert gest_calls == []

        overlays[:] = [{"live": False, "overlay": "Connection Paused", "buttons": 1}]
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            assert cli._cmd_app_switcher(None) == 3
        assert gest_calls == []

        overlays[:] = [{"live": True, "overlay": None, "buttons": 0}]
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            assert cli._cmd_app_switcher(None) == 0
        assert gest_calls == ["app-switcher"]
        assert "sent" in out.getvalue() and "opened" not in out.getvalue()
    finally:
        for (mod, name), value in saved.items():
            setattr(mod, name, value)
        saved.clear()

    # ── 3. gestures.app_switcher + input down/up finally: release audit ──
    bounds = WindowBounds(0, 0, 100, 100)
    kinds = []
    focus = [True]
    drag_count = [0]
    fail_on_drag = [None]

    def fake_post(_tap, event):
        kind = event[0]
        kinds.append(kind)
        if kind == kCGEventLeftMouseDragged:
            drag_count[0] += 1
            if fail_on_drag[0] is not None and drag_count[0] == fail_on_drag[0]:
                raise RuntimeError("boom on 3rd drag")

    try:
        patch(gestures, "ensure_frontmost", lambda: None)
        patch(gestures, "get_bounds", lambda: bounds)
        patch(gestures, "time", SimpleNamespace(sleep=lambda _s: None))
        patch(input_module, "ensure_frontmost", lambda: None)
        patch(input_module, "get_bounds", lambda: bounds)
        patch(input_module, "_focus_check", lambda: focus[0])
        patch(input_module, "_source", lambda: "src")
        patch(input_module, "CGEventCreateMouseEvent", lambda src, kind, pos, btn: (kind, pos))
        patch(input_module, "CGEventPost", fake_post)
        patch(input_module, "time", SimpleNamespace(sleep=lambda _s: None))

        # CGEventPost raises on the 3rd drag event → mouse-up still posted
        fail_on_drag[0] = 3
        try:
            gestures.app_switcher()
            raise AssertionError("expected RuntimeError")
        except RuntimeError as exc:
            assert "3rd drag" in str(exc)
        assert kinds == [
            kCGEventLeftMouseDown,
            kCGEventLeftMouseDragged,
            kCGEventLeftMouseDragged,
            kCGEventLeftMouseDragged,
            kCGEventLeftMouseUp,
        ], kinds

        # _require_focus raising → nothing posted at all
        kinds.clear(); drag_count[0] = 0; fail_on_drag[0] = None
        focus[0] = False
        try:
            gestures.app_switcher()
            raise AssertionError("expected FocusLost")
        except FocusLost:
            pass
        assert kinds == []

        # SIGTERM (SystemExit) during sleep still posts the matching release event
        focus[0] = True
        recorded = []
        patch(input_module, "CGEventCreateKeyboardEvent", lambda src, code, down: ("kb", code, down))
        patch(input_module, "CGEventSetFlags", lambda event, flags: None)
        patch(input_module, "CGEventPost", lambda _tap, ev: recorded.append(ev))

        def sigterm_sleep(_s):
            raise SystemExit(143)

        patch(input_module, "time", SimpleNamespace(sleep=sigterm_sleep))

        for fn, expected in (
            (lambda: tap(0.5, 0.5), [kCGEventLeftMouseDown, kCGEventLeftMouseUp]),
            (lambda: long_press(0.5, 0.5), [kCGEventLeftMouseDown, kCGEventLeftMouseUp]),
            (lambda: swipe(0.5, 0.8, 0.5, 0.2), [kCGEventLeftMouseDown, kCGEventLeftMouseUp]),
        ):
            recorded.clear()
            try:
                fn()
                raise AssertionError("expected SystemExit")
            except SystemExit:
                pass
            assert [e[0] for e in recorded] == expected, recorded

        recorded.clear()
        try:
            press_key("return")
            raise AssertionError("expected SystemExit")
        except SystemExit:
            pass
        assert recorded == [("kb", _VK_RETURN, True), ("kb", _VK_RETURN, False)]

        # _cmd_chord interrupted after key-down releases both the key and Command
        sleeps_left = [1]

        def stop_on_second_sleep(_s):
            if sleeps_left[0] == 0:
                raise SystemExit(143)
            sleeps_left[0] -= 1

        patch(input_module, "time", SimpleNamespace(sleep=stop_on_second_sleep))
        recorded.clear()
        try:
            _cmd_chord(_VK_V)
            raise AssertionError("expected SystemExit")
        except SystemExit:
            pass
        assert recorded == [
            ("kb", _VK_COMMAND, True),
            ("kb", _VK_V, True),
            ("kb", _VK_V, False),
            ("kb", _VK_COMMAND, False),
        ], recorded

        # clear_text interrupted during Delete hold still releases Delete
        sleeps_left[0] = 4  # 3 sleeps in Cmd+A + 1 sleep between Cmd+A and Delete
        recorded.clear()
        try:
            clear_text()
            raise AssertionError("expected SystemExit")
        except SystemExit:
            pass
        assert recorded[-2:] == [("kb", _VK_DELETE, True), ("kb", _VK_DELETE, False)], recorded
    finally:
        for (mod, name), value in saved.items():
            setattr(mod, name, value)
        saved.clear()

    # ── 4. argparse accepts `--` before free-text positionals ──
    p = build_parser()
    a = p.parse_args(["find", "--", "--exact"])
    assert a.text == "--exact" and a.exact is False
    a = p.parse_args(["open", "--", "-DashApp"])
    assert a.app == "-DashApp"
    a = p.parse_args(["key", "--expect", "Home", "--", "return"])
    assert a.expect == "Home" and a.key == "return"
    assert p.parse_args(["longpress", "0.5", "0.5", "1.2"]).duration == 1.2
    assert cli._longpress_duration(p.parse_args(["longpress", "0.5", "0.5", "--duration", "1.5"])) == 1.5



def test_r18_live_recheck_stdin_and_durations():
    """R18: _require_live looks again after a Space switch; "-" reads type/find/open text from stdin;
    an invalid long-press / swipe duration sends no event at all."""
    import io
    import sys as _sys

    from imctl import cli
    import imctl.input as inp

    saved = (cli.get_overlay, cli._bring_front, cli._is_front, cli.sleep)
    try:
        seq = iter([{"live": True, "overlay": None}, {"live": False, "overlay": "Connection Paused"}])
        cli.get_overlay = lambda: next(seq)
        cli._is_front = lambda: False
        cli._bring_front = lambda: None
        cli.sleep = lambda s: None
        assert cli._require_live() == 3  # live before the switch, paused after it → refused

        cli.get_overlay = lambda: {"live": True, "overlay": None}
        cli._is_front = lambda: True
        brought = []
        cli._bring_front = lambda: brought.append(1)
        assert cli._require_live() is None and brought == [1]  # already in front: no second probe needed
    finally:
        cli.get_overlay, cli._bring_front, cli._is_front, cli.sleep = saved

    p = cli.build_parser()
    args = p.parse_args(["type", "--", "-"])
    real_stdin = _sys.stdin
    try:
        _sys.stdin = io.StringIO("s3cret text")
        cli._stdin_values(args)
    finally:
        _sys.stdin = real_stdin
    assert args.text == "s3cret text"

    posted = []
    real = (inp._mouse_event, inp.ensure_frontmost, inp.get_bounds)
    try:
        inp._mouse_event = lambda *a: posted.append(a[0])
        inp.ensure_frontmost = lambda *a, **k: None
        for bad in (-1, float("nan"), float("inf"), 0):
            try:
                inp.long_press(0.5, 0.5, bad)
                raise AssertionError("expected ValueError")
            except ValueError:
                pass
            try:
                inp.swipe(0.5, 0.8, 0.5, 0.2, duration_ms=bad)
                raise AssertionError("expected ValueError")
            except ValueError:
                pass
        assert posted == []
    finally:
        inp._mouse_event, inp.ensure_frontmost, inp.get_bounds = real


def test_r19_duration_before_focus_expect_tokens_and_capture_line():
    """R19: a bad long-press / swipe duration is refused before the mirror is brought forward (exit 2,
    "nothing was sent"); bool is not a duration; an --expect value that starts with "-" survives as one
    --expect=… token; a capture failure while checking --expect says nothing was sent."""
    import io
    import sys as _sys

    from imctl import cli
    import imctl.input as inp

    called = []
    saved = (cli._require_live, cli._require_expect)
    real_err = _sys.stderr
    try:
        cli._require_live = lambda: called.append("live")
        cli._require_expect = lambda a: called.append("expect")
        _sys.stderr = io.StringIO()
        p = cli.build_parser()
        assert cli._cmd_longpress(p.parse_args(["longpress", "0.5", "0.5", "0"])) == 2
        assert cli._cmd_swipe(p.parse_args(["swipe", "0.5", "0.8", "0.5", "0.2", "--ms", "10"])) == 2
        err = _sys.stderr.getvalue()
    finally:
        cli._require_live, cli._require_expect = saved
        _sys.stderr = real_err
    assert called == [] and err.count("invalid_args:") == 2 and "nothing was sent" in err

    try:
        inp._check_duration(True, 0.01, 10, "x")
        raise AssertionError("bool accepted as a duration")
    except ValueError:
        pass

    args = cli.build_parser().parse_args(["key", "--expect=--replace", "--", "return"])
    assert args.expect == "--replace"
    args = cli.build_parser().parse_args(["tap", "0.5", "0.5", "--expect=-h"])
    assert args.expect == "-h"

    def boom():
        raise cli.CaptureError("no pixels")
    real_err = _sys.stderr
    try:
        _sys.stderr = io.StringIO()
        ns = cli.build_parser().parse_args(["tap", "0.5", "0.5", "--expect=Settings"])
        assert cli._require_expect(ns, read_screen=boom, read_sweep=boom) == 7
        line = _sys.stderr.getvalue()
    finally:
        _sys.stderr = real_err
    assert line.startswith("capture_failed:") and "nothing was sent" in line


def test_device_run_frame_diff_alone_is_not_typed():
    """Device run 2026-11-06 (macOS 27.2, iOS 27): type_text confirmed a paste by the frame
    diff alone while the field never got the text. type_text now reports whether OCR saw
    the text; _cmd_type watches for it (multi-character text) or says it cannot read it
    back (one character), and never prints a bare "typed" without a sighting."""
    import argparse
    import contextlib
    import io

    from imctl import cli
    import imctl.input as inp

    # type_text: frame diff fired, OCR did not see the text, no paste box → True, seen False
    class PB:
        def __init__(self):
            self.n = 0
        def changeCount(self):
            return self.n
        def pasteboardItems(self):
            return []
        def types(self):
            return []
        def clearContents(self):
            self.n += 1
        def setString_forType_(self, s, t):
            pass
    real = (inp.ensure_frontmost, inp.save_pasteboard)
    try:
        inp.ensure_frontmost = lambda *a, **k: None
        inp.save_pasteboard = lambda pb: ("remote", None)
        report = {}
        ok = inp.type_text("hello world", pasteboard=PB(), chord=lambda vk, before_key=None: before_key and before_key(),
                           before_check=lambda: (lambda: True), ocr_check=lambda: False, hud_check=lambda: False,
                           sleep=lambda s: None, report=report)
        assert ok is True and report.get("seen") is False
        report = {}
        ok = inp.type_text("hello world", pasteboard=PB(), chord=lambda vk, before_key=None: before_key and before_key(),
                           before_check=lambda: (lambda: True), ocr_check=lambda: True, hud_check=lambda: False,
                           sleep=lambda s: None, report=report)
        assert ok is True and report.get("seen") is True
    finally:
        inp.ensure_frontmost, inp.save_pasteboard = real

    real = (cli._require_live, cli._require_expect, cli.input.type_text, cli._watch_late_paste)
    try:
        cli._require_live = lambda: None
        cli._require_expect = lambda args: None

        def frame_only(text, replace=False, report=None):
            report["count_before"] = 0
            report["seen"] = False
            return True
        cli.input.type_text = frame_only
        watched = []
        cli._watch_late_paste = lambda text, baseline=None: watched.append(baseline) or None
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            assert cli._cmd_type(argparse.Namespace(text="测试文本", replace=True, expect=None)) == 4
        assert watched == [0] and err.getvalue().startswith("type_not_confirmed:")
        cli._watch_late_paste = lambda text, baseline=None: 3.0
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            assert cli._cmd_type(argparse.Namespace(text="测试文本", replace=True, expect=None)) == 0
        assert "showed up late" in out.getvalue()
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            assert cli._cmd_type(argparse.Namespace(text="X", replace=False, expect=None)) == 0
        assert "OCR cannot read this text back" in out.getvalue()
    finally:
        (cli._require_live, cli._require_expect, cli.input.type_text,
         cli._watch_late_paste) = real

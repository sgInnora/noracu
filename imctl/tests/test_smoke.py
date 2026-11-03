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

    # ① the typed query echoes in the bottom search field (ny≈0.95) —
    #    only a result row above it (ny<0.88) counts; topmost row wins.
    hits = [hit("Calculator", 0.95), hit("Calculator", 0.30), hit("Calculator", 0.50)]
    assert choose_app_hit(hits, "Calculator").ny == 0.30
    # ② only the search field matches → nothing to tap
    assert choose_app_hit([hit("Calculator", 0.95)], "Calculator") is None
    # ③ case and surrounding whitespace don't matter
    assert choose_app_hit([hit(" calculator ", 0.40)], "Calculator").ny == 0.40
    assert choose_app_hit([hit("Calculator", 0.40)], "  CALCULATOR ").ny == 0.40
    # ④ partial matches are not the app
    assert choose_app_hit([hit("Calculator Pro", 0.30)], "Calculator") is None
    # no hits at all
    assert choose_app_hit([], "Calculator") is None


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

    # ① first read already has the row → returned at once, no sleep
    sleeps.clear()
    read = make_read([[hit("Calculator", 0.30)]])
    assert find_app_hit(read, "Calculator", sleep=fake_sleep).ny == 0.30
    assert len(read.calls) == 1 and sleeps == []

    # ② first read empty, second has the row → exactly one 1.0s sleep
    sleeps.clear()
    read = make_read([[], [hit("Calculator", 0.40)]])
    assert find_app_hit(read, "Calculator", sleep=fake_sleep).ny == 0.40
    assert len(read.calls) == 2 and sleeps == [1.0]

    # ③ only the bottom search field echoes the query (ny=0.95) →
    #    None after two reads, one sleep between them
    sleeps.clear()
    read = make_read([[hit("Calculator", 0.95)], [hit("Calculator", 0.95)]])
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
    for label in ("X", "x", "×", "X.", "Ｘ"):
        assert choose_app_hit([hit(label, 0.30)], "X").ny == 0.30, label
    # apps whose names merely contain or start with "x" don't match
    for other in ("Xcode", "X Corp", "Box"):
        assert choose_app_hit([hit(other, 0.30)], "X") is None, other
    # the search field echoing "X" at the bottom still doesn't count
    assert choose_app_hit([hit("X", 0.95)], "X") is None
    # several matching rows → the topmost (smallest ny) wins
    hits = [hit("X", 0.50), hit("×", 0.30), hit("X.", 0.40)]
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
    read = make_read([[], [hit("×", 0.30)]])
    assert find_app_hit(read, "X", sleep=fake_sleep).ny == 0.30
    assert read.calls == ["default", False] and sleeps == []

    # long names: read_screen never receives language_correction=False
    # and the read/sleep sequence matches the original behavior
    sleeps.clear()
    read = make_read([[], [hit("Settings", 0.40)]])
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
            home=home, home_settle_s=home_settle_s,
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
    res, taps, homes, sleeps, typed, cleared = run(
        screens=[[LABEL], [LABEL], []], lumas=[ZEROS, OPENED])
    assert res == "opened"
    assert taps == [(0.18, 0.27)]
    assert homes == [] and typed == ["X"] and cleared == [1]
    assert sleeps == [0.3, 1.5, 0.5, 1.0]

    # ② the label tap does nothing, the hit sits inside the Top Hit card
    #    (header above, < 0.15 away) → second tap at the icon position,
    #    confirmed → "opened"
    res, taps, homes, sleeps, *_ = run(
        screens=[[LABEL], [LABEL], [HEADER, LABEL], []],
        lumas=[ZEROS, UNCHANGED, ZEROS, OPENED])
    assert res == "opened"
    assert taps == [(0.18, 0.27), ICON]
    assert homes == []
    assert sleeps == [0.3, 1.5, 0.5, 1.0, 1.0]

    # ③ the label tap does nothing but the hit is NOT inside the Top Hit
    #    card → NO second tap, back on the Home Screen, "not_confirmed".
    #    Three ways to be outside the card: no header at all, the header
    #    below the hit, or the header too far above (≥ 0.15 away).
    for after in ([LABEL],                                 # no header
                  [LABEL, hit("Top Hit", 0.35, nx=0.18)],  # header below
                  [hit("Top Hit", 0.05, nx=0.18), LABEL]):  # ≥ 0.15 above
        res, taps, homes, *_ = run(
            screens=[[LABEL], [LABEL], after], lumas=[ZEROS, UNCHANGED])
        assert res == "not_confirmed"
        assert taps == [(0.18, 0.27)]  # the label tap only
        assert homes == [1]

    # ④ both taps do nothing → back on the Home Screen, "not_confirmed",
    #    exactly two taps (label, then icon)
    res, taps, homes, *_ = run(
        screens=[[LABEL], [LABEL], [HEADER, LABEL], [HEADER, LABEL]],
        lumas=[ZEROS, UNCHANGED, ZEROS, UNCHANGED])
    assert res == "not_confirmed"
    assert taps == [(0.18, 0.27), ICON]
    assert homes == [1]

    # ⑤ stability: the row moved between the two reads → the SECOND
    #    position is tapped (the third read agrees → it stands)
    moved = hit("X", 0.40, nx=0.30)
    res, taps, *_ = run(
        screens=[[LABEL], [moved], [moved], []], lumas=[ZEROS, OPENED])
    assert res == "opened"
    assert taps == [(0.30, 0.40)]

    #    …and when the third read moves again, the LAST one wins
    moved2 = hit("X", 0.45, nx=0.35)
    res, taps, *_ = run(
        screens=[[LABEL], [moved], [moved2], []], lumas=[ZEROS, OPENED])
    assert res == "opened"
    assert taps == [(0.35, 0.45)]

    # ⑥ a capture failure after the hit is found → "not_confirmed", no
    #    additional taps (the icon tap never happens)
    boom = CaptureError("could not capture the iPhone Mirroring window by id")
    res, taps, homes, *_ = run(
        screens=[[LABEL], [LABEL]], lumas=[ZEROS, boom])
    assert res == "not_confirmed"
    assert taps == [(0.18, 0.27)]  # the label tap only — never the icon
    assert homes == [1]

    #    …also when the stability read itself fails: nothing is tapped
    res, taps, homes, *_ = run(screens=[[LABEL], boom], lumas=[])
    assert res == "not_confirmed"
    assert taps == []
    assert homes == [1]

    # ⑦ no row ever matches → "not_found", back on the Home Screen,
    #    nothing tapped (a long name: exactly two find_app_hit reads)
    res, taps, homes, sleeps, *_ = run(
        name="Photos", screens=[[], []], lumas=[])
    assert res == "not_found"
    assert taps == [] and homes == [1]
    assert sleeps == [0.3, 1.5, 1.0]  # find_app_hit's between-passes delay

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
            ("not_found", 1, "app not found: 'X'", False),
            ("not_confirmed", 4,
             "open_not_confirmed: tapped 'X' in Spotlight but the app "
             "did not open; back on the Home Screen", True),
        ):
            cli.gestures = SimpleNamespace(
                open_spotlight_checked=lambda: True,
                open_app=lambda name, spotlight_open=True: result)
            args = p.parse_args(["open", "X"])
            out, err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                assert cli._cmd_open(args) == code
            assert (err.getvalue() if to_stderr else out.getvalue()).strip() == line
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
            bump_on_poll=False, before_check=None, raise_on_poll=None):
        """Drive type_text with fakes; returns (ok, pb, events, v_elapsed,
        ocr_calls).

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

        state["pb"], state["events"] = pb, events
        ok = type_text(text, replace=replace, pasteboard=pb, chord=chord,
                       before_check=before_check or scripted_before_check,
                       ocr_check=ocr_check,
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

        assert len(frontmost_calls) == 8  # one per run() above, never the real one
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

        # ── scroll_trackpad: re-check every 6 events ──
        # The user switches away once 6 events have gone out; the next
        # scheduled check stops the stream — exactly 6 events, no more.
        events.clear()
        focus[0] = True
        flip_at[0] = 6
        try:
            scroll_trackpad(-500)
            raise AssertionError("expected FocusLost")
        except FocusLost:
            pass
        assert len(events) == 6, events
        assert events[0][0] == "mouse"  # the positioning move
        assert all(e[0] == "scroll" for e in events[1:])
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
                          kwargs.get("sweep", False)))
            return screens[len(calls) - 1]

        read.calls = calls
        return read

    read = make_read([[], [], [hit("X", 0.30)]])
    assert find_app_hit(read, "X", sleep=lambda s: None).ny == 0.30
    assert read.calls == [("default", False), (False, False), (False, True)]
    # long names: never a sweep read
    read = make_read([[], [hit("Settings", 0.40)]])
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
        # the baseline sweep read could not capture: never restored, no further reads
        ok, pb, left = run([verify.WindowError("blank"), [X(0.2), X(0.6)]])
        assert ok and pb.data == b"X" and len(left) == 1
        # the screen never held still: no baseline read, no restore, no reads at all
        ok, pb, left = run([[X(0.2)], [X(0.2), X(0.6)], [X(0.2), X(0.6)]], still=False)
        assert ok and pb.data == b"X" and len(left) == 3
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

    # F32: the stability re-read of a short name also sweeps; it sees both
    # rows, the top one stays the target
    res, calls, taps = run("X", [[TOP], [TOP, SUGG], []])
    assert res == "opened" and taps == [(0.18, 0.27)]
    assert calls[1] == {"also_sweep": True}
    # long names keep the plain re-read
    res, calls, taps = run("Photos", [[hit("Photos", 0.27)], [hit("Photos", 0.27)], []])
    assert res == "opened" and calls[1] == {}

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

        def fake_type(text, pending=None):
            pending.append(Pending())
            return True

        patch(gestures.inp, "type_text", fake_type)
        screens, lumas = [[TOP], [TOP, SUGG], []], [ZEROS, OPENED]
        res = open_app("X", spotlight_open=True,
                       read_screen=lambda **kw: screens.pop(0),
                       luma=lambda: lumas.pop(0), sleep=lambda s: None,
                       tap=lambda x, y: None, home=lambda: True,
                       clear_text=lambda: None)
        assert res == "opened" and len(offers) == 3
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
                                       open_app=lambda name, spotlight_open=True: "opened")
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
            if text == "X":  # the pre-read happened before our write
                assert log.index("sweep") < log.index("write")
            else:
                assert "sweep" not in log
    finally:
        for (mod, name), value in saved.items():
            setattr(mod, name, value)

    # F33: an unseen paste gets a third find pass; a seen one keeps two
    TOP = OCRHit(text="X", nx=0.18, ny=0.27, confidence=0.9)
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
    res, left, homes = run(False, [[]] * 6 + [[TOP], [TOP], []])
    assert res == "opened" and left == [] and homes == []
    res, left, homes = run(True, [[]] * 6 + [[TOP], [TOP], []])
    assert res == "not_found" and len(left) == 3 and homes == [1]


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
        patch(window, "_run_osascript", lambda script, strip=True: answers.pop(0))
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
        # _require_live brings the mirror to the front before reading the overlay
        order = []
        patch(cli, "_bring_front", lambda: order.append("front"))
        patch(cli, "get_overlay",
              lambda: order.append("overlay") or {"live": True, "overlay": None, "buttons": 0})
        assert cli._require_live() is None and order == ["front", "overlay"]
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

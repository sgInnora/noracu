"""imctl CLI — control iPhone Mirroring from the command line.

Usage:
    imctl status                    # session + window info
    imctl tap 0.5 0.5               # tap center
    imctl longpress 0.5 0.5 1.0     # long-press center for 1s
    imctl swipe 0.5 0.8 0.5 0.2     # swipe up
    imctl home                      # home gesture
    imctl app-switcher              # app switcher
    imctl scroll down 0.5           # scroll down half a screen
    imctl page left                 # next home page
    imctl type "hello world"        # type text (clipboard-based)
    imctl key return                # press a key
    imctl ocr                       # OCR the screen
    imctl find "Settings"           # find text on screen
    imctl open "Photos"             # open app via Spotlight
    imctl verify home               # run a gesture with verification
"""

from __future__ import annotations

import argparse
import json
import sys

from . import gestures, input, verify, vision
from .window import WindowError


def _cmd_status(_args) -> int:
    print(json.dumps(gestures.status(), indent=2))
    return 0


def _cmd_tap(args) -> int:
    input.tap(args.x, args.y)
    print(f"tapped ({args.x}, {args.y})")
    return 0


def _cmd_longpress(args) -> int:
    input.long_press(args.x, args.y, args.duration)
    print(f"long-pressed ({args.x}, {args.y}) for {args.duration}s")
    return 0


def _cmd_swipe(args) -> int:
    input.swipe(args.fx, args.fy, args.tx, args.ty, args.ms)
    print(f"swiped ({args.fx},{args.fy}) -> ({args.tx},{args.ty})")
    return 0


def _cmd_home(_args) -> int:
    gestures.home()
    print("home gesture sent")
    return 0


def _cmd_app_switcher(_args) -> int:
    gestures.app_switcher()
    print("app switcher opened")
    return 0


def _cmd_scroll(args) -> int:
    if args.direction == "down":
        gestures.scroll_down(args.distance)
    else:
        gestures.scroll_up(args.distance)
    print(f"scrolled {args.direction} {args.distance}")
    return 0


def _cmd_page(args) -> int:
    if args.direction == "left":
        gestures.page_left()
    else:
        gestures.page_right()
    print(f"paged {args.direction}")
    return 0


def _cmd_type(args) -> int:
    input.type_text(args.text)
    print(f"typed {args.text!r}")
    return 0


def _cmd_key(args) -> int:
    input.press_key(args.key)
    print(f"pressed {args.key}")
    return 0


def _cmd_ocr(_args) -> int:
    hits = gestures.read_text()
    for h in hits:
        print(h)
    print(f"-- {len(hits)} hits")
    return 0


def _cmd_find(args) -> int:
    hit = vision.find(args.text, exact=args.exact)
    if hit is None:
        print(f"not found: {args.text!r}", file=sys.stderr)
        return 1
    print(hit)
    return 0


def _cmd_open(args) -> int:
    ok = gestures.open_app(args.app)
    print(f"opened {args.app!r}" if ok else f"app not found: {args.app!r}")
    return 0 if ok else 1


def _cmd_verify(args) -> int:
    actions = {
        "home": gestures.home,
        "app-switcher": gestures.app_switcher,
        "page-left": gestures.page_left,
        "page-right": gestures.page_right,
    }
    if args.action not in actions:
        print(f"unknown action: {args.action}", file=sys.stderr)
        return 2
    ok = verify.verify_action(actions[args.action])
    print("screen changed: yes" if ok else "screen changed: NO (action may have been dropped)")
    return 0 if ok else 1


def _cmd_launch(_args) -> int:
    gestures.launch()
    print("iPhone Mirroring ready")
    return 0


def _cmd_screenshot(args) -> int:
    path = vision.capture_window(args.path)
    print(path)
    return 0


def _cmd_resume(_args) -> int:
    ok = gestures.resume()
    print("resumed" if ok else "still paused (unlock the iPhone, then retry)")
    return 0 if ok else 1


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="imctl",
        description="Control iPhone Mirroring on macOS from the CLI",
    )
    sub = p.add_subparsers(dest="command", required=True)

    sub.add_parser("status", help="show session status").set_defaults(func=_cmd_status)
    sp = sub.add_parser("screenshot", help="capture the mirroring window to PNG (by window id, works when covered)")
    sp.add_argument("path", nargs="?", default=None)
    sp.set_defaults(func=_cmd_screenshot)
    sub.add_parser("resume", help="click Resume when the session shows Connection Paused").set_defaults(func=_cmd_resume)
    sub.add_parser("launch", help="ensure mirroring is running and frontmost").set_defaults(func=_cmd_launch)

    sp = sub.add_parser("tap", help="tap at normalized coords")
    sp.add_argument("x", type=float)
    sp.add_argument("y", type=float)
    sp.set_defaults(func=_cmd_tap)

    sp = sub.add_parser("longpress", help="long-press at normalized coords")
    sp.add_argument("x", type=float)
    sp.add_argument("y", type=float)
    sp.add_argument("--duration", type=float, default=0.8)
    sp.set_defaults(func=_cmd_longpress)

    sp = sub.add_parser("swipe", help="swipe between two normalized points")
    sp.add_argument("fx", type=float)
    sp.add_argument("fy", type=float)
    sp.add_argument("tx", type=float)
    sp.add_argument("ty", type=float)
    sp.add_argument("--ms", type=int, default=300)
    sp.set_defaults(func=_cmd_swipe)

    sub.add_parser("home", help="home gesture").set_defaults(func=_cmd_home)
    sub.add_parser("app-switcher", help="open app switcher").set_defaults(func=_cmd_app_switcher)

    sp = sub.add_parser("scroll", help="scroll up/down")
    sp.add_argument("direction", choices=["up", "down"])
    sp.add_argument("distance", type=float, nargs="?", default=0.5)
    sp.set_defaults(func=_cmd_scroll)

    sp = sub.add_parser("page", help="page left/right on home screen")
    sp.add_argument("direction", choices=["left", "right"])
    sp.set_defaults(func=_cmd_page)

    sp = sub.add_parser("type", help="type text (clipboard-based, IME-safe)")
    sp.add_argument("text")
    sp.set_defaults(func=_cmd_type)

    sp = sub.add_parser("key", help="press a key (return/delete/up/down/left/right)")
    sp.add_argument("key")
    sp.set_defaults(func=_cmd_key)

    sub.add_parser("ocr", help="OCR the screen").set_defaults(func=_cmd_ocr)

    sp = sub.add_parser("find", help="find text on screen")
    sp.add_argument("text")
    sp.add_argument("--exact", action="store_true")
    sp.set_defaults(func=_cmd_find)

    sp = sub.add_parser("open", help="open an app via Spotlight")
    sp.add_argument("app")
    sp.set_defaults(func=_cmd_open)

    sp = sub.add_parser("verify", help="run a gesture and verify the screen changed")
    sp.add_argument("action", choices=["home", "app-switcher", "page-left", "page-right"])
    sp.set_defaults(func=_cmd_verify)

    return p


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except WindowError as exc:
        print(f"window error: {exc}", file=sys.stderr)
        return 3
    except input.InputError as exc:
        print(f"input error: {exc}", file=sys.stderr)
        return 4


if __name__ == "__main__":
    sys.exit(main())

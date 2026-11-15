#!/usr/bin/env python3
"""Record the iPhone demo GIF for the README (docs/demo-phone.gif).

Drives noracu's own MCP server over stdio — the same JSON-RPC an MCP client sends — while a
background thread captures the iPhone Mirroring window by window id (`screencapture -l`, so the
frames are the mirror's own pixels). Each output frame is composed with a log of the tool calls
and encoded to a GIF with ffmpeg. The tap targets come from phone_find / phone_ocr results.

Dev-only; not shipped in the npm package. Needs:
  - macOS with iPhone Mirroring connected, the iPhone LOCKED and near the Mac
  - Calculator open on the mirror, showing 0
  - a Focus mode (e.g. Do Not Disturb) on the iPhone so no notification enters the recording
  - python3 with Pillow and pyobjc (the same python noracu uses for the iPhone layer), ffmpeg

Usage: python3 demo/record-phone.py [out.gif]
Review every frame before publishing: the recording shows whatever the phone shows.
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "docs" / "demo-phone.gif"
FPS = 6
PHONE_H = 600
PANEL_W = 470
MONO = "/System/Library/Fonts/Menlo.ttc"
SANS = "/System/Library/Fonts/Helvetica.ttc"
BG, FG, DIM, ACC, OK, ERR = (17, 19, 24), (232, 234, 237), (140, 146, 156), (122, 162, 247), (125, 200, 140), (240, 120, 120)


class Server:
    """Minimal MCP stdio client for noracu's server."""

    def __init__(self) -> None:
        self.p = subprocess.Popen(
            ["node", str(ROOT / "src" / "server.mjs")],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1,
        )
        self.n = 0
        self.rpc("initialize", {})

    def rpc(self, method: str, params: dict) -> dict:
        self.n += 1
        self.p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": self.n, "method": method, "params": params}) + "\n")
        self.p.stdin.flush()
        while True:
            line = self.p.stdout.readline()
            if not line:
                raise RuntimeError("noracu server exited")
            msg = json.loads(line)
            if msg.get("id") == self.n:
                return msg

    def call(self, name: str, args: dict | None = None) -> tuple[str, bool]:
        res = self.rpc("tools/call", {"name": name, "arguments": args or {}})["result"]
        text = "".join(c.get("text", "") for c in res.get("content", []) if c.get("type") == "text")
        return text, bool(res.get("isError"))

    def close(self) -> None:
        self.p.kill()


class Recorder(threading.Thread):
    def __init__(self, window_id: int, folder: Path) -> None:
        super().__init__(daemon=True)
        self.wid, self.dir, self.frames, self.stop = window_id, folder, [], False

    def run(self) -> None:
        i = 0
        while not self.stop:
            f = self.dir / f"raw_{i:05d}.png"
            t = time.time()
            r = subprocess.run(["screencapture", "-x", "-o", "-l", str(self.wid), str(f)], capture_output=True)
            if r.returncode == 0 and f.exists() and f.stat().st_size > 0:
                self.frames.append((t, f))
                i += 1
            time.sleep(0.04)


HIT = re.compile(r"\(([\d.]+),([\d.]+)\)\s+'([^']*)'")


def hits(text: str) -> list[tuple[float, float, str]]:
    return [(float(x), float(y), s) for x, y, s in HIT.findall(text)]


def one_line(s: str, n: int) -> str:
    s = " ".join(s.split())
    return s if len(s) <= n else s[: n - 1] + "…"


def main() -> int:
    if shutil.which("ffmpeg") is None:
        print("ffmpeg not found", file=sys.stderr)
        return 2
    srv = Server()
    events: list[dict] = []

    def step(name: str, args: dict | None = None, show: str | None = None, pause: float = 0.7) -> tuple[str, bool]:
        ev = {"t0": time.time(), "call": f"{name} {json.dumps(args, ensure_ascii=False)}" if args else name}
        events.append(ev)
        text, err = srv.call(name, args)
        ev.update(t1=time.time(), err=err, text=text, show=show(text) if callable(show) else (show or one_line(text, 52)))
        time.sleep(pause)
        return text, err

    try:
        st, err = srv.call("phone_status")
        if err:
            print("phone_status failed:", st, file=sys.stderr)
            return 1
        info = json.loads(st)
        if not info.get("window_id"):
            print("no mirror window id:", st, file=sys.stderr)
            return 1
        tmp = Path(tempfile.mkdtemp(prefix="noracu-demo-"))
        rec = Recorder(int(info["window_id"]), tmp)
        rec.start()
        time.sleep(1.0)

        def status_show(t: str) -> str:
            try:
                j = json.loads(t)
                return f"running: {str(j.get('running')).lower()} · live: {str(j.get('live')).lower()} · paused: {str(j.get('paused')).lower()}"
            except Exception:
                return one_line(t, 52)

        step("phone_launch")
        step("phone_status", show=status_show)
        ocr, _ = step("phone_ocr", show=lambda t: f"{len(hits(t))} text regions on the phone screen")
        pos = {s.strip(): (x, y) for x, y, s in hits(ocr)}

        def locate(label: str) -> tuple[float, float] | None:
            text, err = step("phone_find", {"text": label}, show=lambda t: one_line(t.splitlines()[0] if t else t, 52))
            h = hits(text) if not err else []
            return (h[0][0], h[0][1]) if h else None

        def tap(xy: tuple[float, float]) -> None:
            step("phone_tap", {"x": round(xy[0], 3), "y": round(xy[1], 3)}, pause=0.6)

        p7 = locate("7")
        p8 = locate("8")
        if not (p7 and p8):
            print("could not find 7/8 on screen — is Calculator open?", file=sys.stderr)
            return 1
        tap(p7)
        plus = locate("+")
        if plus is None and all(k in pos for k in ("9", "1")):
            plus = (pos["9"][0] + (pos["9"][0] - pos["8"][0]) if "8" in pos else pos["9"][0] + 0.22, pos["1"][1])
        if plus is None:
            print("could not locate '+'", file=sys.stderr)
            return 1
        tap(plus)
        tap(p8)
        eq = locate("=")
        if eq is None and all(k in pos for k in ("1", "4")):
            eq = (plus[0], pos["1"][1] + (pos["1"][1] - pos["4"][1]))
        if eq is None:
            print("could not locate '='", file=sys.stderr)
            return 1
        tap(eq)
        step("phone_ocr", show=lambda t: next((f"display reads {s}" for x, y, s in hits(t) if s.strip() == "15"), one_line(t, 52)), pause=2.2)
        rec.stop = True
        rec.join(timeout=3)
    finally:
        srv.close()

    if not rec.frames:
        print("no frames captured", file=sys.stderr)
        return 1
    return encode(rec.frames, events, tmp)


def encode(frames: list, events: list[dict], tmp: Path) -> int:
    mono, mono_s = ImageFont.truetype(MONO, 15), ImageFont.truetype(MONO, 13)
    title, sub = ImageFont.truetype(SANS, 19), ImageFont.truetype(SANS, 13)
    first = Image.open(frames[0][1])
    pw = round(first.width * PHONE_H / first.height)
    W, H = pw + 48 + PANEL_W, PHONE_H + 40
    t_start, t_end = events[0]["t0"] - 0.4, events[-1].get("t1", events[-1]["t0"]) + 2.2
    n = int((t_end - t_start) * FPS)
    k = 0
    for i in range(n):
        t = t_start + i / FPS
        while k + 1 < len(frames) and frames[k + 1][0] <= t:
            k += 1
        phone = Image.open(frames[k][1]).convert("RGB").resize((pw, PHONE_H), Image.LANCZOS)
        img = Image.new("RGB", (W, H), BG)
        img.paste(phone, (20, 20))
        d = ImageDraw.Draw(img)
        x0 = pw + 44
        d.text((x0, 22), "noracu · iPhone layer (experimental)", font=title, fill=FG)
        d.text((x0, 48), "MCP tool calls → iPhone Mirroring · scripted demo", font=sub, fill=DIM)
        y = 82
        shown = [e for e in events if e["t0"] <= t][-9:]
        for e in shown:
            done = "t1" in e and e["t1"] <= t
            d.text((x0, y), "› " + one_line(e["call"], 46), font=mono, fill=ACC if not done else FG)
            y += 21
            if done:
                d.text((x0 + 16, y), one_line(e["show"], 50), font=mono_s, fill=ERR if e.get("err") else OK)
            else:
                d.text((x0 + 16, y), "…", font=mono_s, fill=DIM)
            y += 34
        img.save(tmp / f"comp_{i:05d}.png")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    vf = "split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle"
    r = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(FPS), "-i", str(tmp / "comp_%05d.png"),
                        "-vf", vf, "-loop", "0", str(OUT)])
    log = [{k2: v for k2, v in e.items() if k2 in ("call", "show", "err")} for e in events]
    (tmp / "events.json").write_text(json.dumps(log, indent=1, ensure_ascii=False))
    print(f"{OUT} · {OUT.stat().st_size // 1024} KB · {n} frames @ {FPS} fps · raw {len(frames)} · work dir {tmp}")
    return r.returncode


if __name__ == "__main__":
    sys.exit(main())

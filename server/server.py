import os
import re
import tempfile

_here = os.path.dirname(os.path.abspath(__file__))
# keep model cache and scratch temp off C: (it's full); the .bat launcher
# sets these too, but the tray launcher relies on the defaults here
os.environ.setdefault("HF_HOME", os.path.join(_here, "hf-cache"))
if os.name == "nt":
    _tmp = os.path.join(_here, "pip-temp")
    os.makedirs(_tmp, exist_ok=True)
    os.environ["TMP"] = _tmp
    os.environ["TEMP"] = _tmp
from contextlib import asynccontextmanager
from io import BytesIO

import numpy as np
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

state = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    import torch
    from mokuro.manga_page_ocr import MangaPageOcr

    state["device"] = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"Loading models on {state['device']} (first run downloads ~400MB)...")
    # default 1024 crushes small text on hi-res screenshots before detection
    state["mpocr"] = MangaPageOcr(
        force_cpu=state["device"] == "cpu",
        detector_input_size=2048,
    )
    print("Models loaded. Ready.")
    yield


app = FastAPI(lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# The detector's line quads can be shifted by up to a full column (varies
# with capture resolution), but its BLOCK boxes are reliable. So re-derive
# the line boxes from the ink itself: project ink density across the block,
# segment into bands (wide = text column, narrow = furigana -> dropped),
# and pair bands with the OCR lines in reading order. Returns a list of
# [x1,y1,x2,y2] aligned with quads, or None to fall back to per-line snap.
def refine_block_lines(gray, box, quads, vertical):
    H, W = gray.shape
    x1, y1, x2, y2 = (int(round(v)) for v in box)
    pad_x = max(2, (x2 - x1) // 30)
    pad_y = max(2, (y2 - y1) // 30)
    ex1, ey1 = max(0, x1 - pad_x), max(0, y1 - pad_y)
    ex2, ey2 = min(W, x2 + pad_x), min(H, y2 + pad_y)
    reg = gray[ey1:ey2, ex1:ex2]
    if reg.size == 0:
        return None, "empty region"
    lo, hi = int(reg.min()), int(reg.max())
    if hi - lo < 40:
        return None, "low contrast"
    ink = reg < (lo + hi) / 2
    if ink.mean() > 0.5:  # white-on-black text: flip polarity
        ink = ~ink

    # panel/caption borders are straight lines crossing nearly the whole
    # region; they pollute every band's profile and span. Text never fills
    # >80% of a full row/column, so erase those lines outright.
    full_rows = ink.mean(axis=1) > 0.8
    full_cols = ink.mean(axis=0) > 0.8
    ink[full_rows, :] = False
    ink[:, full_cols] = False

    profile = ink.mean(axis=0) if vertical else ink.mean(axis=1)
    # an erased border line leaves a zeroed row/col that reads as a fake
    # 1px gap and derails band splitting — bridge it with its neighbors
    erased = full_cols if vertical else full_rows
    if erased.any() and not erased.all():
        pos = np.arange(profile.size)
        profile[erased] = np.interp(pos[erased], pos[~erased], profile[~erased])
    if not np.any(profile >= 0.02):
        return None, "no ink"
    # sub-4px gaps don't split a band (thin white slivers inside a column),
    # but tiny low-res text has real inter-column gaps under 4px too — if we
    # find fewer bands than lines, retry with tighter gap closing. Touching
    # columns whose anti-aliasing bleeds ink into the gap never dip below the
    # base threshold at all, so also retry with higher thresholds: the valley
    # between them is shallow but real.
    bands = []
    for tf in (0.08, 0.2, 0.35):
        t = max(float(profile.max()) * tf, 0.02)
        idx = np.flatnonzero(profile >= t)
        if idx.size == 0:
            break
        enough = False
        for gap in (4, 3, 2, 1):
            runs = np.split(idx, np.flatnonzero(np.diff(idx) > gap) + 1)
            got = [(int(r[0]), int(r[-1]) + 1) for r in runs if r[-1] + 1 - r[0] >= 3]
            # base threshold keeps its result even when short (widest bands);
            # higher thresholds only win by actually reaching the line count
            if tf == 0.08:
                bands = got
            if len(got) >= len(quads):
                bands = got
                enough = True
                break
        if enough:
            break
    if not bands:
        return None, "no bands"
    # furigana/noise bands are much narrower than the text columns around
    # them; compare against the MEDIAN width (max is unreliable — a column
    # that merges with its own furigana or brackets can be ~2x normal)
    med = sorted(b1 - b0 for b0, b1 in bands)[len(bands) // 2]
    main = [b for b in bands if (b[1] - b[0]) >= med * 0.5]
    # real text columns are near-uniform width; wildly uneven bands mean the
    # ink profile is polluted (text over artwork) and can't be trusted
    widths = [b1 - b0 for b0, b1 in main]
    if max(widths) > 3 * min(widths):
        return None, f"uneven widths {widths}"

    def band_box(b0, b1, w0=None, w1=None):
        span = ink[:, b0:b1].mean(axis=1) if vertical else ink[b0:b1, :].mean(axis=0)
        st = max(float(span.max()) * 0.1, 0.02)
        on = np.flatnonzero(span >= st)
        if w0 is not None:
            on = on[(on >= w0) & (on <= w1)]
        if on.size == 0:
            return None
        s0, s1 = int(on[0]), int(on[-1]) + 1
        if vertical:
            return [ex1 + b0, ey1 + s0, ex1 + b1, ey1 + s1]
        return [ex1 + s0, ey1 + b0, ex1 + s1, ey1 + b1]

    if len(main) == len(quads):
        # counts agree: pair by reading order. Robust against quads shifted a
        # full column sideways, which overlap-matching would misassign.
        ordered = sorted(main, key=lambda b: -b[0] if vertical else b[0])
        order = sorted(
            range(len(quads)),
            key=lambda i: -max(p[0] for p in quads[i]) if vertical else min(p[1] for p in quads[i]),
        )
        pairs = [(li, b, None, None) for li, b in zip(order, ordered)]
        why = "ok"
    else:
        # detector emitted duplicate/phantom lines (or bands merged): give
        # each quad the band it overlaps most; window each span to the quad's
        # own extent so side-by-side lines sharing a band keep separation
        off = ex1 if vertical else ey1
        soff = ey1 if vertical else ex1
        cand = []
        for i, q in enumerate(quads):
            ax = [(p[0] if vertical else p[1]) - off for p in q]
            q0, q1 = min(ax), max(ax)
            best = max(range(len(main)), key=lambda j: min(q1, main[j][1]) - max(q0, main[j][0]))
            if min(q1, main[best][1]) - max(q0, main[best][0]) <= 0:
                best = min(
                    range(len(main)),
                    key=lambda j: abs((main[j][0] + main[j][1]) / 2 - (q0 + q1) / 2),
                )
            sp = [(p[1] if vertical else p[0]) - soff for p in q]
            cand.append((i, best, min(sp), max(sp), q0, q1))
        pairs = []
        dropped = 0
        for j in range(len(main)):
            group = [c for c in cand if c[1] == j]
            # touching columns merge into one ink band (furigana bridges every
            # gap), but the quads still know each column's position. Cluster
            # quads by band-axis overlap: true duplicates overlap in x, side-
            # by-side columns don't — never dup-drop across clusters.
            clusters = []
            for c in sorted(group, key=lambda c: c[4]):
                for cl in clusters:
                    if min(c[5], cl[1]) - max(c[4], cl[0]) > 0.5 * max(
                        min(c[5] - c[4], cl[1] - cl[0]), 1
                    ):
                        cl[0] = min(cl[0], c[4])
                        cl[1] = max(cl[1], c[5])
                        cl[2].append(c)
                        break
                else:
                    clusters.append([c[4], c[5], [c]])
            b0, b1 = main[j]
            if len(clusters) > 1:
                # carve the band into one sub-band per column
                subs = [
                    [max(b0, min(int(c0), b1 - 3)), min(b1, max(int(c1), b0 + 3))]
                    for c0, c1, _ in clusters
                ]
                # real columns sharing a band are near-uniform width; a much
                # narrower carve is a furigana strip or phantom quad, and
                # re-OCR of a few-px sliver hallucinates whole sentences
                ws = sorted(s1 - s0 for s0, s1 in subs)
                medw = ws[len(ws) // 2]
                thin = [k for k in range(len(subs)) if subs[k][1] - subs[k][0] < 0.5 * medw]
                for k in thin:
                    dropped += len(clusters[k][2])
                clusters = [cl for k, cl in enumerate(clusters) if k not in thin]
                subs = [s for k, s in enumerate(subs) if k not in thin]
                if len(clusters) == 1:
                    subs = [[b0, b1]]
                for a, b2 in zip(subs, subs[1:]):
                    if b2[0] < a[1]:
                        mid = (b2[0] + a[1]) // 2
                        a[1] = mid
                        b2[0] = mid
            else:
                subs = [[b0, b1]]
            for (_, _, members), sub in zip(clusters, subs):
                # duplicates overlap along the span axis too; keep the
                # longest, drop the rest (stacked ghost text breaks selection)
                kept = []
                band_pairs = []
                for i, _, s0, s1, _, _ in sorted(members, key=lambda c: c[2] - c[3]):
                    if any(
                        min(s1, k1) - max(s0, k0) > 0.5 * max(min(s1 - s0, k1 - k0), 1)
                        for k0, k1 in kept
                    ):
                        dropped += 1
                        continue
                    kept.append((s0, s1))
                    m = (sub[1] - sub[0]) // 2
                    band_pairs.append([i, tuple(sub), s0 - m, s1 + m])
                # neighbours sharing a column must not overlap, or their
                # invisible texts stack in the overlap zone; split at midpoint
                band_pairs.sort(key=lambda p: p[2])
                for a, b2 in zip(band_pairs, band_pairs[1:]):
                    if b2[2] < a[3]:
                        mid = (b2[2] + a[3]) // 2
                        a[3] = mid
                        b2[2] = mid
                pairs.extend(band_pairs)
        why = f"ok (overlap-matched, {len(main)} bands / {len(quads)} lines, {dropped} dups dropped)"

    out = [None] * len(quads)
    for li, b, w0, w1 in pairs:
        bb = band_box(b[0], b[1], w0, w1)
        if bb is None:
            return None, "empty span"
        out[li] = bb
    return out, why


def plain(v):  # mokuro returns numpy scalars/arrays, which break JSON
    if isinstance(v, (np.ndarray, np.generic)):
        return v.tolist()
    if isinstance(v, (list, tuple)):
        return [plain(x) for x in v]
    return v


REV = "2026-07-06.12"


@app.get("/health")
def health():
    return {
        "status": "ok" if "mpocr" in state else "loading",
        "device": state.get("device", "unknown"),
        "rev": REV,
    }


def trim_margins(rgb):
    """Bounding box of non-uniform content, as (x, y, w, h).

    Viewer spreads with a blank half (letterboxed bonus pages) waste the
    detector's fixed input resolution on dead space, which measurably
    degrades its line quads. Trim near-constant margins before detection
    and offset the results back afterwards.
    """
    g = np.asarray(rgb.convert("L")).astype(np.int16)
    h, w = g.shape
    border = np.concatenate([g[0, :], g[-1, :], g[:, 0], g[:, -1]])
    bg = int(np.median(border))
    content = np.abs(g - bg) > 32
    # specks are not content: two stacked corner fiducials share a row/col
    # and add up to ~16px, so the floor must clear that comfortably
    rows = content.sum(axis=1) > max(24, w // 50)
    cols = content.sum(axis=0) > max(24, h // 50)
    if not rows.any() or not cols.any():
        return 0, 0, w, h
    y1, y2 = np.flatnonzero(rows)[[0, -1]]
    x1, x2 = np.flatnonzero(cols)[[0, -1]]
    pad = 8
    x1 = max(0, int(x1) - pad)
    y1 = max(0, int(y1) - pad)
    x2 = min(w, int(x2) + 1 + pad)
    y2 = min(h, int(y2) + 1 + pad)
    if (x2 - x1) * (y2 - y1) > 0.95 * w * h:
        return 0, 0, w, h  # nothing worth trimming
    return x1, y1, x2 - x1, y2 - y1


def detect_and_refine(rgb, img_bytes=None):
    """One detection + refinement pass. Returns ([(block, refined)], failures)."""
    # MangaPageOcr reads from a path, so round-trip through a temp file
    fd, path = tempfile.mkstemp(suffix=".png")
    try:
        with os.fdopen(fd, "wb") as f:
            if img_bytes is not None:
                f.write(img_bytes)
            else:
                rgb.save(f, "PNG")
        result = state["mpocr"](path)
    finally:
        os.unlink(path)
    gray = np.asarray(rgb.convert("L"))
    pairs = []
    fails = 0
    for b in result.get("blocks", []):
        vertical = bool(b.get("vertical", True))
        quads = plain(b.get("lines_coords", []))
        if quads:
            refined, why = refine_block_lines(gray, plain(b["box"]), quads, vertical)
        else:
            refined, why = None, "no quads"
        if refined is None:
            fails += 1
        print(
            f"[refine] block {len(pairs)} vertical={vertical} "
            f"lines={len(quads)} box={plain(b['box'])} -> {why}"
        )
        pairs.append((b, refined))
    return pairs, fails


@app.post("/ocr")
async def ocr(request: Request):
    if "mpocr" not in state:
        raise HTTPException(status_code=503, detail="models still loading")

    img_bytes = await request.body()
    if not img_bytes:
        raise HTTPException(status_code=400, detail="empty request body")

    from PIL import Image

    rgb_full = Image.open(BytesIO(img_bytes)).convert("RGB")
    rgb = rgb_full
    pairs, fails = detect_and_refine(rgb_full, img_bytes=img_bytes)

    # Letterboxed spreads waste the detector's fixed input resolution on dead
    # space, which wrecks tiny dense text — but trimming changes the detector's
    # input scale, which perturbs pages that were fine (verified: phantom
    # blocks on a title page). So trim only as a rescue: when the full-frame
    # pass is visibly struggling AND there is real dead space to reclaim.
    ox, oy, tw, th = trim_margins(rgb_full)
    trimmed = False
    if fails >= 2 and tw * th < 0.9 * rgb_full.width * rgb_full.height:
        print(f"[trim] {fails} refine failures -> retry on content at ({ox},{oy}) {tw}x{th}")
        rgb = rgb_full.crop((ox, oy, ox + tw, oy + th))
        pairs, _ = detect_and_refine(rgb)
        trimmed = True

    blocks = []
    for b, refined in pairs:
        lines = b.get("lines", [])
        vertical = bool(b.get("vertical", True))
        quads = plain(b.get("lines_coords", []))
        snapped = []
        kept_lines = []
        for i, quad in enumerate(quads):
            if refined is not None:
                if refined[i] is None:
                    continue  # duplicate/phantom detector line, dropped
                x1, y1, x2, y2 = refined[i]
                snapped.append([[x1, y1], [x2, y1], [x2, y2], [x1, y2]])
                # the detector OCR'd its own sloppy overlapping crops, so its
                # texts carry duplicated/garbled content — re-read from the
                # corrected box instead
                crop = rgb.crop((max(0, x1 - 4), max(0, y1 - 4), x2 + 4, y2 + 4))
                text = state["mpocr"].mocr(crop)
                # junk detections re-OCR as pure punctuation ('．．．');
                # they're useless to Yomitan, so drop the line
                if not re.search(r"[ぁ-ゖァ-ヺ一-鿿a-zA-Z0-9０-９Ａ-Ｚａ-ｚ]", text):
                    snapped.pop()
                    continue
                kept_lines.append(text)
            else:
                # segmentation not confident (usually text over artwork):
                # keep the detector's own quad rather than risk worse
                snapped.append(quad)
                kept_lines.append(lines[i])
        box = plain(b["box"])
        if trimmed:  # back to full-capture coordinates
            box = [box[0] + ox, box[1] + oy, box[2] + ox, box[3] + oy]
            snapped = [[[x + ox, y + oy] for x, y in q] for q in snapped]
        blocks.append(
            {
                "box": box,  # [x1, y1, x2, y2] in image pixels
                "vertical": vertical,
                # ink-refined boxes hug the glyphs; fallback quads run loose.
                # The client only trusts tight boxes for column wrapping.
                "refined": refined is not None,
                "lines_coords": snapped,
                "lines": kept_lines,
                "text": "".join(kept_lines),
            }
        )

    state["last"] = {"img": img_bytes, "blocks": blocks}

    return {
        "img_width": rgb_full.width,
        "img_height": rgb_full.height,
        "blocks": blocks,
    }


# Debug: the exact image the model saw, with its detected block boxes (green)
# and line quads (red) drawn on. If boxes align with the text here but the
# page overlay is offset, the bug is in the extension's geometry; if they're
# already offset here, it's the model.
@app.get("/debug/last")
def debug_last(raw: bool = False):
    last = state.get("last")
    if not last:
        raise HTTPException(status_code=404, detail="no capture OCR'd yet")

    if raw:  # the untouched capture, for offline repro/debugging
        is_png = last["img"][:4] == b"\x89PNG"
        return Response(last["img"], media_type="image/png" if is_png else "image/jpeg")

    from PIL import Image, ImageDraw

    img = Image.open(BytesIO(last["img"])).convert("RGB")
    draw = ImageDraw.Draw(img)
    for b in last["blocks"]:
        x1, y1, x2, y2 = b["box"]
        draw.rectangle([x1, y1, x2, y2], outline=(0, 200, 0), width=3)
        for quad in b["lines_coords"]:
            pts = [tuple(p) for p in quad]
            draw.line(pts + [pts[0]], fill=(255, 0, 0), width=2)

    buf = BytesIO()
    img.save(buf, format="JPEG", quality=90)
    return Response(buf.getvalue(), media_type="image/jpeg")


# Debug: locate the extension's magenta fiducial squares in the last capture
# and report how far each sits from its expected spot (image corners/center).
# Nonzero dx/dy = the capture is misregistered with the viewport by that much.
@app.get("/debug/registration")
def debug_registration():
    last = state.get("last")
    if not last:
        raise HTTPException(status_code=404, detail="no capture OCR'd yet")

    from PIL import Image

    arr = np.asarray(Image.open(BytesIO(last["img"])).convert("RGB")).astype(np.int16)
    h, w = arr.shape[:2]
    mask = (arr[..., 0] > 180) & (arr[..., 2] > 180) & (arr[..., 1] < 120)
    pts = [(int(x), int(y)) for y, x in zip(*np.nonzero(mask))]

    blobs = []
    while pts and len(blobs) < 20:
        sx, sy = pts[0]
        cluster = [p for p in pts if abs(p[0] - sx) < 40 and abs(p[1] - sy) < 40]
        pts = [p for p in pts if p not in cluster]
        cx = sum(p[0] for p in cluster) / len(cluster)
        cy = sum(p[1] for p in cluster) / len(cluster)
        blobs.append({"x": round(cx, 1), "y": round(cy, 1), "px": len(cluster)})

    expected = {
        "top-left": (5, 5),
        "top-right": (w - 5, 5),
        "bottom-left": (5, h - 5),
        "bottom-right": (w - 5, h - 5),
        "center": (w / 2, h / 2),
    }
    for b in blobs:
        name, (ex, ey) = min(
            expected.items(),
            key=lambda kv: (kv[1][0] - b["x"]) ** 2 + (kv[1][1] - b["y"]) ** 2,
        )
        b["nearest"] = name
        b["dx"] = round(b["x"] - ex, 1)
        b["dy"] = round(b["y"] - ey, 1)

    found = {b["nearest"] for b in blobs}
    report = {
        "img": {"w": w, "h": h},
        "fiducials": blobs,
        "missing": [k for k in expected if k not in found],
        "note": "dx/dy in capture px; a missing corner means it was cropped out (also a shift clue)",
    }
    print("[registration]", report)
    return report


def run_tray():
    import socket
    import sys
    import threading
    import webbrowser

    import pystray
    import uvicorn
    from PIL import Image as PILImage
    from PIL import ImageDraw as PILImageDraw

    # under pythonw there is no console; print() would crash the server
    if sys.stdout is None or sys.stderr is None:
        log = open(os.path.join(_here, "server.log"), "a", buffering=1, encoding="utf-8")
        sys.stdout = sys.stderr = log

    # already running (e.g. double-clicked twice)? leave that instance alone
    with socket.socket() as s:
        if s.connect_ex(("127.0.0.1", 8765)) == 0:
            sys.exit(0)

    im = PILImage.new("RGBA", (64, 64), (0, 0, 0, 0))
    d = PILImageDraw.Draw(im)
    d.rounded_rectangle([4, 6, 60, 46], radius=12, fill=(40, 44, 52, 255),
                        outline=(255, 255, 255, 255), width=3)
    d.polygon([(18, 44), (30, 44), (16, 58)], fill=(255, 255, 255, 255))
    for x in (44, 32, 20):  # vertical text columns, manga-style
        d.line([(x, 14), (x, 38)], fill=(255, 255, 255, 255), width=4)

    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=8765))
    threading.Thread(target=server.run, daemon=True).start()

    icon = pystray.Icon(
        "manga-yomi",
        im,
        f"manga-yomi OCR server — port 8765 (rev {REV})",
        menu=pystray.Menu(
            pystray.MenuItem(
                "Health check",
                lambda: webbrowser.open("http://127.0.0.1:8765/health"),
            ),
            pystray.MenuItem("Quit", lambda ic, item: ic.stop()),
        ),
    )
    icon.run()
    os._exit(0)  # torch worker threads can hang normal interpreter teardown


if __name__ == "__main__":
    import sys

    if "--tray" in sys.argv:
        run_tray()
    else:
        import uvicorn

        uvicorn.run(app, host="127.0.0.1", port=8765)

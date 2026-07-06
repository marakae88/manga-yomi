import os
import tempfile
from contextlib import asynccontextmanager

import numpy as np
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware

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


def plain(v):  # mokuro returns numpy scalars/arrays, which break JSON
    if isinstance(v, (np.ndarray, np.generic)):
        return v.tolist()
    if isinstance(v, (list, tuple)):
        return [plain(x) for x in v]
    return v


@app.get("/health")
def health():
    return {
        "status": "ok" if "mpocr" in state else "loading",
        "device": state.get("device", "unknown"),
    }


@app.post("/ocr")
async def ocr(request: Request):
    if "mpocr" not in state:
        raise HTTPException(status_code=503, detail="models still loading")

    img_bytes = await request.body()
    if not img_bytes:
        raise HTTPException(status_code=400, detail="empty request body")

    # MangaPageOcr reads from a path, so round-trip through a temp file
    fd, path = tempfile.mkstemp(suffix=".png")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(img_bytes)
        result = state["mpocr"](path)
    finally:
        os.unlink(path)

    blocks = []
    for b in result.get("blocks", []):
        lines = b.get("lines", [])
        blocks.append(
            {
                "box": plain(b["box"]),  # [x1, y1, x2, y2] in image pixels
                "vertical": bool(b.get("vertical", True)),
                "lines_coords": plain(b.get("lines_coords", [])),
                "lines": list(lines),
                "text": "".join(lines),
            }
        )

    return {
        "img_width": plain(result.get("img_width")),
        "img_height": plain(result.get("img_height")),
        "blocks": blocks,
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8765)

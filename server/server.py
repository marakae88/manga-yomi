import base64
import os
import tempfile
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

state = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    import torch
    from mokuro.manga_page_ocr import MangaPageOcr

    state["device"] = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"Loading models on {state['device']} (first run downloads ~400MB)...")
    state["mpocr"] = MangaPageOcr(force_cpu=state["device"] == "cpu")
    print("Models loaded. Ready.")
    yield


app = FastAPI(lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class OcrRequest(BaseModel):
    image: str  # base64-encoded PNG/JPEG, optionally a data URL


@app.get("/health")
def health():
    return {
        "status": "ok" if "mpocr" in state else "loading",
        "device": state.get("device", "unknown"),
    }


@app.post("/ocr")
def ocr(req: OcrRequest):
    if "mpocr" not in state:
        raise HTTPException(status_code=503, detail="models still loading")

    data = req.image
    if data.startswith("data:"):
        data = data.split(",", 1)[1]
    try:
        img_bytes = base64.b64decode(data)
    except Exception:
        raise HTTPException(status_code=400, detail="invalid base64 image")

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
                "box": b["box"],  # [x1, y1, x2, y2] in screenshot pixels
                "vertical": bool(b.get("vertical", True)),
                "font_size": b.get("font_size"),
                "lines_coords": b.get("lines_coords", []),
                "lines": lines,
                "text": "".join(lines),
            }
        )

    return {
        "img_width": result.get("img_width"),
        "img_height": result.get("img_height"),
        "blocks": blocks,
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8765)

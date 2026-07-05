# manga-yomi

Makes [Yomitan](https://github.com/yomidevs/yomitan) work on manga sites.

Manga pages are images/canvas, so Yomitan has no text to scan. manga-yomi bridges
the gap: a Chrome extension screenshots the page, a local OCR server
([manga-ocr](https://github.com/kha-white/manga-ocr) via
[mokuro](https://github.com/kha-white/mokuro)) finds and reads the speech
bubbles, and the extension overlays invisible selectable text on top of them.
Your existing Yomitan install then works exactly as it does on regular articles
— popup, definitions, audio, Anki.

```
flip page → screenshot → localhost OCR (GPU) → invisible text overlay → hover + Shift → Yomitan popup
```

Everything runs locally; no image ever leaves your machine.

## Setup

### 1. OCR server (Windows)

Requires Python 3.10–3.12 from [python.org](https://www.python.org/downloads/)
(not the Microsoft Store version) and an NVIDIA GPU (CPU works too, just slower).

Double-click `server/run-server.bat`. On first run it creates a venv, installs
dependencies (CUDA torch + mokuro, several GB), and downloads the OCR models
(~400 MB). Later runs start in seconds. Leave the window open while reading.

Verify: open <http://127.0.0.1:8765/health> — should show `{"status": "ok", "device": "cuda"}`.

### 2. Chrome extension

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select the `extension/` folder

### 3. Read

Open a supported site (ynjn.jp, championcross.jp), open a manga page, click the
extension icon → **OCR this page**. After ~1s, hover a speech bubble with your
Yomitan hotkey (Shift by default) — the popup appears as on any text page.

The **Show text boxes (debug)** checkbox makes the normally-invisible overlay
visible, useful for checking OCR alignment.

## Status

- [x] Local OCR server (FastAPI + mokuro/manga-ocr)
- [x] Extension with manual "OCR this page" trigger + invisible overlay
- [ ] Automatic OCR on page flip
- [ ] "Enable on this site" for arbitrary manga sites
- [ ] Tray icon / start-with-Windows for the server

## License

Private project. Depends on mokuro / comic-text-detector (GPL-3.0) and
manga-ocr (Apache-2.0) — GPL-3.0 obligations apply if ever distributed.

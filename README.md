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

### 0. Prerequisite

[Yomitan](https://chromewebstore.google.com/detail/yomitan/likgccmbimhjbgkjambclfkhldnlhbnn)
installed in Chrome with at least one Japanese dictionary. manga-yomi only
provides the text layer — Yomitan does all the lookup.

### 1. OCR server (Windows)

Requires Python 3.10–3.12 from [python.org](https://www.python.org/downloads/)
(not the Microsoft Store version) and an NVIDIA GPU (CPU works too, just slower).

Double-click `server/run-server.bat`. On first run it creates a venv, installs
dependencies (CUDA torch + mokuro, several GB), and downloads the OCR models
(~400 MB). Later runs start in seconds.

Verify: open <http://127.0.0.1:8765/health> — should show `{"status": "ok", "device": "cuda"}`.

For daily use, `server/start-tray.vbs` starts the server silently with a tray
icon (right-click it to check health or quit). To start it with Windows, put a
shortcut to `start-tray.vbs` in `shell:startup`.

### 2. Chrome extension

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select the `extension/` folder

The extension icon's popup shows whether it can reach the OCR server.

## Usage

**On an enabled site** (ynjn.jp and championcross.jp out of the box): just
read. Every page flip is OCR'd automatically (~1s), then hover text with your
Yomitan hotkey (Shift by default) — the popup appears as on any text page.

**Enable your own manga site:** open the site, click the extension icon, and
check **Auto-OCR on \<site\>**. Chrome asks for permission for that site once.
Enabled sites are listed in the popup; **×** removes one. Auto-OCR is tuned
for page-flip readers — on sites where it misfires, leave the site toggle off
and use manual OCR instead.

**Anywhere else:** press **Alt+O** (or the popup's **OCR this page** button)
to OCR the current view once — works on any page without granting permanent
permissions.

Popup switches:

- **Auto OCR on page flip** — master switch for auto mode on all enabled sites
- **Show text boxes (debug)** — makes the normally-invisible overlay visible,
  useful for checking OCR alignment

Known limits: furigana is skipped on purpose, handwritten sound effects are
often missed, and very small text needs a higher-resolution capture (read in
fullscreen).

## Status

- [x] Local OCR server (FastAPI + mokuro/manga-ocr), tray mode
- [x] Invisible selectable overlay, fullscreen-safe geometry
- [x] Automatic OCR on page flip (debounced, cached, capture hygiene)
- [x] Server-side line refinement + per-line re-OCR
- [x] Alt+O one-shot OCR on arbitrary sites
- [x] User-managed auto-OCR site list (popup toggle + permission prompt)
- [ ] Local files / offline reader support

## License

Private project. Depends on mokuro / comic-text-detector (GPL-3.0) and
manga-ocr (Apache-2.0) — GPL-3.0 obligations apply if ever distributed.

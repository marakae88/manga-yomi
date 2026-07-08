# web-manga-ocr

Makes [Yomitan](https://github.com/yomidevs/yomitan) work on manga sites.

Manga pages are images/canvas, so Yomitan has no text to scan. web-manga-ocr bridges
the gap: a Chrome extension screenshots the page, a local OCR server
([manga-ocr](https://github.com/kha-white/manga-ocr) via
[mokuro](https://github.com/kha-white/mokuro)) finds and reads the speech
bubbles, and the extension overlays invisible selectable text on top of them.
Your existing Yomitan install then works exactly as it does on regular
articles: popup, definitions, audio, Anki.

https://github.com/user-attachments/assets/4d636695-bb05-4490-bc55-c00db2909b2b

Everything runs locally; no image ever leaves your machine.

Built and tested on Windows with Chrome. Other browsers and platforms are
untested.

## Setup

### 0. Prerequisite

[Yomitan](https://chromewebstore.google.com/detail/yomitan/likgccmbimhjbgkjambclfkhldnlhbnn)
installed in Chrome with at least one Japanese dictionary. web-manga-ocr only
provides the text layer; Yomitan does all the lookup.

### 1. Get the code

Either clone the repo:

```
git clone https://github.com/marakae88/web-manga-ocr.git
```

or click **Code → Download ZIP** on GitHub and extract it. There is nothing to
build; the repo folder is the installation. Put it somewhere permanent with
~10 GB free: the extension loads directly from it, and the server installs its
Python environment and models inside it. If you move the folder later, redo
steps 2 and 3.

### 2. OCR server (Windows)

Requires Python 3.10–3.12 from [python.org](https://www.python.org/downloads/)
(not the Microsoft Store version).

Double-click `server/run-server.bat`. On first run it creates a venv, installs
dependencies (torch + mokuro, several GB), and downloads the OCR models
(~400 MB). Later runs start in seconds.

An NVIDIA GPU is used automatically if present (about a second per page);
without one, OCR runs on the CPU and takes a few seconds per page instead.

Verify: open <http://127.0.0.1:8765/health>. It should show
`{"status": "ok", "device": "cuda"}` (`"cpu"` without a GPU).

For daily use, `server/start-tray.vbs` starts the server silently with a tray
icon (right-click it to check health or quit). To start it with Windows, put a
shortcut to `start-tray.vbs` in `shell:startup`.

### 3. Chrome extension

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select the `extension/` folder from step 1

The extension icon's popup shows whether it can reach the OCR server.

## Usage

**On an enabled site** (ynjn.jp and championcross.jp out of the box): just
read. Every page flip is OCR'd automatically (~1s), then hover text with your
Yomitan hotkey (Shift by default) and the popup appears as on any text page.

**Enable your own manga site:** open the site, click the extension icon, and
check **Auto-OCR on \<site\>**. Chrome asks for permission for that site once.
Enabled sites are listed in the popup; **×** removes one. Auto-OCR is tuned
for page-flip readers; on sites where it misfires, leave the site toggle off
and use manual OCR instead.

**Anywhere else:** press **Alt+O** (or the popup's **OCR this page** button)
to OCR the current view once. This works on any page without granting
permanent permissions.

Popup switches:

- **Auto OCR on page flip**: master switch for auto mode on all enabled sites
- **Show text boxes (debug)**: makes the normally-invisible overlay visible,
  useful for checking OCR alignment

Known limits: furigana is skipped on purpose, handwritten sound effects are
often missed, and very small text needs a higher-resolution capture (read in
fullscreen).

## Troubleshooting

- **Popup says "Server not running"**: start it with `server/start-tray.vbs`
  (or `run-server.bat` to see logs). The first OCR after a start takes a few
  extra seconds while models load.
- **No popup on hover**: make sure Yomitan is enabled and you're holding its
  scan key (Shift by default). Check **Show text boxes (debug)** in the popup
  to see whether text was found and where.
- **Text found but misaligned or wrong**: small text OCRs poorly at small
  window sizes; read in fullscreen. If a whole bubble is missing, that's
  usually the detector's recall limit on busy art.
- **Alt+O does nothing**: another extension may own the shortcut; rebind it
  at `chrome://extensions/shortcuts`.

Planned: local files / offline reader support.

## License

[GPL-3.0](LICENSE). Built on [mokuro](https://github.com/kha-white/mokuro) and
[comic-text-detector](https://github.com/dmMaze/comic-text-detector) (both
GPL-3.0) and [manga-ocr](https://github.com/kha-white/manga-ocr) (Apache-2.0).

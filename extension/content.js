const OVERLAY_ID = "manga-yomi-overlay";
const TOAST_ID = "manga-yomi-toast";
let debugBoxes = false;

chrome.storage.local.get("debugBoxes").then((v) => {
  debugBoxes = !!v.debugBoxes;
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.debugBoxes) {
    debugBoxes = !!changes.debugBoxes.newValue;
    document.getElementById(OVERLAY_ID)?.classList.toggle("debug", debugBoxes);
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "trigger-ocr") {
    toast("OCR...");
    runOcr()
      .then((n) => {
        toast(`${n} bubble(s) found`);
        sendResponse({ ok: true, blocks: n });
      })
      .catch((e) => {
        toast(`OCR failed: ${e.message}`);
        sendResponse({ error: String(e) });
      });
    return true;
  }
});

// In fullscreen, only the fullscreened element's subtree renders on top;
// anything attached to <html> is covered. So mount inside it when active.
function overlayRoot() {
  const fs = document.fullscreenElement;
  if (fs && !["IMG", "VIDEO", "CANVAS"].includes(fs.tagName)) return fs;
  return document.documentElement;
}

let toastTimer;
function toast(msg) {
  let t = document.getElementById(TOAST_ID);
  if (!t) {
    t = document.createElement("div");
    t.id = TOAST_ID;
  }
  overlayRoot().appendChild(t);
  t.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 2500);
}

async function runOcr() {
  clearOverlay();
  const rect = pageRect();
  const dpr = window.devicePixelRatio;
  const res = await chrome.runtime.sendMessage({
    type: "ocr-page",
    // the capture is in device px; scale here so background needs no dpr
    rect: rect && {
      x: rect.x * dpr,
      y: rect.y * dpr,
      width: rect.width * dpr,
      height: rect.height * dpr,
    },
  });
  if (!res) throw new Error("no response from background");
  if (res.error) throw new Error(res.error);
  renderOverlay(res, rect);
  return res.blocks.filter((b) => b.text).length;
}

// Bounding rect of the manga page image(s) in the viewport, so the capture
// can be cropped and the detector's resolution isn't wasted on UI/letterbox.
function pageRect() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const visible = [];
  for (const el of document.querySelectorAll("img, canvas")) {
    const r = el.getBoundingClientRect();
    const ix = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
    const iy = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    if (ix * iy > 0) visible.push({ r, area: ix * iy });
  }
  if (!visible.length) return null;
  visible.sort((a, b) => b.area - a.area);
  // keep near-largest elements too, so two-page spreads stay together
  const keep = visible.filter((v) => v.area >= visible[0].area * 0.4);
  const left = Math.max(0, Math.min(...keep.map((v) => v.r.left)));
  const top = Math.max(0, Math.min(...keep.map((v) => v.r.top)));
  const right = Math.min(vw, Math.max(...keep.map((v) => v.r.right)));
  const bottom = Math.min(vh, Math.max(...keep.map((v) => v.r.bottom)));
  // implausibly small match (thumbnail, icon): OCR the whole viewport instead
  if ((right - left) * (bottom - top) < vw * vh * 0.2) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function clearOverlay() {
  const overlay = document.getElementById(OVERLAY_ID);
  if (!overlay) return;
  // Yomitan scans by selecting our text; drop that selection or its
  // highlight lingers as a ghost after the overlay is gone
  const sel = window.getSelection();
  if (sel?.anchorNode && overlay.contains(sel.anchorNode)) {
    sel.removeAllRanges();
  }
  overlay.remove();
}

function renderOverlay(res, rect) {
  clearOverlay();
  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  if (debugBoxes) overlay.classList.add("debug");

  // OCR image is the cropped page (or full viewport) in device pixels;
  // convert to CSS px and offset back to the crop's position.
  const scale = (rect ? rect.width : window.innerWidth) / res.img_width;
  const offX = rect ? rect.x : 0;
  const offY = rect ? rect.y : 0;

  for (const block of res.blocks) {
    if (!block.text) continue;
    block.lines.forEach((line, i) => {
      if (!line) return;
      const quad = block.lines_coords?.[i];
      const [x1, y1, x2, y2] = quad ? quadBounds(quad) : block.box;
      const w = (x2 - x1) * scale;
      const h = (y2 - y1) * scale;

      const el = document.createElement("div");
      el.className = "manga-yomi-line" + (block.vertical ? " vertical" : "");
      el.style.left = `${offX + x1 * scale}px`;
      el.style.top = `${offY + y1 * scale}px`;
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
      // Manga text is nearly all full-width chars: advance ≈ font-size,
      // so size glyphs off the line's real length, not mokuro's font_size.
      const fontSize = block.vertical
        ? Math.min(w, h / line.length)
        : Math.min(h, w / line.length);
      el.style.fontSize = `${fontSize}px`;
      el.style.lineHeight = block.vertical ? `${w}px` : `${h}px`;
      el.textContent = line;
      overlay.appendChild(el);
    });
  }

  overlayRoot().appendChild(overlay);
}

function quadBounds(quad) {
  const xs = quad.map((p) => p[0]);
  const ys = quad.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

// Overlay coordinates are viewport-relative; invalidate when the layout moves.
window.addEventListener("resize", clearOverlay);
window.addEventListener("scroll", clearOverlay, true);
document.addEventListener("fullscreenchange", clearOverlay);

// Page flips (click / arrow keys) make the overlay stale — clear it.
window.addEventListener(
  "mousedown",
  (e) => {
    if (!e.target.closest?.(`#${OVERLAY_ID}`)) clearOverlay();
  },
  true
);
window.addEventListener(
  "keydown",
  (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const t = e.target;
    if (t?.tagName === "INPUT" || t?.tagName === "TEXTAREA" || t?.isContentEditable) return;
    clearOverlay();
  },
  true
);

// Yomitan's scan-selection otherwise lingers as a visible highlight;
// drop it as soon as the scan key is released (popup stays open).
window.addEventListener(
  "keyup",
  (e) => {
    if (e.key !== "Shift") return;
    const overlay = document.getElementById(OVERLAY_ID);
    const sel = window.getSelection();
    if (overlay && sel?.anchorNode && overlay.contains(sel.anchorNode)) {
      sel.removeAllRanges();
    }
  },
  true
);

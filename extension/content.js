(() => {
// On non-manga sites this file is injected on demand (Alt+O); a second
// Alt+O must not register duplicate listeners
if (window.__mangaYomiLoaded) return;
window.__mangaYomiLoaded = true;

const OVERLAY_ID = "manga-yomi-overlay";
const TOAST_ID = "manga-yomi-toast";
// auto-OCR-on-flip only runs on sites enabled in the popup; on other
// sites (injected via Alt+O) every click would trigger a capture
let autoSite = false;
let debugBoxes = false;
let autoOcr = true;

const siteMatch = (h) =>
  location.hostname === h || location.hostname.endsWith("." + h);

chrome.storage.local.get(["debugBoxes", "autoOcr", "autoSites"]).then((v) => {
  debugBoxes = !!v.debugBoxes;
  autoOcr = v.autoOcr ?? true;
  autoSite = (v.autoSites ?? []).some(siteMatch);
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.debugBoxes) {
    debugBoxes = !!changes.debugBoxes.newValue;
    document.getElementById(OVERLAY_ID)?.classList.toggle("debug", debugBoxes);
  }
  if (changes.autoOcr) {
    autoOcr = changes.autoOcr.newValue ?? true;
  }
  if (changes.autoSites) {
    const was = autoSite;
    autoSite = (changes.autoSites.newValue ?? []).some(siteMatch);
    if (autoSite && !was) scheduleAutoOcr();
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "capture-done") {
    restoreUi();
  }
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
// anything attached to <html> is covered (popovers/top layer proved
// unreliable above fullscreen too). So mount inside it when active.
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

// Bumped on any event that moves/replaces the page content, so an OCR
// that was in flight during a flip doesn't render a stale overlay.
let ocrGen = 0;
function invalidateOverlay() {
  ocrGen++;
  clearOverlay();
}

let autoTimer;
function scheduleAutoOcr() {
  if (!autoOcr || !autoSite) return;
  clearTimeout(autoTimer);
  // wait for the flip animation / new page render to settle
  autoTimer = setTimeout(() => {
    toast("OCR...");
    runOcr()
      .then((n) => toast(`${n} bubble(s) found`))
      .catch((e) => toast(`OCR failed: ${e.message}`));
  }, 700);
}

// The capture must not include extension UI, or OCR reads it and overlays
// its text as invisible ghosts (e.g. Yomitan's popup definitions ending up
// scannable over the manga). Hide our toast and any visible iframes
// (Yomitan's popup) until the background signals the screenshot is taken.
let restoreUi = () => {};
function hideUiForCapture() {
  const els = [document.getElementById(TOAST_ID)];
  els.push(...document.querySelectorAll("iframe"));
  for (const host of document.querySelectorAll("*")) {
    if (host.shadowRoot) els.push(...host.shadowRoot.querySelectorAll("iframe"));
  }
  const hidden = [];
  for (const el of els) {
    if (!el || el.getClientRects().length === 0) continue;
    hidden.push([el, el.style.visibility]);
    el.style.visibility = "hidden";
  }
  let restored = false;
  restoreUi = () => {
    if (restored) return;
    restored = true;
    for (const [el, vis] of hidden) el.style.visibility = vis;
  };
}

// Two frames so the hidden UI / removed overlay is actually painted out
// before captureVisibleTab grabs the screen.
function paintFlush() {
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}

// Debug-mode registration check: bake markers at the crop rect's corners and
// center into the capture itself. In /debug/last they must sit exactly at the
// image corners/center; any deviation IS the capture↔viewport misregistration.
function placeFiducials(rect) {
  if (!debugBoxes || !rect) return () => {};
  const root = overlayRoot();
  const S = 8;
  const pts = [
    [rect.x, rect.y],
    [rect.x + rect.width - S, rect.y],
    [rect.x, rect.y + rect.height - S],
    [rect.x + rect.width - S, rect.y + rect.height - S],
    [rect.x + (rect.width - S) / 2, rect.y + (rect.height - S) / 2],
  ];
  const els = pts.map(([x, y]) => {
    const d = document.createElement("div");
    d.className = "manga-yomi-fiducial";
    d.style.left = `${x}px`;
    d.style.top = `${y}px`;
    root.appendChild(d);
    return d;
  });
  return () => els.forEach((e) => e.remove());
}

async function runOcr() {
  const gen = ocrGen;
  clearOverlay();
  hideUiForCapture();
  const rect = pageRect();
  const removeFiducials = placeFiducials(rect);
  const restoreTimer = setTimeout(restoreUi, 3000);
  let res;
  try {
    await paintFlush();
    const dpr = window.devicePixelRatio;
    res = await chrome.runtime.sendMessage({
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
    if (gen === ocrGen) renderOverlay(res, rect);
    return res.blocks.filter((b) => b.text).length;
  } finally {
    removeFiducials();
    clearTimeout(restoreTimer);
    restoreUi();
  }
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
    if (ix * iy > 0) visible.push({ el, r, area: ix * iy });
  }
  if (!visible.length) return null;
  visible.sort((a, b) => b.area - a.area);
  // keep near-largest elements too, so two-page spreads stay together
  const keep = visible.filter((v) => v.area >= visible[0].area * 0.4);
  if (debugBoxes) {
    // what IS the page? if it's a plain <img> (or a canvas with a backing
    // store bigger than its CSS size), we could OCR the source at full
    // resolution instead of the screen pixels
    console.log(
      "[manga-yomi] page elements",
      keep.map(({ el, r }) => ({
        tag: el.tagName,
        cssSize: `${Math.round(r.width)}x${Math.round(r.height)}`,
        backing: el.tagName === "IMG"
          ? `${el.naturalWidth}x${el.naturalHeight}`
          : `${el.width}x${el.height}`,
        src: (el.currentSrc || el.src || "").slice(0, 120),
      }))
    );
  }
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
  overlayRoot().appendChild(overlay);

  // If an ancestor of the mount root is CSS-transformed (viewer zoom/pan),
  // position:fixed coordinates are no longer viewport coordinates. Measure
  // where the overlay's origin actually landed and undo offset and scale.
  const box = overlay.getBoundingClientRect();
  const k = overlay.offsetWidth ? box.width / overlay.offsetWidth : 1;

  // OCR image is the cropped page (or full viewport) in device pixels;
  // convert to CSS px and offset back to the crop's position.
  const scale = (rect ? rect.width : window.innerWidth) / res.img_width;
  const offX = (rect ? rect.x : 0) - box.left;
  const offY = (rect ? rect.y : 0) - box.top;

  // Debug frame: where we think the OCR'd crop sits, mapped through the
  // same offset/scale/k math as the text. If it doesn't hug the manga page,
  // the geometry is wrong and the console numbers say by how much.
  const frame = document.createElement("div");
  frame.className = "manga-yomi-debug-frame";
  frame.style.left = `${offX / k}px`;
  frame.style.top = `${offY / k}px`;
  frame.style.width = `${(rect ? rect.width : window.innerWidth) / k}px`;
  frame.style.height = `${(rect ? rect.height : window.innerHeight) / k}px`;
  overlay.appendChild(frame);
  if (debugBoxes) {
    console.log("[manga-yomi] geometry", {
      k,
      overlayBox: { left: box.left, top: box.top, width: box.width, height: box.height },
      overlayLayout: { width: overlay.offsetWidth, height: overlay.offsetHeight },
      rect,
      dpr: window.devicePixelRatio,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      img: { w: res.img_width, h: res.img_height },
      fullscreen: document.fullscreenElement
        ? `${document.fullscreenElement.tagName}.${document.fullscreenElement.className}`
        : null,
    });
  }

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
      el.style.left = `${(offX + x1 * scale) / k}px`;
      el.style.top = `${(offY + y1 * scale) / k}px`;
      el.style.width = `${w / k}px`;
      el.style.height = `${h / k}px`;
      // Manga text is nearly all full-width chars: advance ≈ font-size,
      // so size glyphs off the line's real length, not mokuro's font_size.
      const n = line.length;
      let fontSize = block.vertical ? Math.min(w, h / n) : Math.min(h, w / n);
      // Calligraphic titles and tight low-res columns come back as ONE
      // detected line spanning several physical columns (no ink valley to
      // split on). One stretched skinny column puts every glyph off-target;
      // wrapping into vertical-rl columns (right to left = reading order)
      // tracks the real layout. Only trust ink-refined boxes (fallback
      // quads run loose, so the geometry lies), and only switch when
      // clearly better: a 20% margin keeps true single columns single.
      let cols = 1;
      if (block.vertical && block.refined && n > 1) {
        for (let c = 2; c <= Math.min(n, 6); c++) {
          const fs = Math.min(h / Math.ceil(n / c), w / c);
          if (fs > fontSize * 1.2) {
            fontSize = fs;
            cols = c;
          }
        }
      }
      el.style.fontSize = `${fontSize / k}px`;
      if (cols > 1) {
        const chars = Math.ceil(n / cols);
        // stretch each column to the full box height so wrap points land
        // exactly every `chars` characters; the -0.2px keeps float rounding
        // from pushing an exact-fit last char onto the next column
        el.style.letterSpacing = `${(h - chars * fontSize) / chars / k - 0.2}px`;
        el.style.lineHeight = `${w / cols / k}px`;
        el.style.wordBreak = "break-all";
        // the class sets nowrap (right for true single lines); wrapping is
        // the entire point of this branch, so re-enable it
        el.style.whiteSpace = "normal";
      } else {
        // advance ≈ font-size is a few % off, and the error accumulates so
        // the LAST character lands short of the box end; spread the leftover
        if (n > 1) {
          const leftover = (block.vertical ? h : w) - n * fontSize;
          el.style.letterSpacing = `${leftover / (n - 1) / k}px`;
        }
        el.style.lineHeight = `${(block.vertical ? w : h) / k}px`;
      }
      el.textContent = line;
      overlay.appendChild(el);
    });
  }
}

function quadBounds(quad) {
  const xs = quad.map((p) => p[0]);
  const ys = quad.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

// Overlay coordinates are viewport-relative; invalidate when the layout moves.
window.addEventListener("resize", invalidateOverlay);
window.addEventListener("scroll", invalidateOverlay, true);
document.addEventListener("fullscreenchange", () => {
  invalidateOverlay();
  scheduleAutoOcr();
});

// Page flips (click / arrow keys) make the overlay stale — clear it and,
// in auto mode, OCR the new page once it settles.
window.addEventListener(
  "mousedown",
  (e) => {
    if (e.target.closest?.(`#${OVERLAY_ID}`)) return;
    invalidateOverlay();
    scheduleAutoOcr();
  },
  true
);
window.addEventListener(
  "keydown",
  (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const t = e.target;
    if (t?.tagName === "INPUT" || t?.tagName === "TEXTAREA" || t?.isContentEditable) return;
    invalidateOverlay();
    scheduleAutoOcr();
  },
  true
);

// Yomitan's scan-selection otherwise lingers as a visible highlight.
// A keyup listener misses it when focus is inside Yomitan's popup frame,
// but selectionchange fires on our document regardless of focus — clear
// any overlay selection shortly after it settles (popup stays open).
let selClearTimer;
document.addEventListener("selectionchange", () => {
  clearTimeout(selClearTimer);
  selClearTimer = setTimeout(() => {
    const overlay = document.getElementById(OVERLAY_ID);
    const sel = window.getSelection();
    if (overlay && sel?.anchorNode && overlay.contains(sel.anchorNode)) {
      sel.removeAllRanges();
    }
  }, 600);
});
})();

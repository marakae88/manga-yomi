const OVERLAY_ID = "manga-yomi-overlay";
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
    runOcr()
      .then((n) => sendResponse({ ok: true, blocks: n }))
      .catch((e) => sendResponse({ error: String(e) }));
    return true;
  }
});

async function runOcr() {
  clearOverlay();
  const res = await chrome.runtime.sendMessage({ type: "ocr-page" });
  if (!res) throw new Error("no response from background");
  if (res.error) throw new Error(res.error);
  renderOverlay(res);
  return res.blocks.length;
}

function clearOverlay() {
  document.getElementById(OVERLAY_ID)?.remove();
}

function renderOverlay(res) {
  clearOverlay();
  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  if (debugBoxes) overlay.classList.add("debug");

  // Screenshot covers the visible viewport in device pixels; convert to CSS px.
  const scale = window.innerWidth / res.img_width;

  for (const block of res.blocks) {
    if (!block.text) continue;
    const [x1, y1, x2, y2] = block.box;
    const el = document.createElement("div");
    el.className = "manga-yomi-block" + (block.vertical ? " vertical" : "");
    el.style.left = `${x1 * scale}px`;
    el.style.top = `${y1 * scale}px`;
    el.style.width = `${(x2 - x1) * scale}px`;
    el.style.height = `${(y2 - y1) * scale}px`;
    if (block.font_size) {
      el.style.fontSize = `${block.font_size * scale}px`;
    }
    for (const line of block.lines) {
      const lineEl = document.createElement("div");
      lineEl.textContent = line;
      el.appendChild(lineEl);
    }
    overlay.appendChild(el);
  }

  document.documentElement.appendChild(overlay);
}

// Overlay coordinates are viewport-relative; invalidate when the layout moves.
window.addEventListener("resize", clearOverlay);
window.addEventListener("scroll", clearOverlay, true);

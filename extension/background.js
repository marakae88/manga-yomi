const SERVER = "http://127.0.0.1:8765";

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "ocr-page") {
    ocrVisibleTab(sender.tab, msg.rect)
      .then(sendResponse)
      .catch((e) => sendResponse({ error: String(e) }));
    return true;
  }
  if (msg.type === "health") {
    fetch(`${SERVER}/health`)
      .then((r) => r.json())
      .then(sendResponse)
      .catch((e) => sendResponse({ error: String(e) }));
    return true;
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === "ocr-page") {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, { type: "trigger-ocr" }).catch(() => {});
    }
  }
});

// Auto mode re-OCRs on every click/flip; identical captures (flipping back,
// clicks that don't change the page) should not hit the GPU again.
const ocrCache = new Map();
const OCR_CACHE_MAX = 20;

// rect is in device pixels, matching the capture
async function ocrVisibleTab(tab, rect) {
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: "png",
  });
  // capture is done: the content script can unhide the UI it hid
  chrome.tabs.sendMessage(tab.id, { type: "capture-done" }).catch(() => {});
  let blob = await (await fetch(dataUrl)).blob();
  if (rect) {
    blob = await cropBlob(blob, rect);
  }
  const bytes = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const key = String.fromCharCode(...new Uint8Array(digest));
  const hit = ocrCache.get(key);
  if (hit) {
    ocrCache.delete(key);
    ocrCache.set(key, hit);
    return hit;
  }
  const res = await fetch(`${SERVER}/ocr`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: bytes,
  });
  if (!res.ok) {
    throw new Error(`OCR server responded ${res.status}`);
  }
  const json = await res.json();
  ocrCache.set(key, json);
  if (ocrCache.size > OCR_CACHE_MAX) {
    ocrCache.delete(ocrCache.keys().next().value);
  }
  return json;
}

async function cropBlob(blob, rect) {
  const bitmap = await createImageBitmap(blob);
  const sx = Math.max(0, Math.round(rect.x));
  const sy = Math.max(0, Math.round(rect.y));
  const sw = Math.min(bitmap.width - sx, Math.round(rect.width));
  const sh = Math.min(bitmap.height - sy, Math.round(rect.height));
  if (sw <= 0 || sh <= 0) return blob;
  const canvas = new OffscreenCanvas(sw, sh);
  canvas.getContext("2d").drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  bitmap.close();
  // JPEG encodes much faster than PNG and is ~5-10x smaller; OCR is unaffected
  return canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 });
}

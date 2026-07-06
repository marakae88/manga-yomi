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

// rect is in device pixels, matching the capture
async function ocrVisibleTab(tab, rect) {
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: "png",
  });
  let blob = await (await fetch(dataUrl)).blob();
  if (rect) {
    blob = await cropBlob(blob, rect);
  }
  const res = await fetch(`${SERVER}/ocr`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: blob,
  });
  if (!res.ok) {
    throw new Error(`OCR server responded ${res.status}`);
  }
  return await res.json();
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

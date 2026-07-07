const SERVER = "http://127.0.0.1:8765";
const DEFAULT_SITES = ["ynjn.jp", "championcross.jp"];

// Auto-OCR sites live in storage; one dynamically-registered content script
// (persists across restarts) covers them, so auto mode works on page load
// without any broad host permission.
async function syncAutoSites() {
  const { autoSites } = await chrome.storage.local.get("autoSites");
  const sites = autoSites ?? DEFAULT_SITES;
  const old = await chrome.scripting.getRegisteredContentScripts({
    ids: ["manga-yomi-auto"],
  });
  if (old.length) {
    await chrome.scripting.unregisterContentScripts({ ids: ["manga-yomi-auto"] });
  }
  if (!sites.length) return;
  await chrome.scripting.registerContentScripts([
    {
      id: "manga-yomi-auto",
      matches: sites.flatMap((h) => [`*://${h}/*`, `*://*.${h}/*`]),
      js: ["content.js"],
      css: ["overlay.css"],
      runAt: "document_idle",
    },
  ]);
}

chrome.runtime.onInstalled.addListener(async () => {
  const { autoSites } = await chrome.storage.local.get("autoSites");
  if (!autoSites) {
    await chrome.storage.local.set({ autoSites: DEFAULT_SITES });
  }
  syncAutoSites().catch((e) => console.error("[manga-yomi] site sync failed", e));
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.autoSites) {
    syncAutoSites().catch((e) => console.error("[manga-yomi] site sync failed", e));
  }
});

// Works on any tab: reach the content script if present, otherwise inject on
// the fly (Alt+O and opening the popup both grant activeTab).
async function triggerOcr(tab) {
  try {
    return await chrome.tabs.sendMessage(tab.id, { type: "trigger-ocr" });
  } catch {
    try {
      await chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ["overlay.css"],
      });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"],
      });
      return await chrome.tabs.sendMessage(tab.id, { type: "trigger-ocr" });
    } catch {
      // chrome:// pages, the Web Store, etc.: nothing we can do
      return { ok: false, error: "can't run on this page" };
    }
  }
}

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
  if (msg.type === "trigger-ocr-tab") {
    chrome.tabs
      .query({ active: true, currentWindow: true })
      .then(([tab]) => (tab?.id ? triggerOcr(tab) : { ok: false, error: "no tab" }))
      .then(sendResponse);
    return true;
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "ocr-page") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  await triggerOcr(tab);
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

const SERVER = "http://127.0.0.1:8765";

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "ocr-page") {
    ocrVisibleTab(sender.tab)
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

async function ocrVisibleTab(tab) {
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: "png",
  });
  const res = await fetch(`${SERVER}/ocr`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: dataUrl }),
  });
  if (!res.ok) {
    throw new Error(`OCR server responded ${res.status}`);
  }
  return await res.json();
}

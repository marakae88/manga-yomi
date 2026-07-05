const dot = document.getElementById("dot");
const statusText = document.getElementById("status-text");
const result = document.getElementById("result");
const debugBox = document.getElementById("debug");

chrome.runtime.sendMessage({ type: "health" }).then((res) => {
  if (res && res.status === "ok") {
    dot.className = "ok";
    statusText.textContent = `Server ready (${res.device})`;
  } else if (res && res.status === "loading") {
    dot.className = "";
    statusText.textContent = "Server loading models...";
  } else {
    dot.className = "down";
    statusText.textContent = "Server not running";
  }
});

chrome.storage.local.get("debugBoxes").then((v) => {
  debugBox.checked = !!v.debugBoxes;
});
debugBox.addEventListener("change", () => {
  chrome.storage.local.set({ debugBoxes: debugBox.checked });
});

document.getElementById("ocr-btn").addEventListener("click", async () => {
  result.textContent = "Running OCR...";
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: "trigger-ocr" });
    if (res && res.ok) {
      result.textContent = `Done: ${res.blocks} text block(s) found`;
    } else {
      result.textContent = `Error: ${res ? res.error : "no response"}`;
    }
  } catch (e) {
    result.textContent = "This page isn't an enabled manga site.";
  }
});

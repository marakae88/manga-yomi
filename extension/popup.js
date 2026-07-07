const dot = document.getElementById("dot");
const statusText = document.getElementById("status-text");
const serverHint = document.getElementById("server-hint");
const result = document.getElementById("result");
const debugBox = document.getElementById("debug");
const autoBox = document.getElementById("auto");
const siteLabel = document.getElementById("site-label");
const siteBox = document.getElementById("site-auto");
const siteHost = document.getElementById("site-host");
const sitesDiv = document.getElementById("sites");
const siteList = document.getElementById("site-list");

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
    serverHint.style.display = "block";
  }
});

chrome.storage.local.get(["debugBoxes", "autoOcr"]).then((v) => {
  debugBox.checked = !!v.debugBoxes;
  autoBox.checked = v.autoOcr ?? true;
});
debugBox.addEventListener("change", () => {
  chrome.storage.local.set({ debugBoxes: debugBox.checked });
});
autoBox.addEventListener("change", () => {
  chrome.storage.local.set({ autoOcr: autoBox.checked });
});

// ---- per-site auto-OCR ----

// the hostname the toggle acts on: current tab's, minus a www. prefix
let tabHost = null;

const matches = (hostname, site) =>
  hostname === site || hostname.endsWith("." + site);

async function getSites() {
  const { autoSites } = await chrome.storage.local.get("autoSites");
  return autoSites ?? [];
}

function renderSites(sites) {
  sitesDiv.hidden = sites.length === 0;
  siteList.replaceChildren(
    ...sites.map((s) => {
      const row = document.createElement("div");
      row.className = "site-row";
      const name = document.createElement("span");
      name.textContent = s;
      const del = document.createElement("button");
      del.textContent = "×";
      del.title = `Stop auto-OCR on ${s}`;
      del.addEventListener("click", () => removeSite(s));
      row.append(name, del);
      return row;
    })
  );
}

async function refreshSiteUi() {
  const sites = await getSites();
  renderSites(sites);
  if (tabHost) {
    siteBox.checked = sites.some((s) => matches(tabHost, s));
  }
}

async function addSite(host) {
  // subdomain pattern too: manga readers often live on viewer.example.jp
  const granted = await chrome.permissions.request({
    origins: [`*://${host}/*`, `*://*.${host}/*`],
  });
  if (!granted) return false;
  const sites = await getSites();
  if (!sites.includes(host)) {
    await chrome.storage.local.set({ autoSites: [...sites, host] });
  }
  return true;
}

async function removeSite(host) {
  const sites = await getSites();
  await chrome.storage.local.set({ autoSites: sites.filter((s) => s !== host) });
  // best effort: default sites are required permissions and can't be removed
  chrome.permissions
    .remove({ origins: [`*://${host}/*`, `*://*.${host}/*`] })
    .catch(() => {});
  refreshSiteUi();
}

chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  try {
    const url = new URL(tab.url);
    if (url.protocol === "http:" || url.protocol === "https:") {
      tabHost = url.hostname.replace(/^www\./, "");
      siteHost.textContent = tabHost;
      siteLabel.hidden = false;
    }
  } catch {
    // no usable URL (chrome:// pages etc.) — leave the toggle hidden
  }
  refreshSiteUi();
});

siteBox.addEventListener("change", async () => {
  if (!tabHost) return;
  if (siteBox.checked) {
    const ok = await addSite(tabHost);
    if (!ok) siteBox.checked = false; // permission declined
    refreshSiteUi();
  } else {
    const sites = await getSites();
    for (const s of sites.filter((x) => matches(tabHost, x))) {
      await removeSite(s);
    }
  }
});

document.getElementById("ocr-btn").addEventListener("click", async () => {
  result.textContent = "Running OCR...";
  const res = await chrome.runtime.sendMessage({ type: "trigger-ocr-tab" });
  if (res && res.ok) {
    result.textContent = `Done: ${res.blocks} text block(s) found`;
  } else {
    result.textContent = `Error: ${res ? res.error : "no response"}`;
  }
});

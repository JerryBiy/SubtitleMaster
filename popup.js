// popup.js

const ONBOARDING_KEY = "nsplus_seen_onboarding";
const LOADED_SUBTITLE_KEY = "nsplus_loaded_subtitle";

// runtime current title key (set after ping)
let CURRENT_TITLE_KEY = null;

function $(id) {
  return document.getElementById(id);
}

function setSpinner(on) {
  const el = $("spinner");
  if (!el) return;
  el.classList.toggle("hidden", !on);
}

function setStatus(text, ok = true) {
  const el = $("status");
  el.textContent = text;
  el.style.color = ok ? "#d7fbd7" : "#ffd0d0";
}

function setSmallStatus(text) {
  const el = $("smallStatus");
  el.textContent = text || "";
}

function friendlyErrorMessage(error) {
  const raw = String(error || "");
  const msg = raw.toLowerCase();

  if (
    msg.includes("receiving end does not exist") ||
    msg.includes("could not establish connection")
  ) {
    return (
      "⚠️ Subtitles+ couldn’t connect to Netflix yet.\n" +
      "👉 Try reloading the Netflix page, then open this panel again."
    );
  }

  return `⚠️ ${raw}`;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab && tab.id ? tab : null;
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => reject(r.error || new Error("Failed to read file"));
    r.readAsText(file);
  });
}

async function injectIfNeeded(tabId) {
  // Inject both scripts; content.js guards against double-load
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["subtitle_parser.js", "content.js"],
  });
}

async function sendMessage(tabId, message, { injectOnFail = true } = {}) {
  const attempt = () =>
    new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, message, (resp) => {
        const err = chrome.runtime.lastError;
        if (err) {
          resolve({ ok: false, error: friendlyErrorMessage(err.message) });
        } else {
          resolve(
            resp || { ok: false, error: "⚠️ No response from content script." }
          );
        }
      });
    });

  let resp = await attempt();
  if (resp.ok) return resp;

  const rawLower = String(resp.error || "").toLowerCase();
  const isNoReceiver =
    rawLower.includes("receiving end does not exist") ||
    rawLower.includes("could not establish connection");

  if (injectOnFail && isNoReceiver) {
    try {
      await injectIfNeeded(tabId);
      resp = await attempt();
      return resp;
    } catch (_e) {
      return {
        ok: false,
        error:
          "⚠️ Subtitles+ couldn’t attach to Netflix.\n" +
          "👉 Try reloading the page and opening this panel again.",
      };
    }
  }

  return resp;
}

async function showOnboardingIfNeeded() {
  const stored = await chrome.storage.local.get([ONBOARDING_KEY]);
  const seen = Boolean(stored[ONBOARDING_KEY]);
  const card = $("onboarding");
  if (!card) return;

  if (!seen) {
    card.classList.remove("hidden");
    await chrome.storage.local.set({ [ONBOARDING_KEY]: true });
  }
}

async function refreshFromContent(tabId) {
  setSpinner(true);
  setSmallStatus("Connecting to Netflix…");

  const resp = await sendMessage(tabId, { type: "NSPLUS_PING" });

  setSpinner(false);

  if (!resp.ok) {
    setSmallStatus("");
    setStatus(resp.error, false);
    return null;
  }

  const s = resp.state || {};
  $("offsetMs").value = Number(s.offsetMs ?? 0);
  const offsetValEl = $("offsetVal");
  if (offsetValEl) offsetValEl.textContent = Number(s.offsetMs ?? 0);

  $("fontSizePx").value = Number(s.fontSizePx ?? 36);
  $("fontSizeVal").textContent = $("fontSizePx").value;

  $("bottomPx").value = Number(s.bottomPx ?? 90);
  $("bottomVal").textContent = $("bottomPx").value;

  $("bgOpacity").value = Number(s.bgOpacity ?? 0.45);
  $("bgVal").textContent = Number($("bgOpacity").value).toFixed(2);

  const enabledText = resp.enabled ? "Enabled" : "Disabled";
  const cuesText = resp.hasCues
    ? "Subtitles loaded"
    : "No subtitles loaded yet";
  setStatus(`${enabledText}. ${cuesText}.`, true);

  // Small “debug-ish” line for power users (not scary)
  const pageHint = resp.page?.href ? resp.page.href : "";
  setSmallStatus(
    pageHint.includes("/watch/")
      ? "Tip: use /watch/ pages for best results."
      : ""
  );

  return resp;
}

async function main() {
  await showOnboardingIfNeeded();

  const tab = await getActiveTab();
  if (!tab) {
    setStatus("⚠️ No active tab found.", false);
    return;
  }

  const tabId = tab.id;
  const url = tab.url || "";

  // Helpful guidance if user isn't on Netflix
  if (!url.includes("netflix.com")) {
    setStatus("Open Netflix in the current tab, then try again.", false);
    setSmallStatus("");
  }

  // Initial ping (auto-inject if needed)
  const pingResp = await refreshFromContent(tabId);
  CURRENT_TITLE_KEY = pingResp?.page?.titleKey || null;

  // Load and display previously loaded subtitle info for this title
  async function restoreLoadedSubtitleDisplay() {
    if (!CURRENT_TITLE_KEY) return;
    const stored = await chrome.storage.local.get([LOADED_SUBTITLE_KEY]);
    const map = stored[LOADED_SUBTITLE_KEY] || {};
    const loaded = map[CURRENT_TITLE_KEY];
    if (loaded && loaded.fileName) {
      $(
        "fileStatus"
      ).textContent = `✓ Loaded ${loaded.fileName} (${loaded.cues} cues)`;
    }
  }

  await restoreLoadedSubtitleDisplay();

  // Buttons: Reload Netflix + Help
  $("reloadNetflixBtn").addEventListener("click", async () => {
    try {
      await chrome.tabs.reload(tabId);
      setStatus("Reloading Netflix… reopen this panel in a second.", true);
      setSmallStatus("");
    } catch (e) {
      setStatus(`⚠️ Couldn’t reload the tab: ${String(e)}`, false);
    }
  });

  $("helpBtn").addEventListener("click", async () => {
    // Show onboarding card again
    const card = $("onboarding");
    if (card) card.classList.toggle("hidden");
  });

  $("enableBtn").addEventListener("click", async () => {
    setSpinner(true);
    const resp = await sendMessage(tabId, {
      type: "NSPLUS_SET_ENABLED",
      enabled: true,
    });
    setSpinner(false);
    setStatus(resp.ok ? "Enabled." : resp.error, resp.ok);
  });

  $("disableBtn").addEventListener("click", async () => {
    setSpinner(true);
    const resp = await sendMessage(tabId, {
      type: "NSPLUS_SET_ENABLED",
      enabled: false,
    });
    setSpinner(false);
    setStatus(resp.ok ? "Disabled." : resp.error, resp.ok);
    // Clear the loaded subtitle display when user disables
    // (but keep it in storage in case they re-enable)
  });

  $("fileInput").addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;

    try {
      setSpinner(true);
      setSmallStatus("Reading file…");
      const text = await readFileAsText(file);

      if (!text || text.trim().length === 0) {
        throw new Error("File is empty");
      }

      setSmallStatus("Loading subtitles…");
      const resp = await sendMessage(tabId, {
        type: "NSPLUS_LOAD_SUBTITLES",
        text,
        fileName: file.name,
      });

      setSpinner(false);
      setSmallStatus("");

      if (resp.ok) {
        const statusText = `✓ Loaded ${file.name} (${resp.cues} cues)`;
        $("fileStatus").textContent = statusText;
        setStatus("Subtitles loaded and enabled.", true);
        // Save the loaded subtitle info to storage (per-title)
        try {
          if (!CURRENT_TITLE_KEY) {
            const ping = await refreshFromContent(tabId);
            CURRENT_TITLE_KEY = ping?.page?.titleKey || CURRENT_TITLE_KEY;
          }
          const stored = await chrome.storage.local.get([LOADED_SUBTITLE_KEY]);
          const map = stored[LOADED_SUBTITLE_KEY] || {};
          map[CURRENT_TITLE_KEY] = {
            fileName: file.name,
            text,
            cues: resp.cues,
            timestamp: Date.now(),
          };
          await chrome.storage.local.set({ [LOADED_SUBTITLE_KEY]: map });
        } catch (e) {
          console.warn("Failed to save loaded subtitle info", e);
        }
      } else {
        $("fileStatus").textContent = `✗ Failed to load`;
        setStatus(resp.error, false);
      }
    } catch (err) {
      setSpinner(false);
      setSmallStatus("");
      $("fileStatus").textContent = `✗ Error loading file`;
      setStatus(`⚠️ File error: ${String(err)}`, false);
    }
  });

  $("clearSubtitleBtn").addEventListener("click", async () => {
    try {
      setSpinner(true);
      // Clear the cues from memory
      await sendMessage(tabId, {
        type: "NSPLUS_CLEAR_CUES",
      });
      // Clear the stored subtitle info for this title only
      try {
        const stored = await chrome.storage.local.get([LOADED_SUBTITLE_KEY]);
        const map = stored[LOADED_SUBTITLE_KEY] || {};
        if (CURRENT_TITLE_KEY && map[CURRENT_TITLE_KEY]) {
          delete map[CURRENT_TITLE_KEY];
          const empty = Object.keys(map).length === 0;
          if (empty) {
            await chrome.storage.local.remove([LOADED_SUBTITLE_KEY]);
          } else {
            await chrome.storage.local.set({ [LOADED_SUBTITLE_KEY]: map });
          }
        }
      } catch (e) {
        console.warn("Failed to clear stored subtitle info", e);
      }
      $("fileInput").value = ""; // Clear file input
      $("fileStatus").textContent = "No file loaded";
      setStatus("Subtitles cleared.", true);
      setSpinner(false);
    } catch (err) {
      setSpinner(false);
      setStatus(`⚠️ Error clearing subtitles: ${String(err)}`, false);
    }
  });

  const applySettings = async () => {
    const offsetMsVal = Number($("offsetMs").value || 0);
    const settings = {
      offsetMs: offsetMsVal,
      fontSizePx: Number($("fontSizePx").value || 36),
      bottomPx: Number($("bottomPx").value || 90),
      bgOpacity: Number($("bgOpacity").value || 0.45),
    };

    console.log(
      "applySettings called with offsetMs:",
      offsetMsVal,
      "settings:",
      settings
    );

    // Update display values
    const offsetValEl = $("offsetVal");
    if (offsetValEl) offsetValEl.textContent = settings.offsetMs;

    const fontSizeValEl = $("fontSizeVal");
    if (fontSizeValEl) fontSizeValEl.textContent = settings.fontSizePx;

    const bottomValEl = $("bottomVal");
    if (bottomValEl) bottomValEl.textContent = settings.bottomPx;

    const bgValEl = $("bgVal");
    if (bgValEl) bgValEl.textContent = settings.bgOpacity.toFixed(2);

    setSpinner(true);
    const resp = await sendMessage(tabId, {
      type: "NSPLUS_UPDATE_SETTINGS",
      settings,
    });
    setSpinner(false);

    console.log("applySettings response:", resp);
    setStatus(resp.ok ? `Settings applied.` : resp.error, resp.ok);
  };

  const offsetMsEl = $("offsetMs");
  if (offsetMsEl) {
    offsetMsEl.addEventListener("input", applySettings);
  }

  // languageLabel UI removed

  const fontSizePxEl = $("fontSizePx");
  if (fontSizePxEl) {
    fontSizePxEl.addEventListener("input", applySettings);
  }

  const bottomPxEl = $("bottomPx");
  if (bottomPxEl) {
    bottomPxEl.addEventListener("input", applySettings);
  }

  const bgOpacityEl = $("bgOpacity");
  if (bgOpacityEl) {
    bgOpacityEl.addEventListener("input", applySettings);
  }

  const resetOffsetBtn = $("resetOffsetBtn");
  if (resetOffsetBtn) {
    resetOffsetBtn.addEventListener("click", async () => {
      const offsetMsEl = $("offsetMs");
      if (offsetMsEl) {
        offsetMsEl.value = 0;
      }
      const offsetValEl = $("offsetVal");
      if (offsetValEl) {
        offsetValEl.textContent = 0;
      }

      setSpinner(true);
      const resp = await sendMessage(tabId, {
        type: "NSPLUS_UPDATE_SETTINGS",
        settings: {
          offsetMs: 0,
          fontSizePx: Number($("fontSizePx").value || 36),
          bottomPx: Number($("bottomPx").value || 90),
          bgOpacity: Number($("bgOpacity").value || 0.45),
        },
      });
      setSpinner(false);
      setStatus(resp.ok ? "Offset reset to 0 ms." : resp.error, resp.ok);
    });
  }
}

main();

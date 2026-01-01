// popup.js

const ONBOARDING_KEY = "nsplus_seen_onboarding";
const LOADED_SUBTITLE_KEY = "nsplus_loaded_subtitle";

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
  $("languageLabel").value = String(s.languageLabel ?? "External");

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
  await refreshFromContent(tabId);

  // Load and display previously loaded subtitle info
  async function restoreLoadedSubtitleDisplay() {
    const stored = await chrome.storage.local.get([LOADED_SUBTITLE_KEY]);
    const loaded = stored[LOADED_SUBTITLE_KEY];
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

      const languageLabel = $("languageLabel").value.trim() || "External";

      setSmallStatus("Loading subtitles…");
      const resp = await sendMessage(tabId, {
        type: "NSPLUS_LOAD_SUBTITLES",
        text,
        fileName: file.name,
        languageLabel,
      });

      setSpinner(false);
      setSmallStatus("");

      if (resp.ok) {
        const statusText = `✓ Loaded ${file.name} (${resp.cues} cues)`;
        $("fileStatus").textContent = statusText;
        setStatus("Subtitles loaded and enabled.", true);
        // Save the loaded subtitle info to storage
        await chrome.storage.local.set({
          [LOADED_SUBTITLE_KEY]: {
            fileName: file.name,
            cues: resp.cues,
            timestamp: Date.now(),
          },
        });
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
      // Send message to disable subtitles
      await sendMessage(tabId, {
        type: "NSPLUS_SET_ENABLED",
        enabled: false,
      });
      // Clear the stored subtitle info
      await chrome.storage.local.remove([LOADED_SUBTITLE_KEY]);
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
    const scope = $("scope").value;
    const settings = {
      offsetMs: Number($("offsetMs").value || 0),
      fontSizePx: Number($("fontSizePx").value || 36),
      bottomPx: Number($("bottomPx").value || 90),
      bgOpacity: Number($("bgOpacity").value || 0.45),
      languageLabel: $("languageLabel").value.trim() || "External",
    };

    $("fontSizeVal").textContent = settings.fontSizePx;
    $("bottomVal").textContent = settings.bottomPx;
    $("bgVal").textContent = settings.bgOpacity.toFixed(2);

    setSpinner(true);
    const resp = await sendMessage(tabId, {
      type: "NSPLUS_UPDATE_SETTINGS",
      settings,
      scope,
    });
    setSpinner(false);

    setStatus(resp.ok ? `Settings applied (${scope}).` : resp.error, resp.ok);
  };

  $("offsetMs").addEventListener("change", applySettings);
  $("languageLabel").addEventListener("change", applySettings);
  $("fontSizePx").addEventListener("input", applySettings);
  $("bottomPx").addEventListener("input", applySettings);
  $("bgOpacity").addEventListener("input", applySettings);

  $("scope").addEventListener("change", () => {
    setStatus("Scope changed. Next adjustment will save to that scope.", true);
  });
}

main();

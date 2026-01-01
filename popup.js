// popup.js

function $(id) {
  return document.getElementById(id);
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab && tab.id ? tab : null;
}

function setStatus(text, ok = true) {
  const el = $("status");
  el.textContent = text;
  el.style.color = ok ? "#d7fbd7" : "#ffd0d0";
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
        if (err) resolve({ ok: false, error: err.message });
        else resolve(resp || { ok: false, error: "No response" });
      });
    });

  let resp = await attempt();
  if (resp.ok) return resp;

  // If receiver doesn't exist, inject and retry
  const isNoReceiver =
    (resp.error || "").includes("Receiving end does not exist") ||
    (resp.error || "").includes("Could not establish connection");

  if (injectOnFail && isNoReceiver) {
    try {
      await injectIfNeeded(tabId);
      resp = await attempt();
      return resp;
    } catch (e) {
      return { ok: false, error: `Inject failed: ${String(e)}` };
    }
  }

  return resp;
}

async function refreshFromContent(tabId) {
  const resp = await sendMessage(tabId, { type: "NSPLUS_PING" });
  if (!resp.ok) {
    setStatus("Open a Netflix tab (netflix.com) and try again.", false);
    return;
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

  setStatus(
    resp.enabled ? "Enabled on this page." : "Disabled on this page.",
    true
  );
}

async function main() {
  const tab = await getActiveTab();
  if (!tab) {
    setStatus("No active tab found.", false);
    return;
  }

  const tabId = tab.id;

  // Ping (auto-inject if needed)
  await refreshFromContent(tabId);

  $("enableBtn").addEventListener("click", async () => {
    const resp = await sendMessage(tabId, {
      type: "NSPLUS_SET_ENABLED",
      enabled: true,
    });
    setStatus(resp.ok ? "Enabled." : `Enable failed: ${resp.error}`, resp.ok);
  });

  $("disableBtn").addEventListener("click", async () => {
    const resp = await sendMessage(tabId, {
      type: "NSPLUS_SET_ENABLED",
      enabled: false,
    });
    setStatus(resp.ok ? "Disabled." : `Disable failed: ${resp.error}`, resp.ok);
  });

  $("fileInput").addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;

    try {
      const text = await readFileAsText(file);
      const languageLabel = $("languageLabel").value.trim() || "External";

      const resp = await sendMessage(tabId, {
        type: "NSPLUS_LOAD_SUBTITLES",
        text,
        fileName: file.name,
        languageLabel,
      });

      if (resp.ok) {
        $("fileStatus").textContent = `Loaded ${file.name} (${resp.cues} cues)`;
        setStatus("Subtitles loaded and enabled.", true);
      } else {
        setStatus(`Load failed: ${resp.error}`, false);
      }
    } catch (err) {
      setStatus(`File read failed: ${String(err)}`, false);
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

    const resp = await sendMessage(tabId, {
      type: "NSPLUS_UPDATE_SETTINGS",
      settings,
      scope,
    });

    setStatus(
      resp.ok
        ? `Settings applied (${scope}).`
        : `Settings failed: ${resp.error}`,
      resp.ok
    );
  };

  $("offsetMs").addEventListener("change", applySettings);
  $("languageLabel").addEventListener("change", applySettings);
  $("fontSizePx").addEventListener("input", applySettings);
  $("bottomPx").addEventListener("input", applySettings);
  $("bgOpacity").addEventListener("input", applySettings);

  $("scope").addEventListener("change", () => {
    setStatus("Scope changed. Next adjustment will save to that scope.");
  });
}

main();

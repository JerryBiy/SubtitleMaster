// content.js
(() => {
  // Prevent double-injection if popup injects while content_scripts already ran
  if (window.__NSPLUS_LOADED__) return;
  window.__NSPLUS_LOADED__ = true;

  const STATE = {
    cues: [],
    cueIndex: 0,
    enabled: false,
    languageLabel: "External",
    offsetMs: 0,
    fontSizePx: 36,
    bottomPx: 90,
    bgOpacity: 0.45,
  };

  const STORAGE_KEYS = {
    GLOBAL_SETTINGS: "nsplus_global_settings",
    PER_TITLE: "nsplus_per_title",
  };

  let overlayRoot = null;
  let subtitleBox = null;
  let rafId = null;
  let lastVideo = null;

  function getTitleKey() {
    const m = location.pathname.match(/\/watch\/(\d+)/);
    return m ? `watch:${m[1]}` : `page:${location.pathname}`;
  }

  async function loadStoredSettings() {
    const titleKey = getTitleKey();
    const stored = await chrome.storage.local.get([
      STORAGE_KEYS.GLOBAL_SETTINGS,
      STORAGE_KEYS.PER_TITLE,
    ]);

    const global = stored[STORAGE_KEYS.GLOBAL_SETTINGS] || {};
    const perTitle = stored[STORAGE_KEYS.PER_TITLE] || {};
    const t = perTitle[titleKey] || {};

    STATE.offsetMs = t.offsetMs ?? global.offsetMs ?? STATE.offsetMs;
    STATE.fontSizePx = t.fontSizePx ?? global.fontSizePx ?? STATE.fontSizePx;
    STATE.bottomPx = t.bottomPx ?? global.bottomPx ?? STATE.bottomPx;
    STATE.bgOpacity = t.bgOpacity ?? global.bgOpacity ?? STATE.bgOpacity;
    STATE.languageLabel =
      t.languageLabel ?? global.languageLabel ?? STATE.languageLabel;

    applyStyles();
  }

  async function saveSettings({ scope = "title" } = {}) {
    const titleKey = getTitleKey();
    const stored = await chrome.storage.local.get([
      STORAGE_KEYS.GLOBAL_SETTINGS,
      STORAGE_KEYS.PER_TITLE,
    ]);

    const global = stored[STORAGE_KEYS.GLOBAL_SETTINGS] || {};
    const perTitle = stored[STORAGE_KEYS.PER_TITLE] || {};

    const payload = {
      offsetMs: STATE.offsetMs,
      fontSizePx: STATE.fontSizePx,
      bottomPx: STATE.bottomPx,
      bgOpacity: STATE.bgOpacity,
      languageLabel: STATE.languageLabel,
    };

    if (scope === "global") {
      await chrome.storage.local.set({
        [STORAGE_KEYS.GLOBAL_SETTINGS]: { ...global, ...payload },
      });
    } else {
      perTitle[titleKey] = { ...(perTitle[titleKey] || {}), ...payload };
      await chrome.storage.local.set({ [STORAGE_KEYS.PER_TITLE]: perTitle });
    }
  }

  function ensureOverlay() {
    if (overlayRoot && subtitleBox) return;

    overlayRoot = document.createElement("div");
    overlayRoot.id = "nsplus-overlay-root";
    overlayRoot.style.position = "fixed";
    overlayRoot.style.left = "0";
    overlayRoot.style.top = "0";
    overlayRoot.style.width = "100vw";
    overlayRoot.style.height = "100vh";
    overlayRoot.style.zIndex = "999999";
    overlayRoot.style.pointerEvents = "none";
    overlayRoot.style.display = "flex";
    overlayRoot.style.justifyContent = "center";
    overlayRoot.style.alignItems = "flex-end";
    overlayRoot.style.padding = "0 6vw";

    subtitleBox = document.createElement("div");
    subtitleBox.id = "nsplus-subtitle-box";
    subtitleBox.style.maxWidth = "1200px";
    subtitleBox.style.textAlign = "center";
    subtitleBox.style.whiteSpace = "pre-line";
    subtitleBox.style.fontFamily = "Arial, Helvetica, sans-serif";
    subtitleBox.style.fontWeight = "600";
    subtitleBox.style.textShadow = "0 2px 6px rgba(0,0,0,0.8)";
    subtitleBox.style.borderRadius = "10px";
    subtitleBox.style.padding = "10px 14px";

    overlayRoot.appendChild(subtitleBox);
    document.documentElement.appendChild(overlayRoot);

    applyStyles();
  }

  function applyStyles() {
    if (!subtitleBox) return;
    subtitleBox.style.fontSize = `${STATE.fontSizePx}px`;
    subtitleBox.style.marginBottom = `${STATE.bottomPx}px`;
    subtitleBox.style.background = `rgba(0,0,0,${STATE.bgOpacity})`;
    subtitleBox.style.color = "white";
  }

  function findVideoElement() {
    // Netflix may have multiple videos; pick visible/large one
    const videos = document.querySelectorAll("video");
    for (const v of videos) {
      const r = v.getBoundingClientRect();
      if (r.width > 200 && r.height > 200) return v;
    }
    return null;
  }

  function getActiveCueIndex(cues, t, startIndex) {
    if (!cues.length) return 0;

    let i = Math.max(0, Math.min(startIndex, cues.length - 1));
    if (cues[i] && cues[i].start <= t && t <= cues[i].end) return i;

    while (i + 1 < cues.length && cues[i + 1].start <= t) {
      i++;
      if (cues[i].start <= t && t <= cues[i].end) return i;
    }

    while (i - 1 >= 0 && cues[i - 1].end >= t) {
      i--;
      if (cues[i].start <= t && t <= cues[i].end) return i;
    }

    let lo = 0,
      hi = cues.length - 1,
      ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].start <= t) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans;
  }

  function renderLoop() {
    ensureOverlay();

    if (!STATE.enabled || !subtitleBox) {
      rafId = requestAnimationFrame(renderLoop);
      return;
    }

    const video = findVideoElement();
    if (!video) {
      subtitleBox.textContent = "";
      rafId = requestAnimationFrame(renderLoop);
      return;
    }

    if (video !== lastVideo) {
      lastVideo = video;
      STATE.cueIndex = 0;
    }

    const t = video.currentTime + STATE.offsetMs / 1000;
    const cues = STATE.cues;

    if (!cues.length) {
      subtitleBox.textContent = "";
      rafId = requestAnimationFrame(renderLoop);
      return;
    }

    const idx = getActiveCueIndex(cues, t, STATE.cueIndex);
    STATE.cueIndex = idx;

    const cue = cues[idx];
    const active = cue && cue.start <= t && t <= cue.end;

    subtitleBox.textContent = active ? cue.text : "";

    rafId = requestAnimationFrame(renderLoop);
  }

  function enable() {
    if (STATE.enabled) return;
    STATE.enabled = true;
    ensureOverlay();
    if (!rafId) rafId = requestAnimationFrame(renderLoop);
  }

  function disable() {
    STATE.enabled = false;
    if (subtitleBox) subtitleBox.textContent = "";
  }

  function setCues(cues) {
    STATE.cues = cues || [];
    STATE.cueIndex = 0;
  }

  function onKeyDown(e) {
    const tag =
      e.target && e.target.tagName ? e.target.tagName.toLowerCase() : "";
    if (tag === "input" || tag === "textarea" || e.isComposing) return;

    if (e.key === "[") {
      STATE.offsetMs -= 250;
      saveSettings({ scope: "title" });
    } else if (e.key === "]") {
      STATE.offsetMs += 250;
      saveSettings({ scope: "title" });
    } else if (e.key === "\\") {
      STATE.offsetMs = 0;
      saveSettings({ scope: "title" });
    }
  }

  // Netflix SPA navigation hook
  function hookHistory() {
    const push = history.pushState;
    const replace = history.replaceState;

    function onChange() {
      window.dispatchEvent(new Event("nsplus:navigation"));
    }

    history.pushState = function () {
      push.apply(this, arguments);
      onChange();
    };

    history.replaceState = function () {
      replace.apply(this, arguments);
      onChange();
    };

    window.addEventListener("popstate", onChange);
  }

  async function handleNavigation() {
    // Called whenever Netflix SPA changes routes
    lastVideo = null;
    STATE.cueIndex = 0;
    await loadStoredSettings();
    ensureOverlay();
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        if (!msg || !msg.type) return;

        if (msg.type === "NSPLUS_PING") {
          sendResponse({
            ok: true,
            enabled: STATE.enabled,
            hasCues: STATE.cues.length > 0,
            state: STATE,
          });
          return;
        }

        if (msg.type === "NSPLUS_SET_ENABLED") {
          msg.enabled ? enable() : disable();
          sendResponse({ ok: true });
          return;
        }

        if (msg.type === "NSPLUS_LOAD_SUBTITLES") {
          const { text, fileName, languageLabel } = msg;
          const cues = window.SubtitleParser.parseSubtitles(text, fileName);
          STATE.languageLabel = languageLabel || STATE.languageLabel;
          setCues(cues);
          enable();
          await saveSettings({ scope: "title" });
          sendResponse({ ok: true, cues: cues.length });
          return;
        }

        if (msg.type === "NSPLUS_UPDATE_SETTINGS") {
          const s = msg.settings || {};
          if (typeof s.offsetMs === "number") STATE.offsetMs = s.offsetMs;
          if (typeof s.fontSizePx === "number") STATE.fontSizePx = s.fontSizePx;
          if (typeof s.bottomPx === "number") STATE.bottomPx = s.bottomPx;
          if (typeof s.bgOpacity === "number") STATE.bgOpacity = s.bgOpacity;
          if (typeof s.languageLabel === "string")
            STATE.languageLabel = s.languageLabel;

          applyStyles();
          await saveSettings({
            scope: msg.scope === "global" ? "global" : "title",
          });
          sendResponse({ ok: true });
          return;
        }
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  });

  async function init() {
    hookHistory();
    window.addEventListener("nsplus:navigation", handleNavigation);

    await loadStoredSettings();
    ensureOverlay();
    document.addEventListener("keydown", onKeyDown, true);

    if (!rafId) rafId = requestAnimationFrame(renderLoop);

    // Also react to DOM changes (Netflix frequently rebuilds player)
    const mo = new MutationObserver(() => {
      const v = findVideoElement();
      if (v && v !== lastVideo) {
        lastVideo = v;
        STATE.cueIndex = 0;
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }

  init();
})();

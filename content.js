// content.js
(() => {
  if (window.__NSPLUS_LOADED__) return;
  window.__NSPLUS_LOADED__ = true;

  const EXT_VERSION = "0.3.0";

  const STATE = {
    cues: [],
    cueIndex: 0,
    enabled: false,
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

  async function loadStoredSettings(resetOffset = false) {
    const titleKey = getTitleKey();
    const stored = await chrome.storage.local.get([
      STORAGE_KEYS.GLOBAL_SETTINGS,
      STORAGE_KEYS.PER_TITLE,
    ]);

    const global = stored[STORAGE_KEYS.GLOBAL_SETTINGS] || {};
    const perTitle = stored[STORAGE_KEYS.PER_TITLE] || {};
    const t = perTitle[titleKey] || {};

    // offsetMs is not persisted to storage, so it defaults to 0
    if (resetOffset) {
      STATE.offsetMs = 0;
    }
    STATE.fontSizePx = t.fontSizePx ?? global.fontSizePx ?? STATE.fontSizePx;
    STATE.bottomPx = t.bottomPx ?? global.bottomPx ?? STATE.bottomPx;
    STATE.bgOpacity = t.bgOpacity ?? global.bgOpacity ?? STATE.bgOpacity;

    applyStyles();
  }

  async function saveSettings({ scope = "title", skipOffset = false } = {}) {
    const titleKey = getTitleKey();
    const stored = await chrome.storage.local.get([
      STORAGE_KEYS.GLOBAL_SETTINGS,
      STORAGE_KEYS.PER_TITLE,
    ]);

    const global = stored[STORAGE_KEYS.GLOBAL_SETTINGS] || {};
    const perTitle = stored[STORAGE_KEYS.PER_TITLE] || {};

    // Don't include offsetMs in storage unless explicitly needed
    const payload = {
      fontSizePx: STATE.fontSizePx,
      bottomPx: STATE.bottomPx,
      bgOpacity: STATE.bgOpacity,
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
    subtitleBox.style.display = "none";

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
      subtitleBox.style.display = "none";
      rafId = requestAnimationFrame(renderLoop);
      return;
    }

    if (video !== lastVideo) {
      lastVideo = video;
      STATE.cueIndex = 0;
      STATE.cues = [];
    }

    const t = video.currentTime + STATE.offsetMs / 1000;
    const cues = STATE.cues;

    if (!cues.length) {
      subtitleBox.textContent = "";
      subtitleBox.style.display = "none";
      rafId = requestAnimationFrame(renderLoop);
      return;
    }

    const idx = getActiveCueIndex(cues, t, STATE.cueIndex);
    STATE.cueIndex = idx;

    const cue = cues[idx];
    const active = cue && cue.start <= t && t <= cue.end;
    subtitleBox.textContent = active ? cue.text : "";
    subtitleBox.style.display = active && cue.text ? "block" : "none";

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
    if (subtitleBox) {
      subtitleBox.textContent = "";
      subtitleBox.style.display = "none";
    }
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
    lastVideo = null;
    STATE.cueIndex = 0;
    STATE.offsetMs = 0;
    await loadStoredSettings(true);
    // try to load any stored subtitle for the new title
    try {
      const stored = await chrome.storage.local.get(["nsplus_loaded_subtitle"]);
      const map = stored["nsplus_loaded_subtitle"] || {};
      const entry = map[getTitleKey()];
      if (entry && entry.text) {
        const cues = window.SubtitleParser.parseSubtitles(
          entry.text,
          entry.fileName || "",
        );
        if (Array.isArray(cues) && cues.length) {
          setCues(cues);
          enable();
        } else {
          setCues([]);
        }
      } else {
        setCues([]);
      }
    } catch (e) {
      // ignore storage errors
    }
    ensureOverlay();
  }

  // ===== Online subtitle search (OpenSubtitles via background SW) =====

  function detectTitleInfo() {
    const info = {
      title: "",
      season: null,
      episode: null,
      year: null,
      type: "movie",
    };

    // Try Netflix player overlay first (most reliable while watching)
    const videoTitleEl = document.querySelector('[data-uia="video-title"]');
    if (videoTitleEl) {
      // Show titles: <h4>Show Name</h4><span>S1:E3 Episode Name</span>
      const heading = videoTitleEl.querySelector("h4, h1, .title");
      const spans = videoTitleEl.querySelectorAll("span");
      if (heading && heading.textContent.trim()) {
        info.title = heading.textContent.trim();
      } else {
        info.title = (videoTitleEl.textContent || "").trim();
      }
      // Look for SxEy pattern in any span
      for (const sp of spans) {
        const t = sp.textContent || "";
        const m = t.match(/S(\d+)\s*[:\.\-E]\s*E?(\d+)/i);
        if (m) {
          info.season = Number(m[1]);
          info.episode = Number(m[2]);
          info.type = "episode";
          break;
        }
      }
    }

    // Fallback: parse document.title — typically "Show Title | Netflix"
    if (!info.title) {
      const docTitle = (document.title || "")
        .replace(/\s*\|\s*Netflix.*$/i, "")
        .trim();
      if (docTitle) info.title = docTitle;
    }

    // Strip "Watch " prefix Netflix sometimes adds
    info.title = info.title.replace(/^Watch\s+/i, "").trim();

    // Try to extract year if present in title like "Movie (2019)"
    const ym = info.title.match(/\((\d{4})\)/);
    if (ym) {
      info.year = Number(ym[1]);
      info.title = info.title.replace(/\s*\(\d{4}\)\s*/, "").trim();
    }

    if (info.season && info.episode) info.type = "episode";
    return info;
  }

  let modalRoot = null;

  function closeOnlineModal() {
    if (modalRoot && modalRoot.parentNode) {
      modalRoot.parentNode.removeChild(modalRoot);
    }
    modalRoot = null;
  }

  function buildOnlineModal() {
    closeOnlineModal();

    modalRoot = document.createElement("div");
    modalRoot.id = "nsplus-online-modal-root";
    Object.assign(modalRoot.style, {
      position: "fixed",
      inset: "0",
      zIndex: "2147483647",
      background: "rgba(0,0,0,0.65)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontFamily: "Arial, Helvetica, sans-serif",
      color: "#e7e7e7",
    });
    modalRoot.addEventListener("click", (e) => {
      if (e.target === modalRoot) closeOnlineModal();
    });

    const panel = document.createElement("div");
    Object.assign(panel.style, {
      width: "min(720px, 92vw)",
      maxHeight: "84vh",
      background: "#161922",
      borderRadius: "12px",
      boxShadow: "0 20px 60px rgba(0,0,0,0.6)",
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
      border: "1px solid rgba(255,255,255,0.08)",
    });

    // Header
    const header = document.createElement("div");
    Object.assign(header.style, {
      padding: "14px 16px",
      borderBottom: "1px solid rgba(255,255,255,0.08)",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: "10px",
    });
    const h = document.createElement("div");
    h.textContent = "Find subtitles online";
    h.style.fontSize = "15px";
    h.style.fontWeight = "700";
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "✕";
    Object.assign(closeBtn.style, {
      background: "transparent",
      border: "none",
      color: "#bbb",
      fontSize: "18px",
      cursor: "pointer",
      padding: "4px 8px",
    });
    closeBtn.addEventListener("click", closeOnlineModal);
    header.appendChild(h);
    header.appendChild(closeBtn);

    // Detected title row
    const info = detectTitleInfo();
    const detected = document.createElement("div");
    Object.assign(detected.style, {
      padding: "10px 16px",
      fontSize: "12px",
      opacity: "0.85",
      borderBottom: "1px solid rgba(255,255,255,0.06)",
    });
    const titleLine = info.title
      ? `Detected: <b>${escapeHtml(info.title)}</b>${
          info.type === "episode" && info.season != null
            ? ` — S${info.season}E${info.episode}`
            : ""
        }${info.year ? ` (${info.year})` : ""}`
      : "Could not detect title from this Netflix page.";
    detected.innerHTML = titleLine;

    // Controls row (language + search)
    const controls = document.createElement("div");
    Object.assign(controls.style, {
      padding: "10px 16px",
      display: "grid",
      gridTemplateColumns: "1fr 140px 110px",
      gap: "8px",
      alignItems: "center",
      borderBottom: "1px solid rgba(255,255,255,0.06)",
    });
    const searchInput = document.createElement("input");
    searchInput.type = "text";
    searchInput.placeholder = "Title (auto-filled)";
    searchInput.value = info.title || "";
    Object.assign(searchInput.style, inputStyle());

    const langSelect = document.createElement("select");
    Object.assign(langSelect.style, inputStyle());
    [
      ["en", "English"],
      ["es", "Spanish"],
      ["fr", "French"],
      ["de", "German"],
      ["pt", "Portuguese"],
      ["it", "Italian"],
      ["ja", "Japanese"],
      ["ko", "Korean"],
      ["zh", "Chinese"],
      ["ru", "Russian"],
      ["ar", "Arabic"],
      ["", "Any"],
    ].forEach(([v, lbl]) => {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = lbl;
      langSelect.appendChild(o);
    });
    // Default: UI language → en fallback
    const uiLang = (chrome.i18n.getUILanguage() || "en").slice(0, 2);
    langSelect.value = [
      "en",
      "es",
      "fr",
      "de",
      "pt",
      "it",
      "ja",
      "ko",
      "zh",
      "ru",
      "ar",
    ].includes(uiLang)
      ? uiLang
      : "en";

    const searchBtn = document.createElement("button");
    searchBtn.textContent = "Search";
    Object.assign(searchBtn.style, primaryBtnStyle());

    controls.appendChild(searchInput);
    controls.appendChild(langSelect);
    controls.appendChild(searchBtn);

    // Results area
    const list = document.createElement("div");
    Object.assign(list.style, {
      flex: "1 1 auto",
      overflowY: "auto",
      padding: "8px 8px",
      minHeight: "180px",
    });

    // Status / footer
    const status = document.createElement("div");
    Object.assign(status.style, {
      padding: "10px 16px",
      fontSize: "12px",
      borderTop: "1px solid rgba(255,255,255,0.08)",
      minHeight: "18px",
      opacity: "0.9",
    });

    panel.appendChild(header);
    panel.appendChild(detected);
    panel.appendChild(controls);
    panel.appendChild(list);
    panel.appendChild(status);
    modalRoot.appendChild(panel);
    document.documentElement.appendChild(modalRoot);

    function setStatus(text, ok = true) {
      status.textContent = text || "";
      status.style.color = ok ? "#d7fbd7" : "#ffd0d0";
    }

    function clearList() {
      while (list.firstChild) list.removeChild(list.firstChild);
    }

    function renderEmpty(message) {
      clearList();
      const d = document.createElement("div");
      d.style.padding = "24px";
      d.style.textAlign = "center";
      d.style.opacity = "0.7";
      d.style.fontSize = "13px";
      d.textContent = message;
      list.appendChild(d);
    }

    function renderResults(results) {
      clearList();
      if (!results.length) {
        renderEmpty("No subtitles found. Try adjusting the title or language.");
        return;
      }
      for (const r of results) {
        const row = document.createElement("div");
        Object.assign(row.style, {
          padding: "10px 12px",
          margin: "4px 6px",
          background: "rgba(255,255,255,0.04)",
          borderRadius: "8px",
          display: "grid",
          gridTemplateColumns: "1fr auto",
          gap: "10px",
          alignItems: "center",
        });

        const meta = document.createElement("div");
        meta.style.minWidth = "0";
        const name = document.createElement("div");
        name.style.fontSize = "13px";
        name.style.fontWeight = "600";
        name.style.overflow = "hidden";
        name.style.textOverflow = "ellipsis";
        name.style.whiteSpace = "nowrap";
        name.textContent = r.file_name || r.release || "(unnamed)";
        const sub = document.createElement("div");
        sub.style.fontSize = "11px";
        sub.style.opacity = "0.75";
        sub.style.marginTop = "3px";
        const badges = [];
        if (r.language) badges.push(r.language.toUpperCase());
        if (r.from_trusted) badges.push("✓ Trusted");
        if (r.hd) badges.push("HD");
        if (r.download_count) badges.push(`↓ ${r.download_count}`);
        if (r.fps) badges.push(`${r.fps}fps`);
        if (r.uploader) badges.push(`@${r.uploader}`);
        sub.textContent = badges.join("  ·  ");
        meta.appendChild(name);
        meta.appendChild(sub);

        const useBtn = document.createElement("button");
        useBtn.textContent = "Use";
        Object.assign(useBtn.style, primaryBtnStyle());
        useBtn.addEventListener("click", () => onPickResult(r, useBtn));

        row.appendChild(meta);
        row.appendChild(useBtn);
        list.appendChild(row);
      }
    }

    async function doSearch() {
      const query = (searchInput.value || "").trim();
      if (!query) {
        setStatus("Enter a title to search.", false);
        return;
      }
      const lang = langSelect.value || "";
      setStatus("Searching…");
      renderEmpty("Searching…");

      const params = { query, languages: lang || undefined, type: info.type };
      if (info.year) params.year = info.year;
      if (info.type === "episode") {
        if (info.season != null) params.season_number = info.season;
        if (info.episode != null) params.episode_number = info.episode;
      }

      const resp = await chrome.runtime
        .sendMessage({ type: "NSPLUS_OS_SEARCH", params })
        .catch((e) => ({ ok: false, error: String(e) }));

      if (!resp || !resp.ok) {
        if (resp && resp.error === "MISSING_API_KEY") {
          renderApiKeyPrompt();
          setStatus("OpenSubtitles API key required.", false);
        } else {
          renderEmpty("Search failed.");
          setStatus(`Error: ${(resp && resp.error) || "unknown"}`, false);
        }
        return;
      }
      renderResults(resp.results || []);
      setStatus(`${(resp.results || []).length} result(s).`);
    }

    async function onPickResult(r, btn) {
      if (!r.file_id) {
        setStatus("This result has no downloadable file_id.", false);
        return;
      }
      const original = btn.textContent;
      btn.textContent = "Downloading…";
      btn.disabled = true;
      setStatus("Downloading subtitle…");

      const resp = await chrome.runtime
        .sendMessage({
          type: "NSPLUS_OS_DOWNLOAD",
          params: { file_id: r.file_id },
        })
        .catch((e) => ({ ok: false, error: String(e) }));

      btn.textContent = original;
      btn.disabled = false;

      if (!resp || !resp.ok) {
        setStatus(
          `Download failed: ${(resp && resp.error) || "unknown"}`,
          false,
        );
        return;
      }

      try {
        const cues = window.SubtitleParser.parseSubtitles(
          resp.text,
          resp.fileName || "subtitle.srt",
        );
        if (!Array.isArray(cues) || cues.length === 0) {
          setStatus("Downloaded file had no parseable cues.", false);
          return;
        }
        setCues(cues);
        enable();
        await saveSettings({ scope: "title" });

        // Persist for restore on navigation
        try {
          const stored = await chrome.storage.local.get([
            "nsplus_loaded_subtitle",
          ]);
          const map = stored["nsplus_loaded_subtitle"] || {};
          map[getTitleKey()] = {
            fileName: resp.fileName,
            text: resp.text,
            cues: cues.length,
            timestamp: Date.now(),
            source: "opensubtitles",
          };
          await chrome.storage.local.set({ nsplus_loaded_subtitle: map });
        } catch (_e) {}

        const remainStr =
          typeof resp.remaining === "number"
            ? ` · ${resp.remaining} downloads left today`
            : "";
        setStatus(`✓ Loaded ${cues.length} cues${remainStr}.`);
        setTimeout(closeOnlineModal, 900);
      } catch (e) {
        setStatus(`Parse error: ${String(e)}`, false);
      }
    }

    function renderApiKeyPrompt() {
      clearList();
      const wrap = document.createElement("div");
      wrap.style.padding = "20px";
      wrap.style.fontSize = "13px";
      wrap.style.lineHeight = "1.5";
      wrap.innerHTML =
        '<div style="font-weight:700;margin-bottom:8px">OpenSubtitles API key required</div>' +
        '<div style="opacity:0.85;margin-bottom:10px">Get a free key at ' +
        '<a href="https://www.opensubtitles.com/en/consumers" target="_blank" style="color:#7eaaff">opensubtitles.com/consumers</a>, ' +
        "then paste it below or in the extension popup settings.</div>";

      const keyInput = document.createElement("input");
      keyInput.type = "password";
      keyInput.placeholder = "Paste API key";
      Object.assign(keyInput.style, inputStyle(), { marginTop: "6px" });

      const saveBtn = document.createElement("button");
      saveBtn.textContent = "Save key";
      Object.assign(saveBtn.style, primaryBtnStyle(), { marginTop: "10px" });
      saveBtn.addEventListener("click", async () => {
        const k = (keyInput.value || "").trim();
        if (!k) return;
        const r = await chrome.runtime
          .sendMessage({ type: "NSPLUS_OS_SET_KEY", key: k })
          .catch((e) => ({ ok: false, error: String(e) }));
        if (r && r.ok) {
          setStatus("Key saved. Searching…");
          doSearch();
        } else {
          setStatus("Failed to save key.", false);
        }
      });

      wrap.appendChild(keyInput);
      wrap.appendChild(saveBtn);
      list.appendChild(wrap);
    }

    searchBtn.addEventListener("click", doSearch);
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") doSearch();
    });

    // Auto-search if we have a title
    if (info.title) {
      doSearch();
    } else {
      renderEmpty("Type a title above and click Search.");
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function inputStyle() {
    return {
      width: "100%",
      boxSizing: "border-box",
      border: "1px solid rgba(255,255,255,0.12)",
      background: "rgba(255,255,255,0.06)",
      color: "#fff",
      borderRadius: "8px",
      padding: "8px 10px",
      outline: "none",
      fontSize: "13px",
    };
  }

  function primaryBtnStyle() {
    return {
      border: "none",
      borderRadius: "8px",
      padding: "8px 14px",
      cursor: "pointer",
      background: "#4c7dff",
      color: "white",
      fontWeight: "700",
      fontSize: "13px",
    };
  }

  // ===== End online subtitle search =====

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        if (!msg || !msg.type) return;

        if (msg.type === "NSPLUS_OPEN_ONLINE_MODAL") {
          buildOnlineModal();
          sendResponse({ ok: true });
          return;
        }

        if (msg.type === "NSPLUS_DETECT_TITLE") {
          sendResponse({ ok: true, info: detectTitleInfo() });
          return;
        }

        if (msg.type === "NSPLUS_PING") {
          sendResponse({
            ok: true,
            version: EXT_VERSION,
            page: { href: location.href, titleKey: getTitleKey() },
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
          const { text, fileName } = msg;
          try {
            if (!text || typeof text !== "string") {
              throw new Error(
                chrome.i18n.getMessage("noFileLoaded") ||
                  "Invalid subtitle text: not a string or empty",
              );
            }
            const cues = window.SubtitleParser.parseSubtitles(text, fileName);
            if (!Array.isArray(cues)) {
              throw new Error(
                chrome.i18n.getMessage("fileNotLoaded") ||
                  "Parser returned invalid cues format",
              );
            }
            if (cues.length === 0) {
              throw new Error(
                chrome.i18n.getMessage("fileNotLoaded") ||
                  "No subtitles found in file. Check file format and encoding.",
              );
            }
            setCues(cues);
            enable();
            await saveSettings({ scope: "title" });
            sendResponse({ ok: true, cues: cues.length });
            return;
          } catch (parseErr) {
            sendResponse({
              ok: false,
              error: `Failed to parse subtitles: ${String(parseErr)}`,
            });
            return;
          }
        }

        if (msg.type === "NSPLUS_UPDATE_SETTINGS") {
          const s = msg.settings || {};
          if (typeof s.offsetMs === "number") STATE.offsetMs = s.offsetMs;
          if (typeof s.fontSizePx === "number") STATE.fontSizePx = s.fontSizePx;
          if (typeof s.bottomPx === "number") STATE.bottomPx = s.bottomPx;
          if (typeof s.bgOpacity === "number") STATE.bgOpacity = s.bgOpacity;
          // languageLabel removed

          applyStyles();
          await saveSettings({
            scope: msg.scope === "global" ? "global" : "title",
          });
          sendResponse({ ok: true });
          return;
        }

        if (msg.type === "NSPLUS_CLEAR_CUES") {
          setCues([]);
          disable();
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
    // On initial load, try to restore any stored subtitle for this title
    try {
      const stored = await chrome.storage.local.get(["nsplus_loaded_subtitle"]);
      const map = stored["nsplus_loaded_subtitle"] || {};
      const entry = map[getTitleKey()];
      if (entry && entry.text) {
        const cues = window.SubtitleParser.parseSubtitles(
          entry.text,
          entry.fileName || "",
        );
        if (Array.isArray(cues) && cues.length) {
          setCues(cues);
          enable();
        }
      }
    } catch (e) {
      // ignore
    }
    document.addEventListener("keydown", onKeyDown, true);

    if (!rafId) rafId = requestAnimationFrame(renderLoop);

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

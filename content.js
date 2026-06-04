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

  // Junk strings that should never be treated as a real show/movie title.
  const TITLE_BLOCKLIST = new Set([
    "netflix",
    "watch",
    "home",
    "browse",
    "loading",
    "",
  ]);

  function isJunkTitle(t) {
    if (!t) return true;
    const lower = t.trim().toLowerCase();
    if (TITLE_BLOCKLIST.has(lower)) return true;
    // "Netflix - Watch TV Shows Online…" style site tagline.
    if (/^netflix\b.*\b(watch|shows|movies|tv)\b/i.test(t)) return true;
    return false;
  }

  function cleanTitle(t) {
    if (!t) return "";
    let s = String(t).trim();
    s = s.replace(/^Watch\s+/i, "");
    s = s.replace(/\s*[\|\-–—]\s*Netflix.*$/i, "");
    s = s.replace(/\s*\|\s*Official\s+Netflix\s+Site\s*$/i, "");
    return s.trim();
  }

  function detectTitleInfoOnce() {
    const info = {
      title: "",
      season: null,
      episode: null,
      year: null,
      type: "movie",
    };

    // 1) Netflix player overlay (most reliable while watching)
    const videoTitleEl = document.querySelector('[data-uia="video-title"]');
    if (videoTitleEl) {
      const heading = videoTitleEl.querySelector("h4, h1, .title");
      let candidate = "";
      if (heading && heading.textContent.trim()) {
        candidate = heading.textContent.trim();
      } else {
        candidate = (videoTitleEl.textContent || "").trim();
      }
      candidate = cleanTitle(candidate);
      if (!isJunkTitle(candidate)) info.title = candidate;

      // Netflix shows episode info in sibling spans. Formats vary widely:
      //   "S1:E1", "S01E01", "Season 1: Episode 1", "E1", "Episode 1".
      const overlayText = videoTitleEl.textContent || "";
      const sxe = overlayText.match(
        /S(?:eason)?\s*(\d{1,2})\s*[:\.\-x]?\s*E(?:p|pisode)?\s*(\d{1,3})/i,
      );
      if (sxe) {
        info.season = Number(sxe[1]);
        info.episode = Number(sxe[2]);
        info.type = "episode";
      } else {
        // Episode-only (Netflix sometimes hides the season): assume S1.
        const epOnly = overlayText.match(
          /(?:^|\s)E(?:p|pisode)?\s*[:\.]?\s*(\d{1,3})(?:\s|$|\.)/i,
        );
        if (epOnly) {
          info.season = 1;
          info.episode = Number(epOnly[1]);
          info.type = "episode";
        }
      }
    }

    // 2) Title card on mini-player / details modal
    if (!info.title) {
      const altSel = [
        '[data-uia="title-card-title"]',
        '[data-uia="previewModal--title"]',
        ".title-card-title",
        ".previewModal--player_title h3",
        ".previewModal--section-header h2",
      ];
      for (const sel of altSel) {
        const el = document.querySelector(sel);
        const c = el && cleanTitle(el.textContent || "");
        if (c && !isJunkTitle(c)) {
          info.title = c;
          break;
        }
      }
    }

    // 3) <meta property="og:title">
    if (!info.title) {
      const og =
        document.querySelector('meta[property="og:title"]') ||
        document.querySelector('meta[name="title"]');
      const c = og && cleanTitle(og.getAttribute("content") || "");
      if (c && !isJunkTitle(c)) info.title = c;
    }

    // 4) document.title (last resort — most likely to be junk on Netflix)
    if (!info.title) {
      const c = cleanTitle(document.title || "");
      if (c && !isJunkTitle(c)) info.title = c;
    }

    // Year in parens
    const ym = info.title.match(/\((\d{4})\)/);
    if (ym) {
      info.year = Number(ym[1]);
      info.title = info.title.replace(/\s*\(\d{4}\)\s*/, "").trim();
    }

    if (info.season && info.episode) info.type = "episode";
    return info;
  }

  // Wraps the single-shot detector with a short poll, because the Netflix
  // player overlay can take 1–2s to render after the page loads.
  async function detectTitleInfo({ waitMs = 2500 } = {}) {
    const start = Date.now();
    let info = detectTitleInfoOnce();
    while (
      (!info.title || isJunkTitle(info.title)) &&
      Date.now() - start < waitMs
    ) {
      await new Promise((r) => setTimeout(r, 200));
      info = detectTitleInfoOnce();
    }
    // Final sanity: if still junk, blank it so the UI prompts the user.
    if (isJunkTitle(info.title)) info.title = "";
    return info;
  }

  let modalRoot = null;
  let modalEscHandler = null;
  let modalSurvivor = null; // MutationObserver that re-attaches modal if Netflix SPA removes it

  function closeOnlineModal() {
    if (modalEscHandler) {
      document.removeEventListener("keydown", modalEscHandler, true);
      modalEscHandler = null;
    }
    if (modalSurvivor) {
      modalSurvivor.disconnect();
      modalSurvivor = null;
    }
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
    // Modal stays open until the user explicitly closes it (✕ Close button
    // or Escape key). Clicking the backdrop no longer dismisses it.
    modalEscHandler = (e) => {
      if (e.key === "Escape" && modalRoot) {
        e.stopPropagation();
        e.preventDefault();
        closeOnlineModal();
      }
    };
    document.addEventListener("keydown", modalEscHandler, true);

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
    closeBtn.textContent = "✕ Close";
    closeBtn.title = "Close (Esc)";
    Object.assign(closeBtn.style, {
      background: "rgba(255,255,255,0.10)",
      border: "1px solid rgba(255,255,255,0.15)",
      color: "#fff",
      fontSize: "13px",
      fontWeight: "600",
      cursor: "pointer",
      padding: "6px 12px",
      borderRadius: "6px",
    });
    closeBtn.addEventListener("mouseenter", () => {
      closeBtn.style.background = "rgba(255,80,80,0.85)";
    });
    closeBtn.addEventListener("mouseleave", () => {
      closeBtn.style.background = "rgba(255,255,255,0.10)";
    });
    closeBtn.addEventListener("click", closeOnlineModal);
    header.appendChild(h);
    header.appendChild(closeBtn);

    // Detected title row
    // Use a fast synchronous attempt first so the modal renders immediately;
    // then refine asynchronously (the player overlay may not be in the DOM yet).
    const info = detectTitleInfoOnce();
    if (isJunkTitle(info.title)) info.title = "";
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

    // Variant chips — populated by renderVariantChips() after a search.
    const chips = document.createElement("div");
    Object.assign(chips.style, {
      padding: "0 16px 8px",
      display: "none",
      flexWrap: "wrap",
      gap: "6px",
      fontSize: "11px",
    });

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
      // Inherited white-on-transparent from the styled <select> renders
      // unreadable in the OS dropdown; force dark background + light text.
      o.style.background = "#161922";
      o.style.color = "#e7e7e7";
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
    panel.appendChild(chips);
    panel.appendChild(controls);
    panel.appendChild(list);
    panel.appendChild(status);
    modalRoot.appendChild(panel);
    document.documentElement.appendChild(modalRoot);

    // If Netflix's SPA tries to wipe our modal (e.g. on player teardown),
    // re-attach it so it survives navigations until the user closes it.
    modalSurvivor = new MutationObserver(() => {
      if (modalRoot && !document.documentElement.contains(modalRoot)) {
        document.documentElement.appendChild(modalRoot);
      }
    });
    modalSurvivor.observe(document.documentElement, {
      childList: true,
      subtree: false,
    });

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

    function sourceBadge(src) {
      const label =
        src === "opensubtitles"
          ? "OpenSubs"
          : src === "assrt"
            ? "Assrt"
            : src === "subdl"
              ? "Subdl"
              : src;
      const color =
        src === "opensubtitles"
          ? "#4c7dff"
          : src === "assrt"
            ? "#e6651a"
            : src === "subdl"
              ? "#1aa66e"
              : "#666";
      const span = document.createElement("span");
      span.textContent = label;
      Object.assign(span.style, {
        background: color,
        color: "white",
        fontSize: "10px",
        fontWeight: "700",
        padding: "2px 6px",
        borderRadius: "4px",
        marginRight: "6px",
        verticalAlign: "middle",
      });
      return span;
    }

    function renderResults(results, counts) {
      clearList();
      if (!results.length) {
        renderEmpty("No subtitles found. Try adjusting the title or language.");
        return;
      }
      // Optional: small header row with per-source counts
      if (counts) {
        const summary = document.createElement("div");
        Object.assign(summary.style, {
          padding: "6px 12px",
          fontSize: "11px",
          opacity: "0.7",
        });
        const parts = [];
        if (counts.opensubtitles != null)
          parts.push(`OpenSubs: ${counts.opensubtitles}`);
        if (counts.assrt != null) parts.push(`Assrt: ${counts.assrt}`);
        if (counts.subdl != null) parts.push(`Subdl: ${counts.subdl}`);
        summary.textContent = parts.join("  ·  ");
        list.appendChild(summary);
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
        name.appendChild(sourceBadge(r.source));
        const nameText = document.createElement("span");
        nameText.textContent = r.file_name || r.release || "(unnamed)";
        name.appendChild(nameText);

        const sub = document.createElement("div");
        sub.style.fontSize = "11px";
        sub.style.opacity = "0.75";
        sub.style.marginTop = "3px";
        const badges = [];
        if (r.language_desc) badges.push(r.language_desc);
        else if (r.language) badges.push(r.language.toUpperCase());
        if (r.from_trusted) badges.push("✓ Trusted");
        if (r.hd) badges.push("HD");
        if (r.download_count) badges.push(`↓ ${r.download_count}`);
        if (r.fps) badges.push(`${r.fps}fps`);
        if (r.uploader) badges.push(`@${r.uploader}`);
        if (r._matched_variant) badges.push(`“${r._matched_variant}”`);
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

    function scriptOf(s) {
      if (!s) return "latin";
      if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(s)) return "cjk-han";
      if (/[\u3040-\u30ff]/.test(s)) return "ja";
      if (/[\uac00-\ud7af]/.test(s)) return "ko";
      if (/[\u0400-\u04ff]/.test(s)) return "cyrillic";
      if (/[\u0600-\u06ff]/.test(s)) return "arabic";
      return "latin";
    }

    // Build a set of search tokens from the variants so we can filter out
    // unrelated provider results. OpenSubtitles in particular falls back to
    // popularity-ranked junk when given a query in a non-Latin script.
    function buildVariantTokens(variants) {
      const tokens = new Set();
      const phrases = [];
      const stop = new Set([
        "the",
        "a",
        "an",
        "of",
        "and",
        "or",
        "to",
        "in",
        "on",
        "for",
        "with",
        "is",
        "movie",
        "film",
        "series",
        "season",
        "tv",
        "part",
        "vol",
        "volume",
      ]);
      for (const v of variants || []) {
        const s = (v || "").trim();
        if (!s) continue;
        phrases.push(s.toLowerCase());
        // Split into word-like tokens (works for Latin/Cyrillic/etc.)
        for (const tok of s.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
          // Require >= 4 chars so articles (los, las, el, der, …) don't
          // match every unrelated release.
          if (tok.length >= 4 && !stop.has(tok)) tokens.add(tok);
        }
        // CJK substring tokens (3-grams) for Chinese/Japanese/Korean.
        if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(s)) {
          const clean = s.replace(/\s+/g, "");
          if (clean.length >= 2) tokens.add(clean);
        }
      }
      return { tokens: Array.from(tokens), phrases };
    }

    function filterByRelevance(results, variants) {
      const { tokens, phrases } = buildVariantTokens(variants);
      if (!tokens.length && !phrases.length) return results;
      return results.filter((r) => {
        // IMPORTANT: do NOT include _matched_variant here — that's the
        // query we *sent* to the provider, not what the file actually
        // contains. Including it would let every result trivially pass.
        const hay = (
          (r.file_name || "") +
          " " +
          (r.release || "")
        ).toLowerCase();
        if (!hay.trim()) return false;
        for (const p of phrases) if (p && hay.includes(p)) return true;
        for (const t of tokens) if (hay.includes(t)) return true;
        return false;
      });
    }

    // Detect the language Netflix's UI (and thus the detected title) is in.
    // Used only to recognize which variant is the "native" one; the search
    // itself always prefers the English title because OpenSubtitles indexes
    // English titles far more reliably.
    function detectNetflixLang() {
      const htmlLang = (document.documentElement.lang || "").toLowerCase();
      if (htmlLang) return htmlLang.split("-")[0];
      const nav = (navigator.language || "").toLowerCase();
      return nav ? nav.split("-")[0] : "";
    }

    function prioritizeVariants(variants, original, lang) {
      const seen = new Set();
      const unique = [];
      for (const v of [original, ...variants]) {
        const k = (v || "").trim().toLowerCase();
        if (!k || seen.has(k)) continue;
        seen.add(k);
        unique.push(v.trim());
      }
      const nfLang = detectNetflixLang();
      const langScript =
        {
          zh: "cjk-han",
          ja: "ja",
          ko: "ko",
          ru: "cyrillic",
          ar: "arabic",
        }[lang || nfLang] || "latin";

      // Score: lower = better.
      // 1. The English / Latin-script title wins outright — OpenSubtitles has
      //    by far the best coverage for English titles, so it should be the
      //    primary query (variants[0]).
      // 2. The user's typed/detected title comes next (respect their intent).
      // 3. A variant matching the selected (or Netflix UI) language follows.
      const scored = unique.map((v, i) => {
        let score = 0;
        const sc = scriptOf(v);
        if (sc === "latin") score -= 100; // English title — top priority
        if (i === 0) score -= 40; // the title the user is looking at
        if (sc === langScript && langScript !== "latin") score -= 30;
        return { v, score };
      });
      scored.sort((a, b) => a.score - b.score);
      return scored.map((s) => s.v);
    }

    function renderVariantChips(variants, original) {
      chips.innerHTML = "";
      if (!variants || variants.length <= 1) {
        chips.style.display = "none";
        return;
      }
      chips.style.display = "flex";
      const label = document.createElement("span");
      label.textContent = "Tried:";
      label.style.opacity = "0.6";
      label.style.alignSelf = "center";
      chips.appendChild(label);
      variants.forEach((v) => {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.textContent = v;
        chip.title = `Search only “${v}”`;
        Object.assign(chip.style, {
          background: "rgba(255,255,255,0.08)",
          border: "1px solid rgba(255,255,255,0.15)",
          color: "#e7e7e7",
          borderRadius: "999px",
          padding: "2px 10px",
          fontSize: "11px",
          cursor: "pointer",
        });
        chip.addEventListener("click", () => {
          searchInput.value = v;
          doSearch({ singleVariant: true });
        });
        chips.appendChild(chip);
      });
    }

    async function doSearch(opts = {}) {
      const query = (searchInput.value || "").trim();
      if (!query) {
        setStatus("Enter a title to search.", false);
        return;
      }
      const lang = langSelect.value || "";
      const forceSingle = !!opts.singleVariant; // when user clicks a chip

      // Step 1: get variants unless caller asked for a single-variant search.
      let variants = [query];
      if (!forceSingle) {
        setStatus("Looking up title variants…");
        renderEmpty("Looking up title variants…");
        try {
          const vr = await chrome.runtime.sendMessage({
            type: "NSPLUS_GET_VARIANTS",
            params: { query, year: info.year, type: info.type },
          });
          if (vr && vr.ok && Array.isArray(vr.variants) && vr.variants.length) {
            variants = vr.variants;
          }
        } catch (_e) {}

        // Reorder: the user's typed query first, then any variant in a
        // matching script (Latin / CJK / Cyrillic / Arabic), then the rest.
        // Limit to 4 to avoid diluting OpenSubtitles relevance ranking.
        variants = prioritizeVariants(variants, query, lang).slice(0, 4);
      }

      // Surface the variants as clickable chips so the user can re-run
      // search with just one if auto-merge gives noisy results.
      renderVariantChips(variants, query);

      setStatus(
        variants.length > 1
          ? `Searching ${variants.length} title variants…`
          : `Searching “${variants[0]}”…`,
      );
      renderEmpty("Searching…");

      const baseParams = { type: info.type };
      if (info.year) baseParams.year = info.year;
      if (info.type === "episode") {
        if (info.season != null) baseParams.season_number = info.season;
        if (info.episode != null) baseParams.episode_number = info.episode;
      }

      const sendSearch = (langs) =>
        chrome.runtime
          .sendMessage({
            type: "NSPLUS_SEARCH_ALL",
            params: {
              ...baseParams,
              variants,
              query: variants[0],
              languages: langs || undefined,
            },
          })
          .catch((e) => ({ ok: false, error: String(e) }));

      let resp = await sendSearch(lang || undefined);
      let triedAnyLang = false;

      if (!resp || !resp.ok) {
        renderEmpty("Search failed.");
        setStatus(`Error: ${(resp && resp.error) || "unknown"}`, false);
        return;
      }

      let results = resp.results || [];

      // Client-side language filter — providers don't all honor it strictly.
      const filterByLang = (rs) => {
        if (!lang) return rs;
        const want = lang.toLowerCase();
        const wantFamily = want.split("-")[0];
        return rs.filter((r) => {
          const l = (r.language || "").toLowerCase();
          return (
            l === want || l === wantFamily || l.startsWith(wantFamily + "-")
          );
        });
      };

      let filtered = filterByLang(results);

      // Auto-fallback: if nothing matched the requested language, retry without
      // a language filter so the user at least sees alternatives.
      if (lang && filtered.length === 0 && results.length === 0) {
        triedAnyLang = true;
        setStatus(
          `No results in ${lang.toUpperCase()}. Retrying with any language…`,
        );
        resp = await sendSearch(undefined);
        if (resp && resp.ok) {
          results = resp.results || [];
          filtered = results;
        }
      }

      const finalResults = filtered.length ? filtered : results;
      const relevant = filterByRelevance(finalResults, variants);
      const displayResults = relevant.length ? relevant : finalResults;
      const droppedCount = finalResults.length - relevant.length;
      renderResults(displayResults, resp.counts);

      const errParts = Object.entries(resp.errors || {})
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}: ${String(v).slice(0, 40)}`);
      const variantNote =
        variants.length > 1
          ? ` · Tried titles: ${variants.slice(0, 5).join(" / ")}${variants.length > 5 ? "…" : ""}`
          : "";
      const fallbackNote = triedAnyLang ? " · Showing all languages." : "";

      if (finalResults.length) {
        const dropNote =
          droppedCount > 0 ? ` · Hid ${droppedCount} unrelated.` : "";
        setStatus(
          `${displayResults.length} result(s).${variantNote}${fallbackNote}${dropNote}${
            errParts.length
              ? "  (Some providers failed: " + errParts.join("; ") + ")"
              : ""
          }`,
        );
      } else {
        setStatus(
          (errParts.length
            ? `No results. ${errParts.join("; ")}`
            : "No results.") + variantNote,
          false,
        );
      }
    }

    async function onPickResult(r, btn) {
      if (!r.payload) {
        setStatus("This result has no download payload.", false);
        return;
      }
      const original = btn.textContent;
      btn.textContent = "Downloading…";
      btn.disabled = true;
      setStatus("Downloading subtitle…");

      const resp = await chrome.runtime
        .sendMessage({
          type: "NSPLUS_DOWNLOAD",
          params: { source: r.source, payload: r.payload },
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
            source: r.source,
          };
          await chrome.storage.local.set({ nsplus_loaded_subtitle: map });
        } catch (_e) {}

        const remainStr =
          typeof resp.remaining === "number"
            ? ` · ${resp.remaining} OS downloads left today`
            : "";
        setStatus(
          `✓ Loaded ${cues.length} cues${remainStr}. You can pick another or close this dialog.`,
        );
        // Modal stays open; user closes it explicitly via the Close button or Esc.
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

    // Auto-search if we have a title; otherwise wait briefly for Netflix's
    // player overlay to render and re-detect.
    if (info.title) {
      doSearch();
    } else {
      renderEmpty("Detecting title…");
      detectTitleInfo({ waitMs: 3000 }).then((better) => {
        if (!modalRoot) return; // user closed modal already
        if (better.title) {
          info.title = better.title;
          info.season = better.season;
          info.episode = better.episode;
          info.year = better.year;
          info.type = better.type;
          searchInput.value = better.title;
          detected.innerHTML = `Detected: <b>${escapeHtml(better.title)}</b>${
            better.type === "episode" && better.season != null
              ? ` — S${better.season}E${better.episode}`
              : ""
          }${better.year ? ` (${better.year})` : ""}`;
          doSearch();
        } else {
          renderEmpty(
            "Couldn't detect a title. Type one above and click Search.",
          );
          detected.innerHTML =
            "Could not detect a title from this Netflix page. Type one below.";
        }
      });
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

  // chrome.runtime can be undefined when this script is injected into a
  // sandboxed iframe (e.g. ad/player frames) or after the extension context
  // is invalidated by a reload. Guard so we don't throw on load.
  if (chrome && chrome.runtime && chrome.runtime.onMessage) {
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
            const info = await detectTitleInfo();
            sendResponse({ ok: true, info });
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
            if (typeof s.fontSizePx === "number")
              STATE.fontSizePx = s.fontSizePx;
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
  }

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

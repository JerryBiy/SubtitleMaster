// background.js — MV3 service worker
// Proxies OpenSubtitles REST API calls so content scripts avoid CORS issues
// and so the API key never leaks into page context.

const OS_API_BASE = "https://api.opensubtitles.com/api/v1";
const OS_USER_AGENT = "SubtitleMaster v0.4.0";
const API_KEY_STORAGE = "nsplus_os_api_key";

// Default OpenSubtitles consumer API key shipped with the extension so
// "Browse online subtitles" works out of the box with zero setup.
// Users can override it from popup settings to use their own quota.
//
// WARNING: This value is visible to anyone who unpacks the extension or
// reads the repo. If this repository becomes public, consider moving the
// key to a gitignored file and/or rotating it at
// https://www.opensubtitles.com/en/consumers
const DEFAULT_API_KEY = "S6JQDn2GK3eYJQXvAZPyOfxIiqbOqBzm";

async function getApiKey() {
  const stored = await chrome.storage.local.get([API_KEY_STORAGE]);
  const userKey = (stored[API_KEY_STORAGE] || "").trim();
  return userKey || DEFAULT_API_KEY;
}

function buildHeaders(apiKey) {
  return {
    "Api-Key": apiKey,
    "Content-Type": "application/json",
    "User-Agent": OS_USER_AGENT,
    Accept: "application/json",
  };
}

async function searchSubtitles(params) {
  const apiKey = await getApiKey();
  if (!apiKey) {
    return {
      ok: false,
      error: "MISSING_API_KEY",
    };
  }

  const qs = new URLSearchParams();
  if (params.query) qs.set("query", params.query);
  if (params.languages) qs.set("languages", params.languages);
  if (params.year) qs.set("year", String(params.year));
  if (params.season_number)
    qs.set("season_number", String(params.season_number));
  if (params.episode_number)
    qs.set("episode_number", String(params.episode_number));
  if (params.type) qs.set("type", params.type); // movie | episode
  qs.set("order_by", "download_count");
  qs.set("order_direction", "desc");

  const url = `${OS_API_BASE}/subtitles?${qs.toString()}`;
  let resp;
  try {
    resp = await fetch(url, { method: "GET", headers: buildHeaders(apiKey) });
  } catch (e) {
    return { ok: false, error: `Network error: ${String(e)}` };
  }

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    return { ok: false, error: `HTTP ${resp.status}: ${txt.slice(0, 200)}` };
  }

  const json = await resp.json().catch(() => null);
  if (!json || !Array.isArray(json.data)) {
    return { ok: false, error: "Unexpected API response" };
  }

  const results = json.data.map((row) => {
    const a = row.attributes || {};
    const file = (a.files && a.files[0]) || {};
    return {
      id: row.id,
      file_id: file.file_id,
      file_name: file.file_name || a.release || "",
      language: a.language || "",
      release: a.release || "",
      download_count: a.download_count || 0,
      ratings: a.ratings || 0,
      from_trusted: !!a.from_trusted,
      hd: !!a.hd,
      fps: a.fps || null,
      feature_title:
        (a.feature_details && a.feature_details.movie_name) ||
        (a.feature_details && a.feature_details.title) ||
        "",
      season_number: a.feature_details && a.feature_details.season_number,
      episode_number: a.feature_details && a.feature_details.episode_number,
      uploader: (a.uploader && a.uploader.name) || "",
    };
  });

  return { ok: true, results };
}

// Best-effort decoder: tries UTF-8, falls back to windows-1252 if replacement chars appear.
function decodeBytes(buffer) {
  const tryDecode = (label) => {
    try {
      const dec = new TextDecoder(label, { fatal: false });
      return dec.decode(buffer);
    } catch (_e) {
      return null;
    }
  };
  const utf8 = tryDecode("utf-8");
  if (utf8 && !utf8.includes("\uFFFD")) return utf8;
  const cp1252 = tryDecode("windows-1252");
  if (cp1252) return cp1252;
  return utf8 || "";
}

async function downloadSubtitle({ file_id }) {
  const apiKey = await getApiKey();
  if (!apiKey) return { ok: false, error: "MISSING_API_KEY" };
  if (!file_id) return { ok: false, error: "Missing file_id" };

  let resp;
  try {
    resp = await fetch(`${OS_API_BASE}/download`, {
      method: "POST",
      headers: buildHeaders(apiKey),
      body: JSON.stringify({ file_id }),
    });
  } catch (e) {
    return { ok: false, error: `Network error: ${String(e)}` };
  }

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    return {
      ok: false,
      error: `Download request HTTP ${resp.status}: ${txt.slice(0, 200)}`,
    };
  }

  const meta = await resp.json().catch(() => null);
  if (!meta || !meta.link) {
    return { ok: false, error: "No download link returned" };
  }

  let fileResp;
  try {
    fileResp = await fetch(meta.link, { method: "GET" });
  } catch (e) {
    return { ok: false, error: `Failed to fetch subtitle file: ${String(e)}` };
  }

  if (!fileResp.ok) {
    return {
      ok: false,
      error: `Subtitle file HTTP ${fileResp.status}`,
    };
  }

  const buf = await fileResp.arrayBuffer();
  const text = decodeBytes(buf);
  const fileName = meta.file_name || "subtitle.srt";

  return {
    ok: true,
    text,
    fileName,
    remaining: meta.remaining,
    resetTime: meta.reset_time,
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === "NSPLUS_OS_SEARCH") {
    searchSubtitles(msg.params || {}).then(sendResponse);
    return true;
  }

  if (msg.type === "NSPLUS_OS_DOWNLOAD") {
    downloadSubtitle(msg.params || {}).then(sendResponse);
    return true;
  }

  if (msg.type === "NSPLUS_OS_GET_KEY") {
    chrome.storage.local.get([API_KEY_STORAGE]).then((stored) => {
      const userKey = (stored[API_KEY_STORAGE] || "").trim();
      sendResponse({
        ok: true,
        hasUserKey: !!userKey,
        hasDefaultKey: !!DEFAULT_API_KEY,
        keyPreview: userKey
          ? userKey.slice(0, 4) + "…" + userKey.slice(-4)
          : "",
      });
    });
    return true;
  }

  if (msg.type === "NSPLUS_OS_SET_KEY") {
    const key = String(msg.key || "").trim();
    chrome.storage.local
      .set({ [API_KEY_STORAGE]: key })
      .then(() => sendResponse({ ok: true }));
    return true;
  }
});

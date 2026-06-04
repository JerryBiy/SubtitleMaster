// background.js — MV3 service worker
// Multi-provider subtitle search proxy. Handles:
//   - OpenSubtitles (REST API, JSON)
//   - Assrt (REST API, best for Chinese subs)
//   - Subdl  (REST API, returns ZIPs which we unpack inline)
//
// All API calls happen here so the content script avoids CORS and the API
// keys never reach page context.

// ============ CONFIG / KEYS ============
// WARNING: These default keys are visible to anyone who unpacks the
// extension or reads the repo. If this repo becomes public, rotate them
// and/or move them to a gitignored config file.

const OS_API_BASE = "https://api.opensubtitles.com/api/v1";
const OS_USER_AGENT = "SubtitleMaster v0.5.0";
const OS_DEFAULT_KEY = "S6JQDn2GK3eYJQXvAZPyOfxIiqbOqBzm";
const OS_KEY_STORAGE = "nsplus_os_api_key";

const ASSRT_API_BASE = "https://api.assrt.net/v1";
const ASSRT_DEFAULT_TOKEN = "VpvnwrkYNmiwcU8RwWv2kxM52o2BKZGS";

const SUBDL_API_BASE = "https://api.subdl.com/api/v1";
const SUBDL_DL_BASE = "https://dl.subdl.com";
const SUBDL_DEFAULT_KEY = "subdl_wcVIs6-yRQa2o-7t05KnJbt-7V2E066L5n3-iwgDu8w";

// ============ KEY STORAGE (OpenSubtitles override only for now) ============
async function getOsKey() {
  const stored = await chrome.storage.local.get([OS_KEY_STORAGE]);
  const userKey = (stored[OS_KEY_STORAGE] || "").trim();
  return userKey || OS_DEFAULT_KEY;
}

// ============ TEXT DECODE ============
// Tries UTF-8, then GB18030 (Simplified/Traditional Chinese), then windows-1252.
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
  const gb = tryDecode("gb18030");
  if (gb && !gb.includes("\uFFFD")) return gb;
  const cp1252 = tryDecode("windows-1252");
  if (cp1252) return cp1252;
  return utf8 || "";
}

// ============ MINIMAL ZIP EXTRACTOR ============
// Walks local file headers; supports stored (0) and deflate (8).
async function extractZip(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const u8 = new Uint8Array(arrayBuffer);
  const entries = [];
  let p = 0;

  while (p + 30 <= view.byteLength) {
    const sig = view.getUint32(p, true);
    if (sig !== 0x04034b50) break;

    const method = view.getUint16(p + 8, true);
    const compSize = view.getUint32(p + 18, true);
    const uncompSize = view.getUint32(p + 22, true);
    const nameLen = view.getUint16(p + 26, true);
    const extraLen = view.getUint16(p + 28, true);

    const nameBytes = u8.slice(p + 30, p + 30 + nameLen);
    const name = new TextDecoder("utf-8", { fatal: false }).decode(nameBytes);
    const dataStart = p + 30 + nameLen + extraLen;
    const dataEnd = dataStart + compSize;
    const data = u8.slice(dataStart, dataEnd);

    let bytes;
    if (method === 0) {
      bytes = data;
    } else if (method === 8) {
      try {
        const ds = new DecompressionStream("deflate-raw");
        const stream = new Blob([data]).stream().pipeThrough(ds);
        const buf = await new Response(stream).arrayBuffer();
        bytes = new Uint8Array(buf);
      } catch (_e) {
        bytes = new Uint8Array(0);
      }
    } else {
      bytes = new Uint8Array(0);
    }

    if (name && !name.endsWith("/") && bytes.length) {
      entries.push({ name, bytes, uncompSize });
    }
    p = dataEnd;
  }
  return entries;
}

function pickBestSubtitleFromZip(entries) {
  if (!entries.length) return null;
  const subExt = /\.(srt|vtt|ass|ssa|sub)$/i;
  const subs = entries.filter((e) => subExt.test(e.name));
  if (!subs.length) return null;
  subs.sort((a, b) => {
    const aSrt = /\.srt$/i.test(a.name) ? 1 : 0;
    const bSrt = /\.srt$/i.test(b.name) ? 1 : 0;
    if (aSrt !== bSrt) return bSrt - aSrt;
    return b.uncompSize - a.uncompSize;
  });
  return subs[0];
}

async function fetchAndExtract(url, fetchInit = {}) {
  const resp = await fetch(url, fetchInit);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const buf = await resp.arrayBuffer();
  const head = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
  const isZip =
    head[0] === 0x50 &&
    head[1] === 0x4b &&
    head[2] === 0x03 &&
    head[3] === 0x04;
  if (isZip) {
    const entries = await extractZip(buf);
    const best = pickBestSubtitleFromZip(entries);
    if (!best) throw new Error("ZIP contained no subtitle file");
    return { text: decodeBytes(best.bytes.buffer), fileName: best.name };
  }
  const lastSeg = url.split("?")[0].split("/").pop() || "subtitle.srt";
  return { text: decodeBytes(buf), fileName: lastSeg };
}

// ============ OPENSUBTITLES ============
async function osSearch(params) {
  const key = await getOsKey();
  if (!key) return { ok: false, error: "MISSING_API_KEY" };

  const headers = {
    "Api-Key": key,
    "Content-Type": "application/json",
    "User-Agent": OS_USER_AGENT,
    Accept: "application/json",
  };

  // Build a query string from a subset of params so we can retry with
  // looser filters when the strict search returns nothing.
  const build = (p) => {
    const qs = new URLSearchParams();
    if (p.query) qs.set("query", p.query);
    if (p.languages) qs.set("languages", p.languages);
    if (p.year) qs.set("year", String(p.year));
    if (p.season_number) qs.set("season_number", String(p.season_number));
    if (p.episode_number) qs.set("episode_number", String(p.episode_number));
    if (p.type) qs.set("type", p.type);
    qs.set("order_by", "download_count");
    qs.set("order_direction", "desc");
    return qs.toString();
  };

  const fetchOnce = async (p) => {
    let resp;
    try {
      resp = await fetch(`${OS_API_BASE}/subtitles?${build(p)}`, { headers });
    } catch (e) {
      return { ok: false, error: `Network: ${String(e)}` };
    }
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      return {
        ok: false,
        error: `OS HTTP ${resp.status}: ${txt.slice(0, 160)}`,
      };
    }
    const json = await resp.json().catch(() => null);
    if (!json || !Array.isArray(json.data))
      return { ok: false, error: "OS bad response" };
    return { ok: true, data: json.data };
  };

  // The OpenSubtitles API matches `query` through a title parser (guessit),
  // not a release-name full-text search. A bare uncommon title token (e.g.
  // "wonderfools") returns nothing, but the SAME query WITH season/episode
  // context returns the correct results. So for episodic content we append
  // SxxEyy to the query string AND keep the structured params — this is the
  // single most reliable way to find episode subtitles via the API.
  const pad2 = (n) => String(n).padStart(2, "0");
  const sxe =
    params.season_number && params.episode_number
      ? ` S${pad2(params.season_number)}E${pad2(params.episode_number)}`
      : "";

  // Attempt 1: full context — query + SxxEyy + structured season/episode.
  let r = await fetchOnce({
    ...params,
    query: (params.query || "") + sxe,
  });

  // Attempt 2: drop the noisy year/type filters (brand-new shows are often
  // uploaded without them) but KEEP season/episode, which drive the match.
  if (r.ok && r.data.length === 0 && (params.year || params.type)) {
    const loose = { ...params, query: (params.query || "") + sxe };
    delete loose.year;
    delete loose.type;
    r = await fetchOnce(loose);
  }

  // Attempt 3: structured params only, original query (no SxxEyy appended) —
  // covers shows whose releases don't carry the SxxEyy tag.
  if (r.ok && r.data.length === 0 && sxe) {
    r = await fetchOnce({
      query: params.query,
      languages: params.languages,
      season_number: params.season_number,
      episode_number: params.episode_number,
    });
  }

  // Attempt 4: last-ditch — bare query + language (movies / season packs).
  if (
    r.ok &&
    r.data.length === 0 &&
    (params.season_number ||
      params.episode_number ||
      params.year ||
      params.type)
  ) {
    r = await fetchOnce({
      query: params.query,
      languages: params.languages,
    });
  }
  if (!r.ok) return r;

  // Episode-discovery probe: OpenSubtitles' `query` param can't find a show
  // from a bare title (it returns popularity junk). When we have NO episode
  // context (e.g. the user is browsing, not playing) and none of the results
  // we got actually relate to the title, probe the first few episodes of
  // season 1 by appending SxxEyy — this is how guessit anchors the match.
  const hasEpisodeCtx = !!(params.season_number || params.episode_number);
  if (!hasEpisodeCtx && params.query) {
    const { tokens } = tokensForQuery(params.query);
    const relevant = (rows) =>
      rows.some((row) => {
        const a = row.attributes || {};
        const file = (a.files && a.files[0]) || {};
        const hay = (
          (file.file_name || "") +
          " " +
          (a.release || "")
        ).toLowerCase();
        return tokens.some((t) => hay.includes(t));
      });

    if (tokens.length && !relevant(r.data)) {
      const probes = [];
      for (let ep = 1; ep <= 3; ep++) {
        probes.push(
          fetchOnce({
            query: `${params.query} S01E${pad2(ep)}`,
            languages: params.languages,
            season_number: 1,
            episode_number: ep,
          }),
        );
      }
      const probeResults = await Promise.all(probes);
      const merged = [];
      const seenIds = new Set();
      for (const pr of probeResults) {
        if (pr.ok) {
          for (const row of pr.data) {
            if (!seenIds.has(row.id)) {
              seenIds.add(row.id);
              merged.push(row);
            }
          }
        }
      }
      if (merged.length) r = { ok: true, data: merged };
    }
  }

  const results = r.data.map((row) => {
    const a = row.attributes || {};
    const file = (a.files && a.files[0]) || {};
    return {
      source: "opensubtitles",
      id: `os:${row.id}`,
      file_name: file.file_name || a.release || "",
      release: a.release || "",
      language: (a.language || "").toLowerCase(),
      download_count: a.download_count || 0,
      ratings: a.ratings || 0,
      from_trusted: !!a.from_trusted,
      hd: !!a.hd,
      fps: a.fps || null,
      uploader: (a.uploader && a.uploader.name) || "",
      payload: { file_id: file.file_id },
    };
  });
  return { ok: true, results };
}

async function osDownload(payload) {
  const key = await getOsKey();
  if (!key) return { ok: false, error: "MISSING_API_KEY" };
  if (!payload || !payload.file_id)
    return { ok: false, error: "Missing file_id" };

  const headers = {
    "Api-Key": key,
    "Content-Type": "application/json",
    "User-Agent": OS_USER_AGENT,
    Accept: "application/json",
  };
  let resp;
  try {
    resp = await fetch(`${OS_API_BASE}/download`, {
      method: "POST",
      headers,
      body: JSON.stringify({ file_id: payload.file_id }),
    });
  } catch (e) {
    return { ok: false, error: `Network: ${String(e)}` };
  }
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    return {
      ok: false,
      error: `OS download HTTP ${resp.status}: ${txt.slice(0, 160)}`,
    };
  }
  const meta = await resp.json().catch(() => null);
  if (!meta || !meta.link) return { ok: false, error: "OS no link" };

  try {
    const extracted = await fetchAndExtract(meta.link);
    return {
      ok: true,
      text: extracted.text,
      fileName: meta.file_name || extracted.fileName,
      remaining: meta.remaining,
    };
  } catch (e) {
    return { ok: false, error: `OS file fetch: ${String(e)}` };
  }
}

// ============ ASSRT (best for Chinese) ============
async function assrtSearch(params) {
  if (!ASSRT_DEFAULT_TOKEN) return { ok: false, error: "MISSING_ASSRT_TOKEN" };

  let q = params.query || "";
  if (
    params.type === "episode" &&
    params.season_number != null &&
    params.episode_number != null
  ) {
    const s = String(params.season_number).padStart(2, "0");
    const e = String(params.episode_number).padStart(2, "0");
    q = `${q} S${s}E${e}`.trim();
  }
  if (!q) return { ok: false, error: "Empty query" };

  const qs = new URLSearchParams({
    token: ASSRT_DEFAULT_TOKEN,
    q,
    cnt: "20",
    pos: "0",
  });

  let resp;
  try {
    resp = await fetch(`${ASSRT_API_BASE}/sub/search?${qs}`);
  } catch (e) {
    return { ok: false, error: `Network: ${String(e)}` };
  }
  if (!resp.ok) return { ok: false, error: `Assrt HTTP ${resp.status}` };
  const json = await resp.json().catch(() => null);
  if (!json || json.status !== 0)
    return { ok: false, error: `Assrt status ${json && json.status}` };

  const subs = (json.sub && json.sub.subs) || [];
  if (!Array.isArray(subs)) {
    // Assrt occasionally returns an empty string for `sub.subs` instead of [].
    return { ok: true, results: [] };
  }
  const results = subs.map((s) => {
    const langDesc = (s.lang && s.lang.desc) || "";
    let lang = "";
    if (/简体|chs|zh-cn/i.test(langDesc)) lang = "zh";
    else if (/繁体|cht|zh-tw/i.test(langDesc)) lang = "zh-tw";
    else if (/英|english/i.test(langDesc)) lang = "en";
    else if (/日|japanese/i.test(langDesc)) lang = "ja";
    else if (/韩|korean/i.test(langDesc)) lang = "ko";
    else lang = langDesc.toLowerCase();

    return {
      source: "assrt",
      id: `assrt:${s.id}`,
      file_name: s.native_name || s.videoname || "",
      release: s.videoname || "",
      language: lang,
      language_desc: langDesc,
      download_count: 0,
      ratings: s.vote_score || 0,
      from_trusted: false,
      hd: false,
      uploader: s.release_site || "",
      payload: { sub_id: s.id },
    };
  });
  return { ok: true, results };
}

async function assrtDownload(payload) {
  if (!ASSRT_DEFAULT_TOKEN) return { ok: false, error: "MISSING_ASSRT_TOKEN" };
  if (!payload || !payload.sub_id)
    return { ok: false, error: "Missing sub_id" };

  const qs = new URLSearchParams({
    token: ASSRT_DEFAULT_TOKEN,
    id: String(payload.sub_id),
  });
  let resp;
  try {
    resp = await fetch(`${ASSRT_API_BASE}/sub/detail?${qs}`);
  } catch (e) {
    return { ok: false, error: `Network: ${String(e)}` };
  }
  if (!resp.ok) return { ok: false, error: `Assrt detail HTTP ${resp.status}` };
  const json = await resp.json().catch(() => null);
  if (!json || json.status !== 0)
    return { ok: false, error: `Assrt detail status ${json && json.status}` };

  const subItem = (json.sub && json.sub.subs && json.sub.subs[0]) || null;
  if (!subItem) return { ok: false, error: "Assrt no subs" };

  const filelist = subItem.filelist || [];
  const subExt = /\.(srt|vtt|ass|ssa)$/i;
  const preferred = filelist
    .filter((f) => f.url && subExt.test(f.f || ""))
    .sort((a, b) => (/\.srt$/i.test(a.f) ? -1 : 1))[0];

  const downloadUrl =
    (preferred && preferred.url) ||
    subItem.url ||
    (filelist[0] && filelist[0].url);
  if (!downloadUrl) return { ok: false, error: "Assrt no download url" };

  try {
    const extracted = await fetchAndExtract(downloadUrl);
    return {
      ok: true,
      text: extracted.text,
      fileName: (preferred && preferred.f) || extracted.fileName,
    };
  } catch (e) {
    return { ok: false, error: `Assrt file fetch: ${String(e)}` };
  }
}

// ============ SUBDL ============
function subdlLangCode(iso) {
  if (!iso) return "";
  const m = {
    en: "EN",
    es: "ES",
    fr: "FR",
    de: "DE",
    pt: "PT",
    it: "IT",
    ja: "JA",
    ko: "KO",
    zh: "ZH",
    "zh-tw": "BG",
    ru: "RU",
    ar: "AR",
  };
  return m[iso.toLowerCase()] || iso.toUpperCase();
}

async function subdlSearch(params) {
  if (!SUBDL_DEFAULT_KEY) return { ok: false, error: "MISSING_SUBDL_KEY" };

  const qs = new URLSearchParams({ api_key: SUBDL_DEFAULT_KEY });
  if (params.query) qs.set("film_name", params.query);
  if (params.year) qs.set("year", String(params.year));
  if (params.languages) {
    const codes = params.languages
      .split(",")
      .map((l) => subdlLangCode(l.trim()))
      .filter(Boolean)
      .join(",");
    if (codes) qs.set("languages", codes);
  }
  if (params.type === "episode") {
    qs.set("type", "tv");
    if (params.season_number != null)
      qs.set("season_number", String(params.season_number));
    if (params.episode_number != null)
      qs.set("episode_number", String(params.episode_number));
  } else {
    qs.set("type", "movie");
  }
  qs.set("subs_per_page", "30");

  let resp;
  try {
    resp = await fetch(`${SUBDL_API_BASE}/subtitles?${qs}`);
  } catch (e) {
    return { ok: false, error: `Network: ${String(e)}` };
  }
  if (!resp.ok) return { ok: false, error: `Subdl HTTP ${resp.status}` };
  const json = await resp.json().catch(() => null);
  if (!json || json.status !== true)
    return { ok: false, error: `Subdl: ${(json && json.error) || "no data"}` };

  const subs = json.subtitles || [];
  const results = subs.map((s, i) => {
    const langRaw = (s.language || s.lang || "").toLowerCase();
    let lang = langRaw;
    if (langRaw === "bg" || /traditional/i.test(s.lang || "")) lang = "zh-tw";
    return {
      source: "subdl",
      id: `subdl:${s.subtitlePage || s.url || s.release_name || i}`,
      file_name: s.release_name || s.name || "",
      release: s.release_name || "",
      language: lang,
      download_count: 0,
      ratings: 0,
      hd: !!s.hi,
      from_trusted: false,
      uploader: s.author || "",
      payload: { url: s.url },
    };
  });
  return { ok: true, results };
}

async function subdlDownload(payload) {
  if (!payload || !payload.url) return { ok: false, error: "Missing url" };
  const url = payload.url.startsWith("http")
    ? payload.url
    : SUBDL_DL_BASE + payload.url;
  try {
    const extracted = await fetchAndExtract(url);
    return { ok: true, text: extracted.text, fileName: extracted.fileName };
  } catch (e) {
    return { ok: false, error: `Subdl file fetch: ${String(e)}` };
  }
}

// ============ UNIFIED DISPATCH ============
const PROVIDERS = {
  opensubtitles: { search: osSearch, download: osDownload },
  assrt: { search: assrtSearch, download: assrtDownload },
  subdl: { search: subdlSearch, download: subdlDownload },
};

// ============ TITLE VARIANTS (Wikipedia langlinks) ============
// Given a title, returns alternative titles in other languages by hitting
// the Wikipedia search + langlinks APIs. Free, no key, CORS-friendly.
// Picks the EN Wikipedia article that best matches, then pulls translations
// in zh, ja, ko, en, es, fr, de, ru, pt, it.
const WIKI_LANGS_OF_INTEREST = [
  "en",
  "zh",
  "zh-hans",
  "zh-hant",
  "ja",
  "ko",
  "es",
  "fr",
  "de",
  "ru",
  "pt",
  "it",
];

async function fetchJson(url) {
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// Map a query's script to the matching Wikipedia subdomain. CJK content is
// vastly under-represented on en.wikipedia, so this is the fallback for
// titles like "超能路人甲" that have no English-language coverage.
function pickNativeWiki(s) {
  if (!s) return null;
  if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(s)) return "zh";
  if (/[\u3040-\u30ff]/.test(s)) return "ja";
  if (/[\uac00-\ud7af]/.test(s)) return "ko";
  if (/[\u0400-\u04ff]/.test(s)) return "ru";
  if (/[\u0600-\u06ff]/.test(s)) return "ar";
  return null;
}

async function getTitleVariants(query, year, type) {
  const variants = new Set();
  if (query) variants.add(query.trim());

  if (!query || query.length < 2) {
    return { ok: true, variants: Array.from(variants), source: "none" };
  }

  // Build a search query that biases toward the right article.
  const yearPart = year ? ` (${year})` : "";
  const typeHint =
    type === "episode" ? " TV series" : type === "movie" ? " film" : "";
  const searchTerms = [query + yearPart + typeHint, query + typeHint, query];

  // Reject Wikipedia "meta" articles that are never about a specific title.
  const isJunkArticle = (t) =>
    !t ||
    /^(list of|lists of|category:|outline of|index of|timeline of|filmography)/i.test(
      t,
    ) ||
    /\(disambiguation\)/i.test(t);

  const queryLower = query.trim().toLowerCase();

  // Step 1: collect candidate articles across all search terms.
  const candidates = [];
  for (const term of searchTerms) {
    try {
      const u = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(
        term,
      )}&srlimit=5&format=json&origin=*`;
      const j = await fetchJson(u);
      const hits = (j && j.query && j.query.search) || [];
      for (const h of hits) {
        if (
          !isJunkArticle(h.title) &&
          !candidates.find((c) => c.title === h.title)
        ) {
          candidates.push(h);
        }
      }
      if (candidates.length >= 5) break;
    } catch (_e) {
      // try next
    }
  }

  if (!candidates.length) {
    return { ok: true, variants: Array.from(variants), source: "no-match" };
  }

  // Step 2: walk candidates and pick the FIRST one whose langlinks actually
  // contain the original query (proving the article is about the right title).
  // If none match, we give up rather than poisoning the variant list.
  let chosenTitle = null;
  let chosenLangLinks = [];
  for (const cand of candidates.slice(0, 5)) {
    try {
      const u = `https://en.wikipedia.org/w/api.php?action=query&prop=langlinks&titles=${encodeURIComponent(
        cand.title,
      )}&lllimit=200&format=json&origin=*`;
      const j = await fetchJson(u);
      const pages = (j && j.query && j.query.pages) || {};
      const links = [];
      for (const pid of Object.keys(pages)) {
        for (const ln of pages[pid].langlinks || []) {
          if (ln["*"]) links.push(ln);
        }
      }
      // Does this article's title (EN) or any langlink match the query?
      const titleMatches =
        cand.title
          .toLowerCase()
          .replace(/\s*\([^)]+\)\s*$/, "")
          .trim() === queryLower;
      const linkMatches = links.some(
        (ln) =>
          String(ln["*"])
            .toLowerCase()
            .replace(/\s*\([^)]+\)\s*$/, "")
            .trim() === queryLower,
      );
      if (titleMatches || linkMatches) {
        chosenTitle = cand.title;
        chosenLangLinks = links;
        break;
      }
    } catch (_e) {
      // try next candidate
    }
  }

  if (!chosenTitle) {
    // Fallback: if query is in a non-Latin script, the native-language
    // Wikipedia is far more likely to have the article. Try it directly.
    const nativeWiki = pickNativeWiki(query);
    if (nativeWiki) {
      try {
        const u = `https://${nativeWiki}.wikipedia.org/w/api.php?action=query&prop=langlinks&titles=${encodeURIComponent(
          query.trim(),
        )}&lllimit=200&redirects=1&format=json&origin=*`;
        const j = await fetchJson(u);
        const pages = (j && j.query && j.query.pages) || {};
        for (const pid of Object.keys(pages)) {
          const p = pages[pid];
          if (p.missing !== undefined) continue;
          chosenTitle = p.title || query;
          chosenLangLinks = p.langlinks || [];
          break;
        }
      } catch (_e) {
        // ignore
      }
    }
  }

  if (!chosenTitle) {
    return {
      ok: true,
      variants: Array.from(variants),
      source: "no-confirmed-match",
    };
  }

  // Always include the article title itself (canonical English form).
  variants.add(chosenTitle.replace(/\s*\([^)]+\)\s*$/, "").trim());

  for (const ln of chosenLangLinks) {
    if (WIKI_LANGS_OF_INTEREST.includes(ln.lang) && ln["*"]) {
      const clean = String(ln["*"])
        .replace(/\s*\([^)]+\)\s*$/, "")
        .trim();
      if (clean) variants.add(clean);
    }
  }

  return {
    ok: true,
    variants: Array.from(variants).slice(0, 8),
    source: "wikipedia",
    article: chosenTitle,
  };
}

// Build a token set from a single query for relevance filtering.
function tokensForQuery(q) {
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
  const s = (q || "").trim();
  if (!s) return { tokens: [], phrases: [] };
  phrases.push(s.toLowerCase());
  for (const tok of s.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    // Require >= 4 chars so short articles (los, las, el, der, une, …) and
    // generic words don't match unrelated releases. "los" matching every
    // "Los.Angeles" release was producing pure junk.
    if (tok.length >= 4 && !stop.has(tok)) tokens.add(tok);
  }
  // For CJK input, also add the whole compact string as a token so
  // file_name matches with no whitespace work.
  if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(s)) {
    const clean = s.replace(/\s+/g, "");
    if (clean.length >= 2) tokens.add(clean);
  }
  return { tokens: Array.from(tokens), phrases };
}

// Drop results whose file_name/release have no token overlap with the
// specific query that produced them. This is the only reliable way to
// suppress OpenSubtitles' popularity-ranked junk fallback.
function filterResultsByQuery(results, query) {
  const { tokens, phrases } = tokensForQuery(query);
  if (!tokens.length && !phrases.length) return results;
  return results.filter((r) => {
    const hay = ((r.file_name || "") + " " + (r.release || "")).toLowerCase();
    if (!hay.trim()) return false; // no metadata = can't verify, drop it
    for (const p of phrases) if (p && hay.includes(p)) return true;
    for (const t of tokens) if (hay.includes(t)) return true;
    return false;
  });
}

async function searchAll(params) {
  const wanted =
    Array.isArray(params.providers) && params.providers.length
      ? params.providers
      : Object.keys(PROVIDERS);

  // Build the list of query variants to try.
  // - If caller provided `variants`, use them.
  // - Otherwise fall back to single `query`.
  const queries =
    Array.isArray(params.variants) && params.variants.length
      ? params.variants
      : params.query
        ? [params.query]
        : [];

  // Fan out: providers × variants in parallel.
  const jobs = [];
  for (const q of queries) {
    for (const name of wanted) {
      jobs.push({
        name,
        query: q,
        promise: PROVIDERS[name].search({ ...params, query: q }),
      });
    }
  }

  const settled = await Promise.allSettled(jobs.map((j) => j.promise));

  const errors = {};
  const counts = {};
  const seen = new Map(); // de-dupe by source + identifier
  const merged = [];

  settled.forEach((res, i) => {
    const { name, query } = jobs[i];
    if (res.status === "fulfilled" && res.value.ok) {
      let rs = res.value.results || [];

      // Drop results whose file_name/release has nothing to do with the
      // query that produced them. OpenSubtitles in particular returns
      // popularity-ranked junk when it can't parse a query (e.g. CJK
      // input). Keep this strict so unrelated 50-result dumps don't drown
      // out real hits from other variants.
      const before = rs.length;
      rs = filterResultsByQuery(rs, query);
      const dropped = before - rs.length;
      if (dropped > 0) {
        counts[`${name}_dropped`] = (counts[`${name}_dropped`] || 0) + dropped;
      }

      counts[name] = (counts[name] || 0) + rs.length;
      for (const r of rs) {
        // De-dupe by stable id (source-prefixed) or by source+filename+language
        const dedupeKey =
          r.id ||
          `${r.source}::${(r.file_name || r.release || "").toLowerCase()}::${r.language || ""}`;
        if (seen.has(dedupeKey)) continue;
        seen.set(dedupeKey, true);
        r._matched_variant = query;
        merged.push(r);
      }
    } else {
      const err =
        res.status === "fulfilled"
          ? res.value.error
          : String(res.reason || "rejected");
      // Keep first error per provider (most informative)
      if (!errors[name]) errors[name] = err;
      counts[name] = counts[name] || 0;
    }
  });

  merged.sort((a, b) => {
    const at = a.from_trusted ? 1 : 0;
    const bt = b.from_trusted ? 1 : 0;
    if (at !== bt) return bt - at;
    return (b.download_count || 0) - (a.download_count || 0);
  });

  return {
    ok: true,
    results: merged,
    errors,
    counts,
    variants_used: queries,
  };
}

async function downloadAny(params) {
  const source = params && params.source;
  if (!source || !PROVIDERS[source])
    return { ok: false, error: `Unknown source: ${source}` };
  return PROVIDERS[source].download(params.payload || {});
}

// ============ MESSAGE ROUTER ============
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === "NSPLUS_SEARCH_ALL") {
    searchAll(msg.params || {}).then(sendResponse);
    return true;
  }
  if (msg.type === "NSPLUS_DOWNLOAD") {
    downloadAny(msg.params || {}).then(sendResponse);
    return true;
  }
  if (msg.type === "NSPLUS_GET_VARIANTS") {
    const p = msg.params || {};
    getTitleVariants(p.query, p.year, p.type)
      .then(sendResponse)
      .catch((e) =>
        sendResponse({ ok: false, error: String(e), variants: [p.query] }),
      );
    return true;
  }

  // Legacy OS-only messages
  if (msg.type === "NSPLUS_OS_SEARCH") {
    osSearch(msg.params || {}).then(sendResponse);
    return true;
  }
  if (msg.type === "NSPLUS_OS_DOWNLOAD") {
    osDownload(msg.params || {}).then(sendResponse);
    return true;
  }
  if (msg.type === "NSPLUS_OS_GET_KEY") {
    chrome.storage.local.get([OS_KEY_STORAGE]).then((stored) => {
      const userKey = (stored[OS_KEY_STORAGE] || "").trim();
      sendResponse({
        ok: true,
        hasUserKey: !!userKey,
        hasDefaultKey: !!OS_DEFAULT_KEY,
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
      .set({ [OS_KEY_STORAGE]: key })
      .then(() => sendResponse({ ok: true }));
    return true;
  }
});

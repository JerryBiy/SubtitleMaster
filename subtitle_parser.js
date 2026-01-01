// subtitle_parser.js
// Parses .srt and .vtt into cues: { start: seconds, end: seconds, text: string }

function timeToSeconds(timeStr) {
  // Supports:
  // SRT: 00:01:02,345
  // VTT: 00:01:02.345 or 01:02.345
  const s = timeStr.trim().replace(",", ".");
  const parts = s.split(":");
  let h = 0,
    m = 0,
    secMs = "0";

  if (parts.length === 3) {
    h = Number(parts[0]);
    m = Number(parts[1]);
    secMs = parts[2];
  } else if (parts.length === 2) {
    m = Number(parts[0]);
    secMs = parts[1];
  } else {
    secMs = parts[0];
  }

  const [secStr, msStr = "0"] = secMs.split(".");
  const sec = Number(secStr);
  const ms = Number((msStr + "000").slice(0, 3)); // pad/truncate to 3 digits
  return h * 3600 + m * 60 + sec + ms / 1000;
}

function normalizeText(lines) {
  return lines.join("\n").trim();
}

function parseSRT(srtText) {
  const text = srtText.replace(/\r/g, "").trim();
  const blocks = text.split("\n\n");
  const cues = [];

  for (const block of blocks) {
    const lines = block.split("\n").filter(Boolean);
    if (lines.length < 2) continue;

    let timeLineIndex = 0;
    if (/^\d+$/.test(lines[0].trim())) timeLineIndex = 1;

    const timeLine = lines[timeLineIndex];
    const match = timeLine.match(/(.+?)\s*-->\s*(.+)/);
    if (!match) continue;

    const start = timeToSeconds(match[1]);
    const end = timeToSeconds(match[2]);

    const payload = lines.slice(timeLineIndex + 1);
    const cueText = normalizeText(payload);
    if (!cueText) continue;

    cues.push({ start, end, text: cueText });
  }

  cues.sort((a, b) => a.start - b.start);
  return cues;
}

function parseVTT(vttText) {
  let text = vttText.replace(/\r/g, "");
  text = text.replace(/^\uFEFF/, "");
  text = text.replace(/^WEBVTT[^\n]*\n+/, "");

  const blocks = text.trim().split("\n\n");
  const cues = [];

  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length < 2) continue;

    let timeLineIndex = 0;
    if (!lines[0].includes("-->") && lines[1] && lines[1].includes("-->")) {
      timeLineIndex = 1;
    }

    const timeLine = lines[timeLineIndex];
    const match = timeLine.match(/(.+?)\s*-->\s*(.+?)(\s+.*)?$/);
    if (!match) continue;

    const start = timeToSeconds(match[1]);
    const endRaw = match[2].split(/\s+/)[0];
    const end = timeToSeconds(endRaw);

    const payload = lines.slice(timeLineIndex + 1);
    const cueText = normalizeText(payload);
    if (!cueText) continue;

    cues.push({ start, end, text: cueText });
  }

  cues.sort((a, b) => a.start - b.start);
  return cues;
}

function parseSubtitles(rawText, fileName = "") {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".vtt")) return parseVTT(rawText);
  if (lower.endsWith(".srt")) return parseSRT(rawText);

  if (rawText.includes("WEBVTT")) return parseVTT(rawText);
  return parseSRT(rawText);
}

// Expose globally
window.SubtitleParser = { parseSubtitles };

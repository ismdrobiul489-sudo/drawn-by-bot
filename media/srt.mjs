// Pure SRT helpers — no I/O, unit-tested by tests/smoke.mjs.

/** Seconds → SRT timestamp "HH:MM:SS,mmm". */
export function srtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(r, 3)}`;
}

/**
 * Whisper verbose_json segments ([{start, end, text}, ...], seconds)
 * → SRT document text. Segments with empty text are dropped; a missing or
 * too-small end is repaired to start+1 so players never see a broken cue.
 */
export function segmentsToSrt(segments) {
  const cues = [];
  for (const seg of segments || []) {
    const text = String(seg.text || '').trim();
    if (!text) continue;
    const start = Number(seg.start) || 0;
    let end = Number(seg.end);
    if (!Number.isFinite(end) || end <= start) end = start + 1;
    cues.push({ start, end, text });
  }
  cues.sort((a, b) => a.start - b.start);
  return cues
    .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`)
    .join('\n');
}

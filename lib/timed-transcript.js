// Prefer actual word timestamps to proportional character timing. Keep clauses
// together and never span a music/silence gap with a spoken caption.
export function timedClauses(segments) {
  const words = segments.flatMap(segment => segment.words || []);
  if (!words.length) return segments;
  const result = [];
  let current = [];
  function flush() {
    if (!current.length) return;
    result.push({ start: current[0].start, end: current.at(-1).end,
      text: current.map(w => w.word).join('').replace(/\s+/g, ' ').trim() });
    current = [];
  }
  for (const word of words) {
    if (!(word.end > word.start) || !word.word.trim()) continue;
    const duration = current.length ? word.end - current[0].start : 0;
    const gap = current.length ? word.start - current.at(-1).end : 0;
    const boundary = /^(?:and|but|so|however|because|now|well)\b/i.test(word.word.trim());
    const unfinished = current.length && /^(?:a|an|the|not|that|very|to|is|are|was|were|than|of|for|with|in|on)$/i.test(current.at(-1).word.trim());
    if (current.length && (gap > 0.65 || (duration > 9 && !unfinished) || duration > 12 || (duration > 5.5 && boundary))) flush();
    current.push(word);
    if (/[.!?。！？]$/.test(word.word.trim()) && word.end - current[0].start >= 1.2) flush();
  }
  flush();
  return result;
}

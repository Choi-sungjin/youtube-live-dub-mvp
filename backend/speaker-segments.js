import { randomUUID } from 'node:crypto';
import { timedClauses } from '../lib/timed-transcript.js';

// Server-owned evidence. Never trust a label supplied by the page, and never
// retain raw audio here. Keys bind each result to one video and exact interval.
export function createSpeakerEvidenceStore({ now = Date.now, limit = 2000, ttl = 30 * 60 * 1000 } = {}) {
  const entries = new Map();
  return {
    register(videoId, segments) {
      for (const [key, value] of entries) if (value.expires <= now()) entries.delete(key);
      return segments.map(segment => {
        const speakerKey = randomUUID();
        entries.set(speakerKey, { videoId, start: segment.start, end: segment.end, speaker: segment.speaker, expires: now() + ttl });
        if (entries.size > limit) entries.delete(entries.keys().next().value);
        return { ...segment, speakerKey };
      });
    },
    resolve({ videoId, start, end, speakerKey }) {
      const entry = entries.get(speakerKey);
      if (!entry || entry.expires <= now() || entry.videoId !== videoId ||
          Math.abs(entry.start - start) > 0.011 || Math.abs(entry.end - end) > 0.011) return null;
      return entry.speaker;
    },
  };
}

export const capturedSpeakerEvidence = createSpeakerEvidenceStore();

function voiceAt(start, end, turns) {
  const scores = new Map();
  for (const turn of turns) {
    const overlap = Math.max(0, Math.min(end, turn.end) - Math.max(start, turn.start));
    if (overlap) scores.set(turn.label, (scores.get(turn.label) || 0) + overlap);
  }
  const [label, coverage] = [...scores].sort((a, b) => b[1] - a[1])[0] || [];
  return ['male', 'female'].includes(label) && coverage >= (end - start) * 0.6 ? label : 'unknown';
}

// Split on real word timestamps before clause grouping. Never proportionally
// divide caption text or merge two voices back into one synthesis request.
export function splitSpeakerSegments(segments, turns = []) {
  const groups = [];
  let current;
  for (const segment of segments) {
    const words = (segment.words || []).filter(word => Number.isFinite(word.start) && word.end > word.start && word.word?.trim());
    if (!words.length) {
      current = null;
      groups.push({ label: voiceAt(segment.start, segment.end, turns), segments: [segment] });
      continue;
    }
    for (const word of words) {
      const label = voiceAt(word.start, word.end, turns);
      if (!current || current.label !== label) {
        current = { label, segments: [{ words: [] }] };
        groups.push(current);
      }
      current.segments[0].words.push(word);
    }
  }
  return groups.flatMap(group => timedClauses(group.segments).map(segment => ({
    ...segment,
    speaker: { label: group.label, reason: group.label === 'unknown' ? 'uncertain-or-unavailable' : 'captured-audio' },
  })));
}

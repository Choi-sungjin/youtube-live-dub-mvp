// Content-specific glossary, not a general homophone substitution. The creator's
// visible description and pinned comment name TripoAI and link tripo3d.ai.
// Evidence: https://www.youtube.com/watch?v=6a5VLKPlJRo (2026-10-18).
export function applyVerifiedCaptionTerms(videoId, segments) {
  if(videoId !== '6a5VLKPlJRo') return segments;
  return segments.map(segment => {
    const text=segment.text.replace(/\bTripod\b|\bTripop\b/g,'Tripo')
      .replace(/\btriple(?= for some complex models)/g,'Tripo');
    return text===segment.text ? segment : {...segment,text,rawText:segment.rawText || segment.text};
  });
}

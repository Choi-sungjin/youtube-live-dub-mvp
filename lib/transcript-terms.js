// Conservative homophone corrections for AI-model discussions only. Preserve raw
// STT output on disk; these aliases never alter unrelated general speech.
export function normalizeTechnicalTranscript(segments) {
  const context=segments.map(s=>s.text).join(' ');
  const aiDiscussion=/\bGemini\b/i.test(context)&&/\bOpus\b/i.test(context);
  if(!aiDiscussion)return segments;
  return segments.map(segment=>{
    let text=segment.text
      .replace(/\bCloud\s+(Opus|Code[s]?|Quotes)\b/gi,(_all,term)=>/^opus$/i.test(term)?'Claude Opus':'Claude Code')
      .replace(/\bHicksfield\b/gi,'Higgsfield')
      .replace(/\banti-gravity\b/gi,'Antigravity')
      .replace(/\bGemini\s+4\s+are gone\b/gi,'Gemini 4 Argon')
      .replace(/\bMac's Google plan\b/gi,'highest-tier Google plan')
      .replace(/(Claude Opus [\d.]+,? which is )our guess today/gi,'$1our guest today')
      .replace(/takes good plays,? but right after (GPT[- ]?\d+)/gi,'ranks well, but right after $1');
    return text===segment.text?segment:{...segment,text,rawText:segment.text};
  });
}

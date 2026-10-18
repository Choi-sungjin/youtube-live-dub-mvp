// Send senses of ambiguous words, not neighboring claims, to small local models.
// The topic window is evidence for disambiguation only; it is never translated.
export function captionSenseHints(segment) {
  const text = String(segment.text || '');
  const nearby = [segment.contextBefore, segment.contextAfter, segment.contextTopic].filter(Boolean).join(' ').slice(-2600);
  const hints = [];
  const add = (term, meaning) => hints.push({ term, meaning });
  const fishing = /\bfish(?:ing|erman)?\b|\b(?:cast|casting)\b.{0,70}\bcatch\b/i.test(nearby + ' ' + text);
  const combat = /\bcombat\b|\bfighting\b|\bcooldown\b|\bspell\b/i.test(nearby);
  if (/\bskills?\b/i.test(text) && combat) add('skill', '게임 전투의 스킬/기술. "I should have skills" means 스킬이 있을 텐데, an expectation of available abilities, not needing more personal proficiency.');
  if (/\bcast(?:ing)?\b/i.test(text) && fishing && !combat) add('cast', '낚싯줄을 던지다. Not hiring actors or a software cast.');
  if (/\bcast(?:ing)?\b/i.test(text) && combat && !fishing) add('cast', '게임에서 마법/스킬을 시전하다. Not hiring actors.');
  if (/\bline (?:has )?(?:parted|broke|snapped)\b/i.test(text) && fishing) add('line parted', '낚싯줄이 끊어졌다. Preserve the break, not a visual line splitting.');
  if (/\beffort levels?\b/i.test(text) && /\bClaude\b|\bOpus\b|\btokens?\b|\breasoning\b/i.test(nearby)) add('effort levels', 'AI 추론 강도. Not human effort.');
  // A title immediately preceding a capitalized token establishes a name, but
  // only a name that occurs in this caption can enter the hint list.
  for (const match of nearby.matchAll(/\b(?:Captain|Mr\.?|Ms\.?)\s+([A-Z][a-z]{2,24})\b/g)) {
    if (new RegExp(`\\b${match[1]}\\b`).test(text) && !hints.some(h => h.term === match[1])) {
      add(match[1], `Proper name established by ${match[0]}. Retain the name or transliterate it; never translate its dictionary meaning.`);
    }
  }
  return hints;
}

export function translationContext(segment) {
  return {
    context_before: segment.text.split(/\s+/).length > 10 || /^and give\b/i.test(segment.text) ? (segment.contextBefore || '').slice(-180) : '',
    sense_hints: captionSenseHints(segment),
  };
}

export function captionTranslationText(text) {
  // Remove a spoken aside whose temporal attachment was repeatedly mistranslated
  // by the local model. Preserve the original caption for display and validation.
  return text.replace(/\bwhile I(?:'m| am) (?:going to be )?playing,?\s*(?=what we know about (?:this|the) game is)/i, '');
}

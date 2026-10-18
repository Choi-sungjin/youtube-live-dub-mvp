export const SPEECH_TEXT_REVISION = 'ko-terms-trim-v5';
export function normalizeDubbingTranslation(text, source, language) {
  if(language !== 'ko' || !/\bsee you\b/i.test(source))return text;
  let result=text;
  if(/\bnext\b/i.test(source)) result=result.replace(/다음\s*영상에서\s+요([.!?]?)$/, '다음 영상에서 봐요$1');
  if(/\bwhen\b/i.test(source)) result=result.replace(/때\s+요([.!?]?)$/, '때 봐요$1');
  return result;
}
export function speechText(text, language) {
  if (language !== 'ko') return text;
  const names = { 'Gemini': '제미나이', 'Google': '구글', 'Claude': '클로드',
    'Opus': '오퍼스', 'Argon': '아르곤', 'Astra': '아스트라', 'Blender': '블렌더',
    'Antigravity': '안티그래비티', 'GitHub': '깃허브', 'YouTube': '유튜브',
    'GPT': '지피티', 'CLI': '씨엘아이', 'API': '에이피아이', 'AI': '에이아이',
    '3D': '쓰리디', '2D': '투디', 'VFX': '브이에프엑스', 'UI': '유아이',
    'Pro': '프로', 'Max': '맥스', 'Ultra': '울트라', 'Higgsfield': '힉스필드',
    'Fable': '페이블', 'Astro': '아스트로', 'Rickroll': '릭롤', 'Code': '코드',
    'TimeTalk': '타임토크', 'Tripo': '트리포', 'Godot': '고도', 'Dirt': '더트' };
  let result = text.replace(/제미니|재미나이/g, '제미나이')
    .replace(/\bhigh (?:thinking|effort)\b/gi,'높은 추론 강도')
    .replace(/\bmax thinking\b/gi,'최대 추론 강도')
    .replace(/\bX-high\b/gi,'엑스하이');
  for (const [name, spoken] of Object.entries(names)) {
    // Korean particles directly after an English name are normal in translation.
    result = result.replace(new RegExp(`(?<![A-Za-z])${name}(?![A-Za-z])`, 'gi'), spoken);
  }
  result = result.replace(/(지피티)-(?=\d)/g, '$1 ');
  result = result.replace(/((?:제미나이|오퍼스|지피티|클로드)\s*)(\d+)(?![\d.])/g,
    (match, name, number) => Number(number) < 10 ? name + '영일이삼사오육칠팔구'[Number(number)] : match);
  return result.replace(/(\d+)\.\s*(\d+(?:\.\d+)*)/g,
    (_match, whole, fraction) => `${Number(whole) < 10 ? '영일이삼사오육칠팔구'[Number(whole)] : whole}점${fraction.split('').map(c => '영일이삼사오육칠팔구'[Number(c)] || '점').join('')}`);
}

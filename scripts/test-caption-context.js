import test from 'node:test';
import assert from 'node:assert/strict';
import { captionSenseHints, translationContext, captionTranslationText } from '../backend/caption-context.js';
import { createLocalTranslator } from '../backend/local-translation.js';
import { applyVerifiedCaptionTerms } from '../backend/verified-caption-terms.js';
import { speechText } from '../backend/speech-text.js';

test('short captions receive a relevant sense, never a neighboring claim', () => {
  const segment={text:'Muck is there. Let us set sail.',contextBefore:'Captain Muck is the name.',contextAfter:'Opus 5.5 developed the game.'};
  const result=translationContext(segment);
  assert.equal(result.context_before,'');
  assert.equal(result.sense_hints.length,1);
  assert.equal(result.sense_hints[0].term,'Muck');
  assert.doesNotMatch(JSON.stringify(result),/Opus|5\.5/);
  assert.deepEqual(captionSenseHints({text:'Muck is on my boots.'}),[]);
});

test('the same word gets different senses only with supported topic evidence', () => {
  const combat=captionSenseHints({text:'I can cast something. I have skills.',contextTopic:'Combat fighting, cooldown and spell buttons.'});
  assert.match(JSON.stringify(combat),/시전/); assert.match(JSON.stringify(combat),/스킬/);
  const fishing=captionSenseHints({text:'I cast. The line parted.',contextTopic:'Try to catch the fish while fishing.'});
  assert.match(JSON.stringify(fishing),/낚싯줄/); assert.match(JSON.stringify(fishing),/끊어/);
  assert.deepEqual(captionSenseHints({text:'I cast the movie. The line parted.',contextTopic:'Actor audition and laundry.'}),[]);
  assert.deepEqual(captionSenseHints({text:'Cast the spell.',contextTopic:'Combat and fishing are both possible.'}),[]);
});

test('AI effort is disambiguated without affecting ordinary human effort', () => {
  assert.match(JSON.stringify(captionSenseHints({text:'Different effort levels.',contextTopic:'Claude session tokens.'})),/추론 강도/);
  assert.deepEqual(captionSenseHints({text:'Different effort levels.',contextTopic:'Exercise and running.'}),[]);
});

test('a narration aside cannot move earlier development into the current play session',()=>{
  const raw="While I'm going to be playing, what we know about this game is it was developed by Alice.";
  assert.equal(captionTranslationText(raw),'what we know about this game is it was developed by Alice.');
  const simultaneous='While I am playing, Alice is developing the game.';
  assert.equal(captionTranslationText(simultaneous),simultaneous);
});

test('verified product spelling is scoped to its source video and preserves raw STT',()=>{
  const original=[{text:'Tripod AI and Tripop.'}];
  assert.equal(applyVerifiedCaptionTerms('other-video',original),original);
  const result=applyVerifiedCaptionTerms('6a5VLKPlJRo',original);
  assert.equal(result[0].text,'Tripo AI and Tripo.'); assert.equal(result[0].rawText,original[0].text);
  assert.equal(original[0].text,'Tripod AI and Tripop.');
  assert.equal(speechText('TimeTalk와 Tripo의 Dirt','ko'),'타임토크와 트리포의 더트');
  assert.equal(speechText('TimeTalk and Tripo','en'),'TimeTalk and Tripo');
});

test('an invented farewell is retried, while a source farewell is preserved',async()=>{
  for(const source of ['Like again, wow, it is very easy.','See you again.']){
    let calls=0;
    const translator=createLocalTranslator({fetchImpl:async(_url,options)=>{
      const payload=JSON.parse(JSON.parse(options.body).messages[1].content);calls++;
      const text=calls===1?'준비':calls===2?'또 봐요.':'정말 쉬워요.';
      return new Response(JSON.stringify({message:{content:JSON.stringify({translations:payload.segments.map(s=>({index:s.index,text}))})}}));
    }});
    const result=await translator.translate([{index:0,start:0,end:6,text:source}]);
    assert.equal(result.get(0),source.startsWith('Like')?'정말 쉬워요.':'또 봐요.');
  }
});

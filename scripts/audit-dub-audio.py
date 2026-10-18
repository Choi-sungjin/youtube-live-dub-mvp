"""Audit generated files, not the physical speaker. ASR is a pronunciation proxy."""
import argparse, json, runpy, wave, re
from pathlib import Path
from difflib import SequenceMatcher
import numpy as np

parser = argparse.ArgumentParser()
parser.add_argument('video_id')
parser.add_argument('--start', type=float, default=0)
parser.add_argument('--revision', required=True)
parser.add_argument('--output', required=True)
parser.add_argument('--asr', action='store_true')
parser.add_argument('--api-results', help='Audit exactly the saved API responses, including cache hits')
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
items = {}
paths = [Path(args.api_results)] if args.api_results else (root/'backend/.cache/audit').glob('*.jsonl')
for path in paths:
    lines = [json.dumps(r) for r in json.loads(path.read_text(encoding='utf-8'))] if args.api_results else path.read_text(encoding='utf-8').splitlines()
    for line in lines:
        try: record = json.loads(line)
        except json.JSONDecodeError: continue
        if record.get('videoId') != args.video_id: continue
        if not args.api_results and record.get('timings',{}).get('localRevision') != args.revision: continue
        for item in record['segments']:
            if item['end'] >= args.start: items[item['id']] = item
model = None
if args.asr:
    runpy.run_path(str(root/'backend/cuda-runtime.py'))
    from faster_whisper import WhisperModel
    model = WhisperModel('large-v3-turbo',device='cuda',compute_type='int8_float16',local_files_only=True)
out = Path(args.output)
if out.exists(): raise FileExistsError('Use a new output path to preserve earlier evidence')
out.parent.mkdir(parents=True,exist_ok=True)
for i,item in enumerate(sorted(items.values(),key=lambda s:s['start'])):
    path = root/f"backend/.cache/audio/{item['id']}.wav"
    with wave.open(str(path),'rb') as wav:
        rate=wav.getframerate(); channels=wav.getnchannels()
        if wav.getsampwidth()!=2: raise ValueError('Expected PCM16')
        samples=np.frombuffer(wav.readframes(wav.getnframes()),dtype='<i2').astype(np.float32)/32768
        samples=samples.reshape(-1,channels).mean(axis=1)
    frame=max(1,int(rate*.02))
    rms=np.array([np.sqrt(np.mean(samples[j:j+frame]**2)) for j in range(0,len(samples),frame)])
    voiced=np.flatnonzero(rms>.008)
    longest=run=0
    if len(voiced):
        for quiet in rms[voiced[0]:voiced[-1]+1]<=.008:
            run=run+1 if quiet else 0; longest=max(longest,run)
    result={**item,'rate':rate,'clippedSamples':int(np.sum(np.abs(samples)>=.999)),
            'peak':float(np.max(np.abs(samples))) if len(samples) else 0,
            'internalSilenceMs':longest*20,'allQuiet':not bool(len(voiced))}
    if model:
        segments,_=model.transcribe(str(path),language='ko',beam_size=5,temperature=0,condition_on_previous_text=False)
        result['asrText']=' '.join(s.text.strip() for s in segments)
        clean=lambda s:re.sub(r'[^가-힣a-z0-9]','',s.lower())
        result['asrSimilarity']=round(SequenceMatcher(None,clean(item.get('speechText',item['translatedText'])),clean(result['asrText'])).ratio(),3)
    with out.open('a',encoding='utf-8') as dest: dest.write(json.dumps(result,ensure_ascii=False)+'\n')
    if (i+1)%25==0: print(json.dumps({'audited':i+1,'total':len(items)}),flush=True)
print(json.dumps({'complete':True,'count':len(items),'asr':args.asr,'output':str(out)}),flush=True)

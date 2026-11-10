"""CPU voice-presentation classifier. Private JSON lines; no identity or age output."""
import json
import sys
import subprocess
import time
from pathlib import Path
import numpy as np
import onnxruntime as ort
from faster_whisper.vad import get_speech_timestamps, VadOptions


def reply(value):
    print(json.dumps(value), flush=True)


def classify(session, signal):
    if len(signal) < 8000 or float(np.sqrt(np.mean(signal ** 2))) < 0.003:
        return {"label": "unknown", "reason": "insufficient-speech"}
    regions = get_speech_timestamps(signal, VadOptions(min_speech_duration_ms=250))
    voiced = np.concatenate([signal[r['start']:r['end']] for r in regions]) if regions else np.array([])
    if len(voiced) < 8000:
        return {"label": "unknown", "reason": "insufficient-speech"}
    results = []
    # Separate short windows avoid assigning an entire mixed utterance one voice.
    for offset in range(0, len(voiced), 48000):
        window = voiced[offset:offset + 48000]
        if len(window) < 8000:
            continue
        window = ((window - window.mean()) / np.sqrt(window.var() + 1e-7)).astype(np.float32)
        logits = session.run(['logits_gender'], {'signal': window[None, :]})[0][0]
        probabilities = np.exp(logits - logits.max())
        probabilities /= probabilities.sum()
        index = int(np.argmax(probabilities))
        confidence = float(probabilities[index])
        # Labels verified against the pinned archive's model.yaml: female,male,child.
        label = ['female', 'male', 'unknown'][index] if confidence >= 0.80 else 'unknown'
        results.append((label, confidence, index))
    labels = {item[0] for item in results}
    if len(labels) != 1 or 'unknown' in labels:
        candidates = {item[2] for item in results}
        if len(candidates) == 1 and next(iter(candidates)) in (0, 1):
            return {"label": "unknown", "reason": "low-confidence",
                    "candidate": ['female', 'male'][results[0][2]],
                    "confidence": round(min(item[1] for item in results), 4)}
        return {"label": "unknown", "reason": "uncertain-or-mixed"}
    return {"label": results[0][0], "confidence": round(min(item[1] for item in results), 4), "reason": "local-audio"}


def classify_timeline(session, signal):
    # 750 ms cells with surrounding context preserve changes without asking the
    # model to classify isolated phonemes. Uncertainty stays explicit.
    turns = []
    last_label, last_reliable = None, -10
    for offset in range(0, len(signal), 12000):
        window = signal[max(0, offset - 6000):min(len(signal), offset + 18000)]
        result = classify(session, window)
        start, end = offset / 16000, min(len(signal), offset + 12000) / 16000
        if result['label'] in ('male', 'female'):
            last_label, last_reliable = result['label'], start
        elif (last_label and result.get('candidate') in ('male', 'female') and result.get('confidence', 0) >= 0.5
              and start - last_reliable <= 1.5):
            # Hysteresis avoids a voice flip on an uncertain sentence tail.
            # Never bridge silence or override a confident opposing vote.
            result = {**result, 'label': last_label, 'reason': 'temporal-voice'}
        result.pop('candidate', None)
        if turns and turns[-1]['label'] == result['label']:
            turns[-1]['end'] = end
        else:
            turns.append({'start': start, 'end': end, **result})
    return turns


if __name__ == '__main__':
    try:
        options = ort.SessionOptions()
        options.intra_op_num_threads = 2
        options.inter_op_num_threads = 1
        session = ort.InferenceSession(str(Path(__file__).parent / '.cache/speaker-model/model.onnx'),
                                       sess_options=options, providers=['CPUExecutionProvider'])
        reply({'ready': True})
    except Exception:
        reply({'ready': False, 'error': 'Speaker model unavailable. Run scripts/setup-speaker-model.py.'})
        raise SystemExit(1)
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            start, duration = float(request['start']), float(request['duration'])
            limit = 26 if request.get('timeline') else 12
            if not np.isfinite(start) or not np.isfinite(duration) or start < 0 or not 0 < duration <= limit:
                raise ValueError('Invalid audio interval')
            started = time.perf_counter()
            audio = subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe', '-ss', str(start), '-i', request['inputPath'],
                                    '-t', str(duration), '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1'],
                                   capture_output=True, check=True, timeout=15)
            signal = np.frombuffer(audio.stdout, dtype='<f4').copy()
            result = {'turns': classify_timeline(session, signal)} if request.get('timeline') else classify(session, signal)
            result['inferenceMs'] = round((time.perf_counter() - started) * 1000)
            reply({'id': request['id'], 'ok': True, **result})
        except Exception:
            reply({'id': request.get('id'), 'ok': False, 'error': 'Speaker audio analysis failed'})

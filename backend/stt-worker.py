"""Local, persistent faster-whisper worker; JSON-lines on private stdio only."""
import contextlib
import json
import sys
import time
import os
import runpy
from pathlib import Path

cuda_runtime = runpy.run_path(str(Path(__file__).with_name('cuda-runtime.py')))
model_name = os.environ.get('YLD_STT_MODEL', 'tiny')
device = os.environ.get('YLD_STT_DEVICE', 'cpu')
compute_type = os.environ.get('YLD_STT_COMPUTE', 'int8')
engine = f'faster-whisper-{device}-{compute_type}'

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")


def reply(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


started = time.perf_counter()
try:
    with contextlib.redirect_stdout(sys.stderr):
        from faster_whisper import WhisperModel
        model = WhisperModel(model_name, device=device, compute_type=compute_type,
                             cpu_threads=4, local_files_only=True)
    reply({"ready": True, "model": model_name, "engine": engine, "loadMs": round((time.perf_counter() - started) * 1000)})
except Exception as error:
    reply({"ready": False, "error": str(error)})
    raise SystemExit(1)

for line in sys.stdin:
    request = {}
    try:
        request = json.loads(line)
        if request.get("model", model_name) != model_name:
            raise ValueError(f'The warm worker is configured for {model_name}.')
        started = time.perf_counter()
        with contextlib.redirect_stdout(sys.stderr):
            segments, info = model.transcribe(request["inputPath"],
                language=None if request.get("language", "auto") == "auto" else request["language"],
                beam_size=1 if request.get("lowLatency") else 5,
                best_of=1 if request.get("lowLatency") else 5, temperature=0, word_timestamps=True,
                vad_filter=True, condition_on_previous_text=True,
                initial_prompt=os.environ.get('YLD_STT_PROMPT') or None)
            items = [{"start": item.start, "end": item.end, "text": item.text,
                      "words": [{"start": word.start, "end": word.end, "word": word.word} for word in item.words or []]}
                     for item in segments]
        reply({"id": request["id"], "ok": True, "language": info.language,
               "segments": items, "engine": engine, "model": model_name,
               "inferenceMs": round((time.perf_counter() - started) * 1000)})
    except Exception as error:
        reply({"id": request.get("id"), "ok": False, "error": str(error)})

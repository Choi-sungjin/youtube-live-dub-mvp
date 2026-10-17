"""Persistent Supertonic 3 worker. One model load, JSON-lines over private pipes."""
import contextlib
import json
import os
from pathlib import Path
import sys
import time
import uuid

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")


def reply(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


try:
    with contextlib.redirect_stdout(sys.stderr):
        import numpy as np
        from supertonic import TTS
        started = time.perf_counter()
        tts = TTS(model="supertonic-3", auto_download=False,
                  intra_op_num_threads=4, inter_op_num_threads=1)
        styles = {name: tts.get_voice_style(voice_name=name)
                  for name in [f"{gender}{i}" for gender in ("M", "F") for i in range(1, 6)]}
    reply({"ready": True, "model": "supertonic-3", "loadMs": round((time.perf_counter()-started)*1000)})
except Exception as error:
    reply({"ready": False, "error": str(error)})
    raise SystemExit(1)

for line in sys.stdin:
    request = {}
    try:
        request = json.loads(line)
        text = str(request.get("text", "")).strip()
        if not text or len(text) > 5000:
            raise ValueError("Speech text must contain 1–5000 characters.")
        voice = request.get("voice", "M1")
        if voice not in styles:
            raise ValueError("Unknown Supertonic voice.")
        speed = float(request.get("speed", 1.15))
        if not 0.7 <= speed <= 2:
            raise ValueError("Supertonic speed must be between 0.7 and 2.")
        output = Path(request["outputPath"]).resolve()
        temporary = output.with_name(output.name + "." + uuid.uuid4().hex + ".wav")
        started = time.perf_counter()
        with contextlib.redirect_stdout(sys.stderr):
            wav, duration = tts.synthesize(text, voice_style=styles[voice], lang=request.get("language", "ko"),
                                           total_steps=8, speed=speed, verbose=False)
            tts.save_audio(wav, str(temporary))
        os.replace(temporary, output)
        reply({"id": request["id"], "ok": True, "model": "supertonic-3", "voice": voice,
               "duration": float(np.asarray(duration).reshape(-1)[0]),
               "synthesisMs": round((time.perf_counter()-started)*1000)})
    except Exception as error:
        reply({"id": request.get("id"), "ok": False, "error": str(error)})

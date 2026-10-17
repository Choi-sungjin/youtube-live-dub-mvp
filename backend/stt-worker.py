"""Local, persistent faster-whisper worker; JSON-lines on private stdio only."""
import contextlib
import json
import sys
import time

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")


def reply(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


started = time.perf_counter()
try:
    with contextlib.redirect_stdout(sys.stderr):
        from faster_whisper import WhisperModel
        model = WhisperModel("tiny", device="cpu", compute_type="int8",
                             cpu_threads=4, local_files_only=True)
    reply({"ready": True, "loadMs": round((time.perf_counter() - started) * 1000)})
except Exception as error:
    reply({"ready": False, "error": str(error)})
    raise SystemExit(1)

for line in sys.stdin:
    request = {}
    try:
        request = json.loads(line)
        if request.get("model", "tiny") != "tiny":
            raise ValueError("The warm worker supports the configured tiny model only.")
        started = time.perf_counter()
        with contextlib.redirect_stdout(sys.stderr):
            segments, info = model.transcribe(request["inputPath"],
                language=None if request.get("language", "auto") == "auto" else request["language"],
                beam_size=5, best_of=5, temperature=0)
            items = [{"start": item.start, "end": item.end, "text": item.text}
                     for item in segments]
        reply({"id": request["id"], "ok": True, "language": info.language,
               "segments": items, "engine": "faster-whisper-cpu-int8",
               "inferenceMs": round((time.perf_counter() - started) * 1000)})
    except Exception as error:
        reply({"id": request.get("id"), "ok": False, "error": str(error)})

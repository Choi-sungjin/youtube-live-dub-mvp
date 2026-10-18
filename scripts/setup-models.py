"""Explicit installer downloads and real model smoke checks; never run at import."""
import argparse
import runpy
from pathlib import Path


def prepare_supertonic():
    import numpy as np
    from supertonic import TTS

    tts = TTS(model="supertonic-3", auto_download=True,
              intra_op_num_threads=4, inter_op_num_threads=1)
    wav, _ = tts.synthesize("설치가 완료되었습니다.",
                            voice_style=tts.get_voice_style(voice_name="M1"),
                            lang="ko", total_steps=8, speed=1.15, verbose=False)
    samples = np.asarray(wav)
    if samples.size == 0 or not np.isfinite(samples).all() or not np.any(samples):
        raise RuntimeError("Supertonic produced empty, invalid, or silent audio")
    print("Supertonic 3 synthesis passed at 1.15x.", flush=True)


def prepare_stt(device):
    # Keep DLL directory handles alive through inference, as in stt-worker.py.
    cuda_runtime = runpy.run_path(str(Path(__file__).resolve().parents[1] / "backend/cuda-runtime.py"))
    import numpy as np
    from faster_whisper import WhisperModel
    from faster_whisper.utils import download_model

    model_name = "large-v3-turbo" if device == "cuda" else "small"
    compute = "int8_float16" if device == "cuda" else "int8"
    local_model = download_model(model_name)
    model = WhisperModel(local_model, device=device, device_index=0,
                         compute_type=compute, cpu_threads=4, local_files_only=True)
    # Enumerate the lazy result: merely constructing the model misses DLL/inference errors.
    segments, _ = model.transcribe(np.zeros(16000, dtype=np.float32),
                                   language="en", beam_size=1, vad_filter=False,
                                   word_timestamps=True)
    list(segments)
    print(f"Whisper {model_name} inference passed on {device} ({compute}).", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("engine", choices=("supertonic", "stt"))
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    args = parser.parse_args()
    if args.engine == "supertonic":
        prepare_supertonic()
    else:
        prepare_stt(args.device)


if __name__ == "__main__":
    main()

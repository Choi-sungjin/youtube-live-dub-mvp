# Automatic voice selection

All four modes offer **자동 · 원본 음색에 맞춤** in Voice. The backend analyzes each source audio interval locally on CPU and selects `cedar` for a masculine voice presentation or `marin` for a feminine presentation in GPT speech modes (2/4). Local Supertonic speech modes (1/3) select `M1` / `F1` respectively. This estimates audible voice characteristics, not a person's gender identity. It does not clone the original speaker.

Uncertain, mixed, silent, too-short or unavailable audio uses the default `marin` for GPT or `M1` for local speech. Manual voice choices bypass analysis. Explicitly selected voices remain fixed in every mode. Actual selected voice and classification appear in playback diagnostics. Existing installations must reload the extension and refresh the YouTube page.

There are no additional OpenAI classification requests. GPT translation and generated speech still incur normal usage costs. Optional source acquisition/model analysis waits at most four seconds per interval before using the default voice (diagnostic reason `analysis-pending`). The background analysis continues and is reused when ready. Source acquisition itself has a 60-second timeout; cached source audio and interval classifications are reused. New downloads are capped at two concurrent files and 100 MB per file; an unavailable source has a five-minute retry cooldown. Original compressed audio is retained instead of expanding new downloads to WAV. This is interval-level matching, not full speaker diarization: rapid changes within a caption, overlapping speech, music, short samples and accents may cause uncertainty or incorrect classification. Choose a manual voice when needed.

## Local model setup

Run `python3 scripts/setup-speaker-model.py` in the repository. The existing local Python environment must include `onnxruntime`, `numpy`, `faster-whisper`, and `yt-dlp`; `ffmpeg` must be on PATH. No GPU model is added. The archive is about 333 MB and unpacked model uses additional disk space. Missing models fall back to the default voice without breaking dubbing. Model status is included in `/api/health`.

The pinned model is audEERING's `w2v2-L-robust-6-age-gender.25c844af-1.1.1`, from [Zenodo release 7761387](https://zenodo.org/records/7761387), under **CC BY-NC-SA 4.0** (personal/noncommercial use; do not assume commercial permission). See the [model card](https://huggingface.co/audeering/wav2vec2-large-robust-6-ft-age-gender) and [official examples](https://github.com/audeering/w2v2-age-gender-how-to). The application does not redistribute model weights. The pinned archive's publisher-provided MD5 is checked before installation. The ONNX archive's `model.yaml` defines output order `female, male, child`; the child/age outputs are not exposed or used for age estimation. A non-adult or uncertain model prediction uses the default voice.

## Validation scope

Automated tests cover manual voice isolation and automatic routing across all four modes, invalid ids/intervals, concurrent cache reuse, source failure, actual voice in cache and synthesis. CPU execution is separately checked with a public YouTube excerpt, synthetic M1/F1 speech, silence and mixed speech. Synthetic sample accuracy is not a benchmark for all real speakers. Browser playback and real API synthesis require separate runtime verification.

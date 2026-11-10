# Automatic voice selection

All four modes offer **자동 · 원본 음색에 맞춤**. In v0.9.1, automatic voices use the current YouTube audio buffer (or original-element capture fallback) for both local STT and voice analysis. No cookie extraction or separate source download is needed on these paths. Male/female voice presentation selects `M1`/`F1` in modes 1/3 and `cedar`/`marin` in modes 2/4. This matches audible voice characteristics, not a person's gender identity, and does not clone the original speaker.

The local classifier samples 750 ms cells with up to 1.5 seconds of context. A confident change switches the voice. Up to 1.5 seconds of uncertain sentence tail can keep the established voice; silence or a confident opposing label is never overridden. Word timestamps split mixed captions before translation. The extension preserves those boundaries instead of joining two voices into one synthesis request. Server-issued, video/interval-bound keys carry the result to synthesis and its cache key. Evidence is bounded to 2,000 entries/30 minutes; temporary audio is removed when both analyses finish.

Uncertain, silent, too-short or unavailable audio uses the declared default `marin` for GPT or `M1` for local speech. Manual voice choices stay fixed and bypass voice analysis. Actual selected voice and classification appear in playback diagnostics. Existing installations must reload the extension and refresh the YouTube page. Automatic mode prioritizes word-aligned audio over text-only caption caches; unsupported buffer paths still need an 8-second capture window.

There are no additional OpenAI classification requests. GPT translation and generated speech retain their normal usage costs. The legacy text-only API path can still acquire source audio with a bounded four-second analysis wait. This is voice-category turn matching, not full speaker identity diarization: multiple male or multiple female speakers share their category voice. Rapid changes, overlapping speech, music and short samples may be uncertain or wrong. See [v0.9.1 validation](testing/speaker-routing-v0.9.1.md) for test conditions and limitations.

## Local model setup

Run `python3 scripts/setup-speaker-model.py` in the repository. The existing local Python environment must include `onnxruntime`, `numpy`, `faster-whisper`, and `yt-dlp`; `ffmpeg` must be on PATH. No GPU model is added. The archive is about 333 MB and unpacked model uses additional disk space. Missing models fall back to the default voice without breaking dubbing. Model status is included in `/api/health`.

The pinned model is audEERING's `w2v2-L-robust-6-age-gender.25c844af-1.1.1`, from [Zenodo release 7761387](https://zenodo.org/records/7761387), under **CC BY-NC-SA 4.0** (personal/noncommercial use; do not assume commercial permission). See the [model card](https://huggingface.co/audeering/wav2vec2-large-robust-6-ft-age-gender) and [official examples](https://github.com/audeering/w2v2-age-gender-how-to). The application does not redistribute model weights. The pinned archive's publisher-provided MD5 is checked before installation. The ONNX archive's `model.yaml` defines output order `female, male, child`; the child/age outputs are not exposed or used for age estimation. A non-adult or uncertain model prediction uses the default voice.

## Validation scope

Automated tests cover manual voice isolation and automatic routing across all four modes, invalid ids/intervals, concurrent cache reuse, source failure, actual voice in cache and synthesis. CPU execution is separately checked with a public YouTube excerpt, synthetic M1/F1 speech, silence and mixed speech. Synthetic sample accuracy is not a benchmark for all real speakers. Browser playback and real API synthesis require separate runtime verification.

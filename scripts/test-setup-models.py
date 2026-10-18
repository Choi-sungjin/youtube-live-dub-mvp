"""Installer helper contract tests with fake model modules: no downloads or GPU allocation."""
import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("setup_models", Path(__file__).with_name("setup-models.py"))
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


class SetupModelTests(unittest.TestCase):
    def test_cuda_probe_evaluates_lazy_inference_and_propagates_cuda_failure(self):
        def failed_segments():
            yield {"text": ""}
            raise RuntimeError("CUDA DLL missing")

        model = Mock()
        model.transcribe.return_value = (failed_segments(), None)
        ctor = Mock(return_value=model)
        downloader = Mock(return_value="cached-model")
        modules = {"numpy": types.SimpleNamespace(zeros=Mock(), float32="float32"),
                   "faster_whisper": types.SimpleNamespace(WhisperModel=ctor),
                   "faster_whisper.utils": types.SimpleNamespace(download_model=downloader)}
        with patch.dict(sys.modules, modules), patch.object(setup.runpy, "run_path", return_value={}):
            with self.assertRaisesRegex(RuntimeError, "CUDA DLL missing"):
                setup.prepare_stt("cuda")
        downloader.assert_called_once_with("large-v3-turbo")
        self.assertEqual(ctor.call_args.kwargs["compute_type"], "int8_float16")
        self.assertEqual(ctor.call_args.kwargs["device_index"], 0)

    def test_cpu_probe_downloads_small_and_uses_int8(self):
        model = Mock()
        model.transcribe.return_value = (iter([]), None)
        ctor = Mock(return_value=model)
        downloader = Mock(return_value="cpu-cache")
        modules = {"numpy": types.SimpleNamespace(zeros=Mock(), float32="float32"),
                   "faster_whisper": types.SimpleNamespace(WhisperModel=ctor),
                   "faster_whisper.utils": types.SimpleNamespace(download_model=downloader)}
        with patch.dict(sys.modules, modules), patch.object(setup.runpy, "run_path", return_value={}):
            setup.prepare_stt("cpu")
        downloader.assert_called_once_with("small")
        self.assertEqual(ctor.call_args.kwargs["compute_type"], "int8")
        self.assertTrue(ctor.call_args.kwargs["local_files_only"])

    def run_tts(self, valid=True, audible=True):
        tts = Mock()
        tts.synthesize.return_value = ([0.1, 0.2], 0.1)
        samples = types.SimpleNamespace(size=2)
        numpy = types.SimpleNamespace(asarray=lambda _: samples,
                                      isfinite=lambda _: types.SimpleNamespace(all=lambda: valid),
                                      any=lambda _: audible)
        modules = {"numpy": numpy, "supertonic": types.SimpleNamespace(TTS=Mock(return_value=tts))}
        with patch.dict(sys.modules, modules):
            setup.prepare_supertonic()
        return tts

    def test_tts_smoke_uses_exact_115_speed(self):
        tts = self.run_tts()
        self.assertEqual(tts.synthesize.call_args.kwargs["speed"], 1.15)
        self.assertEqual(tts.synthesize.call_args.kwargs["lang"], "ko")

    def test_invalid_or_silent_tts_cannot_pass_setup(self):
        for valid, audible in [(False, True), (True, False)]:
            with self.subTest(valid=valid, audible=audible):
                with self.assertRaisesRegex(RuntimeError, "invalid, or silent"):
                    self.run_tts(valid=valid, audible=audible)


if __name__ == "__main__":
    unittest.main()

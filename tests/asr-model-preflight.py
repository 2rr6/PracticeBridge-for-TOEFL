"""Synthetic model-directory checks: standard library only; never load a model."""
import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('asr_worker', Path(__file__).resolve().parents[1] / 'tools/asr-worker/worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class ModelPreflight(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='asr-preflight-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = {'modelDirectory': self.temp.name, 'profile': {'files': []}}
        for name in ['model.bin', 'config.json', 'tokenizer.json', 'vocabulary.txt']:
            self.pin(name, b'synthetic fixture, not model weights')

    def pin(self, name, content):
        (self.root / name).write_bytes(content)
        self.config['profile']['files'].append({'name': name, 'bytes': len(content), 'sha256': hashlib.sha256(content).hexdigest()})

    def test_unpinned_preprocessor_is_refused_before_loading(self):
        (self.root / 'preprocessor_config.json').write_text('{"sampling_rate":8000}')
        with self.assertRaisesRegex(worker.Failure, '^model_unexpected_file$'):
            worker.verify_model(self.config)

    def test_alternate_vocabulary_and_unknown_sidecars_are_refused(self):
        for name in ['vocabulary.json', 'shared_vocabulary.json', 'tokenizer_config.json', 'future-model-option.json']:
            with self.subTest(name=name):
                sidecar = self.root / name
                sidecar.write_text('{}')
                try:
                    with self.assertRaisesRegex(worker.Failure, '^model_unexpected_file$'):
                        worker.verify_model(self.config)
                finally:
                    sidecar.unlink()

    def test_closed_model_with_inert_provenance_metadata_is_allowed(self):
        (self.root / '.cache').mkdir()
        (self.root / 'source.json').write_text('{"note":"not an inference input"}')
        worker.verify_model(self.config)

    def test_pinned_preprocessor_is_hash_checked(self):
        self.pin('preprocessor_config.json', b'{"sampling_rate":16000}')
        worker.verify_model(self.config)
        (self.root / 'preprocessor_config.json').write_bytes(b'{"sampling_rate":80000}')
        with self.assertRaisesRegex(worker.Failure, '^model_hash_mismatch$'):
            worker.verify_model(self.config)


class AudioSampleBudget(unittest.TestCase):
    def test_original_fractional_selection_fits_the_sample_budget(self):
        start, end = 0.25049, 6.3933125
        selected_samples = int(end * 16000) - int(start * 16000)
        self.assertEqual(selected_samples, 98286)
        worker.validate_audio_sample_budget(selected_samples, end - start)

    def test_sample_aligned_budgets_keep_their_exact_boundary(self):
        for samples, seconds in [(16000, 1), (98285, 98285 / 16000), (4800000, 300)]:
            with self.subTest(samples=samples, seconds=seconds):
                worker.validate_audio_sample_budget(samples, seconds)

    def test_one_sample_beyond_each_allowed_budget_is_rejected(self):
        for samples, seconds in [(98287, 6.3933125 - 0.25049), (16001, 1), (4800001, 300)]:
            with self.subTest(samples=samples, seconds=seconds):
                with self.assertRaisesRegex(worker.Failure, '^audio_budget$'):
                    worker.validate_audio_sample_budget(samples, seconds)


class SegmentTimestampRange(unittest.TestCase):
    def test_current_millisecond_projection_accepts_legitimate_fractional_starts(self):
        for offset in [0.25, 0.25001, 0.25049, 0.2505, 0.250500001]:
            with self.subTest(offset=offset):
                segment = {'start': round(offset, 3), 'end': round(offset + 0.5, 3)}
                self.assertFalse(worker.segments_outside_audio([segment], offset, 8000))

    def test_true_lower_violation_is_preserved(self):
        self.assertTrue(worker.segments_outside_audio([{'start': 0.249, 'end': 0.75}], 0.25049, 8000))

    def test_true_upper_violation_is_preserved(self):
        self.assertTrue(worker.segments_outside_audio([{'start': 0.251, 'end': 0.751}], 0.25049, 8000))


if __name__ == '__main__':
    unittest.main(verbosity=2)

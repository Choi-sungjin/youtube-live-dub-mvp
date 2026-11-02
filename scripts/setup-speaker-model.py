"""Install pinned audEERING model for personal, noncommercial voice matching.

Model license: CC BY-NC-SA 4.0; see docs/speaker-voices.md.
"""
from pathlib import Path
from urllib.request import urlopen
from zipfile import ZipFile
import hashlib

ROOT = Path(__file__).resolve().parent.parent / 'backend/.cache/speaker-model'
URL = 'https://zenodo.org/records/7761387/files/w2v2-L-robust-6-age-gender.25c844af-1.1.1.zip?download=1'
CHECKSUM = 'd1479956f0cf50107198276dc1b4f1d0'

if __name__ == '__main__':
    ROOT.mkdir(parents=True, exist_ok=True)
    archive = ROOT / 'model.zip.part'
    if not archive.exists() or hashlib.md5(archive.read_bytes()).hexdigest() != CHECKSUM:
        with urlopen(URL, timeout=120) as source, archive.open('wb') as target:
            while chunk := source.read(1024 * 1024):
                target.write(chunk)
    if hashlib.md5(archive.read_bytes()).hexdigest() != CHECKSUM:
        raise SystemExit('Model checksum mismatch; no model installed.')
    with ZipFile(archive) as bundle:
        for name in ['model.onnx', 'model.yaml']:
            temporary = ROOT / (name + '.tmp')
            temporary.write_bytes(bundle.read(name))
            temporary.replace(ROOT / name)
    print('Speaker model installed (CPU; CC BY-NC-SA 4.0).')

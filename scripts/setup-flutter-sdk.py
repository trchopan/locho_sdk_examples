"""Fetch and checksum-verify the pinned standalone Flutter source package."""
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tarfile

root = Path(__file__).resolve().parent.parent
vendor = root / 'vendor'
vendor.mkdir(exist_ok=True)
filename = 'locho_flutter-0.1.0-dev.2.tar.gz'
archive = vendor / filename
if os.environ.get('LOCHO_FLUTTER_ARCHIVE'):
    shutil.copy2(os.environ['LOCHO_FLUTTER_ARCHIVE'], archive)
elif not archive.exists():
    subprocess.run(['gh', 'run', 'download', '38877468589', '--repo', 'trchopan/locho', '--name', 'locho-flutter-source-package', '--dir', str(vendor)], check=True)
if hashlib.sha256(archive.read_bytes()).hexdigest() != 'be944a6e24d5df8c55b6d3a142bbe11c78b16d8ceace9a9e3463736b19a22cad':
    raise RuntimeError('Flutter SDK checksum mismatch')
destination = vendor / 'locho_flutter'
if destination.exists():
    shutil.rmtree(destination)
with tarfile.open(archive) as source:
    source.extractall(vendor, filter='data')
print('Verified standalone locho_flutter 0.1.0-dev.2')

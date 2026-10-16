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
filename = 'locho_flutter-0.1.0-dev.1.tar.gz'
archive = vendor / filename
if os.environ.get('LOCHO_FLUTTER_ARCHIVE'):
    shutil.copy2(os.environ['LOCHO_FLUTTER_ARCHIVE'], archive)
elif not archive.exists():
    subprocess.run(['gh', 'run', 'download', '38831899415', '--repo', 'trchopan/locho', '--name', 'locho-flutter-source-package', '--dir', str(vendor)], check=True)
if hashlib.sha256(archive.read_bytes()).hexdigest() != '288608ecc0c8eb72bd076dfca16e77c02a5e0a1d86adf85f272da34bb5426de5':
    raise RuntimeError('Flutter SDK checksum mismatch')
destination = vendor / 'locho_flutter'
if destination.exists():
    shutil.rmtree(destination)
with tarfile.open(archive) as source:
    source.extractall(vendor, filter='data')
print('Verified standalone locho_flutter 0.1.0-dev.1')

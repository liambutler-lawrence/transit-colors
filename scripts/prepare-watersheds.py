"""Download and unpack pinned HydroSHEDS v2 inputs, checking archive hashes.

Keeps only one of the two duplicate RIV stream feature classes. Downloads are
removed after extraction; the expanded datasets and restartable build intermediates
need roughly 30 GB of free disk space. Uses curl for resumable downloads.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import zipfile

CACHE = Path(os.environ.get('WATERSHED_V2_CACHE', '/tmp'))
ARCHIVES = {
    'BAS': '97f7d16a1a3cd026d586a42efd46bfae395c185d974cd8f176217a8f224dbc6e',
    'RIV': '48447b706795eb0fa7f83d93479ff7dd570a3353f41a86dfc95d34d040e2bde9',
}


def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    manifest = {}
    for kind, expected in ARCHIVES.items():
        stem = f'north-america_{kind}_1s_v2r0.gdb'
        url = f'https://data.hydrosheds.org/file/hydrosheds-v2/{kind}/1s/{stem}.zip'
        manifest[kind] = {'url': url, 'sha256': expected}
        directory = CACHE / f'watersheds-v2-{kind.lower()}'
        marker = directory / '.verified-archive-sha256'
        if marker.exists() and marker.read_text().strip() == expected:
            continue
        archive = CACHE / f'{stem}.zip'
        subprocess.run(['curl', '--fail', '--location', '--retry', '3', '--continue-at', '-', url, '--output', str(archive)], check=True)
        with archive.open('rb') as file:
            actual = hashlib.file_digest(file, 'sha256').hexdigest()
        if actual != expected:
            raise ValueError(f'{kind} archive changed: expected {expected}, got {actual}. Review the source before rebuilding.')
        with zipfile.ZipFile(archive) as zipped:
            for entry in zipped.infolist():
                # Only the expected FileGDB and safe direct children are extracted.
                path = Path(entry.filename)
                if path.parts[0] != stem or '..' in path.parts or path.is_absolute() or len(path.parts) > 2:
                    raise ValueError(f'Unexpected archive entry {entry.filename}')
                if kind == 'RIV' and path.name.startswith('a00000013.'):
                    continue
                zipped.extract(entry, directory)
        marker.write_text(expected + '\n')
        archive.unlink()
    (CACHE / 'watersheds-v2-archives.json').write_text(json.dumps(manifest, indent=2) + '\n')


if __name__ == '__main__':
    main()

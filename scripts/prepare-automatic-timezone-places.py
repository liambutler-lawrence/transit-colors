"""Produce the compact offline naming gazetteer from verified source downloads.

Usage: python3 scripts/prepare-automatic-timezone-places.py /path/to/source/cache
The source directory must contain populated-places.geojson and cities500.zip.
"""
import gzip
import hashlib
import json
import sys
import zipfile
from pathlib import Path

cache = Path(sys.argv[1])
sources = [
    dict(id='natural-earth-populated-places',
         name='Natural Earth populated places 5.1.2; metropolitan estimates',
         url='https://raw.githubusercontent.com/nvkelso/natural-earth-vector/ca96624a56bd078437bca8184e78163e5039ad19/geojson/ne_10m_populated_places.geojson',
         license='Public domain', file='populated-places.geojson',
         sha256='9b8e3de09048ef00dfc70357dbb9fa324493f214b5e0ae4daf1aa79a8d10116b'),
    dict(id='geonames-cities500',
         name='GeoNames cities500 snapshot, 2026-09-10; settlement populations',
         url='https://download.geonames.org/export/dump/cities500.zip',
         license='Creative Commons Attribution 4.0 International (CC BY 4.0)',
         file='cities500.zip',
         sha256='c4ec45f18921948fc2bce5b1e89bcef98c0236c7bea986918999b3e3f71bd3ef'),
]
for source in sources:
    if hashlib.sha256((cache / source['file']).read_bytes()).hexdigest() != source['sha256']:
        raise ValueError('Source checksum mismatch: ' + source['file'])

# Tuple columns: ID, display name, ASCII name, longitude, latitude, population,
# country code (ADM0_A3 for primary, ISO2 for secondary), IANA timezone; primary
# additionally retains the GeoNames ID for filling absent IANA area prefixes.
primary = []
for f in json.loads((cache / 'populated-places.geojson').read_text())['features']:
    p = f['properties']
    population = max(0, p['POP_MAX'])
    # A few non-UN entries have only a city-proper count in POP_MAX (e.g. Newark).
    # Their source LandScan catchment estimates represent the surrounding metro.
    # Keep UN-calibrated metropolitan estimates for major conurbations.
    if not p['UN_FID'] and p['POP_MAX'] == p['POP_MIN']:
        population = max(population, *(p[k] or 0 for k in (
            'MAX_POP10', 'MAX_POP20', 'MAX_POP50', 'MAX_POP300', 'MAX_POP310')))
    primary.append([str(p['NE_ID']), p['NAME_EN'] or p['NAME'],
                    p['NAMEASCII'] or p['NAME_EN'] or p['NAME'],
                    p['LONGITUDE'], p['LATITUDE'], population, p['ADM0_A3'],
                    p['TIMEZONE'] or '', str(p['GEONAMESID'] or '')])

secondary = []
with zipfile.ZipFile(cache / 'cities500.zip') as z:
    for line in z.read('cities500.txt').decode().splitlines():
        p = line.split('\t')
        if p[7] not in ('PPL', 'PPLA', 'PPLA2', 'PPLA3', 'PPLA4', 'PPLA5',
                        'PPLC', 'PPLF', 'PPLG', 'PPLL', 'PPLR', 'STLMT'):
            continue
        secondary.append([p[0], p[1], p[2], float(p[5]), float(p[4]), int(p[14]), p[8], p[17]])

data = dict(sources=[{k: v for k, v in s.items() if k != 'file'} for s in sources],
            primary=sorted(primary), secondary=sorted(secondary))
content = (json.dumps(data, ensure_ascii=False, separators=(',', ':')) + '\n').encode()
output = Path('scripts/data/automatic-timezone-places.json.gz')
output.parent.mkdir(parents=True, exist_ok=True)
output.write_bytes(gzip.compress(content, mtime=0))
print('Prepared', len(primary), 'primary places and', len(secondary), 'settlements')

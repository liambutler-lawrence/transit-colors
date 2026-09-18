"""Assign named receiving bodies without modifying high-resolution watershed geometry.

Natural Earth's marine label polygons are generalized. Use the smallest covering
marine area (or nearest area for coastline/estuary gaps), then roll small bays and
channels up to the named regional receiving body. This is a cartographic grouping,
not a new delineation of drainage or a claim about surveyed marine boundaries.
"""
from collections import defaultdict
import hashlib
import json
import os
from pathlib import Path
import sqlite3

import numpy as np
import shapely
from shapely.geometry import shape

ROOT = Path(__file__).resolve().parents[1]
CACHE = Path(os.environ.get('WATERSHED_V2_CACHE', '/tmp'))
SOURCE = ROOT / 'data/sources/ne_10m_geography_marine_polys.geojson'
# Each small marine area belongs to exactly one displayed receiving body.
BODIES = [
    ('Atlantic Ocean', '#487bb8', 'North Atlantic Ocean|Chesapeake Bay|Bay of Fundy|Gulf of Maine|Pamlico Sound|Albemarle Sound|Straits of Florida|Long Island Sound|Massachusetts Bay|Delaware Bay'),
    ('Pacific Ocean', '#269e92', 'North Pacific Ocean|Hecate Strait|Salish Sea|Queen Charlotte Sound|Queen Charlotte Strait|Cordova Bay|Dixon Entrance|Golfo de Tehuantepec|San Francisco Bay|Golfo de Panamá|Columbia River|Monterey Bay'),
    ('Hudson Bay', '#b47ac5', 'Hudson Bay|James Bay|Foxe Basin|Hudson Strait|Ungava Bay|Frobisher Bay|Fury and Hecla Strait|Wager Bay'),
    ('Gulf of Mexico', '#d39b32', 'Gulf of Mexico|Bahía de Campeche|Lake Pontchartrain'),
    ('Gulf of California', '#e0774d', 'Golfo de California'),
    ('Caribbean Sea', '#70a543', 'Caribbean Sea|Gulf of Honduras|Yucatan Channel'),
    ('Arctic Ocean', '#889caf', "Arctic Ocean|The North Western Passages|Gulf of Boothia|Viscount Melville Sound|M'Clure Strait|Bathurst Inlet|Liddon Gulf|Hadley Bay|Wynniatt Bay|Sherman Basin|Goldsmith Channel|Lincoln Sea|Robeson Channel"),
    ('Bering Sea', '#9e8860', 'Bering Sea|Bristol Bay|Norton Sound|Baird Inlet'),
    ('Beaufort Sea', '#bd7284', 'Beaufort Sea|Amundsen Gulf|Prince ALbert Sound|Prince of Wales Strait|Mackenzie Bay|Minto Inlet|Richard Collinson Inlet|Husky Lakes|Darnley Bay|Franklin Bay'),
    ('Chukchi Sea', '#8f99cd', 'Chukchi Sea|Kotzebue Sound'),
    ('Gulf of Alaska', '#b493cd', 'Gulf of Alaska|Prince William Sound|Cook Inlet'),
    ('Labrador Sea', '#57a4bd', 'Labrador Sea|Hamilton Inlet'),
    ('Baffin Bay', '#bd8270', 'Baffin Bay|Davis Strait|Cumberland Sound|Jones Sound|Smith Sound|Eclipse Sound|Kane Basin|Hall Basin|Kennedy Channel'),
    ('Gulf of St. Lawrence', '#919b43', "Gulf of Saint Lawrence|Saint Lawrence River|Strait of Belle Isle|Bras d'Or Lake"),
]


def main():
    marine = json.loads(SOURCE.read_text())
    features = [f for f in marine['features'] if f['properties']['name'] and f['properties']['name'] != 'Sargasso Sea']
    geometries = np.array([shape(f['geometry']) for f in features])
    tree = shapely.STRtree(geometries)
    rollups = {name: body for body, _, names in BODIES for name in names.split('|')}
    assert len(rollups) == sum(len(names.split('|')) for _, _, names in BODIES)
    outlets = np.load(CACHE / 'watersheds-v2-outlets.npz')
    assert bool(outlets['node_verified'])
    drainage = dict(sqlite3.connect(CACHE / 'watersheds-v2-outlets.sqlite').execute('SELECT id, drainage FROM outlets'))
    groups = defaultdict(list)
    for identifier, xy in zip(outlets['id'], outlets['coordinates']):
        if drainage[int(identifier)] != 'ocean':
            continue
        point = shapely.Point(xy)
        hits = tree.query(point, predicate='intersects')
        index = min(hits, key=lambda i: geometries[i].area) if len(hits) else tree.nearest(point)
        marine_name = features[index]['properties']['name']
        assert marine_name in rollups, f'Review receiving body for {marine_name}'
        groups[rollups[marine_name]].append(int(identifier))
    result = {
        'source': 'Natural Earth 1:10m marine areas, v5.1.2 (public domain)',
        'source_url': 'https://github.com/nvkelso/natural-earth-vector/blob/v5.1.2/geojson/ne_10m_geography_marine_polys.geojson',
        'source_sha256': hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
        'method': 'Smallest covering marine area, nearest marine area for gaps; smaller bays and channels rolled into regional receiving bodies. Generalized marine labels do not alter watershed divides.',
        'count': sum(map(len, groups.values())),
        'bodies': [{'name': name, 'color': color, 'marine_areas': names.split('|'), 'basins': sorted(groups[name])} for name, color, names in BODIES],
    }
    assert result['count'] == sum(value == 'ocean' for value in drainage.values())
    (ROOT / 'data/north-america-watersheds-exit-bodies.json').write_text(json.dumps(result, separators=(',', ':')) + '\n')
    print({body['name']: len(body['basins']) for body in result['bodies']})


if __name__ == '__main__':
    main()

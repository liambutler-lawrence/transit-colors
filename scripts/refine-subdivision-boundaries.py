"""Overlay official US state borders on the coarse Natural Earth catalog.

Usage: python scripts/refine-subdivision-boundaries.py path/to/cb_2025_us_state_500k.shp
Requires pyshp and shapely. Download the source from:
https://www2.census.gov/geo/tiger/GENZ2025/shp/cb_2025_us_state_500k.zip
The authoritative US footprint removes overlapping coarse Canadian/Mexican
polygons. No route geometry or subdivision-specific exceptions are involved.
"""
import json
import sys
from pathlib import Path

import shapefile
from shapely.geometry import mapping, shape
from shapely.ops import unary_union

path = Path('data/north-america-subdivisions.geojson')
catalog = json.loads(path.read_text())
states = {
    'US-' + record.record['STUSPS']: shape(record.shape.__geo_interface__)
    for record in shapefile.Reader(sys.argv[1]).iterShapeRecords()
}
footprint = unary_union(list(states.values()))
for feature in catalog['features']:
    key = feature['properties']['id']
    geometry = states[key] if key in states else shape(feature['geometry']).difference(footprint)
    feature['geometry'] = mapping(geometry)
catalog['source'] = 'Natural Earth v5.1.1 admin 1, overlaid with US Census 2025 1:500,000 state boundaries'
catalog['usSourceUrl'] = 'https://www2.census.gov/geo/tiger/GENZ2025/shp/cb_2025_us_state_500k.zip'
path.write_text(json.dumps(catalog, separators=(',', ':')) + '\n')

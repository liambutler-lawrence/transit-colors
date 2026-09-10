"""Normalize pinned boundary sources. Run through build-automatic-timezones.mjs.

Dependencies: scripts/automatic-timezone-requirements.txt. Original polygon longitude
extents are retained before display simplification or intersection with the land mask.
"""
import io
import json
import sys
import subprocess
import zipfile
from pathlib import Path

import shapefile
from pyproj import CRS, Transformer
from shapely import STRtree, coverage_is_valid, coverage_simplify, make_valid
from shapely.geometry import MultiPolygon, mapping, shape
from shapely.ops import transform, unary_union

cache = Path(sys.argv[1])
output = Path(sys.argv[2])


def read(name):
    return json.loads((cache / name).read_text())


def polygons(geometry):
    if geometry.geom_type == 'Polygon':
        return [geometry] if not geometry.is_empty else []
    if hasattr(geometry, 'geoms'):
        return [p for child in geometry.geoms for p in polygons(child)]
    return []


def valid(geometry):
    return MultiPolygon(polygons(make_valid(geometry)))


def ranges(geometry):
    intervals = sorted([p.bounds[0], p.bounds[2]] for p in polygons(geometry))
    merged = []
    for west, east in intervals:
        if merged and west <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], east)
        else:
            merged.append([west, east])
    return merged


def display(geometry, gap=False, simplify=True):
    # Subpixel coastal strips need no topology-preserving zigzags. Classification
    # still uses every original interval, including all small islands.
    simplified = valid(geometry.simplify(0.001, preserve_topology=not gap)) if simplify else geometry
    visible = [p for p in polygons(simplified) if not simplify or p.area >= 1e-7]
    if not visible:
        visible = [max(polygons(geometry), key=lambda p: p.area).simplify(0.001, preserve_topology=True)]
    coordinates = mapping(MultiPolygon(visible))['coordinates']
    # Detailed island rings can collapse at five decimals. Six retains their
    # topology while keeping the shared-state coordinates identical.
    decimals = 5 if simplify else 6
    return dict(type='MultiPolygon', coordinates=[[[[round(x, decimals), round(y, decimals)] for x, y in ring] for ring in polygon] for polygon in coordinates])


nodes = []
shapes = {}


def node(id, name, country, geometry, level, parent=None, iso='', source='natural-earth', note=''):
    geometry = valid(geometry)
    result = dict(id=id, parent_id=parent, name=name, country_name=country['name'],
                  country_code=country['code'], iso_code=iso, level=level,
                  longitude_ranges=ranges(geometry), source=source,
                  geometry=display(geometry, gap=bool(note)), coverage_note=note)
    nodes.append(result)
    shapes[id] = geometry
    return result


iso = {item['code']: item for item in read('iso3166-2.json')['3166-2']}
admin1 = read('admin1.geojson')['features']
# INEGI's detailed states replace the generalized Natural Earth shapes. Build the
# country from those same states: clipping them to the old country outline would
# reintroduce the inaccurate boundary and manufacture coastal UTC+0 slivers.
mexico = read('MEX1.geojson')['features']
mexico_shapes = [shape(f['geometry']) for f in mexico]
if not coverage_is_valid(mexico_shapes):
    raise ValueError('INEGI states must form a non-overlapping shared-edge coverage')
mexico_display = coverage_simplify(mexico_shapes, 0.0001)
if not coverage_is_valid(mexico_display):
    raise ValueError('Mexico display simplification broke shared state boundaries')
detailed_display = {}
roots = {}
for feature in sorted(read('admin0.geojson')['features'], key=lambda f: f['properties']['NAME_EN']):
    p = feature['properties']
    country = dict(name=p['NAME_EN'], code=p['ADM0_A3'])
    detailed = country['code'] == 'MEX'
    roots[country['code']] = node('country:' + country['code'], country['name'], country,
                                   unary_union(mexico_shapes) if detailed else shape(feature['geometry']),
                                   0, iso=p['ISO_A2_EH'],
                                   source='geoboundaries-MEX1' if detailed else 'natural-earth')

# Ask the same TypeScript resolver used by the browser which countries need children.
# The parent geometry can then be discarded from the runtime dataset.

def unresolved(items):
    code = "import {fitAutomaticTimezone} from './src/automatic-timezones.ts';let s='';for await(const c of process.stdin)s+=c;console.log(JSON.stringify(JSON.parse(s).filter(r=>!fitAutomaticTimezone(r.longitude_ranges)).map(r=>r.id)));"
    result = subprocess.run(['node', '--import', 'tsx', '--input-type=module', '-e', code],
                            input=json.dumps(items), text=True, capture_output=True, check=True)
    return set(json.loads(result.stdout))


wide_countries = unresolved(nodes)
first_levels = {}
for code, root in roots.items():
    if root['id'] not in wide_countries:
        continue
    country = dict(name=root['name'], code=code)
    if code == 'MEX':
        grouped = []
        for f, geometry, simplified in zip(mexico, mexico_shapes, mexico_display):
            p = f['properties']
            # The pinned source incorrectly labels Distrito Federal as MX-MEX,
            # duplicating the State of Mexico. Correct that specific source ID.
            is_capital = p['shapeID'] == '31927357B79016588373767'
            iso_code = 'MX-CMX' if is_capital else p['shapeISO']
            name = 'Ciudad de México' if is_capital else p['shapeName']
            grouped.append((iso_code, name, iso_code, geometry, 'geoboundaries-MEX1'))
            detailed_display['admin1:MEX:' + iso_code] = valid(simplified)
        if len({g[0] for g in grouped}) != 32:
            raise ValueError('Expected 32 uniquely identified Mexican states')
    elif code in ('GRL', 'KIR'):
        features = read(code + '1.geojson')['features']
        grouped = [(f['properties']['shapeID'], f['properties']['shapeName'],
                    f['properties']['shapeISO'], shape(f['geometry']), 'geoboundaries-' + code + '1') for f in features]
    else:
        groups = {}
        for f in admin1:
            p = f['properties']
            if p['adm0_a3'] != code:
                continue
            iso_code = p['iso_3166_2'] or ''
            # Natural Earth's ~ codes denote synthetic units, not ISO subdivisions.
            if '~' in iso_code:
                if code not in ('PYF', 'ATF'):
                    continue
                iso_code = ''
            top = iso_code
            while iso.get(top, {}).get('parent'):
                top = iso[top]['parent']
            key = top or p['adm1_code']
            group = groups.setdefault(key, dict(name=iso.get(top, {}).get('name') or p['name_en'] or p['name'] or root['name'],
                                                iso=top, geometries=[]))
            group['geometries'].append(shape(f['geometry']))
        grouped = [(key, g['name'], g['iso'], unary_union([valid(x) for x in g['geometries']]), 'natural-earth-admin1') for key, g in groups.items()]
    first_levels[code] = []
    for key, name, iso_code, geometry, source in grouped:
        item = node('admin1:' + code + ':' + key, name, country, geometry, 1,
                    parent=root['id'], iso=iso_code, source=source)
        first_levels[code].append(item)
    print(code, 'first-level units:', len(first_levels[code]), file=sys.stderr, flush=True)

wide_first = unresolved([n for n in nodes if n['level'] == 1])


def second_features(code):
    if code != 'CAN':
        filename = code + '2.geojson'
        if not (cache / filename).exists():
            return
        for f in read(filename)['features']:
            p = f['properties']
            yield p['shapeID'], p['shapeName'], p.get('shapeISO', ''), valid(shape(f['geometry'])), None
        return
    with zipfile.ZipFile(cache / 'CAN-census.zip') as z:
        stem = 'lcd_000b21a_e'
        reader = shapefile.Reader(shp=io.BytesIO(z.read(stem + '.shp')),
                                 shx=io.BytesIO(z.read(stem + '.shx')),
                                 dbf=io.BytesIO(z.read(stem + '.dbf')), encoding='latin1')
        transformer = Transformer.from_crs(CRS.from_wkt(z.read(stem + '.prj').decode()), 'EPSG:4326', always_xy=True)
        province = {'24': 'CA-QC', '35': 'CA-ON', '59': 'CA-BC', '61': 'CA-NT', '62': 'CA-NU'}
        for f in reader.iterShapeRecords():
            p = f.record.as_dict()
            parent_iso = province.get(p['PRUID'])
            if parent_iso is None:
                continue
            geometry = valid(transform(transformer.transform, shape(f.shape.__geo_interface__)))
            yield p['CDUID'], p['CDNAME'], '', geometry, parent_iso


for code, parents in first_levels.items():
    needed = [p for p in parents if p['id'] in wide_first]
    if not needed:
        continue
    country = dict(name=roots[code]['name'], code=code)
    # Include every parent in the spatial join so a neighboring province's child
    # cannot be assigned just because it touches the province we need to split.
    parent_shapes = [shapes[p['id']] for p in parents]
    tree = STRtree(parent_shapes)
    count = 0
    for key, name, iso_code, geometry, parent_iso in second_features(code):
        if parent_iso:
            parent = next((p for p in parents if p['iso_code'] == parent_iso), None)
        else:
            candidates = tree.query(geometry, predicate='intersects')
            if len(candidates) == 0:
                continue
            parent_index = max(candidates, key=lambda i: geometry.intersection(parent_shapes[i]).area)
            parent = parents[parent_index]
        if parent is None or parent['id'] not in wide_first:
            continue
        node('admin2:' + code + ':' + key, name, country, geometry, 2,
             parent=parent['id'], iso=iso_code,
             source='statcan-census' if code == 'CAN' else 'geoboundaries-' + code + '2')
        count += 1
    print(code, 'second-level units:', count, file=sys.stderr, flush=True)

# Clip displayed descendants to their parent footprint, retaining their original
# extents for classification. Keep any source coverage gaps explicitly at UTC+0.
# Do this before simplification, so simplification slivers never become fake regions.
for parent in list(nodes):
    children = [n for n in nodes if n['parent_id'] == parent['id']]
    if not children:
        continue
    print('Reconciling', parent['name'], file=sys.stderr, flush=True)
    footprint = shapes[parent['id']]
    coverage = []
    for child in children:
        clipped = valid(shapes[child['id']].intersection(footprint))
        if clipped.is_empty:
            raise ValueError('Child has no overlap with its parent: ' + child['id'])
        shapes[child['id']] = clipped
        child['geometry'] = display(clipped)
        coverage.append(clipped)
    remainder = valid(footprint.difference(unary_union(coverage)))
    # Discard only numerical overlay dust (less than a square metre at the equator).
    remainder = MultiPolygon([p for p in polygons(remainder) if p.area > 1e-10])
    if not remainder.is_empty:
        country = dict(name=parent['country_name'], code=parent['country_code'])
        node(parent['id'] + ':uncovered', parent['name'] + ' — boundary coverage gaps',
             country, remainder, parent['level'] + 1, parent=parent['id'],
             source=parent['source'], note='The child boundary sources do not cover this part of the parent. UTC+0 is a temporary data fallback.')

# Keep the topology-preserving detailed coverage intact for all three consumers:
# borders, color mesh, and point inspection. Do not independently simplify states.
for item in nodes:
    if item['id'] in detailed_display:
        item['geometry'] = display(detailed_display[item['id']], simplify=False)
rounded_mexico = [shape(n['geometry']) for n in nodes if n['id'] in detailed_display]
if not all(g.is_valid for g in rounded_mexico) or not coverage_is_valid(rounded_mexico):
    raise ValueError('Coordinate rounding broke the detailed Mexico coverage')

output.write_text(json.dumps(nodes, ensure_ascii=False, separators=(',', ':')) + '\n')
print('Prepared', len(nodes), 'regions', file=sys.stderr, flush=True)

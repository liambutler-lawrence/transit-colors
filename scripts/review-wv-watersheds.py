"""Reproduce the reviewed WV groundwater crosswalk from source geometry and evidence.

This is an explicit review list, not a proximity-based repair for arbitrary sinks.
Trace endpoints must intersect source polygons, chained connections must reach the
same receiving primary basin, and all members of each terminal node stay together.
"""
from collections import defaultdict
import hashlib
import json
import os
from pathlib import Path
import sqlite3

import numpy as np
import shapely
from shapely.geometry import shape, Point

ROOT = Path(__file__).resolve().parents[1]
CACHE = Path(os.environ.get('WATERSHED_V2_CACHE', '/tmp'))
SOURCE = ROOT / 'data/sources'
TARGET = 72911
# Reviewed WVDEP feature IDs, in downstream order. Different intermediate springs
# within a shared surface-sink group still reach the same ultimate primary basin.
TRACES = {
    8329892: [255], 8376700: [31], 8359544: [190, 31],
    8368624: [189, 31], 8367809: [36], 8393908: [14],
    8375837: [32], 8386049: [54], 8389798: [17], 8390317: [53],
    8412671: [6], 8440158: [124], 8441994: [282],
    8447260: [222], 8447918: [286],
}
REGIONAL = {8403223, 8400813}
TRACE_URL = 'https://tagis.dep.wv.gov/arcgis/rest/services/WRPA_Web_GIS/Groundwater/MapServer/3'
PLAN_URL = 'https://dep.wv.gov/WWE/Programs/nonptsource/WBP/Documents/WP/MilliganCreek_WBP.pdf'
HUC_URL = 'https://tagis.dep.wv.gov/arcgis/rest/services/WRPA_Web_GIS/WV_Watersheds/MapServer'
ATLAS_URL = 'https://karstwaters.org/wp-content/uploads/2023/06/SP4-West-Va-Atlas-1.pdf'


def main():
    outlets = np.load(CACHE / 'watersheds-v2-outlets.npz')
    assert bool(outlets['node_verified'])
    nodes = dict(zip(map(int, outlets['id']), map(int, outlets['node'])))
    xy = {int(i): list(map(float, p)) for i, p in zip(outlets['id'], outlets['coordinates'])}
    groups = defaultdict(list)
    for i, n in nodes.items():
        if n in TRACES or n in REGIONAL:
            groups[n].append(i)
    wanted = {i for members in groups.values() for i in members}
    assert len(wanted) == 32 and len(groups) == 17, 'Review source changes before updating the crosswalk'
    kinds = dict(sqlite3.connect(CACHE / 'watersheds-v2-outlets.sqlite').execute('SELECT id, drainage FROM outlets'))
    assert all(kinds[i] == 'inland' for i in wanted)
    features = {}
    with (CACHE / 'north-america-primary-watersheds.geojsonl').open() as lines:
        for line in lines:
            identifier = json.loads(line.partition(',"geometry":')[0] + '}')['properties']['id']
            if identifier in wanted or identifier == TARGET:
                features[identifier] = json.loads(line)
    assert set(features) == wanted | {TARGET}
    ids = sorted(features)
    geometries = [shape(features[i]['geometry']) for i in ids]
    tree = shapely.STRtree(geometries)
    def at(coordinate):
        matches = tree.query(Point(coordinate), predicate='intersects')
        assert len(matches) == 1, f'Ambiguous evidence endpoint: {coordinate}'
        return ids[matches[0]]
    traces = {f['properties']['OBJECTID']: f for f in json.loads((SOURCE / 'wvdep-sunken-streams.geojson').read_text())['features']}
    huc8 = json.loads((SOURCE / 'wvdep-greenbrier-watershed.geojson').read_text())['features'][0]
    huc12 = json.loads((SOURCE / 'wvdep-milligan-watershed.geojson').read_text())['features'][0]
    assert str(huc8['properties']['HUC_8']).zfill(8) == '05050003'
    assert huc12['properties']['HUC_12'] == '050500030903'
    greenbrier, milligan = shape(huc8['geometry']), shape(huc12['geometry'])
    connections = []
    fixture = []
    for node, members in sorted(groups.items()):
        members.sort()
        sink = xy[members[0]]
        assert all(xy[i] == sink for i in members)
        points = [list(shape(features[i]['geometry']).representative_point().coords)[0] for i in members]
        link = dict(source_basins=members, target_basin=TARGET, terminal_node=node, modeled_sink=sink, test_points=points)
        if node in TRACES:
            path = []
            current = node
            for trace_id in TRACES[node]:
                trace = traces[trace_id]
                a, b = trace['geometry']['coordinates'][0], trace['geometry']['coordinates'][-1]
                start, end = at(a), at(b)
                assert nodes[start] == current, f'Trace {trace_id} does not start in the reviewed sink group'
                current = nodes[end]
                p = trace['properties']
                path.append(dict(feature_id=trace_id, source_basin=start, receiving_basin=end, sink=p['Sink_Name'], resurgence=p['Spring_Nam'], reference=p['Reference'], reference_location=p['Ref_Locat'], comment=p['Comment'].strip()))
            assert current == nodes[TARGET], 'Reviewed path does not reach the Mississippi basin'
            link.update(name=f"{path[0]['sink']} groundwater connection", evidence_kind='mapped_trace', source_url=TRACE_URL, trace_path=path,
                citation='WVDEP WV Sunken Streams public GIS; original references recorded for each trace; Jones (1997), pp. 84–93, for regional drainage.',
                downstream_route='; '.join(f"{p['sink']} → {p['resurgence']}" for p in path) + ' → Greenbrier drainage → New → Kanawha → Ohio → Mississippi',
                evidence='Mapped trace endpoints intersect the listed source and receiving polygons. Shared terminal-node groups are kept together. The reviewed regional routes reach the Greenbrier/Mississippi system; this does not assert one intermediate spring or a surveyed underground divide for every surface catchment.',
                regional_reference=ATLAS_URL)
        else:
            assert milligan.covers(Point(sink)), 'Reviewed sink moved outside the Milligan-Greenbrier unit'
            for identifier in members:
                geom = shape(features[identifier]['geometry'])
                assert greenbrier.covers(geom), 'Regional correction crosses the Greenbrier divide'
            link.update(name='Lewisburg / Davis Spring regional drainage', evidence_kind='documented_regional_drainage', source_url=PLAN_URL,
                citation='WVDEP Milligan Creek/Davis Spring Watershed Based Plan (March 2014), pp. 2–4; Jones (1997), pp. 90–91; WVDEP HUC 05050003 and 050500030903.',
                downstream_route='Lewisburg/Davis Spring and adjacent Greenbrier drainage → Greenbrier → New → Kanawha → Ohio → Mississippi',
                evidence='The reviewed sinks lie in the official Milligan Creek–Greenbrier River unit and the polygons lie wholly within the Greenbrier watershed. The plan and atlas document regional underground drainage toward Davis Spring/Greenbrier. This is regional primary-basin membership, not a claim of an individual dye trace from these modeled sink cells. A small eastern portion of source 86641 crosses the local HUC12 divide but remains in the Greenbrier system.',
                watershed_source_url=HUC_URL, huc8='05050003', huc12='050500030903', regional_reference=ATLAS_URL)
        connections.append(link)
        for identifier, point in zip(members, points):
            fixture.append(dict(source_basin=identifier, terminal_node=node, coordinate=point, catchments=features[identifier]['properties']['catchments'], evidence_kind=link['evidence_kind']))
    sources = [{'file': name, 'sha256': hashlib.sha256((SOURCE / name).read_bytes()).hexdigest()} for name in ['wvdep-sunken-streams.geojson', 'wvdep-greenbrier-watershed.geojson', 'wvdep-milligan-watershed.geojson']]
    result = dict(version=2, source_dataset='HydroSHEDS v2.0 North America BAS beta / RIV v2r0', evidence_sources=sources, connections=connections)
    (ROOT / 'data/north-america-watersheds-corrections.json').write_text(json.dumps(result, indent=2) + '\n')
    (ROOT / 'data/north-america-watersheds-wv-fixtures.json').write_text(json.dumps(dict(target_basin=TARGET, source_basins=32, source_terminal_nodes=17, catchments=sum(f['catchments'] for f in fixture), members=fixture), indent=2) + '\n')
    print(f'Reviewed {len(wanted)} source polygons in {len(groups)} sink groups; 15 trace-supported groups and 2 regional groups')


if __name__ == '__main__':
    main()

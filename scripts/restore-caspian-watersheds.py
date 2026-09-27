"""Migrate the former single Caspian feature without rebuilding other continents.

Requires the pre-migration global manifest, pinned EU/AS GRIT archives in GRIT_CACHE,
the global builder's Python dependencies, and tippecanoe/tile-join. A full global
build now produces the same separate-outlet grouping directly.
"""
import importlib.util
import json
import math
import shutil
import subprocess

spec = importlib.util.spec_from_file_location('global_builder', __file__.replace('restore-caspian-watersheds.py', 'build-global-watersheds.py'))
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


def main():
    summary = json.loads((builder.ROOT / 'data/global-watersheds-summary.json').read_text())
    closed = summary.get('closed_basins')
    if not closed:
        raise SystemExit('Caspian outlets are already separate; use the full builder for future rebuilds.')
    assert closed['count'] == 1
    stats = [builder.build_region(region) for region in ('EU', 'AS')]
    builder.finalize_regions(stats)
    members = []
    source = builder.CACHE / 'caspian-outlets.geojsonl'
    with source.open('w') as output:
        for region in ('EU', 'AS'):
            with (builder.CACHE / f'basins-{region}.geojsonl').open() as lines:
                for line in lines:
                    p = json.loads(line.partition(',"geometry":')[0] + '}')['properties']
                    if p.get('exit_body') == 'Caspian Sea':
                        assert p['drainage'] == 'endorheic'
                        assert p['terminal_node'] and p['outlet_stream']
                        assert math.isfinite(p['outlet_lon']) and math.isfinite(p['outlet_lat'])
                        assert p['source_basins'] == 1
                        members.append(p)
                        output.write(line)
    assert {p['id'] for p in members} == set(closed['members'])
    assert len(members) == closed['terminal_groups_joined']
    assert sum(p['catchments'] for p in members) == closed['catchments']
    assert math.isclose(sum(p['area_km2'] for p in members), closed['area_km2'], rel_tol=1e-12)
    original = builder.CACHE / 'global-before-caspian.pmtiles'
    with original.open('wb') as output:
        for part in summary['parts']:
            with (builder.ROOT / 'data' / part['file']).open('rb') as stream:
                shutil.copyfileobj(stream, output)
    replacement = builder.CACHE / 'caspian-outlets.pmtiles'
    subprocess.run(['tippecanoe', '--force', f'--output={replacement}', '--layer=basins',
        '--minimum-zoom=0', '--maximum-zoom=10', '--full-detail=14', '--low-detail=12',
        '--simplify-only-low-zooms', '--detect-shared-borders', '--no-tiny-polygon-reduction-at-maximum-zoom',
        '--no-feature-limit', '--no-tile-size-limit', '--no-tile-stats', str(source)], check=True)
    target = builder.CACHE / 'global-primary-watersheds.pmtiles'
    # tile-join copies existing geometries without simplification. With matching
    # extents, the unaffected basin coordinates retain their exact tile precision.
    subprocess.run(['tile-join', '--force', f'--output={target}', '--no-tile-size-limit',
        '--no-tile-stats', '--feature-filter={"basins":["!=","id",2900000001]}',
        '--name=Global primary watersheds outside North America',
        '--attribution=GRIT v1.0 / Wortmann et al. (2025); CC BY-NC 4.0',
        str(original), str(replacement)], check=True)
    for entry in summary['regions']:
        groups = entry.pop('closed_lake_terminal_groups')
        entry['inland_sea_terminal_groups'] = groups
        entry['displayed_individual_basins'] += groups
    summary.pop('closed_basins')
    summary['grouping'] += ' Receiving bodies, including the Caspian Sea, do not merge distinct terminal nodes.'
    summary['count'] += len(members) - 1
    builder.publish_archive(target, summary)
    print(f'Restored {len(members)} Caspian outlet basins; total global features: {summary["count"]}', flush=True)


if __name__ == '__main__':
    main()

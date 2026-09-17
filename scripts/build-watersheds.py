"""Build North American watershed tiles from official HydroBASINS v1c archives.

Requires Python 3, pyshp==2.3.1 and tippecanoe on PATH. Run from any directory.
Raw downloads are cached outside the repository; no network is used at runtime
for watershed boundaries. See docs/watersheds.md for provenance and limitations.
"""

import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import zipfile

import shapefile

ROOT = Path(__file__).resolve().parents[1]
CACHE = Path(os.environ.get("WATERSHED_CACHE", "/tmp/transit-watersheds"))
LEVELS = (4, 6, 8)
REGIONS = ("na", "ar", "gr")


def build():
    CACHE.mkdir(parents=True, exist_ok=True)
    manifest = {
        "dataset": "HydroBASINS v1c, standard polygons",
        "source": "https://www.hydrosheds.org/products/hydrobasins",
        "citation": "Lehner, B., Grill G. (2013), Hydrological Processes 27(15): 2171–2186",
        "resolution_arc_seconds": 15,
        "regions": list(REGIONS),
        "levels": {},
    }
    for level in LEVELS:
        count = 0
        area = 0
        ids = set()
        archives = []
        with tempfile.TemporaryDirectory(prefix="watersheds-") as temp:
            geojson = Path(temp) / "basins.geojsonl"
            with geojson.open("w") as output:
                for region in REGIONS:
                    stem = f"hybas_{region}_lev{level:02}_v1c"
                    url = f"https://data.hydrosheds.org/file/hydrobasins/standard/{stem}.zip"
                    archive = CACHE / f"{stem}.zip"
                    if not archive.exists():
                        print(f"Downloading {url}", flush=True)
                        partial = archive.with_suffix(".partial")
                        subprocess.run(["curl", "--fail", "--location", "--retry", "3", "--silent", "--show-error", url, "--output", str(partial)], check=True)
                        partial.replace(archive)
                    archives.append({"url": url, "sha256": hashlib.sha256(archive.read_bytes()).hexdigest()})
                    with zipfile.ZipFile(archive) as zipped:
                        # Only extract the expected shapefile components.
                        for suffix in ("shp", "shx", "dbf"):
                            name = f"{stem}.{suffix}"
                            (Path(temp) / name).write_bytes(zipped.read(name))
                    with shapefile.Reader(str(Path(temp) / stem)) as reader:
                        for entry in reader.iterShapeRecords():
                            record = entry.record.as_dict()
                            basin_id = int(record["HYBAS_ID"])
                            if basin_id in ids:
                                raise ValueError(f"Duplicate basin {basin_id}")
                            ids.add(basin_id)
                            props = {
                                "id": basin_id,
                                "level": level,
                                "area_km2": record["SUB_AREA"],
                                "upstream_km2": record["UP_AREA"],
                                "next_down": int(record["NEXT_DOWN"]),
                                "main_basin": int(record["MAIN_BAS"]),
                                "endorheic": int(record["ENDO"]),
                                "coastal": int(record["COAST"]),
                                "region": region,
                                "color": (basin_id // 10) % 8,
                            }
                            feature = {
                                "type": "Feature", "id": basin_id,
                                "properties": props,
                                "geometry": entry.shape.__geo_interface__,
                            }
                            output.write(json.dumps(feature, separators=(",", ":")) + "\n")
                            count += 1
                            area += props["area_km2"]
            target = ROOT / "data" / f"north-america-watersheds-{level}.pmtiles"
            subprocess.run([
                "tippecanoe", "--force", f"--output={target}", "--layer=basins",
                "--minimum-zoom=0", "--maximum-zoom=9", "--detect-shared-borders",
                "--no-feature-limit", "--no-tile-size-limit", "--no-tile-stats", "--quiet",
                "--name=North America watersheds", "--attribution=HydroSHEDS / WWF; Lehner & Grill (2013)",
                str(geojson),
            ], check=True)
            manifest["levels"][str(level)] = {
                "count": count, "area_km2": round(area, 1), "archives": archives,
                "file": target.name, "bytes": target.stat().st_size,
            }
            print(f"Level {level}: {count} basins, {target.stat().st_size / 1e6:.1f} MB", flush=True)
    (ROOT / "data" / "north-america-watersheds-summary.json").write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    build()

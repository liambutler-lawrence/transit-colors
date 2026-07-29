#!/bin/sh
set -eu

cache_dir="data/.osm-highway-cache"
mkdir -p "$cache_dir"

download_and_filter() {
  region="$1"
  url="$2"
  raw_path="$cache_dir/current-region.osm.pbf"
  filtered_path="$cache_dir/$region-motorways.osm.pbf"

  if [ -f "$filtered_path" ]; then
    echo "Reusing filtered $region extract."
    return
  fi

  echo "Downloading ${region}…"
  curl --fail --location --retry 4 --continue-at - --output "$raw_path" "$url"
  echo "Filtering ${region} motorway topology…"
  osmium tags-filter \
    --overwrite \
    --output "$filtered_path" \
    "$raw_path" \
    w/highway=motorway,motorway_link
  rm -f "$raw_path"
}

download_and_filter \
  "mexico" \
  "https://download.geofabrik.de/north-america/mexico-latest.osm.pbf"
download_and_filter \
  "canada" \
  "https://download.geofabrik.de/north-america/canada-latest.osm.pbf"
download_and_filter \
  "us-midwest" \
  "https://download.geofabrik.de/north-america/us-midwest-latest.osm.pbf"
download_and_filter \
  "us-northeast" \
  "https://download.geofabrik.de/north-america/us-northeast-latest.osm.pbf"
download_and_filter \
  "us-pacific" \
  "https://download.geofabrik.de/north-america/us-pacific-latest.osm.pbf"
download_and_filter \
  "us-south" \
  "https://download.geofabrik.de/north-america/us-south-latest.osm.pbf"
download_and_filter \
  "us-west" \
  "https://download.geofabrik.de/north-america/us-west-latest.osm.pbf"

echo "Merging filtered motorway extracts…"
osmium merge \
  --overwrite \
  --output "$cache_dir/north-america-motorways.osm.pbf" \
  "$cache_dir/canada-motorways.osm.pbf" \
  "$cache_dir/mexico-motorways.osm.pbf" \
  "$cache_dir/us-midwest-motorways.osm.pbf" \
  "$cache_dir/us-northeast-motorways.osm.pbf" \
  "$cache_dir/us-pacific-motorways.osm.pbf" \
  "$cache_dir/us-south-motorways.osm.pbf" \
  "$cache_dir/us-west-motorways.osm.pbf"

osmium fileinfo --extended "$cache_dir/north-america-motorways.osm.pbf"

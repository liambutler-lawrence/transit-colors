"""Cartographic receiving-body labels, independent of drainage delineation."""
import colorsys
import json
from pathlib import Path
import numpy as np
import shapely
from shapely.geometry import shape

ROOT = Path(__file__).resolve().parents[1]
# Keep regional seas comparable to the existing North American categories.
MAJOR = '''Arctic Ocean|North Atlantic Ocean|South Atlantic Ocean|North Pacific Ocean|South Pacific Ocean|INDIAN OCEAN|SOUTHERN OCEAN|Mediterranean Sea|Black Sea|Baltic Sea|North Sea|Norwegian Sea|Greenland Sea|Barents Sea|Kara Sea|Laptev Sea|East Siberian Sea|Bering Sea|Sea of Okhotsk|Sea of Japan|Yellow Sea|East China Sea|South China Sea|Philippine Sea|Arabian Sea|Bay of Bengal|Red Sea|Persian Gulf|Gulf of Aden|Andaman Sea|Caribbean Sea|Gulf of Mexico|Golfo de California|Gulf of Guinea|Tasman Sea|Coral Sea|Arafura Sea|Timor Sea|Java Sea|Banda Sea|Celebes Sea|Sulu Sea|Gulf of Thailand|Caspian Sea|Hudson Bay|Baffin Bay|Labrador Sea|Gulf of Alaska|Chukchi Sea|Beaufort Sea|Gulf of Saint Lawrence'''.split('|')
ALIASES = {'North Atlantic Ocean': 'Atlantic Ocean', 'South Atlantic Ocean': 'Atlantic Ocean', 'North Pacific Ocean': 'Pacific Ocean', 'South Pacific Ocean': 'Pacific Ocean', 'INDIAN OCEAN': 'Indian Ocean', 'SOUTHERN OCEAN': 'Southern Ocean', 'Golfo de California': 'Gulf of California', 'Gulf of Saint Lawrence': 'Gulf of St. Lawrence'}
# Named estuaries/gulfs outside their parent polygon need explicit rollups.
ROLLUPS = {
    'Río de la Plata': 'Atlantic Ocean', 'Amazon River': 'Atlantic Ocean',
    'Baía de Marajó': 'Atlantic Ocean', 'Boca Grande': 'Atlantic Ocean',
    'Canal do Sul': 'Atlantic Ocean', 'Canal do Norte': 'Atlantic Ocean',
    'Yangtze River': 'East China Sea', 'Bo Hai': 'Yellow Sea',
    'Sea of Azov': 'Black Sea', 'Bosporus': 'Black Sea',
    'Sea of Marmara': 'Mediterranean Sea', 'Dardanelles': 'Mediterranean Sea',
    'Adriatic Sea': 'Mediterranean Sea', 'Aegean Sea': 'Mediterranean Sea',
    'Ionian Sea': 'Mediterranean Sea', 'Tyrrhenian Sea': 'Mediterranean Sea',
    'Ligurian Sea': 'Mediterranean Sea', 'Alboran Sea': 'Mediterranean Sea',
    'Gulf of Finland': 'Baltic Sea', 'Gulf of Bothnia': 'Baltic Sea',
    'Gulf of Riga': 'Baltic Sea', 'Stettiner Haff': 'Baltic Sea',
    'White Sea': 'Barents Sea', 'Gulf of Ob': 'Kara Sea', 'Yenisey Gulf': 'Kara Sea',
    'Gulf of Suez': 'Red Sea', 'Gulf of Aqaba': 'Red Sea',
    'Gulf of Oman': 'Arabian Sea', 'Gulf of Martaban': 'Andaman Sea',
    'Gulf of Tonkin': 'South China Sea', 'Gulf of Carpentaria': 'Arafura Sea',
    'Gulf of Papua': 'Coral Sea', 'Great Australian Bight': 'Indian Ocean',
    'Gulf St. Vincent': 'Indian Ocean', 'English Channel': 'Atlantic Ocean',
    'Irish Sea': 'Atlantic Ocean', 'Skagerrak': 'North Sea', 'Kattegat': 'Baltic Sea',
    'Garabogaz Bay': 'Caspian Sea',
    'Mozambique Channel': 'Indian Ocean', 'Laccadive Sea': 'Indian Ocean',
    'Gulf of Mannar': 'Indian Ocean', 'Palk Strait': 'Indian Ocean',
    'Bay of Biscay': 'Atlantic Ocean', 'Bristol Channel': 'Atlantic Ocean',
    'Great Barrier Reef': 'Coral Sea', 'Bismarck Sea': 'Pacific Ocean',
    'Solomon Sea': 'Pacific Ocean', 'Cook Strait': 'Tasman Sea',
    'Bass Strait': 'Tasman Sea', 'Denmark Strait': 'Greenland Sea',
}


class MarineBodies:
    def __init__(self):
        source = json.loads((ROOT / 'data/sources/ne_10m_geography_marine_polys.geojson').read_text())
        previous = json.loads((ROOT / 'data/north-america-watersheds-exit-bodies.json').read_text())
        rollups = {area: body['name'] for body in previous['bodies'] for area in body['marine_areas']}
        rollups.update(ROLLUPS)
        features = [f for f in source['features'] if f['properties']['name'] in MAJOR or f['properties']['name'] in rollups]
        self.names = [ALIASES.get(f['properties']['name'], rollups.get(f['properties']['name'], f['properties']['name'])) for f in features]
        self.geometries = np.array([shape(f['geometry']) for f in features])
        self.tree = shapely.STRtree(self.geometries)
        self.colors = {b['name']: b['color'] for b in previous['bodies']}
        for index, name in enumerate(sorted(set(self.names) - self.colors.keys())):
            # Fixed categorical palette; preserve every existing North American color.
            rgb = colorsys.hls_to_rgb((index * 0.61803398875 + 0.09) % 1, 0.43 + (index % 3) * 0.08, 0.48)
            self.colors[name] = '#' + ''.join(f'{round(c * 255):02x}' for c in rgb)

    def classify(self, xy):
        point = shapely.Point(xy)
        hits = self.tree.query(point, predicate='intersects')
        index = min(hits, key=lambda i: self.geometries[i].area) if len(hits) else self.tree.nearest(point)
        return self.names[index]

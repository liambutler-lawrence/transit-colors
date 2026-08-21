import type { FilterSpecification, MapGeoJSONFeature } from 'maplibre-gl';

import {
  LAND_USE_CATEGORIES,
  isLandUseCategory,
  landUseCategoryDetails,
  landUsePropertiesSchema,
  type LandUseCategory,
  type LandUseProperties,
} from '../land-use.js';
import {
  compactPanelQuery,
  formatInteger,
  landUseCategoriesEl,
  landUseColorsToggle,
  landUseHistoricToggle,
  landUseMetadataEl,
  landUseNameEl,
  landUseParcelCountEl,
  landUseRedevelopmentCountEl,
  landUseResetFilterButton,
  landUseSelectionTypeEl,
  landUseSummaryEl,
  landUseVacantCountEl,
  landUseZoningToggle,
  map,
  runtime,
} from './context.js';
import {
  firstSymbolLayerId,
  replaceMetadata,
  setLayerVisibility,
} from './map-ui-utils.js';
import { expressionSpecificationSchema } from './types.js';

const SOURCE_ID = 'jersey-city-land-use';
const PARCEL_SOURCE_LAYER = 'parcels';
const PARCEL_FILL_LAYER_ID = 'land-use-parcels-fill';
const PARCEL_OUTLINE_LAYER_ID = 'land-use-parcels-outline';
const ZONING_LAYER_ID = 'land-use-zoning-boundaries';
const HISTORIC_FILL_LAYER_ID = 'land-use-historic-fill';
const HISTORIC_LINE_LAYER_ID = 'land-use-historic-boundaries';

const activeCategories = new Set<LandUseCategory>(
  LAND_USE_CATEGORIES.map(({ key }) => key),
);
let hoveredParcelId: string | number | null = null;
let controlsInstalled = false;
let hoverInstalled = false;
let statisticsFrame: number | null = null;

function landUseBeforeLayerId(): string | undefined {
  return map.getLayer('water') ? 'water' : firstSymbolLayerId();
}

function categoryFilter(): FilterSpecification {
  return activeCategories.size > 0
    ? ['in', ['get', 'category'], ['literal', [...activeCategories]]]
    : ['==', ['get', 'category'], '__none__'];
}

function syncCategoryFilter(): void {
  const filter = categoryFilter();
  for (const layerId of [PARCEL_FILL_LAYER_ID, PARCEL_OUTLINE_LAYER_ID]) {
    if (map.getLayer(layerId)) map.setFilter(layerId, filter);
  }
  for (const button of landUseCategoriesEl.querySelectorAll<HTMLButtonElement>(
    '[data-land-use-category]',
  )) {
    const category = button.dataset['landUseCategory'];
    button.setAttribute(
      'aria-pressed',
      String(isLandUseCategory(category) && activeCategories.has(category)),
    );
  }
  landUseResetFilterButton.disabled =
    activeCategories.size === LAND_USE_CATEGORIES.length;
  updateLandUseViewportStatistics();
}

function installControls(): void {
  if (controlsInstalled) return;
  controlsInstalled = true;
  landUseCategoriesEl.replaceChildren(
    ...LAND_USE_CATEGORIES.map((category) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'land-use-category';
      button.dataset['landUseCategory'] = category.key;
      button.setAttribute('aria-pressed', 'true');
      button.title = category.description;
      button.style.setProperty('--land-use-color', category.color);

      const swatch = document.createElement('span');
      swatch.className = 'land-use-swatch';
      swatch.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.className = 'land-use-category-label';
      label.textContent = category.label;
      const count = document.createElement('span');
      count.className = 'land-use-category-count';
      count.dataset['landUseCount'] = category.key;
      count.textContent = '—';
      button.append(swatch, label, count);
      return button;
    }),
  );
  landUseCategoriesEl.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>('[data-land-use-category]');
    if (!button || !landUseCategoriesEl.contains(button)) return;
    const category = button.dataset['landUseCategory'];
    if (!isLandUseCategory(category)) return;
    if (activeCategories.has(category)) activeCategories.delete(category);
    else activeCategories.add(category);
    syncCategoryFilter();
  });
  landUseResetFilterButton.addEventListener('click', () => {
    activeCategories.clear();
    for (const { key } of LAND_USE_CATEGORIES) activeCategories.add(key);
    syncCategoryFilter();
  });
  for (const toggle of [
    landUseColorsToggle,
    landUseZoningToggle,
    landUseHistoricToggle,
  ]) {
    toggle.addEventListener('change', syncLandUseVisibility);
  }
}

function taxClassLabel(taxClass: string): string {
  const labels: Record<string, string> = {
    '1': 'Vacant land',
    '2': 'Residential',
    '3A': 'Farm residence',
    '3B': 'Qualified farm',
    '4A': 'Commercial',
    '4B': 'Industrial',
    '4C': 'Apartment',
    '5A': 'Railroad',
    '5B': 'Railroad',
    '15A': 'Public school',
    '15B': 'Other school',
    '15C': 'Public property',
    '15D': 'Religious / charitable',
    '15E': 'Cemetery',
    '15F': 'Other exempt',
  };
  return labels[taxClass] ? `${taxClass} · ${labels[taxClass]}` : taxClass;
}

function zoningLabel(properties: LandUseProperties): string {
  if (properties.zone_code && properties.zone_name) {
    return `${properties.zone_code} · ${properties.zone_name}`;
  }
  return properties.zone_name || properties.zone_code || 'Not mapped';
}

function renderParcelDetails(properties: LandUseProperties): void {
  const category = landUseCategoryDetails(properties.category);
  const blockLot = [
    properties.block && `Block ${properties.block}`,
    properties.lot && `Lot ${properties.lot}`,
  ]
    .filter(Boolean)
    .join(' · ');
  landUseSelectionTypeEl.textContent = category.label;
  landUseNameEl.textContent = properties.address || blockLot || 'Jersey City parcel';
  landUseSummaryEl.textContent = category.description;
  replaceMetadata(landUseMetadataEl, [
    {
      label: 'Status',
      value:
        properties.status === 'vacant'
          ? 'Vacant'
          : properties.status === 'civic'
            ? 'Civic / exempt'
            : properties.status === 'active'
              ? 'Active'
              : 'Other',
    },
    { label: 'Zoning', value: zoningLabel(properties) },
    { label: 'Zoning basis', value: properties.zone_type },
    {
      label: 'Historic district',
      value: properties.historic || 'Outside mapped district',
    },
    { label: 'Year built', value: properties.year_built || 'Not recorded' },
    { label: 'Stories', value: properties.stories || 'Not recorded' },
    {
      label: 'Tax class',
      value: taxClassLabel(properties.tax_class) || 'Not recorded',
    },
    { label: 'Building record', value: properties.building || 'Not recorded' },
    { label: 'Parcel', value: blockLot || 'Not recorded' },
  ]);
}

function parsedProperties(
  feature: MapGeoJSONFeature | undefined,
): LandUseProperties | null {
  const result = landUsePropertiesSchema.safeParse(feature?.properties);
  return result.success ? result.data : null;
}

function clearHover(): void {
  if (hoveredParcelId !== null) {
    map.setFeatureState(
      { source: SOURCE_ID, sourceLayer: PARCEL_SOURCE_LAYER, id: hoveredParcelId },
      { hover: false },
    );
  }
  hoveredParcelId = null;
}

function installHover(): void {
  if (hoverInstalled) return;
  hoverInstalled = true;
  map.on('mousemove', PARCEL_FILL_LAYER_ID, (event) => {
    if (runtime.activeProduct !== 'landuse') return;
    const feature = event.features?.[0];
    const properties = parsedProperties(feature);
    if (!feature || feature.id === undefined || !properties) return;
    if (hoveredParcelId !== feature.id) {
      clearHover();
      hoveredParcelId = feature.id;
      map.setFeatureState(
        { source: SOURCE_ID, sourceLayer: PARCEL_SOURCE_LAYER, id: feature.id },
        { hover: true },
      );
    }
    renderParcelDetails(properties);
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', PARCEL_FILL_LAYER_ID, () => {
    clearHover();
    map.getCanvas().style.cursor = '';
  });
  map.on('click', PARCEL_FILL_LAYER_ID, (event) => {
    if (runtime.activeProduct !== 'landuse') return;
    const properties = parsedProperties(event.features?.[0]);
    if (properties) renderParcelDetails(properties);
  });
}

export function installJerseyCityLandUse(): void {
  if (map.getSource(SOURCE_ID)) return;
  const tilesUrl = new URL(
    'data/jersey-city-land-use.pmtiles?v=20260821b',
    window.location.href,
  ).href;
  map.addSource(SOURCE_ID, {
    type: 'vector',
    url: `pmtiles://${tilesUrl}`,
    attribution:
      'Parcels, zoning, and historic districts: <a href="https://experience.arcgis.com/experience/63717e4171904651a65fe9827fcb5571/">Jersey City Division of City Planning</a>',
    promoteId: {
      parcels: 'id',
      zoning: 'id',
      historic: 'id',
    },
  });

  const beforeLayerId = landUseBeforeLayerId();
  map.addLayer(
    {
      id: PARCEL_FILL_LAYER_ID,
      type: 'fill',
      source: SOURCE_ID,
      'source-layer': PARCEL_SOURCE_LAYER,
      filter: categoryFilter(),
      layout: { visibility: 'none' },
      paint: {
        'fill-color': expressionSpecificationSchema.parse([
          'match',
          ['get', 'category'],
          ...LAND_USE_CATEGORIES.flatMap(({ key, color }) => [key, color]),
          '#8e969c',
        ]),
        'fill-opacity': [
          'case',
          ['boolean', ['feature-state', 'hover'], false],
          0.94,
          0.78,
        ],
      },
    },
    beforeLayerId,
  );
  map.addLayer(
    {
      id: HISTORIC_FILL_LAYER_ID,
      type: 'fill',
      source: SOURCE_ID,
      'source-layer': 'historic',
      layout: { visibility: 'none' },
      paint: {
        'fill-color': '#7651a8',
        'fill-opacity': 0.09,
      },
    },
    beforeLayerId,
  );
  map.addLayer(
    {
      id: PARCEL_OUTLINE_LAYER_ID,
      type: 'line',
      source: SOURCE_ID,
      'source-layer': PARCEL_SOURCE_LAYER,
      filter: categoryFilter(),
      minzoom: 11,
      layout: { visibility: 'none' },
      paint: {
        'line-color': '#303943',
        'line-opacity': [
          'case',
          ['boolean', ['feature-state', 'hover'], false],
          0.95,
          0.46,
        ],
        'line-width': [
          'interpolate',
          ['linear'],
          ['zoom'],
          11,
          ['case', ['boolean', ['feature-state', 'hover'], false], 2.4, 0.25],
          16,
          ['case', ['boolean', ['feature-state', 'hover'], false], 2.4, 0.9],
        ],
      },
    },
    beforeLayerId,
  );
  map.addLayer(
    {
      id: ZONING_LAYER_ID,
      type: 'line',
      source: SOURCE_ID,
      'source-layer': 'zoning',
      layout: { visibility: 'none' },
      paint: {
        'line-color': [
          'case',
          ['==', ['get', 'redevelopment'], 1],
          '#9b2c64',
          '#172f4d',
        ],
        'line-opacity': 0.88,
        'line-dasharray': [2, 1.2],
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.1, 15, 2.2],
      },
    },
    beforeLayerId,
  );
  map.addLayer(
    {
      id: HISTORIC_LINE_LAYER_ID,
      type: 'line',
      source: SOURCE_ID,
      'source-layer': 'historic',
      layout: { visibility: 'none' },
      paint: {
        'line-color': '#7651a8',
        'line-opacity': 0.95,
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.5, 15, 3],
      },
    },
    beforeLayerId,
  );
  installControls();
  installHover();
  map.on('idle', scheduleLandUseViewportStatistics);
  map.on('moveend', scheduleLandUseViewportStatistics);
  map.on('sourcedata', (event) => {
    if (event.sourceId === SOURCE_ID) scheduleLandUseViewportStatistics();
  });
  syncLandUseVisibility();
}

export function positionJerseyCityLandUseLayers(): void {
  const beforeLayerId = landUseBeforeLayerId();
  for (const layerId of [
    PARCEL_FILL_LAYER_ID,
    HISTORIC_FILL_LAYER_ID,
    PARCEL_OUTLINE_LAYER_ID,
    ZONING_LAYER_ID,
    HISTORIC_LINE_LAYER_ID,
  ]) {
    if (map.getLayer(layerId)) map.moveLayer(layerId, beforeLayerId);
  }
}

export function syncLandUseVisibility(): void {
  const active = runtime.activeProduct === 'landuse';
  const showParcels = active && landUseColorsToggle.checked;
  setLayerVisibility(PARCEL_FILL_LAYER_ID, showParcels);
  setLayerVisibility(PARCEL_OUTLINE_LAYER_ID, showParcels);
  setLayerVisibility(ZONING_LAYER_ID, active && landUseZoningToggle.checked);
  setLayerVisibility(HISTORIC_FILL_LAYER_ID, active && landUseHistoricToggle.checked);
  setLayerVisibility(HISTORIC_LINE_LAYER_ID, active && landUseHistoricToggle.checked);
  if (!active) {
    clearHover();
    map.getCanvas().style.cursor = '';
  } else {
    updateLandUseViewportStatistics();
  }
}

export function updateLandUseViewportStatistics(): void {
  if (runtime.activeProduct !== 'landuse' || !map.getLayer(PARCEL_FILL_LAYER_ID)) {
    return;
  }
  const parcels = new Map<string | number, LandUseProperties>();
  for (const feature of map.queryRenderedFeatures({ layers: [PARCEL_FILL_LAYER_ID] })) {
    const properties = parsedProperties(feature);
    if (properties) parcels.set(properties.id, properties);
  }
  const categoryCounts = new Map<LandUseCategory, number>(
    LAND_USE_CATEGORIES.map(({ key }) => [key, 0]),
  );
  let vacantCount = 0;
  let redevelopmentCount = 0;
  for (const properties of parcels.values()) {
    categoryCounts.set(
      properties.category,
      (categoryCounts.get(properties.category) ?? 0) + 1,
    );
    if (properties.status === 'vacant') vacantCount += 1;
    if (properties.zone_type === 'Redevelopment plan') redevelopmentCount += 1;
  }
  landUseParcelCountEl.textContent = formatInteger(parcels.size);
  landUseVacantCountEl.textContent = formatInteger(vacantCount);
  landUseRedevelopmentCountEl.textContent = formatInteger(redevelopmentCount);
  for (const countEl of landUseCategoriesEl.querySelectorAll<HTMLElement>(
    '[data-land-use-count]',
  )) {
    const category = countEl.dataset['landUseCount'];
    if (isLandUseCategory(category)) {
      countEl.textContent = formatInteger(categoryCounts.get(category) ?? 0);
    }
  }
}

function scheduleLandUseViewportStatistics(): void {
  if (statisticsFrame !== null) return;
  statisticsFrame = window.requestAnimationFrame(() => {
    statisticsFrame = null;
    updateLandUseViewportStatistics();
  });
}

export function focusJerseyCityLandUse(): void {
  map.setMaxBounds(null);
  map.fitBounds(
    [
      [-74.12, 40.67],
      [-74.01, 40.79],
    ],
    {
      bearing: 0,
      duration: 0,
      padding: compactPanelQuery.matches ? 20 : 38,
      pitch: 0,
    },
  );
}

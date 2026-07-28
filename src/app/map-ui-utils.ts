import type { MetadataDetail } from './types.js';
import { activeStationModes, map, state } from './context.js';

export function activeAccessTransitTimes(): Map<string, number> {
  const result = new Map<string, number>();
  for (const [stationId, minutes] of state.transitTimes ?? []) {
    const stationMode = state.stationById.get(stationId)?.properties.mode;
    result.set(
      stationId,
      stationMode !== undefined && activeStationModes.has(stationMode) ? minutes : 90,
    );
  }
  return result;
}

export function firstSymbolLayerId(): string | undefined {
  return map.getStyle().layers.find((layer) => layer.type === 'symbol')?.id;
}

export function setLayerVisibility(id: string, visible: boolean): void {
  if (map.getLayer(id)) {
    map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
  }
}

export function replaceMetadata(
  element: Element,
  details: readonly MetadataDetail[],
): void {
  element.replaceChildren(
    ...details
      .filter(
        (detail) =>
          detail.value !== undefined && detail.value !== null && detail.value !== '',
      )
      .map((detail) => {
        const term = document.createElement('dt');
        term.textContent = detail.label;
        const description = document.createElement('dd');
        description.textContent = String(detail.value);
        const fragment = document.createDocumentFragment();
        fragment.append(term, description);
        return fragment;
      }),
  );
}

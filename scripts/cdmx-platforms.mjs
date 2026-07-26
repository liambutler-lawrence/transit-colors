function normalizeLineRef(value = '') {
  const normalized = String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase()
    .replace(/^(?:LINEA|LINE|L)\s*/, '');
  return /^(?:[1-9]|1[0-2]|A|B)$/.test(normalized) ? normalized : null;
}

export function metroLineRefsForStation(properties = {}) {
  const refs = new Set();
  for (const value of String(properties.route_ref ?? '').split(/[;,/]/)) {
    const lineRef = normalizeLineRef(value);
    if (lineRef) refs.add(lineRef);
  }

  const context = [properties.name, properties.network, properties.route_name]
    .filter(Boolean)
    .join(' ');
  const linePattern = /(?:^|\b)(?:linea|line|l)\s*(1[0-2]|[1-9]|a|b)(?=\b|$)/gi;
  for (const match of context.matchAll(linePattern)) {
    const lineRef = normalizeLineRef(match[1]);
    if (lineRef) refs.add(lineRef);
  }
  return refs;
}

export function normalizedPlatformStationName(value = '') {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(?:linea|line|l)\s*(?:1[0-2]|[1-9]|[a-b])\b/gi, ' ')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toLowerCase();
}

export function stationMatchesRoute(properties, routeIds, routeById) {
  const stationLineRefs = metroLineRefsForStation(properties);
  if (stationLineRefs.size === 0) return true;
  return [...routeIds].some((routeId) => {
    const route = routeById.get(routeId);
    const routeLineRef = normalizeLineRef(route?.route_short_name);
    return routeLineRef && stationLineRefs.has(routeLineRef);
  });
}

// Official agency palettes:
// CDMX: https://serviciosatlas.sgirpc.cdmx.gob.mx/arcgis/rest/services/AtlasCapasPublicas/Movilidad_Integrada_CDMX/FeatureServer/1
// NYC: https://www.mta.info/document/168976
// PATH: published route_color values in the Port Authority GTFS feed
const LINE_COLORS = {
  cdmx: {
    1: '#F05097',
    2: '#005CB9',
    3: '#AF9803',
    4: '#6BBBBA',
    5: '#FFE800',
    6: '#FF0D00',
    7: '#FF610D',
    8: '#009844',
    9: '#51312D',
    A: '#9E1A97',
    B: '#B1B1B1',
    12: '#BFA042',
    L12: '#BFA042',
  },
  nyc: {
    1: '#D82233',
    2: '#D82233',
    3: '#D82233',
    4: '#009952',
    5: '#009952',
    6: '#009952',
    '6X': '#009952',
    7: '#9A38A1',
    '7X': '#9A38A1',
    A: '#0062CF',
    B: '#EB6800',
    C: '#0062CF',
    D: '#EB6800',
    E: '#0062CF',
    F: '#EB6800',
    FX: '#EB6800',
    G: '#799534',
    J: '#8E5C33',
    L: '#7C858C',
    M: '#EB6800',
    N: '#F6BC26',
    Q: '#F6BC26',
    R: '#F6BC26',
    S: '#7C858C',
    SIR: '#008EB7',
    W: '#F6BC26',
    Z: '#8E5C33',
    'PATH · Hoboken - 33rd Street': '#4D92FB',
    'PATH · Hoboken - World Trade Center': '#65C100',
    'PATH · Newark - World Trade Center': '#D93A30',
    'PATH · Journal Square - 33rd Street': '#FF9900',
    'PATH · Journal Square - 33rd Street (via Hoboken)': '#FF9900',
    'PATH · Newark - Harrison Shuttle Train': '#8C3C96',
    'PATH · World Trade Center - 33rd Street': '#65C100',
  },
};

const FALLBACK_LINE_COLOR = '#64748B';

export function lineColor(areaKey, lineName) {
  return LINE_COLORS[areaKey]?.[String(lineName)] ?? FALLBACK_LINE_COLOR;
}

export function hasOfficialLineColor(areaKey, lineName) {
  return Boolean(LINE_COLORS[areaKey]?.[String(lineName)]);
}

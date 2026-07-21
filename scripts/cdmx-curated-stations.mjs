const OFFICIAL_SOURCES = {
  trenAifa: 'https://www.aifa.aero/conectividad/tren',
  trolebus10: 'https://www.ste.cdmx.gob.mx/linea-10',
  trolebus11: 'https://www.ste.cdmx.gob.mx/linea-11',
  trolebus12: 'https://www.ste.cdmx.gob.mx/linea-12',
};

function slug(value) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function buildCorridorStations({
  id,
  line,
  routeName,
  sourceUrl,
  stations,
}) {
  return stations.map(([name, lon, lat], index) => ({
    id: `official/trolebus-${id}/${String(index + 1).padStart(2, '0')}-${slug(name)}`,
    name,
    coordinates: [lon, lat],
    mode: 'brt',
    system: 'BRT',
    network: `Trolebús Línea ${line}`,
    operator: 'Servicio de Transportes Eléctricos de la Ciudad de México',
    route_ref: String(line),
    route_name: routeName,
    source: `Official STE Line ${line} map`,
    source_url: sourceUrl,
  }));
}

const TREN_AIFA_STATIONS = [
  ['Cueyamil', -99.1669, 19.6283],
  ['La Loma', -99.1495, 19.6434],
  ['Teyahualco', -99.1359, 19.6553],
  ['Prados Sur', -99.107, 19.6804],
  ['Cajiga', -99.0863, 19.6984],
  ['Xaltocan', -99.0575, 19.7236],
  ['AIFA / Clara Krause', -99.0258, 19.7356],
].map(([name, lon, lat]) => ({
  id: `official/tren-felipe-angeles/${slug(name)}`,
  name,
  coordinates: [lon, lat],
  mode: 'commuter_rail',
  system: 'Commuter rail',
  network: 'Tren Felipe Ángeles',
  operator: 'Tren Felipe Ángeles',
  opening_date: '2026-04-26',
  route_ref: 'AIFA',
  route_name: 'Buenavista – AIFA',
  source: 'Official AIFA station list; OpenStreetMap station coordinates',
  source_url: OFFICIAL_SOURCES.trenAifa,
}));

const TROLEBUS_LINE_10_STATIONS = buildCorridorStations({
  id: 'line-10',
  line: 10,
  routeName: 'Constitución de 1917 – Santa Marta',
  sourceUrl: OFFICIAL_SOURCES.trolebus10,
  stations: [
    ['Constitución de 1917', -99.0640664, 19.345848],
    ['Tulipán', -99.0563079, 19.3425658],
    ['Deportivo Sta. Cruz', -99.0491742, 19.342408],
    ['Meyehualco', -99.0408316, 19.3432175],
    ['Papalotl', -99.0330615, 19.3439695],
    ['Aztahuacán', -99.0256908, 19.3447009],
    ['Atzintlí', -99.0211525, 19.3453007],
    ['Iztahuatzín', -99.0182597, 19.3492208],
    ['Tecoloxtitlán', -99.0153364, 19.3522862],
    ['Acatitlán', -99.0087608, 19.355032],
    ['Acahualtepec', -99.0012136, 19.357905],
    ['Santa Marta', -98.9955789, 19.3597741],
  ],
});

const TROLEBUS_LINE_11_STATIONS = buildCorridorStations({
  id: 'line-11',
  line: 11,
  routeName: 'Santa Marta – Chalco',
  sourceUrl: OFFICIAL_SOURCES.trolebus11,
  stations: [
    ['Santa Marta', -98.995568, 19.360311],
    ['La Virgen', -98.980445, 19.344697],
    ['Teotongo', -98.974564, 19.337368],
    ['Xico', -98.967014, 19.330656],
    ['Parque de la Mujer', -98.9579, 19.323138],
    ['Cuauhtémoc', -98.946633, 19.313847],
    ['Puente Rojo', -98.939144, 19.307164],
    ['Puente Blanco', -98.930812, 19.30034],
    ['Parque Tejones', -98.923316, 19.292929],
    ['Unión de Guadalupe', -98.915169, 19.286345],
    ['La Covadonga', -98.907602, 19.276003],
    ['Ejidal', -98.897351, 19.265916],
    ['José María Martínez', -98.889394, 19.272156],
    ['Amalinalco', -98.882255, 19.278812],
    ['Chalco', -98.882449, 19.283944],
  ],
});

const TROLEBUS_LINE_12_STATIONS = buildCorridorStations({
  id: 'line-12',
  line: 12,
  routeName: 'Tasqueña – Perisur',
  sourceUrl: OFFICIAL_SOURCES.trolebus12,
  // STE maps the roadside platforms independently, so both directions are kept.
  stations: [
    ['Perisur', -99.185954, 19.304892],
    ['Céfiro', -99.180866, 19.307384],
    ['Tita Avendaño', -99.174676, 19.310024],
    ['Cantera', -99.170895, 19.311979],
    ['Papatzín', -99.167957, 19.314285],
    ['Moctecuzoma', -99.165298, 19.317328],
    ['Tepalcatzin', -99.162484, 19.320553],
    ['Topiltzin', -99.15978, 19.323544],
    ['Ixtlixóchitl', -99.158224, 19.32534],
    ['Moctezuma', -99.155812, 19.328097],
    ['Cantil', -99.154391, 19.329607],
    ['Eje 10', -99.151289, 19.333495],
    ['Pacífico', -99.148219, 19.335295],
    ['Los Pinos', -99.147911, 19.340028],
    ['Central', -99.147454, 19.342282],
    ['Cerro Huitzilac', -99.141438, 19.341542],
    ['Tasqueña', -99.1395919, 19.3428156],
    ['División del Norte', -99.148832, 19.34219],
    ['Los Pinos', -99.148252, 19.340057],
    ['Circunvalación', -99.147251, 19.33771],
    ['Pacífico', -99.150112, 19.33764],
    ['Eje 10', -99.151283, 19.334152],
    ['Cantil', -99.15428, 19.329655],
    ['Moctezuma', -99.155442, 19.328257],
    ['Ixtlixóchitl', -99.158097, 19.325249],
    ['Topiltzin', -99.159652, 19.323442],
    ['Tepalcatzin', -99.162351, 19.320447],
    ['Moctecuzoma', -99.165162, 19.317224],
    ['Papatzín', -99.167829, 19.314176],
    ['Cantera', -99.17085, 19.311884],
    ['Tita Avendaño', -99.174002, 19.31017],
    ['Céfiro', -99.179694, 19.308041],
  ],
});

export const CURATED_CDMX_STATIONS = [
  ...TREN_AIFA_STATIONS,
  ...TROLEBUS_LINE_10_STATIONS,
  ...TROLEBUS_LINE_11_STATIONS,
  ...TROLEBUS_LINE_12_STATIONS,
];

export { OFFICIAL_SOURCES };

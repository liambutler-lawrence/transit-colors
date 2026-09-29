# Highway government seats

The highway overlay includes 129 government seats. The North American catalog covers 13
Canadian provinces/territories, 50 US states plus DC, and 32 Mexican federal entities
(96 markers). The China catalog adds 31 mainland provincial-level divisions plus Hong
Kong and Macao (33 markers); Taiwan is outside this catalog. China has circles only,
with no connection routes or route-status records. Alaska and Hawaii are included.
Central America, Caribbean countries and dependencies are outside this scope.

Each record in `data/north-america-government-seats.json` or
`data/china-government-seats.json` identifies one working executive or legislative seat,
its building coordinates, a building reference, a coordinate reference, and any
relocation note. This is a dated, manually reviewed catalog, not a live directory.
Review temporary seats when updating it.

US locations start from Wikipedia’s list of state and territorial capitols; Canadian
locations start from its legislative-buildings list. Mexican locations use OpenStreetMap
building records checked against government directories and building references. Source
links remain available in marker popups. OpenStreetMap coordinate data is attributed to
its contributors under ODbL; Wikipedia reference data is attributed under CC BY-SA.
These source-data terms are separate from the application’s code license.

Specific exceptions include Arizona’s active Executive Tower, Florida’s working capitol
tower, Kentucky’s temporary governor’s office at 501 High Street, PEI’s temporary George
Coles chamber, Colima’s Building A, and Zacatecas’s Building A. Durango is located at
its active Bicentenario executive complex; its coordinate represents the complex rather
than an individually verified office footprint. Historic museum-only palaces are not
used in place of these seats.

China’s working executive headquarters are checked against the government articles
linked from each record. Mainland coordinates use OpenStreetMap building/campus records
in WGS84; Hong Kong’s Tamar offices and Macao’s government headquarters use Wikidata
building coordinates (CC0). Where a map feature represents a campus, the popup notes
that scope. Beijing uses its Tongzhou headquarters, Anhui its Binhu headquarters, and
Jiangxi its relocated Wolong Road headquarters. City centers, former headquarters, and
provincial liaison offices in other cities are excluded.

Run `node scripts/build-government-seats.mjs` after changing coordinates. The shared
`data/government-seats.geojson` contains all 129 seats, while the existing North America
GeoJSON stays scoped to the 96 routing inputs. It writes one point and one 180-segment
geodesic circle per seat. Every circle has a **5,000 m radius / 10,000 m diameter on
WGS84**, independent of latitude and map zoom. Geometry is generated offline, loaded
once as a static GeoJSON source, and rendered with shared MapLibre layers. Panning and
zooming do not fetch seat records again or rebuild geometry. The overlay is visible only
in highway mode and can be toggled independently of the inside/gradient layers.

`scripts/government-seats.test.mjs` checks coverage, source fields, temporary-seat
exceptions, exact regeneration, ring closure, every vertex’s geodesic radius, and the
opposing-point diameter.

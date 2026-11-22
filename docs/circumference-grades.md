# Circumference grades

The network and allowed grades are independent. A circle is eligible when every travel
segment in it has a grade in the chosen set. Road interchanges and transit stations
define the ends of a travel segment. The grade requirements must hold across its full
length.

Road grades use marked permanent through lanes in each direction. C starts at 1×1 and B
at 2×2. A− adds full grade separation to C. For A, A+ and A++, the entire segment must
be grade separated and physically divided, with at least 2×2, 3×3 and 4×4 lanes
respectively. A 2×2 section with a level crossing and a separate 1×1 narrowing on the
same segment earns C.

Transit grades use scheduled passenger infrastructure. C is the single-track minimum and
B requires a separate track for each direction. Full grade separation raises those to A−
and A respectively. BX and AX apply the B and A rules to a dedicated busway. Conflicting
passenger movements across different corridors count as level crossings. Depot leads
restricted to empty trains, same-corridor crossover switches used to change tracks, and
joins or splits without a crossing do not lower the grade. Existing walking transfers
connect eligible ride segments.

## Transit reviews

[The review catalog](../data/circumference-transit-grades.json) records the grade,
sources and exact published network segment IDs for each reviewed corridor. A line name
describes the review and never assigns a grade to later extensions or other segments.
The [outstanding segment list](circumference-transit-grade-gaps.md) gives the station
pair, services, and missing evidence for every ride without a grade. To add coverage,
record the exact ride IDs from the area's `*-circumference.json` network and the sources
for the whole segment. Update the outstanding list to reflect those grades. Tests check
that every ride in both geometry variants has either a grade or an entry in that list.
Shared services on the same physical edge get one infrastructure grade.

The November 2026 review compared passenger track diagrams, operator infrastructure and
service documents, and OpenStreetMap track and crossing data. The OpenStreetMap extracts
date from November 14 for Mexico City, New York, and Singapore and November 20 for
Athens. Track diagrams distinguish one-way merges, parallel approaches, and crossings
that cut across a second passenger route. For surface track, the review checked mapped
rail and road crossings against the structures and access described by the sources.
Where the sources document a single regular passenger track at a terminal throat, that
section sets the segment's grade even if the corridor widens farther from the station.

At Indios Verdes, the mapped crossing marker originated in an old station footway that
was documented as a pedestrian tunnel before it was removed during entrance remapping.
The city plans show the underground station access, and the Line 3 construction record
documents the separated road crossings on the approach.
[OpenStreetMap footway history](https://www.openstreetmap.org/way/1126581929/history) ·
[CETRAM project plans](https://www.obras.cdmx.gob.mx/storage/app/media/cetram/CETRAM%20INDIOS%20VERDES.pdf)
·
[COMETRO construction report](https://almacenfica.blob.core.windows.net/imagenes-fundacion-ica-org-mx/FICA-IMAGENES/Libro_Digitales/Revista%20ICA/REVISTA_NUM%209.pdf)

For Harrison–Journal Square, the maintenance exception applies to crossing 969865J. The
FRA records a private road with no public access at the rail yard. The mapped road stays
within the Port Authority's Cape May Street parcel (Block 213, Lot 5.04) and ends inside
the maintenance facility. The 2025 state aerial imagery shows the road ending in the
track materials storage area. The facility contract describes controlled entry and
railcar testing and repair infrastructure along the eastbound track.
[FRA crossing record](https://data.transportation.gov/resource/m2f8-22s6.json?crossingid=969865J)
· [Mapped service road](https://www.openstreetmap.org/way/220547655) ·
[New Jersey parcel data](https://www.nj.gov/njgin/edata/parcels/) ·
[Harrison parcel ownership plan](https://www.townofharrisonnj.com/DocumentCenter/View/767/Accordia-II-Site-Plans-May-2020#page=1)
·
[New Jersey 2025 aerial imagery catalog](https://nj.gov/njgin/edata/imagery/index.shtml)
·
[Port Authority maintenance contract](https://www.panynj.gov/content/dam/port-authority/pdfs/goods-and-services-pdfs/BIDDOC_61342.pdf#page=51)

For Journal Square–Grove Street, the review applies the maintenance exception to
crossing 969866R. The FRA records a private pedestrian crossing with no public access
over one main track and one siding. Station footage shows the gate at track level, and
Port Authority plans identify a work platform and other staff facilities on that level.
The grade treats the gated internal walkway as maintenance access.
[FRA crossing record](https://data.transportation.gov/resource/m2f8-22s6.json?crossingid=969866R)
·
[Port Authority station plans](https://www.panynj.gov/content/dam/port-authority/pdfs/bid-proposal/RFIDOC_58339.pdf#page=13)
· [Station footage](https://www.youtube.com/watch?v=WLyyMSa-uMw)

The selector excludes ride segments without evidence. Track data currently covers metro
services. Busways and other passenger rail need to be added to the graph before their
grades can be used. Filtered transit circles use eligible precomputed candidates and
cycles discovered in the reduced network, without a proof of optimality.

## Road reviews

[The road review file](../data/north-america-highway-grade-reviews.json) is indexed by
the sections of the existing North American boundary. Its checksum ties it to the
boundary snapshot. The [road grade gaps](circumference-road-grade-gaps.md) list the
first unresolved location in each pending section. The map draws reviewed sections with
permitted grades and displays the full road circle when every section qualifies.

The audit uses the July 2026 [OpenStreetMap motorway extract][motorway]. It samples the
published boundary at intervals of up to 15 metres and matches both directions to nearby
source carriageways. It verifies that the two directions follow connected source ways,
including any short intervening way between samples. It also compares published
connectors against reconstructed reciprocal paths from the same extract.

The grade uses the fewest marked through lanes found in either direction. It excludes
marked exit-only, merge-only, and bus-only lanes and checks for mapped crossings,
ordinary traffic signals, and access exceptions. The motorway and reciprocal ramp
geometry is evidence of grade separation in this snapshot. The audit retains the
previously reviewed grades for the same boundary and uses the lower grade where both
reviews establish different lane tiers. Zero-length junction records inherit the lower
grade of their two neighbours when both have grades.

Reproduce the audit with the OSM extract used by the highway builder. The audit
reconstructs the road geometry near the published boundary and updates the grade file
and gaps report:

```sh
node --expose-gc --max-old-space-size=5500 --import tsx scripts/audit-highway-grades.mjs \
  data/.osm-highway-cache/north-america-motorways.osm.pbf
```

[motorway]: https://wiki.openstreetmap.org/wiki/Tag:highway%3Dmotorway
[lanes]: https://wiki.openstreetmap.org/wiki/Key:lanes

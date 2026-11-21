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

The selector excludes ride segments without evidence. Track data currently covers metro
services. Busways and other passenger rail need to be added to the graph before their
grades can be used. Filtered transit circles use eligible precomputed candidates and
cycles discovered in the reduced network, without a proof of optimality.

## Road reviews

[The road review file](../data/north-america-highway-grade-reviews.json) is indexed by
the sections of the existing North American boundary. Its checksum ties it to the
boundary snapshot. A null entry requires further review. The map draws only reviewed
sections with permitted grades. It displays area, gradient, and feeder routes only when
the complete boundary qualifies.

The first pass uses the July 2026 [OpenStreetMap motorway extract][motorway] and the
cached paired centerlines. It requires exact geometry matches across a whole boundary
section, two opposing mapped motorway carriageways, and usable [explicit lane
tags][lanes] for those carriageways over the interval. It takes the weakest supported
tier and excludes ambiguous lane-use tags, mapped at-grade crossing indicators, and
reciprocal ramps pending review. The separation evidence for this pass is the OSM
motorway classification on the paired source ways, so these grades reflect the map
snapshot. The road mode screens the existing boundary. Finding alternative road circles
requires graded network-wide topology and a new solve.

Reproduce the data with the same OSM extract and paired-network cache used by the
highway builder:

```sh
node --max-old-space-size=6000 --import tsx scripts/audit-highway-grades.mjs \
  data/.osm-highway-cache/north-america-motorways.osm.pbf \
  data/.osm-highway-cache/north-america-derived-network.bin
```

[motorway]: https://wiki.openstreetmap.org/wiki/Tag:highway%3Dmotorway
[lanes]: https://wiki.openstreetmap.org/wiki/Key:lanes

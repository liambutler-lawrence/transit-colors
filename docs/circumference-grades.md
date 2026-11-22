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

Road mode reviews the existing North American motorway graph between junctions,
including paired ramps and branches outside the former maximum-area boundary. It uses
the July 2026 [OpenStreetMap motorway extract][motorway]. Mainlines are sampled at
intervals of up to 15 metres and matched to connected, opposing source carriageways. For
ramps, the review uses the source ways of both reciprocal movements. The lowest
through-lane count across a segment governs its grade. The review also checks mapped
crossings, access, and separation. Segments with inconclusive evidence stay visible and
the inspector shows the first review issue. They cannot enter a circle.

An unexplained signal or pedestrian crossing marker on a motorway mainline requires
verification. In Woodhaven, the markers on both I-75 carriageways attach to a path
documented on the West Road bridge. The
[crossing review catalog](../data/north-america-road-crossing-reviews.json) records the
mapped feature and the sources for the grade separation.

The [earlier boundary review](../data/north-america-highway-grade-reviews.json) supplies
additional evidence for any segment whose geometry exactly matches a reviewed section.
Its [gaps report](circumference-road-grade-gaps.md) documents that boundary review.

The road builder solves for the largest simple loop over the verified segments in each
allowed grade set. It applies the same interchange turn restrictions as the original
highway solver and publishes the optimal result for each combination. Coincident graph
joins preserve topology without adding a travel segment. The road inspector shows the
grade regardless of which grades are selected.

Regenerate the reviews, circles and map tiles from the existing OSM extract with the
data build command.

```sh
npm run build:data:road-grades
```

The optional native HiGHS solver is described in
[Highway circumference area optimization](highway-area-optimization.md).

[motorway]: https://wiki.openstreetmap.org/wiki/Tag:highway%3Dmotorway
[lanes]: https://wiki.openstreetmap.org/wiki/Key:lanes

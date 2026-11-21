# Circumference grades

The network and allowed grades are independent. A circle is eligible when every graded
travel segment belongs to the chosen set. Each segment carries one grade. Road
interchanges and transit stations define the ends of a travel segment. The grade
requirements must hold across its full length, so even a short narrowing or level
crossing can lower the grade.

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
are links at stations and have no infrastructure grade.

## Coverage

- **Transit.** Initial Grade A coverage follows the two underground, two-track passenger
  corridors from Little India to Chinatown in Singapore. This inference uses the
  [Downtown Line construction profile][dt], [North East Line profile][ne], [Clarke Quay
  construction record][cq], and [North East Line contract C706][c706]. Remaining
  existing metro segments are unclassified. The current circle graph contains metro
  services. A grade choice does not add busways or rail services to that graph.
  Grade-filtered transit results consider still-eligible precomputed circles and cycles
  found on the reduced graph. They have no proof of optimality.
- **Road.** The published continental motorway loop uses a controlled-access dataset
  that predates these grades. Its ramps and mainlines remain unclassified. The selector
  can screen the published result. Finding alternative road loops requires a graded road
  graph and a new offline solve.

An unknown grade means the available evidence does not establish a grade for the whole
segment. Include **Unclassified** to admit these segments. A missing result may reflect
incomplete coverage.

[dt]:
  https://www.lta.gov.sg/content/ltagov/en/getting_around/public_transport/rail_network/downtown_line.html
[ne]:
  https://www.lta.gov.sg/content/ltagov/en/getting_around/public_transport/rail_network/north_east_line.html
[cq]: https://www.lumchang.com.sg/projects_uri/clarke-quay-station/
[c706]: https://ic-group.org/fileadmin/Magazin_PDFs/Atzl_Sigl_ICRT99-LININGa_02.pdf

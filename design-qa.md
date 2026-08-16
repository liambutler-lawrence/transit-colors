# Clock Skew design QA

## Evidence

- Source visual truth: `/private/tmp/transit-colors-tz/tz-skew-reference.png`
- Rendered implementation: `/private/tmp/transit-colors-tz/tz-skew-implementation.png`
- Full-view comparison: `/private/tmp/transit-colors-tz/design-qa-comparison.png`
- Focused Eurasia comparison: `/private/tmp/transit-colors-tz/design-qa-focused.png`
- Route and state: `http://127.0.0.1:5173/?product=timezone`, flat world view, color
  wash and zone borders enabled, UTC+01:00 land area selected
- CSS viewport: 1280 × 720 at device pixel ratio 2
- Source pixels: 6000 × 3800
- Implementation screenshot pixels: 1280 × 720; the browser capture is normalized to CSS
  pixels
- Full-view normalization: the source was scaled proportionally to 900 × 570 and
  centered on a 900 × 720 canvas; the implementation map was cropped to its 900 × 720
  visible map region. The two normalized map regions were placed side by side.
- Focused normalization: source and implementation Eurasia crops were each fitted to 900
  × 520 before being placed side by side.

## Findings

No actionable P0, P1, or P2 differences remain.

- Fonts and typography: the implementation intentionally uses the existing product and
  OpenFreeMap typography rather than the reference's static cartographic lettering.
  Hierarchy, wrapping, optical weight, and map-label contrast remain clear at the tested
  viewport.
- Spacing and layout rhythm: the reference is an edge-to-edge static map; the
  implementation preserves Transit Colors' 380 px inspection sidebar and gives the
  remaining 900 × 720 region to the world map. The three product tabs, two layer
  toggles, four sidebar sections, map controls, and attribution fit without overlap.
- Colors and visual tokens: red still means solar noon later than 12:00, white is near
  12:00, and blue means earlier. The continuous within-zone gradients and brown zone
  edges align with the reference. Underlying land, water, labels, and roads are an
  intentional consequence of integrating the visualization with the interactive base
  map.
- Image quality and asset fidelity: the color field is triangulated from land-clipped
  timezone polygons and rendered as vector-backed WebGL geometry, so coastlines and
  gradients remain sharp while zooming. No reference imagery was substituted with a
  placeholder asset.
- Copy and content: the legend direction, solar-noon calculation, daylight-saving
  caveat, source credit, and inspection details are consistent. Static offset labels
  from the reference become hover/click details so the base-map labels stay legible.

## Comparison History

1. Initial comparison found a P1 projection mismatch: a direct Clock Skew URL opened on
   the globe, distorting the rectangular color field. It also found a P1 incomplete
   loading state and a P2 overlap between the status pill and the third product tab.
2. The implementation now applies Mercator only after the map style is ready, gives the
   new product an initial-load completion path, refits the world, and reserves a full
   header row for the three product tabs.
3. Post-fix evidence is in `design-qa-comparison.png` and `design-qa-focused.png`. The
   full world and Eurasia detail both preserve the reference's zone-by-zone longitudinal
   gradient while the sidebar and base-map context remain readable.

## Interaction and Runtime Checks

- Direct URL restores the Clock Skew tab, Mercator world view, and ready state.
- Color wash and zone-border toggles independently hide and restore their layers.
- Clicking colored land populates longitude, UTC offset, solar noon, skew direction,
  places, and an example IANA zone.
- Switching to Transit Heatmap clears the product query; switching back restores
  `?product=timezone` and the Clock Skew view.
- The accessible map label changes to describe clock time versus mean solar time.
- Console inspection found no new Clock Skew exception after the projection fix. The
  existing MapLibre image-source cancellation messages were also reproduced on the
  unmodified Transit Heatmap entry state and are outside this feature's rendering path.

## Open Questions

- None.

## Implementation Checklist

- [x] Preserve the reference's continuous red-white-blue solar-noon scale.
- [x] Clip official UTC-offset zones to land and retain interactive base-map context.
- [x] Support direct links, product switching, layer toggles, and map inspection.
- [x] Verify the final desktop composition and a focused Eurasia region.

## Follow-up Polish

- P3: add static offset numerals at very large screen widths if a denser cartographic
  presentation is desired; the current interactive inspection avoids label collisions.

final result: passed

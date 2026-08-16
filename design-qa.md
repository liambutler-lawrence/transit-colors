# Clock Skew globe design QA

## Evidence

- Source visual truth: `/private/tmp/transit-colors-tz/tz-skew-reference.png`
- Rendered implementation:
  `/private/tmp/transit-colors-tz/tz-skew-globe-implementation.png`
- Full-view comparison: `/private/tmp/transit-colors-tz/design-qa-globe-comparison.png`
- Focused Europe/Africa comparison:
  `/private/tmp/transit-colors-tz/design-qa-globe-focused.png`
- Route and state: `http://127.0.0.1:5173/?product=timezone`, spherical globe, color
  wash and zone borders enabled, no land area selected
- CSS viewport: 1280 × 720 at device pixel ratio 2
- Source pixels: 6000 × 3800
- Implementation screenshot pixels: 1280 × 720; the browser capture is normalized to CSS
  pixels
- Full-view normalization: the source was scaled proportionally into a 900 × 680 panel;
  the implementation's 900 × 720 map region was scaled into a second 900 × 680 panel.
  The panels were placed side by side.
- Focused normalization: a Europe/Africa crop from the source and the matching visible
  globe face were each fitted into 900 × 680 panels and placed side by side.

## Findings

No actionable P0, P1, or P2 differences remain.

- Fonts and typography: the implementation intentionally uses the existing product and
  OpenFreeMap typography rather than the reference's static cartographic lettering.
  Sidebar hierarchy, label weight, wrapping, and map-label contrast remain clear at the
  tested viewport.
- Spacing and layout rhythm: the reference is an edge-to-edge cylindrical map; the
  implementation preserves Transit Colors' 380 px inspection sidebar and gives the
  remaining 900 × 720 region to the globe. The product tabs, layer toggles, four sidebar
  sections, globe controls, and attribution fit without overlap.
- Colors and visual tokens: red still means solar noon later than 12:00, white is near
  12:00, and blue means earlier. The continuous within-zone gradients and warm-brown
  zone edges retain the source's visual meaning while wrapping cleanly around the
  sphere. Underlying land, water, and labels are intentional base-map context.
- Image quality and asset fidelity: the color field remains vector-backed WebGL
  geometry. MapLibre's active projection shader now places it on the sphere and clips
  the far side at the horizon; coastlines, boundaries, and gradients stay sharp during
  rotation and zoom. No reference imagery was replaced with a placeholder asset.
- Copy and content: the legend direction, solar-noon calculation, source credit, and
  inspection details remain consistent. The source's static offset labels are exposed
  through hover/click details so base-map labels stay legible.

The source's Miller cylindrical projection and the implementation's spherical projection
are intentionally different because the user explicitly requested the same globe
behavior as Circumference mode. The fidelity target is the source's color semantics and
within-zone gradient, not its flat projection.

## Comparison History

1. The first Clock Skew implementation matched the source on a Mercator world view. Its
   custom shader accepted only a flat projection matrix, so switching it to the globe
   would distort and expose the rectangular color field.
2. The follow-up replaces the flat-only shader path with MapLibre's active `projectTile`
   projection prelude and supplies the globe matrix, Mercator extent, horizon clipping
   plane, projection transition, and fallback matrix. Clock Skew now stays on the shared
   globe from initial load through product switching.
3. Post-fix evidence is in `design-qa-globe-comparison.png` and
   `design-qa-globe-focused.png`. The requested sphere, land clipping, red-white-blue
   gradients, boundaries, labels, and product chrome remain coherent with no visible
   projection seams or horizon leakage.

## Interaction and Runtime Checks

- Direct URL restores the Clock Skew tab, spherical world view, and ready state.
- Dragging across the map rotates the globe and reveals another face with the color wash
  and boundaries still aligned to the basemap.
- Color-wash and zone-border toggles independently hide and restore their layers.
- Moving over colored land populates longitude, UTC offset, solar noon, skew direction,
  places, and an example IANA zone.
- Three zoom-in steps preserve the gradient through MapLibre's globe-to-flat close-zoom
  transition.
- Console inspection found no Clock Skew shader or projection exception. The existing
  MapLibre image-source cancellation message comes from the Circumference gradient
  source and is outside this feature's rendering path.

## Open Questions

- None.

## Implementation Checklist

- [x] Keep Clock Skew on the same spherical globe as Circumference mode.
- [x] Preserve the reference's continuous red-white-blue solar-noon scale.
- [x] Keep land clipping, zone boundaries, base-map labels, hover inspection, and layer
      controls aligned during rotation and zoom.
- [x] Verify direct loading, globe rotation, toggles, inspection, close zoom, and
      runtime logs in the browser.

## Follow-up Polish

- P3: none identified in the tested desktop state.

final result: passed
